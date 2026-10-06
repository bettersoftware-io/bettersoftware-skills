#!/usr/bin/env node
// Prints the `packageManager` field with the sha512 hash of its release, the
// form Corepack verifies a download against.
//
//   node tools/arch/ci/pin-package-manager.mts                 the version package.json names
//   node tools/arch/ci/pin-package-manager.mts pnpm@12.7.0     another version
//   node tools/arch/ci/pin-package-manager.mts --write         also write it to package.json
//
// The hash is the registry's own `dist.integrity` for that version, turned
// from base64 into the hex Corepack wants. It needs the network, so it is a
// script a person runs when the version moves, never part of a gate. The
// `package-manager` gate checks that the hash is there.
//
// Run it when you move to a newer pnpm, and leave a release a day before you
// take it, as `minimumReleaseAge` does for every other package.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "../gates/lib/files.mts";

const REGISTRY = "https://registry.npmjs.org";
const NAME_AND_VERSION = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)/;

export class PinError extends Error {}

/** Answers with the registry's document for one version of a package. Swapped in a test, which must not reach the network. */
export type ReadRelease = (name: string, version: string) => Promise<unknown>;

export interface PinOptions {
  root: string;
  /** `pnpm@12.7.0`. Left out: the name and version package.json has now. */
  wanted?: string;
  write: boolean;
  readRelease?: ReadRelease;
}

export interface Pinned {
  /** The whole value of the field: `pnpm@12.6.0+sha512.<hex>`. */
  packageManager: string;
  /** True when package.json was changed. */
  written: boolean;
}

export async function pinPackageManager({ root, wanted, write, readRelease = readFromRegistry }: PinOptions): Promise<Pinned> {
  const file = join(root, "package.json");

  if (!existsSync(file)) {
    throw new PinError(`${file} is not there: run this in the project root`);
  }

  const text = readFileSync(file, "utf8");
  const current = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
  const asked = wanted ?? (typeof current === "string" ? current : "");
  const [, name, version] = NAME_AND_VERSION.exec(asked) ?? [];

  if (name === undefined || version === undefined) {
    throw new PinError(
      wanted === undefined
        ? "package.json names no package manager with an exact version: say which, as pnpm@12.6.0"
        : `"${wanted}" is not a name and an exact version: write it as pnpm@12.6.0`,
    );
  }

  const packageManager = `${name}@${version}+sha512.${hexOf(await readRelease(name, version), `${name}@${version}`)}`;

  if (!write || packageManager === current) {
    return { packageManager, written: false };
  }

  // One line is replaced or added, so the file keeps its layout and its order.
  const line = `"packageManager": ${JSON.stringify(packageManager)}`;
  const replaced =
    typeof current === "string"
      ? text.replace(`"packageManager": ${JSON.stringify(current)}`, line)
      : text.replace(/^\{\n(\s*)/, (_start, indent: string) => `{\n${indent}${line},\n${indent}`);

  if (replaced === text) {
    throw new PinError(`could not find where to write the field in ${file}. Write it by hand: ${line}`);
  }

  writeFileSync(file, replaced);

  return { packageManager, written: true };
}

/** The sha512 of a release as hex, from the registry's `sha512-<base64>`. */
function hexOf(release: unknown, label: string): string {
  const integrity = (release as { dist?: { integrity?: unknown } } | null)?.dist?.integrity;
  const [, base64] = typeof integrity === "string" ? (/^sha512-([A-Za-z0-9+/]+=*)$/.exec(integrity) ?? []) : [];
  const hex = base64 === undefined ? "" : Buffer.from(base64, "base64").toString("hex");

  if (hex.length !== 128) {
    throw new PinError(`the registry gave no sha512 hash for ${label}, so there is nothing to pin it with`);
  }

  return hex;
}

async function readFromRegistry(name: string, version: string): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(`${REGISTRY}/${name}/${version}`, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;

    throw new PinError(`could not reach ${REGISTRY}: ${reason instanceof Error ? reason.message : String(reason)}`);
  }

  if (!response.ok) {
    throw new PinError(`${REGISTRY} answered ${response.status} for ${name}@${version}: is that a version that exists?`);
  }

  return response.json();
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);

  try {
    const { packageManager, written } = await pinPackageManager({
      root: process.cwd(),
      wanted: argv.find((argument) => !argument.startsWith("--")),
      write: argv.includes("--write"),
    });

    console.log(written ? `package.json now has "packageManager": "${packageManager}"` : `"packageManager": "${packageManager}"`);
  } catch (error) {
    console.error(error instanceof PinError ? `pin-package-manager: ${error.message}` : error);
    process.exit(1);
  }
}
