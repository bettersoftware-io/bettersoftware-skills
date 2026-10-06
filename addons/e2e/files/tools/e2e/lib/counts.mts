// How many specs ran, for a tool that needs to know a green run was not a
// run of nothing.
//
// The coverage add-on's mutation check runs a test command with a mutant in
// place, and refuses a command that cannot say how many tests it ran. It puts
// a path in MUTATION_CHECK_REPORT and reads `numPassedTests` and
// `numFailedTests` from the JSON file it finds there afterwards. When that
// variable is set, the run writes the file, from Playwright's own results.
// Without it, nothing is written.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the Playwright config writes its JSON results, from the tests package. */
export const RESULTS = "reports/results.json";

/** The variable that names the file a count is asked for in. */
export const COUNT_VARIABLE = "MUTATION_CHECK_REPORT";

export interface Counts {
  numPassedTests: number;
  numFailedTests: number;
}

interface PlaywrightResults {
  stats?: { expected?: unknown; unexpected?: unknown; flaky?: unknown };
}

/** Removes the results of an earlier run, so that a count is never one it left. */
export function forgetResults(tests: string): void {
  rmSync(join(tests, RESULTS), { force: true });
}

/** The counts in Playwright's results file. Undefined when it is not there or holds none. */
export function readCounts(tests: string): Counts | undefined {
  const file = join(tests, RESULTS);

  if (!existsSync(file)) {
    return undefined;
  }

  try {
    const { stats } = JSON.parse(readFileSync(file, "utf8")) as PlaywrightResults;
    const { expected, unexpected, flaky } = stats ?? {};

    return typeof expected === "number" && typeof unexpected === "number"
      ? { numPassedTests: expected + (typeof flaky === "number" ? flaky : 0), numFailedTests: unexpected }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the counts where they were asked for. Does nothing when nobody asked, or when there is no count to give. */
export function reportCounts(tests: string, environment: NodeJS.ProcessEnv): void {
  const asked = environment[COUNT_VARIABLE];
  const counts = readCounts(tests);

  if (asked === undefined || asked === "" || counts === undefined) {
    return;
  }

  mkdirSync(dirname(asked), { recursive: true });
  writeFileSync(asked, `${JSON.stringify(counts)}\n`);
}
