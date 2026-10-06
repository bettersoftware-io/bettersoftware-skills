// App-harness gate: tests build the whole application in one helper.
//
// The function that composes the application (`createApp`) takes every port.
// A test that calls it wires its own set of fakes, so each such test is a
// second composition to keep in step, and a port added later breaks them all
// one by one. One harness file calls it; every test asks the harness.

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CorePackage, Finding, Project } from "./config.mts";
import { declaredPackages, packagesWithRole } from "./config.mts";
import { isTestScaffolding, listSourceFiles, readCodeLines } from "./files.mts";

const GATE = "app-harness";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The cores whose production source defines their compose function. */
function composingCoresOf({ root, config }: Project): CorePackage[] {
  return packagesWithRole(config, "core").filter((core) => {
    const defined = new RegExp(`\\b(?:function|const|let)\\s+${escape(core.compose)}\\b`);

    return listSourceFiles(root, `${core.path}/src`)
      .filter((file) => !isTestScaffolding(file))
      .some((file) => readCodeLines(root, file).some((code) => defined.test(code)));
  });
}

/** Why this gate judged nothing, if it did. */
export function appHarnessSkipReason(project: Project): string | undefined {
  if (composingCoresOf(project).length > 0) {
    return undefined;
  }

  const names = [...new Set(packagesWithRole(project.config, "core").map((core) => `${core.compose}(…)`))];

  return `no core package defines ${names.join(" or ") || "a compose function"}, so there was no application for a test to build`;
}

export function checkAppHarness(project: Project, onlyFiles?: string[]): Finding[] {
  const { root, config } = project;
  const cores = composingCoresOf(project);

  if (cores.length === 0) {
    return [];
  }

  const harnesses = new Set(cores.map((core) => `${core.path}/${core.appHarness}`));
  const tests = (onlyFiles ?? declaredPackages(config).flatMap(({ path }) => listSourceFiles(root, path))).filter(
    (file) => isTestScaffolding(file) && !harnesses.has(file),
  );
  const findings: Finding[] = [];

  for (const file of tests) {
    readCodeLines(root, file).forEach((code, index) => {
      for (const core of cores) {
        if (!new RegExp(`\\b${escape(core.compose)}\\s*(<[^(]*>)?\\(`).test(code)) {
          continue;
        }

        const harness = `${core.path}/${core.appHarness}`;

        findings.push({
          gate: GATE,
          file,
          line: index + 1,
          message: `A test calls ${core.compose}(…) itself. Each test that builds the application wires its own fakes, so a new port has to be added to every one of them and they drift apart. ${existsSync(join(root, harness)) ? `Ask ${harness} for the application` : `Write the one helper that calls it, ${harness}, and ask that for the application`}; if the harness cannot do what this test needs, extend the harness.`,
        });
      }
    });
  }

  return findings;
}
