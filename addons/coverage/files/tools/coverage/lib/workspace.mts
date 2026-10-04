// Finds the workspace packages, from `pnpm-workspace.yaml`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CoverageError } from "./config.mts";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** Every workspace package folder, as a path from `root`, sorted. */
export function listPackages(root: string): string[] {
  const file = join(root, WORKSPACE_FILE);

  if (!existsSync(file)) {
    throw new CoverageError(`${WORKSPACE_FILE} not found in ${root} — run this from the project root`);
  }

  const patterns = readPackagePatterns(readFileSync(file, "utf8"));
  const excluded = new Set(patterns.filter(isNegated).flatMap((pattern) => expandPattern(root, pattern.slice(1))));
  const packages = patterns
    .filter((pattern) => !isNegated(pattern))
    .flatMap((pattern) => expandPattern(root, pattern))
    .filter((directory) => !excluded.has(directory) && existsSync(join(root, directory, "package.json")));

  if (packages.length === 0) {
    throw new CoverageError(`${WORKSPACE_FILE} lists no package that exists — nothing to measure`);
  }

  return [...new Set(packages)].sort();
}

/** The entries of the top-level `packages:` list. */
export function readPackagePatterns(yaml: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of yaml.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (!inPackages || line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    const entry = /^\s+-\s+(.+?)\s*$/.exec(line);

    if (!entry?.[1]) {
      // The next top-level key ends the list.
      inPackages = false;
      continue;
    }

    patterns.push(entry[1].replace(/^(['"])(.*)\1$/, "$2"));
  }

  return patterns;
}

function isNegated(pattern: string): boolean {
  return pattern.startsWith("!");
}

/** Folders matching `pattern`, where `*` stands for any part of one folder name. */
function expandPattern(root: string, pattern: string): string[] {
  const segments = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/");

  if (segments.includes("**")) {
    throw new CoverageError(`${WORKSPACE_FILE}: "${pattern}" uses **, which this tool does not expand — list the folders with *`);
  }

  let found = [""];

  for (const segment of segments) {
    found = found.flatMap((parent) => matchFolders(root, parent, segment));
  }

  return found;
}

function matchFolders(root: string, parent: string, segment: string): string[] {
  const directory = join(root, parent);

  if (!existsSync(directory)) {
    return [];
  }

  const name = new RegExp(`^${segment.split("*").map(escapeForRegExp).join(".*")}$`);

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && name.test(entry.name))
    .map((entry) => (parent === "" ? entry.name : `${parent}/${entry.name}`));
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
