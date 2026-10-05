#!/usr/bin/env node
// Creates a new project from the starter.
//
//   node scripts/create-project.mts <target> [--scope @acme] [--name my-app]
//
// Copies `starter/` to <target>, puts a real copy of the kit at `tools/arch`
// (the starter only links to it), and renames the `@app` package scope.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../kit/gates/lib/files.mts";
import { addToProject, KIT } from "./add-to-project.mts";
import { listFiles } from "./lib/install.mts";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTER_SCOPE = "@app";
const STARTER_NAME = "starter";

/**
 * Never copied from the starter: installed or generated files, the kit link,
 * and the two hosts' settings folders. Those are written by the kit's setup,
 * from the kit's own templates, which also knows what to do when a host does
 * not let them be written.
 */
const SKIPPED_IN_STARTER = new Set(["node_modules", "dist", "coverage", ".turbo", "tools", ".claude", ".codex"]);

const TEXT_FILE = /\.(ts|tsx|mts|json|md|yaml|yml|html|css)$|^\.gitignore$/;

export class ProjectError extends Error {}

export interface ProjectOptions {
  target: string;
  /** The package scope, e.g. `@acme`. Defaults to `@app`. */
  scope?: string;
  /** The root package name. Defaults to the target folder's name. */
  name?: string;
}

export interface CreatedProject {
  destination: string;
  /** What is left for a person to do by hand. Empty after a normal run. */
  notes: string[];
}

/** The step that can be swapped in a test. */
export interface ProjectSteps {
  installKit: (project: string) => { notes: string[] };
}

const STEPS: ProjectSteps = {
  // The kit goes in the way a later update does, so the project starts with a
  // record of what was installed and `add-to-project.mts <project> kit` can
  // tell an untouched file from an edited one.
  installKit: (project) => addToProject({ project, unit: KIT }),
};

export function createProject({ target, scope = STARTER_SCOPE, name }: ProjectOptions, steps = STEPS): CreatedProject {
  const destination = resolve(target);
  const projectName = name ?? basename(destination);

  if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
    throw new ProjectError(`"${scope}" is not a package scope — expected something like @acme`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new ProjectError(`"${projectName}" is not a package name — use lower-case letters, digits and dashes`);
  }

  const wasThere = existsSync(destination);

  if (wasThere && readdirSync(destination).length > 0) {
    throw new ProjectError(`${destination} is not empty`);
  }

  try {
    return { destination, notes: writeProject(destination, scope, projectName, steps) };
  } catch (error) {
    // Half a project looks like a project. The folder was empty or absent, so
    // everything in it now is ours to take away again.
    removeWhatWasWritten(destination, wasThere);

    throw new ProjectError(
      `Could not create the project, and removed what it had written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeProject(destination: string, scope: string, projectName: string, steps: ProjectSteps): string[] {
  mkdirSync(destination, { recursive: true });

  cpSync(join(REPOSITORY, "starter"), destination, {
    recursive: true,
    filter: (source) => !SKIPPED_IN_STARTER.has(basename(source)),
  });

  const { notes } = steps.installKit(destination);

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

  return notes;
}

function removeWhatWasWritten(destination: string, wasThere: boolean): void {
  const leftovers = wasThere ? readdirSync(destination).map((entry) => join(destination, entry)) : [destination];

  for (const leftover of leftovers) {
    rmSync(leftover, { recursive: true, force: true });
  }
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
    const { destination, notes } = createProject(parseArguments(process.argv.slice(2)));
    const byHand = notes.length === 0 ? "" : `\n\nStill to do by hand:\n${notes.map((note) => `  - ${note}`).join("\n")}`;

    console.log(`Created ${destination}${byHand}\n\nNext:\n  cd ${destination}\n  git init\n  pnpm install\n  pnpm gate:full`);
  } catch (error) {
    console.error(error instanceof ProjectError ? error.message : error);
    process.exit(1);
  }
}
