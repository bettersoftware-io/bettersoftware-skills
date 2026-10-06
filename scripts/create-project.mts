#!/usr/bin/env node
// Creates a new project from the starter.
//
//   node scripts/create-project.mts <target> [--scope @acme] [--name my-app] [--with <add-ons>]
//
// Copies `starter/` to <target>, puts a real copy of the kit at `tools/arch`
// (the starter only links to it), renames the `@app` package scope, and
// writes the project a README of its own.
//
// `--with` takes add-on names separated by commas, or `recommended` for every
// add-on whose manifest says it is. Without it no add-on is added: the choice
// is the person's, and `add-to-project.mts` adds one at any later time.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../kit/gates/lib/files.mts";
import { addToProject, KIT, listAddons, type ListedAddon } from "./add-to-project.mts";
import { listFiles } from "./lib/install.mts";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTER_SCOPE = "@app";
const STARTER_NAME = "starter";

/**
 * The project's README is written from this, not rewritten from the starter's.
 * The starter's describes the starter to a reader of this repository; a
 * project needs its own name, scope, add-ons and first commands, and none of
 * those is a word to swap in the other text.
 */
const README_TEMPLATE = join(REPOSITORY, "scripts", "templates", "README.project.md");

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
  /** Add-on names, or `recommended` for the set the add-ons themselves recommend. */
  addons?: string[];
}

/** Stands for every add-on whose manifest recommends it. */
export const RECOMMENDED = "recommended";

export interface CreatedProject {
  destination: string;
  /** The add-ons that were added, by name. */
  addons: string[];
  /** Commands the add-ons ask to be run once, after `pnpm install` and before the gate. */
  firstRuns: string[];
  /** What is left for a person to do by hand. Empty after a normal run. */
  notes: string[];
}

/** The steps that can be swapped in a test. */
export interface ProjectSteps {
  installKit: (project: string, scope: string) => { notes: string[] };
  listAddons: () => ListedAddon[];
  addAddon: (project: string, name: string, scope: string) => { firstRun?: string };
}

const STEPS: ProjectSteps = {
  // The kit goes in the way a later update does, so the project starts with a
  // record of what was installed and `add-to-project.mts <project> kit` can
  // tell an untouched file from an edited one.
  // The scope is given, since the packages still carry the starter's when the
  // kit goes in: the kit's copy of AGENTS.md is kept in the project's scope.
  installKit: (project, scope) => addToProject({ project, unit: KIT, scope }),
  listAddons: () => listAddons(),
  addAddon: (project, name, scope) => addToProject({ project, unit: name, scope }),
};

export function createProject(
  { target, scope = STARTER_SCOPE, name, addons = [] }: ProjectOptions,
  swapped: Partial<ProjectSteps> = {},
): CreatedProject {
  const steps = { ...STEPS, ...swapped };
  const destination = resolve(target);
  const projectName = name ?? basename(destination);

  if (!/^@[a-z0-9][a-z0-9-]*$/.test(scope)) {
    throw new ProjectError(`"${scope}" is not a package scope — expected something like @acme`);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
    throw new ProjectError(`"${projectName}" is not a package name — use lower-case letters, digits and dashes`);
  }

  // Before anything is written: a mistyped name must not cost a half-made project.
  const available = steps.listAddons();
  const chosen = chooseAddons(addons, available);
  const wasThere = existsSync(destination);

  if (wasThere && readdirSync(destination).length > 0) {
    throw new ProjectError(`${destination} is not empty`);
  }

  try {
    const notes = writeProject(destination, scope, projectName, steps);

    const firstRuns = chosen.flatMap((addon) => steps.addAddon(destination, addon, scope).firstRun ?? []);
    const added = chosen.flatMap((name) => available.filter((addon) => addon.name === name));

    // Last, because it names the add-ons and the commands they ask for.
    writeFileSync(join(destination, "README.md"), projectReadme({ name: projectName, scope, addons: added, firstRuns }));

    return { destination, addons: chosen, firstRuns, notes };
  } catch (error) {
    // Half a project looks like a project. The folder was empty or absent, so
    // everything in it now is ours to take away again.
    removeWhatWasWritten(destination, wasThere);

    throw new ProjectError(
      `Could not create the project, and removed what it had written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface ReadmeFacts {
  name: string;
  scope: string;
  /** The add-ons the project was created with, in the order they were added. */
  addons: ListedAddon[];
  firstRuns: string[];
}

/** The README of a new project. `template` is replaced in a test. */
export function projectReadme({ name, scope, addons, firstRuns }: ReadmeFacts, template = readFileSync(README_TEMPLATE, "utf8")): string {
  const first = [
    "git init          # the agent's stop hook reads git to know what changed",
    "pnpm install",
    ...firstRuns,
    "pnpm gate:full    # everything CI runs",
  ];
  const added =
    addons.length === 0
      ? "None was added when the project was created."
      : ["Added when the project was created:", "", ...addons.map((addon) => `- \`${addon.name}\`: ${addon.summary}`)].join("\n");
  const facts: Record<string, string> = { name, scope, first: first.join("\n"), addons: added };

  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => {
    if (facts[key] === undefined) {
      throw new ProjectError(`the README template asks for "${placeholder}", which is not a thing a project has`);
    }

    return facts[key];
  });
}

/** The names to add: `recommended` becomes the add-ons that say they are; anything unknown is refused. */
function chooseAddons(asked: string[], available: ListedAddon[]): string[] {
  const chosen = asked.flatMap((name) =>
    name === RECOMMENDED ? available.filter((addon) => addon.recommended).map((addon) => addon.name) : [name],
  );
  const unknown = chosen.find((name) => !available.some((addon) => addon.name === name));

  if (unknown !== undefined) {
    throw new ProjectError(
      `"${unknown}" is not an add-on — there are: ${available.map((addon) => addon.name).join(", ")}, or "${RECOMMENDED}" for the recommended ones`,
    );
  }

  return [...new Set(chosen)];
}

function writeProject(destination: string, scope: string, projectName: string, steps: ProjectSteps): string[] {
  mkdirSync(destination, { recursive: true });

  cpSync(join(REPOSITORY, "starter"), destination, {
    recursive: true,
    filter: (source) => !SKIPPED_IN_STARTER.has(basename(source)),
  });

  const { notes } = steps.installKit(destination, scope);

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

export function parseArguments(argv: string[]): ProjectOptions {
  const [target, ...rest] = argv;

  if (target === undefined || target.startsWith("--")) {
    throw new ProjectError("usage: create-project.mts <target> [--scope @acme] [--name my-app] [--with recommended|<add-on>,<add-on>]");
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
    } else if (flag === "--with") {
      options.addons = value.split(",").map((addon) => addon.trim()).filter(Boolean);
    } else {
      throw new ProjectError(`unknown argument "${flag}"`);
    }
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const { destination, addons, firstRuns, notes } = createProject(parseArguments(process.argv.slice(2)));
    const once = firstRuns.map((command) => `\n  ${command}`).join("");
    const added = addons.length === 0 ? "" : `\nWith: ${addons.join(", ")}`;
    const byHand = notes.length === 0 ? "" : `\n\nStill to do by hand:\n${notes.map((note) => `  - ${note}`).join("\n")}`;

    console.log(`Created ${destination}${added}${byHand}\n\nNext:\n  cd ${destination}\n  git init\n  pnpm install${once}\n  pnpm gate:full`);
  } catch (error) {
    console.error(error instanceof ProjectError ? error.message : error);
    process.exit(1);
  }
}
