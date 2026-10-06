#!/usr/bin/env node
// The checkable half of writing CHANGELOG.md.
//
//   node tools/agent-workflow/changelog.mts weeks            which weeks have no entry yet
//   node tools/agent-workflow/changelog.mts prs 2026-W40     what was merged in a week
//   node tools/agent-workflow/changelog.mts check 2026-W40   is every merged pull request cited?
//
// `prs` and `check` ask GitHub, through `gh`, which pull requests were merged
// in the week (by merge time, in UTC). They only read. For a run with no
// network, `--merged 12,15,19` gives `check` the numbers instead.
//
// Exit 0: `check` found nothing wrong. Exit 1: it found something, named
// above the FAIL line. Exit 2: nothing was judged (no `gh`, no network, a
// name that is no week, no CHANGELOG.md). Exit 2 is not a pass.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkWeek, type MergedPullRequest, weeksToWrite } from "./lib/changelog.mts";
import { isMainModule } from "./lib/main.mts";
import { type Run, run } from "./lib/system.mts";
import { isInWeek, parseWeek, type Week, WeekError } from "./lib/week.mts";

/** `gh pr list` returns at most this many. A week that reaches it may be cut short. */
const LIMIT = 500;

export class ChangelogError extends Error {}

export interface ChangelogOptions {
  root: string;
  argv: string[];
  now: Date;
  run: Run;
  report: (line: string) => void;
}

/** Runs one subcommand and returns the exit code. */
export function changelog({ root, argv, now, run: runProgram, report }: ChangelogOptions): number {
  const [command, weekName] = argv;

  try {
    if (command === "weeks") {
      for (const week of weeksToWrite(readChangelog(root), now)) {
        report(describeWeek(week));
      }

      return 0;
    }

    if (command === "prs" && weekName !== undefined) {
      const week = parseWeek(weekName);
      const merged = listMerged(week, root, runProgram);

      report(`${describeWeek(week)}  ${merged.length} merged`);

      for (const { number, title, mergedAt } of merged) {
        report(`${mergedAt.slice(0, 10)}\t#${number}\t${title}`);
      }

      return 0;
    }

    if (command === "check" && weekName !== undefined) {
      const week = parseWeek(weekName);
      const given = argv.indexOf("--merged");
      const merged = given === -1 ? listMerged(week, root, runProgram).map(({ number }) => number) : parseNumbers(argv[given + 1]);
      const problems = checkWeek(readChangelog(root), week.name, merged);

      for (const problem of problems) {
        report(`  ${problem}`);
      }

      report(
        problems.length === 0
          ? `PASS changelog ${week.name}: ${merged.length} merged pull request(s), all cited, every citation defined`
          : `FAIL changelog ${week.name}: ${problems.length} problem(s). Fix CHANGELOG.md and run this again`,
      );

      return problems.length === 0 ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof ChangelogError || error instanceof WeekError) {
      report(`SKIP changelog: ${error.message}. Nothing was judged`);

      return 2;
    }

    throw error;
  }

  report("usage: changelog.mts weeks | prs <week> | check <week> [--merged 12,15]   (a week is written 2026-W40)");

  return 2;
}

/** The pull requests merged inside the week, oldest first. */
export function listMerged(week: Week, root: string, runProgram: Run): MergedPullRequest[] {
  const listed = runProgram(
    "gh",
    ["pr", "list", "--state", "merged", "--search", `merged:${week.start}..${week.end}`, "--limit", String(LIMIT), "--json", "number,title,mergedAt"],
    root,
  );

  if (listed.status !== 0) {
    throw new ChangelogError(`gh could not list the merged pull requests (${listed.stderr.trim() || `exit ${listed.status}`})`);
  }

  const found = JSON.parse(listed.stdout) as MergedPullRequest[];

  if (found.length >= LIMIT) {
    throw new ChangelogError(`gh returned ${found.length} pull requests, its limit, so the list may be cut short`);
  }

  // GitHub's search takes days; the week is exact to the instant.
  return found.filter(({ mergedAt }) => isInWeek(week, mergedAt)).sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

function readChangelog(root: string): string {
  const file = join(root, "CHANGELOG.md");

  if (!existsSync(file)) {
    throw new ChangelogError("there is no CHANGELOG.md at the project root");
  }

  return readFileSync(file, "utf8");
}

function parseNumbers(text: string | undefined): number[] {
  const numbers = (text ?? "").split(",").filter(Boolean).map(Number);

  if (text === undefined || numbers.some((number) => !Number.isInteger(number) || number <= 0)) {
    throw new ChangelogError(`--merged needs pull request numbers separated by commas, got "${text ?? ""}"`);
  }

  return numbers;
}

function describeWeek(week: Week): string {
  return `${week.name}  ${week.start}..${week.end}`;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = changelog({
    root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    argv: process.argv.slice(2),
    now: new Date(),
    run,
    report: (line) => console.log(line),
  });
}
