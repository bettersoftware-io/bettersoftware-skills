#!/usr/bin/env node
// Runs the fixers until nothing changes.
//
//   node tools/format-lint/fix.mts
//
// A project has two tools that rewrite files: Biome (`biome check --write`)
// and ESLint (`eslint --fix`, the kit's rules). Each can undo what makes the
// other content, so neither order settles in one pass:
//
// - Biome rewraps a long line. Two declarations that now span lines stand
//   side by side, and ESLint's `padding-line-between-statements` wants a
//   blank line between them.
// - ESLint's `arrow-body-style` writes `{return x}` on one line, and the
//   kit's `one-import-per-module` joins two imports. Biome lays both out
//   again, which can make the first case.
//
// Measured on one file with all three: Biome, ESLint, Biome to settle one
// way round, ESLint, Biome, ESLint the other, and the same text at the end.
// So this runs them in turn until each has seen the files and left them as
// they are.
//
// ESLint is run when the root `lint` script is a plain `eslint …` call; the
// same arguments are used, with `--fix`. Otherwise Biome runs alone, and this
// says so.
//
// Exit 0: settled, and neither tool has a finding left.
// Exit 1: settled, and findings are left that no fixer repairs. They are
//         printed: fix them in the code.
// Exit 2: a tool could not run.
// Exit 3: not settled. The fixers undo each other on the files named: that
//         is a conflict between the two configs, not something to run again.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How many times each fixer may run. The file in the header needs two; more than a few is a conflict. */
export const MAX_ROUNDS = 5;

const BIOME = "node_modules/.bin/biome";
const ESLINT = "node_modules/.bin/eslint";

/** Folders that hold only installed or generated files. Read only outside a git repository. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "reports", ".git", ".turbo", ".vite", ".cache"]);

/** A fixer could not run, or the project could not be read. Exit 2. */
export class CouldNotRun extends Error {}

export interface Fixer {
  name: string;
  /** The program, from the project root, and its arguments. */
  command: string[];
}

export interface FixerRun {
  status: number;
  /** Everything the fixer printed. */
  output: string;
}

/** Runs one fixer in the project. Replaced by a fake in tests. */
export type RunFixer = (fixer: Fixer) => FixerRun;

export interface FixResult {
  /** The fixers that ran, in order. */
  fixers: string[];
  /** Why ESLint was not one of them, when it was not. */
  withoutEslint?: string;
  /** One entry for each run of a fixer: which, and the files it changed. */
  steps: { fixer: string; changed: string[] }[];
  /** True when every fixer has seen the files and left them as they are. */
  settled: boolean;
  /** Every file that differs from how it was at the start. */
  changed: string[];
  /** When not settled: the files the fixers were still rewriting. */
  stillChanging: string[];
  /** The fixers whose last run still reported findings, each with what it printed. */
  remaining: { fixer: string; output: string }[];
}

/** The fixers of this project, and why ESLint is not among them when it is not. */
export function chooseFixers(root: string): { fixers: Fixer[]; withoutEslint?: string } {
  const biome: Fixer = { name: "biome", command: [BIOME, "check", "--write", "."] };
  const manifest = join(root, "package.json");
  const lint = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts?.lint : undefined;

  if (lint === undefined) {
    return { fixers: [biome], withoutEslint: 'the root package.json has no "lint" script' };
  }

  const [program, ...rest] = lint.trim().split(/\s+/);

  // One program and its arguments. Anything joined to it (`&&`, a pipe) is not a command to add `--fix` to.
  if (program !== "eslint" || rest.some((part) => /[&|;<>$`]/.test(part))) {
    return { fixers: [biome], withoutEslint: `the "lint" script is not a plain eslint call (${lint})` };
  }

  return { fixers: [biome, { name: "eslint", command: [ESLINT, ...rest.filter((part) => part !== "--fix"), "--fix"] }] };
}

export function fix(root: string = process.cwd(), run: RunFixer = runInstalled(resolve(root)), maxRounds: number = MAX_ROUNDS): FixResult {
  const project = resolve(root);
  const { fixers, withoutEslint } = chooseFixers(project);
  const start = takeSnapshot(project);
  const steps: FixResult["steps"] = [];
  const lastRun = new Map<string, FixerRun>();
  // Every state the files have been in. One that comes back is a loop: the fixers will go round it for ever.
  const seen = new Set([digestOf(start)]);
  let now = start;
  let quiet = 0;
  let looped = false;

  while (quiet < fixers.length && steps.length < maxRounds * fixers.length && !looped) {
    const fixer = fixers[steps.length % fixers.length] as Fixer;

    lastRun.set(fixer.name, run(fixer));

    const after = takeSnapshot(project);
    const changed = differing(now, after);

    steps.push({ fixer: fixer.name, changed });
    quiet = changed.length === 0 ? quiet + 1 : 0;
    looped = changed.length > 0 && seen.has(digestOf(after));
    seen.add(digestOf(after));
    now = after;
  }

  const settled = quiet >= fixers.length;

  return {
    fixers: fixers.map(({ name }) => name),
    ...(withoutEslint === undefined ? {} : { withoutEslint }),
    steps,
    settled,
    changed: differing(start, now),
    // What the last run of each fixer rewrote: the files they do not agree on.
    stillChanging: settled ? [] : [...new Set(steps.slice(-fixers.length).flatMap(({ changed }) => changed))].sort(),
    remaining: settled ? fixers.flatMap(({ name }) => (lastRun.get(name)?.status === 0 ? [] : [{ fixer: name, output: lastRun.get(name)?.output.trim() ?? "" }])) : [],
  };
}

export function exitCodeOf({ settled, remaining }: FixResult): number {
  return !settled ? 3 : remaining.length > 0 ? 1 : 0;
}

export function formatResult(result: FixResult): string {
  const { fixers, withoutEslint, steps, settled, changed, stillChanging, remaining } = result;
  const lines = [
    ...(withoutEslint === undefined ? [] : [`fix: biome only: ${withoutEslint}, so eslint --fix was not run.`]),
    ...steps.map(({ fixer, changed: files }, index) => `  ${index + 1}. ${fixer}: ${files.length === 0 ? "changed nothing" : `changed ${files.length} file(s)`}`),
  ];

  if (!settled) {
    return [
      ...lines,
      "",
      `FAIL fix — not settled after ${steps.length} run(s) of ${fixers.join(" and ")}. They are still rewriting:`,
      ...stillChanging.map((file) => `  ${file}`),
      "",
      "Each fixer undoes what the other did there, so running this again changes nothing about that.",
      "It is a conflict between biome.json and the ESLint config. To see it, run one after the other on one of the files:",
      `  ${BIOME} check --write <file> && git diff <file>`,
      `  ${ESLINT} --fix <file> && git diff <file>`,
      "Then change the rule of one tool so that both accept the same text.",
    ].join("\n");
  }

  const summary = `${changed.length === 0 ? "nothing to change" : `${changed.length} file(s) changed`}, settled after ${steps.length} run(s) of ${fixers.join(" and ")}`;

  if (remaining.length === 0) {
    return [...lines, "", `PASS fix — ${summary}.`].join("\n");
  }

  return [
    ...lines,
    "",
    `FAIL fix — ${summary}, and ${remaining.map(({ fixer }) => fixer).join(" and ")} still ${remaining.length === 1 ? "has" : "have"} findings no fixer repairs. Fix them in the code:`,
    ...remaining.flatMap(({ fixer, output }) => ["", `${fixer}:`, ...output.split("\n").map((line) => `  ${line}`)]),
  ].join("\n");
}

/** Runs a fixer from the project's own `node_modules/.bin`, in the project root, without colour. */
function runInstalled(root: string): RunFixer {
  return ({ name, command }) => {
    const [program, ...args] = command as [string, ...string[]];

    if (!existsSync(join(root, program))) {
      throw new CouldNotRun(`${name} is not installed (there is no ${program}). Run \`pnpm install\`.`);
    }

    const ran = spawnSync(join(root, program), args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    if (ran.error !== undefined || ran.status === null) {
      throw new CouldNotRun(`${name} did not run to the end: ${ran.error?.message ?? `stopped by ${ran.signal}`}`);
    }

    // ESLint: 0 clean, 1 findings left. 2 is a config it could not load, and says nothing about the code.
    if (name === "eslint" && ran.status > 1) {
      throw new CouldNotRun(`eslint stopped with exit ${ran.status}: ${firstLine(ran.stderr, ran.stdout)}`);
    }

    return { status: ran.status, output: `${ran.stdout}${ran.stderr}` };
  };
}

function firstLine(...outputs: string[]): string {
  for (const output of outputs) {
    const line = output.split("\n").find((candidate) => candidate.trim() !== "");

    if (line !== undefined) {
      return line.trim();
    }
  }

  return "it printed nothing";
}

/** Path → a hash of the file's content, for every file a fixer could rewrite. */
function takeSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const path of listFiles(root)) {
    try {
      snapshot.set(path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"));
    } catch {
      // A link to nothing, or a file that went away since the listing: no fixer wrote it.
    }
  }

  return snapshot;
}

/**
 * The project's files: what git tracks and what is new, without what it
 * ignores, since neither fixer reads an ignored file. Outside a repository:
 * every file outside the installed and generated folders.
 */
function listFiles(root: string): string[] {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

  return listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : walk(root, "");
}

function walk(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(root, path);
    }

    return entry.isFile() ? [path] : [];
  });
}

/** The files that are in one snapshot and not the other, or differ, in name order. */
function differing(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
}

function digestOf(snapshot: Map<string, string>): string {
  const hash = createHash("sha256");

  for (const path of [...snapshot.keys()].sort()) {
    hash.update(`${path}\0${snapshot.get(path)}\0`);
  }

  return hash.digest("hex");
}

/**
 * True when the module at `moduleUrl` is the script Node was asked to run.
 * Compares real paths: reached through a symlink, a naive comparison is false
 * and the script would exit 0 having done nothing.
 */
function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) {
  try {
    const result = fix();

    console.log(formatResult(result));
    process.exit(exitCodeOf(result));
  } catch (error) {
    console.error(error instanceof CouldNotRun ? `fix could not run: ${error.message}` : error);
    process.exit(2);
  }
}
