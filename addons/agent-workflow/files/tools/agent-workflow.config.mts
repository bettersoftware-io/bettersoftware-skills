// The agent-workflow add-on's one setting. This file is the project's: the
// add-on writes it once and never changes it again.

/**
 * Whether the hook may approve a routine outward step without a prompt.
 *
 * `true`: in Claude Code, a command that is exactly one of the shapes in
 * `tools/agent-workflow/lib/approve.mts` (a push of a `worktree-…` branch to
 * `origin`, `gh pr create`, `gh pr merge <number>`, each with a short list of
 * flags) runs without asking. Every other command is asked about as before.
 *
 * `false`: the hook approves nothing, and every push and pull request step
 * asks. The hook still refuses a command that joins an outward step to
 * anything else; that does not depend on this setting.
 *
 * A `deny` or `ask` rule in `.claude/settings.json` wins over the hook's
 * approval either way. Codex is never told to approve: its own approval
 * settings decide there.
 */
export const approveExactShapes: boolean = true;
