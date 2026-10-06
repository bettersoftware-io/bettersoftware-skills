#!/usr/bin/env node
// PreToolUse hook: refuses a shell command that joins an outward step (a
// push, a pull request written to, a workflow started) to anything else.
//
// Why: a host judges a joined command as a whole. `git add -A && git commit
// -m … && git push && gh pr create` raises one prompt, labelled with its
// first word, so the person sees "git add needs permission", the local steps
// wait on the outward one, and one approval covers actions the prompt never
// showed. An outward step therefore runs as a call of its own, at the start
// or the end of a piece of work.
//
// A pipe into a filter (`git push 2>&1 | tail -2`) is still one step and is
// let through. So is `gh pr create --body "$(cat <<'EOF' … EOF)"`: the inner
// command only feeds the outer one.
//
// A command this cannot read (a quote that never closes) is let through: the
// host's own permission rules still judge it. This hook orders the work; it
// is not what keeps a push from happening.
//
// Works under Claude Code (the `Bash` tool: `tool_input.command` is text) and
// Codex (its shell tool: the same field, as text or as a list of words). Both
// read the same reply: `permissionDecision: "deny"` with a reason, on stdout.

import { readFileSync } from "node:fs";

import { isMainModule } from "../lib/main.mts";
import { judgeCommand } from "../lib/outward.mts";

/** The fields both hosts send that this hook reads. */
export interface CommandPayload {
  tool_name?: string;
  tool_input?: { command?: unknown };
}

/** The command line a tool call will run, from either host's payload. */
export function commandOf(payload: CommandPayload): string | undefined {
  const command = payload.tool_input?.command;

  if (typeof command === "string") {
    return command;
  }

  if (Array.isArray(command) && command.every((word) => typeof word === "string")) {
    // Words, already split: quote each one so that it is read back as one.
    return (command as string[]).map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  }

  return undefined;
}

/** The reason to refuse the call, or undefined to let it through. */
export function judgeCall(payload: CommandPayload): string | undefined {
  const command = commandOf(payload);
  const verdict = command === undefined ? undefined : judgeCommand(command);

  if (verdict === undefined || !verdict.chained) {
    return undefined;
  }

  return [
    `Refused: this command joins an outward step (${verdict.outward.join(", ")}) to other commands.`,
    "Run each outward step (git push, gh pr create or merge, gh workflow run, a gh api write) as a tool call of its own,",
    "and put those calls together at the start or the end of the work. Local steps (git add, git commit, tests) go in separate calls.",
    "Split the command. Do not reword it to get past this check.",
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  const reason = judgeCall(JSON.parse(readFileSync(0, "utf8") || "{}") as CommandPayload);

  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      }),
    );
  }
}
