#!/usr/bin/env node
// Checks that the workspace asks for one version of each dependency, with
// manypkg and syncpack.
//
//   node tools/repo-hygiene/check-versions.mts
//
// Two packages that ask for different ranges of one dependency can each get
// their own copy. For most libraries that is waste; for one that keeps state
// (React, RxJS) it is two libraries that do not see each other.
//
// syncpack's settings are in `tools/repo-hygiene/syncpack.json`, which is the
// project's file to edit.
//
// Exit 0: no findings, or nothing to compare (SKIP). Exit 1: findings.
// Exit 2: a tool could not run.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isMainModule } from "./lib/files.mts";
import { CouldNotRun, firstLine, installedTools, type RunTool } from "./lib/run.mts";

const GATE = "versions";

export const CONFIG = "tools/repo-hygiene/syncpack.json";

/** How manypkg starts a line that reports a broken rule. */
const MANYPKG_ERROR = /^\S*\s*error\s+(.*)$/;

const SAME_RANGE = "Give every package the same range for the dependency, then run `pnpm install`.";

/**
 * What to do about each kind of finding manypkg has, by the words it uses.
 * One sentence fits one kind only: "give every package the same range" does
 * nothing for names that are out of order.
 */
const MANYPKG_ADVICE: [RegExp, string][] = [
  [
    /dependencies are unsorted/,
    "Put the names in each dependency map of that package.json in order. No version changes. The order is by character code, so every `@scope/…` name comes before a plain one, and `@types/…` before `@zeta/…`.",
  ],
  [/but the most common range in the repo is/, SAME_RANGE],
  [/without using the workspace: protocol|is not within range of the depended on version/, "Depend on a package of this workspace as `workspace:*`, then run `pnpm install`."],
  [/has a dependency and a (devDependency|optionalDependency) on/, "Keep the entry under `dependencies` and take the other out."],
  [/root package\.json contains dependencies/, "Move them to `devDependencies`: the root package is never published, so the difference means nothing there."],
  [/has a peerDependency on/, "Name it under `devDependencies` too, with a range inside the peer range."],
  [/does not have a name|is an invalid package name/, "Give that package.json a valid `name`."],
  [/repository field/, "Set `repository` in that package.json to what the finding says."],
];

const OTHER_MANYPKG_ADVICE = "This check has no advice written for this finding: manypkg's own sentence says what it wants.";

/** The advice that fits one manypkg finding. */
export function adviseOn(finding: string): string {
  return MANYPKG_ADVICE.find(([words]) => words.test(finding))?.[1] ?? OTHER_MANYPKG_ADVICE;
}

/** manypkg's findings as lines: each kind together, in the order first seen, with its advice under it once. */
function describeManypkg(findings: string[]): string[] {
  const kinds = [...new Set(findings.map(adviseOn))];

  return kinds.flatMap((advice) => [...findings.filter((finding) => adviseOn(finding) === advice).map((finding) => `  ${finding}`), `    ${advice}`]);
}

export interface VersionCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  /** manypkg's findings, one per line. */
  manypkg: string[];
  /** syncpack's report when it found a mismatch, else empty. */
  syncpack: string;
  /** Dependency entries compared. */
  entries: number;
  /** package.json files they were read from. */
  packages: number;
}

export function checkVersions(root: string = process.cwd(), run: RunTool = installedTools(resolve(root))): VersionCheck {
  if (!existsSync(join(resolve(root), CONFIG))) {
    throw new CouldNotRun(`${CONFIG} is missing. It holds syncpack's settings; add the add-on again to get it back.`);
  }

  // syncpack does not stop at a settings file it cannot read: it goes on
  // without one, and reports every workspace package as a mismatch.
  try {
    JSON.parse(readFileSync(join(resolve(root), CONFIG), "utf8"));
  } catch (error) {
    throw new CouldNotRun(`${CONFIG} is not JSON: ${(error as Error).message}`);
  }

  const manypkg = readManypkg(run("manypkg", ["check"]));
  const lint = run("syncpack", ["lint", "--config", CONFIG]);
  const listing = run("syncpack", ["json", "--config", CONFIG]);
  const entries = readEntries(listing.stdout);

  // syncpack: 0 clean, 1 a mismatch or a failure to start. A mismatch is in
  // the listing; a failure to start leaves the listing empty.
  if (lint.status !== 0 && entries.length === 0) {
    throw new CouldNotRun(`syncpack stopped with exit ${lint.status}: ${firstLine(lint.stderr, lint.stdout, listing.stderr)}`);
  }

  if (lint.status !== 0 && lint.status !== 1) {
    throw new CouldNotRun(`syncpack stopped with exit ${lint.status}: ${firstLine(lint.stderr, lint.stdout)}`);
  }

  return {
    gate: GATE,
    ...(entries.length === 0 ? { skipped: "no dependency in any package.json" } : {}),
    manypkg,
    syncpack: lint.status === 0 ? "" : `${lint.stdout}${lint.stderr}`.trim(),
    entries: entries.length,
    packages: new Set(entries).size,
  };
}

/** manypkg's findings, without the rule this check leaves out. */
function readManypkg({ status, stdout, stderr }: { status: number; stdout: string; stderr: string }): string[] {
  if (status === 0) {
    return [];
  }

  const errors = `${stderr}\n${stdout}`.split("\n").flatMap((line) => MANYPKG_ERROR.exec(line)?.[1] ?? []);

  // It failed and named no rule: it did not check anything.
  if (errors.length === 0) {
    throw new CouldNotRun(`manypkg stopped with exit ${status}: ${firstLine(stderr, stdout)}`);
  }

  return errors;
}

/** The package.json each dependency entry was read from, one per entry, from `syncpack json`. */
function readEntries(listing: string): string[] {
  return listing
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return String((JSON.parse(line) as { package?: unknown }).package);
      } catch {
        throw new CouldNotRun(`syncpack's listing has a line that is not JSON: ${line.slice(0, 80)}`);
      }
    });
}

export function formatResult({ gate, skipped, manypkg, syncpack, entries, packages }: VersionCheck): string {
  if (manypkg.length === 0 && syncpack === "") {
    // Nothing to judge is reported as such: it is not a pass.
    return skipped === undefined
      ? `PASS ${gate} — ${entries} dependency entries in ${packages} package.json file(s) agree`
      : `SKIP ${gate} — ${skipped}`;
  }

  return [
    `FAIL ${gate}`,
    ...(manypkg.length === 0 ? [] : ["", "manypkg:", ...describeManypkg(manypkg)]),
    // syncpack reports one kind of finding: a range that differs.
    ...(syncpack === ""
      ? []
      : [
          "",
          "syncpack:",
          ...syncpack.split("\n").map((line) => `  ${line}`),
          "",
          SAME_RANGE,
          `A dependency that must differ on purpose gets a version group in ${CONFIG}, with a label that says why.`,
        ]),
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkVersions();

    console.log(formatResult(result));
    process.exit(result.manypkg.length === 0 && result.syncpack === "" ? 0 : 1);
  } catch (error) {
    console.error(error instanceof CouldNotRun ? `check:versions could not run: ${error.message}` : error);
    process.exit(2);
  }
}
