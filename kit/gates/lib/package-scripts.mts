// Package-scripts gate: every workspace package has a `typecheck` script and a
// test script.
//
// A task runner runs a task only in the packages that declare its script, and
// says nothing about the rest. A new package with no `typecheck` is therefore
// never typechecked, and one with no `test` never tested, with every run
// green. Read from each package.json, so the gate needs no task runner to run.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding, Project } from "./config.mts";

const GATE = "package-scripts";

interface Manifest {
  scripts?: Record<string, string>;
}

/** Why this gate judged nothing, if it did. */
export function packageScriptsSkipReason({ workspace }: Project): string | undefined {
  return workspace.length === 0 ? "no workspace package was found, so there was nothing to check" : undefined;
}

export function checkPackageScripts({ root, config, workspace }: Project, onlyFiles?: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const { path, name } of workspace) {
    const file = `${path}/package.json`;

    if ((onlyFiles && !onlyFiles.includes(file)) || !existsSync(join(root, file))) {
      continue;
    }

    const { scripts = {} } = JSON.parse(readFileSync(join(root, file), "utf8")) as Manifest;

    if (!("typecheck" in scripts)) {
      findings.push({
        gate: GATE,
        file,
        message: `${name} has no "typecheck" script. The task runner skips a package without one and says nothing, so this package's types are never checked. Add "typecheck": "tsc --noEmit -p tsconfig.json" to its scripts.`,
      });
    }

    const hasTests = Object.keys(scripts).some((script) => /^test(:|$)/.test(script));

    if (!hasTests && !config.packagesWithoutTests[path]) {
      findings.push({
        gate: GATE,
        file,
        message: `${name} has no "test" script (or "test:…" one). The task runner skips a package without one and says nothing, so nothing here is ever tested and every run is green. Add "test": "vitest run" to its scripts, or list "${path}" under packagesWithoutTests in architecture.config.mts with the reason it has no tests.`,
      });
    }
  }

  return findings;
}
