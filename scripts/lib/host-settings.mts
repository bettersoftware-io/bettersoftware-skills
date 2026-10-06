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

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface MergeResult {
  merged: Json;
  /** One line per thing added, e.g. `permissions.allow: Bash(gh pr create *)`. Empty when nothing changed. */
  added: string[];
}

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
export function mergeSettings(current: Json, wanted: Json, path: string[] = []): MergeResult {
  if (isObject(current) && isObject(wanted)) {
    const merged: { [key: string]: Json } = { ...current };
    const added: string[] = [];

    for (const [key, value] of Object.entries(wanted)) {
      if (key in current) {
        const inner = mergeSettings(current[key] as Json, value, [...path, key]);

        merged[key] = inner.merged;
        added.push(...inner.added);
      } else {
        merged[key] = value;
        added.push(...describeAdded(value, [...path, key]));
      }
    }

    return { merged, added };
  }

  if (Array.isArray(current) && Array.isArray(wanted)) {
    const merged = [...current];
    const added: string[] = [];

    for (const entry of wanted) {
      if (!merged.some((existing) => isSameEntry(existing, entry, path))) {
        merged.push(entry);
        added.push(...describeAdded(entry, path));
      }
    }

    return { merged, added };
  }

  // A plain value, or two values of different kinds: the project's stands.
  return { merged: current, added: [] };
}

/**
 * Whether the project's list already holds this entry. Under `hooks`, an entry
 * is a group of commands, and it is there when its commands are: a project
 * that changed the group's timeout or matcher still has the hook, and adding
 * the group again would run it twice.
 */
function isSameEntry(existing: Json, wanted: Json, path: string[]): boolean {
  if (path[0] === "hooks" && path.length === 2) {
    const commands = hookCommands(wanted);

    return commands.length > 0 && commands.every((command) => hookCommands(existing).includes(command));
  }

  return isEqual(existing, wanted);
}

function hookCommands(group: Json): string[] {
  const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];

  return hooks.flatMap((hook) => (isObject(hook) && typeof hook.command === "string" ? [hook.command] : []));
}

function describeAdded(value: Json, path: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => describeAdded(entry, path));
  }

  if (path[0] === "hooks" && path.length === 2) {
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
