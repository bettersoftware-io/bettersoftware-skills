import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Mutant, MutantStatus, RunTest, TestRun } from "../files/tools/coverage/mutation-check.mts";
import {
  askForReport,
  createShellRunner,
  exitCodeFor,
  formatTable,
  MutationError,
  readSpec,
  readTestsRun,
  runMutants,
} from "../files/tools/coverage/mutation-check.mts";
import { createFolder, TOOLS } from "./support.mts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

const SOURCE = "export const add = (a, b) => a + b;\n";
const MUTATED = "export const add = (a, b) => a - b;\n";

/** What a runner reports when one test ran and passed, and when it failed. */
const GREEN: TestRun = { verdict: "green", testsRun: 1 };
const RED: TestRun = { verdict: "red", testsRun: 1 };

/** Stands for a test runner: writes the counts it is given (passed, failed, skipped) where the tool asked. */
const REPORTING_SCRIPT = [
  "import { writeFileSync } from 'node:fs';",
  "const [numPassedTests, numFailedTests, numPendingTests] = process.argv.slice(2).map(Number);",
  "writeFileSync(process.env.MUTATION_CHECK_REPORT, JSON.stringify({ numPassedTests, numFailedTests, numPendingTests }));",
  "process.exit(numFailedTests > 0 ? 1 : 0);",
  "",
].join("\n");

describe("checking that a test can fail", () => {
  it("reports a mutant as KILLED when its test goes red with the mutant in place", async () => {
    const root = createProject();
    const results = await runMutants([createMutant()], { root, runTest: createTestThatNotices(root) });

    expect(results).toEqual([{ name: "add subtracts", status: "KILLED", detail: "" }]);
  });

  it("reports a mutant as SURVIVED when its test stays green, and says that is about the test", async () => {
    const root = createProject();
    const results = await runMutants([createMutant()], { root, runTest: () => GREEN });

    expect(results).toEqual([{ name: "add subtracts", status: "SURVIVED", detail: "the test passes with the mutant applied" }]);
    expect(formatTable(results, 1)).toContain("A SURVIVED row is a finding about the test");
  });

  it("puts the file back after the mutant has run", async () => {
    const root = createProject();

    await runMutants([createMutant()], { root, runTest: createTestThatNotices(root) });

    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
  });

  it("puts the file back even when running the test throws", async () => {
    const root = createProject();
    const runs: TestRun[] = [GREEN];
    const run = runMutants([createMutant()], {
      root,
      runTest: () => {
        const next = runs.shift();

        if (next === undefined) {
          throw new Error("the test runner crashed");
        }

        return next;
      },
    });

    await expect(run).rejects.toThrow("the test runner crashed");
    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
  });

  it("refuses a `find` that occurs more than once, without touching the file or running a test", async () => {
    const root = createProject();
    const commands: string[] = [];
    const results = await runMutants([createMutant({ find: "a", replace: "c" })], {
      root,
      runTest: (command) => {
        commands.push(command);

        return GREEN;
      },
    });

    expect(results[0]?.status).toBe("ERROR");
    expect(results[0]?.detail).toBe('"find" occurs 3 times in src/add.ts; it must occur exactly once');
    expect(commands).toEqual([]);
  });

  it("refuses a `find` that does not occur", async () => {
    const results = await runMutants([createMutant({ find: "a * b" })], { root: createProject(), runTest: () => GREEN });

    expect(results[0]?.detail).toBe('"find" occurs 0 times in src/add.ts; it must occur exactly once');
  });

  it("refuses a mutant whose test is red before anything is changed", async () => {
    const root = createProject();
    const seen: string[] = [];
    const results = await runMutants([createMutant()], {
      root,
      runTest: () => {
        seen.push(readFileSync(join(root, "src/add.ts"), "utf8"));

        return RED;
      },
    });

    expect(results[0]?.status).toBe("ERROR");
    expect(results[0]?.detail).toBe("the test is red before the mutant is applied, so a red run would prove nothing");
    expect(seen).toEqual([SOURCE]);
  });

  it("refuses a mutant whose test command ran no test, without touching the file", async () => {
    const root = createProject();
    const seen: string[] = [];
    const results = await runMutants([createMutant()], {
      root,
      runTest: () => {
        seen.push(readFileSync(join(root, "src/add.ts"), "utf8"));

        return { verdict: "green", testsRun: 0 };
      },
    });

    expect(results[0]?.status).toBe("NO TESTS");
    expect(results[0]?.detail).toContain("the test command ran 0 tests with no mutant applied");
    expect(results[0]?.detail).toContain("vitest cuts an `it.each` title at 40 characters");
    expect(seen).toEqual([SOURCE]);
  });

  it("says NO TESTS, not that the test is red, for a runner that fails when nothing matched", async () => {
    const results = await runMutants([createMutant()], { root: createProject(), runTest: () => ({ verdict: "red", testsRun: 0 }) });

    expect(results[0]?.status).toBe("NO TESTS");
  });

  it("refuses a mutant whose test command left no count of its tests", async () => {
    const root = createProject();
    const seen: string[] = [];
    const results = await runMutants([createMutant()], {
      root,
      runTest: () => {
        seen.push(readFileSync(join(root, "src/add.ts"), "utf8"));

        return { verdict: "green" };
      },
    });

    expect(results[0]?.status).toBe("NO TESTS");
    expect(results[0]?.detail).toContain("left no count of the tests it ran");
    expect(results[0]?.detail).toContain('"uncounted": "<reason>"');
    expect(seen).toEqual([SOURCE]);
  });

  it("judges a command with no count on its exit code when the row says why it has none", async () => {
    const root = createProject();
    const uncounted = createTestThatNotices(root);
    const results = await runMutants([createMutant({ uncounted: "a script, not a test runner" })], {
      root,
      runTest: (command) => ({ verdict: uncounted(command).verdict }),
    });

    expect(results[0]?.status).toBe("KILLED");
  });

  it("still refuses a row marked uncounted when its command did count, and counted zero", async () => {
    const results = await runMutants([createMutant({ uncounted: "a script" })], {
      root: createProject(),
      runTest: () => ({ verdict: "green", testsRun: 0 }),
    });

    expect(results[0]?.status).toBe("NO TESTS");
  });

  it("shows each line of a reason under its row, and says what a NO TESTS row means", async () => {
    const results = await runMutants([createMutant()], { root: createProject(), runTest: () => ({ verdict: "green", testsRun: 0 }) });
    const table = formatTable(results, 1);

    expect(table).toContain("  NO TESTS add subtracts\n           the test command ran 0 tests with no mutant applied");
    expect(table).toContain("\n           Usually a filter matches no test");
    expect(table).toContain("A NO TESTS row was not judged");
    expect(table).toContain("0 of 1 killed.");
  });

  it("runs each test command once without a mutant, however many mutants share it", async () => {
    const twice = "export const twice = (a) => a * 2;\n";
    const root = createFolder({ "src/add.ts": SOURCE, "src/twice.ts": twice });
    const unchanged = SOURCE + twice;
    const seen: string[] = [];

    await runMutants(
      [createMutant(), createMutant({ name: "twice triples", file: "src/twice.ts", find: "a * 2", replace: "a * 3" })],
      {
        root,
        runTest: () => {
          const sources = readFileSync(join(root, "src/add.ts"), "utf8") + readFileSync(join(root, "src/twice.ts"), "utf8");

          seen.push(sources);

          return sources === unchanged ? GREEN : RED;
        },
      },
    );

    expect(seen.filter((sources) => sources === unchanged)).toHaveLength(1);
    expect(seen).toHaveLength(3);
  });

  it("writes $& in a replacement as it is, not as the text it replaced", async () => {
    const root = createProject();
    const seen: string[] = [];

    await runMutants([createMutant({ replace: "a /* $& */ - b" })], {
      root,
      runTest: () => {
        seen.push(readFileSync(join(root, "src/add.ts"), "utf8"));

        return GREEN;
      },
    });

    expect(seen[1]).toBe("export const add = (a, b) => a /* $& */ - b;\n");
  });

  it("reports a file that does not exist as an error in the table", async () => {
    const results = await runMutants([createMutant({ file: "src/gone.ts" })], { root: createProject(), runTest: () => GREEN });

    expect(results).toEqual([{ name: "add subtracts", status: "ERROR", detail: "src/gone.ts does not exist" }]);
  });

  it("counts a test that timed out under the mutant as neither killed nor survived", async () => {
    const runs: TestRun[] = [GREEN, { verdict: "timed out" }];
    const results = await runMutants([createMutant()], { root: createProject(), runTest: () => runs.shift() ?? GREEN });

    expect(results[0]?.status).toBe("ERROR");
    expect(results[0]?.detail).toBe("the test timed out with the mutant applied; that is not a red test");
  });

  it("stops between mutants when asked to, and says the rest did not run", async () => {
    const root = createProject();
    let stopped = false;
    const results = await runMutants([createMutant(), createMutant({ name: "never runs" })], {
      root,
      runTest: createTestThatNotices(root),
      announce: () => {
        stopped = true;
      },
      isStopped: () => stopped,
    });

    expect(results.map(({ name }) => name)).toEqual(["add subtracts"]);
    expect(formatTable(results, 2)).toContain("1 of 2 killed.\nStopped after 1; the rest did not run.");
  });
});

describe("the spec", () => {
  it("reads a list of mutants", () => {
    const root = createFolder({ "mutants.json": JSON.stringify([createMutant()]) });

    expect(readSpec(join(root, "mutants.json"))).toEqual([createMutant()]);
  });

  it("refuses a mutant with a field that is missing or not text", () => {
    const root = createFolder({ "mutants.json": JSON.stringify([{ ...createMutant(), find: 3 }]) });

    expect(() => readSpec(join(root, "mutants.json"))).toThrow(MutationError);
    expect(() => readSpec(join(root, "mutants.json"))).toThrow('mutant 1 needs a "find" that is text');
  });

  it("refuses a mutant that changes nothing", () => {
    const root = createFolder({ "mutants.json": JSON.stringify([createMutant({ replace: "a + b" })]) });

    expect(() => readSpec(join(root, "mutants.json"))).toThrow('mutant 1 ("add subtracts") changes nothing');
  });

  it("refuses an `uncounted` that gives no reason", () => {
    const root = createFolder({ "mutants.json": JSON.stringify([{ ...createMutant(), uncounted: " " }]) });

    expect(() => readSpec(join(root, "mutants.json"))).toThrow('mutant 1 has an "uncounted" that does not say why');
  });

  it("refuses an empty list", () => {
    const root = createFolder({ "mutants.json": "[]" });

    expect(() => readSpec(join(root, "mutants.json"))).toThrow("expected a JSON array with at least one mutant");
  });
});

describe("the exit code", () => {
  it("is 0 when every mutant ran and was killed", () => {
    expect(exitCodeFor([createRow("KILLED"), createRow("KILLED")], 2)).toBe(0);
  });

  it("is 1 when a mutant survived", () => {
    expect(exitCodeFor([createRow("KILLED"), createRow("SURVIVED")], 2)).toBe(1);
  });

  it("is 1 when the run stopped before every mutant ran", () => {
    expect(exitCodeFor([createRow("KILLED")], 2)).toBe(1);
  });

  it("is 2 when a test command ran no test", () => {
    expect(exitCodeFor([createRow("KILLED"), createRow("NO TESTS")], 2)).toBe(2);
  });

  it("is 2 when a mutant could not be judged", () => {
    expect(exitCodeFor([createRow("SURVIVED"), createRow("ERROR")], 2)).toBe(2);
  });
});

describe("running a test command", () => {
  it("reads exit 0 as green and any other exit as red", () => {
    const runTest = createShellRunner(createFolder(), 60);

    expect(runTest('node -e "process.exit(0)"').verdict).toBe("green");
    expect(runTest('node -e "process.exit(3)"').verdict).toBe("red");
  });

  it("runs the command in the project root", () => {
    const runTest = createShellRunner(createFolder({ "marker.txt": "" }), 60);

    expect(runTest("node -e \"require('node:fs').accessSync('marker.txt')\"").verdict).toBe("green");
  });

  it("reads a command that outlives the timeout as timed out, not as red", () => {
    const runTest = createShellRunner(createFolder(), 0.5);

    expect(runTest('node -e "setTimeout(() => {}, 600000)"').verdict).toBe("timed out");
  });

  it("has no count for a command that writes no report", () => {
    expect(createShellRunner(createFolder(), 60)('node -e "process.exit(0)"')).toEqual({ verdict: "green", testsRun: undefined });
  });

  it("counts the tests a command reports in the file the environment names, skipped ones left out", () => {
    const runTest = createShellRunner(createFolder({ "report.mts": REPORTING_SCRIPT }), 60);

    expect(runTest("node report.mts 2 0 5")).toEqual({ verdict: "green", testsRun: 2 });
    expect(runTest("node report.mts 2 1 5")).toEqual({ verdict: "red", testsRun: 3 });
    expect(runTest("node report.mts 0 0 7")).toEqual({ verdict: "green", testsRun: 0 });
  });

  it("does not carry a count from one run to the next", () => {
    const runTest = createShellRunner(createFolder({ "report.mts": REPORTING_SCRIPT }), 60);

    runTest("node report.mts 4 0 0");

    expect(runTest('node -e "process.exit(0)"').testsRun).toBeUndefined();
  });

  it("asks vitest for a JSON report when vitest is what the command runs", () => {
    expect(askForReport('pnpm vitest run add -t "adds"', "/tmp/r.json")).toBe('pnpm vitest run add -t "adds" --reporter=json --outputFile="/tmp/r.json"');
    expect(askForReport("pnpm --filter @app/domain exec vitest run add", "/tmp/r.json")).toContain("--reporter=json");
    expect(askForReport("node_modules/.bin/vitest", "/tmp/r.json")).toContain("--reporter=json");
  });

  it("leaves a command alone when it names no vitest, or says where its report goes itself", () => {
    const own = 'vitest run --reporter=json --outputFile="$MUTATION_CHECK_REPORT"';

    expect(askForReport("node check.mts", "/tmp/r.json")).toBe("node check.mts");
    expect(askForReport("node tests/vitest-setup.mts", "/tmp/r.json")).toBe("node tests/vitest-setup.mts");
    expect(askForReport(own, "/tmp/r.json")).toBe(own);
  });

  it("reads no count from a report that is not JSON or holds no numbers", () => {
    const root = createFolder({ "broken.json": "{", "other.json": JSON.stringify({ numPassedTests: "3" }) });

    expect(readTestsRun(join(root, "broken.json"))).toBeUndefined();
    expect(readTestsRun(join(root, "other.json"))).toBeUndefined();
    expect(readTestsRun(join(root, "absent.json"))).toBeUndefined();
  });
});

describe("a real vitest", () => {
  // The defect this guards: vitest exits 0 when `-t` matches nothing, so only
  // the count tells a run of nothing from a pass.
  it("runs one test for a filter that matches, and zero, still green, for a filter that matches none", () => {
    const tests = createFolder({ "add.test.ts": 'it("adds two numbers", () => {\n  expect(1 + 2).toBe(3);\n});\n' });
    const runTest = createShellRunner(REPOSITORY, 120);

    expect(runTest(`pnpm vitest run --root ${tests} --globals -t "adds two numbers"`)).toEqual({ verdict: "green", testsRun: 1 });
    expect(runTest(`pnpm vitest run --root ${tests} --globals -t "a title no test has"`)).toEqual({ verdict: "green", testsRun: 0 });
  }, 120_000);
});

describe("the command line", () => {
  it("prints the table and exits 0 when the mutant is killed, leaving the file as it was", () => {
    const root = createProject();
    const { status, stdout } = runCommandLine(root, [createMutant({ test: "node check.mts", uncounted: "a script, not a test runner" })]);

    expect(stdout).toContain("KILLED   add subtracts");
    expect(stdout).toContain("1 of 1 killed.");
    expect(status).toBe(0);
    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
  });

  it("waits for the file to be put back when it is told to terminate while a mutant is applied", () => {
    const root = createProject();
    // Under the mutant the "test" sends SIGTERM to the tool that runs it.
    const terminate = "grep -q 'a - b' src/add.ts && kill -TERM $PPID; exit 0";
    const { status, stdout } = runCommandLine(root, [
      createMutant({ test: terminate, uncounted: "a shell line" }),
      createMutant({ name: "never runs", test: terminate, uncounted: "a shell line" }),
    ]);

    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
    expect(stdout).toContain("Stopped after 1; the rest did not run.");
    expect(status).toBe(143);
  });

  it("prints NO TESTS and exits 2 for a command that counts nothing, leaving the file as it was", () => {
    const root = createProject();
    const { status, stdout } = runCommandLine(root, [createMutant({ test: "node check.mts" })]);

    expect(stdout).toContain("NO TESTS add subtracts");
    expect(stdout).toContain("0 of 1 killed.");
    expect(status).toBe(2);
    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
  });

  it("refuses a timeout that is not a number of seconds above 0", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "mutation-check.mts"), "mutants.json", "--timeout", "0"], { encoding: "utf8" });

    expect(stderr).toContain('mutation-check could not run: "--timeout" needs a number of seconds above 0');
    expect(status).toBe(2);
  });

  it("exits 2 with the usage when no spec is given", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "mutation-check.mts")], { encoding: "utf8" });

    expect(stderr).toContain("mutation-check could not run: usage:");
    expect(status).toBe(2);
  });
});

/** A project with one source file and a check that fails when `add` no longer adds. */
function createProject(): string {
  return createFolder({
    "src/add.ts": SOURCE,
    "check.mts": "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('src/add.ts', 'utf8').includes('a + b') ? 0 : 1);\n",
  });
}

function createMutant(overrides: Partial<Mutant> = {}): Mutant {
  return { name: "add subtracts", file: "src/add.ts", find: "a + b", replace: "a - b", test: "check add", ...overrides };
}

/** A test that is red exactly when the mutant is in the file. */
function createTestThatNotices(root: string): RunTest {
  return () => (readFileSync(join(root, "src/add.ts"), "utf8") === MUTATED ? RED : GREEN);
}

function createRow(status: MutantStatus): { name: string; status: typeof status; detail: string } {
  return { name: "a mutant", status, detail: "" };
}

function runCommandLine(root: string, spec: Mutant[]): { status: number | null; stdout: string } {
  writeFileSync(join(root, "mutants.json"), JSON.stringify(spec));

  return spawnSync("node", [join(TOOLS, "mutation-check.mts"), "mutants.json"], { cwd: root, encoding: "utf8" });
}
