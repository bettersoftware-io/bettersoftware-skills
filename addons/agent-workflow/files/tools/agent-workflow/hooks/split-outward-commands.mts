#!/usr/bin/env node
// PreToolUse hook, with two answers.
//
// It refuses a shell command that joins an outward step (a push, a pull
// request written to, a workflow started) to anything else.
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
// A command this cannot read (a quote that never closes) is not refused: the
// host's own permission rules still judge it. The refusal orders the work;
// it is not what keeps a push from happening. A command this will not read
// (longer than a million characters, or nested more than forty deep) is
// refused when it holds the word `push` or `gh` at all, and so is a command
// the reader fails on: a chain must not get through because it was written
// to be hard to read.
//
// And it can approve a call that is exactly one routine outward step in
// exactly one of the forms in `lib/approve.mts`, so that the closing steps of
// a piece of work do not each wait for a person. Both approvals are off until
// the project turns them on. It approves only when all of these hold:
//
//   - the project's setting says so: `approvePushAndCreate` for a push and
//     for `gh pr create`, `approveMerge` for `gh pr merge`, each a literal
//     `true` in `tools/agent-workflow.config.json`. The file is read as data.
//     If it is missing or cannot be read, nothing is approved.
//   - it was started with `--host=claude-code`. Claude Code's settings start
//     it so; Codex's do not. Claude Code checks its `deny` and `ask` rules
//     whatever a hook answers, so an approval never overrides a rule. Codex
//     does not take an approval from a hook, so it is never sent one.
//   - the call itself is one that may be approved (`lib/call.mts`): the tool
//     is `Bash`, its input has no field that changes how or where the
//     command runs, the session is in a mode that asks before a command, and
//     it runs in a checkout or a worktree of the repository this file sits in.
//   - git, asked in that checkout, has nothing that would make the step do
//     other than its words say (`lib/push.mts`), and for a merge GitHub says
//     the pull request is this checkout's own work (`lib/pull-request.mts`).
//
// When the words are an exact form and that last check fails, the answer is
// "ask", with the reason: the person is asked as they would have been, and
// is told what is unusual about this checkout.
//
// For any other command it says nothing, and the host asks as it always does.
//
// It never ends without an answer it meant to give: whatever fails inside it,
// it approves nothing and exits 0.
//
// Works under Claude Code (the `Bash` tool: `tool_input.command` is text) and
// Codex (its shell tool: the same field, as text or as a list of words). Both
// read the same reply: `permissionDecision` with a reason, on stdout.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readShape, type Shape } from "../lib/approve.mts";
import { approvableCommand } from "../lib/call.mts";
import { isMainModule } from "../lib/main.mts";
import { judgeCommand, mentionsOutward, type Verdict } from "../lib/outward.mts";
import { createAsk, mergeObstacle } from "../lib/pull-request.mts";
import { obstacle } from "../lib/push.mts";
import { isCheckoutOf } from "../lib/repository.mts";
import { readSettings, type Settings } from "../lib/settings.mts";

/** The start-up argument that says the host takes an approval from a hook. */
export const APPROVING_HOST = "--host=claude-code";

/** The project's setting, from where this file sits in a project: `tools/agent-workflow/hooks/`. */
const CONFIG = new URL("../../agent-workflow.config.json", import.meta.url);

/** The fields both hosts send that this hook reads. */
export interface CommandPayload {
  tool_name?: string;
  tool_input?: { command?: unknown; [field: string]: unknown };
  /** The folder the call runs in. Claude Code's follows the session: it is the new folder after a `cd`. */
  cwd?: string;
  /** Claude Code's permission mode. An approval is given only in a mode that asks before a command. */
  permission_mode?: string;
}

/** What the hook needs to know to approve. Without it, it approves nothing. */
export interface Approval {
  /** What the project turned on. */
  settings: Settings;
  /** Whether a folder is a checkout or a worktree of this project's repository. */
  isOwnCheckout: (cwd: string) => boolean;
  /** Why the step, run in `cwd`, would not do just what its words say. Undefined when it would. */
  obstacle: (cwd: string, shape: Shape) => string | undefined;
}

export interface Answer {
  decision: "deny" | "allow" | "ask";
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

/** The answer to give the host, or undefined to say nothing and leave the call to its own rules. */
export function judgeCall(payload: CommandPayload, approval?: Approval): Answer | undefined {
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

  if (verdict?.chained) {
    return {
      decision: "deny",
      reason: [
        `Refused: this command joins an outward step (${verdict.outward.join(", ")}) to other commands.`,
        "Run each outward step (git push, gh pr create or merge, gh workflow run, a gh api write) as a tool call of its own,",
        "and put those calls together at the start or the end of the work. Local steps (git add, git commit, tests) go in separate calls.",
        "Split the command. Do not reword it to get past this check.",
      ].join("\n"),
    };
  }

  try {
    return approval === undefined ? undefined : judgeApproval(payload, approval);
  } catch {
    // Whatever failed while asking git or GitHub, the answer is not a yes.
    return undefined;
  }
}

/** The refusal above reads any call that carries a command. The approval reads only a call that is whole and plain. */
function judgeApproval(payload: CommandPayload, approval: Approval): Answer | undefined {
  const approvable = approvableCommand(payload, approval.isOwnCheckout);
  const shape = approvable === undefined ? undefined : readShape(approvable);

  if (shape === undefined || !(shape.step === "merge" ? approval.settings.approveMerge : approval.settings.approvePushAndCreate)) {
    return undefined;
  }

  const reason = approval.obstacle(payload.cwd as string, shape);

  return reason === undefined
    ? { decision: "allow", reason: `Approved by tools/agent-workflow: ${shape.says}, in the exact form the project pre-approves.` }
    : { decision: "ask", reason: `Not approved by tools/agent-workflow, though it is ${shape.says} in the exact form: ${reason}. Check that before you say yes.` };
}

/** What the project turned on, for a host that takes approvals. Nothing, for any other host. */
export function approvalSettings(argv: string[], config: string | URL = CONFIG): Settings | undefined {
  const settings = argv.includes(APPROVING_HOST) ? readSettings(config) : undefined;

  return settings?.approvePushAndCreate || settings?.approveMerge ? settings : undefined;
}

/** Asks git, and for a merge GitHub, in the checkout the call runs in. */
export function checkoutObstacle(cwd: string, shape: Shape, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (shape.step === "push") {
    return obstacle(cwd, { branch: shape.branch }, env);
  }

  return obstacle(cwd, { hosting: true }, env) ?? (shape.step === "merge" ? mergeObstacle(shape.number, shape.commit, createAsk(cwd, env)) : undefined);
}

/** The reply for one payload, as the text to print. Empty when there is nothing to say. */
export function replyTo(input: string, argv: string[], home: string): string {
  let answer: Answer | undefined;

  try {
    const payload = JSON.parse(input) as CommandPayload;
    const settings = approvalSettings(argv);

    answer = judgeCall(payload, settings === undefined ? undefined : { settings, isOwnCheckout: (cwd) => isCheckoutOf(cwd, home), obstacle: checkoutObstacle });
  } catch {
    // A payload that is not JSON, or anything nobody foresaw: no answer, and never an approval.
    return "";
  }

  return answer === undefined
    ? ""
    : JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: answer.decision, permissionDecisionReason: answer.reason } });
}

if (isMainModule(import.meta.url)) {
  let reply = "";

  try {
    reply = replyTo(readFileSync(0, "utf8"), process.argv.slice(2), dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Standard input could not be read. There is nothing to judge.
  }

  if (reply !== "") {
    console.log(reply);
  }
}
