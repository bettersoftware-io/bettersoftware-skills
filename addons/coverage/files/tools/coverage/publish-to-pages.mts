#!/usr/bin/env node
// Publishes a folder to the branch GitHub Pages serves, without disturbing
// what other producers keep there.
//
//   node tools/coverage/publish-to-pages.mts --source <dir> [--branch gh-pages]
//        [--remote origin] [--message <commit message>]
//
// Each top-level entry of <source> replaces the entry of the same name on the
// branch; every other entry on the branch is kept. So `<source>/coverage/`
// becomes `/coverage/` on the site, and a report another workflow publishes
// under another name stays where it is.
//
// The branch is created if it does not exist. A push that is rejected because
// someone else pushed first is retried on top of their commit.
//
// Git must already be able to push to the remote (in CI: `actions/checkout`
// with `persist-credentials: true` in a job with `contents: write`).
//
// Exit 0: published, or nothing had changed. Exit 1: git failed. Exit 2: the
// arguments are wrong.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isMainModule } from "./lib/main.mts";

const PUSH_ATTEMPTS = 5;
// The commits are made by the workflow, not by a person.
const IDENTITY = ["-c", "user.name=github-actions[bot]", "-c", "user.email=github-actions[bot]@users.noreply.github.com"];

export interface PublishOptions {
  /** The folder whose top-level entries are published. */
  source: string;
  /** The git checkout to publish from. Default: the current folder. */
  repository?: string;
  branch?: string;
  remote?: string;
  message?: string;
}

export type PublishOutcome = "published" | "no changes";

/** The arguments are wrong. Reported with exit code 2. */
export class PublishError extends Error {}

export function publishToPages({
  source,
  repository = process.cwd(),
  branch = "gh-pages",
  remote = "origin",
  message = `publish to ${branch}`,
}: PublishOptions): PublishOutcome {
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new PublishError(`--source is not a folder: ${source}`);
  }

  const owned = readdirSync(source);

  if (owned.length === 0) {
    throw new PublishError(`--source is empty: ${source} — there is nothing to publish`);
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const fetchBranch = ["fetch", "--no-tags", remote, `+refs/heads/${branch}:${remoteRef}`];
  const work = mkdtempSync(join(tmpdir(), "pages-"));

  try {
    if (branchExists(repository, fetchBranch, remoteRef)) {
      git(repository, ["worktree", "add", "-B", branch, work, remoteRef]);
    } else {
      git(repository, ["worktree", "add", "--detach", work]);
      git(work, ["checkout", "--orphan", branch]);
      git(work, ["rm", "-rf", "--quiet", "--ignore-unmatch", "."]);
    }

    for (const entry of owned) {
      rmSync(join(work, entry), { recursive: true, force: true });
      cpSync(join(resolve(source), entry), join(work, entry), { recursive: true });
    }

    // Without this file Pages runs Jekyll, which drops every folder whose name
    // starts with an underscore — `__fixtures__` in a coverage report, say.
    writeFileSync(join(work, ".nojekyll"), "");

    git(work, ["add", "-A"]);

    if (git(work, ["status", "--porcelain"]) === "") {
      return "no changes";
    }

    git(work, ["commit", "--quiet", "-m", message]);
    push(work, remote, branch, fetchBranch, remoteRef);

    return "published";
  } finally {
    try {
      git(repository, ["worktree", "remove", "--force", work]);
    } catch {
      // The folder is removed below either way.
    }

    rmSync(work, { recursive: true, force: true });
  }
}

function branchExists(repository: string, fetchBranch: string[], remoteRef: string): boolean {
  try {
    git(repository, fetchBranch);
    git(repository, ["rev-parse", "--verify", "--quiet", remoteRef]);

    return true;
  } catch {
    return false;
  }
}

/** Pushes, and when the remote has moved on, rebases onto it and tries again. */
function push(work: string, remote: string, branch: string, fetchBranch: string[], remoteRef: string): void {
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    try {
      git(work, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]);

      return;
    } catch (error) {
      if (attempt === PUSH_ATTEMPTS) {
        throw error;
      }

      console.error(`push rejected (attempt ${attempt} of ${PUSH_ATTEMPTS}); rebasing on ${remote}/${branch}`);

      if (branchExists(work, fetchBranch, remoteRef)) {
        git(work, ["rebase", "--quiet", remoteRef]);
      }
    }
  }
}

function git(directory: string, gitArguments: string[]): string {
  return execFileSync("git", [...IDENTITY, ...gitArguments], { cwd: directory, stdio: "pipe", encoding: "utf8" }).trim();
}

function parseArguments(argv: string[]): PublishOptions {
  const values: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];

    if (!["--source", "--branch", "--remote", "--message"].includes(flag)) {
      throw new PublishError(`unknown argument "${flag}"`);
    }

    if (value === undefined) {
      throw new PublishError(`"${flag}" needs a value`);
    }

    values[flag.slice(2)] = value;
  }

  if (values.source === undefined) {
    throw new PublishError("usage: publish-to-pages.mts --source <dir> [--branch gh-pages] [--remote origin] [--message <msg>]");
  }

  return { source: values.source, branch: values.branch, remote: values.remote, message: values.message };
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const outcome = publishToPages(options);

    console.log(outcome === "published" ? `published to ${options.branch ?? "gh-pages"}` : "no changes to publish");
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(`publish-to-pages could not run: ${error.message}`);
      process.exit(2);
    }

    // Git's own words (a rejected push, missing credentials) say more than a stack trace.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();

    console.error(stderr === "" ? error : stderr);
    process.exit(1);
  }
}
