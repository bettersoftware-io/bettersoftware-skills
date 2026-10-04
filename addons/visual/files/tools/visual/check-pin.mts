#!/usr/bin/env node
// Checks that one Playwright version is used everywhere.
//
//   node tools/visual/check-pin.mts
//
// The goldens are pixels drawn by one exact browser build. The npm package
// brings its build; the container image the workflows run in brings its own.
// If the two versions drift apart the tier either cannot start in CI or draws
// with a different browser than the one the goldens came from. So the npm
// version is exact (no `^`), and every workflow's image tag carries the same
// number.
//
// Exit 0: they agree (or SKIP: no workflow uses the image). 1: they do not.
// 2: there was nothing to judge.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = "packages/client-react";
const PACKAGE = "@playwright/test";
const WORKFLOWS = ".github/workflows";
const IMAGE_TAG = /mcr\.microsoft\.com\/playwright:v([^\s"'-]+)-/g;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

export interface PinVerdict {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export function checkPin(root: string): PinVerdict {
  const manifest = join(root, CLIENT, "package.json");

  if (!existsSync(manifest)) {
    return { exitCode: 2, lines: [`playwright-pin could not run: ${CLIENT}/package.json is not there.`] };
  }

  const { devDependencies } = JSON.parse(readFileSync(manifest, "utf8")) as { devDependencies?: Record<string, string> };
  const declared = devDependencies?.[PACKAGE];

  if (declared === undefined) {
    return { exitCode: 2, lines: [`playwright-pin could not run: ${CLIENT}/package.json has no ${PACKAGE} dev dependency.`] };
  }

  const findings: string[] = [];

  if (!EXACT_VERSION.test(declared)) {
    findings.push(
      `${CLIENT}/package.json: ${PACKAGE} is "${declared}". Write the exact version, with no ^ or ~: a range lets an install move to a browser build the goldens were not drawn with.`,
    );
  }

  const installed = readInstalledVersion(root);

  if (installed !== undefined && EXACT_VERSION.test(declared) && installed !== declared) {
    findings.push(`${PACKAGE} ${installed} is installed but package.json says ${declared}. Run pnpm install.`);
  }

  const images = findImageTags(root);

  for (const { file, version } of images) {
    if (version !== declared) {
      findings.push(
        `${file}: the container image is Playwright ${version}, but ${PACKAGE} is ${declared}. Change the image tag to v${declared}-… in the same commit as the npm version, then regenerate the goldens: a new browser build draws new pixels.`,
      );
    }
  }

  if (findings.length > 0) {
    return { exitCode: 1, lines: ["FAIL playwright-pin", ...findings.map((finding) => `  ${finding}`)] };
  }

  if (images.length === 0) {
    return {
      exitCode: 0,
      lines: [`SKIP playwright-pin: no workflow in ${WORKFLOWS} uses the Playwright image, so there was nothing to compare ${PACKAGE} ${declared} with.`],
    };
  }

  return { exitCode: 0, lines: [`PASS playwright-pin: ${PACKAGE} ${declared} and ${images.length} workflow image(s) agree.`] };
}

function readInstalledVersion(root: string): string | undefined {
  const installed = join(root, CLIENT, "node_modules", PACKAGE, "package.json");

  if (!existsSync(installed)) {
    return undefined;
  }

  return (JSON.parse(readFileSync(installed, "utf8")) as { version?: string }).version;
}

function findImageTags(root: string): { file: string; version: string }[] {
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

/** True when Node was asked to run this file. Real paths, so a symlinked copy still runs. */
function isMainModule(): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const verdict = checkPin(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

  console.log(verdict.lines.join("\n"));
  process.exit(verdict.exitCode);
}
