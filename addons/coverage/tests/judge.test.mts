import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../files/tools/coverage/lib/config.mts";
import { exitCodeFor, judgePackage } from "../files/tools/coverage/lib/judge.mts";
import type { Measurement } from "../files/tools/coverage/lib/measure.mts";
import { createEmptyFile, createFileCoverage, createResult } from "./support.mts";

const BAR = DEFAULTS.thresholds;

describe("judging a package, file by file", () => {
  it("passes a package whose every file meets the bar", () => {
    const result = judgePackage(createMeasurement({ files: [createFileCoverage("packages/a/src/price.ts")] }), BAR);

    expect(result.verdict).toBe("PASS");
    expect(result.reason).toBe("1 file at or above the bar");
    expect(result.underTheBar).toEqual([]);
  });

  it("fails one weak file however good the package's average is", () => {
    const result = judgePackage(
      createMeasurement({
        status: 1,
        files: [
          createFileCoverage("packages/a/src/big.ts", { lines: [1000, 1000] }),
          createFileCoverage("packages/a/src/weak.ts", { lines: [9, 10] }),
        ],
      }),
      BAR,
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe("1 of 2 files under the bar");
    expect(result.underTheBar).toEqual([
      { file: "packages/a/src/weak.ts", shortfalls: [{ metric: "lines", pct: 90, needed: 95, uncovered: 1 }] },
    ]);
  });

  it("holds branches to their own, lower bar", () => {
    const files = [createFileCoverage("packages/a/src/price.ts", { branches: [86, 100] })];

    expect(judgePackage(createMeasurement({ files }), BAR).verdict).toBe("PASS");
  });

  it("passes a file that is exactly on the bar", () => {
    const files = [createFileCoverage("packages/a/src/price.ts", { lines: [95, 100], branches: [85, 100] })];

    expect(judgePackage(createMeasurement({ files }), BAR).verdict).toBe("PASS");
  });

  it("fails when a test failed, and says that nothing was measured", () => {
    const result = judgePackage(
      createMeasurement({
        status: 1,
        files: undefined,
        tests: { total: 3, failed: [{ name: "marks a higher price as up", message: "expected 'down' to be 'up'" }] },
      }),
      BAR,
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe("1 test failed, so nothing was measured");
    expect(result.failedTests).toHaveLength(1);
  });

  it("is an error, not a pass, when vitest wrote no coverage summary", () => {
    const result = judgePackage(createMeasurement({ status: 1, files: undefined, tests: undefined }), BAR);

    expect(result.verdict).toBe("ERROR");
    expect(result.reason).toContain("vitest wrote no coverage summary (exit code 1)");
  });

  it("skips a package where no source file matches, and says so", () => {
    const result = judgePackage(createMeasurement({ files: [] }), BAR);

    expect(result.verdict).toBe("SKIP");
    expect(result.reason).toBe("no file to measure: none matches `include`, or every one is excluded");
  });

  it("skips a package whose files hold only types, and does not call that a pass", () => {
    const result = judgePackage(
      createMeasurement({ files: [createEmptyFile("packages/a/src/index.ts"), createEmptyFile("packages/a/src/price.ts")] }),
      BAR,
    );

    expect(result.verdict).toBe("SKIP");
    expect(result.reason).toBe("2 files, none with code to cover (types and re-exports only)");
    expect(result.emptyFiles).toBe(2);
  });

  it("does not count a file with nothing to cover among the measured files", () => {
    const result = judgePackage(
      createMeasurement({ files: [createEmptyFile("packages/a/src/index.ts"), createFileCoverage("packages/a/src/price.ts")] }),
      BAR,
    );

    expect(result.measured.map(({ file }) => file)).toEqual(["packages/a/src/price.ts"]);
    expect(result.emptyFiles).toBe(1);
    expect(result.verdict).toBe("PASS");
  });

  it("does not skip a package with nothing to measure when vitest itself failed", () => {
    expect(judgePackage(createMeasurement({ status: 1, files: [] }), BAR).verdict).toBe("ERROR");
  });

  it("fails a package that leaves code out by a comment without a reason, though every number is fine", () => {
    const result = judgePackage(
      createMeasurement({
        files: [createFileCoverage("packages/a/src/price.ts")],
        unexplainedIgnores: [{ file: "packages/a/src/price.ts", line: 12 }],
      }),
      BAR,
    );

    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe("1 ignore comment without a reason");
  });

  it("fails a package whose only file is ignored whole without a reason, where it would otherwise have nothing to measure", () => {
    const result = judgePackage(
      createMeasurement({
        files: [createEmptyFile("packages/a/src/price.ts")],
        unexplainedIgnores: [{ file: "packages/a/src/price.ts", line: 1 }],
      }),
      BAR,
    );

    expect(result.verdict).toBe("FAIL");
  });

  it("never passes when vitest failed for a reason the numbers do not show", () => {
    const result = judgePackage(createMeasurement({ status: 1, files: [createFileCoverage("packages/a/src/price.ts")] }), BAR);

    expect(result.verdict).toBe("ERROR");
    expect(result.reason).toContain("vitest failed (exit code 1)");
  });
});

describe("the exit code of a run", () => {
  it("is 0 when a package passed and the others had nothing to measure", () => {
    expect(exitCodeFor([createResult({ verdict: "PASS" }), createResult({ verdict: "SKIP" })])).toBe(0);
  });

  it("is 1 when a package failed", () => {
    expect(exitCodeFor([createResult({ verdict: "PASS" }), createResult({ verdict: "FAIL" })])).toBe(1);
  });

  it("is 2 when a package could not be read, even beside a failure", () => {
    expect(exitCodeFor([createResult({ verdict: "FAIL" }), createResult({ verdict: "ERROR" })])).toBe(2);
  });

  it("is 2, not 0, when nothing was measured in any package", () => {
    expect(exitCodeFor([createResult({ verdict: "SKIP" }), createResult({ verdict: "SKIP" })])).toBe(2);
  });
});

function createMeasurement(overrides: Partial<Measurement>): Measurement {
  return {
    directory: "packages/a",
    status: 0,
    files: [],
    tests: { total: 1, failed: [] },
    unexplainedIgnores: [],
    ...overrides,
  };
}
