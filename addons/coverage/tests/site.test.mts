import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { PackageResult } from "../files/tools/coverage/lib/judge.mts";
import { buildReport } from "../files/tools/coverage/lib/site.mts";
import { createBuild, createConfig, createFileCoverage, createFolder, createResult } from "./support.mts";

describe("the merged report", () => {
  it("copies each measured package's HTML report under the package's path and links it from the index", () => {
    const root = createFolder({ "packages/a/coverage/index.html": "<p>package a</p>" });
    const index = buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild() });

    expect(index).toBe("coverage/report/index.html");
    expect(readFileSync(join(root, "coverage/report/packages/a/index.html"), "utf8")).toBe("<p>package a</p>");
    expect(readFileSync(join(root, index), "utf8")).toContain('<a href="./packages/a/index.html">packages/a</a>');
  });

  it("states the commit and the date it was built from, and that a published report can be old", () => {
    const root = createFolder();
    const index = buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild() });
    const page = readFileSync(join(root, index), "utf8");

    expect(page).toContain("Built from commit abc1234 (main) on 2026-10-04 19:56 UTC.");
    expect(page).toContain("A published report shows the commit that built it, not the newest one.");
  });

  it("links the CI run that built it when there is one", () => {
    const root = createFolder();
    const runUrl = "https://github.com/acme/app/actions/runs/7";
    const index = buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild({ runUrl }) });

    expect(readFileSync(join(root, index), "utf8")).toContain(`<a href="${runUrl}">The run that built this report</a>`);
  });

  it("keeps the test results out of the published report and gathers them beside it", () => {
    const root = createFolder({
      "packages/a/coverage/index.html": "<p>package a</p>",
      "packages/a/coverage/test-results.json": '{"numTotalTests":1}',
    });

    buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild() });

    expect(existsSync(join(root, "coverage/report/packages/a/test-results.json"))).toBe(false);
    expect(readFileSync(join(root, "coverage/test-results/packages/a.json"), "utf8")).toBe('{"numTotalTests":1}');
  });

  it("does not show an HTML report for a package that was not measured in this run", () => {
    const root = createFolder({ "packages/a/coverage/index.html": "<p>left by an earlier run</p>" });
    const failed = createResult({ verdict: "FAIL", reason: "1 test failed, so nothing was measured" });
    const index = buildReport({ root, results: [failed], config: createConfig(), build: createBuild() });

    expect(existsSync(join(root, "coverage/report/packages/a"))).toBe(false);
    expect(readFileSync(join(root, index), "utf8")).toContain("<td>packages/a</td>");
  });

  it("removes the previous merged report first", () => {
    const root = createFolder({ "coverage/report/packages/gone/index.html": "<p>a package that no longer exists</p>" });

    buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild() });

    expect(existsSync(join(root, "coverage/report/packages/gone"))).toBe(false);
  });

  it("lists the files under the bar", () => {
    const root = createFolder();
    const failure = createResult({
      verdict: "FAIL",
      underTheBar: [{ file: "packages/a/src/weak.ts", shortfalls: [{ metric: "lines", pct: 50, needed: 95, uncovered: 2 }] }],
    });
    const index = buildReport({ root, results: [failure], config: createConfig(), build: createBuild() });

    expect(readFileSync(join(root, index), "utf8")).toContain(
      "<li><code>packages/a/src/weak.ts</code> — lines 50% (needs 95%, 2 not covered)</li>",
    );
  });

  it("lists the ignore comments without a reason", () => {
    const root = createFolder();
    const failure = createResult({ verdict: "FAIL", unexplainedIgnores: [{ file: "packages/a/src/price.ts", line: 12 }] });
    const index = buildReport({ root, results: [failure], config: createConfig(), build: createBuild() });

    expect(readFileSync(join(root, index), "utf8")).toContain(
      "<li><code>packages/a/src/price.ts:12</code> — an ignore comment without a reason</li>",
    );
  });

  it("lists what is left out of the measurement, with the reasons", () => {
    const root = createFolder();
    const config = createConfig({ exclude: { "packages/a/src/generated/**": "written by the schema generator" } });
    const index = buildReport({ root, results: [createMeasured()], config, build: createBuild() });

    expect(readFileSync(join(root, index), "utf8")).toContain(
      "<li><code>packages/a/src/generated/**</code> — written by the schema generator</li>",
    );
  });

  it("escapes what it writes into the page", () => {
    const root = createFolder();
    const config = createConfig({ exclude: { "**/a&b/**": 'holds <script> & "quotes"' } });
    const index = buildReport({ root, results: [createMeasured()], config, build: createBuild() });
    const page = readFileSync(join(root, index), "utf8");

    expect(page).toContain("<code>**/a&amp;b/**</code> — holds &lt;script&gt; &amp; &quot;quotes&quot;");
    expect(page).not.toContain("<script>");
  });

  it("writes the same facts for a machine: the commit, the date, the bar and each verdict", () => {
    const root = createFolder();

    buildReport({ root, results: [createMeasured()], config: createConfig(), build: createBuild({ dirty: true }) });

    expect(JSON.parse(readFileSync(join(root, "coverage/report/summary.json"), "utf8"))).toMatchObject({
      commit: "abc1234def5678900000000000000000000000ff",
      uncommittedChanges: true,
      ref: "main",
      builtAt: "2026-10-04T19:56:31.000Z",
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
      packages: [{ directory: "packages/a", verdict: "PASS", measuredFiles: 1, underTheBar: [] }],
    });
  });
});

/** A package that was measured in this run. */
function createMeasured(): PackageResult {
  return createResult({ measured: [createFileCoverage("packages/a/src/price.ts")] });
}
