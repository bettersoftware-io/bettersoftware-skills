#!/usr/bin/env node
// Ranks every file with code no test reaches, across all packages, worst
// first. It measures afresh each time, so the list is never an old one.
//
//   node tools/coverage/gaps.mts                   every workspace package
//   node tools/coverage/gaps.mts packages/domain   only the packages given
//   node tools/coverage/gaps.mts --limit 10        the ten worst (default 30)
//   node tools/coverage/gaps.mts --json            machine-readable
//
// This is a report, not a gate: gaps do not fail it. Exit 0: every package was
// measured. Exit 2: a package could not be measured (a failed test, a broken
// run), or nothing was measured at all — the list is then incomplete.

import type { Metric } from "./lib/config.mts";
import { CoverageError, loadConfig } from "./lib/config.mts";
import type { PackageResult } from "./lib/judge.mts";
import { uncovered } from "./lib/judge.mts";
import { portTestsAreSkipped } from "./lib/listening.mts";
import { isMainModule } from "./lib/main.mts";
import { formatPercent } from "./lib/report.mts";
import { checkCoverage } from "./run.mts";

export interface Gap {
  file: string;
  uncoveredLines: number;
  uncoveredBranches: number;
  uncoveredFunctions: number;
  linesPct: number;
  /** The metrics on which the file is under the bar; empty when it meets it. */
  under: Metric[];
}

/** Every measured file with something not covered, the most uncovered lines first. */
export function rankGaps(results: PackageResult[]): Gap[] {
  return results
    .flatMap((result) =>
      result.measured.map((file) => ({
        file: file.file,
        uncoveredLines: uncovered(file.lines),
        uncoveredBranches: uncovered(file.branches),
        uncoveredFunctions: uncovered(file.functions),
        linesPct: file.lines.pct,
        under: result.underTheBar.find((entry) => entry.file === file.file)?.shortfalls.map(({ metric }) => metric) ?? [],
      })),
    )
    .filter((gap) => gap.uncoveredLines + gap.uncoveredBranches + gap.uncoveredFunctions > 0)
    .sort(
      (a, b) =>
        b.uncoveredLines - a.uncoveredLines ||
        a.linesPct - b.linesPct ||
        b.uncoveredBranches - a.uncoveredBranches ||
        b.uncoveredFunctions - a.uncoveredFunctions ||
        a.file.localeCompare(b.file),
    );
}

/** Packages whose files are missing from the ranking, and why. */
export function findUnmeasured(results: PackageResult[]): PackageResult[] {
  return results.filter((result) => result.verdict === "ERROR" || result.failedTests.length > 0);
}

export function formatGaps(results: PackageResult[], limit: number): string {
  const gaps = rankGaps(results);
  const measured = results.reduce((sum, result) => sum + result.measured.length, 0);
  const lines: string[] = [];

  if (gaps.length > 0) {
    lines.push("  lines not covered   line %   branches   functions   file");

    for (const gap of gaps.slice(0, limit)) {
      const numbers = [
        String(gap.uncoveredLines).padStart(19),
        formatPercent(gap.linesPct).padStart(8),
        String(gap.uncoveredBranches).padStart(10),
        String(gap.uncoveredFunctions).padStart(11),
      ].join("");

      lines.push(`${numbers}   ${gap.file}${gap.under.length > 0 ? `  (under the bar: ${gap.under.join(", ")})` : ""}`);
    }

    if (gaps.length > limit) {
      lines.push(`  … ${gaps.length - limit} more (raise --limit)`);
    }

    lines.push("");
  }

  lines.push(
    `${gaps.length} file(s) with code no test reaches, ${gaps.filter((gap) => gap.under.length > 0).length} of them under the bar, out of ${measured} measured.`,
  );

  for (const result of results.filter((result) => result.verdict === "SKIP")) {
    lines.push(`SKIP ${result.directory} — ${result.reason}`);
  }

  for (const result of findUnmeasured(results)) {
    lines.push(`NOT MEASURED ${result.directory} — ${result.reason}`);
  }

  if (findUnmeasured(results).length > 0) {
    lines.push("The list is incomplete: fix the packages that were not measured and run this again.");
  } else if (measured === 0) {
    lines.push("Nothing was measured in any package. That is not a clean result.");
  }

  return lines.join("\n");
}

interface CommandLine {
  root: string;
  packages: string[];
  limit: number;
  json: boolean;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { root: process.cwd(), packages: [], limit: 30, json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--root" || argument === "--limit") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new CoverageError(`"${argument}" needs a value`);
      }

      if (argument === "--root") {
        options.root = value;
      } else if (Number.isInteger(Number(value)) && Number(value) > 0) {
        options.limit = Number(value);
      } else {
        // Read as NaN, a bad limit would compare false with everything and print no gap at all.
        throw new CoverageError(`"--limit" needs a whole number above 0, got "${value}"`);
      }

      index += 1;
    } else if (argument.startsWith("--")) {
      throw new CoverageError(`unknown argument "${argument}"`);
    } else {
      options.packages.push(argument.replace(/\/$/, ""));
    }
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const { root, packages, limit, json } = parseArguments(process.argv.slice(2));
    const results = checkCoverage({
      root,
      config: await loadConfig(root),
      packages,
      portTestsSkipped: await portTestsAreSkipped(),
      quiet: true,
      announce: (directory) => {
        console.error(`measuring ${directory} …`);
      },
    });
    const unmeasured = findUnmeasured(results);

    console.log(
      json
        ? JSON.stringify({ gaps: rankGaps(results).slice(0, limit), unmeasured }, null, 2)
        : `\n${formatGaps(results, limit)}`,
    );
    process.exit(unmeasured.length > 0 || results.every((result) => result.measured.length === 0) ? 2 : 0);
  } catch (error) {
    console.error(error instanceof CoverageError ? `coverage:gaps could not run: ${error.message}` : error);
    process.exit(2);
  }
}
