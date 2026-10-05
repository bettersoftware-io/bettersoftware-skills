// What a markdown file links to, and which anchors it offers.
//
// It reads the text by a few rules. It is not a markdown parser, and the
// README lists what that leaves out.

import { createSlugger } from "./slug.mts";

export interface Link {
  /** 1-based. */
  line: number;
  /** As written: `../docs/setup.md#install`. */
  target: string;
}

/** `[text](target)`, `[text](<target>)`, with or without a title. One level of brackets inside the target. */
const INLINE_LINK = /\]\(\s*(?:<([^>]*)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** `[label]: target`. A footnote (`[^1]: …`) is not a link. */
const LINK_DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/;

/** `href="…"` and `src="…"` in HTML written in the markdown. */
const HTML_LINK = /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** `<a name="x">` and any `id="x"`: an anchor the author placed by hand. */
const HTML_ANCHOR = /<[a-z][^>]*?\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * The lines of a document with every fenced code block emptied. Line numbers
 * are kept. What a fence shows is an example, not the document's own text.
 */
export function proseLines(text: string): string[] {
  let fence: { mark: string; length: number } | undefined;

  return text.split(/\r?\n/).map((line) => {
    if (fence === undefined) {
      // Backticks later on the line make it a code span, not a fence.
      const opening = /^\s*(?:(`{3,})[^`]*$|(~{3,}))/.exec(line);

      if (opening === null) {
        return line;
      }

      const marks = (opening[1] ?? opening[2]) as string;

      fence = { mark: marks[0] as string, length: marks.length };

      return "";
    }

    const closing = line.trim();

    if (closing.length >= fence.length && closing === fence.mark.repeat(closing.length)) {
      fence = undefined;
    }

    return "";
  });
}

/** The line without its code spans: `` `[x](y)` `` shows link syntax, it is not a link. */
export function withoutCodeSpans(line: string): string {
  // A span opened by N backticks is closed by the next run of exactly N.
  return line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, "");
}

/** Every link in the text that is written in the document itself, in order. */
export function readLinks(text: string): Link[] {
  const links: Link[] = [];

  proseLines(text).forEach((raw, index) => {
    const line = withoutCodeSpans(raw);
    const definition = LINK_DEFINITION.exec(line);
    const targets = [
      ...[...line.matchAll(INLINE_LINK)].map((match) => match[1] ?? match[2]),
      ...(definition === null ? [] : [definition[1] ?? definition[2]]),
      ...[...line.matchAll(HTML_LINK)].map((match) => match[1] ?? match[2]),
    ];

    for (const target of targets) {
      if (target !== undefined && target !== "") {
        links.push({ line: index + 1, target });
      }
    }
  });

  return links;
}

/**
 * The words of a heading as a reader sees them, which is what GitHub makes the
 * anchor from: a link gives its text, an image and a tag give nothing, and
 * `_emphasis_` loses its underscores. A code span is kept as written.
 */
export function headingText(raw: string): string {
  return raw
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, "")
            .replace(/\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, "$1")
            .replace(/<\/?[a-z][^>]*>/gi, "")
            .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)(.*?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2"),
    )
    .join("");
}

/** The text of `# Title`, `## Title ##` and the like, or undefined when the line is not such a heading. */
function atxHeading(line: string): string | undefined {
  const heading = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/.exec(line);

  if (heading === null) {
    return undefined;
  }

  // A closing run of `#` is decoration. `C#` is not: nothing separates it from the word.
  return (heading[1] ?? "").trim().replace(/(^|[ \t]+)#+$/, "");
}

/** What may be the first line of a heading underlined with `===` or `---`: plain text, not a list, a quote, a table or a tag. */
const PLAIN_TEXT = /^ {0,3}(?![-*+>|#<=]|\d+[.)] )\S/;

/** The text of a heading written as a line of text with `===` or `---` under it. */
function underlinedHeading(lines: string[], index: number): string | undefined {
  const line = lines[index] as string;
  const above = index === 0 ? "" : (lines[index - 1] as string);
  const below = lines[index + 1];

  if (below === undefined || !/^ {0,3}(?:=+|-+)[ \t]*$/.test(below) || above.trim() !== "" || !PLAIN_TEXT.test(line)) {
    return undefined;
  }

  return line.trim();
}

/**
 * Every anchor a link may name in this document: one for each heading, as
 * GitHub makes it, and one for each `id` or `name` written in HTML.
 */
export function readAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const nextAnchor = createSlugger();
  const lines = proseLines(text);

  lines.forEach((line, index) => {
    const heading = atxHeading(line) ?? underlinedHeading(lines, index);

    if (heading !== undefined && heading !== "") {
      anchors.add(nextAnchor(headingText(heading)));
    }

    for (const match of withoutCodeSpans(line).matchAll(HTML_ANCHOR)) {
      anchors.add((match[1] ?? match[2]) as string);
    }
  });

  return anchors;
}
