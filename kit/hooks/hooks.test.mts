import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { editedFilesOf, judgeEdit } from "./after-edit.mts";
import { findProject, type GateRun, judgeStop, runGate, type RunLimits } from "./before-stop.mts";

const here = dirname(fileURLToPath(import.meta.url));
const broken = join(here, "..", "gates", "fixtures", "broken");
const clean = join(here, "..", "gates", "fixtures", "clean");
const UI = "packages/client-react/src/ui/PriceList.tsx";

// The suite itself may run inside an agent session, which sets this.
beforeEach(() => {
  vi.stubEnv("CLAUDE_PROJECT_DIR", "");
});

describe("after an edit", () => {
  it("reads the written file from a Claude Code payload", () => {
    expect(editedFilesOf({ tool_name: "Edit", tool_input: { file_path: "/repo/a.tsx" } })).toEqual(["/repo/a.tsx"]);
  });

  it("reads every written file from a Codex patch, and skips deletions", () => {
    const patch = createPatch();

    expect(editedFilesOf({ tool_name: "apply_patch", tool_input: { command: patch } })).toEqual([
      "src/ui/New.tsx",
      "src/ui/Old.tsx",
    ]);
  });

  it("has nothing to judge for a tool that wrote no file", () => {
    expect(editedFilesOf({ tool_name: "Bash", tool_input: { command: "ls" } })).toEqual([]);
  });

  it("hands the findings back when the written file breaks a rule", async () => {
    const reason = await judgeEdit({ cwd: broken, tool_input: { file_path: join(broken, UI) } });

    expect(reason).toContain("breaks an architecture rule");
    expect(reason).toContain(`${UI}:9`);
    expect(reason).toContain("A timer in the UI");
  });

  it("says nothing when the written file is fine", async () => {
    expect(await judgeEdit({ cwd: clean, tool_input: { file_path: join(clean, UI) } })).toBeUndefined();
  });

  it("stays out of a project that has declared no layers", async () => {
    expect(await judgeEdit({ cwd: tmpdir(), tool_input: { file_path: join(tmpdir(), "a.tsx") } })).toBeUndefined();
  });

  it("still judges when the script is reached through a symlink", () => {
    const link = join(mkdtempSync(join(tmpdir(), "arch-link-")), "after-edit.mts");

    symlinkSync(join(here, "after-edit.mts"), link);

    const run = spawnSync(process.execPath, [link], {
      input: JSON.stringify({ cwd: broken, tool_input: { file_path: UI } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });

    expect(JSON.parse(run.stdout).decision).toBe("block");
  });

  it("replies in the shape both hosts read, when run as a command", () => {
    const run = spawnSync(process.execPath, [join(here, "after-edit.mts")], {
      input: JSON.stringify({ cwd: broken, tool_input: { file_path: UI } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });
    const reply = JSON.parse(run.stdout);

    expect(run.status).toBe(0);
    expect(reply.decision).toBe("block");
    expect(reply.reason).toContain("dumb-ui");
  });
});

describe("before the agent stops", () => {
  const red = () => ({ status: 1, output: "FAIL dumb-ui (1)\n  src/ui/A.tsx:3" });
  const green = () => ({ status: 0, output: "all gates passed." });

  it("sends a red gate back as the next instruction", async () => {
    const reason = await judgeStop({ cwd: createProject({ "gate:fast": "false" }) }, red);

    expect(reason).toContain("`gate:fast` is red");
    expect(reason).toContain("src/ui/A.tsx:3");
  });

  it("lets the agent finish on a green gate", async () => {
    expect(await judgeStop({ cwd: createProject({ "gate:fast": "true" }) }, green)).toBeUndefined();
  });

  it("lets the agent finish the second time, so a gate it cannot fix does not loop", async () => {
    expect(await judgeStop({ cwd: createProject({ "gate:fast": "false" }), stop_hook_active: true }, red)).toBeUndefined();
  });

  it("holds the agent to the full gate, the one CI runs, when the project has one", async () => {
    const asked: string[] = [];
    const reason = await judgeStop({ cwd: createProject({ "gate:fast": "true", "gate:full": "false" }) }, (_root, script) => {
      asked.push(script);

      return red();
    });

    expect(asked).toEqual(["gate:full"]);
    expect(reason).toContain("`gate:full` is red");
  });

  it("runs the project's own script and reads its exit code", async () => {
    expect(await judgeStop({ cwd: createProject({ "gate:full": "node -e \"process.exit(0)\"" }) })).toBeUndefined();

    const reason = await judgeStop({
      cwd: createProject({ "gate:full": "node -e \"console.log('FAIL dumb-ui (1)'); process.exit(1)\"" }),
    });

    expect(reason).toContain("`gate:full` is red");
    expect(reason).toContain("FAIL dumb-ui (1)");
  });

  it("sends back the stage that failed and nothing a stage that passed printed", async () => {
    const reason = await judgeStop({
      cwd: createProject({
        lint: "node -e \"console.log('4812 files linted')\"",
        test: "node -e \"console.log('expected 3 to be 4'); process.exit(1)\"",
        build: "node -e \"console.log('built')\"",
        typecheck: "node -e 0",
        "gate:fast": "pnpm lint && pnpm typecheck",
        "gate:full": "pnpm gate:fast && pnpm test && pnpm build",
      }),
    });

    expect(reason).toContain("`gate:full` is red");
    expect(reason).toContain("ok    pnpm lint");
    expect(reason).toContain("FAIL  pnpm test (exit 1");
    expect(reason).toContain("expected 3 to be 4");
    expect(reason).not.toContain("4812 files linted");
    expect(reason).toContain("not run:\n      pnpm build");
  });

  it("stays out of a project that has no gate", async () => {
    const gate = createCountedGate(red);
    const reason = await judgeStop({ cwd: createProject({ test: "vitest" }) }, gate.run);

    expect(reason).toBeUndefined();
    expect(gate.runs()).toBe(0);
  });

  it("says a gate that did not finish verified nothing, and does not let the agent finish on it", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(() => ({ status: 1, output: "", timedOut: true }));

    expect(await judgeStop({ cwd: project }, gate.run)).toContain("did not finish");
    expect(await judgeStop({ cwd: project }, gate.run)).toContain("did not finish");
    expect(gate.runs()).toBe(2);
  });
});

// A hook the host has to kill blocks nothing. So in every one of these the
// hook itself must answer, in bounded time, that nothing was verified.
describe("a gate that does not finish", () => {
  const RECORD = "node_modules/.cache/arch/last-green-tree";

  it("is reported as not finished, with what its stage had printed, when the runner stops by itself", async () => {
    const project = createGitProject({ "gate:full": "node slow.mjs" });

    writeFileSync(join(project, "slow.mjs"), "console.log('started the slow tests'); setInterval(() => {}, 1000);\n");
    spawnSync("git", ["add", "slow.mjs"], { cwd: project });

    const reason = await judgeStop({ cwd: project }, (root, script) => runGate(root, script, { runMs: 1500, stopMs: 15_000, killMs: 2000 }));

    expect(reason).toContain("`gate:full` did not finish in time and was stopped, so nothing is verified. That is not a pass.");
    expect(reason).toContain("FAIL  node slow.mjs (stopped by SIGTERM");
    expect(reason).toContain("started the slow tests");
    expect(existsSync(join(project, RECORD))).toBe(false);
  }, 30_000);

  it("is reported as not finished when its stage ignores the request and has to be killed by the runner", async () => {
    const project = createProject({ "gate:full": "node stubborn.mjs" });

    writeFileSync(join(project, "stubborn.mjs"), "process.on('SIGTERM', () => console.log('not stopping')); console.log('started'); setInterval(() => {}, 1000);\n");

    const started = Date.now();
    const reason = await judgeStop({ cwd: project }, (root, script) => runGate(root, script, { runMs: 1500, stopMs: 15_000, killMs: 2000 }));

    expect(reason).toContain("did not finish in time");
    expect(reason).toContain("started\nnot stopping");
    // The runner's own grace period is five seconds; the hook did not have to kill it.
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 30_000);

  it("is reported as not finished when the runner itself ignores the request and has to be killed", async () => {
    const runner = createRunner("process.on('SIGTERM', () => {}); console.log('halfway'); setInterval(() => {}, 1000);\n");
    const run = await runGate(createProject({}), "gate:full", { runMs: 500, stopMs: 500, killMs: 5000 }, runner);

    expect(run).toEqual({ status: 1, output: "halfway\n", timedOut: true });
  }, 30_000);

  it("is reported as not finished when the runner cannot be waited for at all", async () => {
    // Killed, the runner leaves a process behind that holds its output open, so its output never closes.
    const holder = createRunner("process.on('SIGTERM', () => {}); setTimeout(() => {}, 8000);\n");
    const runner = createRunner(
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, [${JSON.stringify(holder)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();`,
        "process.on('SIGTERM', () => {}); console.log('halfway'); setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    const started = Date.now();
    const run = await runGate(createProject({}), "gate:full", { runMs: 500, stopMs: 500, killMs: 500 }, runner);

    expect(run).toEqual({ status: 1, output: "halfway\n\n(the gate did not end when it was killed, and was left behind)", timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it("is not a pass even when the runner, told to stop, exits 0", async () => {
    const runner = createRunner("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);\n");
    const project = createGitProject({ "gate:full": "true" });
    const limits: RunLimits = { runMs: 500, stopMs: 5000, killMs: 1000 };

    expect(await runGate(project, "gate:full", limits, runner)).toEqual({ status: 1, output: "", timedOut: true });
    expect(await judgeStop({ cwd: project }, (root, script) => runGate(root, script, limits, runner))).toContain("did not finish in time");
    expect(existsSync(join(project, RECORD))).toBe(false);
  }, 30_000);

  it("is red, not green, when the runner ends by a signal nobody here sent", async () => {
    const runner = createRunner("process.kill(process.pid, 'SIGKILL');\n");

    expect(await runGate(createProject({}), "gate:full", { runMs: 10_000, stopMs: 1000, killMs: 1000 }, runner)).toEqual({ status: 1, output: "", timedOut: false });
  });

  it("does not remember a tree as green on a stopped run that reports status 0", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(() => ({ status: 0, output: "", timedOut: true }));

    expect(await judgeStop({ cwd: project }, gate.run)).toContain("did not finish in time");
    expect(await judgeStop({ cwd: project }, gate.run)).toContain("did not finish in time");
    expect(gate.runs()).toBe(2);
    expect(existsSync(join(project, RECORD))).toBe(false);
  });

  it("never writes its record through a link out of the project", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const outside = join(createProject({}), "important.txt");

    writeFileSync(outside, "must not be overwritten\n");
    mkdirSync(join(project, "node_modules/.cache/arch"), { recursive: true });
    symlinkSync(outside, join(project, RECORD));

    expect(await judgeStop({ cwd: project }, () => ({ status: 0, output: "" }))).toBeUndefined();
    expect(readFileSync(outside, "utf8")).toBe("must not be overwritten\n");
  });

  it("ends by itself when run as a command, with the reply both hosts read", () => {
    const project = createProject({ "gate:full": "node -e \"console.log('expected 3 to be 4'); process.exit(1)\"" });
    const run = spawnSync(process.execPath, [join(here, "before-stop.mts")], { input: JSON.stringify({ cwd: project }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" }, timeout: 20_000 });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("expected 3 to be 4") });
  });
});

/** A script that stands in for the quiet runner. */
function createRunner(source: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "arch-runner-")), "runner.mjs");

  writeFileSync(file, source);

  return file;
}

describe("a tree that has already passed", () => {
  const green = () => ({ status: 0, output: "all gates passed." });

  it("is not judged a second time, so an agent that changed nothing does not wait", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    await judgeStop({ cwd: project }, gate.run);
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is judged again after a tracked file changes", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    await judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "src.ts"), "export const a = 2;\n");
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again after a new file appears, and after one is deleted", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    await judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "new.ts"), "export const b = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "src.ts"));
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(3);
  });

  it.each([".gitignore", "lib/.gitignore"])("is judged again after %s changes: a remembered green does not outlive a new rule", async (ignoreFile) => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    mkdirSync(join(project, "lib"), { recursive: true });
    writeFileSync(join(project, "lib/a.ts"), "export const a = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    appendFileSync(join(project, ignoreFile), "a.ts\n");
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again after a file changes that only .git/info/exclude names: a rule in no file of the tree hides nothing", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, ".git/info/exclude"), "hidden.ts\n");
    writeFileSync(join(project, "hidden.ts"), "export const h = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "hidden.ts"), "export const h = 2;\n");
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again after a file changes that only the person's global list names", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);
    const home = mkdtempSync(join(tmpdir(), "arch-hooks-home-"));

    writeFileSync(join(home, "ignore"), "hidden.ts\n");
    writeFileSync(join(home, "gitconfig"), `[core]\n\texcludesFile = ${join(home, "ignore")}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    writeFileSync(join(project, "hidden.ts"), "export const h = 1;\n");
    expect(spawnSync("git", ["check-ignore", "hidden.ts"], { cwd: project }).status).toBe(0);
    await judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "hidden.ts"), "export const h = 2;\n");
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again after a file is renamed with its content unchanged", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "draft.ts"), "export const d = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    renameSync(join(project, "draft.ts"), join(project, "moved.ts"));
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when an empty file is deleted, though no content changed", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "src.ts"), "");
    await judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "src.ts"));
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when a link is pointed somewhere else", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    symlinkSync("src.ts", join(project, "link.ts"));
    await judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "link.ts"));
    symlinkSync("package.json", join(project, "link.ts"));
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is not judged again when a file is only staged", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "added.ts"), "export const c = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    spawnSync("git", ["add", "added.ts"], { cwd: project });
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is judged again when an environment file changes, though git ignores it", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    mkdirSync(join(project, "packages", "web"), { recursive: true });
    writeFileSync(join(project, "packages", "web", ".env.local"), "API=http://localhost:4000\n");
    await judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "packages", "web", ".env.local"), "API=http://localhost:5000\n");
    await judgeStop({ cwd: project }, gate.run);
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again under another version of Node", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);
    const version = process.version;

    onTestFinished(() => {
      Object.defineProperty(process, "version", { value: version });
    });

    await judgeStop({ cwd: project }, gate.run);
    Object.defineProperty(process, "version", { value: "v99.0.0" });
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged every time when it holds a repository of its own, whose files git does not list", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    mkdirSync(join(project, "vendor"));
    spawnSync("git", ["init", "--quiet"], { cwd: join(project, "vendor") });
    writeFileSync(join(project, "vendor", "lib.ts"), "export const v = 1;\n");
    await judgeStop({ cwd: project }, gate.run);
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("lets the agent finish on a green gate even where the result cannot be stored", async () => {
    const project = createGitProject({ "gate:full": "true" });

    // A file where the folder for the record would go.
    writeFileSync(join(project, "node_modules"), "");

    expect(await judgeStop({ cwd: project }, green)).toBeUndefined();
  });

  it("is not judged again for a change git ignores, such as a build's output", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    await judgeStop({ cwd: project }, gate.run);
    mkdirSync(join(project, "dist"));
    writeFileSync(join(project, "dist", "out.js"), "built");
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is not remembered when the gate was red", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(() => ({ status: 1, output: "FAIL" }));

    await judgeStop({ cwd: project }, gate.run);
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when the gate itself rewrote a file, since the tree is now another one", async () => {
    const project = createGitProject({ "gate:full": "true" });
    let runs = 0;
    const rewriteThenPass = (): GateRun => {
      runs += 1;

      if (runs === 1) {
        writeFileSync(join(project, "src.ts"), "export const a = 3;\n");
      }

      return green();
    };

    await judgeStop({ cwd: project }, rewriteThenPass);
    await judgeStop({ cwd: project }, rewriteThenPass);
    await judgeStop({ cwd: project }, rewriteThenPass);

    expect(runs).toBe(2);
  });

  it("is judged every time where there is no git to say what changed", async () => {
    const project = createProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    await judgeStop({ cwd: project }, gate.run);
    await judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
    expect(existsSync(join(project, "node_modules"))).toBe(false);
  });
});

// The agent-workflow add-on has an agent work in `<project>-worktrees/<name>`.
// Claude Code keeps CLAUDE_PROJECT_DIR at the checkout the session started in
// and moves the payload's `cwd`. The hook once read the variable first: a red
// worktree beside a green primary checkout was then judged green.
const LAST_GREEN_RECORD = "node_modules/.cache/arch/last-green-tree";

describe("which tree is judged", () => {
  const green = () => ({ status: 0, output: "all gates passed." });

  it("is the worktree the session stops in, not the checkout the session started in", async () => {
    const { primary, worktree } = createProjectWithWorktree();
    const asked: string[] = [];

    vi.stubEnv("CLAUDE_PROJECT_DIR", primary);

    const reason = await judgeStop({ cwd: worktree }, (root, script) => {
      asked.push(`${root} ${script}`);

      return { status: 1, output: "FAIL in the worktree" };
    });

    expect(asked).toEqual([`${worktree} gate:full`]);
    expect(reason).toContain("FAIL in the worktree");
  });

  it("is the top of that worktree when the session stops in a folder inside it", async () => {
    const { primary, worktree } = createProjectWithWorktree();
    const roots: string[] = [];

    vi.stubEnv("CLAUDE_PROJECT_DIR", primary);
    mkdirSync(join(worktree, "packages/web/src"), { recursive: true });
    await judgeStop({ cwd: join(worktree, "packages/web/src") }, (root) => {
      roots.push(root);

      return green();
    });

    expect(roots).toEqual([worktree]);
  });

  it("blocks on a red worktree beside a green primary checkout, run as a command the way Claude Code starts it", () => {
    const { primary, worktree } = createProjectWithWorktree();

    writeFileSync(join(worktree, "check.mjs"), "console.log('red in the worktree'); process.exit(1);\n");

    const inWorktree = runHook({ cwd: worktree, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default", session_id: "s" }, { CLAUDE_PROJECT_DIR: primary });
    const inPrimary = runHook({ cwd: primary, hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default", session_id: "s" }, { CLAUDE_PROJECT_DIR: primary });

    expect(JSON.parse(inWorktree.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("red in the worktree") });
    expect(inPrimary.stdout).toBe("");
    expect(inPrimary.status).toBe(0);
  });

  it("is the project, when the session stops in a package folder whose package.json has no gate", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const roots: string[] = [];

    mkdirSync(join(project, "packages/web"), { recursive: true });
    writeFileSync(join(project, "packages/web/package.json"), JSON.stringify({ name: "web", scripts: { test: "vitest run" } }));
    await judgeStop({ cwd: join(project, "packages/web") }, (root) => {
      roots.push(root);

      return green();
    });

    expect(roots).toEqual([realpathSync(project)]);
  });

  it("is the project even when the package folder has a gate script of its own: the search starts at the top of the checkout", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const asked: string[] = [];

    mkdirSync(join(project, "packages/web"), { recursive: true });
    writeFileSync(join(project, "packages/web/package.json"), JSON.stringify({ name: "web", scripts: { "gate:fast": "true" } }));
    await judgeStop({ cwd: join(project, "packages/web") }, (root, script) => {
      asked.push(`${root} ${script}`);

      return green();
    });

    expect(asked).toEqual([`${realpathSync(project)} gate:full`]);
  });

  it("is the project for a package folder where there is no git either: the nearest folder upward with a gate", async () => {
    const project = createProject({ "gate:fast": "true" });
    const asked: string[] = [];

    mkdirSync(join(project, "packages/web/src"), { recursive: true });
    writeFileSync(join(project, "packages/web/package.json"), JSON.stringify({ name: "web", scripts: {} }));
    await judgeStop({ cwd: join(project, "packages/web/src") }, (root, script) => {
      asked.push(`${root} ${script}`);

      return green();
    });

    expect(asked).toEqual([`${project} gate:fast`]);
  });

  it("is the nearest such folder, not one further up", () => {
    const outer = createProject({ "gate:full": "true" });

    mkdirSync(join(outer, "inner/deep"), { recursive: true });
    writeFileSync(join(outer, "inner/package.json"), JSON.stringify({ scripts: { "gate:fast": "true" } }));

    expect(findProject(join(outer, "inner/deep"))).toEqual({ root: join(outer, "inner"), script: "gate:fast" });
    expect(findProject(outer)).toEqual({ root: outer, script: "gate:full" });
  });

  it.each([
    ["Claude Code", { hook_event_name: "Stop", stop_hook_active: false, permission_mode: "default", session_id: "s", transcript_path: "/t.jsonl" }],
    ["Codex", { hook_event_name: "Stop", stop_hook_active: false, session_id: "s", turn_id: "t", model: "m", last_assistant_message: "done" }],
  ])("blocks on a red gate from a package folder with no gate of its own, under %s, with CLAUDE_PROJECT_DIR not set", (_host, fields) => {
    const project = createGitProject({ "gate:full": "node -e \"console.log('red at the root'); process.exit(1)\"" });

    mkdirSync(join(project, "packages/web"), { recursive: true });
    writeFileSync(join(project, "packages/web/package.json"), JSON.stringify({ name: "web", scripts: { test: "true" } }));

    const run = runHook({ cwd: join(project, "packages/web"), ...fields }, {});

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("red at the root") });
  });

  it("falls back on CLAUDE_PROJECT_DIR only when the payload names no folder", async () => {
    const project = createProject({ "gate:fast": "true" });
    const other = createProject({ "gate:fast": "true" });
    const roots: string[] = [];
    const record = (root: string): GateRun => {
      roots.push(root);

      return green();
    };

    vi.stubEnv("CLAUDE_PROJECT_DIR", project);
    await judgeStop({}, record);
    await judgeStop({ cwd: "" }, record);
    await judgeStop({ cwd: other }, record);

    expect(roots).toEqual([project, project, other]);
  });

  it("does not take a green run in one checkout as a green run in another with the same files", async () => {
    const { primary, worktree } = createProjectWithWorktree();
    const gate = createCountedGate(green);

    mkdirSync(join(worktree, "node_modules"));
    mkdirSync(join(primary, "node_modules"));
    await judgeStop({ cwd: primary }, gate.run);
    await judgeStop({ cwd: primary }, gate.run);

    expect(gate.runs()).toBe(1);

    // The same files, the same record, in another place.
    mkdirSync(join(worktree, "node_modules/.cache/arch"), { recursive: true });
    writeFileSync(join(worktree, LAST_GREEN_RECORD), readFileSync(join(primary, LAST_GREEN_RECORD)));
    await judgeStop({ cwd: worktree }, gate.run);

    expect(gate.runs()).toBe(2);
    expect(readFileSync(join(worktree, LAST_GREEN_RECORD), "utf8")).not.toBe(readFileSync(join(primary, LAST_GREEN_RECORD), "utf8"));
  });

  it("does not read the record of another checkout through a node_modules that is a link to it", async () => {
    const { primary, worktree } = createProjectWithWorktree();
    const gate = createCountedGate(() => ({ status: 1, output: "FAIL" }));

    // A green run in the worktree leaves the worktree's own hash. It is moved to the primary checkout's record,
    // and the worktree's node_modules becomes a link there: read through the link, the record would match.
    mkdirSync(join(worktree, "node_modules"));
    await judgeStop({ cwd: worktree }, () => ({ status: 0, output: "" }));
    mkdirSync(join(primary, "node_modules/.cache/arch"), { recursive: true });
    writeFileSync(join(primary, LAST_GREEN_RECORD), readFileSync(join(worktree, LAST_GREEN_RECORD)));
    rmSync(join(worktree, "node_modules"), { recursive: true });
    symlinkSync(join(primary, "node_modules"), join(worktree, "node_modules"));

    expect(readFileSync(join(worktree, LAST_GREEN_RECORD), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(await judgeStop({ cwd: worktree }, gate.run)).toContain("is red");
    expect(gate.runs()).toBe(1);
  });
});

// Apart from the documented second stop, the agent may finish without a gate
// having passed only when there is no gate, or the tree is on record as green.
describe("a stop the hook cannot judge", () => {
  const green = () => ({ status: 0, output: "all gates passed." });

  it("is sent back when the project's package.json is not JSON: a gate may be in it", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "package.json"), '{ "scripts": { "gate:full": "false" }, }');

    const reason = await judgeStop({ cwd: project }, gate.run);

    expect(reason).toContain("The stop hook could not judge this project, so nothing is verified. That is not a pass.");
    expect(reason).toContain("package.json could not be read as JSON");
    expect(gate.runs()).toBe(0);
  });

  it("is still let through the second time, so that does not loop either", async () => {
    const project = createGitProject({ "gate:full": "true" });

    writeFileSync(join(project, "package.json"), "{");

    expect(await judgeStop({ cwd: project, stop_hook_active: true })).toBeUndefined();
  });

  it("is sent back when the gate's runner throws", async () => {
    const reason = await judgeStop({ cwd: createProject({ "gate:fast": "true" }) }, () => {
      throw new Error("the runner is gone");
    });

    expect(reason).toContain("could not judge this project");
    expect(reason).toContain("the runner is gone");
  });

  it("takes only the literal true for 'already continuing': the word in quotes still runs the gate", async () => {
    const gate = createCountedGate(() => ({ status: 1, output: "FAIL" }));
    const payload = { cwd: createProject({ "gate:fast": "false" }), stop_hook_active: "false" } as unknown as Parameters<typeof judgeStop>[0];

    expect(await judgeStop(payload, gate.run)).toContain("is red");
    expect(await judgeStop({ ...payload, stop_hook_active: 1 } as unknown as typeof payload, gate.run)).toContain("is red");
    expect(gate.runs()).toBe(2);
  });

  it("runs the gate when the record cannot be read, and does not fall over", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    // A folder where the record would be.
    mkdirSync(join(project, LAST_GREEN_RECORD), { recursive: true });

    expect(await judgeStop({ cwd: project }, gate.run)).toBeUndefined();
    expect(await judgeStop({ cwd: project }, gate.run)).toBeUndefined();
    expect(gate.runs()).toBe(2);
  });

  it.skipIf(process.getuid?.() === 0)("runs the gate every time when a file of the tree cannot be read, and does not fall over", async () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    chmodSync(join(project, "src.ts"), 0o000);
    onTestFinished(() => {
      chmodSync(join(project, "src.ts"), 0o644);
    });

    expect(await judgeStop({ cwd: project }, gate.run)).toBeUndefined();
    expect(await judgeStop({ cwd: project }, gate.run)).toBeUndefined();
    expect(gate.runs()).toBe(2);
  });

  it("runs the gate, from the folder it was started in, when what the host sent is not JSON", () => {
    const project = createProject({ "gate:fast": "node -e \"console.log('still judged'); process.exit(1)\"" });
    const run = spawnSync(process.execPath, [join(here, "before-stop.mts")], { cwd: project, input: "not json", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "" }, timeout: 20_000 });

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ decision: "block", reason: expect.stringContaining("still judged") });
  });
});

/** Runs the hook as a host does: the payload on its standard input. */
function runHook(payload: Record<string, unknown>, env: Record<string, string>): { status: number | null; stdout: string } {
  const { CLAUDE_PROJECT_DIR: _unset, ...rest } = process.env;

  return spawnSync(process.execPath, [join(here, "before-stop.mts")], { input: JSON.stringify(payload), encoding: "utf8", env: { ...rest, ...env }, timeout: 30_000 });
}

/** A committed project whose gate runs `check.mjs`, and a worktree of it beside it, as the agent-workflow add-on makes one. */
function createProjectWithWorktree(): { primary: string; worktree: string } {
  const primary = realpathSync(createGitProject({ "gate:full": "node check.mjs" }));
  const worktree = join(`${primary}-worktrees`, "fix");
  const git = (cwd: string, ...args: string[]): void => {
    const ran = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd, encoding: "utf8" });

    if (ran.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${ran.stderr}`);
    }
  };

  writeFileSync(join(primary, "check.mjs"), "process.exit(0);\n");
  git(primary, "add", "-A");
  git(primary, "commit", "--quiet", "-m", "first");
  git(primary, "worktree", "add", "--quiet", "-b", "worktree-fix", worktree);

  return { primary, worktree };
}

function createPatch(): string {
  return [
    "*** Begin Patch",
    "*** Add File: src/ui/New.tsx",
    "+export const a = 1;",
    "*** Update File: src/ui/Old.tsx",
    "@@",
    "-old",
    "+new",
    "*** Delete File: src/ui/Gone.tsx",
    "*** End Patch",
  ].join("\n");
}

function createProject(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "arch-hooks-"));

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", scripts }));

  return root;
}

/** A project git knows about: one tracked source file, and a build folder it ignores. */
function createGitProject(scripts: Record<string, string>): string {
  const root = createProject(scripts);

  writeFileSync(join(root, "src.ts"), "export const a = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ndist/\n.env.local\n");
  spawnSync("git", ["init", "--quiet"], { cwd: root });
  spawnSync("git", ["add", "src.ts", "package.json", ".gitignore"], { cwd: root });

  return root;
}

function createCountedGate(result: () => GateRun): { run: () => GateRun; runs: () => number } {
  let count = 0;

  return {
    run: (): GateRun => {
      count += 1;

      return result();
    },
    runs: (): number => count,
  };
}
