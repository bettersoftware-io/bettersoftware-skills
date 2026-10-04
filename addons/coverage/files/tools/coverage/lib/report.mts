// Turns the verdicts into text: for the terminal, and as Markdown for a CI job
// summary.

import type { Metric, Thresholds } from "./config.mts";
import { METRICS } from "./config.mts";
import type { PackageResult, Shortfall } from "./judge.mts";
import { exitCodeFor } from "./judge.mts";
import type { FileCoverage } from "./measure.mts";

/** Which commit a report was built from, and when. */
export interface Build {
  /** The full commit hash; `undefined` outside a git checkout, or before the first commit. */
  commit: string | undefined;
  /** True when the working tree had changes that are not in the commit. */
  dirty: boolean;
  /** Branch or tag name, when known. */
  ref: string | undefined;
  builtAt: Date;
  /** The CI run that built it, when there is one. */
  runUrl: string | undefined;
}

export const UNEXPLAINED_IGNORE = "an ignore comment without a reason — say after ` -- ` why no test can reach this code, or remove the comment";

export function formatResults(results: PackageResult[], thresholds: Thresholds): string {
  const lines: string[] = [];

  for (const result of results) {
    lines.push(`${result.verdict} ${result.directory} — ${result.reason}`);

    for (const test of result.failedTests) {
      lines.push(`  ✗ ${test.name}`, `    ${test.message}`);
    }

    for (const { file, shortfalls } of result.underTheBar) {
      lines.push(`  ${file}`, `    ${shortfalls.map(describeShortfall).join(" · ")}`);
    }

    for (const { file, line } of result.unexplainedIgnores) {
      lines.push(`  ${file}:${line}`, `    ${UNEXPLAINED_IGNORE}`);
    }
  }

  lines.push("", `The bar, for every file: ${describeBar(thresholds)}.`, ...formatConclusion(results));

  return lines.join("\n");
}

function formatConclusion(results: PackageResult[]): string[] {
  const files = results.reduce((sum, result) => sum + result.underTheBar.length, 0);
  const failedTests = results.reduce((sum, result) => sum + result.failedTests.length, 0);
  const unread = results.filter((result) => result.verdict === "ERROR").length;
  const ignores = results.reduce((sum, result) => sum + result.unexplainedIgnores.length, 0);
  const lines: string[] = [];

  if (unread > 0) {
    lines.push(`${unread} package(s) could not be measured. That is not a pass.`);
  }

  if (failedTests > 0) {
    lines.push(`${failedTests} test(s) failed. Fix them first: a failed run has no coverage numbers.`);
  }

  if (files > 0) {
    lines.push(
      `${files} file(s) under the bar.`,
      "Rank them with `pnpm coverage:gaps` and write tests through the public interface.",
      "Code no test can reach (a generated file, a browser-only line) is listed in tools/coverage.config.mts with the reason.",
    );
  }

  if (ignores > 0) {
    lines.push(`${ignores} ignore comment(s) without a reason.`);
  }

  if (lines.length > 0) {
    return lines;
  }

  return exitCodeFor(results) === 0
    ? ["Every measured file meets the bar."]
    : ["Nothing was measured in any package. That is not a pass."];
}

export function formatMarkdown(results: PackageResult[], thresholds: Thresholds, build: Build): string {
  const lines = [
    "## Coverage",
    "",
    `Built from ${describeBuild(build)}.`,
    "",
    `The bar, for every file: ${describeBar(thresholds)}.`,
    "",
    "| Package | Verdict | Files | Lines | Statements | Functions | Branches |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...results.map(
      (result) =>
        `| \`${result.directory}\` | ${result.verdict} | ${result.measured.length} | ${METRICS.map((metric) => formatTotal(result.measured, metric)).join(" | ")} |`,
    ),
  ];
  const notMeasured = results.filter((result) => result.verdict === "SKIP" || result.verdict === "ERROR");
  const failedTests = results.flatMap((result) => result.failedTests);
  const underTheBar = results.flatMap((result) => result.underTheBar);
  const ignores = results.flatMap((result) => result.unexplainedIgnores);

  if (notMeasured.length > 0) {
    lines.push("", "### Not measured", "", ...notMeasured.map((result) => `- \`${result.directory}\`: ${result.reason}`));
  }

  if (failedTests.length > 0) {
    lines.push("", "### Failed tests", "", ...failedTests.map((test) => `- ${test.name}: \`${test.message.replaceAll("`", "'")}\``));
  }

  if (underTheBar.length > 0) {
    lines.push(
      "",
      "### Files under the bar",
      "",
      "| File | Under the bar |",
      "|---|---|",
      ...underTheBar.map(({ file, shortfalls }) => `| \`${file}\` | ${shortfalls.map(describeShortfall).join(" · ")} |`),
    );
  }

  if (ignores.length > 0) {
    lines.push("", "### Ignore comments without a reason", "", ...ignores.map(({ file, line }) => `- \`${file}:${line}\``));
  }

  return `${lines.join("\n")}\n`;
}

export function describeBuild({ commit, dirty, ref, builtAt }: Build): string {
  const from = commit === undefined ? "an unknown commit (git has no commit here)" : `commit ${commit.slice(0, 7)}`;
  const changes = dirty ? " with uncommitted changes" : "";
  const branch = ref === undefined ? "" : ` (${ref})`;

  return `${from}${changes}${branch} on ${formatDate(builtAt)}`;
}

export function formatDate(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function describeBar(thresholds: Thresholds): string {
  return METRICS.map((metric) => `${metric} ≥ ${thresholds[metric]}%`).join(", ");
}

export function describeShortfall({ metric, pct, needed, uncovered }: Shortfall): string {
  return `${metric} ${formatPercent(pct)} (needs ${needed}%, ${uncovered} not covered)`;
}

/** The package's own percentage for one metric, over its measured files. */
export function formatTotal(files: FileCoverage[], metric: Metric): string {
  const total = files.reduce((sum, file) => sum + file[metric].total, 0);
  const covered = files.reduce((sum, file) => sum + file[metric].covered, 0);

  return total === 0 ? "–" : formatPercent((covered / total) * 100);
}

/** Rounded down, so 94.99 never reads as 95. */
export function formatPercent(pct: number): string {
  return `${Math.floor(pct * 100) / 100}%`;
}
