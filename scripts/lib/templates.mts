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
   */
  state: "untouched" | "edited" | "absent";
  /** The lines of the template that changed: `- ` for one that went, `+ ` for one that came. */
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
 * only when the update rewrote it: one that is new to the project has no
 * earlier version to differ from, and one that did not change needs nothing.
 */
export function findOwnedChanges(project: string, templates: Template[], before: Map<string, string>, written: string[]): OwnedChange[] {
  const changes: OwnedChange[] = [];

  for (const { owned, template } of templates) {
    const old = before.get(template);

    if (old === undefined || !written.includes(template)) {
      continue;
    }

    const file = join(project, owned);
    const state = !existsSync(file) ? "absent" : readFileSync(file, "utf8") === old ? "untouched" : "edited";

    changes.push({ owned, template, state, lines: changedLines(old, readFileSync(join(project, template), "utf8")) });
  }

  return changes;
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

/** What to print for one file, as lines. */
export function describeOwnedChange({ owned, template, state, lines }: OwnedChange): string[] {
  const what = {
    untouched: [`${owned}: yours is still the old template, word for word. Take the new one:`, `    cp ${template} ${owned}`],
    edited: [
      `${owned}: yours has changes of its own, so it was left as it is. Make this change in it by hand.`,
      `    The whole template is ${template}`,
    ],
    absent: [`${owned}: this project has none. If it should, the template is ${template}`],
  }[state];

  return [...what, "    What changed in the template:", ...lines.map((line) => `      ${line}`)];
}
