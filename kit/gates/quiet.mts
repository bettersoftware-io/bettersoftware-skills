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
// A part is opened up only when its parts are certainly what pnpm would have
// run. Anything else runs whole, as written, by pnpm itself:
//
//   - `pnpm run <name>` with nothing after it, or `pnpm <name>` where the name
//     holds a colon. `pnpm audit` is pnpm's own command even in a project with
//     an `audit` script, and no command of pnpm has a colon in its name;
//   - no flag and no argument (`--if-present`, `--filter`, `-r`, `--`);
//   - no `pre<name>` or `post<name>` script, which pnpm would run around it;
//   - `npm run` and `yarn` are never opened up.
//
// A stage that comes from an opened script gets what pnpm gives that script:
// the project's `node_modules/.bin` first on the PATH, and `INIT_CWD`,
// `PNPM_SCRIPT_SRC_DIR`, `npm_lifecycle_event`, `npm_lifecycle_script`,
// `npm_package_json`, `npm_package_name`, `npm_package_version`, `NODE` and
// `npm_node_execpath`.
//
// A script that uses the shell for more than `&&` (a pipe, `;`, `||`, a
// subshell) is not split: it runs as one stage. That is still correct, only
// less exact about which part failed.
//
// Each stage runs in a shell of its own, so nothing a part does to its shell
// reaches the parts after it. `cd sub && node check.mjs`, split, would run the
// check in the wrong folder; `export STRICT=1 && …` would lose the variable.
// A wrong folder or a lost variable can turn a red gate green, so a chain is
// split only when every part is certainly a program: its first word, after
// any `NAME=value` in front, is one the stage's own shell finds as a file on
// the `PATH` (`pnpm`, `node`, what `node_modules/.bin` holds). The shell is
// asked (`command -v`); no list of its builtins is kept here, so a word this
// does not know is never taken for harmless. `cd`, `export`, `set`, `.`,
// `eval`, `exec`, a bare `NAME=value`, `!`, `{`, a function: none is a file
// on the `PATH`, and the script runs whole. So does one that reads what only
// the shell of the whole chain has: `$?`, `$_`, `$!`, `${…}`.
//
// The shell asked is `/bin/sh`, the one the stages run in, so the answer is
// the one that shell acts on: `time` is a word of bash's own and a file to
// dash. A word with a slash is a path, which no shell runs itself: the file
// is looked at instead, since shells do not agree on what to say about one.
//
// Told to stop (SIGINT, SIGTERM), it never waits on the stage: the stage's
// process group gets SIGTERM, then SIGKILL, and the run ends within seconds
// with what the stage had printed, whatever the stage does. A second signal
// ends it at once. A run that was stopped never exits 0.
//
// The commands come from package.json and run in a shell, as `pnpm run` runs
// them: this trusts the project exactly as far as running its gate does.
//
// Everything every stage printed is also in
// `node_modules/.cache/arch/last-gate.log`, written as it arrives, so a run
// that is killed loses nothing.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants as fileConstants, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { isMainModule, isPlainPath } from "./lib/files.mts";

/** Inside a folder git always ignores, like the stop hook's record. */
export const LOG_FILE = "node_modules/.cache/arch/last-gate.log";

export class QuietError extends Error {}

export interface Stage {
  /** One line for a shell. */
  command: string;
  /** What pnpm would add to the environment of this command; empty for a part pnpm itself is left to run. */
  env: Record<string, string>;
}

export interface StageRun {
  /** The exit code, or the code a shell gives a command a signal ended: 128 + the signal's number. */
  status: number;
  /** What the stage wrote, to either stream, in the order it arrived. The end of it, when `dropped` is set. */
  output: string;
  /** Set when the stage did not exit by itself: the signal that ended it, or why it could not start. */
  ended?: string;
  /** How many characters from the start of the output are not in `output`, because it outgrew what is kept in memory. */
  dropped?: number;
}

/** Runs one stage. `onOutput` is given each piece as it arrives. Replaced in tests. */
export type RunStage = (stage: Stage, root: string, onOutput: (chunk: string) => void) => Promise<StageRun>;

export interface QuietOptions {
  root: string;
  /** The name of the script in the root package.json: `gate:fast`, `gate:full`. */
  script: string;
  write: (text: string) => void;
  runStage?: RunStage;
  /** Whether a word is a program the stage's shell would find as a file. Replaced in tests whose commands are made up. */
  isProgram?: IsProgram;
  /** Asked before each stage; the run stops when it answers true. */
  isStopped?: () => boolean;
  now?: () => number;
}

interface Manifest {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

/** Says whether a word, as the first of a command, is a program found as a file. */
export type IsProgram = (word: string) => boolean;

/**
 * The commands `script` runs, in order: its `&&` chain, with each part that
 * runs another chain of the project replaced by that chain's parts.
 */
export function planStages(
  scripts: Record<string, string>,
  script: string,
  isProgram: IsProgram = createProgramFinder(process.cwd()),
  seen: string[] = [],
): { command: string; script?: string }[] {
  const body = scripts[script];

  if (body === undefined) {
    throw new QuietError(`package.json has no "${script}" script`);
  }

  if (seen.includes(script)) {
    throw new QuietError(`the script "${script}" runs itself: ${[...seen, script].join(" → ")}`);
  }

  // pnpm runs these around the script. Only pnpm is trusted to do that, so it is given the whole script.
  if (hasHooks(scripts, script)) {
    return [{ command: `pnpm run ${script}` }];
  }

  return splitStages(body, isProgram).flatMap((command) => {
    const named = scriptRunBy(command);

    // Only a chain is opened up. Any other script is one stage, under the name a person would type.
    return named !== undefined && splitStages(scripts[named] ?? "", isProgram).length > 1
      ? planStages(scripts, named, isProgram, [...seen, script])
      : [{ command, script }];
  });
}

/** `NAME=value` any number of times, then the command's first word. A value or a word with a quote or a `$` in it is not read. */
const FIRST_WORD = /^(?:[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+,=-]*\s+)*([A-Za-z0-9_./@+-]+)(?:\s|$)/;
/** A `$` that is not the start of a plain variable's name: `$?`, `$_`, `$!`, `$$`, `$1`, `${…}`. */
const SHELL_STATE = /\$(?![A-Za-z]|_[A-Za-z0-9_])/;

/**
 * The parts of a chain that may each run in a shell of its own: every part
 * starts with a program, and none reads what only the chain's own shell has.
 * Any other script comes back whole.
 */
export function splitStages(script: string, isProgram: IsProgram): string[] {
  const parts = splitChain(script);
  const separable =
    !SHELL_STATE.test(script) &&
    parts.every((part) => {
      const word = FIRST_WORD.exec(part)?.[1];

      return word !== undefined && isProgram(word);
    });

  return separable ? parts : [script.trim()];
}

/**
 * Asks the shell a stage runs in whether a word is a program: `command -v`
 * prints a path for a file on the `PATH`, and the bare word, or an alias's
 * definition, for anything the shell would run itself. Each word is asked
 * once. Where there is no such shell (Windows), nothing is a program, and
 * every script runs whole.
 *
 * A word with a slash names a file, which no shell runs itself, so the file
 * is looked at and the shell is not asked: shells answer differently there.
 * bash says the word back only for a file it can run; dash says it back for
 * anything that exists, a folder included; ksh gives the whole path.
 */
export function createProgramFinder(root: string): IsProgram {
  const known = new Map<string, boolean>();
  const path = [join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter);

  return (word) => {
    let found = known.get(word);

    if (found === undefined) {
      if (process.platform === "win32") {
        found = false;
      } else if (word.includes("/")) {
        found = isRunnableFile(resolve(root, word));
      } else {
        const asked = spawnSync("/bin/sh", ["-c", 'command -v -- "$1"', "sh", word], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: path } });

        found = asked.status === 0 && asked.stdout.trim().startsWith("/");
      }

      known.set(word, found);
    }

    return found;
  };
}

/** Whether the path is a file this process may run. A folder is not, though it has the same permission bit. */
function isRunnableFile(file: string): boolean {
  try {
    accessSync(file, fileConstants.X_OK);

    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The script a command certainly runs, when it is `pnpm run <name>` or
 * `pnpm <name:with:colon>` and nothing more. `pnpm <word>` may be a command of
 * pnpm (`audit`, `install`, `exec`, `store`), which wins over a script of that
 * name; none of its commands has a colon.
 */
export function scriptRunBy(command: string): string | undefined {
  return /^pnpm\s+run\s+([\w:.-]+)$/.exec(command)?.[1] ?? /^pnpm\s+([\w.-]*:[\w:.-]*)$/.exec(command)?.[1];
}

function hasHooks(scripts: Record<string, string>, script: string): boolean {
  return scripts[`pre${script}`] !== undefined || scripts[`post${script}`] !== undefined;
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

/** What pnpm 12 adds to the environment of a script's line, beyond the PATH. Measured, not taken from its documentation. */
export function scriptEnvironment(root: string, manifest: Manifest, script: string): Record<string, string> {
  return {
    INIT_CWD: root,
    PNPM_SCRIPT_SRC_DIR: root,
    NODE: process.execPath,
    npm_node_execpath: process.execPath,
    npm_lifecycle_event: script,
    npm_lifecycle_script: manifest.scripts?.[script] ?? "",
    npm_package_json: join(root, "package.json"),
    ...(manifest.name === undefined ? {} : { npm_package_name: manifest.name }),
    ...(manifest.version === undefined ? {} : { npm_package_version: manifest.version }),
  };
}

/** Runs the stages of `script` until one fails, and returns the exit code `pnpm <script>` would give. */
export async function runQuiet({
  root,
  script,
  write,
  runStage = createShellRunner(),
  isProgram = createProgramFinder(root),
  isStopped,
  now = Date.now,
}: QuietOptions): Promise<number> {
  const manifestFile = join(root, "package.json");

  if (!existsSync(manifestFile)) {
    throw new QuietError(`${root} has no package.json`);
  }

  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const stages = planStages(manifest.scripts ?? {}, script, isProgram).map(
    (planned): Stage => ({ command: planned.command, env: planned.script === undefined ? {} : scriptEnvironment(root, manifest, planned.script) }),
  );
  const log = openLog(root);
  const startedAt = now();

  try {
    for (const [index, stage] of stages.entries()) {
      const { command } = stage;
      const notRun = (): string[] => stages.slice(index + 1).map((later) => `      ${later.command}`);

      if (isStopped?.()) {
        write([`STOP  before ${command}`, "not run:", `      ${command}`, ...notRun(), ""].join("\n"));

        return 1;
      }

      const stageStartedAt = now();
      const skips = createSkipCollector();

      log(`\n$ ${command}\n`);

      const { status, output, ended, dropped } = await runStage(stage, root, (chunk) => {
        log(chunk);
        skips.add(chunk);
      });
      const took = seconds(now() - stageStartedAt);

      if (status === 0 && ended === undefined) {
        // From the stream, which saw everything, and from the text, for a runner that gives only that.
        const skipped = [...new Set([...skips.lines(), ...skipLines(output)])];

        write([`ok    ${command} (${took})`, ...skipped.map((line) => `      ${line}`), ""].join("\n"));
        continue;
      }

      const failed = [
        `FAIL  ${command} (${ended ?? `exit ${status}`}, ${took})`,
        "",
        ...(dropped ? [`(the first ${dropped} characters are not shown. ${log.kept ? `They are in ${LOG_FILE}` : "They were not kept: the log could not be written"})`] : []),
        output.trimEnd() === "" ? "(it printed nothing)" : output.trimEnd(),
        "",
      ];
      const rest = notRun();

      write([...failed, ...(rest.length > 0 ? ["not run:", ...rest, ""] : []), `${script} is red.`, ""].join("\n"));

      // Never 0 here: a stage that was stopped is not a stage that passed.
      return status === 0 ? 1 : status;
    }

    // Asked once more: a signal that came as the last stage ended must not leave a pass behind it.
    if (isStopped?.()) {
      write(`STOP  after the last stage. ${script} was stopped, so this is not a pass.\n`);

      return 1;
    }

    write(`${script} passed: ${stages.length} stage${stages.length === 1 ? "" : "s"} in ${seconds(now() - startedAt)}.\n`);

    return 0;
  } finally {
    log.close();
  }
}

// Colour codes, which a tool told to force colour puts in front of the word.
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The lines in which a check says it judged nothing. The kit's gates, the
 * add-ons' checks and the port tests all start such a line with `SKIP`; a task
 * runner may put the package's name in front, and a tool may indent or colour
 * it. Each is given once.
 */
export function skipLines(output: string): string[] {
  const lines = output.split("\n").map((line) => line.replace(ESCAPE_SEQUENCE, "").trim());

  return [...new Set(lines.filter((line) => /^(?:\S+: )?SKIP\s/.test(line)))];
}

/** Finds the `SKIP` lines of an output as it arrives, so none is missed in a part that is no longer kept. */
function createSkipCollector(): { add: (chunk: string) => void; lines: () => string[] } {
  const found: string[] = [];
  let unfinished = "";

  return {
    add: (chunk) => {
      const text = unfinished + chunk;
      const end = text.lastIndexOf("\n");

      found.push(...skipLines(text.slice(0, end + 1)));
      unfinished = text.slice(end + 1);
    },
    lines: () => [...new Set([...found, ...skipLines(unfinished)])],
  };
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

interface Log {
  (text: string): void;
  /** False when the log could not be opened, so what is not printed is not kept anywhere. */
  kept: boolean;
  close: () => void;
}

/**
 * Where it cannot be written (a read-only tree) the run goes on without it.
 * It is never written through a symbolic link: the path is a fixed one in a
 * tree this did not make, and a link there would send every stage's output,
 * and a truncation, wherever the link points.
 */
function openLog(root: string): Log {
  let file: number | undefined;

  try {
    if (isPlainPath(root, LOG_FILE)) {
      mkdirSync(dirname(join(root, LOG_FILE)), { recursive: true });
      file = openSync(join(root, LOG_FILE), fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_TRUNC | fileConstants.O_NOFOLLOW, 0o600);
    }
  } catch {
    file = undefined;
  }

  const log = (text: string): void => {
    if (file !== undefined) {
      writeSync(file, text);
    }
  };

  log.kept = file !== undefined;

  log.close = (): void => {
    if (file !== undefined) {
      closeSync(file);
    }
  };

  return log;
}

/** How a request to stop reaches the stage that is running. */
export interface Stopper {
  /** The signal that asked first; undefined while nobody has. */
  readonly signal: NodeJS.Signals | undefined;
  /** Called for each request: `again` is true from the second on. */
  request: (signal: NodeJS.Signals) => void;
  onRequest: (listener: (signal: NodeJS.Signals, again: boolean) => void) => () => void;
}

export function createStopper(): Stopper {
  const listeners = new Set<(signal: NodeJS.Signals, again: boolean) => void>();
  let first: NodeJS.Signals | undefined;

  return {
    get signal() {
      return first;
    },
    request: (signal) => {
      const again = first !== undefined;

      first ??= signal;

      for (const listener of [...listeners]) {
        listener(signal, again);
      }
    },
    onRequest: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface RunnerLimits {
  /** After a request to stop: how long the stage has to end on SIGTERM before it gets SIGKILL. */
  graceMs: number;
  /** After SIGKILL: how long to wait for it to be gone before going on without it. */
  abandonMs: number;
  /** After a stage exits: how long to wait for what it started to close its output. */
  drainMs: number;
  /** How much of a stage's output is kept in memory. All of it is in the log. */
  keptCharacters: number;
}

export const LIMITS: RunnerLimits = { graceMs: 5000, abandonMs: 2000, drainMs: 1000, keptCharacters: 32 * 1024 * 1024 };

/**
 * A runner that runs a stage as pnpm would run a script's line: in a shell, in
 * the project root, with the project's installed programs on the PATH.
 *
 * It never waits without a bound. A stage that exits while something it
 * started still holds its output open is given `drainMs`, as pnpm would not
 * wait for that at all. A stage asked to stop is given `graceMs`, then killed,
 * then left behind after `abandonMs` if it is somehow still there.
 */
export function createShellRunner(stopper: Stopper = createStopper(), limits: RunnerLimits = LIMITS): RunStage {
  return (stage, root, onOutput) =>
    new Promise((settle) => {
      const path = [join(root, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter);
      // Its own process group, so that stopping it stops what it started as well.
      const child = spawn(stage.command, {
        cwd: root,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...stage.env, PATH: path },
      });
      const timers: NodeJS.Timeout[] = [];
      let output = "";
      let dropped = 0;
      let stoppedBy = stopper.signal;
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let finished = false;

      function keep(chunk: Buffer): void {
        const text = chunk.toString("utf8");

        output += text;
        onOutput(text);

        if (output.length > limits.keptCharacters) {
          dropped += output.length - limits.keptCharacters;
          output = output.slice(-limits.keptCharacters);
        }
      }

      function signalGroup(signal: NodeJS.Signals): void {
        try {
          process.kill(-(child.pid as number), signal);
        } catch {
          child.kill(signal);
        }
      }

      function finish(startError?: Error): void {
        if (finished) {
          return;
        }

        finished = true;
        timers.forEach(clearTimeout);
        forget();
        // Whatever still holds them open must not hold this process open.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();

        const by = stoppedBy ?? exited?.signal ?? undefined;
        const kept = dropped > 0 ? { dropped } : {};

        if (startError !== undefined) {
          settle({ status: 127, output, ended: `could not start: ${startError.message}`, ...kept });
        } else if (by !== undefined) {
          settle({ status: 128 + (constants.signals[by] ?? 0), output, ended: `stopped by ${by}${exited === undefined ? ", and still running when it was left" : ""}`, ...kept });
        } else {
          settle({ status: exited?.code ?? 1, output, ...kept });
        }
      }

      function stop(signal: NodeJS.Signals, again: boolean): void {
        stoppedBy ??= signal;

        if (again) {
          signalGroup("SIGKILL");
          finish();

          return;
        }

        signalGroup("SIGTERM");
        timers.push(
          setTimeout(() => {
            signalGroup("SIGKILL");
            timers.push(setTimeout(finish, limits.abandonMs));
          }, limits.graceMs),
        );
      }

      const forget = stopper.onRequest(stop);

      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", finish);
      child.on("close", () => {
        finish();
      });
      child.on("exit", (code, signal) => {
        exited = { code, signal };
        timers.push(
          setTimeout(() => {
            finish();
          }, limits.drainMs),
        );
      });

      // Asked to stop before this stage began.
      if (stoppedBy !== undefined) {
        stop(stoppedBy, false);
      }
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
  const stopper = createStopper();
  let status = 2;

  // A signal here must not end the process at once: what the running stage
  // printed so far would be lost. It is passed on to the stage, which is
  // stopped within a bound, and the run reports it like any other failure.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopper.request(signal);
    });
  }

  try {
    const { script, root } = parseArguments(process.argv.slice(2));

    status = await runQuiet({
      root,
      script,
      write: (text) => {
        process.stdout.write(text);
      },
      runStage: createShellRunner(stopper),
      isStopped: () => stopper.signal !== undefined,
    });

    // Whatever the run answered, a run that was told to stop did not pass.
    if (stopper.signal !== undefined) {
      status = 128 + (constants.signals[stopper.signal] ?? 0);
    }
  } catch (error) {
    console.error(error instanceof QuietError ? `the quiet gate could not run: ${error.message}` : error);
    status = 2;
  }

  // Exits by itself, once what it printed is written: a stage that was left
  // behind may still hold something open, and must not keep this alive.
  process.stdout.write("", () => {
    process.exit(status);
  });
}
