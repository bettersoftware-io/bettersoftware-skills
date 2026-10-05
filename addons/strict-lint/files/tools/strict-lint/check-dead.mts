#!/usr/bin/env node
// Finds unused files, unused exports and unused dependencies with knip.
//
//   node tools/strict-lint/check-dead.mts
//
// What knip reads and what it leaves alone is in `tools/strict-lint/knip.jsonc`,
// which is the project's file to edit.
//
// This wrapper exists for one reason: knip in a project with no source file
// prints nothing and exits 0. Here that project is told nothing was judged.
//
// Exit 0: no findings, or nothing to judge (SKIP). Exit 1: findings.
// Exit 2: knip could not run.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { isMainModule, listSourceFiles } from "./lib/files.mts";
import { CouldNotRun, firstLine, installedTools, type RunTool } from "./lib/run.mts";

const GATE = "lint:dead";

export const CONFIG = "tools/strict-lint/knip.jsonc";

export const KNIP_ARGUMENTS: string[] = ["--config", CONFIG, "--no-progress", "--no-config-hints"];

export interface DeadCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  failed: boolean;
  /** knip's own report: the kind of finding, the name, the file and line. */
  report: string;
  /** How many TypeScript files the project has outside tools/. */
  files: number;
}

export function checkDead(root: string = process.cwd(), run: RunTool = installedTools(resolve(root))): DeadCheck {
  const project = resolve(root);
  const files = listSourceFiles(project).length;

  if (files === 0) {
    return { gate: GATE, skipped: "no TypeScript file in the project outside tools/", failed: false, report: "", files };
  }

  if (!existsSync(join(project, CONFIG))) {
    throw new CouldNotRun(`${CONFIG} is missing. It tells knip what the project is made of; add the add-on again to get it back.`);
  }

  const { status, stdout, stderr } = run("knip", KNIP_ARGUMENTS);

  // knip: 0 clean, 1 findings. 2 is a config it could not read or a crash.
  if (status !== 0 && status !== 1) {
    throw new CouldNotRun(`knip stopped with exit ${status}: ${firstLine(stderr, stdout)}`);
  }

  const report = stdout.trim();

  if (status === 1 && report === "") {
    throw new CouldNotRun(`knip failed and named no finding: ${firstLine(stderr)}`);
  }

  return { gate: GATE, failed: status === 1, report, files };
}

export function formatResult({ gate, skipped, failed, report, files }: DeadCheck): string {
  // Nothing to judge is reported as such: it is not a pass.
  if (skipped !== undefined) {
    return `SKIP ${gate} — ${skipped}`;
  }

  if (!failed) {
    return `PASS ${gate} — knip found nothing unused (${files} TypeScript file(s) in the project)`;
  }

  return [
    `FAIL ${gate}`,
    "",
    report,
    "",
    "Remove what is unused: the file, the `export` keyword, the line in package.json.",
    `If it is used in a way knip cannot see, name that file as an entry in ${CONFIG}.`,
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkDead();

    console.log(formatResult(result));
    process.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error instanceof CouldNotRun ? `lint:dead could not run: ${error.message}` : error);
    process.exit(2);
  }
}
