// Reads CHANGELOG.md and judges one week's entry against the pull requests
// that were merged in that week.
//
// What a week's entry says is a matter of judgement. These three things are
// not, so they are checked:
//
//   1. every pull request merged in the week is cited in the week's section;
//   2. every citation in the file has a link definition, to that number;
//   3. the definitions are in ascending order.

import { lastFinishedWeek, parseWeek, startOf, type Week, weekAfter, weekOf } from "./week.mts";

const HEADING = /^## (\d{4}-W\d{2})\b.*$/gm;
/** `[#12]`, but not the `[#12]:` that starts a definition. */
const CITATION = /\[#(\d+)\](?!:)/g;
const DEFINITION = /^\[#(\d+)\]:[ \t]*(\S+)[ \t]*$/gm;

export interface MergedPullRequest {
  number: number;
  title: string;
  /** ISO timestamp, UTC. */
  mergedAt: string;
}

/** The names of the weeks that have a heading, in the order they appear. */
export function weeksIn(text: string): string[] {
  return [...text.matchAll(HEADING)].map((match) => match[1] as string);
}

/** The text of one week's section: from its heading to the next `## ` heading, or to the end of the file. */
export function sectionOf(text: string, week: string): string | undefined {
  const heading = [...text.matchAll(HEADING)].find((match) => match[1] === week);

  if (heading === undefined) {
    return undefined;
  }

  const body = text.slice(heading.index + heading[0].length);
  const end = body.search(/^## /m);

  return end === -1 ? body : body.slice(0, end);
}

export function citationsIn(text: string): number[] {
  return [...new Set([...text.matchAll(CITATION)].map((match) => Number(match[1])))];
}

/** Every link definition, in file order. */
export function definitionsIn(text: string): { number: number; url: string }[] {
  return [...text.matchAll(DEFINITION)].map((match) => ({ number: Number(match[1]), url: match[2] as string }));
}

/** What is wrong with the week's entry, one line each. Empty when nothing is. */
export function checkWeek(text: string, week: string, merged: number[]): string[] {
  const problems: string[] = [];
  const section = sectionOf(text, week);

  if (section === undefined) {
    if (merged.length > 0) {
      problems.push(`there is no "## ${week}" heading, and ${merged.length} pull request(s) were merged that week: ${list(merged)}`);
    }
  } else {
    const cited = citationsIn(section);
    const missing = merged.filter((number) => !cited.includes(number));

    if (missing.length > 0) {
      problems.push(`merged in ${week} and not cited in its section: ${list(missing)}`);
    }
  }

  const definitions = definitionsIn(text);
  const undefinedCitations = citationsIn(text).filter((number) => !definitions.some((definition) => definition.number === number));

  if (undefinedCitations.length > 0) {
    problems.push(`cited with no link definition at the bottom of the file: ${list(undefinedCitations)}`);
  }

  for (const { number, url } of definitions) {
    if (!new RegExp(`/(?:pull|issues)/${number}$`).test(url)) {
      problems.push(`the definition of [#${number}] points at ${url}, which is not pull request ${number}`);
    }
  }

  const outOfOrder = definitions.find((definition, index) => index > 0 && definition.number <= (definitions[index - 1]?.number ?? 0));

  if (outOfOrder !== undefined) {
    problems.push(`the link definitions are not in ascending order: [#${outOfOrder.number}] comes after a higher or equal number`);
  }

  return problems;
}

/**
 * The weeks to write: every week after the newest one in the file, up to and
 * including the week `now` is in. When the newest week in the file is the
 * current one, that week alone: its entry is partial and is extended in
 * place. With no week in the file, the last finished week and the current one.
 */
export function weeksToWrite(text: string, now: Date): Week[] {
  const newest = weeksIn(text).map(parseWeek).sort((a, b) => startOf(b) - startOf(a))[0];
  const current = weekOf(now);

  if (newest === undefined) {
    return [lastFinishedWeek(now), current];
  }

  if (newest.name === current.name) {
    return [current];
  }

  const weeks: Week[] = [];

  for (let week = weekAfter(newest); startOf(week) <= startOf(current); week = weekAfter(week)) {
    weeks.push(week);
  }

  return weeks;
}

function list(numbers: number[]): string {
  return [...numbers].sort((a, b) => a - b).map((number) => `#${number}`).join(", ");
}
