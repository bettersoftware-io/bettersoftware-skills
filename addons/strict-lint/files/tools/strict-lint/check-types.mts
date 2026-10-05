#!/usr/bin/env node
// Runs the ESLint rules that need type information.
//
//   node tools/strict-lint/check-types.mts
//
// The rules are in `tools/strict-lint/eslint.typed.base.mts` (the add-on's)
// and the config ESLint is given is `tools/strict-lint/eslint.config.mts` (the
// project's). `tools/` and generated folders are not judged.
//
// This wrapper exists for two reasons. ESLint exits 2 both for a broken config
// and for "no files": here a project with no TypeScript file is told so (SKIP).
// And a file that no tsconfig.json includes is reported with what to do about
// it, since that is the one finding ESLint's own message does not explain.
//
// Exit 0: no findings, or nothing to judge (SKIP). Exit 1: findings.
// Exit 2: ESLint could not run.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { isMainModule, listSourceFiles } from "./lib/files.mts";
import { CouldNotRun, firstLine, installedTools, type RunTool } from "./lib/run.mts";

const GATE = "lint:types";

export const CONFIG = "tools/strict-lint/eslint.config.mts";

/** The starter's `lint` script passes the same flag: without it ESLint cannot load a `.mts` config. */
export const ESLINT_ARGUMENTS: string[] = [
  "--flag",
  "unstable_native_nodejs_ts_config",
  "--config",
  CONFIG,
  "--max-warnings",
  "0",
  "--format",
  "json",
  ".",
];

/** What to do about a finding of each rule the add-on sets. A rule the project added has its own message. */
const ADVICE: [rule: string, text: string][] = [
  [
    "@typescript-eslint/no-floating-promises",
    "A promise nothing waits for: await it, return it, or mark it `void` with a comment that says why nothing waits.",
  ],
  [
    "@typescript-eslint/no-misused-promises",
    "A promise where none is expected: do not make the callback `async`; use a `for…of` loop with `await`, or handle the promise where it is made.",
  ],
  ["@typescript-eslint/switch-exhaustiveness-check", "A switch that misses a case: add the case, or a `default` branch if the rest are handled alike."],
  [
    "parse",
    "A file no tsconfig.json includes is not typechecked either: add it to the `include` of the tsconfig.json of its package.",
  ],
];

const NOT_IN_A_PROJECT = /was not found by the project service/;

export interface Finding {
  /** Path from the project root. */
  file: string;
  line: number;
  column: number;
  /** The rule's name, or `parse` for a file ESLint could not read. */
  rule: string;
  message: string;
}

export interface TypesCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  findings: Finding[];
  /** How many files ESLint judged. */
  files: number;
}

interface EslintMessage {
  ruleId: string | null;
  line?: number;
  column?: number;
  message: string;
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

export function checkTypes(root: string = process.cwd(), run: RunTool = installedTools(resolve(root))): TypesCheck {
  const project = resolve(root);

  if (listSourceFiles(project).length === 0) {
    return { gate: GATE, skipped: "no TypeScript file in the project outside tools/", findings: [], files: 0 };
  }

  if (!existsSync(join(project, CONFIG))) {
    throw new CouldNotRun(`${CONFIG} is missing. It is the config this check runs; add the add-on again to get it back.`);
  }

  const { status, stdout, stderr } = run("eslint", ESLINT_ARGUMENTS);

  // ESLint: 0 clean, 1 findings. 2 is a config it could not load or a crash,
  // and says nothing about the code.
  if (status !== 0 && status !== 1) {
    throw new CouldNotRun(`eslint stopped with exit ${status}: ${firstLine(stderr, stdout)}`);
  }

  const results = readResults(stdout);
  const findings = results.flatMap(({ filePath, messages }) =>
    messages.map(
      ({ ruleId, line = 0, column = 0, message }): Finding => ({
        file: relative(project, filePath).split("\\").join("/"),
        line,
        column,
        rule: ruleId ?? "parse",
        message: NOT_IN_A_PROJECT.test(message) ? "no tsconfig.json includes this file" : message.trim(),
      }),
    ),
  );

  if (status === 1 && findings.length === 0) {
    throw new CouldNotRun(`eslint failed and named no finding: ${firstLine(stderr, stdout)}`);
  }

  // ESLint was given files and judged none: every one is ignored by the config.
  if (results.length === 0) {
    return { gate: GATE, skipped: "ESLint judged no file: the config ignores every TypeScript file", findings: [], files: 0 };
  }

  return { gate: GATE, findings, files: results.length };
}

export function formatResult({ gate, skipped, findings, files }: TypesCheck): string {
  // Nothing to judge is reported as such: it is not a pass.
  if (skipped !== undefined) {
    return `SKIP ${gate} — ${skipped}`;
  }

  if (findings.length === 0) {
    return `PASS ${gate} — ${files} file(s) linted with type information`;
  }

  const rules = new Set(findings.map(({ rule }) => rule));
  const advice = ADVICE.filter(([rule]) => rules.has(rule)).map(([, text]) => text);

  return [
    `FAIL ${gate} — ${findings.length} finding(s)`,
    "",
    ...findings.map(({ file, line, column, rule, message }) => `${file}:${line}:${column}  ${rule}  ${message}`),
    ...(advice.length > 0 ? ["", ...advice] : []),
  ].join("\n");
}

function readResults(stdout: string): EslintResult[] {
  try {
    const parsed: unknown = JSON.parse(stdout);

    if (Array.isArray(parsed)) {
      return parsed as EslintResult[];
    }
  } catch {
    // Reported below.
  }

  throw new CouldNotRun(`eslint did not print its JSON report: ${firstLine(stdout)}`);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkTypes();

    console.log(formatResult(result));
    process.exit(result.findings.length > 0 ? 1 : 0);
  } catch (error) {
    console.error(error instanceof CouldNotRun ? `lint:types could not run: ${error.message}` : error);
    process.exit(2);
  }
}
