// Fixture factories shared by the coverage add-on's tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CoverageConfig, Metric } from "../files/tools/coverage/lib/config.mts";
import { DEFAULTS, METRICS } from "../files/tools/coverage/lib/config.mts";
import type { PackageResult } from "../files/tools/coverage/lib/judge.mts";
import type { Count, FileCoverage } from "../files/tools/coverage/lib/measure.mts";
import { REPORTS_DIRECTORY, SUMMARY_FILE, TEST_RESULTS_FILE } from "../files/tools/coverage/lib/measure.mts";
import type { Build } from "../files/tools/coverage/lib/report.mts";

export const TOOLS = join(import.meta.dirname, "..", "files", "tools", "coverage");

/** A fresh folder holding `files` (path → content). Its real path, so it compares equal to what tools report. */
export function createFolder(files: Record<string, string> = {}): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "coverage-addon-")));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }

  return folder;
}

/** A project root with a workspace file and the packages named, each with a package.json. */
export function createWorkspace(packages: string[], files: Record<string, string> = {}): string {
  return createFolder({
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    ...Object.fromEntries(packages.map((directory) => [`${directory}/package.json`, "{}"])),
    ...files,
  });
}

export function createConfig(overrides: Partial<CoverageConfig> = {}): CoverageConfig {
  return { ...DEFAULTS, ...overrides };
}

export function createCount(covered: number, total: number): Count {
  // istanbul cuts the percentage to two decimals and reads nothing-to-cover as 100.
  return { covered, total, pct: total === 0 ? 100 : Math.floor((covered / total) * 10000) / 100 };
}

/** A file's numbers; every metric is 10 of 10 covered unless given as [covered, total]. */
export function createFileCoverage(file: string, counts: Partial<Record<Metric, [number, number]>> = {}): FileCoverage {
  const [lines, statements, functions, branches] = METRICS.map((metric) => createCount(...(counts[metric] ?? [10, 10])));

  return { file, lines, statements, functions, branches } as FileCoverage;
}

/** A file with nothing to cover: types, re-exports. */
export function createEmptyFile(file: string): FileCoverage {
  return createFileCoverage(file, { lines: [0, 0], statements: [0, 0], functions: [0, 0], branches: [0, 0] });
}

export function createResult(overrides: Partial<PackageResult> = {}): PackageResult {
  return {
    directory: "packages/a",
    verdict: "PASS",
    reason: "1 file at or above the bar",
    measured: [],
    emptyFiles: 0,
    underTheBar: [],
    unexplainedIgnores: [],
    failedTests: [],
    ...overrides,
  };
}

export function createBuild(overrides: Partial<Build> = {}): Build {
  return {
    commit: "abc1234def5678900000000000000000000000ff",
    dirty: false,
    ref: "main",
    builtAt: new Date("2026-10-04T19:56:31Z"),
    runUrl: undefined,
    ...overrides,
  };
}

/** What istanbul's json-summary reporter writes for the files given, as text. */
export function createSummaryJson(packageRoot: string, files: FileCoverage[]): string {
  return JSON.stringify({
    total: {},
    ...Object.fromEntries(
      files.map(({ file, ...counts }) => [join(packageRoot, file), Object.fromEntries(METRICS.map((metric) => [metric, { ...counts[metric], skipped: 0 }]))]),
    ),
  });
}

/** Writes what a vitest run leaves in a package: its coverage summary and, when given, its test report. */
export function writeRunOutput(root: string, directory: string, files: FileCoverage[] | undefined, testReport?: object): void {
  const reports = join(root, directory, REPORTS_DIRECTORY);

  mkdirSync(reports, { recursive: true });

  if (files !== undefined) {
    writeFileSync(join(reports, SUMMARY_FILE), createSummaryJson(join(root, directory), files));
  }

  if (testReport !== undefined) {
    writeFileSync(join(reports, TEST_RESULTS_FILE), JSON.stringify(testReport));
  }
}

/** Keeps the user's own git settings (signing, hooks, templates) out of the tests. */
export const ISOLATED_GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** Runs git in `directory` as a test author and returns what it printed. */
export function git(directory: string, ...gitArguments: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test Author", "-c", "user.email=author@example.test", ...gitArguments], {
    cwd: directory,
    encoding: "utf8",
    stdio: "pipe",
    env: ISOLATED_GIT,
  }).trim();
}

/** A git checkout on `main` with one commit, holding `files`. */
export function createCheckout(files: Record<string, string> = { "README.md": "a project\n" }): string {
  const checkout = createFolder(files);

  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "first commit");

  return checkout;
}
