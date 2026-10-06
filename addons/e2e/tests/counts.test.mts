import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { forgetResults, readCounts, RESULTS } from "../files/tools/e2e/lib/counts.mts";
import { fileExists, write } from "./support.mts";

describe("how many specs ran", () => {
  it("is read from Playwright's results: what passed, a flaky pass with it, and what failed", () => {
    const tests = createResults(JSON.stringify({ stats: { expected: 5, unexpected: 2, flaky: 1, skipped: 9 } }));

    expect(readCounts(tests)).toEqual({ numPassedTests: 6, numFailedTests: 2 });
  });

  it("is zero and zero when nothing ran, which is a count and not a missing one", () => {
    expect(readCounts(createResults(JSON.stringify({ stats: { expected: 0, unexpected: 0 } })))).toEqual({ numPassedTests: 0, numFailedTests: 0 });
  });

  it("is not known without a results file, or from one that holds no counts", () => {
    expect(readCounts(createResults(undefined))).toBeUndefined();
    expect(readCounts(createResults("{}"))).toBeUndefined();
    expect(readCounts(createResults(JSON.stringify({ stats: { expected: "5", unexpected: 0 } })))).toBeUndefined();
    expect(readCounts(createResults("not json"))).toBeUndefined();
  });

  it("is forgotten before a run, so a run that writes none has none", () => {
    const tests = createResults(JSON.stringify({ stats: { expected: 5, unexpected: 0 } }));

    forgetResults(tests);

    expect(fileExists(tests, RESULTS)).toBe(false);
    expect(readCounts(tests)).toBeUndefined();
  });
});

function createResults(text: string | undefined): string {
  const tests = mkdtempSync(join(tmpdir(), "e2e-counts-"));

  onTestFinished(() => {
    rmSync(tests, { recursive: true, force: true });
  });

  if (text !== undefined) {
    write(join(tests, RESULTS), text);
  }

  return tests;
}
