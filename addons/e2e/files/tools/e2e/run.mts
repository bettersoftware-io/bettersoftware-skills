#!/usr/bin/env node
// The end-to-end run: build the client, serve the build, run the specs in a
// real browser, and leave nothing running.
//
//   node tools/e2e/run.mts                             every mode, every spec
//   node tools/e2e/run.mts --mode sim                  one mode
//   node tools/e2e/run.mts src/sim/priceList.spec.ts   one spec
//   node tools/e2e/run.mts -g "selects the row"        the tests whose title matches
//
// Anything that is not `--mode` goes to `playwright test` as it is.
//
// For each mode: its server is started, if it has one; the client is built
// with that mode's variables; the build is served. Then the specs run. The
// modes are in `tools/e2e.config.mts`, which belongs to the project.
//
// Every program is started in a process group of its own and the groups are
// stopped when the run ends: after a pass, a failure, an error, or a signal.
//
// Exit 0: every spec passed. 1: one failed. 2: the run could not start, or had
// nothing to judge. 130, 143: it was interrupted, and has cleaned up.

import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArguments, USAGE, UsageError } from "./lib/arguments.mts";
import { type E2eConfig, E2eError, loadConfig, selectModes } from "./lib/config.mts";
import { forgetResults, reportCounts } from "./lib/counts.mts";
import { createGroups, exitCodeOfSignal, type Groups, StartError } from "./lib/processes.mts";
import { MODES_VARIABLE, type RunningMode, startMode } from "./lib/stack.mts";

/** How long the programs are given to leave after a signal, before they are killed. */
const STOP_GRACE_MS = 10_000;

/** The test runner, from the tests package. Called directly: never through a package manager. */
const RUNNER = ["node_modules/.bin/playwright", "test"];

export interface RunOptions {
  root: string;
  config: E2eConfig;
  /** The modes to run. */
  modes: string[];
  /** Arguments for the test runner. */
  forwarded: string[];
  groups: Groups;
  environment?: NodeJS.ProcessEnv;
  say?: (line: string) => void;
  /** The test runner's command. Replaced in tests. */
  runner?: string[];
}

/** Starts every mode, runs the specs, and resolves with the test runner's exit code. Stops nothing: the caller does. */
export async function runEndToEnd({
  root,
  config,
  modes,
  forwarded,
  groups,
  environment = process.env,
  say = console.log,
  runner = RUNNER,
}: RunOptions): Promise<number> {
  const tests = join(root, config.tests);

  if (!existsSync(join(tests, "node_modules"))) {
    throw new E2eError(`${config.tests} has no node_modules — run pnpm install`);
  }

  const running: Record<string, RunningMode> = {};

  forgetResults(tests);

  for (const name of modes) {
    running[name] = await startMode(name, { root, config, groups, environment, say });
  }

  const exitCode = await groups.run({
    label: "the test runner",
    command: [...runner, ...forwarded],
    cwd: tests,
    env: { ...environment, [MODES_VARIABLE]: JSON.stringify(running) },
  });

  // For a tool that asked how many specs ran (the mutation check).
  reportCounts(tests, environment);

  return exitCode;
}

/** True when a process may listen on a port here. Some sandboxes do not let one. */
export function canListen(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      // A refusal is an answer. Anything else is a fault to report, not a "no".
      if (error.code === "EPERM" || error.code === "EACCES") {
        resolve(false);
      } else {
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export interface CommandOptions {
  groups: Groups;
  /** Asks whether a port can be opened here. Replaced in tests. */
  probe?: () => Promise<boolean>;
  say?: (line: string) => void;
  complain?: (line: string) => void;
  runner?: string[];
}

/**
 * The whole command, without the signals: reads what was asked, starts what
 * is needed and runs the specs. Resolves with the exit code and never throws:
 * a run that could not start is 2. Stops nothing: the caller does.
 */
export async function runCommand(
  argv: string[],
  root: string,
  { groups, probe = canListen, say = console.log, complain = console.error, runner }: CommandOptions,
): Promise<number> {
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      say(USAGE);

      return 0;
    }

    const request = parseArguments(argv);
    const config = await loadConfig(root);
    const { modes } = selectModes(root, config, request.modes);

    if (!(await probe())) {
      throw new E2eError(
        "this environment does not let a process listen on a port, as Codex's sandbox does not, so no server could be started. The end-to-end specs are not verified here. They run where a port can be opened: outside the sandbox, and in CI",
      );
    }

    return await runEndToEnd({ root, config, modes, forwarded: request.forwarded, groups, say, runner });
  } catch (error) {
    if (error instanceof UsageError) {
      complain(`${error.message}\n\n${USAGE}`);
    } else if (error instanceof E2eError || error instanceof StartError) {
      complain(`e2e could not run: ${error.message}`);
    } else {
      complain(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }

    return 2;
  }
}

/** The command with the signals: whatever ends the run, every program it started is stopped first. */
async function main(argv: string[], root: string): Promise<number> {
  const groups = createGroups();
  let interrupted: NodeJS.Signals | undefined;

  function interrupt(signal: NodeJS.Signals): void {
    if (interrupted !== undefined) {
      // Asked twice: stop waiting for anything.
      groups.killAllNow();
      process.exit(exitCodeOfSignal(signal));
    }

    interrupted = signal;
    console.error(`[e2e] interrupted (${signal}): stopping what was started. Again to stop waiting for it.`);
    // The test runner closes its browsers on a signal; the servers leave.
    groups.signal(signal);
    // A program that does not leave is not waited for.
    setTimeout(groups.killAllNow, STOP_GRACE_MS).unref();
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, interrupt);
  }

  // The last line of defence: whatever ends this process, no group outlives it.
  process.on("exit", groups.killAllNow);

  try {
    const exitCode = await runCommand(argv, root, {
      groups,
      complain: (line) => {
        // A program that was told to stop did not become ready: that is the interruption, not a fault.
        if (interrupted === undefined) {
          console.error(line);
        }
      },
    });

    return interrupted === undefined ? exitCode : exitCodeOfSignal(interrupted);
  } finally {
    await groups.stopAll();
  }
}

/** True when Node was asked to run this file. Real paths, so a symlinked copy still runs. */
function isMainModule(): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exit(await main(process.argv.slice(2), process.cwd()));
}
