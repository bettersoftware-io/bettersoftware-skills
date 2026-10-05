import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { editedFilesOf, judgeEdit } from "./after-edit.mts";
import { type GateRun, judgeStop } from "./before-stop.mts";

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

  it("sends a red gate back as the next instruction", () => {
    const reason = judgeStop({ cwd: createProject({ "gate:fast": "false" }) }, red);

    expect(reason).toContain("`gate:fast` is red");
    expect(reason).toContain("src/ui/A.tsx:3");
  });

  it("lets the agent finish on a green gate", () => {
    expect(judgeStop({ cwd: createProject({ "gate:fast": "true" }) }, green)).toBeUndefined();
  });

  it("lets the agent finish the second time, so a gate it cannot fix does not loop", () => {
    expect(judgeStop({ cwd: createProject({ "gate:fast": "false" }), stop_hook_active: true }, red)).toBeUndefined();
  });

  it("holds the agent to the full gate, the one CI runs, when the project has one", () => {
    const asked: string[] = [];
    const reason = judgeStop({ cwd: createProject({ "gate:fast": "true", "gate:full": "false" }) }, (_root, script) => {
      asked.push(script);

      return red();
    });

    expect(asked).toEqual(["gate:full"]);
    expect(reason).toContain("`gate:full` is red");
  });

  it("runs the project's own script and reads its exit code", () => {
    expect(judgeStop({ cwd: createProject({ "gate:full": "node -e \"process.exit(0)\"" }) })).toBeUndefined();

    const reason = judgeStop({
      cwd: createProject({ "gate:full": "node -e \"console.log('FAIL dumb-ui (1)'); process.exit(1)\"" }),
    });

    expect(reason).toContain("`gate:full` is red");
    expect(reason).toContain("FAIL dumb-ui (1)");
  });

  it("stays out of a project that has no gate", () => {
    const gate = createCountedGate(red);
    const reason = judgeStop({ cwd: createProject({ test: "vitest" }) }, gate.run);

    expect(reason).toBeUndefined();
    expect(gate.runs()).toBe(0);
  });

  it("says a gate that did not finish verified nothing, and does not let the agent finish on it", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(() => ({ status: 1, output: "", timedOut: true }));

    expect(judgeStop({ cwd: project }, gate.run)).toContain("did not finish");
    expect(judgeStop({ cwd: project }, gate.run)).toContain("did not finish");
    expect(gate.runs()).toBe(2);
  });
});

describe("a tree that has already passed", () => {
  const green = () => ({ status: 0, output: "all gates passed." });

  it("is not judged a second time, so an agent that changed nothing does not wait", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    judgeStop({ cwd: project }, gate.run);
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is judged again after a tracked file changes", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "src.ts"), "export const a = 2;\n");
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again after a new file appears, and after one is deleted", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "new.ts"), "export const b = 1;\n");
    judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "src.ts"));
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(3);
  });

  it("is judged again after a file is renamed with its content unchanged", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "draft.ts"), "export const d = 1;\n");
    judgeStop({ cwd: project }, gate.run);
    renameSync(join(project, "draft.ts"), join(project, "moved.ts"));
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when an empty file is deleted, though no content changed", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "src.ts"), "");
    judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "src.ts"));
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when a link is pointed somewhere else", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    symlinkSync("src.ts", join(project, "link.ts"));
    judgeStop({ cwd: project }, gate.run);
    rmSync(join(project, "link.ts"));
    symlinkSync("package.json", join(project, "link.ts"));
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is not judged again when a file is only staged", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    writeFileSync(join(project, "added.ts"), "export const c = 1;\n");
    judgeStop({ cwd: project }, gate.run);
    spawnSync("git", ["add", "added.ts"], { cwd: project });
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is judged again when an environment file changes, though git ignores it", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    mkdirSync(join(project, "packages", "web"), { recursive: true });
    writeFileSync(join(project, "packages", "web", ".env.local"), "API=http://localhost:4000\n");
    judgeStop({ cwd: project }, gate.run);
    writeFileSync(join(project, "packages", "web", ".env.local"), "API=http://localhost:5000\n");
    judgeStop({ cwd: project }, gate.run);
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again under another version of Node", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);
    const version = process.version;

    onTestFinished(() => {
      Object.defineProperty(process, "version", { value: version });
    });

    judgeStop({ cwd: project }, gate.run);
    Object.defineProperty(process, "version", { value: "v99.0.0" });
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged every time when it holds a repository of its own, whose files git does not list", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    mkdirSync(join(project, "vendor"));
    spawnSync("git", ["init", "--quiet"], { cwd: join(project, "vendor") });
    writeFileSync(join(project, "vendor", "lib.ts"), "export const v = 1;\n");
    judgeStop({ cwd: project }, gate.run);
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("lets the agent finish on a green gate even where the result cannot be stored", () => {
    const project = createGitProject({ "gate:full": "true" });

    // A file where the folder for the record would go.
    writeFileSync(join(project, "node_modules"), "");

    expect(judgeStop({ cwd: project }, green)).toBeUndefined();
  });

  it("is not judged again for a change git ignores, such as a build's output", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    judgeStop({ cwd: project }, gate.run);
    mkdirSync(join(project, "dist"));
    writeFileSync(join(project, "dist", "out.js"), "built");
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(1);
  });

  it("is not remembered when the gate was red", () => {
    const project = createGitProject({ "gate:full": "true" });
    const gate = createCountedGate(() => ({ status: 1, output: "FAIL" }));

    judgeStop({ cwd: project }, gate.run);
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
  });

  it("is judged again when the gate itself rewrote a file, since the tree is now another one", () => {
    const project = createGitProject({ "gate:full": "true" });
    let runs = 0;
    const rewriteThenPass = (): GateRun => {
      runs += 1;

      if (runs === 1) {
        writeFileSync(join(project, "src.ts"), "export const a = 3;\n");
      }

      return green();
    };

    judgeStop({ cwd: project }, rewriteThenPass);
    judgeStop({ cwd: project }, rewriteThenPass);
    judgeStop({ cwd: project }, rewriteThenPass);

    expect(runs).toBe(2);
  });

  it("is judged every time where there is no git to say what changed", () => {
    const project = createProject({ "gate:full": "true" });
    const gate = createCountedGate(green);

    judgeStop({ cwd: project }, gate.run);
    judgeStop({ cwd: project }, gate.run);

    expect(gate.runs()).toBe(2);
    expect(existsSync(join(project, "node_modules"))).toBe(false);
  });
});

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
