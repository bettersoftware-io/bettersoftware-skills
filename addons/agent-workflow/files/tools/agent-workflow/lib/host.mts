// What this add-on asks of each host's settings file. The installer merges
// the same entries in (they are also in the add-on's manifest); `check.mts`
// reads them back from the project.

export const HOOK_SCRIPT = "tools/agent-workflow/hooks/split-outward-commands.mts";

/** The project's setting: what the hook may approve. Data, never code. */
export const CONFIG_FILE = "tools/agent-workflow.config.json";

/** Where the setting was until it became data. The hook no longer reads it. */
export const RETIRED_CONFIG_FILE = "tools/agent-workflow.config.mts";

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

/**
 * Always ask before an editing tool changes the hook or its setting. An
 * `Edit` rule is the one Claude Code reads for every built-in tool that edits
 * a file; a leading `/` is the project's root. A shell command that writes
 * the same files (`sed -i`, a redirection, `git checkout`) is not an editing
 * tool, and no rule here sees it.
 */
export const EDIT_ASK_RULES = ["Edit(/tools/agent-workflow/**)", "Edit(/tools/agent-workflow.config.json)"];

/** How long Claude Code gives the hook, in seconds. A merge is checked with two reads of GitHub, ten seconds each at most. */
export const HOOK_SECONDS = 30;

/** An `allow` rule with a `*` for one of the steps the hook approves by shape: it approves more than the shape. */
export const WIDE_ALLOW = /^Bash\((?:git push|gh pr create|gh pr merge)\b.*\*.*\)$/;

/** Slash commands that work only with another add-on in the project. */
export const COMMAND_NEEDS: Record<string, string | undefined> = {
  changelog: undefined,
  "coverage-backfill": "coverage",
  "visual-tolerance-audit": "visual",
};
