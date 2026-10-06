import { describe, expect, it } from "vitest";

import { changedLines } from "./templates.mts";

describe("the lines that changed between two versions of a template", () => {
  it("are none when the two are the same", () => {
    expect(changedLines("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("are the line that came, for a line added between two that stayed", () => {
    expect(changedLines("a\nc\n", "a\nb\nc\n")).toEqual(["+ b"]);
  });

  it("are the line that went, for a line removed", () => {
    expect(changedLines("a\nb\nc\n", "a\nc\n")).toEqual(["- b"]);
  });

  it("are the old line then the new, for a line reworded", () => {
    expect(changedLines('{\n  "timeout": 60\n}\n', '{\n  "timeout": 600\n}\n')).toEqual(['-   "timeout": 60', '+   "timeout": 600']);
  });

  it("keep the order of the text when several places changed", () => {
    expect(changedLines("one\ntwo\nthree\nfour\n", "one\n2\nthree\nfour\nfive\n")).toEqual(["- two", "+ 2", "+ five"]);
  });

  it("keep the longest run of lines that stayed, so a block that moved is the only thing reported", () => {
    expect(changedLines("a\nb\nc\nd\ne\n", "c\nd\ne\na\nb\n")).toEqual(["- a", "- b", "+ a", "+ b"]);
  });
});
