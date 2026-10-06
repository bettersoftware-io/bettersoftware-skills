// Fixtures shared by the e2e add-on's tests: a project in a temporary folder
// whose "client", "server" and "test runner" are small programs written here,
// so the runner under test starts and stops real processes without a bundler
// or a browser.

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vitest";

import { type E2eConfig, OUT_DIR, SERVER_HOST, SERVER_URL } from "../files/tools/e2e/lib/config.mts";

export const ADDON = join(import.meta.dirname, "..");
export const REPOSITORY = join(ADDON, "..", "..");
export const TOOLS = join(ADDON, "files", "tools");

/** A case that starts real processes: on a busy machine that is longer than vitest's default five seconds. */
export const REAL_PROCESS_TIMEOUT = 60_000;

// However a test ends, and whatever a mutant of the runner fails to stop, no
// fake program outlives it by more than this.
const LIFETIME_MS = 90_000;
const SLEEPER = `setTimeout(() => {}, ${LIFETIME_MS})`;

// Listens on a port the system picks, says so in the words given, and starts
// a child of its own, the way a server starts a worker. Both write their pid
// to the folder the test reads. FAKE_SILENT: never says it is ready.
// FAKE_STUBBORN: does not leave on SIGTERM.
const SERVER_PROGRAM = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [label, said] = process.argv.slice(2);
const server = createServer((request, response) => {
  response.end(label);
});
const child = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}], { stdio: "ignore" });

setTimeout(() => process.exit(0), ${LIFETIME_MS});

if (process.env.FAKE_STUBBORN === label) {
  process.on("SIGTERM", () => {});
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();

  writeFileSync(join(process.env.FAKE_RECORD, label + "-" + process.pid + ".json"), JSON.stringify({ pids: [process.pid, child.pid], port, env: process.env.FAKE_SEEN }));

  if (process.env.FAKE_SILENT !== label) {
    console.log(said.replace("PORT", String(port)));
  }
});
`;

// The client's build: writes what it was given into the folder it was told to
// build into. FAKE_BUILD_EXIT: fails with that code after printing a reason.
const BUILD_PROGRAM = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir] = process.argv.slice(2);

if (process.env.FAKE_BUILD_EXIT !== undefined) {
  console.error("the bundler said: no such module");
  process.exit(Number(process.env.FAKE_BUILD_EXIT));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "built.json"), JSON.stringify({ serverUrl: process.env.CLIENT_SERVER_URL, apiUrl: process.env.CLIENT_API_URL }));
`;

// The test runner: asks every address it was given, writes down what it saw,
// starts a child of its own (its browser) and then does what FAKE_RUNNER
// says: pass, fail, hang until it is told to stop, or hang and not listen
// ("deaf"). FAKE_RESULTS: what it leaves as its results file.
const RUNNER_PROGRAM = `
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const modes = JSON.parse(process.env.E2E_MODES);
const answers = {};

for (const [name, { baseURL }] of Object.entries(modes)) {
  answers[name] = await (await fetch(baseURL)).text();
}

const browser = spawn(process.execPath, ["-e", ${JSON.stringify(SLEEPER)}], { stdio: "ignore" });

setTimeout(() => process.exit(0), ${LIFETIME_MS});

writeFileSync(
  join(process.env.FAKE_RECORD, "runner.json"),
  JSON.stringify({ pids: [process.pid, browser.pid], modes, answers, argv: process.argv.slice(2), cwd: process.cwd() }),
);

if (process.env.FAKE_RESULTS !== undefined) {
  mkdirSync("reports", { recursive: true });
  writeFileSync("reports/results.json", process.env.FAKE_RESULTS);
}

if (process.env.FAKE_RUNNER === "hang" || process.env.FAKE_RUNNER === "deaf") {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      // What a real runner does with the signal: closes its browser, then leaves.
      if (process.env.FAKE_RUNNER === "hang") {
        browser.kill();
        writeFileSync(join(process.env.FAKE_RECORD, "runner-heard-" + signal), "");
        process.exit(signal === "SIGINT" ? 130 : 143);
      }
    });
  }

  console.log("RUNNER STARTED");
} else {
  browser.kill();
  process.exit(process.env.FAKE_RUNNER === "fail" ? 1 : 0);
}
`;

export interface FakeProject {
  root: string;
  /** Where the fake programs write what they saw. */
  record: string;
  config: E2eConfig;
}

/**
 * A project with the add-on's tools in `tools/e2e`, a tests package with one
 * spec in each mode, and a config whose every command is a fake program.
 */
export function createFakeProject(): FakeProject {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-addon-")));
  const record = join(root, "record");
  const programs = join(root, "programs");

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  write(join(programs, "server.mts"), SERVER_PROGRAM);
  write(join(programs, "build.mts"), BUILD_PROGRAM);
  write(join(programs, "runner.mts"), RUNNER_PROGRAM);
  mkdirSync(record, { recursive: true });
  mkdirSync(join(root, "packages/client"), { recursive: true });
  mkdirSync(join(root, "packages/server"), { recursive: true });
  mkdirSync(join(root, "packages/e2e/node_modules/.bin"), { recursive: true });
  write(join(root, "packages/e2e/src/sim/list.spec.ts"), "");
  write(join(root, "packages/e2e/src/fullstack/server.spec.ts"), "");
  write(join(root, "packages/e2e/src/pages/List.page.ts"), "");

  // What the runner under test starts by name: the tests package's own
  // `playwright`. A shell script that becomes the fake, so a signal reaches it.
  write(join(root, "packages/e2e/node_modules/.bin/playwright"), `#!/bin/sh\nexec "${process.execPath}" "${join(programs, "runner.mts")}" "$@"\n`);
  chmodSync(join(root, "packages/e2e/node_modules/.bin/playwright"), 0o755);

  cpSync(join(TOOLS, "e2e"), join(root, "tools/e2e"), { recursive: true });

  const config: E2eConfig = {
    tests: "packages/e2e",
    client: {
      cwd: "packages/client",
      build: [process.execPath, join(programs, "build.mts"), OUT_DIR],
      serve: [process.execPath, join(programs, "server.mts"), "client", "  Local:   http://127.0.0.1:PORT/", OUT_DIR],
      ready: /Local:\s+(http:\/\/[^\s/]+)/,
    },
    modes: {
      sim: { env: { CLIENT_SERVER_URL: "", CLIENT_API_URL: "" } },
      fullstack: {
        server: {
          cwd: "packages/server",
          command: [process.execPath, join(programs, "server.mts"), "server", "price server listening on ws://127.0.0.1:PORT/ws"],
          env: { PORT: "0" },
          ready: /listening on (ws:\/\/\S+)/,
        },
        // One port, two protocols: the socket's address as printed, and an HTTP address written around the host and port.
        env: { CLIENT_SERVER_URL: SERVER_URL, CLIENT_API_URL: `http://${SERVER_HOST}/api` },
      },
    },
  };

  write(join(root, "tools/e2e.config.mts"), renderConfig(config));

  return { root, record, config };
}

/** The config as the file a project would hold. A pattern is written as a literal. */
export function renderConfig(config: E2eConfig): string {
  const text = JSON.stringify(config, (_key, value: unknown) => (value instanceof RegExp ? `__pattern__${value.source}` : value), 2).replace(
    /"__pattern__((?:[^"\\]|\\.)*)"/g,
    (_whole, source: string) => `/${(JSON.parse(`"${source}"`) as string)}/`,
  );

  return `export default ${text};\n`;
}

export interface Recorded {
  pids: number[];
  port?: number;
}

export interface RunnerRecord extends Recorded {
  modes: Record<string, { baseURL: string; serverURL?: string; serverHost?: string }>;
  answers: Record<string, string>;
  argv: string[];
  cwd: string;
}

/** What each fake program wrote, by the name of its file: the label, then its pid. */
export function readRecord(record: string): Record<string, Recorded> {
  return Object.fromEntries(
    readdirSync(record)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name.slice(0, -".json".length), JSON.parse(readFileSync(join(record, name), "utf8")) as Recorded]),
  );
}

export function readRunnerRecord(record: string): RunnerRecord {
  return JSON.parse(readFileSync(join(record, "runner.json"), "utf8")) as RunnerRecord;
}

export function readBuilt(root: string, mode: string): unknown {
  return JSON.parse(readFileSync(join(root, "packages/e2e/node_modules/.cache/e2e", mode, "built.json"), "utf8"));
}

/** Every process the fake programs said they were, that is still there. */
export function findSurvivors(record: string): number[] {
  return Object.values(readRecord(record))
    .flatMap(({ pids }) => pids)
    .filter(isAlive);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** True when nothing listens on the port any more: a new server can take it. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export interface CliRun {
  child: ChildProcess;
  /** Resolves when the output holds this text. */
  said: (text: string) => Promise<void>;
  /** Resolves with the exit code and everything it printed. */
  ended: Promise<CliEnd>;
}

export interface CliEnd {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

/** Starts the shipped command in the project, the way `pnpm e2e` does. */
export function startCli(project: FakeProject, argv: string[] = [], env: Record<string, string> = {}): CliRun {
  const child = spawn(process.execPath, ["tools/e2e/run.mts", ...argv], {
    cwd: project.root,
    env: { ...process.env, FAKE_RECORD: project.record, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const waiting: { text: string; resolve: () => void }[] = [];

  function read(chunk: Buffer): void {
    output += chunk.toString("utf8");

    for (const entry of waiting.splice(0)) {
      if (output.includes(entry.text)) {
        entry.resolve();
      } else {
        waiting.push(entry);
      }
    }
  }

  child.stdout.on("data", read);
  child.stderr.on("data", read);

  return {
    child,
    said: (text: string): Promise<void> => {
      return new Promise((resolve) => {
        if (output.includes(text)) {
          resolve();
        } else {
          waiting.push({ text, resolve });
        }
      });
    },
    ended: new Promise((resolve) => {
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode, signal, output });
      });
    }),
  };
}

export function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function fileExists(root: string, path: string): boolean {
  return existsSync(join(root, path));
}
