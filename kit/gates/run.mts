#!/usr/bin/env node
// The architecture gates. One entry point for the editor hook, the local check
// and CI, so a file cannot pass in one place and fail in another.
//
//   node run.mts                     every gate
//   node run.mts --file a.tsx …      only the per-file gates, for the files given
//   node run.mts --root <dir>        judge another folder
//   node run.mts --json              machine-readable findings
//
// Exit 0: no findings. Exit 1: findings. Exit 2: the gates could not run.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { Finding } from "./lib/config.mts";
import { ConfigError, loadConfig } from "./lib/config.mts";
import { appHarnessSkipReason, checkAppHarness } from "./lib/app-harness.mts";
import {
  checkContractsImportNoImplementation,
  checkPortContracts,
  portContractsSkipReason,
} from "./lib/contracts.mts";
import { checkDependencies } from "./lib/depcruise.mts";
import { isMainModule } from "./lib/files.mts";
import { checkInstructionPaths, instructionsSkipReason } from "./lib/instructions.mts";
import { checkLanguage, languageSkipReason } from "./lib/language.mts";
import { checkNodeFloor, nodeFloorSkipReason } from "./lib/node-floor.mts";
import { checkPackageManager, packageManagerSkipReason } from "./lib/package-manager.mts";
import { checkPackageScripts, packageScriptsSkipReason } from "./lib/package-scripts.mts";
import { checkPlaywrightPin, playwrightPinSkipReason } from "./lib/playwright-pin.mts";
import { checkStructure, checkStructureOfFiles } from "./lib/structure.mts";
import { checkTaskCache, taskCacheSkipReason } from "./lib/task-cache.mts";
import { checkTestIds, testIdsSkipReason } from "./lib/test-ids.mts";
import { checkTypesOnly, typesOnlySkipReason } from "./lib/types-only.mts";
import { checkDumbUi, dumbUiSkipReason } from "./lib/ui-bans.mts";

export interface GateOptions {
  root?: string;
  /** Judge only these files, with the per-file gates. */
  files?: string[];
  configFile?: string;
}

export interface GateResult {
  gates: string[];
  /** Gate → why it judged nothing. A gate listed here has not passed. */
  skipped: Record<string, string>;
  findings: Finding[];
}

export async function runGates({ root = process.cwd(), files, configFile }: GateOptions = {}): Promise<GateResult> {
  const project = await loadConfig(root, configFile);

  if (files) {
    const relativeFiles = files
      .map((file) => relative(project.root, resolve(project.root, file)))
      .filter((file) => !file.startsWith("..") && existsSync(join(project.root, file)));

    // Each of these reads the one file and, at most, the declaration: cheap
    // enough to run after every edit. A skip here is one the declaration
    // decides; whether the files given held anything to judge is not reported.
    return {
      gates: [
        "structure",
        "typescript-only",
        "dumb-ui",
        "port-contracts",
        "package-scripts",
        "node-floor",
        "package-manager",
        "app-harness",
        "test-ids",
        "types-only",
      ],
      skipped: dropUndefined({
        "typescript-only": languageSkipReason(project),
        "node-floor": nodeFloorSkipReason(project),
        "package-manager": packageManagerSkipReason(project),
        "app-harness": appHarnessSkipReason(project),
        "test-ids": testIdsSkipReason(project),
        "types-only": typesOnlySkipReason(project),
      }),
      findings: [
        ...checkStructureOfFiles(project, relativeFiles),
        ...checkLanguage(project, relativeFiles),
        ...checkDumbUi(project, relativeFiles),
        ...checkContractsImportNoImplementation(project, relativeFiles),
        ...checkPackageScripts(project, relativeFiles),
        ...checkNodeFloor(project, relativeFiles),
        ...checkPackageManager(project, relativeFiles),
        ...checkAppHarness(project, relativeFiles),
        ...checkTestIds(project, relativeFiles),
        ...checkTypesOnly(project, relativeFiles),
      ],
    };
  }

  return {
    gates: [
      "structure",
      "typescript-only",
      "dumb-ui",
      "port-contracts",
      "dependencies",
      "agent-docs",
      "task-cache",
      "package-scripts",
      "node-floor",
      "package-manager",
      "app-harness",
      "test-ids",
      "types-only",
      "playwright-pin",
    ],
    skipped: dropUndefined({
      "typescript-only": languageSkipReason(project),
      "dumb-ui": dumbUiSkipReason(project),
      "port-contracts": portContractsSkipReason(project),
      "agent-docs": instructionsSkipReason(project),
      "task-cache": taskCacheSkipReason(project),
      "package-scripts": packageScriptsSkipReason(project),
      "node-floor": nodeFloorSkipReason(project),
      "package-manager": packageManagerSkipReason(project),
      "app-harness": appHarnessSkipReason(project),
      "test-ids": testIdsSkipReason(project),
      "types-only": typesOnlySkipReason(project),
      "playwright-pin": playwrightPinSkipReason(project),
    }),
    findings: [
      ...checkStructure(project),
      ...checkLanguage(project),
      ...checkDumbUi(project),
      ...checkPortContracts(project),
      ...checkDependencies(project),
      ...checkInstructionPaths(project),
      ...checkTaskCache(project),
      ...checkPackageScripts(project),
      ...checkNodeFloor(project),
      ...checkPackageManager(project),
      ...checkAppHarness(project),
      ...checkTestIds(project),
      ...checkTypesOnly(project),
      ...checkPlaywrightPin(project),
    ],
  };
}

function dropUndefined(record: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function formatFindings({ gates, findings, skipped }: GateResult): string {
  const lines: string[] = [];

  for (const gate of gates) {
    const ofGate = findings.filter((finding) => finding.gate === gate);

    if (ofGate.length === 0) {
      // Nothing to judge is reported as such: it is not a pass.
      lines.push(skipped[gate] ? `SKIP ${gate} — ${skipped[gate]}` : `PASS ${gate}`);
      continue;
    }

    lines.push(`FAIL ${gate} (${ofGate.length})`);

    for (const finding of ofGate) {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(project)";
      lines.push(`  ${where}`, `    ${finding.message}`);
    }
  }

  lines.push("", findings.length === 0 ? "all gates passed." : `${findings.length} finding(s).`);

  return lines.join("\n");
}

interface CommandLine extends GateOptions {
  json: boolean;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (value === undefined) {
      throw new ConfigError(`"${argument}" needs a value`);
    }

    if (argument === "--root") {
      options.root = value;
    } else if (argument === "--config") {
      options.configFile = value;
    } else if (argument === "--file") {
      options.files = [...(options.files ?? []), value];
    } else {
      throw new ConfigError(`unknown argument "${argument}"`);
    }

    index += 1;
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const { json, ...options } = parseArguments(process.argv.slice(2));
    const result = await runGates(options);

    console.log(json ? JSON.stringify(result, null, 2) : formatFindings(result));
    process.exit(result.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof ConfigError ? `gates could not run: ${error.message}` : error);
    process.exit(2);
  }
}
