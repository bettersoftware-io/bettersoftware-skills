// Says what an update leaves for the project to change itself.
//
// Some files in a project are written once from a template and then belong to
// the project: its hook settings, its `AGENTS.md`, its architecture config, an
// add-on's starting files. An update never overwrites them. When the template
// of one changes, the project's file is silently out of date: a new stop hook
// once wanted a longer timeout in `.claude/settings.json`, and the update that
// brought the hook said nothing.
//
// The mechanism adds nothing to the installer's record. Each template is kept
// in the project as an ordinary installed file, one the unit owns and an
// update replaces. So the hash record already says when a template changed,
// and the copy about to be replaced is the old text to compare with.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A file the project owns, and the installed copy of the template it was written from. */
export interface Template {
  /** The project's file, e.g. `.claude/settings.json`. */
  owned: string;
  /** The unit's copy of the template in the project, e.g. `tools/arch/hooks/claude.settings.json`. */
  template: string;
}

export interface OwnedChange extends Template {
  /**
   * `untouched`: the project's file is still the old template, word for word,
   * so the new one can simply be taken. `edited`: it has changes of its own,
   * so the change is made by hand. `absent`: the project has no such file.
   *
   * The last two are for a template the project had no copy of before this
   * update, so there is no older text to compare with. `unknown`: the
   * project's file differs from the template, and nothing says which side
   * changed. `never-seen`: the project has no such file, and nothing says
   * whether it deleted one or was never given one.
   */
  state: "untouched" | "edited" | "absent" | "unknown" | "never-seen";
  /**
   * The lines that differ: `- ` for one that went, `+ ` for one that came.
   * Between the old template and the new one; for `unknown`, between the
   * template (`-`) and the project's file (`+`); none for `never-seen`.
   */
  lines: string[];
}

/** The text of each template as it is in the project now. Read before an update replaces them. */
export function readTemplates(project: string, templates: Template[]): Map<string, string> {
  const texts = new Map<string, string>();

  for (const { template } of templates) {
    if (existsSync(join(project, template))) {
      texts.set(template, readFileSync(join(project, template), "utf8"));
    }
  }

  return texts;
}

/**
 * What the update that has just run leaves to the project. A template counts
 * only when the update wrote it: one that did not change needs nothing.
 *
 * A template that is new to the project has no earlier version to differ
 * from. That is every template, for a project from before templates were
 * kept, and such a project was once told nothing at all. So the project's
 * file is compared with the template itself: equal needs nothing, and a
 * difference is shown as one, without a guess about which side moved.
 */
export function findOwnedChanges(project: string, templates: Template[], before: Map<string, string>, written: string[]): OwnedChange[] {
  const changes: OwnedChange[] = [];

  for (const { owned, template } of templates) {
    const old = before.get(template);

    if (!written.includes(template)) {
      continue;
    }

    if (old === undefined) {
      const now = readFileSync(join(project, template), "utf8");
      const yours = existsSync(join(project, owned)) ? readFileSync(join(project, owned), "utf8") : undefined;

      if (yours === undefined) {
        changes.push({ owned, template, state: "never-seen", lines: [] });
      } else if (withoutAddonSections(yours) !== now) {
        changes.push({ owned, template, state: "unknown", lines: changedLines(now, withoutAddonSections(yours)) });
      }

      continue;
    }

    const file = join(project, owned);
    const state = !existsSync(file) ? "absent" : readFileSync(file, "utf8") === old ? "untouched" : "edited";

    changes.push({ owned, template, state, lines: changedLines(old, readFileSync(join(project, template), "utf8")) });
  }

  return changes;
}

/**
 * A text without the sections the installer itself appends to `AGENTS.md`,
 * one for each add-on. They are in no template, and are not a difference the
 * project made.
 */
export function withoutAddonSections(text: string): string {
  const without = text.replace(/\n*<!-- add-on: ([\w-]+) -->[\s\S]*?<!-- \/add-on: \1 -->\n?/g, "\n");

  // The sections stand at the end, each after a blank line: what is left ends as a file does.
  return without === text ? text : without.replace(/\n+$/, "\n");
}

/** The lines that differ between two texts, in order, by their longest common run of lines. */
export function changedLines(before: string, after: string): string[] {
  const old = before.split("\n");
  const now = after.split("\n");
  // common[i][j]: how many lines old[i..] and now[j..] share, in order.
  const common = Array.from({ length: old.length + 1 }, () => new Array<number>(now.length + 1).fill(0));

  for (let i = old.length - 1; i >= 0; i -= 1) {
    for (let j = now.length - 1; j >= 0; j -= 1) {
      common[i][j] = old[i] === now[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;

  while (i < old.length || j < now.length) {
    if (i < old.length && j < now.length && old[i] === now[j]) {
      i += 1;
      j += 1;
    } else if (j >= now.length || (i < old.length && common[i + 1][j] >= common[i][j + 1])) {
      lines.push(`- ${old[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${now[j]}`);
      j += 1;
    }
  }

  return lines;
}

/** How many lines of a difference are printed. A file that shares little with its template would fill the screen. */
export const SHOWN_LINES = 30;

/** The lines of a difference as they are printed: the first of them, and how to see the rest. */
export function showLines(lines: string[], template: string, owned: string): string[] {
  return lines.length <= SHOWN_LINES
    ? lines.map((line) => `      ${line}`)
    : [...lines.slice(0, SHOWN_LINES).map((line) => `      ${line}`), `      … and ${lines.length - SHOWN_LINES} more line(s): diff ${template} ${owned}`];
}

/** What to print for one file, as lines. */
export function describeOwnedChange({ owned, template, state, lines }: OwnedChange): string[] {
  if (state === "never-seen") {
    return [
      `${owned}: this project has none, and no earlier copy of its template was kept, so it cannot be told whether the file was deleted here or never given. It was not written. If the project should have it:`,
      `    cp ${template} ${owned}`,
    ];
  }

  if (state === "unknown") {
    return [
      `${owned}: differs from its template, and no earlier copy of the template was kept, so it cannot be told which side changed: compare with ${template}`,
      "    A line of the template that yours does not have is `-`; a line only yours has is `+`. Take what is new in the template; leave what is this project's own.",
      ...showLines(lines, template, owned),
    ];
  }

  const what = {
    untouched: [`${owned}: yours is still the old template, word for word. Take the new one:`, `    cp ${template} ${owned}`],
    edited: [
      `${owned}: yours has changes of its own, so it was left as it is. Make this change in it by hand.`,
      `    The whole template is ${template}`,
    ],
    absent: [`${owned}: this project has none. If it should, the template is ${template}`],
  }[state];

  return [...what, "    What changed in the template:", ...showLines(lines, template, owned)];
}
