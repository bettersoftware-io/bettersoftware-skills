// Judges one package's measurement against the bar, file by file.
//
// Four verdicts, and only one of them is a pass:
//   PASS   every measured file meets the bar
//   FAIL   a test failed, a file is under the bar, or code is left out of the
//          measurement by a comment that gives no reason
//   SKIP   there was nothing to measure — this is not a pass
//   ERROR  the measurement could not be read — this is not a pass either

import type { Metric, Thresholds } from "./config.mts";
import { METRICS } from "./config.mts";
import type { IgnoreComment } from "./ignores.mts";
import type { Count, FailedTest, FileCoverage, Measurement } from "./measure.mts";

export type Verdict = "PASS" | "FAIL" | "SKIP" | "ERROR";

/** One metric of one file that is under the bar. */
export interface Shortfall {
  metric: Metric;
  pct: number;
  needed: number;
  /** How many lines, statements, functions or branches no test reached. */
  uncovered: number;
}

export interface FileShortfalls {
  file: string;
  shortfalls: Shortfall[];
}

export interface PackageResult {
  directory: string;
  verdict: Verdict;
  /** Why, in one line. */
  reason: string;
  /** Files that hold something to cover. */
  measured: FileCoverage[];
  /** Files with nothing to cover: types, re-exports. They are neither a pass nor a gap. */
  emptyFiles: number;
  underTheBar: FileShortfalls[];
  /** Comments that leave code out of the measurement without saying why. */
  unexplainedIgnores: IgnoreComment[];
  failedTests: FailedTest[];
}

export function judgePackage(
  { directory, status, files, tests, unexplainedIgnores }: Measurement,
  thresholds: Thresholds,
): PackageResult {
  const result: PackageResult = {
    directory,
    verdict: "ERROR",
    reason: "",
    measured: [],
    emptyFiles: 0,
    underTheBar: [],
    unexplainedIgnores,
    failedTests: tests?.failed ?? [],
  };

  if (result.failedTests.length > 0) {
    // vitest writes no coverage for a failed run, so there are no numbers to judge.
    return { ...result, verdict: "FAIL", reason: `${count(result.failedTests.length, "test")} failed, so nothing was measured` };
  }

  if (files === undefined) {
    return {
      ...result,
      reason: `vitest wrote no coverage summary (${describeExit(status)}) — run \`pnpm exec vitest run\` in ${directory} to see why`,
    };
  }

  result.measured = files.filter(hasSomethingToCover);
  result.emptyFiles = files.length - result.measured.length;
  result.underTheBar = result.measured
    .map((file) => ({ file: file.file, shortfalls: findShortfalls(file, thresholds) }))
    .filter(({ shortfalls }) => shortfalls.length > 0);

  const problems = [
    ...(result.underTheBar.length > 0 ? [`${result.underTheBar.length} of ${count(result.measured.length, "file")} under the bar`] : []),
    // Checked before the skips: a file whose every line is ignored has nothing left to measure.
    ...(unexplainedIgnores.length > 0 ? [`${count(unexplainedIgnores.length, "ignore comment")} without a reason`] : []),
  ];

  if (problems.length > 0) {
    return { ...result, verdict: "FAIL", reason: problems.join(", ") };
  }

  if (status !== 0) {
    // vitest holds the same bar through its own thresholds. If it failed and
    // this tool found nothing wrong, one of the two is mistaken: never a pass,
    // and never a skip.
    return { ...result, reason: `vitest failed (${describeExit(status)}) although no test failed and no file is under the bar` };
  }

  if (files.length === 0) {
    return { ...result, verdict: "SKIP", reason: "no file to measure: none matches `include`, or every one is excluded" };
  }

  if (result.measured.length === 0) {
    return { ...result, verdict: "SKIP", reason: `${count(files.length, "file")}, none with code to cover (types and re-exports only)` };
  }

  return { ...result, verdict: "PASS", reason: `${count(result.measured.length, "file")} at or above the bar` };
}

/**
 * 0 when every package passed or had nothing to measure and at least one
 * passed; 1 when one failed; 2 when one could not be read, or nothing at all
 * was measured.
 */
export function exitCodeFor(results: PackageResult[]): 0 | 1 | 2 {
  if (results.some((result) => result.verdict === "ERROR")) {
    return 2;
  }

  if (results.some((result) => result.verdict === "FAIL")) {
    return 1;
  }

  return results.some((result) => result.verdict === "PASS") ? 0 : 2;
}

export function hasSomethingToCover(file: FileCoverage): boolean {
  return METRICS.some((metric) => file[metric].total > 0);
}

export function uncovered({ total, covered }: Count): number {
  return total - covered;
}

function findShortfalls(file: FileCoverage, thresholds: Thresholds): Shortfall[] {
  return METRICS.filter((metric) => file[metric].total > 0 && file[metric].pct < thresholds[metric]).map((metric) => ({
    metric,
    pct: file[metric].pct,
    needed: thresholds[metric],
    uncovered: uncovered(file[metric]),
  }));
}

function describeExit(status: number | null): string {
  return status === null ? "it did not run" : `exit code ${status}`;
}

function count(number: number, noun: string): string {
  return `${number} ${noun}${number === 1 ? "" : "s"}`;
}
