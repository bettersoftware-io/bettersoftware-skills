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

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { dropIgnored, isMainModule, listFiles } from "./lib/files.mts";
import { CouldNotRun, firstLine, installedTools, type RunTool } from "./lib/run.mts";

const GATE = "css";

export const CONFIG = "tools/repo-hygiene/stylelint.json";

/** How many paths one stylelint run is given, to stay under the limit on a command line's length. */
const BATCH = 200;

export interface CssCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  failed: boolean;
  /** stylelint's own report: the file, the line, the rule. */
  report: string;
  files: number;
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

  return { gate: GATE, failed: reports.length > 0, report: reports.join("\n\n"), files: files.length };
}

export function formatResult({ gate, skipped, failed, report, files }: CssCheck): string {
  if (failed) {
    return [
      `FAIL ${gate}`,
      "",
      report,
      "",
      `Fix the stylesheet. A rule this project does not want is turned off in ${CONFIG}.`,
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
