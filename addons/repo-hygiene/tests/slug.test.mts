import { describe, expect, it } from "vitest";

import { createSlugger, slug } from "../files/tools/repo-hygiene/lib/slug.mts";

describe("the anchor GitHub gives a heading", () => {
  it("keeps the spaces around a dropped character, so ` -- ` is four dashes", () => {
    expect(slug("A -- B")).toBe("a----b");
    expect(slug("Q & A")).toBe("q--a");
  });

  it("drops punctuation without leaving a dash for it", () => {
    expect(slug("What's new? (v2.0)")).toBe("whats-new-v20");
  });

  it("lowers the case", () => {
    expect(slug("Getting Started")).toBe("getting-started");
  });

  it("keeps underscores, dashes, digits and letters of any script", () => {
    expect(slug("snake_case pre-2024 Ünï 中文")).toBe("snake_case-pre-2024-ünï-中文");
  });

  it("drops an emoji and keeps the space after it", () => {
    expect(slug("🚀 Quick start")).toBe("-quick-start");
  });
});

describe("the anchors of one document", () => {
  it("numbers a heading that repeats: -1, then -2", () => {
    const next = createSlugger();

    expect(["Usage", "Usage", "usage"].map((heading) => next(heading))).toEqual(["usage", "usage-1", "usage-2"]);
  });

  it("does not hand out an anchor a numbered heading already took", () => {
    const next = createSlugger();

    expect(["Usage", "Usage", "Usage-1", "Usage"].map((heading) => next(heading))).toEqual(["usage", "usage-1", "usage-1-1", "usage-2"]);
  });

  it("starts again for another document", () => {
    createSlugger()("Usage");

    expect(createSlugger()("Usage")).toBe("usage");
  });
});
