#!/usr/bin/env node
// Measures how much the visual tier's screenshots differ when nothing changed.
//
//   pnpm visual:jitter                  capture this commit 3 times here, compare
//   pnpm visual:jitter --runs 5         the same, with 5 captures
//   pnpm visual:jitter <dirA> <dirB>    compare captures made elsewhere, e.g. the
//                                       artifacts of several update-workflow runs
//
// The answer is the noise floor: the tolerance in tolerance.ts has to sit above
// it, and as little above it as you can bear. Run this before changing either
// knob there. A tolerance set by feel is wrong in one of two ways: too tight
// and the tier fails on its own, too loose and it stops seeing real changes.
//
// Exit 0: measured, and the tolerance sits above the noise. 1: it does not.
// 2: nothing could be measured.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOLERANCE } from "../../packages/client-react/tests/visual/tolerance.ts";
import { type JitterRequest, parseArguments, UsageError } from "./lib/arguments.mts";
import { judgeNoise, measureNoise } from "./lib/measure.mts";

const PROJECT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLIENT = join(PROJECT, "packages", "client-react");
const CAPTURES = join(CLIENT, "tests", "visual", "reports", "jitter");

/**
 * Takes every scenario's screenshot `runs` times, each time with a server of
 * its own, into a folder of its own. The committed goldens are not touched.
 * Returns the folders, or undefined if a run failed.
 */
function captureRuns(runs: number): string[] | undefined {
  const playwright = join(CLIENT, "node_modules", ".bin", "playwright");

  if (!existsSync(playwright)) {
    console.error(`No measurement: ${playwright} is not there. Run pnpm install first.`);

    return undefined;
  }

  rmSync(CAPTURES, { recursive: true, force: true });

  const directories: string[] = [];

  for (let run = 1; run <= runs; run += 1) {
    const directory = join(CAPTURES, `run-${run}`);
    const result = spawnSync(
      playwright,
      ["test", "--config", "tests/visual/playwright.config.ts", "--update-snapshots=all", "--reporter=line"],
      { cwd: CLIENT, encoding: "utf8", env: { ...process.env, VISUAL_GOLDENS_DIR: directory } },
    );

    if (result.status !== 0) {
      // The whole output, unfiltered: a cut-down summary can hide the line that matters.
      console.error(`${result.stdout}${result.stderr}`);
      console.error(`No measurement: capture ${run} of ${runs} failed (see above). Fix that first; \`pnpm visual\` shows the same failure.`);

      return undefined;
    }

    console.log(`Capture ${run} of ${runs}: done`);
    directories.push(directory);
  }

  return directories;
}

function runJitter(argv: string[]): number {
  let request: JitterRequest;

  try {
    request = parseArguments(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }

    console.error(`${error.message}\n\nusage: pnpm visual:jitter [--runs N]\n       pnpm visual:jitter <dirA> <dirB> [dirC ...]`);

    return 2;
  }

  const directories = request.mode === "capture" ? captureRuns(request.runs) : request.directories;

  if (directories === undefined) {
    return 2;
  }

  const verdict = judgeNoise(measureNoise(directories, TOLERANCE.threshold), TOLERANCE);

  console.log(`\n${verdict.lines.join("\n")}`);

  return verdict.exitCode;
}

/** True when Node was asked to run this file. Real paths, so a symlinked copy still runs. */
function isMainModule(): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exit(runJitter(process.argv.slice(2)));
}
