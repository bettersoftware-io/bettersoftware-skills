import { describe, expect, it } from "vitest";

import { headingText, readAnchors, readLinks } from "../files/tools/repo-hygiene/lib/markdown.mts";

const targets = (text: string): string[] => readLinks(text).map(({ target }) => target);
const anchors = (text: string): string[] => [...readAnchors(text)];

describe("reading the links of a document", () => {
  it("gives each link with the line it is on", () => {
    expect(readLinks("intro\n\nsee [the guide](docs/guide.md) and [more](more.md#top)\n")).toEqual([
      { line: 3, target: "docs/guide.md" },
      { line: 3, target: "more.md#top" },
    ]);
  });

  it("leaves a title out of the target", () => {
    expect(targets('[a](one.md "The first") [b](two.md \'Second\')')).toEqual(["one.md", "two.md"]);
  });

  it("reads a target in angle brackets, spaces included", () => {
    expect(targets("[a](<my notes/one.md>)")).toEqual(["my notes/one.md"]);
  });

  it("keeps a pair of brackets that is part of the target", () => {
    expect(targets("[a](notes_(draft).md) and (see [b](two.md))")).toEqual(["notes_(draft).md", "two.md"]);
  });

  it("reads an image as a link to its file", () => {
    expect(targets("![diagram](img/flow.png)")).toEqual(["img/flow.png"]);
  });

  it("reads a link definition, and not a footnote", () => {
    expect(targets("[guide]: docs/guide.md\n[^1]: a footnote, see.md\n")).toEqual(["docs/guide.md"]);
  });

  it("reads href and src written as HTML", () => {
    expect(targets('<a href="docs/a.md">a</a> <img src=\'img/b.png\'>')).toEqual(["docs/a.md", "img/b.png"]);
  });

  it("skips what a fenced block shows", () => {
    expect(targets("```md\n[x](missing.md)\n```\n[y](real.md)\n")).toEqual(["real.md"]);
  });

  it("skips a block fenced with tildes", () => {
    expect(targets("~~~\n[x](missing.md)\n~~~\n[y](real.md)\n")).toEqual(["real.md"]);
  });

  it("does not let a shorter fence close a longer one", () => {
    expect(targets("````\n```\n[x](missing.md)\n```\n````\n[y](real.md)\n")).toEqual(["real.md"]);
  });

  it("does not take a line of inline code for the start of a fence", () => {
    expect(targets("```not a fence``` and [y](real.md)\n[z](also.md)\n")).toEqual(["real.md", "also.md"]);
  });

  it("skips link syntax shown in a code span", () => {
    expect(targets("write `[x](missing.md)` or ``[x](`also`.md)`` then [y](real.md)")).toEqual(["real.md"]);
  });
});

describe("the words of a heading", () => {
  it("takes the text of a link and drops its target", () => {
    expect(headingText("Hello [World](http://x.test) end")).toBe("Hello World end");
  });

  it("drops an image and a tag", () => {
    expect(headingText("![logo](x.png) Title <kbd>Ctrl</kbd>")).toBe(" Title Ctrl");
  });

  it("drops the underscores of emphasis and keeps those inside a word", () => {
    expect(headingText("_foo_ and __bar__ and snake_case_name")).toBe("foo and bar and snake_case_name");
  });

  it("keeps a code span as written", () => {
    expect(headingText("`code_span` and `_x_`")).toBe("`code_span` and `_x_`");
  });
});

describe("the anchors a document offers", () => {
  it("has one for each heading, at any level", () => {
    expect(anchors("# Top\n\ntext\n\n### Deep down\n")).toEqual(["top", "deep-down"]);
  });

  it("does not read text with no space after the # as a heading", () => {
    expect(anchors("#hashtag\n#1 in the list\n")).toEqual([]);
  });

  it("drops a closing run of #, and keeps the # of C#", () => {
    expect(anchors("## Closed ##\n## About C#\n")).toEqual(["closed", "about-c"]);
    expect(anchors("## C# ##\n")).toEqual(["c"]);
  });

  it("makes the anchor from the words a reader sees", () => {
    expect(anchors("## The [guide](docs/guide.md) for `pnpm test`\n")).toEqual(["the-guide-for-pnpm-test"]);
  });

  it("numbers a repeated heading", () => {
    expect(anchors("## Limits\n\n## Limits\n")).toEqual(["limits", "limits-1"]);
  });

  it("reads a heading underlined with = or -", () => {
    expect(anchors("Top title\n=========\n\nSecond one\n---\n")).toEqual(["top-title", "second-one"]);
  });

  it("does not read a rule under a paragraph's last line, a list item or a table row as a heading", () => {
    expect(anchors("first line\nlast line\n---\n\n- item\n---\n\n| a | b |\n---\n")).toEqual([]);
  });

  it("skips a heading shown in a fenced block", () => {
    expect(anchors("```md\n## Not here\n```\n## Here\n")).toEqual(["here"]);
  });

  it("has the id and the name written in HTML, as written", () => {
    expect(anchors('<a name="Old-Name"></a>\n<div id="by-id">\n')).toEqual(["Old-Name", "by-id"]);
  });
});
