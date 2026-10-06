import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isPlainPath } from "./lib/files.mts";
import {
  createProgramFinder,
  createShellRunner,
  createStopper,
  LIMITS,
  LOG_FILE,
  planStages,
  QuietError,
  type RunnerLimits,
  runQuiet,
  type RunStage,
  scriptRunBy,
  skipLines,
  splitChain,
  splitStages,
  type StageRun,
  type Stopper,
} from "./quiet.mts";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "quiet.mts");

describe("the stages of a gate script", () => {
  it("are the parts of its && chain, in order", () => {
    expect(commandsOf({ "gate:fast": "pnpm gates && pnpm lint && pnpm typecheck" }, "gate:fast")).toEqual([
      "pnpm gates",
      "pnpm lint",
      "pnpm typecheck",
    ]);
  });

  it("open up a part that runs another chain of the project, so gate:full shows gate:fast's stages", () => {
    const scripts = { "gate:fast": "pnpm gates && pnpm lint", "gate:full": "pnpm gate:fast && pnpm test && pnpm run build", build: "turbo run build" };

    expect(commandsOf(scripts, "gate:full")).toEqual(["pnpm gates", "pnpm lint", "pnpm test", "pnpm run build"]);
  });

  it("include what an add-on joined to either gate, where the add-on put it", () => {
    const scripts = {
      "gate:fast": "pnpm gates && pnpm lint && pnpm biome:check && pnpm perf:check",
      "gate:full": "pnpm gate:fast && pnpm test && pnpm build && pnpm coverage",
    };

    expect(commandsOf(scripts, "gate:full")).toEqual([
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
    expect(commandsOf({ gate: "pnpm run test && pnpm run lint", test: "vitest run", lint: "eslint ." }, "gate")).toEqual(["pnpm run test", "pnpm run lint"]);
  });

  // pnpm runs its own command for a name it knows, whatever the project's
  // scripts say. Measured on pnpm 12.6: root, bin, list, exec, why, store,
  // env and config all win over a script of that name.
  it.each([["audit"], ["install"], ["exec"], ["store"], ["root"], ["typecheck"]])(
    "leave pnpm %s whole, since a bare word may be a command of pnpm and not the script",
    (name) => {
      expect(commandsOf({ gate: `pnpm ${name} && pnpm lint`, [name]: "node a.mjs && node b.mjs" }, "gate")).toEqual([`pnpm ${name}`, "pnpm lint"]);
    },
  );

  it("open the same script up when it is run by name, which pnpm cannot read as a command of its own", () => {
    expect(commandsOf({ gate: "pnpm run audit && pnpm lint", audit: "node a.mjs && node b.mjs" }, "gate")).toEqual(["node a.mjs", "node b.mjs", "pnpm lint"]);
  });

  it.each([
    ["pnpm run check:all --if-present"],
    ["pnpm run --if-present check:all"],
    ["pnpm run check:all -- --fix"],
    ["pnpm --filter web run check:all"],
    ["pnpm -r run check:all"],
    ["pnpm check:all --fix"],
    ["npm run check:all"],
    ["yarn check:all"],
    ["yarn run check:all"],
  ])("leave %s whole: a flag, an argument or another package manager changes what runs", (command) => {
    expect(commandsOf({ gate: `${command} && pnpm lint`, "check:all": "node a.mjs && node b.mjs" }, "gate")).toEqual([command, "pnpm lint"]);
  });

  it("leave a part whole when pnpm would run a pre or post script around it", () => {
    const chain = { "gate:fast": "node a.mjs && node b.mjs", "gate:full": "pnpm gate:fast && pnpm test" };

    expect(commandsOf({ ...chain, "pregate:fast": "node before.mjs" }, "gate:full")).toEqual(["pnpm run gate:fast", "pnpm test"]);
    expect(commandsOf({ ...chain, "postgate:fast": "node after.mjs" }, "gate:full")).toEqual(["pnpm run gate:fast", "pnpm test"]);
  });

  it("hand the whole gate to pnpm when the gate itself has a pre or post script", () => {
    const scripts = { "gate:full": "node a.mjs && node b.mjs", "postgate:full": "node after.mjs" };

    expect(commandsOf(scripts, "gate:full")).toEqual(["pnpm run gate:full"]);
  });

  it("say which script each stage is a line of, and say none for a stage pnpm is left to run", () => {
    const scripts = { "gate:fast": "node a.mjs && pnpm lint", "gate:full": "pnpm gate:fast && node c.mjs", "pregate:x": "true", "gate:x": "a && b" };

    expect(planStages(scripts, "gate:full")).toEqual([
      { command: "node a.mjs", script: "gate:fast" },
      { command: "pnpm lint", script: "gate:fast" },
      { command: "node c.mjs", script: "gate:full" },
    ]);
    expect(planStages(scripts, "gate:x")).toEqual([{ command: "pnpm run gate:x" }]);
  });

  it("refuse a script the project does not have", () => {
    expect(() => planStages({}, "gate:full")).toThrow(QuietError);
    expect(() => planStages({}, "gate:full")).toThrow('package.json has no "gate:full" script');
  });

  it("refuse a chain that runs itself", () => {
    const scripts = { "a:1": "pnpm b:1 && pnpm lint", "b:1": "pnpm a:1 && pnpm test" };

    expect(() => planStages(scripts, "a:1")).toThrow('the script "a:1" runs itself: a:1 → b:1 → a:1');
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

// Each stage runs in a shell of its own. So a chain is split only when no part
// can change the shell for the parts after it: every part starts with a
// program the shell finds as a file. The shell is asked; nothing here lists
// what it would run itself.
describe("splitting a chain into stages that each get a shell of their own", () => {
  const isProgram = createProgramFinder(process.cwd());
  const whole = (script: string): void => {
    expect(splitStages(script, isProgram)).toEqual([script]);
  };

  it("splits a chain whose every part starts with a program on the PATH", () => {
    expect(splitStages("pnpm gates && node tools/check.mts && pnpm test", isProgram)).toEqual(["pnpm gates", "node tools/check.mts", "pnpm test"]);
  });

  it("splits when a variable is set in front of a part, since that reaches the one command and no further", () => {
    expect(splitStages("CI=1 pnpm test && NODE_ENV=production FORCE_COLOR=0 node build.mjs", isProgram)).toEqual(["CI=1 pnpm test", "NODE_ENV=production FORCE_COLOR=0 node build.mjs"]);
  });

  it.each([
    ["changes folder", "cd packages && node check.mjs"],
    ["sets a variable for what follows", "MODE=strict && node check.mjs"],
    ["sets two", "A=1 B=2 && node check.mjs"],
    ["exports one", "export STRICT=1 && node check.mjs"],
    ["turns on a shell option", "set -e && node check.mjs"],
    ["reads a file into the shell", ". ./env.sh && node check.mjs"],
    ["does the same by its other name", "source ./env.sh && node check.mjs"],
    ["evaluates text", "eval X=1 && node check.mjs"],
    ["replaces the shell", "exec node a.mjs && node check.mjs"],
    ["takes a variable away", "unset CI && node check.mjs"],
    ["changes the file mask", "umask 077 && node check.mjs"],
    ["sets a trap", "trap '' TERM && node check.mjs"],
    ["defines an alias", "alias n=node && node check.mjs"],
    ["starts with a test the shell does itself", "test -d packages && node check.mjs"],
    ["starts with the other spelling of that test", "[ -d packages ] && node check.mjs"],
    ["starts with true", "true && node check.mjs"],
    ["starts with echo", "echo start && node check.mjs"],
    ["negates a part", "! node a.mjs && node check.mjs"],
    ["groups in braces", "{ node a.mjs && node check.mjs }"],
    ["starts with a quoted word", '"node" a.mjs && node check.mjs'],
    ["starts with a variable", "$RUNNER a.mjs && node check.mjs"],
    ["sets a variable to quoted text in front", 'NAME="a b" node a.mjs && node check.mjs'],
    ["sets a variable from another in front", "NAME=$OTHER node a.mjs && node check.mjs"],
    ["starts with a word that is no program at all", "no-such-program-anywhere a && node check.mjs"],
    ["has the unknown word last", "node check.mjs && no-such-program-anywhere"],
    ["has it in the middle", "node a.mjs && cd packages && node check.mjs"],
  ])("leaves whole a chain with a part that %s", (_name, script) => {
    whole(script);
  });

  it.each([
    ["the last exit code", "node a.mjs && node exit.mjs $?"],
    ["the last argument", "node a.mjs 7 && node exit.mjs $_"],
    ["the last background job", "node a.mjs && node wait.mjs $!"],
    ["the shell's own process", "node a.mjs && node kill.mjs $$"],
    ["an argument of the script", "node a.mjs && node b.mjs $1"],
    ["an expansion in braces, which may assign", "node a.mjs ${MODE:=strict} && node b.mjs"],
  ])("leaves whole a chain that reads %s", (_name, script) => {
    whole(script);
  });

  it("still splits a chain that only reads variables by name", () => {
    expect(splitStages("node a.mjs $HOME && node b.mjs $_private_name", isProgram)).toEqual(["node a.mjs $HOME", "node b.mjs $_private_name"]);
  });

  it("leaves a script that is not a chain as it is, whatever it starts with", () => {
    expect(splitStages("cd packages", isProgram)).toEqual(["cd packages"]);
    expect(splitStages("node a.mjs || true", isProgram)).toEqual(["node a.mjs || true"]);
  });

  it("asks the shell: a word is a program only when the shell finds it as a file", () => {
    expect(isProgram("node")).toBe(true);
    expect(isProgram("pnpm")).toBe(true);
    expect(isProgram("/bin/sh")).toBe(true);

    for (const word of ["cd", "export", "set", ".", "eval", "exec", "unset", "true", "echo", "test", "[", "!", "{", "if", "no-such-program-anywhere", "./no-such-file.sh", ""]) {
      expect(isProgram(word), word).toBe(false);
    }
  });

  it("finds a program the project installed, and a script named by its path", () => {
    const root = createProject({}, { "node_modules/.bin/installed-tool": "#!/bin/sh\n", "scripts/run.sh": "#!/bin/sh\n", "scripts/not-executable.sh": "#!/bin/sh\n" });

    chmodSync(join(root, "node_modules/.bin/installed-tool"), 0o755);
    chmodSync(join(root, "scripts/run.sh"), 0o755);

    const inProject = createProgramFinder(root);

    expect(inProject("installed-tool")).toBe(true);
    expect(inProject("./scripts/run.sh")).toBe(true);
    expect(inProject("scripts/run.sh")).toBe(true);
    expect(inProject(join(root, "scripts/run.sh"))).toBe(true);
    expect(isProgram("installed-tool")).toBe(false);
  });

  // The shell is not asked about a path. bash and zsh say it back only for a
  // file they can run; dash says it back for anything that exists.
  it("reads a path the same under every shell: a file that cannot be run, a folder and a path to nothing are no program", () => {
    const root = createProject({}, { "scripts/run.sh": "#!/bin/sh\n", "scripts/not-executable.sh": "#!/bin/sh\n" });

    chmodSync(join(root, "scripts/run.sh"), 0o755);

    const inProject = createProgramFinder(root);

    expect(inProject("./scripts/not-executable.sh")).toBe(false);
    expect(inProject("./scripts")).toBe(false);
    expect(inProject("./scripts/")).toBe(false);
    expect(inProject("./scripts/none.sh")).toBe(false);
    expect(inProject("./scripts/run.sh")).toBe(true);
  });

  it("does not take a file named after a thing the shell does itself for a program: the shell would not run the file", () => {
    const root = createProject({}, { "node_modules/.bin/cd": "#!/bin/sh\n", "node_modules/.bin/export": "#!/bin/sh\n" });

    chmodSync(join(root, "node_modules/.bin/cd"), 0o755);
    chmodSync(join(root, "node_modules/.bin/export"), 0o755);

    expect(createProgramFinder(root)("cd")).toBe(false);
    expect(createProgramFinder(root)("export")).toBe(false);
  });

  it("plans a gate whose inner script cannot be split as one stage that pnpm runs, with its parts kept together", () => {
    const scripts = { check: "cd packages && node check.mjs", "gate:fast": "pnpm run check && node a.mjs", "gate:full": "export CI=1 && pnpm gate:fast" };

    expect(planStages(scripts, "gate:fast", isProgram)).toEqual([
      { command: "pnpm run check", script: "gate:fast" },
      { command: "node a.mjs", script: "gate:fast" },
    ]);
    expect(planStages(scripts, "gate:full", isProgram)).toEqual([{ command: "export CI=1 && pnpm gate:fast", script: "gate:full" }]);
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

describe("a line that says a check judged nothing", () => {
  it("is found when a tool indents it or colours it", () => {
    const escape = String.fromCharCode(27);

    expect(skipLines(`  SKIP indented — nothing to judge\n${escape}[33mSKIP${escape}[0m coloured — nothing to judge\n`)).toEqual([
      "SKIP indented — nothing to judge",
      "SKIP coloured — nothing to judge",
    ]);
  });
});

describe("a run that was told to stop", () => {
  it("is not a pass when the request comes as the last stage ends", async () => {
    const written: string[] = [];
    let ended = false;
    const status = await runQuiet({
      root: createProject({ gate: "pnpm lint" }),
      script: "gate",
      write: (text) => written.push(text),
      runStage: () => {
        ended = true;

        return Promise.resolve(pass(""));
      },
      isStopped: () => ended,
    });

    expect(written.join("")).toContain("STOP  after the last stage. gate was stopped, so this is not a pass.");
    expect(written.join("")).not.toContain("gate passed");
    expect(status).toBe(1);
  });
});

describe("stopping a real stage", () => {
  const quick: RunnerLimits = { ...LIMITS, graceMs: 400, abandonMs: 400, drainMs: 300 };

  it("ends a stage that ignores SIGTERM, by killing it after the grace period, and keeps what it printed", async () => {
    const ignores = "process.on('SIGTERM', () => console.log('told to stop, and going on')); console.log('started'); setInterval(() => {}, 1000);\n";
    const started = Date.now();
    const { status, printed } = await stopOnceStarted({ gate: "node ignores.mjs" }, { "ignores.mjs": ignores }, quick);

    expect(printed).toContain("FAIL  node ignores.mjs (stopped by SIGTERM, ");
    expect(printed).toContain("started\ntold to stop, and going on\n");
    expect(status).toBe(143);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("ends, though something the stage started is beyond its reach and holds its output open", async () => {
    const started = Date.now();
    const { status, printed } = await stopOnceStarted({ gate: "node parent.mjs" }, { "parent.mjs": PARENT_OF_A_HOLDER, "holder.mjs": HOLDER }, quick);

    expect(printed).toContain("FAIL  node parent.mjs (stopped by SIGTERM");
    expect(printed).toContain("started\n");
    expect(status).toBe(143);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("does not wait for what a stage left running once the stage itself has exited, as pnpm does not", async () => {
    const leaves = PARENT_OF_A_HOLDER.replace("setInterval(() => {}, 1000);", "process.exit(0);");
    const root = createProject({ gate: "node parent.mjs" }, { "parent.mjs": leaves, "holder.mjs": HOLDER });
    const written: string[] = [];
    const started = Date.now();
    const status = await runQuiet({ root, script: "gate", write: (text) => written.push(text), runStage: createShellRunner(createStopper(), quick) });

    expect(written.join("")).toContain("ok    node parent.mjs");
    expect(status).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 20_000);

  it("ends at once on a second request, without waiting out the grace period", async () => {
    const patient: RunnerLimits = { ...LIMITS, graceMs: 60_000, abandonMs: 60_000 };
    const ignores = "process.on('SIGTERM', () => {}); console.log('started'); setInterval(() => {}, 1000);\n";
    const started = Date.now();
    const { status, printed } = await stopOnceStarted({ gate: "node ignores.mjs" }, { "ignores.mjs": ignores }, patient, 2);

    expect(printed).toContain("FAIL  node ignores.mjs (stopped by SIGTERM");
    expect(status).toBe(143);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);

  it("stops a stage that begins after the request, so none runs unheard", async () => {
    const stopper = createStopper();

    stopper.request("SIGINT");

    const run = await createShellRunner(stopper, quick)({ command: "node -e \"setInterval(() => {}, 1000)\"", env: {} }, createProject({}), () => undefined);

    expect(run).toEqual({ status: 130, output: "", ended: "stopped by SIGINT" });
  }, 20_000);
});

describe("what is kept of a stage's output", () => {
  const small: RunnerLimits = { ...LIMITS, keptCharacters: 2000 };
  const noisy = "console.log('SKIP early-check — nothing to judge');\nfor (let line = 0; line < 500; line += 1) console.log('line', line, 'of the output');\n";

  it("is bounded in memory: a failure shows the end, and says where the start is", async () => {
    const root = createProject({ gate: "node noisy.mjs" }, { "noisy.mjs": `${noisy}process.exitCode = 1;\n` });
    const written: string[] = [];

    await runQuiet({ root, script: "gate", write: (text) => written.push(text), runStage: createShellRunner(createStopper(), small) });

    expect(written.join("")).toMatch(/\(the first \d+ characters are not shown\. They are in node_modules\/\.cache\/arch\/last-gate\.log\)\n/);
    expect(written.join("")).toContain("line 499 of the output\n");
    expect(written.join("")).not.toContain("line 0 of the output\n");
    expect(readFileSync(join(root, LOG_FILE), "utf8")).toContain("line 0 of the output\n");
  });

  it("still shows a SKIP line from the part that is no longer kept", async () => {
    const root = createProject({ gate: "node noisy.mjs" }, { "noisy.mjs": noisy });
    const written: string[] = [];

    await runQuiet({ root, script: "gate", write: (text) => written.push(text), runStage: createShellRunner(createStopper(), small) });

    expect(written.join("")).toContain("      SKIP early-check — nothing to judge\n");
  });
});

describe("the log", () => {
  it("is not written through a link: the file the link points at is left as it was, and the run goes on", () => {
    const root = createProject({ gate: "node -e \"console.log('secret-free output')\"" });
    const outside = join(createProject({}), "important.txt");

    writeFileSync(outside, "must not be overwritten\n");
    mkdirSync(dirname(join(root, LOG_FILE)), { recursive: true });
    symlinkSync(outside, join(root, LOG_FILE));

    expect(runCommand(root, "gate").status).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("must not be overwritten\n");
  });

  it("is refused by the check itself, for a link at the file and for a link at a folder above it", () => {
    const root = createProject({});
    const outside = createProject({});

    mkdirSync(join(root, "plain", "deep"), { recursive: true });
    symlinkSync(join(outside, "package.json"), join(root, "plain", "deep", "file.log"));
    symlinkSync(outside, join(root, "linked"));

    expect(isPlainPath(root, "plain/deep/new.log")).toBe(true);
    expect(isPlainPath(root, "plain/deep/file.log")).toBe(false);
    expect(isPlainPath(root, "linked/deep/new.log")).toBe(false);
    expect(isPlainPath(root, "package.json/under-a-file.log")).toBe(false);
  });

  it("is not written under a folder that is a link out of the project", () => {
    const root = createProject({ gate: "node -e 0" });
    const outside = createProject({});

    mkdirSync(join(root, "node_modules"));
    symlinkSync(outside, join(root, "node_modules", ".cache"));

    expect(runCommand(root, "gate").status).toBe(0);
    expect(existsSync(join(outside, "arch"))).toBe(false);
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

  it("ends within its grace period when the stage ignores the signal and leaves something holding its output", async () => {
    const stubborn = PARENT_OF_A_HOLDER.replace("console.log('started');", "process.on('SIGTERM', () => {}); console.log('started');");
    const root = createProject({ gate: "node parent.mjs" }, { "parent.mjs": stubborn, "holder.mjs": HOLDER });
    const started = Date.now();
    const { status, stdout } = await signalOnceStarted(root, ["SIGTERM"]);

    expect(stdout).toContain("FAIL  node parent.mjs (stopped by SIGTERM");
    expect(stdout).toContain("started\n");
    expect(status).toBe(143);
    expect(Date.now() - started).toBeLessThan(LIMITS.graceMs + LIMITS.abandonMs + 3000);
  }, 30_000);

  it("ends at once when it is signalled a second time", async () => {
    const root = createProject({ gate: "node stubborn.mjs" }, { "stubborn.mjs": "process.on('SIGTERM', () => {}); console.log('started'); setInterval(() => {}, 1000);\n" });
    const started = Date.now();
    const { status, stdout } = await signalOnceStarted(root, ["SIGTERM", "SIGTERM"]);

    expect(stdout).toContain("FAIL  node stubborn.mjs (stopped by SIGTERM");
    expect(status).toBe(143);
    expect(Date.now() - started).toBeLessThan(LIMITS.graceMs - 1000);
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

describe("which script a command runs", () => {
  it("is known for pnpm run with a name, and for pnpm with a name that holds a colon", () => {
    expect(scriptRunBy("pnpm run audit")).toBe("audit");
    expect(scriptRunBy("pnpm gate:fast")).toBe("gate:fast");
    expect(scriptRunBy("pnpm  run   lint:types")).toBe("lint:types");
  });

  it("is not known for a bare word, which pnpm may read as a command of its own", () => {
    expect(scriptRunBy("pnpm audit")).toBeUndefined();
    expect(scriptRunBy("pnpm test")).toBeUndefined();
  });
});

// What pnpm really runs for each gate below is recorded, then what the quiet
// plan runs. Every leaf writes its name and the environment pnpm gives a
// script. The two records must be the same, line for line.
describe("the quiet plan, run in order, against what pnpm runs", () => {
  const leaf = (name: string): string => `node record.mjs ${name}`;

  it.each([
    ["a plain chain", { gate: `${leaf("a")} && ${leaf("b")}` }],
    ["a chain inside a chain", { "gate:fast": `${leaf("a")} && ${leaf("b")}`, gate: `pnpm gate:fast && ${leaf("c")}` }],
    ["a chain run by name", { inner: `${leaf("a")} && ${leaf("b")}`, gate: `pnpm run inner && ${leaf("c")}` }],
    ["a script named after a command of pnpm", { root: `${leaf("a")} && ${leaf("b")}`, gate: `pnpm root && ${leaf("c")}` }],
    ["that same script run by name", { root: `${leaf("a")} && ${leaf("b")}`, gate: `pnpm run root && ${leaf("c")}` }],
    ["a chain with a pre and a post script", { "pregate:fast": leaf("before"), "gate:fast": `${leaf("a")} && ${leaf("b")}`, "postgate:fast": leaf("after"), gate: `pnpm gate:fast && ${leaf("c")}` }],
    ["a gate with a pre and a post script of its own", { pregate: leaf("before"), gate: `${leaf("a")} && ${leaf("b")}`, postgate: leaf("after") }],
    ["a script run only if it is there", { "check:all": `${leaf("a")} && ${leaf("b")}`, gate: `pnpm run --if-present check:all && pnpm run --if-present check:none && ${leaf("c")}` }],
    // pnpm 12.6 hands a flag after the name to the script: the last leaf is run with it.
    ["a script given an argument", { "check:all": `${leaf("a")} && ${leaf("b")}`, gate: `pnpm run check:all --if-present && ${leaf("c")}` }],
    ["a leaf script, which pnpm names for itself", { lint: leaf("lint"), "gate:fast": `pnpm lint && ${leaf("a")}`, gate: `pnpm gate:fast && pnpm run lint` }],
  ])("is the same for %s", (_case, scripts) => {
    const loud = recordRun(scripts, (root) => spawnSync("pnpm", ["run", "gate"], { cwd: root, encoding: "utf8" }));
    const quiet = recordRun(scripts, (root) => runCommand(root, "gate"));

    expect(loud.status).toBe(0);
    expect(quiet.status).toBe(0);
    expect(loud.record.length).toBeGreaterThan(0);
    expect(quiet.record).toEqual(loud.record);
  }, 60_000);
});

// The same claim, for scripts whose parts depend on one another through the
// shell. Each is run for real, by pnpm and by the quiet runner. The quiet
// runner once split every one of these and ran each part in a fresh shell:
// the first three then exited 0 where pnpm exits 1, and the stop hook
// remembered a red tree as green.
describe("the quiet gate and pnpm, for a script whose parts share a shell", () => {
  /** Whether `/bin/sh`, which runs a script for pnpm and for the quiet runner, keeps the last argument in `$_`. */
  const SHELL_KEEPS_LAST_ARGUMENT = spawnSync("/bin/sh", ["-c", ': 7 && echo "$_"'], { encoding: "utf8" }).stdout.trim() === "7";

  const exitWith = (code: string): string => `node exit.mjs ${code}`;
  const files = {
    "check.mjs": "process.exit(0);\n",
    "sub/check.mjs": "process.exit(1);\n",
    "exit.mjs": "process.exit(Number(process.argv[2] ?? 0));\n",
    "env.mjs": "process.exit(process.env[process.argv[2]] === process.argv[3] ? Number(process.argv[4]) : 0);\n",
    "env.sh": "FROM_FILE=yes\nexport FROM_FILE\n",
  };

  it.each([
    ["changes folder, and the check that fails is in that folder", { gate: "cd sub && node check.mjs" }, 1],
    // Not `MODE`: the test runner sets that one, and a stage would inherit it.
    ["sets a variable the next part tests", { gate: 'GATE_MODE=strict && test -z "$GATE_MODE"' }, 1],
    ["sets a variable the next part hands to a program", { gate: "GATE_CODE=3 && node exit.mjs $GATE_CODE" }, 3],
    ["exports a variable the next part reads", { gate: "export STRICT=1 && node env.mjs STRICT 1 1" }, 1],
    ["reads a file of variables into the shell", { gate: ". ./env.sh && node env.mjs FROM_FILE yes 6" }, 6],
    ["evaluates an assignment", { gate: 'eval X=1 && test "$X" != 1' }, 1],
    ["takes away a variable pnpm set", { gate: "unset npm_lifecycle_event && node env.mjs npm_lifecycle_event gate 8" }, 0],
    ["replaces the shell, so nothing after it runs", { gate: `exec ${exitWith("0")} && ${exitWith("9")}` }, 0],
    // `$_` is the last argument in bash and zsh. dash and ksh do not set it, and `exit.mjs` is then given whatever it held before.
    ["passes the last argument on", { gate: `${exitWith("0")} 7 && node exit.mjs $_` }, SHELL_KEEPS_LAST_ARGUMENT ? 7 : undefined],
    ["turns on exit-on-error first", { gate: `set -e && ${exitWith("0")} && ${exitWith("4")}` }, 4],
    ["ends in || true", { gate: `${exitWith("5")} && ${exitWith("0")} || true` }, 0],
    ["negates its first part", { gate: `! ${exitWith("0")} && ${exitWith("9")}` }, 1],
    ["negates a failing part and goes on", { gate: `! ${exitWith("3")} && ${exitWith("2")}` }, 2],
    ["groups its parts in braces", { gate: `{ ${exitWith("0")} && ${exitWith("4")}; }` }, 4],
    ["defines a function and calls it", { gate: "f() { return 3; } && f" }, 3],
    ["sets a variable in front of one part only", { gate: "MODE=x node env.mjs MODE x 0 && node env.mjs MODE x 6" }, 0],
    ["sets a variable in front of the part that fails on it", { gate: "node env.mjs MODE x 6 && MODE=x node env.mjs MODE x 6" }, 6],
    ["changes folder inside a script the gate runs", { inner: "cd sub && node check.mjs", gate: `pnpm run inner && ${exitWith("0")}` }, 1],
    ["changes folder inside a script the gate runs by its name with a colon", { "in:ner": "cd sub && node check.mjs", gate: `${exitWith("0")} && pnpm in:ner` }, 1],
    ["exports a variable, then runs a chain that reads it", { "in:ner": `${exitWith("0")} && node env.mjs STRICT 1 5`, gate: "export STRICT=1 && pnpm in:ner" }, 5],
    ["is a plain chain of programs that passes", { gate: `${exitWith("0")} && node check.mjs` }, 0],
    ["is a plain chain of programs whose last part fails", { gate: `${exitWith("0")} && node check.mjs && ${exitWith("3")}` }, 3],
  ])("give the same exit code when the gate %s", (_case, scripts, expected) => {
    const root = createProject(scripts, files);
    const loud = spawnSync("pnpm", ["run", "gate"], { cwd: root, encoding: "utf8" });
    const quiet = runCommand(root, "gate");

    // What pnpm does is the fact; the number beside each case only shows that the case is the one it is named for.
    // It is left out where the shell decides it: the two runs are then only compared with each other.
    if (expected !== undefined) {
      expect(loud.status, loud.stderr).toBe(expected);
    }

    expect(loud.status).not.toBeNull();
    expect(quiet.status, quiet.stdout).toBe(loud.status);
  }, 60_000);
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

/** Starts a process in a session of its own, which a signal to the stage's group does not reach, with the stage's output still open. */
const PARENT_OF_A_HOLDER = [
  "import { spawn } from 'node:child_process';",
  "spawn(process.execPath, ['holder.mjs'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();",
  "console.log('started');",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

/** Lives a few seconds, ignoring SIGTERM, so a test that leaves it behind does not leave it for long. */
const HOLDER = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 8000);\n";

/** Runs the command, and sends it each signal in turn once its stage has printed `started`. */
async function signalOnceStarted(root: string, signals: NodeJS.Signals[]): Promise<{ status: unknown; stdout: string }> {
  const child = spawn(process.execPath, [RUNNER, "gate", "--root", root], { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  const watching = setInterval(() => {
    if (existsSync(join(root, LOG_FILE)) && readFileSync(join(root, LOG_FILE), "utf8").includes("started")) {
      clearInterval(watching);
      signals.forEach((signal, index) => setTimeout(() => child.kill(signal), index * 300));
      // A runner that waits on its stage for ever is ended here, and the test fails on its status.
      setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
    }
  }, 20);

  const status = await new Promise((exited) => child.on("exit", exited));

  clearInterval(watching);

  return { status, stdout };
}

/** Runs a real gate, and asks it to stop, `times` times, once its stage has printed `started`. */
async function stopOnceStarted(
  scripts: Record<string, string>,
  files: Record<string, string>,
  limits: RunnerLimits,
  times = 1,
): Promise<{ status: number; printed: string }> {
  const stopper: Stopper = createStopper();
  const runStage = createShellRunner(stopper, limits);
  const written: string[] = [];
  const status = await runQuiet({
    root: createProject(scripts, files),
    script: "gate",
    write: (text) => written.push(text),
    runStage: (stage, root, onOutput) =>
      runStage(stage, root, (chunk) => {
        onOutput(chunk);

        if (chunk.includes("started")) {
          for (let request = 0; request < times; request += 1) {
            stopper.request("SIGTERM");
          }
        }
      }),
    isStopped: () => stopper.signal !== undefined,
  });

  // What the command does with the answer: a run that was told to stop exits with the signal's code.
  return { status: stopper.signal === undefined ? status : 143, printed: written.join("") };
}

/** Appends one line for each time it is run: its name, and what pnpm gives a script's line. */
const RECORDER = [
  "import { appendFileSync } from 'node:fs';",
  "const { env } = process;",
  "const first = env.PATH.split(':')[0];",
  "appendFileSync(env.RECORD, [process.argv.slice(2).join(' '), env.npm_lifecycle_event, env.npm_lifecycle_script, env.npm_package_name, env.npm_package_version, env.npm_package_json, env.INIT_CWD, env.PNPM_SCRIPT_SRC_DIR, env.NODE === env.npm_node_execpath, first].join(' | ') + '\\n');",
  "",
].join("\n");

function recordRun(scripts: Record<string, string>, run: (root: string) => { status: number | null }): { status: number | null; record: string[] } {
  const root = createProject(scripts, { "record.mjs": RECORDER });
  const record = join(root, "record.txt");
  const before = process.env.RECORD;

  process.env.RECORD = record;

  try {
    const { status } = run(root);

    // The two runs are in two folders; the folder is taken out so the records can be compared.
    return { status, record: existsSync(record) ? readFileSync(record, "utf8").split(root).join("<root>").trim().split("\n") : [] };
  } finally {
    if (before === undefined) {
      delete process.env.RECORD;
    } else {
      process.env.RECORD = before;
    }
  }
}

function pass(output: string): StageRun {
  return { status: 0, output };
}

function fail(status: number, output: string): StageRun {
  return { status, output };
}

/** A runner that answers each command from the table, and takes one second by the fake clock. */
function createStages(table: Record<string, StageRun>, ran: string[] = []): RunStage {
  return ({ command }) => {
    ran.push(command);

    return Promise.resolve(table[command] as StageRun);
  };
}

/** The plan, with every first word taken for a program: these tests are about which scripts are opened, and their commands are made up. */
function commandsOf(scripts: Record<string, string>, script: string): string[] {
  return planStages(scripts, script, () => true).map(({ command }) => command);
}

/** Runs a gate whose stages are the table's keys, on a clock that moves one second per stage. */
async function runWith(table: Record<string, StageRun>, ran: string[] = []): Promise<{ status: number; printed: string }> {
  const written: string[] = [];
  let clock = 0;
  const status = await runQuiet({
    root: createProject({ gate: Object.keys(table).join(" && ") }),
    script: "gate",
    write: (text) => written.push(text),
    runStage: (stage, root, onOutput) => {
      clock += 1000;

      return createStages(table, ran)(stage, root, onOutput);
    },
    now: () => clock,
  });

  return { status, printed: written.join("") };
}

/** A folder with a package.json holding `scripts`, and the files given. */
function createProject(scripts: Record<string, string>, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quiet-gate-")));

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", version: "1.2.3", private: true, scripts }));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}

function runCommand(root: string, script: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [RUNNER, script, "--root", root], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
