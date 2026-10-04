#!/usr/bin/env node
// Creates a new project from the starter.
//
//   node scripts/create-project.mts <target> [--scope @acme] [--name my-app]
//
// Copies `starter/` to <target>, puts a real copy of the kit at `tools/arch`
// (the starter only links to it), and renames the `@app` package scope.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../kit/gates/lib/files.mts";
import { addToProject, KIT } from "./add-to-project.mts";
import { listFiles } from "./lib/install.mts";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTER_SCOPE = "@app";
const STARTER_NAME = "starter";

/** Never copied from the starter: installed or generated files, and the kit link. */
const SKIPPED_IN_STARTER = new Set(["node_modules", "dist", "coverage", ".turbo", "tools"]);

const TEXT_FILE = /\.(ts|tsx|mts|json|md|yaml|yml|html|css)$|^\.gitignore$/;

export class ProjectError extends Error {}

export interface ProjectOptions {
  target: string;
  /** The package scope, e.g. `@acme`. Defaults to `@app`. */
  scope?: string;
  /** The root package name. Defaults to the target folder's name. */
  name?: string;
}

export function createProject({ target, scope = STARTER_SCOPE, name }: ProjectOptions): string {
  const destination = resolve(target);
  const projectName = name ?? basename(destination);

  if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
    throw new ProjectError(`"${scope}" is not a package scope — expected something like @acme`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new ProjectError(`"${projectName}" is not a package name — use lower-case letters, digits and dashes`);
  }

  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new ProjectError(`${destination} is not empty`);
  }

  mkdirSync(destination, { recursive: true });

  cpSync(join(REPOSITORY, "starter"), destination, {
    recursive: true,
    filter: (source) => !SKIPPED_IN_STARTER.has(basename(source)),
  });

  // The kit goes in the way a later update does, so the project starts with a
  // record of what was installed and `add-to-project.mts <project> kit` can
  // tell an untouched file from an edited one.
  addToProject({ project: destination, unit: KIT });

  for (const file of listFiles(destination)) {
    if (!TEXT_FILE.test(basename(file)) || file.startsWith(join(destination, "tools"))) {
      continue;
    }

    const original = readFileSync(file, "utf8");
    const renamed = original.replaceAll(`${STARTER_SCOPE}/`, `${scope}/`);

    if (renamed !== original) {
      writeFileSync(file, renamed);
    }
  }

  const manifest = join(destination, "package.json");

  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(`"name": "${STARTER_NAME}"`, `"name": "${projectName}"`));

  return destination;
}

function parseArguments(argv: string[]): ProjectOptions {
  const [target, ...rest] = argv;

  if (target === undefined || target.startsWith("--")) {
    throw new ProjectError("usage: create-project.mts <target> [--scope @acme] [--name my-app]");
  }

  const options: ProjectOptions = { target };

  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];

    if (value === undefined) {
      throw new ProjectError(`"${flag}" needs a value`);
    }

    if (flag === "--scope") {
      options.scope = value;
    } else if (flag === "--name") {
      options.name = value;
    } else {
      throw new ProjectError(`unknown argument "${flag}"`);
    }
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const destination = createProject(parseArguments(process.argv.slice(2)));

    console.log(`Created ${destination}\n\nNext:\n  cd ${destination}\n  git init\n  pnpm install\n  pnpm gate:full`);
  } catch (error) {
    console.error(error instanceof ProjectError ? error.message : error);
    process.exit(1);
  }
}
