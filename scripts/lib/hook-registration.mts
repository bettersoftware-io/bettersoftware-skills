// Decides whether a host would run a hook that a settings file registers.
//
// This file is kept twice, byte for byte: in `scripts/lib/`, where the
// installer's merge reads it, and in the agent-workflow add-on's `lib/`,
// where the project's own check reads it. The add-on's files run in a project
// that has no installer, and the installer must not depend on one add-on, so
// neither can import the other's copy. A test holds the two to the same text
// and the same table, so that the merge and the check cannot disagree on
// whether a hook is registered.
//
// "Registered" here means: the host would start this command before this
// tool. Every doubt is a "no". A "no" costs a second registration or a failed
// check; a wrong "yes" leaves a project with no hook and a check that passes.
//
// How each host reads a group's `matcher`, from its documentation:
//
//   Claude Code   Left out, `""` or `"*"`: every tool. Only letters, digits,
//                 `_`, `-`, spaces, `,` and `|`: a list of exact names split
//                 at `|` or `,`, blanks around a name dropped. Anything
//                 else: a JavaScript regular expression, tested anywhere in
//                 the name (`RegExp.prototype.test`). Case matters.
//   Codex         Left out, `""` or `"*"`: every tool. Otherwise a regular
//                 expression, and its documentation does not say whether it
//                 must match the whole name. So only a list of plain names
//                 split at `|` is read, which means the same either way;
//                 any other pattern is not evaluated, and is a "no".
//
// A matcher that is no text (a number, `null`, a list) is a "no".
//
// A hook entry is one the host runs as the command when its `type` is
// `"command"`, its `command` is the command letter for letter, and nothing in
// it narrows or weakens the run: no `if` (Claude Code then runs it for some
// commands only), no `async` (the host then does not wait for the answer),
// and a `timeout` that is left out or a number above zero. A command that
// only contains the registered line (`… || true`, `echo …`, a `#` in front,
// another argument) is another command.
//
// What this does not look at: a switch that turns every hook off
// (`disableAllHooks`), another settings file, and whether Codex has been told
// to trust the project's hooks. The callers say what they do about those.

export type Host = "claude-code" | "codex";

/** The host a settings file belongs to, from where it is in a project. */
export function hostOf(path: string): Host {
  return path.startsWith(".codex/") ? "codex" : "claude-code";
}

const EVERY_TOOL = ["", "*"];
/** Claude Code compares such a matcher as a list of exact names. */
const CLAUDE_LIST = /^[A-Za-z0-9_\- ,|]+$/;
/** A list of plain names split at `|` matches the same names as a pattern, whole or in part. */
const NAMES = /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/;

/** Whether the host runs a group with this matcher for the tool. */
export function runsForTool(matcher: unknown, tool: string, host: Host): boolean {
  if (matcher === undefined || EVERY_TOOL.includes(matcher as string)) {
    return true;
  }

  if (typeof matcher !== "string") {
    return false;
  }

  if (host === "codex") {
    return NAMES.test(matcher) && matcher.split("|").includes(tool);
  }

  if (CLAUDE_LIST.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .includes(tool);
  }

  try {
    return new RegExp(matcher).test(tool);
  } catch {
    // Not a pattern the host can read either.
    return false;
  }
}

/** Whether the host runs this entry of a group as the command, each time and waiting for its answer. */
export function isLiveCommand(hook: unknown, command: string): boolean {
  if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
    return false;
  }

  const { type, command: has, timeout, async: inBackground } = hook as Record<string, unknown>;

  return (
    type === "command" &&
    has === command &&
    !("if" in hook) &&
    (inBackground === undefined || inBackground === false) &&
    (timeout === undefined || (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0))
  );
}

/** Whether the host runs this group's live entry of the command for the tool. */
export function groupRuns(group: unknown, command: string, tool: string, host: Host): boolean {
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    return false;
  }

  const { matcher, hooks } = group as Record<string, unknown>;

  return Array.isArray(hooks) && runsForTool(matcher, tool, host) && hooks.some((hook) => isLiveCommand(hook, command));
}

/**
 * The tools a matcher the add-on itself wrote names: `Bash`, `Edit|Write`.
 * Undefined for a matcher that names every tool, and for a pattern.
 */
export function toolsNamed(matcher: unknown): string[] | undefined {
  return typeof matcher === "string" && NAMES.test(matcher) ? matcher.split("|") : undefined;
}
