import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findUnmeasured, formatGaps, rankGaps } from "../files/tools/coverage/gaps.mts";
import { createFileCoverage, createFolder, createResult, TOOLS } from "./support.mts";

describe("ranking the gaps", () => {
  it("puts the file with the most lines not covered first, across packages", () => {
    const gaps = rankGaps([
      createResult({ directory: "packages/a", measured: [createFileCoverage("packages/a/src/small.ts", { lines: [9, 10] })] }),
      createResult({ directory: "packages/b", measured: [createFileCoverage("packages/b/src/large.ts", { lines: [60, 100] })] }),
    ]);

    expect(gaps.map(({ file, uncoveredLines }) => ({ file, uncoveredLines }))).toEqual([
      { file: "packages/b/src/large.ts", uncoveredLines: 40 },
      { file: "packages/a/src/small.ts", uncoveredLines: 1 },
    ]);
  });

  it("breaks a tie on lines with the lower percentage", () => {
    const gaps = rankGaps([
      createResult({
        measured: [
          createFileCoverage("packages/a/src/mostly-covered.ts", { lines: [98, 100] }),
          createFileCoverage("packages/a/src/untested.ts", { lines: [0, 2] }),
        ],
      }),
    ]);

    expect(gaps.map(({ file }) => file)).toEqual(["packages/a/src/untested.ts", "packages/a/src/mostly-covered.ts"]);
  });

  it("lists a file that lacks only a branch, after the files that lack lines", () => {
    const gaps = rankGaps([
      createResult({
        measured: [
          createFileCoverage("packages/a/src/branchy.ts", { branches: [6, 8] }),
          createFileCoverage("packages/a/src/thin.ts", { lines: [9, 10] }),
        ],
      }),
    ]);

    expect(gaps.map(({ file, uncoveredBranches }) => ({ file, uncoveredBranches }))).toEqual([
      { file: "packages/a/src/thin.ts", uncoveredBranches: 0 },
      { file: "packages/a/src/branchy.ts", uncoveredBranches: 2 },
    ]);
  });

  it("leaves out a file every test reaches", () => {
    expect(rankGaps([createResult({ measured: [createFileCoverage("packages/a/src/price.ts")] })])).toEqual([]);
  });

  it("marks the metrics that put a file under the bar, and leaves a file above it unmarked", () => {
    const gaps = rankGaps([
      createResult({
        measured: [
          createFileCoverage("packages/a/src/weak.ts", { lines: [5, 10] }),
          createFileCoverage("packages/a/src/fine.ts", { lines: [99, 100] }),
        ],
        underTheBar: [{ file: "packages/a/src/weak.ts", shortfalls: [{ metric: "lines", pct: 50, needed: 95, uncovered: 5 }] }],
      }),
    ]);

    expect(gaps.map(({ file, under }) => ({ file, under }))).toEqual([
      { file: "packages/a/src/weak.ts", under: ["lines"] },
      { file: "packages/a/src/fine.ts", under: [] },
    ]);
  });
});

describe("the gap list", () => {
  it("shows the worst files up to the limit and says how many it left out", () => {
    const text = formatGaps(
      [
        createResult({
          measured: [
            createFileCoverage("packages/a/src/first.ts", { lines: [0, 30] }),
            createFileCoverage("packages/a/src/second.ts", { lines: [0, 20] }),
            createFileCoverage("packages/a/src/third.ts", { lines: [0, 10] }),
          ],
        }),
      ],
      1,
    );

    expect(text).toContain("packages/a/src/first.ts");
    expect(text).not.toContain("packages/a/src/second.ts");
    expect(text).toContain("… 2 more (raise --limit)");
    expect(text).toContain("3 file(s) with code no test reaches, 0 of them under the bar, out of 3 measured.");
  });

  it("gives the count of lines not covered and the line percentage for each file", () => {
    const text = formatGaps([createResult({ measured: [createFileCoverage("packages/a/src/weak.ts", { lines: [1, 8], branches: [1, 4] })] })], 30);

    expect(text).toContain("                  7   12.5%         3          0   packages/a/src/weak.ts");
  });

  it("says the list is incomplete when a package's tests failed", () => {
    const failed = createResult({
      directory: "packages/b",
      verdict: "FAIL",
      reason: "1 test failed, so nothing was measured",
      failedTests: [{ name: "marks a higher price as up", message: "expected 'down' to be 'up'" }],
    });
    const results = [createResult({ measured: [createFileCoverage("packages/a/src/price.ts")] }), failed];

    expect(findUnmeasured(results)).toEqual([failed]);
    expect(formatGaps(results, 30)).toContain("NOT MEASURED packages/b — 1 test failed, so nothing was measured");
    expect(formatGaps(results, 30)).toContain("The list is incomplete");
  });

  it("does not count a package with files under the bar as unmeasured", () => {
    const underTheBar = createResult({ verdict: "FAIL", measured: [createFileCoverage("packages/a/src/weak.ts", { lines: [1, 10] })] });

    expect(findUnmeasured([underTheBar])).toEqual([]);
  });

  it("names the packages with nothing to measure, and does not call an empty list clean", () => {
    const text = formatGaps([createResult({ verdict: "SKIP", reason: "no file to measure: none matches `include`, or every one is excluded" })], 30);

    expect(text).toContain("SKIP packages/a — no file to measure: none matches `include`, or every one is excluded");
    expect(text).toContain("Nothing was measured in any package. That is not a clean result.");
  });

  it("refuses a limit that is not a whole number above 0", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "gaps.mts"), "--limit", "0", "--root", createFolder()], { encoding: "utf8" });

    expect(stderr).toContain('coverage:gaps could not run: "--limit" needs a whole number above 0, got "0"');
    expect(status).toBe(2);
  });
});
