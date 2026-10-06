// What this add-on asks of each host's settings file. The installer merges
// the same entries in (they are also in the add-on's manifest); `check.mts`
// reads them back from the project.

export const HOOK_SCRIPT = "tools/agent-workflow/hooks/split-outward-commands.mts";

/** The project's one setting: whether the hook may approve. */
export const CONFIG_FILE = "tools/agent-workflow.config.mts";

/** Given to the hook only by a host that takes an approval from a hook. The same text is in the hook itself. */
export const APPROVING_HOST = "--host=claude-code";

export const CLAUDE_SETTINGS = ".claude/settings.json";
export const CODEX_HOOKS = ".codex/hooks.json";

/**
 * Always ask. The add-on ships no `allow` rule: what runs without a prompt
 * is decided by the hook, from the exact shape of the command. These rules
 * are the backstop behind it, for a project that adds an `allow` rule of its
 * own: a rule here wins over any `allow`, and over the hook's approval.
 */
export const ASK_RULES = [
  "Bash(git push *--force*)",
  "Bash(git push -f*)",
  "Bash(git push * -f*)",
  "Bash(git push * +*)",
  "Bash(git push *:*)",
  "Bash(git push *--delete*)",
  "Bash(git push -d*)",
  "Bash(git push * -d*)",
  "Bash(git push *--mirror*)",
  "Bash(git push *--all*)",
  "Bash(git push *--tags*)",
  "Bash(git push *--prune*)",
  "Bash(gh pr merge *--admin*)",
];

/** An `allow` rule with a `*` for one of the steps the hook approves by shape: it approves more than the shape. */
export const WIDE_ALLOW = /^Bash\((?:git push|gh pr create|gh pr merge)\b.*\*.*\)$/;

/** Slash commands that work only with another add-on in the project. */
export const COMMAND_NEEDS: Record<string, string | undefined> = {
  changelog: undefined,
  "coverage-backfill": "coverage",
  "visual-tolerance-audit": "visual",
};
