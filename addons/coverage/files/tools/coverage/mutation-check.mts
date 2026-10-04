#!/usr/bin/env node
// Proves that tests can fail.
//
// A passing test says nothing about whether it could ever fail. A mutant does:
// change the code to be wrong in one specific way and see the test go red.
// This applies each mutant in a spec, runs that mutant's test, and puts the
// file back whatever happens.
//
//   node tools/coverage/mutation-check.mts <spec.json> [--timeout <seconds>]
//
// The spec is a JSON array. Paths and commands are read from the folder this
// is run in (the project root):
//
//   [
//     {
//       "name": "a price above the previous one moved up, not down",
//       "file": "packages/domain/src/useCases/trackMovement.ts",
//       "find": "mid > before",
//       "replace": "mid < before",
//       "test": "pnpm --filter @app/domain exec vitest run trackMovement"
//     }
//   ]
//
// `find` is literal text and must occur exactly once in the file. Each row of
// the table is one of:
//
//   KILLED    the test went red with the mutant in place — it can fail
//   SURVIVED  the test stayed green — it cannot see this mistake. That is a
//             finding about the test: strengthen it, or write down why this
//             behaviour is left unchecked
//   ERROR     the mutant could not be judged, and the reason is given
//
// Exit 0: every mutant was killed. Exit 1: one survived. Exit 2: the spec
// could not be read, or a mutant could not be judged.
//
// A spec is code, not data: its `test` commands run in a shell. Do not run a
// spec you have not read.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { isMainModule } from "./lib/main.mts";

export interface Mutant {
  name: string;
  file: string;
  find: string;
  replace: string;
  test: string;
}

export type MutantStatus = "KILLED" | "SURVIVED" | "ERROR";

export interface MutantResult {
  name: string;
  status: MutantStatus;
  /** Why, for a row that is not KILLED. */
  detail: string;
}

export type TestRun = "green" | "red" | "timed out";

/** Runs a mutant's test command in the project root. Replaced in tests. */
export type RunTest = (command: string) => TestRun;

export interface MutantOptions {
  root: string;
  runTest: RunTest;
  /** Called before each mutant runs. */
  announce?: (mutant: Mutant) => void;
  /** Asked before each mutant; the run stops when it answers true. */
  isStopped?: () => boolean;
}

export class MutationError extends Error {}

export function readSpec(path: string): Mutant[] {
  if (!existsSync(path)) {
    throw new MutationError(`${path} does not exist`);
  }

  const spec: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (!Array.isArray(spec) || spec.length === 0) {
    throw new MutationError(`${path}: expected a JSON array with at least one mutant`);
  }

  for (const [index, mutant] of (spec as Record<string, unknown>[]).entries()) {
    for (const field of ["name", "file", "find", "replace", "test"]) {
      if (typeof mutant?.[field] !== "string") {
        throw new MutationError(`${path}: mutant ${index + 1} needs a "${field}" that is text`);
      }
    }

    if (mutant.find === mutant.replace) {
      throw new MutationError(`${path}: mutant ${index + 1} ("${String(mutant.name)}") changes nothing`);
    }
  }

  return spec as Mutant[];
}

export async function runMutants(spec: Mutant[], { root, runTest, announce, isStopped }: MutantOptions): Promise<MutantResult[]> {
  const results: MutantResult[] = [];
  // Each test command is run once without any mutant, however many mutants use it.
  const baselines = new Map<string, TestRun>();

  for (const mutant of spec) {
    // The run is synchronous, so a Ctrl-C is only seen here, between mutants,
    // after the file has been put back.
    await new Promise((seen) => setImmediate(seen));

    if (isStopped?.()) {
      break;
    }

    announce?.(mutant);
    results.push({ name: mutant.name, ...runMutant(mutant, root, runTest, baselines) });
  }

  return results;
}

/** Applies one mutant, runs its test, and restores the file whatever happens. */
function runMutant(mutant: Mutant, root: string, runTest: RunTest, baselines: Map<string, TestRun>): Omit<MutantResult, "name"> {
  const path = resolve(root, mutant.file);

  if (!existsSync(path)) {
    return { status: "ERROR", detail: `${mutant.file} does not exist` };
  }

  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutant.find).length - 1;

  if (occurrences !== 1) {
    // Which of three occurrences changed is not a question a kill table can answer.
    return { status: "ERROR", detail: `"find" occurs ${occurrences} times in ${mutant.file}; it must occur exactly once` };
  }

  const baseline = baselines.get(mutant.test) ?? runTest(mutant.test);

  baselines.set(mutant.test, baseline);

  if (baseline !== "green") {
    // A test that is red anyway would "kill" every mutant.
    return {
      status: "ERROR",
      detail: `the test ${baseline === "red" ? "is red" : "timed out"} before the mutant is applied, so a red run would prove nothing`,
    };
  }

  try {
    // A function, so `$&` and `$1` in the replacement are written as they are.
    writeFileSync(path, original.replace(mutant.find, () => mutant.replace));

    const run = runTest(mutant.test);

    if (run === "red") {
      return { status: "KILLED", detail: "" };
    }

    return run === "green"
      ? { status: "SURVIVED", detail: "the test passes with the mutant applied" }
      : { status: "ERROR", detail: "the test timed out with the mutant applied; that is not a red test" };
  } finally {
    writeFileSync(path, original);
  }
}

export function formatTable(results: MutantResult[], total: number): string {
  const killed = results.filter((result) => result.status === "KILLED").length;
  const lines = ["mutants", ...results.map(({ status, name, detail }) => `  ${status.padEnd(9)}${name}${detail ? `\n           ${detail}` : ""}`)];

  lines.push("", `${killed} of ${total} killed.`);

  if (results.length < total) {
    lines.push(`Stopped after ${results.length}; the rest did not run.`);
  }

  if (results.some((result) => result.status === "SURVIVED")) {
    lines.push("A SURVIVED row is a finding about the test, not about this tool: the test cannot see that mistake.");
  }

  return lines.join("\n");
}

export function exitCodeFor(results: MutantResult[], total: number): 0 | 1 | 2 {
  if (results.some((result) => result.status === "ERROR")) {
    return 2;
  }

  return results.length === total && results.every((result) => result.status === "KILLED") ? 0 : 1;
}

/** Runs `command` in a shell. Output is discarded: only red or green matters. */
export function createShellRunner(root: string, timeoutSeconds: number): RunTest {
  return (command) => {
    try {
      execSync(command, { cwd: root, stdio: "ignore", timeout: timeoutSeconds * 1000 });

      return "green";
    } catch (error) {
      return (error as { code?: string }).code === "ETIMEDOUT" ? "timed out" : "red";
    }
  };
}

interface CommandLine {
  specPath: string;
  timeoutSeconds: number;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { specPath: "", timeoutSeconds: 300 };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--timeout") {
      const seconds = Number(argv[index + 1]);

      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new MutationError('"--timeout" needs a number of seconds above 0');
      }

      options.timeoutSeconds = seconds;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new MutationError(`unknown argument "${argument}"`);
    } else {
      options.specPath = argument;
    }
  }

  if (options.specPath === "") {
    throw new MutationError("usage: node tools/coverage/mutation-check.mts <spec.json> [--timeout <seconds>]");
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  let stoppedBy: "SIGINT" | "SIGTERM" | undefined;

  // Without a handler, a signal ends the process at once and the `finally`
  // that restores the file never runs. With one, the signal waits until the
  // mutant in hand has been put back.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stoppedBy = signal;
    });
  }

  try {
    const { specPath, timeoutSeconds } = parseArguments(process.argv.slice(2));
    const spec = readSpec(specPath);
    const root = process.cwd();
    const results = await runMutants(spec, {
      root,
      runTest: createShellRunner(root, timeoutSeconds),
      announce: (mutant) => {
        console.error(`… ${mutant.name}`);
      },
      isStopped: () => stoppedBy !== undefined,
    });

    console.log(`\n${formatTable(results, spec.length)}`);
    process.exit(stoppedBy === undefined ? exitCodeFor(results, spec.length) : stoppedBy === "SIGINT" ? 130 : 143);
  } catch (error) {
    console.error(error instanceof MutationError ? `mutation-check could not run: ${error.message}` : error);
    process.exit(2);
  }
}
