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
// it is not what keeps a push from happening.
//
// And it approves a call that is exactly one routine outward step in exactly
// one of the forms in `lib/approve.mts`, so that the closing steps of a piece
// of work do not each wait for a person. It approves only when all of these
// hold:
//
//   - the call itself is one that may be approved (`lib/call.mts`): the tool
//     is `Bash`, its input has no field that changes how or where the
//     command runs, and it runs in a checkout or a worktree of the repository
//     this file sits in.
//   - it was started with `--host=claude-code`. Claude Code's settings start
//     it so; Codex's do not. Claude Code checks its `deny` and `ask` rules
//     whatever a hook answers, so an approval never overrides a rule. Codex
//     does not take an approval from a hook, so it is never sent one.
//   - `approveExactShapes` is `true` in `tools/agent-workflow.config.mts`. If
//     that file is missing or cannot be loaded, nothing is approved.
//
// For any other command it says nothing, and the host asks as it always does.
//
// Works under Claude Code (the `Bash` tool: `tool_input.command` is text) and
// Codex (its shell tool: the same field, as text or as a list of words). Both
// read the same reply: `permissionDecision` with a reason, on stdout.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { approvedShape } from "../lib/approve.mts";
import { approvableCommand } from "../lib/call.mts";
import { isMainModule } from "../lib/main.mts";
import { judgeCommand } from "../lib/outward.mts";
import { isCheckoutOf } from "../lib/repository.mts";

/** The start-up argument that says the host takes an approval from a hook. */
export const APPROVING_HOST = "--host=claude-code";

/** The project's setting, from where this file sits in a project: `tools/agent-workflow/hooks/`. */
const CONFIG = new URL("../../agent-workflow.config.mts", import.meta.url);

/** The fields both hosts send that this hook reads. */
export interface CommandPayload {
  tool_name?: string;
  tool_input?: { command?: unknown; [field: string]: unknown };
  /** The folder the call runs in. Claude Code's follows the session: it is the new folder after a `cd`. */
  cwd?: string;
}

/** What the hook needs to know to approve. Without it, it approves nothing. */
export interface Approval {
  /** Whether a folder is a checkout or a worktree of this project's repository. */
  isOwnCheckout: (cwd: string) => boolean;
}

export interface Answer {
  decision: "deny" | "allow";
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
  const verdict = command === undefined ? undefined : judgeCommand(command);

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

  // The refusal above reads any call that carries a command. The approval reads only a call that is whole and plain.
  const approvable = approval === undefined ? undefined : approvableCommand(payload, approval.isOwnCheckout);
  const shape = approvable === undefined ? undefined : approvedShape(approvable);

  return shape === undefined ? undefined : { decision: "allow", reason: `Approved by tools/agent-workflow: ${shape}, in the exact form the project pre-approves.` };
}

/** Whether this run may approve: the host takes approvals, and the project has not turned them off. */
export async function mayApprove(argv: string[], config: URL = CONFIG): Promise<boolean> {
  if (!argv.includes(APPROVING_HOST)) {
    return false;
  }

  try {
    const loaded = (await import(config.href)) as { approveExactShapes?: unknown };

    return loaded.approveExactShapes === true;
  } catch {
    // No setting that can be read is not a yes.
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}") as CommandPayload;
  const home = dirname(fileURLToPath(import.meta.url));
  const approval = (await mayApprove(process.argv.slice(2))) ? { isOwnCheckout: (cwd: string) => isCheckoutOf(cwd, home) } : undefined;
  const answer = judgeCall(payload, approval);

  if (answer) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: answer.decision, permissionDecisionReason: answer.reason },
      }),
    );
  }
}
