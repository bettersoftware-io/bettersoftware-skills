// What this add-on asks of each host's settings file. The installer merges
// the same entries in (they are also in the add-on's manifest); `check.mts`
// reads them back from the project.

export const HOOK_SCRIPT = "tools/agent-workflow/hooks/split-outward-commands.mts";

export const CLAUDE_SETTINGS = ".claude/settings.json";
export const CODEX_HOOKS = ".codex/hooks.json";

/** Run without a prompt: the routine end of a piece of work, in exactly these forms. */
export const ALLOW_RULES = [
  "Bash(git push -u origin worktree-*)",
  "Bash(git push origin worktree-*)",
  "Bash(gh pr create *)",
  "Bash(gh pr merge *)",
];

/**
 * Always ask, even where an allow rule matches too: a forced push, in any of
 * its spellings, and a push that names its target with `source:target`.
 */
export const ASK_RULES = [
  "Bash(git push *--force*)",
  "Bash(git push -f*)",
  "Bash(git push * -f*)",
  "Bash(git push * +*)",
  "Bash(git push *:*)",
];

/** Slash commands that work only with another add-on in the project. */
export const COMMAND_NEEDS: Record<string, string | undefined> = {
  changelog: undefined,
  "coverage-backfill": "coverage",
  "visual-tolerance-audit": "visual",
};
