import { describe, expect, it } from "vitest";

import { changelog } from "../files/tools/agent-workflow/changelog.mts";
import { checkWeek, citationsIn, definitionsIn, sectionOf, weeksIn, weeksToWrite } from "../files/tools/agent-workflow/lib/changelog.mts";
import type { Run } from "../files/tools/agent-workflow/lib/system.mts";
import { createFolder } from "./support.mts";

const REPO = "https://github.com/acme/app";

describe("reading the file", () => {
  it("finds each week's heading, newest first as written", () => {
    expect(weeksIn(createChangelog())).toEqual(["2026-W40", "2026-W39"]);
  });

  it("takes a week's section up to the next week, and the last one to the end of the file", () => {
    expect(citationsIn(sectionOf(createChangelog(), "2026-W40") ?? "")).toEqual([12, 15]);
    expect(citationsIn(sectionOf(createChangelog(), "2026-W39") ?? "")).toEqual([9]);
    expect(sectionOf(createChangelog(), "2026-W41")).toBeUndefined();
  });

  it("does not take a deeper heading for the end of a week", () => {
    expect(sectionOf(createChangelog(), "2026-W40")).toContain("### Fixed");
  });

  it("tells a citation from the definition that starts with the same text", () => {
    expect(citationsIn("See [#3] and [#3] and [#4].\n\n[#3]: u/pull/3\n[#5]: u/pull/5\n")).toEqual([3, 4]);
    expect(definitionsIn("See [#3].\n\n[#3]: u/pull/3\n[#5]:   u/pull/5  \n")).toEqual([
      { number: 3, url: "u/pull/3" },
      { number: 5, url: "u/pull/5" },
    ]);
  });
});

describe("checking a week", () => {
  it("passes when every merged pull request is cited in the week and every citation is defined", () => {
    expect(checkWeek(createChangelog(), "2026-W40", [12, 15])).toEqual([]);
  });

  it("names a merged pull request the week does not cite", () => {
    expect(checkWeek(createChangelog(), "2026-W40", [12, 15, 17, 16])).toEqual(["merged in 2026-W40 and not cited in its section: #16, #17"]);
  });

  it("does not count a citation in another week's section", () => {
    expect(checkWeek(createChangelog(), "2026-W40", [9])).toEqual(["merged in 2026-W40 and not cited in its section: #9"]);
  });

  it("names a citation with no link definition, wherever it is in the file", () => {
    const text = createChangelog().replace(`[#9]: ${REPO}/pull/9\n`, "");

    expect(checkWeek(text, "2026-W40", [12, 15])).toEqual(["cited with no link definition at the bottom of the file: #9"]);
  });

  it("names a definition that points at another pull request", () => {
    const text = createChangelog().replace(`[#12]: ${REPO}/pull/12`, `[#12]: ${REPO}/pull/120`);

    expect(checkWeek(text, "2026-W40", [12, 15])).toEqual([`the definition of [#12] points at ${REPO}/pull/120, which is not pull request 12`]);
  });

  it("accepts a definition that points at an issue of that number", () => {
    const text = createChangelog().replace(`[#12]: ${REPO}/pull/12`, `[#12]: ${REPO}/issues/12`);

    expect(checkWeek(text, "2026-W40", [12, 15])).toEqual([]);
  });

  it("names definitions that are out of order, and one given twice", () => {
    const swapped = createChangelog().replace(`[#9]: ${REPO}/pull/9\n[#12]: ${REPO}/pull/12\n`, `[#12]: ${REPO}/pull/12\n[#9]: ${REPO}/pull/9\n`);
    const twice = `${createChangelog()}[#15]: ${REPO}/pull/15\n`;

    expect(checkWeek(swapped, "2026-W40", [12, 15])).toEqual(["the link definitions are not in ascending order: [#9] comes after a higher or equal number"]);
    expect(checkWeek(twice, "2026-W40", [12, 15])).toEqual(["the link definitions are not in ascending order: [#15] comes after a higher or equal number"]);
  });

  it("fails a week with merged pull requests and no heading, and passes one with neither", () => {
    expect(checkWeek(createChangelog(), "2026-W41", [20])).toEqual(['there is no "## 2026-W41" heading, and 1 pull request(s) were merged that week: #20']);
    expect(checkWeek(createChangelog(), "2026-W41", [])).toEqual([]);
  });
});

describe("the weeks to write", () => {
  it("are those after the newest one in the file, up to and including the current one", () => {
    expect(weeksToWrite(createChangelog(), new Date("2026-10-21T09:00:00Z")).map(({ name }) => name)).toEqual(["2026-W41", "2026-W42", "2026-W43"]);
  });

  it("is the current week alone when the file already has it: that entry is partial", () => {
    expect(weeksToWrite(createChangelog(), new Date("2026-10-02T09:00:00Z")).map(({ name }) => name)).toEqual(["2026-W40"]);
  });

  it("goes by the newest heading, wherever it is in the file", () => {
    const reordered = "## 2026-W38 — a\n\n## 2026-W40 — b\n";

    expect(weeksToWrite(reordered, new Date("2026-10-06T09:00:00Z")).map(({ name }) => name)).toEqual(["2026-W41"]);
  });

  it("is the last finished week and the current one for a file with no week yet", () => {
    expect(weeksToWrite("# Changelog\n", new Date("2026-10-06T09:00:00Z")).map(({ name }) => name)).toEqual(["2026-W40", "2026-W41"]);
  });
});

describe("the command", () => {
  it("lists the weeks to write, with their first and last day", () => {
    const { lines, status } = runChangelog(["weeks"], { now: "2026-10-06T09:00:00Z" });

    expect(status).toBe(0);
    expect(lines).toEqual(["2026-W41  2026-10-05..2026-10-11"]);
  });

  it("asks gh for the week's merged pull requests, by day, and only reads", () => {
    const { calls } = runChangelog(["prs", "2026-W40"], { merged: [] });

    expect(calls).toEqual([
      ["gh", "pr", "list", "--state", "merged", "--search", "merged:2026-09-28..2026-10-04", "--limit", "500", "--json", "number,title,mergedAt"],
    ]);
  });

  it("lists what was merged in the week, oldest first, and leaves out what the search returned from outside it", () => {
    const { lines, status } = runChangelog(["prs", "2026-W40"], {
      merged: [
        { number: 15, title: "feat: later", mergedAt: "2026-10-04T23:59:59Z" },
        { number: 12, title: "fix: earlier", mergedAt: "2026-09-28T00:00:00Z" },
        { number: 16, title: "feat: next week", mergedAt: "2026-10-05T00:00:00Z" },
        { number: 11, title: "feat: last week", mergedAt: "2026-09-27T23:59:59Z" },
      ],
    });

    expect(status).toBe(0);
    expect(lines).toEqual(["2026-W40  2026-09-28..2026-10-04  2 merged", "2026-09-28\t#12\tfix: earlier", "2026-10-04\t#15\tfeat: later"]);
  });

  it("passes a week whose merged pull requests are all cited", () => {
    const { lines, status } = runChangelog(["check", "2026-W40"], { merged: [createMerged(12), createMerged(15)] });

    expect(status).toBe(0);
    expect(lines).toEqual(["PASS changelog 2026-W40: 2 merged pull request(s), all cited, every citation defined"]);
  });

  it("fails a week with a merged pull request it does not cite, and names it", () => {
    const { lines, status } = runChangelog(["check", "2026-W40"], { merged: [createMerged(12), createMerged(15), createMerged(18)] });

    expect(status).toBe(1);
    expect(lines[0]).toBe("  merged in 2026-W40 and not cited in its section: #18");
    expect(lines.at(-1)).toMatch(/^FAIL changelog 2026-W40: 1 problem/);
  });

  it("takes the numbers from --merged without asking gh", () => {
    const passing = runChangelog(["check", "2026-W40", "--merged", "12,15"], { gh: "absent" });
    const failing = runChangelog(["check", "2026-W40", "--merged", "12,15,19"], { gh: "absent" });
    const none = runChangelog(["check", "2026-W41", "--merged", ""], { gh: "absent" });

    expect([passing.status, failing.status, none.status]).toEqual([0, 1, 0]);
    expect(passing.calls).toEqual([]);
  });

  it.each([
    ["gh is not installed", ["check", "2026-W40"], { gh: "absent" as const }, /gh could not list the merged pull requests/],
    ["gh returned as many as it will", ["check", "2026-W40"], { merged: Array.from({ length: 500 }, (_, index) => createMerged(index + 1)) }, /may be cut short/],
    ["the name is no week", ["check", "2026-W54"], {}, /is not an ISO week/],
    ["--merged holds something else", ["check", "2026-W40", "--merged", "12,abc"], {}, /--merged needs pull request numbers/],
    ["there is no CHANGELOG.md", ["check", "2026-W40", "--merged", "12"], { file: null }, /no CHANGELOG\.md/],
  ])("judges nothing, and says so, when %s", (_name, argv, world, message) => {
    const { lines, status } = runChangelog(argv, world);

    expect(status).toBe(2);
    expect(lines.at(-1)).toMatch(message);
    expect(lines.at(-1)).toMatch(/^SKIP changelog: .*Nothing was judged$/);
  });

  it("prints how it is used, and does not pass, for anything else", () => {
    expect(runChangelog([]).status).toBe(2);
    expect(runChangelog(["check"]).status).toBe(2);
    expect(runChangelog(["publish", "2026-W40"]).lines[0]).toMatch(/^usage: /);
  });
});

interface World {
  now?: string;
  merged?: { number: number; title: string; mergedAt: string }[];
  gh?: "absent";
  /** The file's text; null for a project with no CHANGELOG.md. */
  file?: string | null;
}

function runChangelog(argv: string[], world: World = {}): { status: number; lines: string[]; calls: string[][] } {
  const file = world.file === undefined ? createChangelog() : world.file;
  const root = createFolder(file === null ? {} : { "CHANGELOG.md": file });
  const lines: string[] = [];
  const calls: string[][] = [];
  const run: Run = (program, args) => {
    calls.push([program, ...args]);

    return world.gh === "absent"
      ? { status: 127, stdout: "", stderr: "spawnSync gh ENOENT" }
      : { status: 0, stdout: JSON.stringify(world.merged ?? []), stderr: "" };
  };
  const status = changelog({ root, argv, now: new Date(world.now ?? "2026-10-06T09:00:00Z"), run, report: (line) => lines.push(line) });

  return { status, lines, calls };
}

function createMerged(number: number): { number: number; title: string; mergedAt: string } {
  return { number, title: `change ${number}`, mergedAt: "2026-09-30T12:00:00Z" };
}

function createChangelog(): string {
  return [
    "# Changelog",
    "",
    "Every merged pull request is cited as `[#12]`-style links.",
    "",
    "## 2026-W40 — 28 Sep – 4 Oct",
    "",
    "A week about prices.",
    "",
    "### Added",
    "",
    "- **Stale prices** are greyed out. [#12]",
    "",
    "### Fixed",
    "",
    "- **The total** no longer double-counts. [#15], after [#12]",
    "",
    "## 2026-W39 — 21 Sep – 27 Sep",
    "",
    "### Added",
    "",
    "- **The price list.** [#9]",
    "",
    `[#9]: ${REPO}/pull/9`,
    `[#12]: ${REPO}/pull/12`,
    `[#15]: ${REPO}/pull/15`,
    "",
  ].join("\n");
}
