#!/usr/bin/env node
// Says whether an add-on is in this project. A command that only works with
// another add-on runs this first, so that it stops with a reason and does not
// improvise the part that is missing.
//
//   node tools/agent-workflow/requires.mts coverage
//
// Exit 0: the add-on is installed. Exit 2: it is not, or the record of what
// is installed cannot be read; the line printed says how to add it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/main.mts";

/** Written by the installer: one key per unit it has put in the project. */
const RECORD = "tools/installed.json";

/** The units the installer has recorded in the project. Undefined when there is no readable record. */
export function installedIn(root: string): string[] | undefined {
  try {
    const record: unknown = JSON.parse(readFileSync(join(root, RECORD), "utf8"));

    return typeof record === "object" && record !== null && !Array.isArray(record) ? Object.keys(record) : undefined;
  } catch {
    // No record, or one that is not JSON: either way there is nothing to read.
    return undefined;
  }
}

export function requires(root: string, addon: string | undefined, report: (line: string) => void): number {
  if (addon === undefined || addon === "") {
    report("usage: requires.mts <add-on>   e.g. requires.mts coverage");

    return 2;
  }

  const installed = installedIn(root);

  if (installed === undefined) {
    report(`SKIP: ${RECORD} is missing or unreadable, so there is no record of what this project has. Do not go on`);

    return 2;
  }

  if (!installed.includes(addon)) {
    report(
      `SKIP: this needs the "${addon}" add-on, which this project does not have. Add it first (add-to-project.mts <project> ${addon}), or stop here. Do not go on without it`,
    );

    return 2;
  }

  report(`OK: the "${addon}" add-on is installed`);

  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = requires(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), process.argv[2], (line) => console.log(line));
}
