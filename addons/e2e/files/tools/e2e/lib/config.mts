// What the end-to-end run is told about the project: where the tests are, how
// the client is built and served, and which data modes there are.
//
// The project's own file is `tools/e2e.config.mts`. This file belongs to the
// add-on and is replaced when the add-on is updated, so do not edit it.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** In a build or serve command: the folder this mode's build is written to and served from. */
export const OUT_DIR = "{outDir}";

/** In a mode's `env`: the address the mode's server printed when it was ready, as it printed it. */
export const SERVER_URL = "{serverUrl}";

/**
 * In a mode's `env`: the host and port of the mode's server, as in
 * `localhost:4000`, taken from the address it printed. A server that answers
 * more than one protocol on its port (a WebSocket and an HTTP API) prints one
 * address; each of the client's variables is written around this:
 * `ws://${SERVER_HOST}/ws`, `http://${SERVER_HOST}`.
 */
export const SERVER_HOST = "{serverHost}";

/** A program that is started, says when it is ready, and runs until it is stopped. */
export interface ServerCommand {
  /** Where it runs, from the project root. */
  cwd: string;
  /** The program and its arguments. Never a package manager: see `findWrapper`. */
  command: string[];
  env?: Record<string, string>;
  /**
   * Matches the line it prints once it listens. The first group is its
   * address (`ws://localhost:4000/ws`), or its host and port alone
   * (`localhost:4000`).
   */
  ready: RegExp;
}

export interface ClientCommands {
  /** The client package, from the project root. Both commands run there. */
  cwd: string;
  /** Builds the client into `OUT_DIR`. Runs once for each mode, with that mode's `env`. */
  build: string[];
  /** Serves `OUT_DIR`. */
  serve: string[];
  /** Matches the line the serve command prints once it listens. The first group is its address. */
  ready: RegExp;
}

export interface Mode {
  /** What the client talks to in this mode. Left out: nothing, the client runs alone. */
  server?: ServerCommand;
  /**
   * Variables the client's build is given. `SERVER_URL` stands for the
   * server's address as it printed it, `SERVER_HOST` for its host and port.
   */
  env?: Record<string, string>;
}

export interface E2eConfig {
  /** The package that holds the specs and the Playwright config, from the project root. */
  tests: string;
  client: ClientCommands;
  /** Mode name → what runs in it. The specs of a mode are in `<tests>/src/<name>/`. */
  modes: Record<string, Mode>;
}

/** The run could not start, or had nothing to judge. Exit code 2, never a pass. */
export class E2eError extends Error {}

/** Where the project's own file is, from the project root. */
export const PROJECT_CONFIG = "tools/e2e.config.mts";

const SPEC = /\.spec\.[cm]?tsx?$/;
const NOT_SOURCE = new Set(["node_modules", "reports", "dist"]);

// A package manager started as a server is one more process between this run
// and the server it has to stop. Since pnpm 12.6 that wrapper can die on the
// stop signal while the server lives on, holding its port; a test runner that
// waits for the server then never ends.
const WRAPPERS = new Set(["pnpm", "npm", "npx", "yarn", "bun", "bunx"]);

export async function loadConfig(root: string): Promise<E2eConfig> {
  const file = join(root, PROJECT_CONFIG);

  if (!existsSync(file)) {
    throw new E2eError(`${PROJECT_CONFIG} not found in ${root} — run this from the project root`);
  }

  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };

  return checkConfig(loaded.default);
}

/** Node runs the project's file without checking its types, so its shape is checked here. */
export function checkConfig(config: unknown): E2eConfig {
  if (!isRecord(config) || typeof config.tests !== "string" || !isRecord(config.client) || !isRecord(config.modes)) {
    throw new E2eError(`${PROJECT_CONFIG} must default-export an object with "tests", "client" and "modes"`);
  }

  const { tests, client, modes } = config as unknown as E2eConfig;

  if (Object.keys(modes).length === 0) {
    throw new E2eError(`${PROJECT_CONFIG}: "modes" is empty, so there is nothing to run`);
  }

  const servers = Object.entries(modes).flatMap(([name, mode]) => (mode.server ? [{ what: `modes.${name}.server`, server: mode.server }] : []));
  const commands: [string, unknown][] = [
    ["client.build", client.build],
    ["client.serve", client.serve],
    ...servers.map(({ what, server }): [string, unknown] => [`${what}.command`, server.command]),
  ];
  const patterns: [string, unknown][] = [
    ["client.ready", client.ready],
    ...servers.map(({ what, server }): [string, unknown] => [`${what}.ready`, server.ready]),
  ];

  for (const [what, command] of commands) {
    if (!isCommand(command)) {
      throw new E2eError(`${PROJECT_CONFIG}: "${what}" must be a list with the program first, then its arguments`);
    }

    const wrapper = findWrapper(command);

    if (wrapper !== undefined) {
      throw new E2eError(
        `${PROJECT_CONFIG}: "${what}" starts with ${wrapper}. A package manager's wrapper can die on the stop signal while the program it started lives on and keeps its port. Call the program itself: node_modules/.bin/<name> from the package, or node with the file.`,
      );
    }
  }

  for (const [what, ready] of patterns) {
    if (!(ready instanceof RegExp) || !hasGroup(ready)) {
      throw new E2eError(`${PROJECT_CONFIG}: "${what}" must be a regular expression whose first group is the address the program printed`);
    }
  }

  for (const what of ["build", "serve"] as const) {
    if (!client[what].includes(OUT_DIR)) {
      throw new E2eError(`${PROJECT_CONFIG}: "client.${what}" does not name OUT_DIR, so every mode would be built into, or served from, one folder`);
    }
  }

  return { tests, client, modes };
}

/** The package manager a command starts with, if it does. */
export function findWrapper(command: string[]): string | undefined {
  const program = (command[0] ?? "").split("/").at(-1) ?? "";

  return WRAPPERS.has(program) ? program : undefined;
}

export interface Selection {
  /** The modes to run, in the config's order. */
  modes: string[];
}

/**
 * The modes to run: the ones asked for, or all. Fails on a mode that does not
 * exist, on a mode with no spec, and on a spec that is in no mode's folder:
 * each of those would otherwise be a run that passes having judged nothing.
 */
export function selectModes(root: string, config: E2eConfig, asked: string[]): Selection {
  const known = Object.keys(config.modes);
  const unknown = asked.filter((name) => !known.includes(name));

  if (unknown.length > 0) {
    throw new E2eError(`there is no mode called "${unknown[0]}" — the modes are ${known.join(", ")}`);
  }

  const source = join(root, config.tests, "src");

  if (!existsSync(source)) {
    throw new E2eError(`${config.tests}/src not found — ${PROJECT_CONFIG} says the specs are there`);
  }

  const specs = listSpecs(source, "");
  const homeless = specs.filter((spec) => !known.some((name) => spec.startsWith(`${name}/`)));

  if (homeless.length > 0) {
    throw new E2eError(
      `${config.tests}/src/${homeless[0]} is in no mode's folder, so no run would ever start it. Move it into one of: ${known.map((name) => `src/${name}/`).join(", ")}`,
    );
  }

  const modes = known.filter((name) => asked.length === 0 || asked.includes(name));
  const empty = modes.filter((name) => !specs.some((spec) => spec.startsWith(`${name}/`)));

  if (empty.length > 0) {
    throw new E2eError(
      `the mode "${empty[0]}" has no spec in ${config.tests}/src/${empty[0]}/, so there is nothing to judge in it. That is not a pass: add a spec, or remove the mode from ${PROJECT_CONFIG}`,
    );
  }

  return { modes };
}

function listSpecs(directory: string, relative: string): string[] {
  return readdirSync(join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

    if (entry.isDirectory()) {
      return NOT_SOURCE.has(entry.name) ? [] : listSpecs(directory, path);
    }

    return SPEC.test(entry.name) ? [path] : [];
  });
}

function isCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part !== "");
}

function hasGroup(pattern: RegExp): boolean {
  return new RegExp(`${pattern.source}|`).exec("")?.length !== 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
