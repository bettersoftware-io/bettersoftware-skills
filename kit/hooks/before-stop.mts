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
// Which project: the one the session is working in when it stops. That is
// the payload's `cwd`, which follows the agent into a worktree, and not
// `CLAUDE_PROJECT_DIR`, which stays at the checkout the session started in.
// An agent that worked in `<project>-worktrees/<name>` is judged on that
// worktree, not on the primary checkout beside it, which it never touched
// and which is green. From `cwd` the root is the top of its git checkout,
// and from there the nearest folder upward whose package.json has a gate
// script: a stop from inside a package folder runs the project's gate, not
// none. `CLAUDE_PROJECT_DIR` is read only when the payload names no folder.
// A session that edited two checkouts is judged on the one it stops in.
//
// The gate is run by the copy of the quiet runner beside this file, on the
// tree found above.
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
// Apart from that second stop, the agent finishes without a gate having
// passed in two cases only: no folder from `cwd` upward has a gate script,
// or the tree is the one a green run is on record for. Anything that goes
// wrong on the way (a package.json that is not JSON, a file that cannot be
// read) is sent back as "nothing is verified", never passed over.
//
// Works under Claude Code and Codex: both send `stop_hook_active` and both read
// `{"decision":"block","reason":…}`.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
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
  // Only the literal: a payload that says "false" in quotes is not a second stop.
  if (payload.stop_hook_active === true) {
    return undefined;
  }

  try {
    return await judgeTree(payload, run);
  } catch (error) {
    // Whatever failed, no gate passed. Saying nothing here would let the agent finish on that.
    return [
      "The stop hook could not judge this project, so nothing is verified. That is not a pass.",
      "Run the gate yourself and report what it says; if the reason below is something you changed, put it right first.",
      "",
      error instanceof Error ? error.message : String(error),
    ].join("\n");
  }
}

async function judgeTree(payload: StopPayload, run: (root: string, script: string) => GateRun | Promise<GateRun>): Promise<string | undefined> {
  const project = findProject(typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.env.CLAUDE_PROJECT_DIR || process.cwd());

  if (project === undefined) {
    return undefined;
  }

  const { root, script } = project;
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

/**
 * The project a folder belongs to, and the gate to hold it to: from the top
 * of the folder's git checkout (the folder itself where there is no git),
 * the nearest folder upward whose package.json has a gate script. Undefined
 * when there is none. Throws when a package.json on the way cannot be read:
 * a gate may be in it.
 */
export function findProject(folder: string): { root: string; script: string } | undefined {
  const asked = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: folder, encoding: "utf8" });
  const top = asked.status === 0 ? asked.stdout.replace(/\n$/, "") : "";
  let current = top === "" ? folder : top;

  for (;;) {
    const manifest = join(current, "package.json");

    if (existsSync(manifest)) {
      let scripts: unknown;

      try {
        ({ scripts } = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: unknown });
      } catch (error) {
        throw new Error(`${manifest} could not be read as JSON, so the gate script could not be looked up (${error instanceof Error ? error.message : String(error)})`);
      }

      const script = SCRIPTS.find((candidate) => typeof scripts === "object" && scripts !== null && Boolean((scripts as Record<string, unknown>)[candidate]));

      if (script !== undefined) {
        return { root: current, script };
      }
    }

    if (dirname(current) === current) {
      return undefined;
    }

    current = dirname(current);
  }
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
 * environment files it does ignore; and the version of Node. And where the
 * tree is: a record made for one checkout must never speak for another, even
 * one with the same files in it, since what git ignores (what is installed,
 * what is built) is each checkout's own.
 *
 * Undefined when that cannot be established: git cannot list the files, a
 * file cannot be read, or the tree holds a repository of its own (a
 * submodule, a nested clone), whose files git lists as one entry. Then
 * nothing is remembered and the gate runs every time.
 */
function hashWorkingTree(root: string): string | undefined {
  try {
    return hashFiles(root);
  } catch {
    // A file that went away or cannot be read between the listing and the reading.
    return undefined;
  }
}

function hashFiles(root: string): string | undefined {
  const judged = listFiles(root, ["--cached", "--others", "--exclude-standard"]);
  // `--directory` names an ignored folder once and does not walk it, so this never reads node_modules.
  const ignored = listFiles(root, ["--others", "--ignored", "--exclude-standard", "--directory"]);

  if (judged === undefined || ignored === undefined) {
    return undefined;
  }

  const hash = createHash("sha256").update(`${process.version} ${process.platform} ${process.arch}\0${realpathSync(root)}\0`);

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

  // Never through a symbolic link, as it is never written through one: a
  // `node_modules` that links to another checkout's would hand over that
  // checkout's record.
  try {
    return isPlainPath(root, LAST_GREEN) && existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
  } catch {
    // A record that cannot be read is no record.
    return undefined;
  }
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

/** What the host sent. A payload that cannot be read is an empty one: the gate is then run, never skipped. */
function readPayload(): StopPayload {
  try {
    const payload: unknown = JSON.parse(readFileSync(0, "utf8") || "{}");

    return typeof payload === "object" && payload !== null ? (payload as StopPayload) : {};
  } catch {
    return {};
  }
}

if (isMainModule(import.meta.url)) {
  const reason = await judgeStop(readPayload());
  const reply = reason ? `${JSON.stringify({ decision: "block", reason })}\n` : "";

  // Exits by itself once the reply is written: a gate that was left behind must not keep the hook alive.
  process.stdout.write(reply, () => {
    process.exit(0);
  });
}
