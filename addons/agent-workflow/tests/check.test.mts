import { describe, expect, it } from "vitest";

import { check, type CheckOptions, createHookRunner } from "../files/tools/agent-workflow/check.mts";
import { APPROVING_HOST, ASK_RULES, WIDE_ALLOW } from "../files/tools/agent-workflow/lib/host.mts";
import { installedIn, requires } from "../files/tools/agent-workflow/requires.mts";
import { createFolder } from "./support.mts";

const CLAUDE_HOOK = `node "$CLAUDE_PROJECT_DIR/tools/agent-workflow/hooks/split-outward-commands.mts" ${APPROVING_HOST}`;
const CODEX_HOOK = "node tools/agent-workflow/hooks/split-outward-commands.mts";
const COMMANDS = {
  ".claude/commands/workflow/changelog.md": "changelog\n",
  ".claude/commands/workflow/coverage-backfill.md": "coverage\n",
  ".claude/commands/workflow/visual-tolerance-audit.md": "visual\n",
};
const DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}\n';
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n';

describe("the add-on's check", () => {
  it("passes a project that has the hook in both hosts' settings, approval on and the ask rules in", () => {
    const { status, lines } = runCheck(createProject());

    expect(status).toBe(0);
    expect(lines).toEqual([
      "PASS hook: refuses an outward step joined to others, says nothing about a push to main, and never approves without --host=claude-code",
      "PASS approval: on. In Claude Code a routine step in its exact form runs without a prompt (turn it off in tools/agent-workflow.config.mts)",
      "PASS Claude Code: .claude/settings.json runs the hook before each shell command",
      "PASS Claude Code: all 13 ask rules are in, so a forced or destructive push and an --admin merge ask whatever else allows them",
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

  it("notes that approval is off when the project turned it off, and does not fail for it", () => {
    const { status, lines } = runCheck(createProject(), { approval: "off" });

    expect(status).toBe(0);
    expect(lines[1]).toBe(
      "NOTE approval: off. tools/agent-workflow.config.mts does not set approveExactShapes to true, so every push and pull request step asks. That is the project's choice",
    );
  });

  it("says approval is not possible yet in a folder that is in no repository, whatever the setting says", () => {
    const { status, lines } = runCheck(createProject(), { approval: "off", repository: false });

    expect(status).toBe(0);
    expect(lines[1]).toMatch(/^NOTE approval: not possible yet\. .* is not in a git repository, and the hook approves only in a checkout or a worktree of the project's own\. Run git init, then this again$/);
    expect(runCheck(createProject(), { repository: false }).lines[1]).toMatch(/^PASS approval: on\./);
  });

  it("still fails a hook that refuses the routine step, in a folder that is in no repository", () => {
    const { status, lines } = runCheck(createProject(), { approved: { status: 0, stdout: DENY }, repository: false });

    expect(status).toBe(1);
    expect(lines.join("\n")).not.toContain("not possible yet");
  });

  it("asks the hook the way a host does: a plain Bash call that runs in the project", () => {
    const root = createProject();
    const payloads: unknown[] = [];

    runCheck(root, { payloads });

    expect(payloads).toHaveLength(6);
    expect(payloads[0]).toEqual({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m wip && git push" }, cwd: root });
    expect(new Set(payloads.map((payload) => JSON.stringify(Object.keys(payload as object))))).toEqual(new Set(['["tool_name","tool_input","cwd"]']));
  });

  it("says the setting file is missing when that is why approval is off", () => {
    const { status, lines } = runCheck(createProject({ "tools/agent-workflow.config.mts": undefined }), { approval: "off" });

    expect(status).toBe(0);
    expect(lines[1]).toBe("NOTE approval: off. There is no tools/agent-workflow.config.mts, so nothing is approved and every push and pull request step asks");
  });

  it.each([
    ["does not refuse the chain", { refused: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A && git commit -m wip && git push` started with --host=claude-code answered "none", not "deny"$/],
    ["does not refuse the chain for Codex", { refusedForCodex: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A .*` started with no argument answered "none", not "deny"$/],
    ["approves a chain", { refused: { status: 0, stdout: ALLOW } }, /answered "allow", not "deny"$/],
    ["crashes after it replied", { refused: { status: 1, stdout: DENY } }, /answered "broken", not "deny"$/],
    ["prints something that is no answer", { refused: { status: 0, stdout: "refused" } }, /answered "broken", not "deny"$/],
    ["prints a decision it does not have", { refused: { status: 0, stdout: DENY.replace("deny", "ask") } }, /answered "broken", not "deny"$/],
    ["approves a push to main", { unanswered: { status: 0, stdout: ALLOW } }, /^FAIL hook: `git push origin main` started with --host=claude-code answered "allow", not "none"$/],
    ["refuses a push to main", { unanswered: { status: 0, stdout: DENY } }, /^FAIL hook: `git push origin main` .* answered "deny", not "none"$/],
    ["approves for Codex", { approvedForCodex: { status: 0, stdout: ALLOW } }, /^FAIL hook: `git push -u origin worktree-sample 2>&1 \| tail -2` started with no argument answered "allow", not "none"$/],
  ])("fails when the hook %s", (_name, replies, message) => {
    const { status, lines } = runCheck(createProject(), replies);

    expect(status).toBe(1);
    expect(lines[0]).toMatch(message);
    expect(lines.join("\n")).not.toContain("PASS hook");
  });

  it("fails when the hook refuses the routine step it is there to approve", () => {
    const { status, lines } = runCheck(createProject(), { approved: { status: 0, stdout: DENY } });

    expect(status).toBe(1);
    expect(lines).toContain('FAIL hook: `git push -u origin worktree-sample 2>&1 | tail -2` started with --host=claude-code answered "deny"; it may only approve or say nothing');
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

  it("fails when Codex's settings start the hook with the argument that lets it approve", () => {
    const { status, lines } = runCheck(createProject({ ".codex/hooks.json": { hooks: { PreToolUse: [createGroup(`${CODEX_HOOK} ${APPROVING_HOST}`, "Bash")] } } }));

    expect(status).toBe(1);
    expect(lines).toContain(
      "FAIL Codex: .codex/hooks.json starts the hook with --host=claude-code. Codex does not take an approval from a hook: remove that argument there",
    );
  });

  it("notes that the hook approves nothing when Claude Code's settings start it without the argument", () => {
    const { status, lines } = runCheck(createProject({ claudeHook: CODEX_HOOK }));

    expect(status).toBe(0);
    expect(lines).toContain("NOTE Claude Code: .claude/settings.json starts the hook without --host=claude-code, so it approves nothing there");
    expect(runCheck(createProject()).lines.join("\n")).not.toContain("starts the hook without");
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

  it("notes ask rules the project took out, and does not fail while no allow rule approves by pattern", () => {
    const { status, lines } = runCheck(createProject({ ask: ASK_RULES.slice(2), allow: ["Bash(pnpm test)", "Bash(git push origin worktree-fix)"] }));

    expect(status).toBe(0);
    expect(lines).toContain(
      "NOTE Claude Code: 2 of 13 ask rules are not in permissions.ask. No allow rule pre-approves a push or a merge by pattern, so those forms ask anyway",
    );
  });

  it.each(["Bash(git push origin worktree-*)", "Bash(git push *)", "Bash(gh pr merge *)", "Bash(gh pr create *)"])(
    "notes an allow rule with a star for a step the hook approves by shape: %s",
    (rule) => {
      const { status, lines } = runCheck(createProject({ allow: [rule] }));

      expect(status).toBe(0);
      expect(lines.join("\n")).toContain(`NOTE Claude Code: the allow rule ${rule} pre-approves more than its words say`);
    },
  );

  it("fails when such a rule is there and an ask rule that backs it is not", () => {
    const { status, lines } = runCheck(createProject({ allow: ["Bash(git push origin worktree-*)"], ask: ASK_RULES.filter((rule) => rule !== "Bash(git push *--mirror*)") }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toMatch(
      /FAIL Claude Code: Bash\(git push origin worktree-\*\) pre-approves by pattern, and a forced or destructive form is not set to ask\. Missing from permissions\.ask: Bash\(git push \*--mirror\*\)/,
    );
  });

  it("fails when a command file is gone", () => {
    const { status, lines } = runCheck(createProject({ ".claude/commands/workflow/changelog.md": undefined }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toContain("FAIL command: .claude/commands/workflow/changelog.md is missing");
  });

  it("says the hook is missing when it is asked to run one that is not there", () => {
    expect(createHookRunner(createFolder())({}, [])).toEqual({ status: 127, stdout: "tools/agent-workflow/hooks/split-outward-commands.mts does not exist" });
  });
});

describe("an allow rule that approves by pattern", () => {
  it.each(["Bash(git push origin worktree-*)", "Bash(git push -u origin worktree-*)", "Bash(git push *)", "Bash(gh pr create *)", "Bash(gh pr merge *)", "Bash(gh pr merge * --merge)"])(
    "is %s",
    (rule) => {
      expect(WIDE_ALLOW.test(rule)).toBe(true);
    },
  );

  it.each(["Bash(git push origin worktree-fix)", "Bash(gh pr merge 12 --merge)", "Bash(git pushd *)", "Bash(pnpm test *)", "Bash(gh pr view *)", "Bash(git fetch *)", "Read(git push *)"])(
    "is not %s",
    (rule) => {
      expect(WIDE_ALLOW.test(rule)).toBe(false);
    },
  );
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
  /** The command Claude Code's settings start the hook with. */
  claudeHook?: string;
  /** A file's content, or undefined for a file that is not there. Overrides what the project would have. */
  [path: `.${string}` | `tools/${string}`]: unknown;
}

function createProject(shape: ProjectShape = {}): string {
  const files: Record<string, unknown> = {
    ".claude/settings.json": {
      permissions: { allow: shape.allow ?? [], ask: shape.ask ?? ASK_RULES },
      hooks: { PreToolUse: [createGroup(shape.claudeHook ?? CLAUDE_HOOK, "Bash")] },
    },
    ".codex/hooks.json": { hooks: { PreToolUse: [createGroup(CODEX_HOOK, "Bash")] } },
    "tools/installed.json": Object.fromEntries((shape.installed ?? ["kit", "agent-workflow"]).map((unit) => [unit, { files: {} }])),
    "tools/agent-workflow.config.mts": "export const approveExactShapes: boolean = true;\n",
    ...COMMANDS,
  };

  for (const [path, content] of Object.entries(shape)) {
    if (path.startsWith(".") || path.startsWith("tools/")) {
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

interface Replies {
  /** Whether the stand-in hook approves the routine step for Claude Code. "on" unless said otherwise. */
  approval?: "on" | "off";
  /** Whether the project folder is in a git repository. Yes unless said otherwise. */
  repository?: boolean;
  /** Every payload the check gave the hook is added here. */
  payloads?: unknown[];
  refused?: HookReply;
  refusedForCodex?: HookReply;
  unanswered?: HookReply;
  approved?: HookReply;
  approvedForCodex?: HookReply;
}

/** Runs the check with a hook that answers as the real one does, unless `replies` says otherwise. */
function runCheck(root: string, replies: Replies = {}): { status: number; lines: string[] } {
  const lines: string[] = [];
  const nothing = { status: 0, stdout: "" };
  const runHook: CheckOptions["runHook"] = (payload, args) => {
    replies.payloads?.push(payload);

    const command = (payload as { tool_input: { command: string } }).tool_input.command;
    const forClaude = args.includes(APPROVING_HOST);

    if (command.includes("&&")) {
      return (forClaude ? replies.refused : replies.refusedForCodex) ?? { status: 0, stdout: DENY };
    }

    if (command.includes("worktree-sample")) {
      return forClaude ? (replies.approved ?? (replies.approval === "off" ? nothing : { status: 0, stdout: ALLOW })) : (replies.approvedForCodex ?? nothing);
    }

    return replies.unanswered ?? nothing;
  };

  return { status: check({ root, runHook, isRepository: () => replies.repository ?? true, report: (line) => lines.push(line) }), lines };
}

function runRequires(root: string, addon: string | undefined): { status: number; lines: string[] } {
  const lines: string[] = [];

  return { status: requires(root, addon, (line) => lines.push(line)), lines };
}

function createGroup(command: string, matcher?: string): unknown {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] };
}
