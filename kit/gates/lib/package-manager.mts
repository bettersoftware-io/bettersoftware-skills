// Package-manager gate: the root package.json names the package manager by
// one exact version, with the sha512 hash of that release.
//
// `packageManager` is what Corepack reads to decide which pnpm to download,
// in every workflow and on a new machine. With a version alone, whatever the
// registry answers under that version is run. With the hash after it,
// Corepack compares the download with the hash first and refuses another
// file. The hash is the only thing that pins the tool that installs
// everything else: the lockfile pins what pnpm installs, and nothing in it
// pins pnpm.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding, Project } from "./config.mts";

const GATE = "package-manager";
const ROOT_MANIFEST = "package.json";

/** Prints the field with its hash, and writes it with `--write`. */
const HELPER = "node tools/arch/ci/pin-package-manager.mts";

/** `pnpm@12.6.0`, then `+sha512.` and the hash in hex. Corepack's own form. */
const NAME_AND_VERSION = /^(?<name>[a-z][a-z0-9-]*)@(?<version>\d+\.\d+\.\d+)(?<rest>.*)$/;
const SHA512_SUFFIX = /^\+sha512\.[0-9a-f]{128}$/;

interface Manifest {
  packageManager?: unknown;
}

/** Why this gate judged nothing, if it did. */
export function packageManagerSkipReason({ root }: Pick<Project, "root">): string | undefined {
  return existsSync(join(root, ROOT_MANIFEST)) ? undefined : "no package.json was found at the root, so there was nothing to check";
}

export function checkPackageManager({ root }: Pick<Project, "root">, onlyFiles?: string[]): Finding[] {
  if ((onlyFiles && !onlyFiles.includes(ROOT_MANIFEST)) || !existsSync(join(root, ROOT_MANIFEST))) {
    return [];
  }

  const { packageManager } = JSON.parse(readFileSync(join(root, ROOT_MANIFEST), "utf8")) as Manifest;
  const finding = (message: string): Finding[] => [{ gate: GATE, file: ROOT_MANIFEST, message }];

  if (typeof packageManager !== "string" || packageManager === "") {
    return finding(
      `There is no packageManager field, so nothing says which package manager installs this project, or which version: each machine and each workflow uses the one it happens to have. Add "packageManager": "pnpm@<version>+sha512.<hash>". \`${HELPER} pnpm@<version>\` prints the line for a version.`,
    );
  }

  const parts = NAME_AND_VERSION.exec(packageManager)?.groups;

  if (parts === undefined) {
    return finding(
      `packageManager is "${packageManager}". Write one exact version, as "pnpm@12.6.0+sha512.<hash>": a range or a tag lets two installs of the same commit run two package managers. \`${HELPER} pnpm@<version>\` prints the line for a version.`,
    );
  }

  if (!SHA512_SUFFIX.test(parts.rest ?? "")) {
    const { name, version, rest } = parts;
    const found = rest === "" ? "has no hash after the version" : `ends in "${abbreviate(rest ?? "")}", which is not +sha512. and 128 hex digits`;

    return finding(
      `packageManager is "${name}@${version}" and ${found}. Corepack downloads ${name} ${version} in every workflow, and without the hash it runs whatever the registry answers under that version. With "+sha512.<hash>" after the version it compares the download first and refuses another file. Run \`${HELPER} --write\`: it asks the registry for the hash of ${name} ${version} and writes the field.`,
    );
  }

  return [];
}

function abbreviate(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}
