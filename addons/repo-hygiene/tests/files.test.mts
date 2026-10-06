import { describe, expect, it } from "vitest";

import { listFiles } from "../files/tools/repo-hygiene/lib/files.mts";
import { createFolder } from "./support.mts";

// Which files the CSS lint and the doc-link check read. A hidden folder at the
// project root belongs to a tool: a plugin's working folder (`.remember/`)
// held notes with links that lead nowhere, and a stylesheet of its own.

describe("the files the hygiene checks read", () => {
  it("are none in a hidden folder at the project root that belongs to a tool", () => {
    const root = createFolder({ ".remember/now.md": "", ".remember/tmp/x.css": "", ".cache/a/b.md": "", ".vscode/notes.md": "", "docs/a.md": "" });

    expect(listFiles(root, /\.(md|css)$/)).toEqual(["docs/a.md"]);
  });

  it.each([".github", ".claude", ".codex", ".agents"])("are still read in %s/, which holds files of the project", (folder) => {
    expect(listFiles(createFolder({ [`${folder}/notes.md`]: "" }), /\.md$/)).toEqual([`${folder}/notes.md`]);
  });

  it("are still read in a visible folder at the root, and in a hidden folder further down", () => {
    const root = createFolder({ "scratch/a.md": "", "packages/app/.storybook/preview.css": "", "docs/.drafts/b.md": "" });

    expect(listFiles(root, /\.(md|css)$/)).toEqual(["docs/.drafts/b.md", "packages/app/.storybook/preview.css", "scratch/a.md"]);
  });
});
