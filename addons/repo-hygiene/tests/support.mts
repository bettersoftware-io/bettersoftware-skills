// Fixture factories shared by the repo-hygiene add-on's tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunTool, ToolRun } from "../files/tools/repo-hygiene/lib/run.mts";

export const TOOLS = join(import.meta.dirname, "..", "files", "tools", "repo-hygiene");

/** A fresh folder holding `files` (path → content). */
export function createFolder(files: Record<string, string> = {}): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "repo-hygiene-addon-")));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }

  return folder;
}

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

export const STYLELINT_ROOT = "tools/repo-hygiene/stylelint.json";
export const STYLELINT_BASE = "tools/repo-hygiene/stylelint.base.json";

/**
 * A project that has just received the add-on's two stylelint files, with
 * this repository's installed packages as its own, so the real stylelint
 * runs. `files` are added; one given under a config's path replaces it.
 */
export function createStyledProject(files: Record<string, string> = {}): string {
  const project = createFolder({
    [STYLELINT_ROOT]: readFileSync(join(TOOLS, "stylelint.json"), "utf8"),
    [STYLELINT_BASE]: readFileSync(join(TOOLS, "stylelint.base.json"), "utf8"),
    ...files,
  });

  symlinkSync(join(REPOSITORY, "node_modules"), join(project, "node_modules"));

  return project;
}

/** Makes `folder` a git repository, so that its .gitignore counts. */
export function initGit(folder: string): void {
  execFileSync("git", ["init", "--quiet"], {
    cwd: folder,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

export function createToolRun(overrides: Partial<ToolRun> = {}): ToolRun {
  return { status: 0, stdout: "", stderr: "", ...overrides };
}

export interface FakeTools {
  run: RunTool;
  /** Every call made, as `name arg arg`. */
  calls: string[];
}

/**
 * Stands in for the installed tools. `answers` maps the start of a command
 * line (`syncpack lint`) to what that tool answers; a call nothing matches
 * answers with a clean exit.
 */
export function createFakeTools(answers: Record<string, Partial<ToolRun>> = {}): FakeTools {
  const calls: string[] = [];

  return {
    calls,
    run: (name, args) => {
      const call = [name, ...args].join(" ");

      calls.push(call);

      const match = Object.keys(answers).find((start) => call.startsWith(start));

      return createToolRun(match === undefined ? {} : answers[match]);
    },
  };
}

/** One line of `syncpack json`: a dependency entry read from `packageFile`. */
export function createEntry(packageFile: string, dependency = "rxjs"): string {
  return JSON.stringify({ dependency, package: packageFile, statusType: "Valid" });
}
