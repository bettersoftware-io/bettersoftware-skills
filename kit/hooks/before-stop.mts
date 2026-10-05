#!/usr/bin/env node
// Stop hook: the agent may not finish while the project's gate is red.
//
// It runs the project's own script, the same command a person or CI runs, so
// there is one definition of "green": `gate:full` (what CI runs) when the
// project has one, `gate:fast` otherwise. A red gate sends the output back as
// the next instruction.
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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isMainModule } from "../gates/lib/files.mts";

/** Tried in order: the gate CI runs, then the fast one for a project that has no other. */
const SCRIPTS = ["gate:full", "gate:fast"];
/** Inside a folder git always ignores, so writing it never changes the tree it describes. */
const LAST_GREEN = "node_modules/.cache/arch/last-green-tree";
/** Shorter than the hook's own timeout in the host's settings, so this script is the one that reports it. */
const RUN_TIMEOUT_MS = 9 * 60 * 1000;
const TAIL_CHARACTERS = 4000;

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

export function judgeStop(
  payload: StopPayload,
  run: (root: string, script: string) => GateRun = runGate,
): string | undefined {
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

  const { status, output, timedOut } = run(root, script);

  if (timedOut) {
    return [
      `\`${script}\` did not finish in ${RUN_TIMEOUT_MS / 60000} minutes, so nothing is verified. That is not a pass.`,
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

function runGate(root: string, script: string): GateRun {
  const result = spawnSync("pnpm", ["--silent", "run", script], { cwd: root, encoding: "utf8", timeout: RUN_TIMEOUT_MS });

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
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

  // Where it cannot be stored, the next stop simply runs the gate again.
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${tree}\n`);
  } catch {
    // Nothing to do: the verdict of this run stands, and it was green.
  }
}

if (isMainModule(import.meta.url)) {
  const reason = judgeStop(JSON.parse(readFileSync(0, "utf8") || "{}") as StopPayload);

  if (reason) {
    console.log(JSON.stringify({ decision: "block", reason }));
  }
}
