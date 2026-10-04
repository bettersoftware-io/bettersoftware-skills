// Runs one package's tests under vitest's v8 coverage and reads back what it
// wrote: the per-file numbers and the test results.
//
// Everything is passed as command-line flags, so a package's own vitest config
// is used as it is and never edited. The flags win over a `coverage` block in
// that config.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { CoverageConfig, Metric } from "./config.mts";
import { METRICS } from "./config.mts";
import type { IgnoreComment } from "./ignores.mts";
import { findUnexplainedIgnores } from "./ignores.mts";

/** Where vitest writes, inside each package. The starter's `.gitignore` covers it. */
export const REPORTS_DIRECTORY = "coverage";
export const SUMMARY_FILE = "coverage-summary.json";
export const TEST_RESULTS_FILE = "test-results.json";

export interface Count {
  total: number;
  covered: number;
  /** 100 when there is nothing to cover. */
  pct: number;
}

export type FileCoverage = Record<Metric, Count> & {
  /** Path from the project root. */
  file: string;
};

export interface FailedTest {
  name: string;
  /** The first line of the failure. */
  message: string;
}

export interface TestOutcome {
  total: number;
  failed: FailedTest[];
}

export interface Measurement {
  /** The package folder, as a path from the project root. */
  directory: string;
  /** vitest's exit code; `null` when it did not start or was killed. */
  status: number | null;
  /** Per-file numbers; `undefined` when vitest wrote no coverage summary. */
  files: FileCoverage[] | undefined;
  /** `undefined` when vitest wrote no test results. */
  tests: TestOutcome | undefined;
  /** Comments in the measured files that leave code out without a reason. */
  unexplainedIgnores: IgnoreComment[];
}

export interface VitestRun {
  status: number | null;
}

/** Runs vitest in `directory`. Replaced in tests. */
export type RunVitest = (directory: string, vitestArguments: string[], quiet: boolean) => VitestRun;

export function measurePackage(
  root: string,
  directory: string,
  config: CoverageConfig,
  quiet: boolean,
  run: RunVitest = runVitest,
): Measurement {
  const reports = join(root, directory, REPORTS_DIRECTORY);

  // A number left by an earlier run must never be read as this run's result.
  rmSync(join(reports, SUMMARY_FILE), { force: true });
  rmSync(join(reports, TEST_RESULTS_FILE), { force: true });

  const { status } = run(join(root, directory), vitestArguments(config, directory), quiet);

  const files = readSummary(root, directory);

  return {
    directory,
    status,
    files,
    tests: readTestOutcome(root, directory),
    unexplainedIgnores: findUnexplainedIgnores(root, (files ?? []).map(({ file }) => file)),
  };
}

/** The flags for the package in `directory`. vitest reads every glob from that folder. */
export function vitestArguments({ thresholds, include, exclude }: CoverageConfig, directory: string): string[] {
  return [
    "run",
    // A package with source and no test is measured at 0%, not passed over.
    "--passWithNoTests",
    "--coverage.enabled",
    "--coverage.provider=v8",
    `--coverage.reportsDirectory=${REPORTS_DIRECTORY}`,
    ...include.map((pattern) => `--coverage.include=${pattern}`),
    ...excludePatternsFor(directory, Object.keys(exclude)).map((pattern) => `--coverage.exclude=${pattern}`),
    "--coverage.reporter=text",
    "--coverage.reporter=json-summary",
    "--coverage.reporter=html",
    "--coverage.reporter=lcovonly",
    "--coverage.thresholds.perFile",
    ...METRICS.map((metric) => `--coverage.thresholds.${metric}=${thresholds[metric]}`),
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${REPORTS_DIRECTORY}/${TEST_RESULTS_FILE}`,
  ];
}

/**
 * The exclusions that reach this package, as globs from its folder: the ones
 * that apply everywhere, and the ones written for a file inside it.
 */
export function excludePatternsFor(directory: string, patterns: string[]): string[] {
  return patterns
    .filter((pattern) => appliesEverywhere(pattern) || pattern.startsWith(`${directory}/`))
    .map((pattern) => (appliesEverywhere(pattern) ? pattern : pattern.slice(directory.length + 1)));
}

/** Exclusions that name no package and do not say they apply everywhere. They would reach nothing, or too much. */
export function findMisplacedExclusions(packages: string[], patterns: string[]): string[] {
  return patterns.filter((pattern) => !appliesEverywhere(pattern) && !packages.some((directory) => pattern.startsWith(`${directory}/`)));
}

function appliesEverywhere(pattern: string): boolean {
  return pattern.startsWith("**/");
}

function runVitest(directory: string, vitestArguments: string[], quiet: boolean): VitestRun {
  const { status } = spawnSync("pnpm", ["exec", "vitest", ...vitestArguments], {
    cwd: directory,
    stdio: quiet ? "ignore" : "inherit",
  });

  return { status };
}

/** The fields this tool reads from one entry of istanbul's `coverage-summary.json`. */
type SummaryEntry = Partial<Record<Metric, { total?: number; covered?: number; pct?: number | string }>>;

export function readSummary(root: string, directory: string): FileCoverage[] | undefined {
  const path = join(root, directory, REPORTS_DIRECTORY, SUMMARY_FILE);

  if (!existsSync(path)) {
    return undefined;
  }

  const summary = JSON.parse(readFileSync(path, "utf8")) as Record<string, SummaryEntry>;
  const packageRoot = realpathSync(join(root, directory));

  return Object.entries(summary)
    .filter(([key]) => key !== "total")
    .map(([key, entry]) => ({
      file: toProjectPath(key, packageRoot, directory),
      lines: readCount(entry.lines),
      statements: readCount(entry.statements),
      functions: readCount(entry.functions),
      branches: readCount(entry.branches),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The summary holds absolute paths; a report is read with paths from the project root. */
function toProjectPath(absolute: string, packageRoot: string, directory: string): string {
  const inPackage = relative(packageRoot, absolute);

  return inPackage.startsWith("..") ? absolute : `${directory}/${inPackage.split(sep).join("/")}`;
}

function readCount(count: SummaryEntry[Metric]): Count {
  const total = count?.total ?? 0;
  const covered = count?.covered ?? 0;

  // istanbul writes "Unknown" when there is nothing to count.
  return { total, covered, pct: typeof count?.pct === "number" ? count.pct : total === 0 ? 100 : (covered / total) * 100 };
}

/** The fields this tool reads from vitest's JSON test report. */
interface TestReport {
  numTotalTests?: number;
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; status?: string; failureMessages?: string[] }[];
  }[];
}

export function readTestOutcome(root: string, directory: string): TestOutcome | undefined {
  const path = join(root, directory, REPORTS_DIRECTORY, TEST_RESULTS_FILE);

  if (!existsSync(path)) {
    return undefined;
  }

  const report = JSON.parse(readFileSync(path, "utf8")) as TestReport;
  const packageRoot = realpathSync(join(root, directory));
  const failed: FailedTest[] = [];

  for (const file of report.testResults ?? []) {
    const failedTests = (file.assertionResults ?? []).filter((test) => test.status === "failed");

    for (const test of failedTests) {
      failed.push({ name: test.fullName ?? "(unnamed test)", message: firstLine(test.failureMessages?.[0]) });
    }

    // A file that failed to load has no failed test of its own, only a failed status.
    if (file.status === "failed" && failedTests.length === 0) {
      failed.push({
        name: toProjectPath(file.name ?? "(unnamed file)", packageRoot, directory),
        message: firstLine(file.message) || "the test file failed to run",
      });
    }
  }

  return { total: report.numTotalTests ?? 0, failed };
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0]?.trim() ?? "";
}
