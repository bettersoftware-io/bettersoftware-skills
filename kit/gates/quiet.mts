#!/usr/bin/env node
// Runs one of the project's gate scripts and prints failures only.
//
//   node tools/arch/gates/quiet.mts gate:full
//   node tools/arch/gates/quiet.mts gate:fast --root <dir>
//
// `pnpm gate:full` prints every passing test and every cached task. That is
// what CI wants, and it is what fills an agent's context. This runs the same
// commands, in the same order, and prints:
//
//   - one line for each stage that passed, and under it each `SKIP` line the
//     stage printed: a check that judged nothing has not passed, and says so;
//   - for the stage that failed, its whole output, and nothing else;
//   - the stages that did not run, because the one before them failed.
//
// The exit code is the failing stage's own, which is what `pnpm gate:full`
// exits with. 0 when every stage passed. 2 when the script could not be read.
//
// The stages are read from package.json each time, never listed here. A gate
// script is a chain, `a && b && c`, and each part is a stage. A part that runs
// another script of the project which is itself a chain (`pnpm gate:fast`) is
// replaced by that script's parts. So a command an add-on joined to a gate is
// a stage like any other, and there is still one definition of the gate.
//
// A script that uses the shell for more than `&&` (a pipe, `;`, `||`, a
// subshell) is not split: it runs as one stage. That is still correct, only
// less exact about which part failed.
//
// Everything every stage printed is also in
// `node_modules/.cache/arch/last-gate.log`, written as it arrives, so a run
// that is killed loses nothing.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { isMainModule } from "./lib/files.mts";

/** Inside a folder git always ignores, like the stop hook's record. */
export const LOG_FILE = "node_modules/.cache/arch/last-gate.log";

export class QuietError extends Error {}

export interface StageRun {
  /** The exit code, or the code a shell gives a command a signal ended: 128 + the signal's number. */
  status: number;
  /** Everything the stage wrote, to either stream, in the order it arrived. */
  output: string;
  /** Set when the stage did not exit by itself: the signal that ended it, or why it could not start. */
  ended?: string;
}

/** Runs one stage. `onOutput` is given each piece as it arrives. Replaced in tests. */
export type RunStage = (command: string, root: string, onOutput: (chunk: string) => void) => Promise<StageRun>;

export interface QuietOptions {
  root: string;
  /** The name of the script in the root package.json: `gate:fast`, `gate:full`. */
  script: string;
  write: (text: string) => void;
  runStage?: RunStage;
  /** Asked before each stage; the run stops when it answers true. */
  isStopped?: () => boolean;
  now?: () => number;
}

/**
 * The commands `script` runs, in order: its `&&` chain, with each part that
 * runs another chain of the project replaced by that chain's parts.
 */
export function planStages(scripts: Record<string, string>, script: string, seen: string[] = []): string[] {
  const body = scripts[script];

  if (body === undefined) {
    throw new QuietError(`package.json has no "${script}" script`);
  }

  if (seen.includes(script)) {
    throw new QuietError(`the script "${script}" runs itself: ${[...seen, script].join(" → ")}`);
  }

  return splitChain(body).flatMap((command) => {
    const named = /^pnpm\s+(?:run\s+)?([\w:.-]+)$/.exec(command)?.[1];

    // Only a chain is opened up. Any other script is one stage, under the name a person would type.
    return named !== undefined && splitChain(scripts[named] ?? "").length > 1 ? planStages(scripts, named, [...seen, script]) : [command];
  });
}

/**
 * The parts of `a && b && c`. Quotes are respected. A script that uses any
 * other shell operator comes back whole: splitting it would change what runs.
 */
export function splitChain(script: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote: string | undefined;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] as string;

    if (quote !== undefined) {
      quote = character === quote ? undefined : quote;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "\\") {
      part += character + (script[index + 1] ?? "");
      index += 1;
      continue;
    } else if (script.startsWith("&&", index)) {
      parts.push(part.trim());
      part = "";
      index += 1;
      continue;
    } else if (";|&()`\n".includes(character) || script.startsWith("$(", index)) {
      return [script.trim()];
    }

    part += character;
  }

  parts.push(part.trim());

  return parts.includes("") ? [script.trim()] : parts;
}

/** Runs the stages of `script` until one fails, and returns the exit code `pnpm <script>` would give. */
export async function runQuiet({ root, script, write, runStage = runInShell, isStopped, now = Date.now }: QuietOptions): Promise<number> {
  const manifest = join(root, "package.json");

  if (!existsSync(manifest)) {
    throw new QuietError(`${root} has no package.json`);
  }

  const { scripts = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
  const stages = planStages(scripts, script);
  const log = openLog(root);
  const startedAt = now();

  try {
    for (const [index, command] of stages.entries()) {
      const notRun = (): string[] => stages.slice(index + 1).map((later) => `      ${later}`);

      if (isStopped?.()) {
        write([`STOP  before ${command}`, "not run:", `      ${command}`, ...notRun(), ""].join("\n"));

        return 1;
      }

      const stageStartedAt = now();

      log(`\n$ ${command}\n`);

      const { status, output, ended } = await runStage(command, root, log);
      const took = seconds(now() - stageStartedAt);

      if (status === 0 && ended === undefined) {
        write([`ok    ${command} (${took})`, ...skipLines(output).map((line) => `      ${line}`), ""].join("\n"));
        continue;
      }

      const failed = [
        `FAIL  ${command} (${ended ?? `exit ${status}`}, ${took})`,
        "",
        output.trimEnd() === "" ? "(it printed nothing)" : output.trimEnd(),
        "",
      ];
      const rest = notRun();

      write([...failed, ...(rest.length > 0 ? ["not run:", ...rest, ""] : []), `${script} is red.`, ""].join("\n"));

      // Never 0 here: a stage that was stopped is not a stage that passed.
      return status === 0 ? 1 : status;
    }

    write(`${script} passed: ${stages.length} stage${stages.length === 1 ? "" : "s"} in ${seconds(now() - startedAt)}.\n`);

    return 0;
  } finally {
    log.close();
  }
}

/**
 * The lines in which a check says it judged nothing. The kit's gates, the
 * add-ons' checks and the port tests all start such a line with `SKIP`; a task
 * runner may put the package's name in front. Each is given once.
 */
export function skipLines(output: string): string[] {
  return [...new Set(output.split("\n").map((line) => line.trimEnd()).filter((line) => /^(?:\S+: )?SKIP\s/.test(line)))];
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

interface Log {
  (text: string): void;
  close: () => void;
}

/** Where it cannot be written (a read-only tree) the run goes on without it. */
function openLog(root: string): Log {
  let file: number | undefined;

  try {
    mkdirSync(dirname(join(root, LOG_FILE)), { recursive: true });
    file = openSync(join(root, LOG_FILE), "w");
  } catch {
    file = undefined;
  }

  const log = (text: string): void => {
    if (file !== undefined) {
      writeSync(file, text);
    }
  };

  log.close = (): void => {
    if (file !== undefined) {
      closeSync(file);
    }
  };

  return log;
}

/** The stage that is running now, so a signal to this process can be passed on to it. */
let running: { stop: (signal: NodeJS.Signals) => void } | undefined;

/**
 * Runs `command` as pnpm would run a script's line: in a shell, in the project
 * root, with the project's installed programs on the PATH. Both streams are
 * kept as one text, however long: there is no buffer to overflow.
 */
function runInShell(command: string, root: string, onOutput: (chunk: string) => void): Promise<StageRun> {
  return new Promise((settle) => {
    const path = [join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter);
    // Its own process group, so that stopping it stops what it started as well.
    const child = spawn(command, { cwd: root, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: path } });
    let output = "";
    let stoppedBy: NodeJS.Signals | undefined;

    function keep(chunk: Buffer): void {
      output += chunk.toString("utf8");
      onOutput(chunk.toString("utf8"));
    }

    running = {
      stop: (signal) => {
        stoppedBy = signal;

        try {
          process.kill(-(child.pid as number), signal);
        } catch {
          child.kill(signal);
        }
      },
    };

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);

    child.on("error", (error) => {
      running = undefined;
      settle({ status: 127, output, ended: `could not start: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      running = undefined;

      const by = signal ?? stoppedBy;

      settle(
        by === undefined
          ? { status: code ?? 1, output }
          : { status: 128 + (constants.signals[by] ?? 0), output, ended: `stopped by ${by}` },
      );
    });
  });
}

interface CommandLine {
  script: string;
  root: string;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { script: "", root: process.cwd() };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (argument === "--root") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new QuietError('"--root" needs a folder');
      }

      options.root = resolve(value);
      index += 1;
    } else if (argument.startsWith("--") || options.script !== "") {
      throw new QuietError(`unknown argument "${argument}"`);
    } else {
      options.script = argument;
    }
  }

  if (options.script === "") {
    throw new QuietError("usage: node tools/arch/gates/quiet.mts <script> [--root <dir>]   e.g. gate:full");
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  let stoppedBy: NodeJS.Signals | undefined;

  // A signal here must not end the process at once: what the running stage
  // printed so far would be lost. It is passed on to the stage, which then
  // ends, and the run reports it like any other failure.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stoppedBy = signal;
      running?.stop(signal);
    });
  }

  try {
    const { script, root } = parseArguments(process.argv.slice(2));
    const status = await runQuiet({
      root,
      script,
      write: (text) => {
        process.stdout.write(text);
      },
      isStopped: () => stoppedBy !== undefined,
    });

    process.exitCode = stoppedBy === undefined ? status : 128 + (constants.signals[stoppedBy] ?? 0);
  } catch (error) {
    console.error(error instanceof QuietError ? `the quiet gate could not run: ${error.message}` : error);
    process.exitCode = 2;
  }
}
