// Builds the client for one mode and starts what the mode needs: its server,
// if it has one, and a server for the build.
//
// The order matters. A client reads the server's address at build time, so
// the server is started first and the build is given the address it printed.
// Every address comes from the program that owns it: nothing here picks a
// port, so two runs on one machine cannot collide and none can adopt the
// other's server.

import { join } from "node:path";

import { type E2eConfig, E2eError, type Mode, OUT_DIR, SERVER_HOST, SERVER_URL } from "./config.mts";
import type { Groups } from "./processes.mts";

/** How long a program is given to say it is ready. */
const READY_TIMEOUT_MS = 60_000;

/** What the test runner is told about one mode. The Playwright config reads it. */
export interface RunningMode {
  /** Where the built client is served. */
  baseURL: string;
  /** The address of the mode's server, as it printed it. Left out when the mode has none. */
  serverURL?: string;
  /** The host and port of the mode's server, as in `localhost:4000`. Left out when the mode has none. */
  serverHost?: string;
}

/** The server of a mode, as the build's variables and the tests are told of it. */
export interface ServerAddress {
  /** What the `ready` pattern captured. */
  url: string;
  /** Its host and port. */
  host: string;
}

/** The variable the test runner finds the modes in, as JSON: name → `RunningMode`. */
export const MODES_VARIABLE = "E2E_MODES";

export interface StackOptions {
  root: string;
  config: E2eConfig;
  groups: Groups;
  environment?: NodeJS.ProcessEnv;
  say?: (line: string) => void;
  readyTimeoutMs?: number;
}

export async function startMode(
  name: string,
  { root, config, groups, environment = process.env, say = console.log, readyTimeoutMs = READY_TIMEOUT_MS }: StackOptions,
): Promise<RunningMode> {
  const mode = config.modes[name] as Mode;
  const clientFolder = join(root, config.client.cwd);
  const outDir = join(root, config.tests, "node_modules", ".cache", "e2e", name);
  let server: ServerAddress | undefined;

  if (mode.server !== undefined) {
    const started = await groups.start(
      {
        label: `the server of mode "${name}"`,
        command: mode.server.command,
        cwd: join(root, mode.server.cwd),
        env: { ...environment, ...mode.server.env },
      },
      mode.server.ready,
      readyTimeoutMs,
    );

    server = { url: started.address, host: readHost(name, started.address) };
    say(`[e2e] ${name}: server ready at ${server.url}`);
  }

  const buildEnv = { ...environment, ...resolveEnv(name, mode.env ?? {}, server) };
  const build = await groups.finish({
    label: `the build of the client for mode "${name}"`,
    command: withOutDir(config.client.build, outDir),
    cwd: clientFolder,
    env: buildEnv,
  });

  if (build.exitCode !== 0) {
    throw new E2eError(`the build of the client for mode "${name}" failed (exit code ${build.exitCode})\n--- its output ---\n${build.output || "(none)"}`);
  }

  const served = await groups.start(
    {
      label: `the client of mode "${name}"`,
      command: withOutDir(config.client.serve, outDir),
      cwd: clientFolder,
      env: buildEnv,
    },
    config.client.ready,
    readyTimeoutMs,
  );

  say(`[e2e] ${name}: client built and served at ${served.address}`);

  return { baseURL: served.address, ...(server === undefined ? {} : { serverURL: server.url, serverHost: server.host }) };
}

/**
 * The host and port in what a server's `ready` pattern captured: out of an
 * address (`ws://localhost:4000/ws`), or the capture itself when it is a host
 * and a port already. Anything else has no host to give, and is refused: a
 * client variable written around it would point nowhere.
 */
export function readHost(name: string, printed: string): string {
  const address = printed.includes("://") ? printed : `e2e://${printed}`;
  const host = URL.canParse(address) ? new URL(address).host : "";

  // A port alone parses as a host called by a number.
  if (host === "" || /^\d+$/.test(host) || (!printed.includes("://") && host !== printed)) {
    throw new E2eError(
      `the server of mode "${name}" was ready at "${printed}", which is neither an address (ws://localhost:4000/ws) nor a host and a port (localhost:4000). Change the group of its "ready" pattern to capture one of those`,
    );
  }

  return host;
}

/** The mode's variables, with the server's address, or its host and port, written in where each is asked for. */
export function resolveEnv(name: string, env: Record<string, string>, server: ServerAddress | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!value.includes(SERVER_URL) && !value.includes(SERVER_HOST)) {
        return [key, value];
      }

      if (server === undefined) {
        throw new E2eError(`the mode "${name}" gives ${key} the server's address, and has no server to take it from`);
      }

      return [key, value.replaceAll(SERVER_URL, server.url).replaceAll(SERVER_HOST, server.host)];
    }),
  );
}

function withOutDir(command: string[], outDir: string): string[] {
  return command.map((part) => part.replaceAll(OUT_DIR, outDir));
}
