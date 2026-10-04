import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../files/tools/coverage/lib/config.mts";
import { describeBuild, formatMarkdown, formatPercent, formatResults } from "../files/tools/coverage/lib/report.mts";
import { createBuild, createFileCoverage, createResult } from "./support.mts";

const BAR = DEFAULTS.thresholds;

describe("the terminal report", () => {
  it("names each file under the bar with the metric, its number and what it needs", () => {
    const text = formatResults([createFailure()], BAR);

    expect(text).toContain("FAIL packages/a — 1 of 2 files under the bar");
    expect(text).toContain("  packages/a/src/weak.ts\n    lines 50% (needs 95%, 2 not covered) · branches 0% (needs 85%, 1 not covered)");
    expect(text).toContain("The bar, for every file: lines ≥ 95%, statements ≥ 95%, functions ≥ 95%, branches ≥ 85%.");
  });

  it("says what to do about a file under the bar", () => {
    const text = formatResults([createFailure()], BAR);

    expect(text).toContain("1 file(s) under the bar.");
    expect(text).toContain("pnpm coverage:gaps");
    expect(text).toContain("tools/coverage.config.mts");
  });

  it("gives no advice about files when every file meets the bar", () => {
    const text = formatResults([createResult()], BAR);

    expect(text).toContain("Every measured file meets the bar.");
    expect(text).not.toContain("under the bar.");
  });

  it("tells a failed test apart from low coverage", () => {
    const text = formatResults(
      [
        createResult({
          verdict: "FAIL",
          reason: "1 test failed, so nothing was measured",
          failedTests: [{ name: "marks a higher price as up", message: "expected 'down' to be 'up'" }],
        }),
      ],
      BAR,
    );

    expect(text).toContain("  ✗ marks a higher price as up\n    expected 'down' to be 'up'");
    expect(text).toContain("1 test(s) failed. Fix them first");
    expect(text).not.toContain("file(s) under the bar");
  });

  it("does not call it a pass when nothing was measured", () => {
    const text = formatResults([createResult({ verdict: "SKIP", reason: "no file to measure: none matches `include`, or every one is excluded" })], BAR);

    expect(text).toContain("SKIP packages/a — no file to measure: none matches `include`, or every one is excluded");
    expect(text).toContain("Nothing was measured in any package. That is not a pass.");
    expect(text).not.toContain("Every measured file meets the bar.");
  });

  it("says a package that could not be measured is not a pass", () => {
    const text = formatResults([createResult(), createResult({ directory: "packages/b", verdict: "ERROR", reason: "vitest wrote no coverage summary" })], BAR);

    expect(text).toContain("1 package(s) could not be measured. That is not a pass.");
    expect(text).not.toContain("Every measured file meets the bar.");
  });

  it("points at each ignore comment without a reason and says what to write", () => {
    const text = formatResults(
      [createResult({ verdict: "FAIL", reason: "1 ignore comment without a reason", unexplainedIgnores: [{ file: "packages/a/src/price.ts", line: 12 }] })],
      BAR,
    );

    expect(text).toContain("  packages/a/src/price.ts:12\n    an ignore comment without a reason — say after ` -- ` why no test can reach this code");
    expect(text).toContain("1 ignore comment(s) without a reason.");
    expect(text).not.toContain("Every measured file meets the bar.");
  });

  it("rounds a percentage down, so 94.999 never reads as 95", () => {
    expect(formatPercent(94.999)).toBe("94.99%");
  });
});

describe("which commit a report was built from", () => {
  it("states the commit, the branch and the time", () => {
    expect(describeBuild(createBuild())).toBe("commit abc1234 (main) on 2026-10-04 19:56 UTC");
  });

  it("says so when the tree had changes that are not in the commit", () => {
    expect(describeBuild(createBuild({ dirty: true }))).toBe("commit abc1234 with uncommitted changes (main) on 2026-10-04 19:56 UTC");
  });

  it("says so when there is no commit to name", () => {
    expect(describeBuild(createBuild({ commit: undefined, ref: undefined }))).toBe(
      "an unknown commit (git has no commit here) on 2026-10-04 19:56 UTC",
    );
  });
});

describe("the job summary", () => {
  it("has a row per package with the package's own percentages", () => {
    const markdown = formatMarkdown([createFailure()], BAR, createBuild());

    expect(markdown).toContain("Built from commit abc1234 (main) on 2026-10-04 19:56 UTC.");
    expect(markdown).toContain("| `packages/a` | FAIL | 2 | 85.71% | 100% | 100% | 90.9% |");
  });

  it("lists the files under the bar", () => {
    const markdown = formatMarkdown([createFailure()], BAR, createBuild());

    expect(markdown).toContain("### Files under the bar");
    expect(markdown).toContain("| `packages/a/src/weak.ts` | lines 50% (needs 95%, 2 not covered) · branches 0% (needs 85%, 1 not covered) |");
  });

  it("lists the packages that were not measured, with the reason", () => {
    const markdown = formatMarkdown(
      [createResult({ directory: "packages/types", verdict: "SKIP", reason: "2 files, none with code to cover (types and re-exports only)" })],
      BAR,
      createBuild(),
    );

    expect(markdown).toContain("### Not measured");
    expect(markdown).toContain("- `packages/types`: 2 files, none with code to cover (types and re-exports only)");
    expect(markdown).toContain("| `packages/types` | SKIP | 0 | – | – | – | – |");
  });

  it("lists the failed tests", () => {
    const markdown = formatMarkdown(
      [createResult({ verdict: "FAIL", failedTests: [{ name: "marks a higher price as up", message: "expected `down` to be `up`" }] })],
      BAR,
      createBuild(),
    );

    expect(markdown).toContain("### Failed tests");
    expect(markdown).toContain("- marks a higher price as up: `expected 'down' to be 'up'`");
  });

  it("lists the ignore comments without a reason", () => {
    const markdown = formatMarkdown(
      [createResult({ verdict: "FAIL", unexplainedIgnores: [{ file: "packages/a/src/price.ts", line: 12 }] })],
      BAR,
      createBuild(),
    );

    expect(markdown).toContain("### Ignore comments without a reason\n\n- `packages/a/src/price.ts:12`");
  });

  it("leaves out the sections that have nothing in them", () => {
    const markdown = formatMarkdown([createResult({ measured: [createFileCoverage("packages/a/src/price.ts")] })], BAR, createBuild());

    expect(markdown).not.toContain("###");
  });
});

/** A package with one strong file and one weak one. */
function createFailure(): ReturnType<typeof createResult> {
  return createResult({
    verdict: "FAIL",
    reason: "1 of 2 files under the bar",
    measured: [
      createFileCoverage("packages/a/src/strong.ts"),
      createFileCoverage("packages/a/src/weak.ts", { lines: [2, 4], branches: [0, 1] }),
    ],
    underTheBar: [
      {
        file: "packages/a/src/weak.ts",
        shortfalls: [
          { metric: "lines", pct: 50, needed: 95, uncovered: 2 },
          { metric: "branches", pct: 0, needed: 85, uncovered: 1 },
        ],
      },
    ],
  });
}
