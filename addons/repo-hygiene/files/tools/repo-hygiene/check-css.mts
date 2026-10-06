#!/usr/bin/env node
// Lints the project's stylesheets with stylelint.
//
//   node tools/repo-hygiene/check-css.mts
//
// Reads every `.css` file that git does not ignore, outside installed and
// generated folders and outside `tools/`. The rules are in
// `tools/repo-hygiene/stylelint.json`, which is the project's file to edit. It
// extends `stylelint.base.json` beside it, which is the add-on's.
//
// A warning fails like an error (`--max-warnings 0`): stylelint exits 0 on a
// rule set to "warning", so it would report on every run and stop nothing.
//
// This wrapper exists for one reason: stylelint given no file either stops
// with an error or, with `--allow-empty-input`, passes without a word. Here a
// project with no stylesheet is told so.
//
// Exit 0: no findings, or no stylesheet (SKIP). Exit 1: findings.
// Exit 2: stylelint could not run.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { dropIgnored, isMainModule, listFiles } from "./lib/files.mts";
import { CouldNotRun, firstLine, installedTools, type RunTool } from "./lib/run.mts";

const GATE = "css";

export const CONFIG = "tools/repo-hygiene/stylelint.json";

/** The add-on's rules. The project's file takes them by extending this one. */
export const BASE = "tools/repo-hygiene/stylelint.base.json";

/** How many paths one stylelint run is given, to stay under the limit on a command line's length. */
const BATCH = 200;

/**
 * Why the project's rules file does not carry the add-on's rules, if it does
 * not. The file is the project's, so an update never rewrites it: one written
 * when the add-on shipped a single file still extends the preset of that
 * time, and every rule added to the base since is off there. stylelint says
 * nothing about a rule it was never given, so the check would pass.
 */
export function findMissingBase(root: string): string | undefined {
  let config: unknown;

  try {
    config = JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
  } catch (error) {
    throw new CouldNotRun(`${CONFIG} is not JSON: ${(error as Error).message}`);
  }

  const declared = (config as { extends?: unknown } | null)?.extends;
  const extended = (Array.isArray(declared) ? declared : [declared]).filter((entry): entry is string => typeof entry === "string");

  // A path in `extends` is read from the folder of the file that names it.
  if (extended.some((entry) => /^\.{1,2}\//.test(entry) && resolve(root, dirname(CONFIG), entry) === resolve(root, BASE))) {
    return undefined;
  }

  return `${CONFIG} does not extend ./stylelint.base.json, so none of the add-on's rules is on: it extends ${extended.length === 0 ? "nothing" : extended.map((entry) => `"${entry}"`).join(", ")}. Put "./stylelint.base.json" in its "extends" (the base brings the preset with it), and keep below it the rules this project changes. The file as the add-on ships it now is tools/templates/repo-hygiene.tools__repo-hygiene__stylelint.json.txt.`;
}

export interface CssCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  failed: boolean;
  /** stylelint's own report: the file, the line, the rule. */
  report: string;
  files: number;
  /** Set when the project's rules file does not extend the add-on's base. The check has failed, whatever stylelint said. */
  missingBase?: string;
}

export function checkCss(root: string = process.cwd(), run: RunTool = installedTools(resolve(root))): CssCheck {
  const project = resolve(root);
  const files = dropIgnored(project, listFiles(project, /\.css$/i));

  if (files.length === 0) {
    return { gate: GATE, skipped: "no .css file in the project", failed: false, report: "", files: 0 };
  }

  if (!existsSync(join(project, CONFIG))) {
    throw new CouldNotRun(`${CONFIG} is missing. It holds the rules; add the add-on again to get it back.`);
  }

  if (!existsSync(join(project, BASE))) {
    throw new CouldNotRun(`${BASE} is missing. It holds the add-on's rules; add the add-on again to get it back.`);
  }

  const missingBase = findMissingBase(project);
  const reports: string[] = [];

  for (let start = 0; start < files.length; start += BATCH) {
    const { status, stdout, stderr } = run("stylelint", ["--config", CONFIG, "--max-warnings", "0", ...files.slice(start, start + BATCH)]);

    // stylelint: 0 clean, 2 lint problems or more warnings than allowed. Anything else is a bad
    // configuration or a crash, and says nothing about the stylesheets.
    if (status !== 0 && status !== 2) {
      throw new CouldNotRun(`stylelint stopped with exit ${status}: ${firstLine(stderr, stdout)}`);
    }

    if (status === 2) {
      reports.push(`${stdout}${stderr}`.trim());
    }
  }

  return {
    gate: GATE,
    failed: reports.length > 0 || missingBase !== undefined,
    report: reports.join("\n\n"),
    files: files.length,
    ...(missingBase === undefined ? {} : { missingBase }),
  };
}

export function formatResult({ gate, skipped, failed, report, files, missingBase }: CssCheck): string {
  if (failed) {
    return [
      `FAIL ${gate}`,
      ...(missingBase === undefined ? [] : ["", missingBase]),
      ...(report === "" ? [] : ["", report, "", `Fix the stylesheet. A rule this project does not want is turned off in ${CONFIG}.`]),
    ].join("\n");
  }

  // Nothing to judge is reported as such: it is not a pass.
  return skipped === undefined ? `PASS ${gate} — ${files} stylesheet(s) linted` : `SKIP ${gate} — ${skipped}`;
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkCss();

    console.log(formatResult(result));
    process.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error instanceof CouldNotRun ? `lint:css could not run: ${error.message}` : error);
    process.exit(2);
  }
}
