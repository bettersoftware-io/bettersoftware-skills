#!/usr/bin/env node
// Creates a worktree for a piece of work, on a branch cut from the newest
// commit of the remote's main branch.
//
//   node tools/agent-workflow/new-worktree.mts <name> [--ready] [--base <branch>]
//
// It makes `<project>-worktrees/<name>`, a folder beside the project, on the
// branch `worktree-<name>`.
//
// Why a script: `git worktree add -b <branch>` cuts the branch from HEAD, so
// it starts from whatever the local checkout happens to be on. A local main
// goes stale whenever anyone else merges, and a stale start does not fail: it
// shows up later, as conflicts and as a diff that holds other people's work.
// This script fetches, then names the start explicitly as `origin/<base>`.
// HEAD and the local branches are never read.
//
// A fresh worktree has no node_modules, so nothing in it can run a test, and
// a command there fails in a way that reads like a broken change. So the last
// line always says which state the worktree is in. `--ready` runs
// `pnpm install` and then `pnpm gate:fast` in it, and says READY only when
// both passed.
//
// The name and the base are each one plain word: letters, digits and
// `. _ / -`, starting with a letter or a digit. Both are handed to git, and a
// word that starts with `-` is an option to it: `--upload-pack=<command>` as
// the base once ran that command. The fetch also says `--end-of-options`
// (git 2.24, 2019); an older git fails on that word, and the script then
// stops at "could not fetch" and makes nothing.
//
// Exit 0: the worktree exists, and with `--ready` it is proven. Exit 1: it
// exists and is not ready, or it was refused (the name is taken). Exit 2: it
// could not be made (the fetch failed, this is not a git repository).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { isMainModule } from "./lib/main.mts";
import { type Run, run, runShown } from "./lib/system.mts";

const BRANCH_PREFIX = "worktree-";
const REMOTE = "origin";
/** A worktree's name: one word with no `/`, since it is also a folder's name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A branch to start from. It may hold `/` (`release/1.x`); it may not start with `-`, hold `..`, or end in `/` or `.`. */
const BASE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const USAGE = "usage: new-worktree.mts <name> [--ready] [--base <branch>]   e.g. new-worktree.mts rates-filter-fix --ready";

export interface WorktreeOptions {
  /** Anywhere inside the project, or inside one of its worktrees. */
  cwd: string;
  argv: string[];
  /** Runs git, with its output captured. */
  run: Run;
  /** Runs the install and the proof, with their output shown. */
  runShown: Run;
  report: (line: string) => void;
}

export function newWorktree({ cwd, argv, run: runProgram, runShown: runLong, report }: WorktreeOptions): number {
  const baseAt = argv.indexOf("--base");
  const names = argv.filter((argument, index) => !argument.startsWith("--") && (baseAt === -1 || index !== baseAt + 1));
  const [name] = names;

  if (name === undefined || names.length !== 1 || !NAME.test(name) || (baseAt !== -1 && !isBase(argv[baseAt + 1]))) {
    report(USAGE);

    return 2;
  }

  const git = (...args: string[]) => runProgram("git", args, cwd);
  const listed = git("worktree", "list", "--porcelain");

  if (listed.status !== 0) {
    report(`SKIP new-worktree: ${cwd} is not inside a git repository (${listed.stderr.trim()}). Nothing was made`);

    return 2;
  }

  // The first entry is the main checkout, wherever this was run from.
  const project = (listed.stdout.split("\n")[0] ?? "").replace(/^worktree /, "");
  const path = join(dirname(project), `${basename(project)}-worktrees`, name);
  const branch = `${BRANCH_PREFIX}${name}`;

  if (existsSync(path)) {
    report(`FAIL new-worktree: ${path} already exists. Pick another name, or remove it with: git worktree remove ${path}`);

    return 1;
  }

  if (git("show-ref", "--quiet", "--verify", `refs/heads/${branch}`).status === 0) {
    report(`FAIL new-worktree: the branch ${branch} already exists. Pick another name, or delete it with: git branch -D ${branch}`);

    return 1;
  }

  const base = baseAt === -1 ? defaultBranch(git) : (argv[baseAt + 1] as string);

  // What `origin/HEAD` names is read from the repository, so it is checked like a word a person gave.
  if (!isBase(base)) {
    report(`SKIP new-worktree: ${REMOTE}'s main branch is recorded as "${base}", which is not a plain branch name. Nothing was made. Name the branch: --base <branch>`);

    return 2;
  }

  const fetched = git("fetch", REMOTE, "--end-of-options", base);

  if (fetched.status !== 0) {
    // Going on would cut the branch from whatever `origin/<base>` was at the last fetch.
    report(`SKIP new-worktree: could not fetch ${base} from ${REMOTE} (${fetched.stderr.trim()}). Nothing was made`);

    return 2;
  }

  // `--no-track`: the new branch is not a copy of main, and must never push to it.
  const added = git("worktree", "add", "--no-track", "-b", branch, path, `${REMOTE}/${base}`);

  if (added.status !== 0) {
    report(`SKIP new-worktree: git could not add the worktree (${added.stderr.trim()}). Nothing was made`);

    return 2;
  }

  report(`worktree: ${path}`);
  report(`branch:   ${branch}`);
  report(`base:     ${REMOTE}/${base} at ${runProgram("git", ["log", "-1", "--format=%h %s"], path).stdout.trim()}`);

  if (!argv.includes("--ready")) {
    report("state:    NOT READY — nothing is installed in this worktree, so nothing in it can run a test yet.");
    report(`          Before you edit, and always before you hand it to another agent: cd ${path} && pnpm install && pnpm gate:fast`);

    return 0;
  }

  report("");
  report(`--ready: pnpm install in ${path}`);

  if (runLong("pnpm", ["install"], path).status !== 0) {
    report("state:    NOT READY — pnpm install failed. Its output is above");

    return 1;
  }

  const proof = proofOf(path);

  if (proof === undefined) {
    report("state:    INSTALLED, NOT PROVEN — this project has no gate:fast script to prove the worktree with");

    return 1;
  }

  report(`--ready: pnpm ${proof}`);

  if (runLong("pnpm", [proof], path).status !== 0) {
    report(`state:    NOT READY — pnpm ${proof} failed in a worktree nobody has edited. Its output is above`);

    return 1;
  }

  report(`state:    READY — dependencies installed, pnpm ${proof} passed`);

  return 0;
}

function isBase(value: string | undefined): value is string {
  return value !== undefined && value.length <= 200 && BASE.test(value) && !value.includes("..") && !value.endsWith(".");
}

/** The branch `origin/HEAD` points at, or `main` when the clone does not record one. */
function defaultBranch(git: (...args: string[]) => { status: number; stdout: string }): string {
  const head = git("symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`);

  return head.status === 0 && head.stdout.trim().startsWith(`${REMOTE}/`) ? head.stdout.trim().slice(REMOTE.length + 1) : "main";
}

/** The script that proves a worktree can run the project's checks. */
function proofOf(path: string): string | undefined {
  const manifest = join(path, "package.json");
  const scripts = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts : undefined;

  return scripts?.["gate:fast"] === undefined ? undefined : "gate:fast";
}

if (isMainModule(import.meta.url)) {
  process.exitCode = newWorktree({ cwd: process.cwd(), argv: process.argv.slice(2), run, runShown, report: (line) => console.log(line) });
}
