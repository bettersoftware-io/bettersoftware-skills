#!/usr/bin/env node
// The coverage gate: every file of every workspace package must meet the bar,
// measured with that package's own tests. The bar and what is measured are in
// `lib/config.mts`; a project adds its own in `tools/coverage.config.mts`.
//
//   node tools/coverage/run.mts                    every workspace package
//   node tools/coverage/run.mts packages/domain    only the packages given
//   node tools/coverage/run.mts --json             machine-readable verdicts
//   node tools/coverage/run.mts --root <dir>       judge another project
//
// It also writes the merged HTML report to `coverage/report/`, and a Markdown
// summary to `$GITHUB_STEP_SUMMARY` when CI sets it.
//
// Exit 0: every measured file meets the bar. Exit 1: a test failed or a file
// is under the bar. Exit 2: the gate could not run, or measured nothing.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import type { CoverageConfig } from "./lib/config.mts";
import { CoverageError, loadConfig, PROJECT_CONFIG } from "./lib/config.mts";
import type { PackageResult } from "./lib/judge.mts";
import { exitCodeFor, judgePackage, skipPackage } from "./lib/judge.mts";
import { hasPortTests, portTestsAreSkipped } from "./lib/listening.mts";
import { isMainModule } from "./lib/main.mts";
import type { RunVitest } from "./lib/measure.mts";
import { findMisplacedExclusions, measurePackage } from "./lib/measure.mts";
import type { Build } from "./lib/report.mts";
import { formatMarkdown, formatResults } from "./lib/report.mts";
import { buildReport } from "./lib/site.mts";
import { listPackages } from "./lib/workspace.mts";

export interface CheckOptions {
  root: string;
  config: CoverageConfig;
  /** Only these package folders. Default: every workspace package. */
  packages?: string[];
  /** Hide vitest's own output. */
  quiet?: boolean;
  /** Called before each package is measured. */
  announce?: (directory: string) => void;
  /** Runs vitest. Replaced in tests. */
  run?: RunVitest;
  /** True where no port can be opened, so the packages leave their port tests out. */
  portTestsSkipped?: boolean;
}

/** Measures and judges each package, one after the other. */
export function checkCoverage({
  root,
  config,
  packages,
  quiet = false,
  announce,
  run,
  portTestsSkipped = false,
}: CheckOptions): PackageResult[] {
  const inWorkspace = listPackages(root);
  const unknown = (packages ?? []).filter((directory) => !inWorkspace.includes(directory));

  if (unknown.length > 0) {
    throw new CoverageError(`not a workspace package: ${unknown.join(", ")} — the packages are ${inWorkspace.join(", ")}`);
  }

  const misplaced = findMisplacedExclusions(inWorkspace, Object.keys(config.exclude));

  if (misplaced.length > 0) {
    throw new CoverageError(
      `${PROJECT_CONFIG} excludes "${misplaced[0]}", which is in no workspace package — write it from the project root (${inWorkspace[0]}/src/…), or start it with **/ to apply it in every package`,
    );
  }

  return (packages?.length ? packages : inWorkspace).map((directory) => {
    announce?.(directory);

    // Measured without the tests that need a port, the package would read
    // lower than it is. Not judging it is not passing it: the verdict is SKIP.
    if (portTestsSkipped && hasPortTests(root, directory)) {
      return skipPackage(
        directory,
        "its tests that need a port cannot run here, so its numbers would be wrong; it is measured where a port can be opened, and always in CI",
      );
    }

    return judgePackage(measurePackage(root, directory, config, quiet, run), config.thresholds);
  });
}

/** The commit the report is built from, so a reader can tell how old it is. */
export function readBuild(root: string, environment: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Build {
  const commit = git(root, ["rev-parse", "HEAD"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const { GITHUB_REF_NAME, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = environment;

  return {
    commit,
    dirty: commit !== undefined && git(root, ["status", "--porcelain"]) !== "",
    ref: GITHUB_REF_NAME || (branch === "HEAD" ? undefined : branch),
    builtAt: now,
    runUrl:
      GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
        ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
        : undefined,
  };
}

/** A git command's output, or `undefined` when it fails (no git, no commit yet). */
function git(root: string, gitArguments: string[]): string | undefined {
  const { status, stdout } = spawnSync("git", gitArguments, { cwd: root, encoding: "utf8" });

  return status === 0 ? stdout.trim() : undefined;
}

interface CommandLine {
  root: string;
  packages: string[];
  json: boolean;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { root: process.cwd(), packages: [], json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--root") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new CoverageError('"--root" needs a value');
      }

      options.root = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new CoverageError(`unknown argument "${argument}"`);
    } else {
      options.packages.push(argument.replace(/\/$/, ""));
    }
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const { root, packages, json } = parseArguments(process.argv.slice(2));
    const config = await loadConfig(root);
    const results = checkCoverage({
      root,
      config,
      packages,
      portTestsSkipped: await portTestsAreSkipped(),
      quiet: json,
      announce: (directory) => {
        console.error(`\n── coverage: ${directory}`);
      },
    });
    const build = readBuild(root);
    const report = buildReport({ root, results, config, build });

    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatMarkdown(results, config.thresholds, build));
    }

    console.log(json ? JSON.stringify(results, null, 2) : `\n${formatResults(results, config.thresholds)}\n\nReport: ${report}`);
    process.exit(exitCodeFor(results));
  } catch (error) {
    console.error(error instanceof CoverageError ? `coverage could not run: ${error.message}` : error);
    process.exit(2);
  }
}
