// Merges what an add-on needs into a host's settings file.
//
// `.claude/settings.json` and `.codex/hooks.json` belong to the project: the
// kit's setup writes them once, and people edit them afterwards. An add-on
// that needs a hook registered or a permission rule added therefore never
// replaces the file. It merges, by three rules:
//
//   - a key the project has keeps the project's value;
//   - a list gains the entries it lacks, after the ones it has;
//   - nothing is ever removed.
//
// Merging the same settings a second time changes nothing.
//
// An add-on may change the command line of a hook it registers. A project
// that has the old line must not get the new one beside it: the hook would
// run twice. So the add-on names the old line (`retired`), and a hook found
// under it counts as there. The project's entry is left as it is, and is
// named in `kept`.
//
// Where the project's file has a value of another kind than the add-on needs
// (`"permissions": null`, `"ask": "Bash(x)"`, `"PreToolUse": {}`), the first
// rule holds and the project's value stands. That leaves the add-on's entries
// out, so it is never silent: each such place is named in `skipped`.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface MergeResult {
  merged: Json;
  /** One line per thing added, e.g. `permissions.allow: Bash(gh pr create *)`. Empty when nothing changed. */
  added: string[];
  /** One line per place where the project's value is of another kind, with what was left out there. */
  skipped: string[];
  /** Each hook command of the project that is an older form of one the add-on registers now, with that one. */
  kept: { has: string; now: string }[];
}

/** Older command lines of a hook, each with the command line that took its place. */
export type RetiredCommands = Record<string, string>;

export class SettingsError extends Error {}

/** Reads a settings file's text. Throws `SettingsError` when it is not a JSON object. */
export function parseSettings(text: string, path: string): { [key: string]: Json } {
  let parsed: Json;

  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    throw new SettingsError(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!isObject(parsed)) {
    throw new SettingsError(`${path} does not hold a JSON object`);
  }

  return parsed;
}

/** `current` with everything from `wanted` that it lacks. `current` itself is not changed. */
export function mergeSettings(current: Json, wanted: Json, retired: RetiredCommands = {}, path: string[] = []): MergeResult {
  if (isObject(current) && isObject(wanted)) {
    const merged: { [key: string]: Json } = { ...current };
    const added: string[] = [];
    const skipped: string[] = [];
    const kept: MergeResult["kept"] = [];

    for (const [key, value] of Object.entries(wanted)) {
      if (key in current) {
        const inner = mergeSettings(current[key] as Json, value, retired, [...path, key]);

        merged[key] = inner.merged;
        added.push(...inner.added);
        skipped.push(...inner.skipped);
        kept.push(...inner.kept);
      } else {
        merged[key] = value;
        added.push(...describeAdded(value, [...path, key]));
      }
    }

    return { merged, added, skipped, kept };
  }

  if (Array.isArray(current) && Array.isArray(wanted)) {
    const merged = [...current];
    const added: string[] = [];
    const kept: MergeResult["kept"] = [];

    for (const entry of wanted) {
      const found = isHookGroup(path) ? findHookGroup(merged, entry, retired) : merged.some((existing) => isEqual(existing, entry)) ? [] : undefined;

      if (found === undefined) {
        merged.push(entry);
        added.push(...describeAdded(entry, path));
      } else {
        kept.push(...found);
      }
    }

    return { merged, added, skipped: [], kept };
  }

  // A plain value, or two values of different kinds: the project's stands.
  // A list or an object the add-on needed is then missing, and that is said.
  if (kindOf(wanted) === "a value" || kindOf(current) === kindOf(wanted)) {
    return { merged: current, added: [], skipped: [], kept: [] };
  }

  const left = describeAdded(wanted, path).map((entry) => entry.slice(entry.indexOf(": ") + 2));

  return {
    merged: current,
    added: [],
    kept: [],
    skipped: [`${path.join(".")} is ${kindOf(current)} in the project and ${kindOf(wanted)} is needed there, so ${left.length} entr${left.length === 1 ? "y was" : "ies were"} not merged: ${left.join("; ")}`],
  };
}

function kindOf(value: Json): "a list" | "an object" | "a value" {
  return Array.isArray(value) ? "a list" : isObject(value) ? "an object" : "a value";
}

/** Under `hooks`, a list holds groups of commands, one list per event. */
function isHookGroup(path: string[]): boolean {
  return path[0] === "hooks" && path.length === 2;
}

/**
 * Whether one of the project's groups already holds every command of this
 * group: a project that changed the group's timeout or matcher still has the
 * hook, and adding the group again would run it twice. A command is also
 * there under an older command line the add-on names. Undefined when no
 * group holds them all; else the older lines that stood in for one, which is
 * none when each command was found as it is written now.
 */
function findHookGroup(groups: Json[], wanted: Json, retired: RetiredCommands): MergeResult["kept"] | undefined {
  const commands = hookCommands(wanted);

  if (commands.length === 0) {
    return undefined;
  }

  // As it is written now, in any group, before an older line is looked for.
  if (groups.some((group) => commands.every((command) => hookCommands(group).includes(command)))) {
    return [];
  }

  for (const group of groups) {
    const has = hookCommands(group);
    const older = commands.map((command) => (has.includes(command) ? command : has.find((line) => retired[line] === command)));

    if (older.every((line) => line !== undefined)) {
      return commands.flatMap((now, index) => (older[index] === now ? [] : [{ has: older[index] as string, now }]));
    }
  }

  return undefined;
}

function hookCommands(group: Json): string[] {
  const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];

  return hooks.flatMap((hook) => (isObject(hook) && typeof hook.command === "string" ? [hook.command] : []));
}

function describeAdded(value: Json, path: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => describeAdded(entry, path));
  }

  if (isHookGroup(path)) {
    return hookCommands(value).map((command) => `${path.join(".")}: ${command}`);
  }

  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, inner]) => describeAdded(inner, [...path, key]));
  }

  return [`${path.join(".")}: ${String(value)}`];
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEqual(a: Json, b: Json): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => isEqual(entry, b[index] as Json));
  }

  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);

    return keys.length === Object.keys(b).length && keys.every((key) => key in b && isEqual(a[key] as Json, b[key] as Json));
  }

  return a === b;
}
