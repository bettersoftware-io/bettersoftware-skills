// Merges what an add-on needs into a host's settings file.
//
// `.claude/settings.json` and `.codex/hooks.json` belong to the project: the
// kit's setup writes them once, and people edit them afterwards. An add-on
// that needs a hook registered or a permission rule added therefore never
// replaces the file. It merges, by three rules:
//
//   - a key the project has keeps the project's value;
//   - a list gains the entries it lacks, after the ones it has;
//   - nothing is removed, and nothing the project wrote is changed, with
//     the one exception below.
//
// Merging the same settings a second time changes nothing.
//
// One thing is rewritten, and only this: the command line of a hook the
// add-on itself registered under an older form (`retired`). Without that, a
// project that has the old line would get the new one beside it, and the hook
// would run twice. The rewrite is bound on every side:
//
//   - the project's command must be exactly the old line, letter for letter;
//   - the new line must be one the add-on registers now, in this file, for
//     this event: an old line under another event is not touched;
//   - only the command changes. The entry's other fields (its timeout), the
//     group's matcher and the other hooks of the group stay as they are;
//   - when the new line is already registered for the event, the old entry
//     is taken out instead, so the hook is never there twice. A group left
//     with no hook goes with it;
//   - the old line is never taken out unless the new one is in the result.
//
// A command that only begins like the add-on's own is another shape. It is
// left alone and named in `unknown`.
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
  /** One line per hook whose older command line was rewritten, or taken out because the new one was there. */
  changed: string[];
  /** One line per hook command that begins like one the add-on registers and is neither that nor an older form of it. */
  unknown: string[];
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
    const result: MergeResult = { merged: { ...current }, added: [], skipped: [], changed: [], unknown: [] };

    for (const [key, value] of Object.entries(wanted)) {
      if (key in current) {
        const inner = mergeSettings(current[key] as Json, value, retired, [...path, key]);

        (result.merged as { [key: string]: Json })[key] = inner.merged;
        result.added.push(...inner.added);
        result.skipped.push(...inner.skipped);
        result.changed.push(...inner.changed);
        result.unknown.push(...inner.unknown);
      } else {
        (result.merged as { [key: string]: Json })[key] = value;
        result.added.push(...describeAdded(value, [...path, key]));
      }
    }

    return result;
  }

  if (Array.isArray(current) && Array.isArray(wanted)) {
    const renewed = isHookGroup(path) ? renewCommands(current, wanted.flatMap(hookCommands), retired, path) : { groups: current, changed: [], unknown: [] };
    const merged = [...renewed.groups];
    const added: string[] = [];

    for (const entry of wanted) {
      if (!merged.some((existing) => isSameEntry(existing, entry, path))) {
        merged.push(entry);
        added.push(...describeAdded(entry, path));
      }
    }

    return { merged, added, skipped: [], changed: renewed.changed, unknown: renewed.unknown };
  }

  // A plain value, or two values of different kinds: the project's stands.
  // A list or an object the add-on needed is then missing, and that is said.
  if (kindOf(wanted) === "a value" || kindOf(current) === kindOf(wanted)) {
    return { merged: current, added: [], skipped: [], changed: [], unknown: [] };
  }

  const left = describeAdded(wanted, path).map((entry) => entry.slice(entry.indexOf(": ") + 2));

  return {
    merged: current,
    added: [],
    changed: [],
    unknown: [],
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
 * Whether the project's list already holds this entry. Under `hooks`, an entry
 * is a group of commands, and it is there when its commands are: a project
 * that changed the group's timeout or matcher still has the hook, and adding
 * the group again would run it twice.
 */
function isSameEntry(existing: Json, wanted: Json, path: string[]): boolean {
  if (isHookGroup(path)) {
    const commands = hookCommands(wanted);

    return commands.length > 0 && commands.every((command) => hookCommands(existing).includes(command));
  }

  return isEqual(existing, wanted);
}

/**
 * The project's groups for one event, with each hook that is exactly an older
 * command line of one of `registered` brought to the line registered now.
 * The first such hook has its command rewritten, when the new line is not
 * there yet; every other one is taken out. Nothing else about a group changes.
 */
function renewCommands(groups: Json[], registered: string[], retired: RetiredCommands, path: string[]): { groups: Json[]; changed: string[]; unknown: string[] } {
  const changed: string[] = [];
  const unknown: string[] = [];
  let renewed = groups;

  for (const now of registered) {
    const older = Object.keys(retired).filter((line) => retired[line] === now && line !== now);
    let isThere = renewed.flatMap(hookCommands).includes(now);

    renewed = renewed.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        return [group];
      }

      const hooks = group.hooks.flatMap((hook) => {
        if (!isObject(hook) || typeof hook.command !== "string" || !older.includes(hook.command)) {
          return [hook];
        }

        if (isThere) {
          changed.push(`${path.join(".")}: took out ${hook.command}, an older command line of a hook that is registered as ${now}`);

          return [];
        }

        isThere = true;
        changed.push(`${path.join(".")}: ${hook.command} is now ${now}`);

        return [{ ...hook, command: now }];
      });

      // A group whose only hooks were older lines of one that is registered elsewhere has nothing left to run.
      return hooks.length === 0 && group.hooks.length > 0 ? [] : [{ ...group, hooks }];
    });

    unknown.push(
      ...renewed
        .flatMap(hookCommands)
        .filter((line) => line.startsWith(`${now} `))
        .map((line) => `${path.join(".")}: ${line} begins like ${now}, which the add-on registers, and is no command line it ever registered. It was left as it is`),
    );
  }

  return { groups: renewed, changed, unknown };
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

/**
 * Why an add-on's older command lines cannot be used, or undefined when they
 * can. Each must lead to a command line the add-on registers now, under
 * `hooks` of some settings file, and must not itself be one: a manifest that
 * named any other command would have the installer put it into a project's
 * settings, or take a hook out with nothing in its place.
 */
export function refuseRetired(retired: RetiredCommands, wanted: Record<string, Json>): string | undefined {
  const registered = Object.values(wanted).flatMap((settings) =>
    isObject(settings) && isObject(settings.hooks) ? Object.values(settings.hooks).flatMap((groups) => (Array.isArray(groups) ? groups.flatMap(hookCommands) : [])) : [],
  );

  for (const [older, now] of Object.entries(retired)) {
    if (typeof now !== "string" || !registered.includes(now)) {
      return `retiredHookCommands gives "${String(now)}" as what took the place of "${older}", and hostSettings registers no hook with that command line`;
    }

    if (registered.includes(older)) {
      return `retiredHookCommands calls "${older}" an older command line, and hostSettings still registers it`;
    }
  }

  return undefined;
}
