import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LOG_FILE, planStages, QuietError, runQuiet, type RunStage, splitChain, type StageRun } from "./quiet.mts";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "quiet.mts");

describe("the stages of a gate script", () => {
  it("are the parts of its && chain, in order", () => {
    expect(planStages({ "gate:fast": "pnpm gates && pnpm lint && pnpm typecheck" }, "gate:fast")).toEqual([
      "pnpm gates",
      "pnpm lint",
      "pnpm typecheck",
    ]);
  });

  it("open up a part that runs another chain of the project, so gate:full shows gate:fast's stages", () => {
    const scripts = { "gate:fast": "pnpm gates && pnpm lint", "gate:full": "pnpm gate:fast && pnpm test && pnpm run build", build: "turbo run build" };

    expect(planStages(scripts, "gate:full")).toEqual(["pnpm gates", "pnpm lint", "pnpm test", "pnpm run build"]);
  });

  it("include what an add-on joined to either gate, where the add-on put it", () => {
    const scripts = {
      "gate:fast": "pnpm gates && pnpm lint && pnpm biome:check && pnpm perf:check",
      "gate:full": "pnpm gate:fast && pnpm test && pnpm build && pnpm coverage",
    };

    expect(planStages(scripts, "gate:full")).toEqual([
      "pnpm gates",
      "pnpm lint",
      "pnpm biome:check",
      "pnpm perf:check",
      "pnpm test",
      "pnpm build",
      "pnpm coverage",
    ]);
  });

  it("keep a script that is not a chain as one stage, under the name a person would type", () => {
    expect(planStages({ gate: "pnpm test && pnpm lint", test: "vitest run", lint: "eslint ." }, "gate")).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("refuse a script the project does not have", () => {
    expect(() => planStages({}, "gate:full")).toThrow(QuietError);
    expect(() => planStages({}, "gate:full")).toThrow('package.json has no "gate:full" script');
  });

  it("refuse a chain that runs itself", () => {
    const scripts = { a: "pnpm b && pnpm lint", b: "pnpm a && pnpm test" };

    expect(() => planStages(scripts, "a")).toThrow('the script "a" runs itself: a → b → a');
  });
});

describe("splitting a chain", () => {
  it("does not split inside quotes", () => {
    expect(splitChain("node -e \"a && b\" && echo 'c && d'")).toEqual(['node -e "a && b"', "echo 'c && d'"]);
  });

  it("keeps a variable set in front of a command with that command", () => {
    expect(splitChain("CI=1 pnpm test && pnpm build")).toEqual(["CI=1 pnpm test", "pnpm build"]);
  });

  it.each([
    ["pnpm a; pnpm b && pnpm c"],
    ["pnpm a || pnpm b && pnpm c"],
    ["pnpm a | tee log && pnpm c"],
    ["(pnpm a && pnpm b)"],
    ["pnpm a & pnpm b && pnpm c"],
    ["echo $(pnpm a) && pnpm c"],
    ["pnpm a && "],
  ])("leaves %s whole, since splitting it would change what runs", (script) => {
    expect(splitChain(script)).toEqual([script.trim()]);
  });
});

describe("a quiet run", () => {
  it("prints one line for each stage that passed and one for the whole, and exits 0", async () => {
    const { status, printed } = await runWith({ "pnpm lint": pass("412 files linted"), "pnpm test": pass("55 tests passed") });

    expect(printed).toBe("ok    pnpm lint (1.0s)\nok    pnpm test (1.0s)\ngate passed: 2 stages in 2.0s.\n");
    expect(status).toBe(0);
  });

  it("keeps the SKIP lines of a stage that passed, once each, since a check that judged nothing has not passed", async () => {
    const output = [
      "PASS structure",
      "SKIP types-only — no package is declared typesOnly",
      "@app/server:test: SKIP tests that need a port — they are not verified here",
      "@app/server:test: SKIP tests that need a port — they are not verified here",
      "it skips nothing: SKIPPED is not a verdict",
    ].join("\n");
    const { printed } = await runWith({ "pnpm gates": pass(output) });

    expect(printed).toBe(
      [
        "ok    pnpm gates (1.0s)",
        "      SKIP types-only — no package is declared typesOnly",
        "      @app/server:test: SKIP tests that need a port — they are not verified here",
        "gate passed: 1 stage in 1.0s.",
        "",
      ].join("\n"),
    );
  });

  it("prints the whole output of the stage that failed, and nothing from the stages that passed", async () => {
    const output = Array.from({ length: 5000 }, (_, line) => `line ${line} of the failure`).join("\n");
    const { printed } = await runWith({ "pnpm lint": pass("412 files linted"), "pnpm test": fail(1, output) });

    expect(printed).toContain("ok    pnpm lint (1.0s)\nFAIL  pnpm test (exit 1, 1.0s)\n\nline 0 of the failure\n");
    expect(printed).toContain("line 4999 of the failure\n");
    expect(printed).not.toContain("412 files linted");
    expect(printed.endsWith("\ngate is red.\n")).toBe(true);
  });

  it("stops at the stage that failed, as && does, and names the stages that did not run", async () => {
    const ran: string[] = [];
    const { printed } = await runWith({ "pnpm lint": fail(1, "bad"), "pnpm test": pass("never") }, ran);

    expect(ran).toEqual(["pnpm lint"]);
    expect(printed).toContain("not run:\n      pnpm test\n");
  });

  it("exits with the failing stage's own exit code", async () => {
    expect((await runWith({ "pnpm lint": fail(3, "bad") })).status).toBe(3);
    expect((await runWith({ "pnpm lint": pass(""), "pnpm test": fail(2, "could not run") })).status).toBe(2);
  });

  it("says so when the stage that failed printed nothing", async () => {
    expect((await runWith({ "pnpm lint": fail(1, "") })).printed).toContain("FAIL  pnpm lint (exit 1, 1.0s)\n\n(it printed nothing)\n");
  });

  it("reports a stage that was stopped as failed, with what it had printed, even when its code is 0", async () => {
    const stopped: StageRun = { status: 0, output: "halfway through the tests", ended: "stopped by SIGTERM" };
    const { status, printed } = await runWith({ "pnpm lint": stopped });

    expect(printed).toContain("FAIL  pnpm lint (stopped by SIGTERM, 1.0s)\n\nhalfway through the tests\n");
    expect(status).toBe(1);
  });

  it("runs no further stage once it is asked to stop, and does not call that a pass", async () => {
    const ran: string[] = [];
    const written: string[] = [];
    const status = await runQuiet({
      root: createProject({ gate: "pnpm lint && pnpm test" }),
      script: "gate",
      write: (text) => written.push(text),
      runStage: createStages({ "pnpm lint": pass(""), "pnpm test": pass("") }, ran),
      isStopped: () => ran.length === 1,
    });

    expect(ran).toEqual(["pnpm lint"]);
    expect(written.join("")).toContain("STOP  before pnpm test\nnot run:\n      pnpm test\n");
    expect(status).toBe(1);
  });

  it("refuses a folder with no package.json", async () => {
    const run = runQuiet({ root: mkdtempSync(join(tmpdir(), "quiet-gate-")), script: "gate", write: () => undefined });

    await expect(run).rejects.toThrow(QuietError);
  });
});

describe("the quiet gate, run as a command", () => {
  it("runs each stage in a shell in the project root, and prints a line for each", () => {
    const root = createProject({ gate: "node check.mjs one && node check.mjs two" }, { "check.mjs": "console.log('ran', process.argv[2]);\n" });
    const { status, stdout } = runCommand(root, "gate");

    expect(stdout).toMatch(/^ok {4}node check\.mjs one \(\d+\.\ds\)\nok {4}node check\.mjs two \(\d+\.\ds\)\ngate passed: 2 stages in \d+\.\ds\.\n$/);
    expect(status).toBe(0);
  });

  it("keeps what a failing stage wrote to both streams, in the order written", () => {
    const script = "console.log('to stdout'); console.error('to stderr'); process.exitCode = 4;\n";
    const { status, stdout } = runCommand(createProject({ gate: "node quiet-pass.mjs && node fails.mjs" }, { "quiet-pass.mjs": "console.log('hidden');\n", "fails.mjs": script }), "gate");

    expect(stdout).toContain("FAIL  node fails.mjs (exit 4, ");
    expect(stdout).toMatch(/to stdout\nto stderr\n/);
    expect(stdout).not.toContain("hidden");
    expect(status).toBe(4);
  });

  it("loses none of a failing stage's output, however long it is", () => {
    // Past the megabyte at which a buffered child process is killed.
    const script = "for (let line = 0; line < 60000; line += 1) console.log('a line of the failing output, number', line);\nprocess.exitCode = 1;\n";
    const { status, stdout } = runCommand(createProject({ gate: "node long.mjs" }, { "long.mjs": script }), "gate");

    expect(stdout.length).toBeGreaterThan(2_000_000);
    expect(stdout).toContain("a line of the failing output, number 0\n");
    expect(stdout).toContain("a line of the failing output, number 59999\n");
    expect(status).toBe(1);
  });

  it("finds a program the project installed, as pnpm does for a script", () => {
    const root = createProject({ gate: "local-tool && node -e 0" }, { "node_modules/.bin/local-tool": "#!/bin/sh\necho from the project\n" });

    spawnSync("chmod", ["+x", join(root, "node_modules/.bin/local-tool")]);

    expect(runCommand(root, "gate").status).toBe(0);
  });

  it("reports a stage that crashed, with the signal, and what it printed first", () => {
    const { status, stdout } = runCommand(createProject({ gate: "echo before the crash; kill -9 $$" }), "gate");

    expect(stdout).toContain("(stopped by SIGKILL, ");
    expect(stdout).toContain("before the crash\n");
    expect(status).toBe(137);
  });

  it("reports a command that does not exist as the shell does, with exit 127", () => {
    const { status, stdout } = runCommand(createProject({ gate: "no-such-program-anywhere --flag" }), "gate");

    expect(stdout).toContain("FAIL  no-such-program-anywhere --flag (exit 127, ");
    expect(stdout).toMatch(/not found/);
    expect(status).toBe(127);
  });

  it("writes everything every stage printed to the log, passed stages included", () => {
    const root = createProject({ gate: "node quiet-pass.mjs && node -e 0" }, { "quiet-pass.mjs": "console.log('printed by a stage that passed');\n" });

    runCommand(root, "gate");

    expect(readFileSync(join(root, LOG_FILE), "utf8")).toBe("\n$ node quiet-pass.mjs\nprinted by a stage that passed\n\n$ node -e 0\n");
  });

  it("when it is told to terminate, stops the stage in hand and prints what that stage had said", async () => {
    // What the stop hook's timeout does: SIGTERM to this process, not to the stage.
    const script = "console.log('started the slow tests'); setTimeout(() => {}, 20000);\n";
    const root = createProject({ gate: "node quiet-pass.mjs && node slow.mjs && node quiet-pass.mjs" }, { "quiet-pass.mjs": "", "slow.mjs": script });
    const child = spawn(process.execPath, [RUNNER, "gate", "--root", root], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");

      if (stdout.includes("ok    node quiet-pass.mjs")) {
        // The slow stage is running once its line is in the log.
        const waiting = setInterval(() => {
          if (readFileSync(join(root, LOG_FILE), "utf8").includes("started the slow tests")) {
            clearInterval(waiting);
            child.kill("SIGTERM");
            // A runner that does not pass the signal on would wait for the stage. It is ended here, and the test fails on its status.
            setTimeout(() => child.kill("SIGKILL"), 5000).unref();
          }
        }, 20);
      }
    });

    const status = await new Promise((exited) => child.on("close", exited));

    expect(stdout).toContain("FAIL  node slow.mjs (stopped by SIGTERM, ");
    expect(stdout).toContain("started the slow tests\n");
    expect(stdout).toContain("not run:\n      node quiet-pass.mjs\n");
    expect(status).toBe(143);
  }, 30_000);

  it("exits 2 and says why when the script is not in package.json", () => {
    const { status, stderr } = runCommand(createProject({}), "gate:full");

    expect(stderr).toContain('the quiet gate could not run: package.json has no "gate:full" script');
    expect(status).toBe(2);
  });

  it("exits 2 with the usage when no script is named", () => {
    const { status, stderr } = spawnSync(process.execPath, [RUNNER], { encoding: "utf8" });

    expect(stderr).toContain("the quiet gate could not run: usage:");
    expect(status).toBe(2);
  });
});

describe("the quiet gate and pnpm", () => {
  // The claim the stop hook and a person rely on: quiet changes what is
  // printed, never the verdict.
  it.each([
    ["a green gate", "node -e 0", 0],
    ["a stage that exits 1", "node -e \"process.exit(1)\"", 1],
    ["a stage that exits 3, inside a chain the gate runs", "node -e \"process.exit(3)\"", 3],
  ])("give the same exit code for %s", (_case, check, expected) => {
    const root = createProject({ check, "gate:fast": "node -e 0 && pnpm check", "gate:full": "pnpm gate:fast && node -e 0" });
    const loud = spawnSync("pnpm", ["run", "gate:full"], { cwd: root, encoding: "utf8" });

    expect(loud.status).toBe(expected);
    expect(runCommand(root, "gate:full").status).toBe(expected);
  }, 60_000);
});

function pass(output: string): StageRun {
  return { status: 0, output };
}

function fail(status: number, output: string): StageRun {
  return { status, output };
}

/** A runner that answers each command from the table, and takes one second by the fake clock. */
function createStages(table: Record<string, StageRun>, ran: string[] = []): RunStage {
  return (command) => {
    ran.push(command);

    return Promise.resolve(table[command] as StageRun);
  };
}

/** Runs a gate whose stages are the table's keys, on a clock that moves one second per stage. */
async function runWith(table: Record<string, StageRun>, ran: string[] = []): Promise<{ status: number; printed: string }> {
  const written: string[] = [];
  let clock = 0;
  const status = await runQuiet({
    root: createProject({ gate: Object.keys(table).join(" && ") }),
    script: "gate",
    write: (text) => written.push(text),
    runStage: (command, root, onOutput) => {
      clock += 1000;

      return createStages(table, ran)(command, root, onOutput);
    },
    now: () => clock,
  });

  return { status, printed: written.join("") };
}

/** A folder with a package.json holding `scripts`, and the files given. */
function createProject(scripts: Record<string, string>, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quiet-gate-")));

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", private: true, scripts }));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}

function runCommand(root: string, script: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [RUNNER, script, "--root", root], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
