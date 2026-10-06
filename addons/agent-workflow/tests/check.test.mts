import { describe, expect, it } from "vitest";

import { check, type CheckOptions, createHookRunner } from "../files/tools/agent-workflow/check.mts";
import { APPROVING_HOST, ASK_RULES, EDIT_ASK_RULES, WIDE_ALLOW } from "../files/tools/agent-workflow/lib/host.mts";
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
const ASK = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}\n';
const PUSH_ON = { approvePushAndCreate: true, approveMerge: false };
const BOTH_ON = { approvePushAndCreate: true, approveMerge: true };
const EDIT_PASS = "PASS Claude Code: an editing tool asks before it changes the hook or its setting (a shell command that writes them is not covered by any rule)";

describe("the add-on's check", () => {
  it("passes a project as the add-on leaves it: the hook in both hosts' settings, every ask rule in, and approval off", () => {
    const { status, lines } = runCheck(createProject());

    expect(status).toBe(0);
    expect(lines).toEqual([
      "PASS hook: refuses an outward step joined to others, says nothing about a push to main, and never approves without --host=claude-code",
      "NOTE approval: off. tools/agent-workflow.config.json sets neither approvePushAndCreate nor approveMerge to true, so every push and pull request step asks. That is the shipped default",
      "PASS Claude Code: .claude/settings.json runs the hook before each shell command",
      EDIT_PASS,
      "PASS Claude Code: all 13 ask rules are in, so a forced or destructive push and an --admin merge ask whatever else allows them",
      "PASS Codex: .codex/hooks.json runs the hook before each shell command",
      "PASS command /workflow:changelog",
      'NOTE command /workflow:coverage-backfill: needs the "coverage" add-on, which this project does not have. It stops and says so when run',
      'NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on, which this project does not have. It stops and says so when run',
    ]);
  });

  it.each([
    ["a push and a pull request opened", PUSH_ON, "a push of a worktree- branch to origin; gh pr create for one"],
    ["a merge", { approveMerge: true }, "gh pr merge of a pull request that is this checkout's own branch at the commit the command names"],
    [
      "both",
      BOTH_ON,
      "a push of a worktree- branch to origin; gh pr create for one; gh pr merge of a pull request that is this checkout's own branch at the commit the command names",
    ],
  ])("says what runs without a prompt, and what then stands before the default branch, once the project turns on %s", (_name, setting, what) => {
    // With the push approval on the real hook asks about the sample, whose branch does not exist. With it off it says nothing.
    const { status, lines } = runCheck(createProject({ setting }), { approved: { status: 0, stdout: "approvePushAndCreate" in setting ? ASK : "" } });

    expect(status).toBe(0);
    expect(lines[1]).toBe(
      `NOTE approval: on, by the project's choice in tools/agent-workflow.config.json. In Claude Code these run without a prompt when the checkout is plain: ${what}. Branch protection on the remote is then what stands between an instruction injected into the agent and the default branch`,
    );
  });

  it("takes an approval of the sample, or a question about it, from a hook whose push approval is on", () => {
    expect(runCheck(createProject({ setting: PUSH_ON }), { approved: { status: 0, stdout: ALLOW } }).status).toBe(0);
    expect(runCheck(createProject({ setting: PUSH_ON }), { approved: { status: 0, stdout: ASK } }).status).toBe(0);
  });

  it.each([
    ["approves the routine step while the setting is off", {}, ALLOW, "allow", "off", '"none"'],
    ["asks about the routine step while the setting is off", {}, ASK, "ask", "off", '"none"'],
    ["approves a push while only the merge is on", { approveMerge: true }, ALLOW, "allow", "off", '"none"'],
    ["says nothing about the routine step while the setting is on", PUSH_ON, "", "none", "on", '"ask" or "allow"'],
    ["refuses the routine step", PUSH_ON, DENY, "deny", "on", '"ask" or "allow"'],
  ])("fails when the hook %s", (_name, setting, stdout, answered, state, allowed) => {
    const { status, lines } = runCheck(createProject({ setting }), { approved: { status: 0, stdout } });

    expect(status).toBe(1);
    expect(lines).toContain(
      `FAIL hook: \`git push -u origin worktree-sample 2>&1 | tail -2\` started with --host=claude-code answered "${answered}" with approvePushAndCreate ${state}; it may only answer ${allowed}`,
    );
  });

  it("says the old setting file is no longer read, when a project still has one", () => {
    const { status, lines } = runCheck(createProject({ "tools/agent-workflow.config.mts": "export const approveExactShapes: boolean = true;\n" }));

    expect(status).toBe(0);
    expect(lines[1]).toMatch(/^NOTE approval: off\./);
    expect(lines[2]).toBe(
      "NOTE setting: tools/agent-workflow.config.mts is no longer read, and nothing in it turns an approval on. The setting is tools/agent-workflow.config.json. Delete the old file",
    );
    expect(runCheck(createProject()).lines.join("\n")).not.toContain("no longer read");
  });

  it("fails when an approval is on and the rules that ask before the hook or its setting is edited are not in", () => {
    const { status, lines } = runCheck(createProject({ setting: BOTH_ON, ask: [...ASK_RULES, EDIT_ASK_RULES[0] as string] }), { approved: { status: 0, stdout: ASK } });

    expect(status).toBe(1);
    expect(lines).toContain(
      `FAIL Claude Code: an approval is on, and an editing tool may change the hook or its setting without asking. Missing from permissions.ask: Edit(/tools/agent-workflow.config.json). Run the installer again (add-to-project.mts <project> agent-workflow): it merges what is missing and removes nothing`,
    );
    expect(lines).not.toContain(EDIT_PASS);
  });

  it("fails the same with the merge alone on", () => {
    expect(runCheck(createProject({ setting: { approveMerge: true }, ask: ASK_RULES })).status).toBe(1);
  });

  it("only notes those rules missing while approval is off", () => {
    const { status, lines } = runCheck(createProject({ ask: ASK_RULES }));

    expect(status).toBe(0);
    expect(lines).toContain(
      "NOTE Claude Code: Edit(/tools/agent-workflow/**), Edit(/tools/agent-workflow.config.json) are not in permissions.ask, so an editing tool may change the hook or its setting without asking. Approval is off, so nothing depends on them yet",
    );
    expect(runCheck(createProject({ ask: [...ASK_RULES, EDIT_ASK_RULES[1] as string] })).lines.join("\n")).toContain("NOTE Claude Code: Edit(/tools/agent-workflow/**) is not in permissions.ask");
  });

  it("notes a time limit too short for the merge check, when the merge is approved", () => {
    const short = createProject({ setting: BOTH_ON, claudeTimeout: 5 });
    const note =
      "NOTE Claude Code: .claude/settings.json gives the hook 5 seconds. A merge is checked by asking GitHub, which may take longer; the hook is then stopped and the merge asks. Set its timeout to 30";

    expect(runCheck(short, { approved: { status: 0, stdout: ASK } }).lines).toContain(note);
    expect(runCheck(createProject({ setting: BOTH_ON, claudeTimeout: 30 }), { approved: { status: 0, stdout: ASK } }).lines.join("\n")).not.toContain("gives the hook");
    expect(runCheck(createProject({ setting: PUSH_ON, claudeTimeout: 5 }), { approved: { status: 0, stdout: ASK } }).lines.join("\n")).not.toContain("gives the hook");
  });

  it("says a command is usable once the add-on it needs is recorded", () => {
    const { lines } = runCheck(createProject({ installed: ["kit", "agent-workflow", "coverage"] }));

    expect(lines).toContain("PASS command /workflow:coverage-backfill");
    expect(lines.join("\n")).toContain('NOTE command /workflow:visual-tolerance-audit: needs the "visual" add-on');
  });

  it("says approval is not possible yet in a folder that is in no repository, when the setting is on", () => {
    const { status, lines } = runCheck(createProject({ setting: PUSH_ON }), { repository: false });

    expect(status).toBe(0);
    expect(lines[1]).toMatch(/^NOTE approval: not possible yet\. .* is not in a git repository, and the hook approves only in a checkout or a worktree of the project's own\. Run git init, then this again$/);
    expect(runCheck(createProject(), { repository: false }).lines[1]).toMatch(/^NOTE approval: off\./);
  });

  it("fails a hook that approves in a folder that is in no repository", () => {
    const { status, lines } = runCheck(createProject({ setting: PUSH_ON }), { approved: { status: 0, stdout: ALLOW }, repository: false });

    expect(status).toBe(1);
    expect(lines.join("\n")).not.toContain("not possible yet");
  });

  it("asks the hook the way a host does: a plain Bash call that runs in the project, in the mode that asks", () => {
    const root = createProject();
    const payloads: unknown[] = [];

    runCheck(root, { payloads });

    expect(payloads).toHaveLength(6);
    expect(payloads[0]).toEqual({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m wip && git push" }, cwd: root, permission_mode: "default" });
    expect(new Set(payloads.map((payload) => JSON.stringify(Object.keys(payload as object))))).toEqual(new Set(['["tool_name","tool_input","cwd","permission_mode"]']));
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "export const approvePushAndCreate = true;\n"],
  ])("reads a setting file that is %s as approval off", (_name, setting) => {
    const { status, lines } = runCheck(createProject({ setting }));

    expect(status).toBe(0);
    expect(lines[1]).toMatch(setting === undefined ? /^NOTE approval: off\. There is no tools\/agent-workflow\.config\.json, so nothing is approved/ : /^NOTE approval: off\. tools\/agent-workflow\.config\.json sets neither/);
  });

  it.each([
    ["does not refuse the chain", { refused: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A && git commit -m wip && git push` started with --host=claude-code answered "none", not "deny"$/],
    ["does not refuse the chain for Codex", { refusedForCodex: { status: 0, stdout: "" } }, /^FAIL hook: `git add -A .*` started with no argument answered "none", not "deny"$/],
    ["approves a chain", { refused: { status: 0, stdout: ALLOW } }, /answered "allow", not "deny"$/],
    ["crashes after it replied", { refused: { status: 1, stdout: DENY } }, /answered "broken", not "deny"$/],
    ["prints something that is no answer", { refused: { status: 0, stdout: "refused" } }, /answered "broken", not "deny"$/],
    ["prints a decision it does not have", { refused: { status: 0, stdout: DENY.replace("deny", "maybe") } }, /answered "broken", not "deny"$/],
    ["asks about the chain", { refused: { status: 0, stdout: ASK } }, /answered "ask", not "deny"$/],
    ["approves a push to main", { unanswered: { status: 0, stdout: ALLOW } }, /^FAIL hook: `git push origin main` started with --host=claude-code answered "allow", not "none"$/],
    ["refuses a push to main", { unanswered: { status: 0, stdout: DENY } }, /^FAIL hook: `git push origin main` .* answered "deny", not "none"$/],
    ["approves for Codex", { approvedForCodex: { status: 0, stdout: ALLOW } }, /^FAIL hook: `git push -u origin worktree-sample 2>&1 \| tail -2` started with no argument answered "allow", not "none"$/],
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
    const { status, lines } = runCheck(createProject({ ask: [...ASK_RULES.slice(2), ...EDIT_ASK_RULES], allow: ["Bash(pnpm test)", "Bash(git push origin worktree-fix)"] }));

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
    const { status, lines } = runCheck(createProject({ allow: ["Bash(git push origin worktree-*)"], ask: [...ASK_RULES, ...EDIT_ASK_RULES].filter((rule) => rule !== "Bash(git push *--mirror*)") }));

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
  /** The time limit Claude Code's settings give the hook, in seconds. None unless said. */
  claudeTimeout?: number;
  /** What the setting file holds: an object, text as it is, or undefined for no file. The shipped one (both off) unless said. */
  setting?: unknown;
  /** A file's content, or undefined for a file that is not there. Overrides what the project would have. */
  [path: `.${string}` | `tools/${string}`]: unknown;
}

function createProject(shape: ProjectShape = {}): string {
  const files: Record<string, unknown> = {
    ".claude/settings.json": {
      permissions: { allow: shape.allow ?? [], ask: shape.ask ?? [...ASK_RULES, ...EDIT_ASK_RULES] },
      hooks: { PreToolUse: [createGroup(shape.claudeHook ?? CLAUDE_HOOK, "Bash", shape.claudeTimeout)] },
    },
    ".codex/hooks.json": { hooks: { PreToolUse: [createGroup(CODEX_HOOK, "Bash")] } },
    "tools/installed.json": Object.fromEntries((shape.installed ?? ["kit", "agent-workflow"]).map((unit) => [unit, { files: {} }])),
    "tools/agent-workflow.config.json": "setting" in shape ? shape.setting : { approvePushAndCreate: false, approveMerge: false },
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
      return forClaude ? (replies.approved ?? nothing) : (replies.approvedForCodex ?? nothing);
    }

    return replies.unanswered ?? nothing;
  };

  return { status: check({ root, runHook, isRepository: () => replies.repository ?? true, report: (line) => lines.push(line) }), lines };
}

function runRequires(root: string, addon: string | undefined): { status: number; lines: string[] } {
  const lines: string[] = [];

  return { status: requires(root, addon, (line) => lines.push(line)), lines };
}

function createGroup(command: string, matcher?: string, timeout?: number): unknown {
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }] };
}
