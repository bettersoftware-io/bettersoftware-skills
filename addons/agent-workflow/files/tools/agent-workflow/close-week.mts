#!/usr/bin/env node
// Closes the ISO week that has just ended. Run by the `Weekly tag` workflow.
//
//   1. Tags the last commit that reached the default branch before Monday
//      00:00 UTC as `<year>-W<week>`, so that `git diff 2026-W39 2026-W40` is
//      exactly what the changelog's W40 section describes.
//   2. Opens an issue that asks for that week's changelog entry, when any
//      pull request was merged in the week.
//
// Writing the entry needs judgement, so it is not done here.
//
// The tag is the mark that a week is closed: a run that finds it does
// nothing. Running this twice, or by hand, is therefore safe.
//
// It needs `gh` with a token that may write contents and issues, the
// repository's name in GITHUB_REPOSITORY, and the full first-parent history
// of the default branch checked out.
//
// Exit 0: the week is closed (now, or already). Exit 1: GitHub refused a
// step, and the line above says which. Exit 2: it could not start.

import { isMainModule } from "./lib/main.mts";
import { type Run, run } from "./lib/system.mts";
import { endOf, lastFinishedWeek } from "./lib/week.mts";

const LIMIT = 500;

export interface CloseWeekOptions {
  /** A checkout of the default branch, with history. */
  root: string;
  /** `owner/name`. */
  repository: string | undefined;
  now: Date;
  run: Run;
  report: (line: string) => void;
}

export function closeWeek({ root, repository, now, run: runProgram, report }: CloseWeekOptions): number {
  if (repository === undefined || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    report("SKIP close-week: GITHUB_REPOSITORY is not set to owner/name. Nothing was done");

    return 2;
  }

  const week = lastFinishedWeek(now);
  const gh = (...args: string[]) => runProgram("gh", args, root);

  report(`Closing ${week.name} (${week.start} .. ${week.end}, UTC)`);

  const existing = gh("api", `repos/${repository}/git/ref/tags/${week.name}`, "--silent");

  if (existing.status === 0) {
    report(`The tag ${week.name} exists: this week is already closed.`);

    return 0;
  }

  // Only "there is no such tag" means the week is open. Any other failure
  // (no token, no network) is not an answer.
  if (!/404|Not Found/i.test(existing.stderr)) {
    report(`FAIL close-week: could not ask GitHub whether ${week.name} exists (${existing.stderr.trim() || `exit ${existing.status}`})`);

    return 1;
  }

  // The last second of the week: `--before` includes the instant it is given.
  const boundary = new Date(endOf(week) - 1000).toISOString();
  const found = runProgram("git", ["rev-list", "-1", "--first-parent", `--before=${boundary}`, "HEAD"], root);

  if (found.status !== 0) {
    report(`FAIL close-week: git could not read the history (${found.stderr.trim()})`);

    return 1;
  }

  const sha = found.stdout.trim();

  if (sha === "") {
    report(`No commit reached the default branch before the end of ${week.name}: there is nothing to tag.`);

    return 0;
  }

  const message = `${week.name} - the default branch at the end of ${week.start} .. ${week.end} (UTC). See CHANGELOG.md.`;
  const tag = gh(
    "api",
    `repos/${repository}/git/tags`,
    ...["-f", `tag=${week.name}`, "-f", `message=${message}`, "-f", `object=${sha}`, "-f", "type=commit", "--jq", ".sha"],
  );

  if (tag.status !== 0 || tag.stdout.trim() === "") {
    report(`FAIL close-week: GitHub did not create the tag object (${tag.stderr.trim() || `exit ${tag.status}`})`);

    return 1;
  }

  const ref = gh("api", `repos/${repository}/git/refs`, "-f", `ref=refs/tags/${week.name}`, "-f", `sha=${tag.stdout.trim()}`, "--silent");

  if (ref.status !== 0) {
    report(`FAIL close-week: GitHub did not create the tag (${ref.stderr.trim() || `exit ${ref.status}`})`);

    return 1;
  }

  report(`Tagged ${sha} as ${week.name}`);

  const listed = gh(
    ...["pr", "list", "--repo", repository, "--state", "merged", "--limit", String(LIMIT)],
    ...["--search", `merged:${week.start}..${week.end}`, "--json", "number"],
  );

  if (listed.status !== 0) {
    report(`FAIL close-week: the week is tagged, but gh could not count its merged pull requests (${listed.stderr.trim()})`);

    return 1;
  }

  const merged = (JSON.parse(listed.stdout) as unknown[]).length;

  if (merged === 0) {
    report(`No pull request was merged in ${week.name}: there is nothing to write up.`);

    return 0;
  }

  const body = [
    `**${merged}${merged >= LIMIT ? " or more" : ""} pull request(s)** were merged in ${week.name} (${week.start} to ${week.end}, UTC), and the week is now tagged \`${week.name}\`.`,
    "",
    "Write its entry in `CHANGELOG.md`:",
    "",
    `- in Claude Code: \`/workflow:changelog ${week.name}\``,
    `- in Codex: \`$workflow-changelog ${week.name}\``,
    `- by hand: follow \`.claude/commands/workflow/changelog.md\`, then \`pnpm changelog check ${week.name}\``,
    "",
    "The pull request that adds the entry closes this issue.",
  ].join("\n");
  const issue = gh("issue", "create", "--repo", repository, "--title", `Changelog: write ${week.name}`, "--body", body);

  if (issue.status !== 0) {
    report(`FAIL close-week: the week is tagged, but the issue was not opened (${issue.stderr.trim() || `exit ${issue.status}`})`);

    return 1;
  }

  report(`Opened "Changelog: write ${week.name}" ${issue.stdout.trim()}`);

  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = closeWeek({
    root: process.cwd(),
    repository: process.env.GITHUB_REPOSITORY,
    now: new Date(),
    run,
    report: (line) => console.log(line),
  });
}
