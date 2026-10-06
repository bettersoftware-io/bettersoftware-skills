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
//   - it is rewritten where it stands. Only the command changes: the entry's
//     other fields (its timeout), its group, the group's matcher and the
//     other hooks of the group stay as they are. No group is ever taken out;
//   - one thing is taken out: when the rewrite leaves the same command line
//     twice in one group, the later one goes. The hook still runs there.
//
// A hook counts as registered only under a matcher that covers the one the
// add-on asks for: the same matcher, no matcher, `*`, or a list (`a|b`) that
// names it. The command under any other matcher (`Edit`, `Nothing`) does not
// run where the add-on needs it, so the add-on's own group is added.
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
 * is a group of commands, and it is there when a group whose matcher covers
 * the wanted one holds its commands: a project that changed the group's
 * timeout or widened its matcher still has the hook, and adding the group
 * again would run it twice. The commands under a matcher that does not cover
 * the wanted one do not run where the add-on needs them.
 */
function isSameEntry(existing: Json, wanted: Json, path: string[]): boolean {
  if (isHookGroup(path)) {
    const commands = hookCommands(wanted);

    return commands.length > 0 && coversMatcher(existing, wanted) && commands.every((command) => hookCommands(existing).includes(command));
  }

  return isEqual(existing, wanted);
}

/**
 * Whether the project's group runs for everything the wanted group runs for,
 * as far as that can be told without reading a pattern: the same matcher, no
 * matcher, an empty one or `*` (each runs for every tool), or a list of names
 * that holds the wanted one. Anything else is taken not to cover it.
 */
function coversMatcher(existing: Json, wanted: Json): boolean {
  const has = isObject(existing) ? existing.matcher : undefined;
  const needs = isObject(wanted) ? wanted.matcher : undefined;

  if (has === undefined || has === "" || has === "*") {
    return true;
  }

  return typeof has === "string" && typeof needs === "string" && has.split("|").includes(needs);
}

/**
 * The project's groups for one event, with each hook that is exactly an older
 * command line of one of `registered` rewritten, where it stands, to the line
 * registered now. Every group stays, with its matcher. Within one group, a
 * command line the rewrite left there twice is kept once, the first.
 */
function renewCommands(groups: Json[], registered: string[], retired: RetiredCommands, path: string[]): { groups: Json[]; changed: string[]; unknown: string[] } {
  const changed: string[] = [];
  const renewedTo = (hook: Json): string | undefined => {
    const now = isObject(hook) && typeof hook.command === "string" ? retired[hook.command] : undefined;

    return now !== undefined && registered.includes(now) ? now : undefined;
  };
  const renewed = groups.map((group) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      return group;
    }

    // The lines this group gets by a rewrite. Only these may be there twice because of it.
    const rewritten = new Set(group.hooks.flatMap((hook) => renewedTo(hook) ?? []));
    const seen = new Set<string>();

    if (rewritten.size === 0) {
      return group;
    }

    const hooks = group.hooks.flatMap((hook) => {
      const now = renewedTo(hook);
      const command = now ?? (isObject(hook) && typeof hook.command === "string" ? hook.command : undefined);

      if (!isObject(hook) || command === undefined || !rewritten.has(command)) {
        return [hook];
      }

      if (seen.has(command)) {
        changed.push(`${path.join(".")}: took out ${String(hook.command)}, which the same group already runs as ${command}`);

        return [];
      }

      seen.add(command);

      if (now === undefined) {
        return [hook];
      }

      changed.push(`${path.join(".")}: ${String(hook.command)} is now ${now}`);

      return [{ ...hook, command: now }];
    });

    return { ...group, hooks };
  });
  const unknown = registered.flatMap((now) =>
    renewed
      .flatMap(hookCommands)
      .filter((line) => line.startsWith(`${now} `))
      .map((line) => `${path.join(".")}: ${line} begins like ${now}, which the add-on registers, and is no command line it ever registered. It was left as it is`),
  );

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
