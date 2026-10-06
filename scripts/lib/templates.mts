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

import { projectHas, readProjectText } from "./install.mts";

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
    if (projectHas(project, template)) {
      texts.set(template, readProjectText(project, template));
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
      const now = readProjectText(project, template);
      const yours = projectHas(project, owned) ? readProjectText(project, owned) : undefined;

      if (yours === undefined) {
        changes.push({ owned, template, state: "never-seen", lines: [] });
      } else if (withoutAddonSections(yours) !== now) {
        changes.push({ owned, template, state: "unknown", lines: differenceOf(now, withoutAddonSections(yours)) });
      }

      continue;
    }

    const state = !projectHas(project, owned) ? "absent" : readProjectText(project, owned) === old ? "untouched" : "edited";

    changes.push({ owned, template, state, lines: changedLines(old, readProjectText(project, template)).map(showSafely) });
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

/** A file larger than this is not compared line by line, and not printed. */
export const LARGEST_SHOWN_BYTES = 512 * 1024;

/** A line longer than this is cut where it is printed. */
const LONGEST_SHOWN_LINE = 300;

/**
 * The lines that differ between a template and a file of the project, for
 * printing: text only. A file that is not text (it holds a zero byte) or is
 * very large is not shown at all, and every character that would move the
 * cursor, clear the screen or set a title is written out as what it is
 * (`\\x1b`), so a file cannot write to the terminal it is listed on.
 */
export function differenceOf(template: string, yours: Buffer | string): string[] {
  const text = typeof yours === "string" ? yours : yours.toString("utf8");

  if (Buffer.byteLength(text) > LARGEST_SHOWN_BYTES || text.includes("\0")) {
    return ["  (not shown: the project's file is not text, or is larger than 512 KB)"];
  }

  // The comparison's table has a cell for each pair of lines: bounded before it is built, not after.
  if (countLines(template) * countLines(text) > MOST_COMPARED_CELLS) {
    return ["  (not shown: the two files have too many lines to compare here)"];
  }

  return changedLines(template, text).map(showSafely);
}

/** Lines of one text times lines of the other, above which two files are not compared line by line. */
export const MOST_COMPARED_CELLS = 4_000_000;

function countLines(text: string): number {
  let lines = 1;

  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
    lines += 1;
  }

  return lines;
}

// Every C0 and C1 control and the delete character; the two Unicode line
// breaks; and the marks that reorder text on screen (a line could be made to
// read as another).
const UNPRINTABLE = "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069";

function writeOut(character: string): string {
  const code = character.charCodeAt(0);

  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * A whole message as it may be printed: its line breaks and tabs kept, every
 * other control character written out. Everything this script prints goes
 * through it, since a path, a setting or a note may carry text from a file of
 * the project.
 */
export function printable(message: string): string {
  return message.replace(new RegExp(`[${UNPRINTABLE}]`, "g"), writeOut);
}

/** One line as it may be printed: no control character, and not longer than a screen can use. */
export function showSafely(line: string): string {
  // As `printable`, and a line break too: this is one line.
  const plain = printable(line).replace(/\n/g, "\\x0a");

  return plain.length <= LONGEST_SHOWN_LINE ? plain : `${plain.slice(0, LONGEST_SHOWN_LINE)}… (${plain.length - LONGEST_SHOWN_LINE} more characters)`;
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
