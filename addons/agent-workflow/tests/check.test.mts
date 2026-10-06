import { describe, expect, it } from "vitest";

import { check, type CheckOptions, createHookRunner } from "../files/tools/agent-workflow/check.mts";
import { ALLOW_RULES, ASK_RULES } from "../files/tools/agent-workflow/lib/host.mts";
import { installedIn, requires } from "../files/tools/agent-workflow/requires.mts";
import { createFolder } from "./support.mts";

const CLAUDE_HOOK = 'node "$CLAUDE_PROJECT_DIR/tools/agent-workflow/hooks/split-outward-commands.mts"';
const CODEX_HOOK = "node tools/agent-workflow/hooks/split-outward-commands.mts";
const COMMANDS = {
  ".claude/commands/workflow/changelog.md": "changelog\n",
  ".claude/commands/workflow/coverage-backfill.md": "coverage\n",
  ".claude/commands/workflow/visual-tolerance-audit.md": "visual\n",
};

describe("the add-on's check", () => {
  it("passes a project that has the hook in both hosts' settings and the permission rules", () => {
    const { status, lines } = runCheck(createProject());

    expect(status).toBe(0);
    expect(lines).toEqual([
      "PASS hook: refuses an outward step joined to others, lets a lone one through",
      "PASS Claude Code: .claude/settings.json runs the hook before each shell command",
      "PASS Claude Code: 4 of 4 routine steps pre-approved, a forced push always asks",
      "PASS Codex: .codex/hooks.json runs the hook before each shell command",
      "PASS command /workflow:changelog",
      'NOTE command /workflow:coverage-backfill: needs the "coverage" add-on, which this project does not have. It stops and says so when run',
      'NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on, which this project does not have. It stops and says so when run',
    ]);
  });

  it("says a command is usable once the add-on it needs is recorded", () => {
    const { lines } = runCheck(createProject({ installed: ["kit", "agent-workflow", "coverage"] }));

    expect(lines).toContain("PASS command /workflow:coverage-backfill");
    expect(lines.join("\n")).toContain('NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on');
  });

  it.each([
    ["Claude Code", ".claude/settings.json"],
    ["Codex", ".codex/hooks.json"],
  ])("fails when %s's settings exist and do not register the hook", (host, path) => {
    const { status, lines } = runCheck(createProject({ [path]: { hooks: { Stop: [createGroup("node tools/arch/hooks/before-stop.mts")] } } }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toMatch(new RegExp(`FAIL ${host}: ${path.replace(".", "\\.")} does not register tools/agent-workflow/hooks/split-outward-commands\\.mts`));
  });

  it("does not take a hook registered for another event as registered", () => {
    const { status, lines } = runCheck(createProject({ ".codex/hooks.json": { hooks: { PostToolUse: [createGroup(CODEX_HOOK)] } } }));

    expect(status).toBe(1);
    expect(lines).toContain("PASS Claude Code: .claude/settings.json runs the hook before each shell command");
    expect(lines.join("\n")).toContain("FAIL Codex: .codex/hooks.json does not register");
  });

  it("fails a settings file that holds no JSON object", () => {
    const { status, lines } = runCheck(createProject({ ".codex/hooks.json": "not json" }));

    expect(status).toBe(1);
    expect(lines).toContain("FAIL Codex: .codex/hooks.json is not a JSON object, so the host reads no hook from it");
  });

  it("skips a host whose settings file is not there, and still judges the other", () => {
    const { status, lines } = runCheck(createProject({ ".codex/hooks.json": undefined }));

    expect(status).toBe(0);
    expect(lines).toContain("SKIP Codex: there is no .codex/hooks.json, so the hook does not run there");
    expect(lines).toContain("PASS Claude Code: .claude/settings.json runs the hook before each shell command");
  });

  it("does not pass when neither host has a settings file: nothing was judged", () => {
    const { status, lines } = runCheck(createProject({ ".codex/hooks.json": undefined, ".claude/settings.json": undefined }));

    expect(status).toBe(2);
    expect(lines.at(-1)).toMatch(/^SKIP agent-workflow: neither .* exists, so no host runs the hook\. That is not a pass/);
  });

  it("notes a routine step the project chose not to pre-approve, and does not fail for it", () => {
    const { status, lines } = runCheck(createProject({ allow: ALLOW_RULES.filter((rule) => !rule.includes("gh pr merge")) }));

    expect(status).toBe(0);
    expect(lines).toContain(
      "NOTE Claude Code: Bash(gh pr merge *) is not in permissions.allow, so that step asks each time. That is the project's choice",
    );
    expect(lines).toContain("PASS Claude Code: 3 of 4 routine steps pre-approved, a forced push always asks");
  });

  it("fails when a push is pre-approved and a forced push is not set to ask", () => {
    const { status, lines } = runCheck(createProject({ ask: ASK_RULES.filter((rule) => rule !== "Bash(git push * +*)") }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL Claude Code: a push is pre-approved .*Missing from permissions\.ask: Bash\(git push \* \+\*\)/);
  });

  it("passes a project that pre-approves no push and has no ask rule: every push asks anyway", () => {
    const { status, lines } = runCheck(createProject({ allow: ["Bash(gh pr create *)"], ask: [] }));

    expect(status).toBe(0);
    expect(lines).toContain("PASS Claude Code: no push is pre-approved, so every push asks");
  });

  it.each([
    ["does not refuse the chain", { refused: { status: 0, stdout: "" } }, /FAIL hook: it did not refuse `git add -A && git commit -m wip && git push`/],
    ["crashes after it replied", { refused: { status: 1, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}' } }, /FAIL hook: it did not refuse .*exit 1/],
    ["refuses a lone push", { allowed: { status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}' } }, /FAIL hook: it did not let `git push -u origin worktree-sample 2>&1 \| tail -2` through/],
  ])("fails when the hook %s", (_name, replies, message) => {
    const { status, lines } = runCheck(createProject(), replies);

    expect(status).toBe(1);
    expect(lines[0]).toMatch(message);
  });

  it("fails when a command file is gone", () => {
    const { status, lines } = runCheck(createProject({ ".claude/commands/workflow/changelog.md": undefined }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toContain("FAIL command: .claude/commands/workflow/changelog.md is missing");
  });

  it("says the hook is missing when it is asked to run one that is not there", () => {
    expect(createHookRunner(createFolder())({})).toEqual({ status: 127, stdout: "tools/agent-workflow/hooks/split-outward-commands.mts does not exist" });
  });
});

describe("asking whether an add-on is installed", () => {
  it("answers from the installer's record", () => {
    const root = createFolder({ "tools/installed.json": JSON.stringify({ kit: {}, coverage: {} }) });

    expect(installedIn(root)).toEqual(["kit", "coverage"]);
    expect(runRequires(root, "coverage")).toEqual({ status: 0, lines: ['OK: the "coverage" add-on is installed'] });
  });

  it("stops, and says how to add it, when the add-on is not there", () => {
    const { status, lines } = runRequires(createFolder({ "tools/installed.json": JSON.stringify({ kit: {} }) }), "visual");

    expect(status).toBe(2);
    expect(lines[0]).toMatch(/^SKIP: this needs the "visual" add-on, which this project does not have\. Add it first \(add-to-project\.mts <project> visual\)/);
  });

  it.each([
    ["missing", {}],
    ["not JSON", { "tools/installed.json": "{" }],
    ["a list", { "tools/installed.json": '["coverage"]' }],
  ])("stops when the record is %s", (_name, files) => {
    const root = createFolder(files);

    expect(installedIn(root)).toBeUndefined();
    expect(runRequires(root, "coverage").status).toBe(2);
    expect(runRequires(root, "coverage").lines[0]).toMatch(/tools\/installed\.json is missing or unreadable/);
  });

  it("stops when it is not told which add-on", () => {
    expect(runRequires(createFolder({ "tools/installed.json": "{}" }), undefined)).toEqual({
      status: 2,
      lines: ["usage: requires.mts <add-on>   e.g. requires.mts coverage"],
    });
  });
});

interface ProjectShape {
  allow?: string[];
  ask?: string[];
  installed?: string[];
  /** A file's content, or undefined for a file that is not there. Overrides what the project would have. */
  [path: `.${string}`]: unknown;
}

function createProject(shape: ProjectShape = {}): string {
  const files: Record<string, unknown> = {
    ".claude/settings.json": {
      permissions: { allow: shape.allow ?? ALLOW_RULES, ask: shape.ask ?? ASK_RULES },
      hooks: { PreToolUse: [createGroup(CLAUDE_HOOK, "Bash")] },
    },
    ".codex/hooks.json": { hooks: { PreToolUse: [createGroup(CODEX_HOOK, "Bash")] } },
    "tools/installed.json": Object.fromEntries((shape.installed ?? ["kit", "agent-workflow"]).map((unit) => [unit, { files: {} }])),
    ...COMMANDS,
  };

  for (const [path, content] of Object.entries(shape)) {
    if (path.startsWith(".")) {
      files[path] = content;
    }
  }

  return createFolder(
    Object.fromEntries(
      Object.entries(files)
        .filter(([, content]) => content !== undefined)
        .map(([path, content]) => [path, typeof content === "string" ? content : JSON.stringify(content)]),
    ),
  );
}

type HookReply = ReturnType<CheckOptions["runHook"]>;

/** Runs the check with a hook that answers as the real one does, unless `replies` says otherwise. */
function runCheck(root: string, replies: { refused?: HookReply; allowed?: HookReply } = {}): { status: number; lines: string[] } {
  const lines: string[] = [];
  const runHook: CheckOptions["runHook"] = (payload) => {
    const command = (payload as { tool_input: { command: string } }).tool_input.command;

    return command.includes("&&")
      ? (replies.refused ?? { status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}\n' })
      : (replies.allowed ?? { status: 0, stdout: "" });
  };

  return { status: check({ root, runHook, report: (line) => lines.push(line) }), lines };
}

function runRequires(root: string, addon: string | undefined): { status: number; lines: string[] } {
  const lines: string[] = [];

  return { status: requires(root, addon, (line) => lines.push(line)), lines };
}

function createGroup(command: string, matcher?: string): unknown {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] };
}
