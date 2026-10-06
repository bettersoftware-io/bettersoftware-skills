#!/usr/bin/env node
// Stop hook: the agent may not finish while the project's gate is red.
//
// It runs the project's own script, the same commands a person or CI runs, so
// there is one definition of "green": `gate:full` (what CI runs) when the
// project has one, `gate:fast` otherwise. A red gate sends the output back as
// the next instruction.
//
// The script is run through `gates/quiet.mts`, which runs the same commands
// in the same order and prints only the stage that failed. What goes back to
// the agent is the end of that output, so it is the failure, and not the
// passing tests that happened to be printed last.
//
// The hook always answers by itself. The host gives it ten minutes and then
// kills it, and a hook that was killed blocks nothing. So the gate is told to
// stop at nine minutes, killed if it does not, and left behind if even that
// does not end it; each of those is reported as "nothing is verified".
//
// The full gate takes minutes, so it is not run on a tree it has already
// passed. After a green run the hook remembers a hash of every file git does
// not ignore; while that hash is unchanged the agent finishes at once. An
// agent that only answered a question never waits, and one that edited
// anything is held to the whole gate.
//
// This is a guard against stopping early, not a lock. The record is a file,
// and an agent that sets out to cheat can write it, as it can rewrite the
// `gate:full` script or this hook. What catches that is CI, which runs the
// same script from nothing. The record is also only as complete as its hash:
// an input the hash leaves out (an environment variable, a tool installed
// outside the project) can change the verdict without changing the record.
//
// `stop_hook_active` means the agent is already continuing because of this
// hook; it is let through then, so a gate the agent cannot fix ends in a
// report to the user and never in a loop.
//
// Works under Claude Code and Codex: both send `stop_hook_active` and both read
// `{"decision":"block","reason":…}`.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isMainModule, isPlainPath } from "../gates/lib/files.mts";

/** Tried in order: the gate CI runs, then the fast one for a project that has no other. */
const SCRIPTS = ["gate:full", "gate:fast"];
/** Inside a folder git always ignores, so writing it never changes the tree it describes. */
const LAST_GREEN = "node_modules/.cache/arch/last-green-tree";
const TAIL_CHARACTERS = 4000;

export interface RunLimits {
  /** How long the gate may run before it is told to stop. */
  runMs: number;
  /** How long the runner then has to stop its stage, report and exit, before it is killed. */
  stopMs: number;
  /** How long to wait for a killed runner to be gone, before answering without it. */
  killMs: number;
}

/**
 * Together shorter than the hook's own timeout in the host's settings (ten
 * minutes), so this script is the one that reports a gate that did not
 * finish. A hook the host has to kill blocks nothing: the agent would stop
 * with nothing verified and nobody told.
 */
export const RUN_LIMITS: RunLimits = { runMs: 9 * 60 * 1000, stopMs: 20 * 1000, killMs: 5 * 1000 };

/** The fields both hosts send that this hook reads. */
export interface StopPayload {
  cwd?: string;
  stop_hook_active?: boolean;
}

export interface GateRun {
  status: number;
  output: string;
  /** The gate was stopped before it finished, so it verified nothing. */
  timedOut?: boolean;
}

export async function judgeStop(
  payload: StopPayload,
  run: (root: string, script: string) => GateRun | Promise<GateRun> = runGate,
): Promise<string | undefined> {
  if (payload.stop_hook_active) {
    return undefined;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const manifest = join(root, "package.json");

  if (!existsSync(manifest)) {
    return undefined;
  }

  const { scripts } = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };
  const script = SCRIPTS.find((candidate) => scripts?.[candidate]);

  if (script === undefined) {
    return undefined;
  }

  const tree = hashWorkingTree(root);

  if (tree !== undefined && tree === readLastGreen(root)) {
    return undefined;
  }

  const { status, output, timedOut } = await run(root, script);

  // Asked first, and whatever the status: a run that was stopped proves nothing, even one that then exited 0.
  if (timedOut) {
    return [
      `\`${script}\` did not finish in time and was stopped, so nothing is verified. That is not a pass.`,
      "Run it yourself, and report what it says; if it cannot finish, say so plainly.",
      "",
      output.slice(-TAIL_CHARACTERS),
    ].join("\n");
  }

  if (status === 0) {
    // The tree as it was before the run. If the gate itself rewrote a file,
    // the tree is no longer this one, and the next stop judges the new one.
    if (tree !== undefined) {
      writeLastGreen(root, tree);
    }

    return undefined;
  }

  return [
    `\`${script}\` is red, so the work is not finished. Fix what it reports and run it again.`,
    "If a finding is wrong or outside what you were asked to do, say so plainly instead of working around the gate.",
    "",
    output.slice(-TAIL_CHARACTERS),
  ].join("\n");
}

/** The quiet runner, in the copy of the kit this hook is in. */
const QUIET_RUNNER = join(import.meta.dirname, "..", "gates", "quiet.mts");
/** Only the end of the output is sent back, so only the end is kept. */
const KEPT_CHARACTERS = 64 * 1024;

/**
 * Runs the gate, and answers within `runMs + stopMs + killMs` whatever the
 * runner does. Past `runMs` the runner is told to stop (SIGTERM): it stops its
 * stage, prints what the stage had said, and exits. If it has not exited
 * `stopMs` later it is killed. If even then it does not go, or something it
 * left behind holds its output open, the answer is given without it.
 *
 * Not `spawnSync` with a timeout: that waits for the child for ever when the
 * child outlives the signal, and it stops reading at the timeout, so what the
 * runner prints once it is told to stop was never seen.
 */
export function runGate(root: string, script: string, limits: RunLimits = RUN_LIMITS, runner: string = QUIET_RUNNER): Promise<GateRun> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [runner, script, "--root", root], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const timers: NodeJS.Timeout[] = [];
    let output = "";
    let timedOut = false;
    let answered = false;

    function keep(chunk: Buffer): void {
      output = (output + chunk.toString("utf8")).slice(-KEPT_CHARACTERS);
    }

    function answer(status: number | null, note = ""): void {
      if (answered) {
        return;
      }

      answered = true;
      timers.forEach(clearTimeout);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      // Never 0 for a run that was stopped or that ended any way but by exiting.
      settle({ status: timedOut || status === null ? status || 1 : status, output: `${output}${note}`, timedOut });
    }

    timers.push(
      setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        timers.push(
          setTimeout(() => {
            child.kill("SIGKILL");
            timers.push(
              setTimeout(() => {
                answer(null, "\n(the gate did not end when it was killed, and was left behind)");
              }, limits.killMs),
            );
          }, limits.stopMs),
        );
      }, limits.runMs),
    );

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      answer(null, `\n${error.message}`);
    });
    child.on("close", (code) => {
      answer(code);
    });
  });
}

/** A file of settings that git usually ignores and that a build or a test may read. */
const ENVIRONMENT_FILE = /(^|\/)\.env(\.[^/]*)?$/;

/**
 * One hash over everything a gate's verdict is taken to depend on: the path
 * and content of every file git does not ignore, tracked or not; the
 * environment files it does ignore; and the version of Node.
 *
 * Undefined when that cannot be established: git cannot list the files, or
 * the tree holds a repository of its own (a submodule, a nested clone), whose
 * files git lists as one entry. Then nothing is remembered and the gate runs
 * every time.
 */
function hashWorkingTree(root: string): string | undefined {
  const judged = listFiles(root, ["--cached", "--others", "--exclude-standard"]);
  // `--directory` names an ignored folder once and does not walk it, so this never reads node_modules.
  const ignored = listFiles(root, ["--others", "--ignored", "--exclude-standard", "--directory"]);

  if (judged === undefined || ignored === undefined) {
    return undefined;
  }

  const hash = createHash("sha256").update(`${process.version} ${process.platform} ${process.arch}\0`);

  for (const path of [...judged, ...ignored.filter((entry) => ENVIRONMENT_FILE.test(entry))].sort()) {
    const file = lstatSync(join(root, path), { throwIfNoEntry: false });

    hash.update(`${path}\0`);

    if (file?.isDirectory()) {
      return undefined;
    }

    if (file?.isSymbolicLink()) {
      hash.update(readlinkSync(join(root, path)));
    } else if (file?.isFile()) {
      hash.update(readFileSync(join(root, path)));
    } else {
      // Deleted, but still in git's index.
      hash.update("\0absent");
    }

    hash.update("\0");
  }

  return hash.digest("hex");
}

function listFiles(root: string, which: string[]): string[] | undefined {
  const listed = spawnSync("git", ["ls-files", ...which, "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

  return listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : undefined;
}

function readLastGreen(root: string): string | undefined {
  const file = join(root, LAST_GREEN);

  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

function writeLastGreen(root: string, tree: string): void {
  const file = join(root, LAST_GREEN);

  // Never through a symbolic link: the place is a fixed one in a tree this did not make.
  if (!isPlainPath(root, LAST_GREEN)) {
    return;
  }

  // Where it cannot be stored, the next stop simply runs the gate again.
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${tree}\n`);
  } catch {
    // Nothing to do: the verdict of this run stands, and it was green.
  }
}

if (isMainModule(import.meta.url)) {
  const reason = await judgeStop(JSON.parse(readFileSync(0, "utf8") || "{}") as StopPayload);
  const reply = reason ? `${JSON.stringify({ decision: "block", reason })}\n` : "";

  // Exits by itself once the reply is written: a gate that was left behind must not keep the hook alive.
  process.stdout.write(reply, () => {
    process.exit(0);
  });
}
