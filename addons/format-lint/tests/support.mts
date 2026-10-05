// Fixture factories shared by the format-lint add-on's tests.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const ADDON = join(import.meta.dirname, "..");
export const REPOSITORY = join(ADDON, "..", "..");
export const ROOT_CONFIG = "biome.json";
export const BASE_CONFIG = "tools/format-lint/biome.base.json";

/** The Biome this repository installs: the version the add-on pins. */
const BIOME = join(REPOSITORY, "node_modules", ".bin", "biome");

/** Written out, not built with JSON.stringify: Biome formats this file too, and keeps a short list on one line. */
const TURBO_JSON = `{
  "tasks": {
    "build": {
      "env": ["DECLARED"]
    }
  }
}
`;

export interface Manifest {
  packageJson: Record<string, { scripts?: Record<string, string>; devDependencies?: Record<string, string> }>;
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  verify: string;
}

export interface Run {
  status: number | null;
  /** Everything Biome printed, without colour codes. */
  output: string;
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as Manifest;
}

/** The root scripts the add-on adds, by name. */
export function readScripts(): Record<string, string> {
  return readManifest().packageJson["."]?.scripts ?? {};
}

/**
 * A project that has just received the add-on: the two shipped config files, a
 * .gitignore, a turbo.json that declares one environment variable, and `files`
 * (path → content). A file given under a config's own path replaces the shipped one.
 */
export function createProject(files: Record<string, string> = {}): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "format-lint-addon-")));
  const all: Record<string, string> = {
    [ROOT_CONFIG]: readFileSync(join(ADDON, "files", ROOT_CONFIG), "utf8"),
    [BASE_CONFIG]: readFileSync(join(ADDON, "files", BASE_CONFIG), "utf8"),
    ".gitignore": "node_modules/\n",
    "turbo.json": TURBO_JSON,
    ...files,
  };

  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }

  return project;
}

/** Copies a folder of this repository into a project, leaving out what a created project never receives. */
export function copyInto(project: string, source: string, skipped: ReadonlySet<string> = new Set()): void {
  cpSync(source, project, { recursive: true, filter: (path) => !skipped.has(basename(path)) });
}

/** Runs one of the add-on's root scripts in `project`, as `pnpm <name>` would. */
export function runScript(project: string, name: string): Run {
  const script = readScripts()[name];

  if (script === undefined) {
    throw new Error(`addon.json adds no script called "${name}"`);
  }

  const [command, ...scriptArguments] = script.split(" ");

  if (command !== "biome") {
    throw new Error(`the script "${name}" runs "${command}", not biome`);
  }

  const run = spawnSync(BIOME, [...scriptArguments, "--colors=off", "--max-diagnostics=none"], { cwd: project, encoding: "utf8" });

  if (run.error !== undefined) {
    throw run.error;
  }

  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** A root config that extends the base and sets `rule` in the style group. */
export function createRootConfig(rule: string, level: "off" | "error"): string {
  return `{
  "extends": ["./${BASE_CONFIG}"],
  "linter": {
    "rules": {
      "style": {
        "${rule}": "${level}"
      }
    }
  }
}
`;
}

/** The version of the Biome this repository installs, e.g. `2.5.14`. */
export function readInstalledVersion(): string {
  return spawnSync(BIOME, ["--version"], { encoding: "utf8" }).stdout.replace("Version:", "").trim();
}
