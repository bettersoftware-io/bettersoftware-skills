#!/usr/bin/env node
// Proves the agent-workflow add-on is in place in this project.
//
//   node tools/agent-workflow/check.mts
//
// It runs the hook on three commands: one it must refuse, one it must leave
// to the host, and one routine step that it approves when approval is on and
// the host is Claude Code, and never otherwise. Then it reads each host's
// settings file to see that the hook is registered there.
//
// A host's settings file belongs to the project, and so does the setting
// that turns approval off. What the project chose is reported as a NOTE.
// These are failures: the hook does not behave; it is not registered in a
// settings file that exists; Codex would be sent an approval; an `allow`
// rule with a `*` pre-approves a push or a merge while the `ask` rules that
// catch a forced or destructive one are missing.
//
// Exit 0: nothing failed. Exit 1: a FAIL line says what and how to fix it.
// Exit 2: no host settings file exists, so there was nothing to judge.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPROVING_HOST, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, COMMAND_NEEDS, CONFIG_FILE, HOOK_SCRIPT, WIDE_ALLOW } from "./lib/host.mts";
import { isMainModule } from "./lib/main.mts";
import { installedIn } from "./requires.mts";

const REFUSED_SAMPLE = "git add -A && git commit -m wip && git push";
const UNANSWERED_SAMPLE = "git push origin main";
const APPROVED_SAMPLE = "git push -u origin worktree-sample 2>&1 | tail -2";
const FIX = "Run the installer again (add-to-project.mts <project> agent-workflow): it merges what is missing and removes nothing";

type Settings = Record<string, unknown>;
type Decision = "deny" | "allow" | "none" | "broken";

export interface CheckOptions {
  root: string;
  /** Runs the hook with a payload on its standard input, started with `args`. */
  runHook: (payload: unknown, args: string[]) => { status: number; stdout: string };
  report: (line: string) => void;
}

export function check({ root, runHook, report }: CheckOptions): number {
  let failed = false;
  let judged = 0;
  const fail = (line: string): void => {
    failed = true;
    report(`FAIL ${line}`);
  };
  const ask = (command: string, args: string[]): Decision => decisionOf(runHook({ tool_name: "Bash", tool_input: { command } }, args));
  const asClaude = [APPROVING_HOST];
  const asCodex: string[] = [];

  // What the hook must do whatever the project chose.
  const fixed: [string, string[], Decision][] = [
    [REFUSED_SAMPLE, asClaude, "deny"],
    [REFUSED_SAMPLE, asCodex, "deny"],
    [UNANSWERED_SAMPLE, asClaude, "none"],
    [UNANSWERED_SAMPLE, asCodex, "none"],
    [APPROVED_SAMPLE, asCodex, "none"],
  ];
  const wrong = fixed.map(([command, args, expected]) => ({ command, args, expected, got: ask(command, args) })).filter(({ expected, got }) => got !== expected);
  const approval = ask(APPROVED_SAMPLE, asClaude);

  for (const { command, args, expected, got } of wrong) {
    fail(`hook: \`${command}\` started ${args.length === 0 ? "with no argument" : `with ${args.join(" ")}`} answered "${got}", not "${expected}"`);
  }

  if (wrong.length === 0) {
    report("PASS hook: refuses an outward step joined to others, says nothing about a push to main, and never approves without --host=claude-code");
  }

  if (approval === "allow") {
    report(`PASS approval: on. In Claude Code a routine step in its exact form runs without a prompt (turn it off in ${CONFIG_FILE})`);
  } else if (approval === "none") {
    report(
      existsSync(join(root, CONFIG_FILE))
        ? `NOTE approval: off. ${CONFIG_FILE} does not set approveExactShapes to true, so every push and pull request step asks. That is the project's choice`
        : `NOTE approval: off. There is no ${CONFIG_FILE}, so nothing is approved and every push and pull request step asks`,
    );
  } else {
    fail(`hook: \`${APPROVED_SAMPLE}\` started with ${APPROVING_HOST} answered "${approval}"; it may only approve or say nothing`);
  }

  for (const [host, path] of [
    ["Claude Code", CLAUDE_SETTINGS],
    ["Codex", CODEX_HOOKS],
  ] as const) {
    const settings = readSettings(root, path);

    if (settings === "absent") {
      report(`SKIP ${host}: there is no ${path}, so the hook does not run there`);
      continue;
    }

    judged += 1;

    if (settings === "unreadable") {
      fail(`${host}: ${path} is not a JSON object, so the host reads no hook from it`);
      continue;
    }

    const registered = hookCommands(settings).filter((command) => command.includes(HOOK_SCRIPT));

    if (registered.length === 0) {
      fail(`${host}: ${path} does not register ${HOOK_SCRIPT} under hooks.PreToolUse. ${FIX}`);
    } else {
      report(`PASS ${host}: ${path} runs the hook before each shell command`);
    }

    const approving = registered.some((command) => command.includes(APPROVING_HOST));

    if (path === CODEX_HOOKS && approving) {
      fail(`${host}: ${path} starts the hook with ${APPROVING_HOST}. Codex does not take an approval from a hook: remove that argument there`);
    }

    if (path === CLAUDE_SETTINGS) {
      if (registered.length > 0 && !approving) {
        report(`NOTE ${host}: ${path} starts the hook without ${APPROVING_HOST}, so it approves nothing there`);
      }

      failed = judgePermissions(settings, report) || failed;
    }
  }

  const installed = installedIn(root) ?? [];

  for (const [command, needs] of Object.entries(COMMAND_NEEDS)) {
    if (!existsSync(join(root, ".claude/commands/workflow", `${command}.md`))) {
      fail(`command: .claude/commands/workflow/${command}.md is missing. ${FIX}`);
    } else if (needs !== undefined && !installed.includes(needs)) {
      report(`NOTE command /workflow:${command}: needs the "${needs}" add-on, which this project does not have. It stops and says so when run`);
    } else {
      report(`PASS command /workflow:${command}`);
    }
  }

  if (failed) {
    return 1;
  }

  if (judged === 0) {
    report(`SKIP agent-workflow: neither ${CLAUDE_SETTINGS} nor ${CODEX_HOOKS} exists, so no host runs the hook. That is not a pass. ${FIX}`);

    return 2;
  }

  return 0;
}

/** Reports on the permission rules. Returns true when something failed. */
function judgePermissions(settings: Settings, report: (line: string) => void): boolean {
  const permissions = (settings.permissions ?? {}) as { allow?: unknown; ask?: unknown };
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const ask = Array.isArray(permissions.ask) ? (permissions.ask as unknown[]) : [];
  const missingAsk = ASK_RULES.filter((rule) => !ask.includes(rule));
  const wide = allow.filter((rule): rule is string => typeof rule === "string" && WIDE_ALLOW.test(rule));

  for (const rule of wide) {
    report(`NOTE Claude Code: the allow rule ${rule} pre-approves more than its words say: a "*" also matches a second branch, another flag, a "$(…)". The hook approves the exact forms without it`);
  }

  if (missingAsk.length > 0 && wide.length > 0) {
    report(
      `FAIL Claude Code: ${wide.join(", ")} pre-approves by pattern, and a forced or destructive form is not set to ask. Missing from permissions.ask: ${missingAsk.join(", ")}. ${FIX}`,
    );

    return true;
  }

  report(
    missingAsk.length === 0
      ? `PASS Claude Code: all ${ASK_RULES.length} ask rules are in, so a forced or destructive push and an --admin merge ask whatever else allows them`
      : `NOTE Claude Code: ${missingAsk.length} of ${ASK_RULES.length} ask rules are not in permissions.ask. No allow rule pre-approves a push or a merge by pattern, so those forms ask anyway`,
  );

  return false;
}

/** What a run of the hook answered: its decision, nothing, or something that is neither. */
function decisionOf({ status, stdout }: { status: number; stdout: string }): Decision {
  if (status !== 0) {
    return "broken";
  }

  if (stdout.trim() === "") {
    return "none";
  }

  try {
    const decision = (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } }).hookSpecificOutput?.permissionDecision;

    return decision === "deny" || decision === "allow" ? decision : "broken";
  } catch {
    return "broken";
  }
}

function readSettings(root: string, path: string): Settings | "absent" | "unreadable" {
  const file = join(root, path);

  if (!existsSync(file)) {
    return "absent";
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Settings) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** Every command registered to run before a tool call. */
function hookCommands(settings: Settings): string[] {
  const groups = (settings.hooks as { PreToolUse?: unknown } | undefined)?.PreToolUse;

  return (Array.isArray(groups) ? groups : []).flatMap((group: { hooks?: unknown }) =>
    (Array.isArray(group?.hooks) ? group.hooks : []).flatMap((hook: { command?: unknown }) =>
      typeof hook?.command === "string" ? [hook.command] : [],
    ),
  );
}

/** Runs the shipped hook the way a host does: the payload on its standard input. */
export function createHookRunner(root: string): CheckOptions["runHook"] {
  return (payload, args) => {
    const file = join(root, HOOK_SCRIPT);

    if (!existsSync(file)) {
      return { status: 127, stdout: `${HOOK_SCRIPT} does not exist` };
    }

    const ran = spawnSync(process.execPath, [file, ...args], { cwd: root, input: JSON.stringify(payload), encoding: "utf8" });

    return { status: ran.status ?? 1, stdout: ran.stdout ?? "" };
  };
}

if (isMainModule(import.meta.url)) {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  process.exitCode = check({ root, runHook: createHookRunner(root), report: (line) => console.log(line) });
}
