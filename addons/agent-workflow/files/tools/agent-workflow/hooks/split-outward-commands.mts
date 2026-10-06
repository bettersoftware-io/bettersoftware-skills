#!/usr/bin/env node
// PreToolUse hook, with one answer: a refusal.
//
// It refuses a shell command that joins an outward step (a push, a pull
// request written to, a workflow started) to anything else.
//
// Why: a host judges a joined command as a whole. `git add -A && git commit
// -m … && git push && gh pr create` raises one prompt, labelled with its
// first word, so the person sees "git add needs permission", the local steps
// wait on the outward one, and one yes covers actions the prompt never
// showed. An outward step therefore runs as a call of its own, at the start
// or the end of a piece of work.
//
// A pipe into a filter (`git push 2>&1 | tail -2`) is still one step and is
// let through. So is `gh pr create --body "$(cat <<'EOF' … EOF)"`: the inner
// command only feeds the outer one.
//
// A command this cannot read (a quote that never closes) is not refused: the
// host's own permission rules still judge it. The refusal orders the work;
// it is not what keeps a push from happening. A command this will not read
// (longer than a million characters, or nested more than forty deep) is
// refused when it holds the word `push` or `gh` at all, and so is a command
// the reader fails on: a chain must not get through because it was written
// to be hard to read.
//
// For any other command it says nothing, and the host asks as it always does.
// It never says yes to a command, and it never asks about one: `Answer` has
// no such decision. The README says why, under "Why the hook does not approve
// anything".
//
// It reads standard input and nothing else: no file, no setting, no start-up
// argument, and it starts no program. An argument it is given is ignored, so
// a settings file that still starts it with one from an older version works.
//
// It never ends without an answer it meant to give: whatever fails inside
// it, it says nothing and exits 0.
//
// Works under Claude Code (the `Bash` tool: `tool_input.command` is text) and
// Codex (its shell tool: the same field, as text or as a list of words). Both
// read the same reply: `permissionDecision` with a reason, on stdout.

import { readFileSync } from "node:fs";

import { isMainModule } from "../lib/main.mts";
import { judgeCommand, mentionsOutward, type Verdict } from "../lib/outward.mts";

/** The fields both hosts send that this hook reads. */
export interface CommandPayload {
  tool_name?: string;
  tool_input?: { command?: unknown; [field: string]: unknown };
}

/** The one thing the hook ever says. To let a call through it says nothing. */
export interface Answer {
  decision: "deny";
  reason: string;
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

/** The refusal to give the host, or undefined to say nothing and leave the call to its own rules. */
export function judgeCall(payload: CommandPayload): Answer | undefined {
  const command = commandOf(payload);
  let verdict: Verdict | undefined;

  try {
    verdict = command === undefined ? undefined : judgeCommand(command);
  } catch {
    // Not read: too long, nested too deep, or the reader itself failed. A chain must not pass for that.
    return command !== undefined && mentionsOutward(command)
      ? {
          decision: "deny",
          reason: [
            "Refused: this command is too long or too deeply nested to be read, and it names an outward step (push, gh).",
            "Run each outward step as a short tool call of its own, with nothing else in it.",
          ].join("\n"),
        }
      : undefined;
  }

  return verdict?.chained
    ? {
        decision: "deny",
        reason: [
          `Refused: this command joins an outward step (${verdict.outward.join(", ")}) to other commands.`,
          "Run each outward step (git push, gh pr create or merge, gh workflow run, a gh api write) as a tool call of its own,",
          "and put those calls together at the start or the end of the work. Local steps (git add, git commit, tests) go in separate calls.",
          "Split the command. Do not reword it to get past this check.",
        ].join("\n"),
      }
    : undefined;
}

/** The reply for one payload, as the text to print. Empty when there is nothing to say. */
export function replyTo(input: string): string {
  let answer: Answer | undefined;

  try {
    answer = judgeCall(JSON.parse(input) as CommandPayload);
  } catch {
    // A payload that is not JSON, or anything nobody foresaw: no answer.
    return "";
  }

  return answer === undefined
    ? ""
    : JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: answer.decision, permissionDecisionReason: answer.reason } });
}

if (isMainModule(import.meta.url)) {
  let reply = "";

  try {
    reply = replyTo(readFileSync(0, "utf8"));
  } catch {
    // Standard input could not be read. There is nothing to judge.
  }

  if (reply !== "") {
    console.log(reply);
  }
}
