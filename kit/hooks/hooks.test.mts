import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { editedFilesOf, judgeEdit } from "./after-edit.mts";
import { judgeStop } from "./before-stop.mts";

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

  it("runs the project's own script and reads its exit code", () => {
    expect(judgeStop({ cwd: createProject({ "gate:fast": "node -e \"process.exit(0)\"" }) })).toBeUndefined();

    const reason = judgeStop({
      cwd: createProject({ "gate:fast": "node -e \"console.log('FAIL dumb-ui (1)'); process.exit(1)\"" }),
    });

    expect(reason).toContain("`gate:fast` is red");
    expect(reason).toContain("FAIL dumb-ui (1)");
  });

  it("stays out of a project that has no fast gate", () => {
    let ran = false;
    const reason = judgeStop({ cwd: createProject({ test: "vitest" }) }, () => {
      ran = true;

      return red();
    });

    expect(reason).toBeUndefined();
    expect(ran).toBe(false);
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
