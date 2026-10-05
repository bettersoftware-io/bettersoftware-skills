#!/usr/bin/env node
// Proves that a project's cached tasks notice a change they depend on.
//
//   node scripts/check-task-cache.mts <project>      (installed, with turbo)
//
// Packages in the starter export their TypeScript source, so a package's
// typecheck and its tests read the source of the packages it imports. Turbo
// keys a task's cache on that package's own files unless the task graph says
// otherwise. If it does not, a change in the domain replays "passed" for every
// package that imports it: a green that means nothing, on a developer's
// machine and in the agent's stop hook, though not in CI, which starts cold.
//
// This asks turbo for each task's cache key (a dry run: nothing is executed),
// edits one file, asks again, and fails unless every key that should have
// changed did. The file is put back afterwards.
//
// Exit 0: every key moved. Exit 1: some did not. Exit 2: it could not run.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TASKS = ["typecheck", "test"];
/** The package every other one imports, directly or not. */
const INNERMOST = "packages/domain";
/** Read by every package's typecheck through `extends`. */
const SHARED_CONFIG = "tsconfig.base.json";

class CheckError extends Error {}

interface DryRun {
  tasks: { taskId: string; hash: string }[];
}

/** Task id → cache key, for every task of every package. */
function readCacheKeys(project: string): Map<string, string> {
  const run = spawnSync("pnpm", ["exec", "turbo", "run", ...TASKS, "--dry=json"], {
    cwd: project,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (run.status !== 0) {
    throw new CheckError(`turbo could not plan the tasks:\n${(run.stderr || run.stdout).trim().slice(0, 600)}`);
  }

  const { tasks } = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as DryRun;

  return new Map(tasks.map(({ taskId, hash }) => [taskId, hash]));
}

/** The task ids whose key is the same before and after `file` gains one line. */
function findBlindTasks(project: string, file: string, expected: (taskId: string) => boolean): string[] {
  const path = join(project, file);
  const original = readFileSync(path, "utf8");
  const before = readCacheKeys(project);

  try {
    writeFileSync(path, `${original}\n`);

    const after = readCacheKeys(project);

    return [...before].filter(([taskId, hash]) => expected(taskId) && after.get(taskId) === hash).map(([taskId]) => taskId);
  } finally {
    writeFileSync(path, original);
  }
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readManifest(project: string, directory: string): Manifest {
  return JSON.parse(readFileSync(join(project, directory, "package.json"), "utf8")) as Manifest;
}

/** The names of `name` and of every workspace package that imports it, directly or through another. */
function findDependents(project: string, name: string): Set<string> {
  const manifests = readdirSync(join(project, "packages"))
    .filter((directory) => existsSync(join(project, "packages", directory, "package.json")))
    .map((directory) => readManifest(project, `packages/${directory}`));
  const found = new Set([name]);
  let grew = true;

  while (grew) {
    grew = false;

    for (const manifest of manifests) {
      const imports = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

      if (!found.has(manifest.name) && imports.some((imported) => found.has(imported))) {
        found.add(manifest.name);
        grew = true;
      }
    }
  }

  return found;
}

function findFirstSourceFile(project: string, directory: string): string {
  const index = `${directory}/src/index.ts`;

  if (existsSync(join(project, index))) {
    return index;
  }

  const [first] = readdirSync(join(project, directory, "src")).filter((name) => name.endsWith(".ts"));

  if (first === undefined) {
    throw new CheckError(`${directory}/src holds no TypeScript file to edit`);
  }

  return `${directory}/src/${first}`;
}

export function checkTaskCache(project: string): string[] {
  if (!existsSync(join(project, "turbo.json")) || !existsSync(join(project, INNERMOST, "package.json"))) {
    throw new CheckError(`${project} is not a project with a turbo.json and ${INNERMOST}`);
  }

  const lines: string[] = [];
  const innermost = readManifest(project, INNERMOST).name;
  const dependents = findDependents(project, innermost);
  const upstream = findFirstSourceFile(project, INNERMOST);
  const blindToUpstream = findBlindTasks(project, upstream, (taskId) => dependents.has(taskId.split("#")[0]));
  const blindToConfig = findBlindTasks(project, SHARED_CONFIG, (taskId) => taskId.endsWith("#typecheck"));

  lines.push(
    blindToUpstream.length === 0
      ? `PASS a change in ${upstream} moves the cache key of every task in the ${dependents.size} package(s) that read it`
      : `FAIL a change in ${upstream} (${innermost}) leaves ${blindToUpstream.length} cache key(s) as they were: ${blindToUpstream.join(", ")}. Those tasks would replay an old result. Give them a dependency on the packages they import: a "transit" task with dependsOn ["^transit"], and dependsOn ["transit"] on each of them.`,
    blindToConfig.length === 0
      ? `PASS a change in ${SHARED_CONFIG} moves the cache key of every typecheck`
      : `FAIL a change in ${SHARED_CONFIG} leaves ${blindToConfig.length} typecheck cache key(s) as they were: ${blindToConfig.join(", ")}. List the file under globalDependencies in turbo.json.`,
  );

  return lines;
}

const [target] = process.argv.slice(2);

if (target === undefined) {
  console.error("usage: check-task-cache.mts <project>");
  process.exit(2);
}

try {
  const lines = checkTaskCache(resolve(target));

  console.log(lines.join("\n"));
  process.exit(lines.some((line) => line.startsWith("FAIL")) ? 1 : 0);
} catch (error) {
  console.error(error instanceof CheckError ? `the cache check could not run: ${error.message}` : error);
  process.exit(2);
}
