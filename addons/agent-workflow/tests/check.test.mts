import { describe, expect, it } from "vitest";

import { check, type CheckOptions, createHookRunner } from "../files/tools/agent-workflow/check.mts";
import { ASK_RULES, EDIT_ASK_RULES, RETIRED_ARGUMENT, RETIRED_FILES, WIDE_ALLOW } from "../files/tools/agent-workflow/lib/host.mts";
import { installedIn, requires } from "../files/tools/agent-workflow/requires.mts";
import { OLD_SETTING_ON } from "./shapes.mts";
import { createFolder } from "./support.mts";

const CLAUDE_HOOK = 'node "$CLAUDE_PROJECT_DIR/tools/agent-workflow/hooks/split-outward-commands.mts"';
const CODEX_HOOK = "node tools/agent-workflow/hooks/split-outward-commands.mts";
const COMMANDS = {
  ".claude/commands/workflow/changelog.md": "changelog\n",
  ".claude/commands/workflow/coverage-backfill.md": "coverage\n",
  ".claude/commands/workflow/visual-tolerance-audit.md": "visual\n",
};
const DENY = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}\n';
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n';
const ASK = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}\n';
const EDIT_PASS = "PASS Claude Code: an editing tool asks before it changes the hook (a shell command that writes it is not covered by any rule)";
const ROUTINE = "`git push -u origin worktree-sample 2>&1 \\| tail -2`";

describe("the add-on's check", () => {
  it("passes a project as the add-on leaves it: the hook in both hosts' settings, and every ask rule in", () => {
    const { status, lines } = runCheck(createProject());

    expect(status).toBe(0);
    expect(lines).toEqual([
      "PASS hook: refuses an outward step joined to others, and says nothing about a push alone, whatever it is started with",
      "PASS Claude Code: .claude/settings.json runs the hook before each shell command",
      EDIT_PASS,
      "PASS Claude Code: all 13 ask rules are in, so a forced or destructive push and an --admin merge ask whatever else allows them",
      "PASS Codex: .codex/hooks.json runs the hook before each shell command",
      "PASS command /workflow:changelog",
      'NOTE command /workflow:coverage-backfill: needs the "coverage" add-on, which this project does not have. It stops and says so when run',
      'NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on, which this project does not have. It stops and says so when run',
    ]);
  });

  it.each(RETIRED_FILES)("says %s is no longer read, when a project still has one, whatever it holds", (path) => {
    const { status, lines } = runCheck(createProject({ [path]: OLD_SETTING_ON }));

    expect(status).toBe(0);
    expect(lines[1]).toBe(`NOTE setting: ${path} is no longer read. The hook lets nothing run without a prompt, whatever that file says. Delete it`);
    expect(runCheck(createProject()).lines.join("\n")).not.toContain("no longer read");
  });

  it("names the two files a project may still have from the version that read a setting", () => {
    expect(RETIRED_FILES).toEqual(["tools/agent-workflow.config.json", "tools/agent-workflow.config.mts"]);
  });

  it.each([
    ["Claude Code", ".claude/settings.json", `${CLAUDE_HOOK} ${RETIRED_ARGUMENT}`],
    ["Codex", ".codex/hooks.json", `${CODEX_HOOK} ${RETIRED_ARGUMENT}`],
  ])("passes, and notes it, when %s's settings still start the hook with the argument of an older version", (host, path, command) => {
    const { status, lines } = runCheck(createProject({ [path]: { hooks: { PreToolUse: [createGroup(command, "Bash", 30)] } } }));

    expect(status).toBe(0);
    expect(lines).toContain(`PASS ${host}: ${path} runs the hook before each shell command`);
    expect(lines).toContain(`NOTE ${host}: ${path} starts the hook with --host=claude-code, as an older version of the add-on did. The hook ignores it. Remove the argument when you like`);
    expect(runCheck(createProject()).lines.join("\n")).not.toContain("--host=claude-code");
  });

  it("notes, and does not fail, when the rule that asks before an edit of the hook is not in", () => {
    const { status, lines } = runCheck(createProject({ ask: ASK_RULES }));

    expect(status).toBe(0);
    expect(lines).toContain(
      "NOTE Claude Code: Edit(/tools/agent-workflow/**) is not in permissions.ask, so an editing tool may change the hook that refuses a chain without asking. Run the installer again (add-to-project.mts <project> agent-workflow): it merges what is missing and removes nothing",
    );
    expect(lines).not.toContain(EDIT_PASS);
    expect(EDIT_ASK_RULES).toEqual(["Edit(/tools/agent-workflow/**)"]);
  });

  it("notes a hook registered twice in one file, which then runs twice", () => {
    const twice = { hooks: { PreToolUse: [createGroup(`${CLAUDE_HOOK} ${RETIRED_ARGUMENT}`, "Bash", 30), createGroup(CLAUDE_HOOK, "Bash", 5)] } };
    const { status, lines } = runCheck(createProject({ ".claude/settings.json": twice }));

    expect(status).toBe(0);
    expect(lines).toContain("NOTE Claude Code: .claude/settings.json registers the hook 2 times, so it runs that often before each command. Keep one");
    expect(runCheck(createProject()).lines.join("\n")).not.toContain("registers the hook");
  });

  it("says a command is usable once the add-on it needs is recorded", () => {
    const { lines } = runCheck(createProject({ installed: ["kit", "agent-workflow", "coverage"] }));

    expect(lines).toContain("PASS command /workflow:coverage-backfill");
    expect(lines.join("\n")).toContain('NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on');
  });

  it("asks the hook the way a host does: a plain Bash call that runs in the project, in the mode that asks", () => {
    const root = createProject();
    const payloads: unknown[] = [];
    const args: string[][] = [];

    runCheck(root, { payloads, args });

    expect(payloads).toHaveLength(6);
    expect(args).toEqual([[], [RETIRED_ARGUMENT], [], [RETIRED_ARGUMENT], [], [RETIRED_ARGUMENT]]);
    expect(payloads[0]).toEqual({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m wip && git push" }, cwd: root, permission_mode: "default" });
    expect(new Set(payloads.map((payload) => JSON.stringify(Object.keys(payload as object))))).toEqual(new Set(['["tool_name","tool_input","cwd","permission_mode"]']));
  });

  it.each([
    ["does not refuse the chain", { refused: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A && git commit -m wip && git push` started with no argument answered "none", not "deny"$/],
    ["does not refuse the chain when started as before", { refusedAsBefore: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A .*` started with --host=claude-code answered "none", not "deny"$/],
    ["allows a chain", { refused: { status: 0, stdout: ALLOW } }, /answered "allow", which it must never answer, not "deny"$/],
    ["crashes after it replied", { refused: { status: 1, stdout: DENY } }, /answered "broken", not "deny"$/],
    ["prints something that is no answer", { refused: { status: 0, stdout: "refused" } }, /answered "broken", not "deny"$/],
    ["prints a decision that is no text", { refused: { status: 0, stdout: DENY.replace('"deny"', "1") } }, /answered "broken", not "deny"$/],
    ["prints a decision it does not have", { refused: { status: 0, stdout: DENY.replace("deny", "maybe") } }, /answered "maybe", which it must never answer, not "deny"$/],
    ["asks about the chain", { refused: { status: 0, stdout: ASK } }, /answered "ask", which it must never answer, not "deny"$/],
    ["allows a push to main", { unanswered: { status: 0, stdout: ALLOW } }, /^FAIL hook: `git push origin main` started with no argument answered "allow", which it must never answer, not "none"$/],
    ["refuses a push to main", { unanswered: { status: 0, stdout: DENY } }, /^FAIL hook: `git push origin main` .* answered "deny", not "none"$/],
    ["allows the routine push", { routine: { status: 0, stdout: ALLOW } }, new RegExp(`^FAIL hook: ${ROUTINE} started with no argument answered "allow", which it must never answer, not "none"$`)],
    ["asks about the routine push", { routine: { status: 0, stdout: ASK } }, new RegExp(`^FAIL hook: ${ROUTINE} started with no argument answered "ask", which it must never answer, not "none"$`)],
    ["allows the routine push when started as before", { routineAsBefore: { status: 0, stdout: ALLOW } }, new RegExp(`^FAIL hook: ${ROUTINE} started with --host=claude-code answered "allow", which it must never answer, not "none"$`)],
  ])("fails when the hook %s", (_name, replies, message) => {
    const { status, lines } = runCheck(createProject(), replies);

    expect(status).toBe(1);
    expect(lines[0]).toMatch(message);
    expect(lines.join("\n")).not.toContain("PASS hook");
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

  it("notes ask rules the project took out, and does not fail while no allow rule allows by pattern", () => {
    const { status, lines } = runCheck(createProject({ ask: [...ASK_RULES.slice(2), ...EDIT_ASK_RULES], allow: ["Bash(pnpm test)", "Bash(git push origin worktree-fix)"] }));

    expect(status).toBe(0);
    expect(lines).toContain(
      "NOTE Claude Code: 2 of 13 ask rules are not in permissions.ask. No allow rule lets a push or a merge run by pattern, so those forms ask anyway",
    );
  });

  it.each(["Bash(git push origin worktree-*)", "Bash(git push *)", "Bash(gh pr merge *)", "Bash(gh pr create *)"])(
    "notes an allow rule with a star for a push, a pull request opened or a merge: %s",
    (rule) => {
      const { status, lines } = runCheck(createProject({ allow: [rule] }));

      expect(status).toBe(0);
      expect(lines.join("\n")).toContain(`NOTE Claude Code: the allow rule ${rule} lets more run unasked than its words say`);
    },
  );

  it("fails when such a rule is there and an ask rule that backs it is not", () => {
    const { status, lines } = runCheck(createProject({ allow: ["Bash(git push origin worktree-*)"], ask: [...ASK_RULES, ...EDIT_ASK_RULES].filter((rule) => rule !== "Bash(git push *--mirror*)") }));

    expect(status).toBe(1);
    expect(lines.join("\n")).toMatch(
      /FAIL Claude Code: Bash\(git push origin worktree-\*\) allows by pattern, and a forced or destructive form is not set to ask\. Missing from permissions\.ask: Bash\(git push \*--mirror\*\)/,
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

describe("an allow rule that allows by pattern", () => {
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
  /** A file's content, or undefined for a file that is not there. Overrides what the project would have. */
  [path: `.${string}` | `tools/${string}`]: unknown;
}

function createProject(shape: ProjectShape = {}): string {
  const files: Record<string, unknown> = {
    ".claude/settings.json": {
      permissions: { allow: shape.allow ?? [], ask: shape.ask ?? [...ASK_RULES, ...EDIT_ASK_RULES] },
      hooks: { PreToolUse: [createGroup(CLAUDE_HOOK, "Bash", 5)] },
    },
    ".codex/hooks.json": { hooks: { PreToolUse: [createGroup(CODEX_HOOK, "Bash")] } },
    "tools/installed.json": Object.fromEntries((shape.installed ?? ["kit", "agent-workflow"]).map((unit) => [unit, { files: {} }])),
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
  /** Every payload the check gave the hook is added here, and what it was started with. */
  payloads?: unknown[];
  args?: string[][];
  refused?: HookReply;
  refusedAsBefore?: HookReply;
  unanswered?: HookReply;
  routine?: HookReply;
  routineAsBefore?: HookReply;
}

/** Runs the check with a hook that answers as the real one does, unless `replies` says otherwise. */
function runCheck(root: string, replies: Replies = {}): { status: number; lines: string[] } {
  const lines: string[] = [];
  const nothing = { status: 0, stdout: "" };
  const runHook: CheckOptions["runHook"] = (payload, args) => {
    replies.payloads?.push(payload);
    replies.args?.push(args);

    const command = (payload as { tool_input: { command: string } }).tool_input.command;
    const asBefore = args.includes(RETIRED_ARGUMENT);

    if (command.includes("&&")) {
      return (asBefore ? replies.refusedAsBefore : replies.refused) ?? { status: 0, stdout: DENY };
    }

    if (command.includes("worktree-sample")) {
      return (asBefore ? replies.routineAsBefore : replies.routine) ?? nothing;
    }

    return replies.unanswered ?? nothing;
  };

  return { status: check({ root, runHook, report: (line) => lines.push(line) }), lines };
}

function runRequires(root: string, addon: string | undefined): { status: number; lines: string[] } {
  const lines: string[] = [];

  return { status: requires(root, addon, (line) => lines.push(line)), lines };
}

function createGroup(command: string, matcher?: string, timeout?: number): unknown {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }] };
}
