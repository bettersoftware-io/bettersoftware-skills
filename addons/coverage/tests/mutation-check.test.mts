import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Mutant, RunTest, TestRun } from "../files/tools/coverage/mutation-check.mts";
import { createShellRunner, exitCodeFor, formatTable, MutationError, readSpec, runMutants } from "../files/tools/coverage/mutation-check.mts";
import { createFolder, TOOLS } from "./support.mts";

const SOURCE = "export const add = (a, b) => a + b;\n";
const MUTATED = "export const add = (a, b) => a - b;\n";

describe("checking that a test can fail", () => {
  it("reports a mutant as KILLED when its test goes red with the mutant in place", async () => {
    const root = createProject();
    const results = await runMutants([createMutant()], { root, runTest: createTestThatNotices(root) });

    expect(results).toEqual([{ name: "add subtracts", status: "KILLED", detail: "" }]);
  });

  it("reports a mutant as SURVIVED when its test stays green, and says that is about the test", async () => {
    const root = createProject();
    const results = await runMutants([createMutant()], { root, runTest: () => "green" });

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
    const runs: TestRun[] = ["green"];
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

        return "green";
      },
    });

    expect(results[0]?.status).toBe("ERROR");
    expect(results[0]?.detail).toBe('"find" occurs 3 times in src/add.ts; it must occur exactly once');
    expect(commands).toEqual([]);
  });

  it("refuses a `find` that does not occur", async () => {
    const results = await runMutants([createMutant({ find: "a * b" })], { root: createProject(), runTest: () => "green" });

    expect(results[0]?.detail).toBe('"find" occurs 0 times in src/add.ts; it must occur exactly once');
  });

  it("refuses a mutant whose test is red before anything is changed", async () => {
    const root = createProject();
    const seen: string[] = [];
    const results = await runMutants([createMutant()], {
      root,
      runTest: () => {
        seen.push(readFileSync(join(root, "src/add.ts"), "utf8"));

        return "red";
      },
    });

    expect(results[0]?.status).toBe("ERROR");
    expect(results[0]?.detail).toBe("the test is red before the mutant is applied, so a red run would prove nothing");
    expect(seen).toEqual([SOURCE]);
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

          return sources === unchanged ? "green" : "red";
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

        return "green";
      },
    });

    expect(seen[1]).toBe("export const add = (a, b) => a /* $& */ - b;\n");
  });

  it("reports a file that does not exist as an error in the table", async () => {
    const results = await runMutants([createMutant({ file: "src/gone.ts" })], { root: createProject(), runTest: () => "green" });

    expect(results).toEqual([{ name: "add subtracts", status: "ERROR", detail: "src/gone.ts does not exist" }]);
  });

  it("counts a test that timed out under the mutant as neither killed nor survived", async () => {
    const runs: TestRun[] = ["green", "timed out"];
    const results = await runMutants([createMutant()], { root: createProject(), runTest: () => runs.shift() ?? "green" });

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

  it("is 2 when a mutant could not be judged", () => {
    expect(exitCodeFor([createRow("SURVIVED"), createRow("ERROR")], 2)).toBe(2);
  });
});

describe("running a test command", () => {
  it("reads exit 0 as green and any other exit as red", () => {
    const runTest = createShellRunner(createFolder(), 60);

    expect(runTest('node -e "process.exit(0)"')).toBe("green");
    expect(runTest('node -e "process.exit(3)"')).toBe("red");
  });

  it("runs the command in the project root", () => {
    const runTest = createShellRunner(createFolder({ "marker.txt": "" }), 60);

    expect(runTest("node -e \"require('node:fs').accessSync('marker.txt')\"")).toBe("green");
  });

  it("reads a command that outlives the timeout as timed out, not as red", () => {
    const runTest = createShellRunner(createFolder(), 0.5);

    expect(runTest('node -e "setTimeout(() => {}, 600000)"')).toBe("timed out");
  });
});

describe("the command line", () => {
  it("prints the table and exits 0 when the mutant is killed, leaving the file as it was", () => {
    const root = createProject();
    const { status, stdout } = runCommandLine(root, [createMutant({ test: "node check.mts" })]);

    expect(stdout).toContain("KILLED   add subtracts");
    expect(stdout).toContain("1 of 1 killed.");
    expect(status).toBe(0);
    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
  });

  it("waits for the file to be put back when it is told to terminate while a mutant is applied", () => {
    const root = createProject();
    // Under the mutant the "test" sends SIGTERM to the tool that runs it.
    const terminate = "grep -q 'a - b' src/add.ts && kill -TERM $PPID; exit 0";
    const { status, stdout } = runCommandLine(root, [createMutant({ test: terminate }), createMutant({ name: "never runs", test: terminate })]);

    expect(readFileSync(join(root, "src/add.ts"), "utf8")).toBe(SOURCE);
    expect(stdout).toContain("Stopped after 1; the rest did not run.");
    expect(status).toBe(143);
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
  return () => (readFileSync(join(root, "src/add.ts"), "utf8") === MUTATED ? "red" : "green");
}

function createRow(status: "KILLED" | "SURVIVED" | "ERROR"): { name: string; status: typeof status; detail: string } {
  return { name: "a mutant", status, detail: "" };
}

function runCommandLine(root: string, spec: Mutant[]): { status: number | null; stdout: string } {
  writeFileSync(join(root, "mutants.json"), JSON.stringify(spec));

  return spawnSync("node", [join(TOOLS, "mutation-check.mts"), "mutants.json"], { cwd: root, encoding: "utf8" });
}
