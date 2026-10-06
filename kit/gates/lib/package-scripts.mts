// Package-scripts gate: every workspace package has a `typecheck` script and a
// test script, and no script runs ESLint in a way that lets a warning through.
//
// A task runner runs a task only in the packages that declare its script, and
// says nothing about the rest. A new package with no `typecheck` is therefore
// never typechecked, and one with no `test` never tested, with every run
// green. Read from each package.json, so the gate needs no task runner to run.
//
// ESLint exits 0 on a warning. A rule set to "warn", by the project or by a
// preset it takes in, then reports on every run and stops nothing, and the
// count only grows. `--max-warnings 0` makes a warning fail.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding, Project } from "./config.mts";

const GATE = "package-scripts";
const ROOT_MANIFEST = "package.json";

interface Manifest {
  scripts?: Record<string, string>;
}

/** Why this gate judged nothing, if it did. */
export function packageScriptsSkipReason({ root, workspace }: Project): string | undefined {
  return workspace.length === 0 && !existsSync(join(root, ROOT_MANIFEST))
    ? "no workspace package was found, so there was nothing to check"
    : undefined;
}

// `eslint` as a command: at the start of a script or after `&&`, `;`, `|` or a
// runner (`pnpm exec eslint`). Not `eslint-something`, and not a path.
const ESLINT_COMMAND = /(?:^|[\s;&|])eslint(?=\s|$)([^;&|]*)/g;

/** The ESLint commands in a script that would exit 0 on a warning. A fixer is left out: it is not a verdict. */
export function lenientLintCommands(script: string): string[] {
  return [...script.matchAll(ESLINT_COMMAND)]
    .map(([, flags = ""]) => flags)
    .filter((flags) => !/(^|\s)--fix(-dry-run)?(\s|$)/.test(flags) && !/(^|\s)--max-warnings[= ]0(\s|$)/.test(flags))
    .map((flags) => `eslint${flags}`.trim());
}

export function checkPackageScripts({ root, config, workspace }: Project, onlyFiles?: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of [ROOT_MANIFEST, ...workspace.map(({ path }) => `${path}/package.json`)]) {
    if ((onlyFiles && !onlyFiles.includes(file)) || !existsSync(join(root, file))) {
      continue;
    }

    const { scripts = {} } = JSON.parse(readFileSync(join(root, file), "utf8")) as Manifest;

    for (const [name, script] of Object.entries(scripts)) {
      for (const command of lenientLintCommands(script)) {
        findings.push({
          gate: GATE,
          file,
          message: `The script "${name}" runs \`${command}\` without --max-warnings 0. ESLint exits 0 on a warning, so a rule set to "warn" reports on every run and stops nothing. Add --max-warnings 0 to the command.`,
        });
      }
    }
  }

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

    const testScripts = Object.keys(scripts).filter((script) => /^test(:|$)/.test(script));
    const hasTests = testScripts.length > 0;

    // An e2e package's run needs a browser and a port. It is started by a
    // script of the project's root, and is no part of `pnpm test`.
    if (config.packages[path]?.role === "e2e") {
      for (const script of testScripts) {
        findings.push({
          gate: GATE,
          file,
          message: `${name} has a "${script}" script. The task runner would run it with every other package's tests, so the full gate would need a browser and a port, on every machine and in every sandbox. An e2e package is run by a script of the project's root (pnpm e2e), on its own. Remove the script, or give it a name that does not start with "test".`,
        });
      }

      continue;
    }

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
