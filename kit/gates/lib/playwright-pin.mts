// Playwright-pin gate: one exact Playwright version, in every package that
// uses it and in every workflow that runs it.
//
// The npm package brings its own browser build; the container image a
// workflow runs in brings another. When the two versions differ the tests
// either cannot start in CI, or run in a browser the developer never ran
// them in, and a golden image is compared with pixels of another build. Two
// packages on two versions run two browsers on one machine.
//
// So the version is exact (no `^`), the same in every package.json that asks
// for it, the one that is installed, and the tag of every workflow's image.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding, Project } from "./config.mts";

const GATE = "playwright-pin";
const PACKAGE = "@playwright/test";
const WORKFLOWS = ".github/workflows";
const IMAGE_TAG = /mcr\.microsoft\.com\/playwright:v([^\s"'-]+)-/g;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Declared {
  /** The package.json, as a path from the root. */
  file: string;
  /** The folder it is in: "" for the root. */
  directory: string;
  version: string;
}

interface ImageTag {
  file: string;
  version: string;
}

/** Why this gate judged nothing, if it did. */
export function playwrightPinSkipReason(project: Project): string | undefined {
  return findDeclared(project).length === 0
    ? `no package.json asks for ${PACKAGE}, so there was no version to hold`
    : undefined;
}

export function checkPlaywrightPin(project: Project): Finding[] {
  const declared = findDeclared(project);
  // What every other place is held to. A range names no version, so nothing is compared with one.
  const first = declared.find(({ version }) => EXACT_VERSION.test(version));
  const findings: Finding[] = [];

  for (const { file, directory, version } of declared) {
    if (!EXACT_VERSION.test(version)) {
      findings.push({
        gate: GATE,
        file,
        message: `${PACKAGE} is "${version}". Write the exact version, with no ^ or ~: a range lets an install move to a browser build nothing was checked with.`,
      });

      continue;
    }

    const installed = readInstalledVersion(project.root, directory);

    if (installed !== undefined && installed !== version) {
      findings.push({
        gate: GATE,
        file,
        message: `${PACKAGE} ${installed} is installed but this file says ${version}. Run pnpm install.`,
      });
    }

    if (first !== undefined && version !== first.version) {
      findings.push({
        gate: GATE,
        file,
        message: `${PACKAGE} is ${version} here and ${first.version} in ${first.file}. Two versions are two browser builds on one machine: write the same version in both.`,
      });
    }
  }

  if (first === undefined) {
    return findings;
  }

  for (const { file, version } of findImageTags(project.root)) {
    if (version !== first.version) {
      findings.push({
        gate: GATE,
        file,
        message: `The container image is Playwright ${version}, but ${PACKAGE} is ${first.version} in ${first.file}. Change the image tag to v${first.version}-… in the same commit as the npm version, then redraw any golden image: a new browser build draws new pixels.`,
      });
    }
  }

  return findings;
}

/** Every package.json that asks for Playwright: the root's, then each workspace package's. */
function findDeclared({ root, workspace }: Project): Declared[] {
  return ["", ...workspace.map(({ path }) => path)].flatMap((directory) => {
    const file = directory === "" ? "package.json" : `${directory}/package.json`;

    if (!existsSync(join(root, file))) {
      return [];
    }

    const { dependencies, devDependencies } = JSON.parse(readFileSync(join(root, file), "utf8")) as Manifest;
    const version = devDependencies?.[PACKAGE] ?? dependencies?.[PACKAGE];

    return version === undefined ? [] : [{ file, directory, version }];
  });
}

function readInstalledVersion(root: string, directory: string): string | undefined {
  const installed = join(root, directory, "node_modules", PACKAGE, "package.json");

  if (!existsSync(installed)) {
    return undefined;
  }

  return (JSON.parse(readFileSync(installed, "utf8")) as { version?: string }).version;
}

function findImageTags(root: string): ImageTag[] {
  const directory = join(root, WORKFLOWS);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) =>
      [...readFileSync(join(directory, name), "utf8").matchAll(IMAGE_TAG)].map((match) => ({
        file: `${WORKFLOWS}/${name}`,
        version: match[1] as string,
      })),
    );
}
