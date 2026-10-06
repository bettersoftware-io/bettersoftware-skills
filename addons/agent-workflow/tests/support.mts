// Fixture factories shared by the agent-workflow add-on's tests. Nothing here
// reaches a network: every git repository is a folder made for the test, and
// its "remote" is another folder beside it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ADDON = join(import.meta.dirname, "..");
export const REPOSITORY = join(ADDON, "..", "..");
export const TOOLS = join(ADDON, "files/tools/agent-workflow");

/** A fresh folder holding `files` (path → content). */
export function createFolder(files: Record<string, string> = {}): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "agent-workflow-addon-")));

  for (const [path, content] of Object.entries(files)) {
    writeFile(folder, path, content);
  }

  return folder;
}

export function writeFile(folder: string, path: string, content: string): void {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), content);
}

export function readJson<T = Record<string, unknown>>(folder: string, path: string): T {
  return JSON.parse(readFileSync(join(folder, path), "utf8")) as T;
}

/** Runs git in `cwd` and returns what it printed. Throws when git fails. */
export function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${run.stderr}`);
  }

  return run.stdout.trim();
}

/** Commits `files` in `repository`, at `date` when one is given, and returns the commit's hash. */
export function commit(repository: string, message: string, files: Record<string, string>, date?: string): string {
  for (const [path, content] of Object.entries(files)) {
    writeFile(repository, path, content);
  }

  git(repository, "add", "-A");

  const run = spawnSync("git", ["commit", "--quiet", "-m", message], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  });

  if (run.status !== 0) {
    throw new Error(`git commit failed in ${repository}:\n${run.stderr}`);
  }

  return git(repository, "rev-parse", "HEAD");
}

export interface Remote {
  /** The bare repository that plays `origin`. */
  origin: string;
  /** A clone of it: the checkout a person works in. */
  clone: string;
  /** A second clone, used to move `origin` on without the first one knowing. */
  other: string;
}

/** An `origin` with one commit on `main`, and two clones of it. */
export function createRemote(): Remote {
  const root = createFolder();
  const origin = join(root, "origin.git");
  const clone = join(root, "project");
  const other = join(root, "other");

  mkdirSync(origin);
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(root, "clone", "--quiet", origin, clone);
  git(clone, "checkout", "--quiet", "-b", "main");
  commit(clone, "first", { "package.json": `${JSON.stringify({ name: "project", scripts: { "gate:fast": "true" } })}\n` });
  git(clone, "push", "--quiet", "-u", "origin", "main");
  git(root, "clone", "--quiet", origin, other);

  return { origin, clone, other };
}
