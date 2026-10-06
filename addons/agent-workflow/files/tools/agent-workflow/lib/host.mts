// What this add-on asks of each host's settings file. The installer merges
// the same entries in (they are also in the add-on's manifest); `check.mts`
// reads them back from the project.

export const HOOK_SCRIPT = "tools/agent-workflow/hooks/split-outward-commands.mts";

/**
 * Where a project kept the setting of a feature this add-on no longer has.
 * Nothing reads either file. The same paths are in the manifest, under
 * `retiredFiles`, where the installer reads them.
 */
export const RETIRED_FILES = ["tools/agent-workflow.config.json", "tools/agent-workflow.config.mts"];

/** A start-up argument an older registration of the hook carries. The hook ignores it. */
export const RETIRED_ARGUMENT = "--host=claude-code";

export const CLAUDE_SETTINGS = ".claude/settings.json";
/** A person's own settings for the project. They win over the project's, and can switch every hook off. */
export const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";
export const CODEX_HOOKS = ".codex/hooks.json";

/** The command line the add-on registers the hook with, in each host's file. The same text is in the manifest. */
export const HOOK_COMMANDS: Record<string, string> = {
  [CLAUDE_SETTINGS]: `node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT}"`,
  [CODEX_HOOKS]: `node ${HOOK_SCRIPT}`,
};

/**
 * Always ask. The add-on ships no `allow` rule, and its hook allows nothing.
 * These rules are the backstop for a project that adds an `allow` rule of its
 * own: a rule here wins over any `allow`.
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
 * Always ask before an editing tool changes the hook or the files beside it.
 * The hook is what refuses a chain, so a change to it is a person's to make.
 * An `Edit` rule is the one Claude Code reads for every built-in tool that
 * edits a file; a leading `/` is the project's root. A shell command that
 * writes the same files (`sed -i`, a redirection, `git checkout`) is not an
 * editing tool, and no rule here sees it.
 */
export const EDIT_ASK_RULES = ["Edit(/tools/agent-workflow/**)"];

/** An `allow` rule with a `*` for a push, a pull request opened or a merge: a `*` also matches a second branch, another flag, a `$(…)`. */
export const WIDE_ALLOW = /^Bash\((?:git push|gh pr create|gh pr merge)\b.*\*.*\)$/;

/** Slash commands that work only with another add-on in the project. */
export const COMMAND_NEEDS: Record<string, string | undefined> = {
  changelog: undefined,
  "coverage-backfill": "coverage",
  "visual-tolerance-audit": "visual",
};
