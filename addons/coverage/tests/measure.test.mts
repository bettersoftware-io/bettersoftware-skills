import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RunVitest } from "../files/tools/coverage/lib/measure.mts";
import { excludePatternsFor, findMisplacedExclusions, measurePackage, vitestArguments } from "../files/tools/coverage/lib/measure.mts";
import { createConfig, createCount, createFileCoverage, createFolder, createWorkspace, writeRunOutput } from "./support.mts";

describe("measuring a package", () => {
  it("asks vitest for v8 coverage of every included file, held to the bar file by file", () => {
    const config = createConfig({
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
      include: ["src/**/*.ts"],
      exclude: { "**/*.d.ts": "declarations hold no code", "packages/a/src/generated/**": "generated" },
    });

    expect(vitestArguments(config, "packages/a")).toEqual([
      "run",
      "--passWithNoTests",
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reportsDirectory=coverage",
      "--coverage.include=src/**/*.ts",
      "--coverage.exclude=**/*.d.ts",
      "--coverage.exclude=src/generated/**",
      "--coverage.reporter=text",
      "--coverage.reporter=json-summary",
      "--coverage.reporter=html",
      "--coverage.reporter=lcovonly",
      "--coverage.thresholds.perFile",
      "--coverage.thresholds.lines=95",
      "--coverage.thresholds.statements=95",
      "--coverage.thresholds.functions=95",
      "--coverage.thresholds.branches=85",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=coverage/test-results.json",
    ]);
  });

  it("applies an exclusion written for one package in that package only, and one that starts with **/ in all", () => {
    const patterns = ["**/*.d.ts", "packages/server/src/index.ts"];

    expect(excludePatternsFor("packages/server", patterns)).toEqual(["**/*.d.ts", "src/index.ts"]);
    expect(excludePatternsFor("packages/domain", patterns)).toEqual(["**/*.d.ts"]);
  });

  it("does not take packages/server-tools for a part of packages/server", () => {
    expect(excludePatternsFor("packages/server", ["packages/server-tools/src/index.ts"])).toEqual([]);
  });

  it("finds an exclusion that names no package, which would reach nothing or too much", () => {
    const packages = ["packages/domain", "packages/server"];

    expect(findMisplacedExclusions(packages, ["**/*.d.ts", "packages/server/src/index.ts", "src/index.ts"])).toEqual(["src/index.ts"]);
  });

  it("runs vitest in the package's own folder, so the package's config is the one used", () => {
    const root = createWorkspace(["packages/a"]);
    const calls: { directory: string; quiet: boolean }[] = [];

    measurePackage(root, "packages/a", createConfig(), true, (directory, _arguments, quiet) => {
      calls.push({ directory, quiet });

      return { status: 0 };
    });

    expect(calls).toEqual([{ directory: join(root, "packages/a"), quiet: true }]);
  });

  it("reads each file's numbers, with paths from the project root", () => {
    const root = createWorkspace(["packages/a"]);
    const measurement = measurePackage(
      root,
      "packages/a",
      createConfig(),
      true,
      createVitestRun(root, "packages/a", [createFileCoverage("src/price.ts", { lines: [3, 4] })]),
    );

    expect(measurement.status).toBe(0);
    expect(measurement.files?.map(({ file }) => file)).toEqual(["packages/a/src/price.ts"]);
    expect(measurement.files?.[0]?.lines).toEqual({ total: 4, covered: 3, pct: 75 });
  });

  it("reads nothing-to-cover as 100%, where istanbul writes Unknown", () => {
    const root = createWorkspace(["packages/a"]);
    const typesOnly = { ...createFileCoverage("src/types.ts"), lines: { total: 0, covered: 0, pct: "Unknown" } };
    const measurement = measurePackage(
      root,
      "packages/a",
      createConfig(),
      true,
      createVitestRun(root, "packages/a", [typesOnly as never]),
    );

    expect(measurement.files?.[0]?.lines).toEqual(createCount(0, 0));
  });

  it("never reads numbers an earlier run left behind", () => {
    const root = createWorkspace(["packages/a"]);

    writeRunOutput(root, "packages/a", [createFileCoverage("src/price.ts")], { numTotalTests: 1, testResults: [] });

    const measurement = measurePackage(root, "packages/a", createConfig(), true, () => ({ status: 1 }));

    expect(measurement.files).toBeUndefined();
    expect(measurement.tests).toBeUndefined();
  });

  it("lists each failed test with the first line of its failure", () => {
    const root = createWorkspace(["packages/a"]);
    const measurement = measurePackage(
      root,
      "packages/a",
      createConfig(),
      true,
      createVitestRun(root, "packages/a", undefined, createTestReport(root), 1),
    );

    expect(measurement.files).toBeUndefined();
    expect(measurement.tests?.total).toBe(2);
    expect(measurement.tests?.failed).toContainEqual({
      name: "trackMovement marks a higher price as up",
      message: "AssertionError: expected 'down' to be 'up'",
    });
  });

  it("counts a test file that could not be loaded as a failure, though no test in it ran", () => {
    const root = createWorkspace(["packages/a"]);
    const measurement = measurePackage(
      root,
      "packages/a",
      createConfig(),
      true,
      createVitestRun(root, "packages/a", undefined, createTestReport(root), 1),
    );

    expect(measurement.tests?.failed).toContainEqual({
      name: "packages/a/src/broken.test.ts",
      message: "Cannot find module './missing.ts'",
    });
  });

  it("reports no numbers and no tests when vitest wrote nothing", () => {
    const root = createFolder({ "packages/a/package.json": "{}" });

    expect(measurePackage(root, "packages/a", createConfig(), true, () => ({ status: null }))).toEqual({
      directory: "packages/a",
      status: null,
      files: undefined,
      tests: undefined,
      unexplainedIgnores: [],
    });
  });

  it("looks in the measured files for comments that leave code out without a reason", () => {
    const root = createWorkspace(["packages/a"], { "packages/a/src/price.ts": "/* v8 ignore next */\nexport const price = 1;\n" });
    const measurement = measurePackage(
      root,
      "packages/a",
      createConfig(),
      true,
      createVitestRun(root, "packages/a", [createFileCoverage("src/price.ts")]),
    );

    expect(measurement.unexplainedIgnores).toEqual([{ file: "packages/a/src/price.ts", line: 1 }]);
  });
});

/** Stands in for vitest: leaves the files a real run would leave. */
function createVitestRun(
  root: string,
  directory: string,
  files: Parameters<typeof writeRunOutput>[2],
  testReport: object = { numTotalTests: 1, testResults: [] },
  status = 0,
): RunVitest {
  return () => {
    writeRunOutput(root, directory, files, testReport);

    return { status };
  };
}

/** vitest's JSON report for one failed test, one passed test and one file that failed to load. */
function createTestReport(root: string): object {
  return {
    numTotalTests: 2,
    testResults: [
      {
        name: join(root, "packages/a/src/trackMovement.test.ts"),
        status: "failed",
        message: "",
        assertionResults: [
          { fullName: "trackMovement marks the first price as flat", status: "passed", failureMessages: [] },
          {
            fullName: "trackMovement marks a higher price as up",
            status: "failed",
            failureMessages: ["AssertionError: expected 'down' to be 'up'\n    at src/trackMovement.test.ts:12:5"],
          },
        ],
      },
      {
        name: join(root, "packages/a/src/broken.test.ts"),
        status: "failed",
        message: "Cannot find module './missing.ts'\n    at src/broken.test.ts:1:1",
        assertionResults: [],
      },
    ],
  };
}
