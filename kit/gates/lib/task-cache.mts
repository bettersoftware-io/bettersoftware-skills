// Task-cache gate: a cached task's key includes everything the task reads.
//
// Turbo keys a task's cache on that package's own files unless the task graph
// says otherwise. When packages import each other's source, a typecheck or a
// test also reads the packages it imports. Leave those out of the key and a
// change upstream replays "passed" for every dependent: a green that means
// nothing, on a developer's machine and in the agent's stop hook. CI starts
// with an empty cache, so it never shows there.
//
// Two things are read, both from files, so the gate needs no turbo to run:
//   - turbo.json: every cached task must depend, directly or through another
//     task, on a task in the packages it imports (a `^` dependency);
//   - each package's tsconfig: a file it extends outside the package must be a
//     global dependency, since no package's files include it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

import type { Finding, Project } from "./config.mts";
import { parseJsonWithComments } from "./files.mts";

const GATE = "task-cache";
const TURBO = "turbo.json";

interface TaskDefinition {
  dependsOn?: string[];
  cache?: boolean;
}

interface TurboConfig {
  tasks?: Record<string, TaskDefinition>;
  /** The name of `tasks` before turbo 2. */
  pipeline?: Record<string, TaskDefinition>;
  globalDependencies?: string[];
}

/** Why this gate judged nothing, if it did. */
export function taskCacheSkipReason({ root }: Project): string | undefined {
  return existsSync(join(root, TURBO)) ? undefined : `no ${TURBO} was found, so there was nothing to check`;
}

export function checkTaskCache(project: Project): Finding[] {
  const file = join(project.root, TURBO);

  if (!existsSync(file)) {
    return [];
  }

  const turbo = parseJsonWithComments(readFileSync(file, "utf8")) as TurboConfig | undefined;

  if (turbo === undefined || typeof turbo !== "object") {
    return [{ gate: GATE, file: TURBO, message: `${TURBO} could not be read as JSON, so the task cache was not checked. That is no verdict, not a pass.` }];
  }

  return [...checkTasksSeeUpstream(project, turbo), ...checkSharedConfigIsGlobal(project, turbo)];
}

function checkTasksSeeUpstream({ config }: Project, turbo: TurboConfig): Finding[] {
  const tasks = turbo.tasks ?? turbo.pipeline ?? {};

  function seesUpstream(name: string, visited: Set<string>): boolean {
    return (tasks[name]?.dependsOn ?? []).some((dependency) => {
      if (dependency.startsWith("^")) {
        return true;
      }

      // `package#task` names one package, which is not "whatever this one imports".
      if (dependency.includes("#") || visited.has(dependency)) {
        return false;
      }

      return seesUpstream(dependency, new Set([...visited, dependency]));
    });
  }

  return Object.entries(tasks)
    .filter(([name, task]) => {
      // A root task (`//#name`) reads the root, which every key already includes.
      const judged = !name.startsWith("//#") && task.cache !== false && !config.tasksThatReadNothingUpstream[name];

      return judged && !seesUpstream(name, new Set([name]));
    })
    .map(([name]) => ({
      gate: GATE,
      file: TURBO,
      message: `The task "${name}" is cached, and its key leaves out the packages a package imports: change one of them and turbo replays the old result for every package that reads it. Give it dependsOn ["transit"], with a task "transit": { "dependsOn": ["^transit"] } that matches no script, so tasks still run in parallel. If this task reads nothing outside its own package, list it under tasksThatReadNothingUpstream in the architecture config with the reason.`,
    }));
}

function checkSharedConfigIsGlobal({ root, workspace }: Project, turbo: TurboConfig): Finding[] {
  const global = turbo.globalDependencies ?? [];
  const findings: Finding[] = [];

  for (const { path } of workspace) {
    for (const name of listTsconfigs(join(root, path))) {
      for (const shared of extendedFilesOf(root, `${path}/${name}`)) {
        if (!shared.startsWith(`${path}/`) && !global.some((pattern) => matchesPath(shared, pattern))) {
          findings.push({
            gate: GATE,
            file: TURBO,
            message: `${path}/${name} extends ${shared}, which is outside the package and not under globalDependencies: change it and every typecheck replays its old result. Add "${shared}" to globalDependencies in ${TURBO}.`,
          });
        }
      }
    }
  }

  return findings;
}

function listTsconfigs(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter((name) => /^tsconfig(\..+)?\.json$/.test(name)) : [];
}

/** The files a tsconfig extends by relative path, from the root. A package name (`@tsconfig/node22`) is not a file here. */
function extendedFilesOf(root: string, tsconfig: string): string[] {
  const parsed = parseJsonWithComments(readFileSync(join(root, tsconfig), "utf8")) as { extends?: string | string[] } | undefined;
  const targets = [parsed?.extends ?? []].flat();

  return targets
    .filter((target) => target.startsWith("."))
    .map((target) => normalize(join(tsconfig, "..", target)).replaceAll("\\", "/"))
    .map((path) => (!existsSync(join(root, path)) && existsSync(join(root, `${path}.json`)) ? `${path}.json` : path))
    .filter((path) => !path.startsWith(".."));
}

/** `pattern` is a path, or a glob with `*` (within a folder) and `**` (across folders). */
function matchesPath(path: string, pattern: string): boolean {
  const expression = pattern
    .replace(/^\.\//, "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");

  return new RegExp(`^${expression}$`).test(path);
}
