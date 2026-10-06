#!/usr/bin/env node
// Proves the agent-workflow add-on is in place in this project.
//
//   node tools/agent-workflow/check.mts
//
// It runs the hook on two commands, one it must refuse and one it must let
// through, and then reads each host's settings file to see that the hook is
// registered there and, for Claude Code, that the permission rules are in.
//
// A host's settings file belongs to the project. A missing "allow" rule is
// therefore reported as a NOTE, not a failure: the project may prefer to be
// asked. Two things are failures: the hook is not registered in a settings
// file that exists, and a push is pre-approved while a forced push is not
// set to ask.
//
// Exit 0: nothing failed. Exit 1: a FAIL line says what and how to fix it.
// Exit 2: no host settings file exists, so there was nothing to judge.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOW_RULES, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, COMMAND_NEEDS, HOOK_SCRIPT } from "./lib/host.mts";
import { isMainModule } from "./lib/main.mts";
import { installedIn } from "./requires.mts";

const REFUSED_SAMPLE = "git add -A && git commit -m wip && git push";
const ALLOWED_SAMPLE = "git push -u origin worktree-sample 2>&1 | tail -2";
const FIX = "Run the installer again (add-to-project.mts <project> agent-workflow): it merges what is missing and removes nothing";

type Settings = Record<string, unknown>;

export interface CheckOptions {
  root: string;
  /** Runs the hook with a payload on its standard input. */
  runHook: (payload: unknown) => { status: number; stdout: string };
  report: (line: string) => void;
}

export function check({ root, runHook, report }: CheckOptions): number {
  let failed = false;
  let judged = 0;
  const fail = (line: string): void => {
    failed = true;
    report(`FAIL ${line}`);
  };

  const refused = runHook({ tool_name: "Bash", tool_input: { command: REFUSED_SAMPLE } });
  const allowed = runHook({ tool_name: "Bash", tool_input: { command: ALLOWED_SAMPLE } });

  if (refused.status !== 0 || !refused.stdout.includes('"permissionDecision":"deny"')) {
    fail(`hook: it did not refuse \`${REFUSED_SAMPLE}\` (exit ${refused.status}, printed ${JSON.stringify(refused.stdout.trim())})`);
  } else if (allowed.status !== 0 || allowed.stdout.trim() !== "") {
    fail(`hook: it did not let \`${ALLOWED_SAMPLE}\` through (exit ${allowed.status}, printed ${JSON.stringify(allowed.stdout.trim())})`);
  } else {
    report("PASS hook: refuses an outward step joined to others, lets a lone one through");
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

    if (hookCommands(settings).some((command) => command.includes(HOOK_SCRIPT))) {
      report(`PASS ${host}: ${path} runs the hook before each shell command`);
    } else {
      fail(`${host}: ${path} does not register ${HOOK_SCRIPT} under hooks.PreToolUse. ${FIX}`);
    }

    if (path === CLAUDE_SETTINGS) {
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
  const missingAllow = ALLOW_RULES.filter((rule) => !allow.includes(rule));
  const missingAsk = ASK_RULES.filter((rule) => !ask.includes(rule));
  const preApprovedPushes = allow.filter((rule) => typeof rule === "string" && rule.startsWith("Bash(git push"));

  for (const rule of missingAllow) {
    report(`NOTE Claude Code: ${rule} is not in permissions.allow, so that step asks each time. That is the project's choice`);
  }

  if (missingAsk.length > 0 && preApprovedPushes.length > 0) {
    report(
      `FAIL Claude Code: a push is pre-approved (${preApprovedPushes.join(", ")}) and a forced push is not set to ask. Missing from permissions.ask: ${missingAsk.join(", ")}. ${FIX}`,
    );

    return true;
  }

  report(
    missingAsk.length === 0
      ? `PASS Claude Code: ${ALLOW_RULES.length - missingAllow.length} of ${ALLOW_RULES.length} routine steps pre-approved, a forced push always asks`
      : "PASS Claude Code: no push is pre-approved, so every push asks",
  );

  return false;
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
  return (payload) => {
    const file = join(root, HOOK_SCRIPT);

    if (!existsSync(file)) {
      return { status: 127, stdout: `${HOOK_SCRIPT} does not exist` };
    }

    const ran = spawnSync(process.execPath, [file], { cwd: root, input: JSON.stringify(payload), encoding: "utf8" });

    return { status: ran.status ?? 1, stdout: ran.stdout ?? "" };
  };
}

if (isMainModule(import.meta.url)) {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  process.exitCode = check({ root, runHook: createHookRunner(root), report: (line) => console.log(line) });
}
