import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkDocLinks, formatResult } from "../files/tools/repo-hygiene/check-doc-links.mts";
import { createFolder, initGit, TOOLS } from "./support.mts";

const script = join(TOOLS, "check-doc-links.mts");

describe("a project whose links all resolve", () => {
  const root = createFolder({
    "README.md": "See [the guide](docs/guide.md#set-up), [the folder](docs) and [the site](https://example.test/missing.md).\n",
    "docs/guide.md": "# Guide\n\n## Set up\n\nBack to [the top](#guide) or [the readme](../README.md).\n",
  });

  it("has no findings, and says how much it checked", () => {
    const result = checkDocLinks(root);

    expect(result.findings).toEqual([]);
    expect(formatResult(result)).toBe("PASS doc-links — 4 relative link(s) in 2 markdown file(s) resolve");
  });

  it("does not count a link with a scheme, or one that starts with //", () => {
    expect(checkDocLinks(createFolder({ "README.md": "[a](mailto:a@example.test) [b](//example.test/x.md) [c](README.md)\n" })).links).toBe(1);
  });
});

describe("a dead link", () => {
  it("to a missing file is reported with the file and the line it is written on", () => {
    const result = checkDocLinks(createFolder({ "docs/intro.md": "# Intro\n\nRead [setup](setup.md) first.\n" }));

    expect(result.findings).toEqual([
      {
        file: "docs/intro.md",
        line: 3,
        message: "The link `setup.md` leads to docs/setup.md, which does not exist. Correct the path, or remove the link.",
      },
    ]);
  });

  it("to a missing anchor names the anchor and the file that lacks it", () => {
    const result = checkDocLinks(createFolder({ "README.md": "[x](docs/guide.md#install)\n", "docs/guide.md": "# Guide\n\n## Set up\n" }));

    expect(result.findings).toMatchObject([{ file: "README.md", line: 1 }]);
    expect(result.findings[0]?.message).toBe(
      "The link `docs/guide.md#install` names the anchor `#install`, and docs/guide.md has no heading with that anchor. Correct the anchor, or remove it.",
    );
  });

  it("to an anchor written by the simple rule is told the anchor GitHub makes", () => {
    const result = checkDocLinks(createFolder({ "README.md": "[x](guide.md#local-ci)\n", "guide.md": "## Local -- CI\n" }));

    expect(result.findings[0]?.message).toContain("It has `#local----ci`: GitHub lowers the case, drops punctuation");
  });

  it("to an anchor in the same file is checked against that file", () => {
    const result = checkDocLinks(createFolder({ "README.md": "# Title\n\n[ok](#title) [dead](#titel)\n" }));

    expect(result.findings.map(({ message }) => message)).toEqual([
      "The link `#titel` names the anchor `#titel`, and README.md has no heading with that anchor. Correct the anchor, or remove it.",
    ]);
  });

  it("whose name differs from the file's only by case is dead, as it is on GitHub", () => {
    const result = checkDocLinks(createFolder({ "README.md": "[x](docs/Guide.md)\n", "docs/guide.md": "# Guide\n" }));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("The link `docs/Guide.md` leads to docs/Guide.md, ");
  });

  it("is printed under FAIL with a count", () => {
    expect(formatResult(checkDocLinks(createFolder({ "README.md": "[a](README.md)\n\n[x](gone.md)\n" })))).toBe(
      [
        "FAIL doc-links (1)",
        "  README.md:3",
        "    The link `gone.md` leads to gone.md, which does not exist. Correct the path, or remove the link.",
        "",
        "1 dead link(s) among 2 in 1 markdown file(s).",
      ].join("\n"),
    );
  });
});

describe("how a target is read", () => {
  it("takes a path that starts with / from the top of the project", () => {
    const root = createFolder({ "docs/deep/a.md": "[ok](/docs/b.md) [dead](/b.md)\n", "docs/b.md": "# B\n" });

    expect(checkDocLinks(root).findings.map(({ message }) => message)).toEqual([
      "The link `/b.md` leads to b.md, which does not exist. Correct the path, or remove the link.",
    ]);
  });

  it("decodes %20 in a path and in an anchor", () => {
    const root = createFolder({ "README.md": "[a](my%20notes.md#caf%C3%A9)\n", "my notes.md": "## Café\n" });

    expect(checkDocLinks(root).findings).toEqual([]);
  });

  it("leaves a query out of the path", () => {
    expect(checkDocLinks(createFolder({ "README.md": "[a](img.svg?raw=true)\n", "img.svg": "<svg/>" })).findings).toEqual([]);
  });

  it("does not look for a heading in a file that is not markdown", () => {
    expect(checkDocLinks(createFolder({ "README.md": "[a](src/main.ts#L10)\n", "src/main.ts": "" })).findings).toEqual([]);
  });

  it("follows a link that leaves the project", () => {
    const root = createFolder({ "project/README.md": "[up](../shared.md#notes) [dead](../gone.md)\n", "shared.md": "## Notes\n" });

    expect(checkDocLinks(join(root, "project")).findings.map(({ message }) => message)).toEqual([
      "The link `../gone.md` leads to ../gone.md, which does not exist. Correct the path, or remove the link.",
    ]);
  });
});

describe("which files are read", () => {
  it("skips installed and generated folders", () => {
    const root = createFolder({
      "README.md": "[a](README.md)\n",
      "node_modules/pkg/README.md": "[x](gone.md)\n",
      "packages/a/dist/notes.md": "[x](gone.md)\n",
    });

    expect(checkDocLinks(root)).toMatchObject({ findings: [], files: 1 });
  });

  it("skips the installed tooling in tools/, and still checks a link that points into it", () => {
    const root = createFolder({
      "README.md": "[kit](tools/arch/README.md) [dead](tools/arch/gone.md)\n",
      "tools/arch/README.md": "[example](architecture.config.example.mts)\n",
      "packages/a/tools/notes.md": "[x](gone.md)\n",
    });

    expect(checkDocLinks(root).findings.map(({ file, message }) => `${file}: ${message}`)).toEqual([
      "README.md: The link `tools/arch/gone.md` leads to tools/arch/gone.md, which does not exist. Correct the path, or remove the link.",
      "packages/a/tools/notes.md: The link `gone.md` leads to packages/a/tools/gone.md, which does not exist. Correct the path, or remove the link.",
    ]);
  });

  it("skips a folder that is a checkout of its own", () => {
    const root = createFolder({ "README.md": "[a](README.md)\n", "worktrees/other/.git": "gitdir: elsewhere\n", "worktrees/other/README.md": "[x](gone.md)\n" });

    expect(checkDocLinks(root)).toMatchObject({ findings: [], files: 1 });
  });

  it("skips a file git ignores", () => {
    const root = createFolder({ "README.md": "[a](README.md)\n", ".gitignore": "scratch/\n", "scratch/notes.md": "[x](gone.md)\n" });

    expect(checkDocLinks(root).files).toBe(2);

    initGit(root);

    expect(checkDocLinks(root)).toMatchObject({ findings: [], files: 1 });
  });

  it("reads a file whose extension is .MD", () => {
    expect(checkDocLinks(createFolder({ "NOTES.MD": "[x](gone.md)\n" })).findings).toHaveLength(1);
  });
});

describe("a project with nothing to check", () => {
  it("is skipped when it has no markdown, and never passes", () => {
    const result = checkDocLinks(createFolder({ "src/main.ts": "" }));

    expect(result.skipped).toBe("no markdown file");
    expect(formatResult(result)).toBe("SKIP doc-links — no markdown file");
  });

  it("is skipped when its markdown has no relative link", () => {
    expect(formatResult(checkDocLinks(createFolder({ "README.md": "# Title\n\n[site](https://example.test)\n" })))).toBe(
      "SKIP doc-links — no relative link in 1 markdown file(s)",
    );
  });
});

describe("the command", () => {
  const run = (...args: string[]) => spawnSync("node", [script, ...args], { encoding: "utf8" });

  it("exits 0 and prints PASS when every link resolves", () => {
    const { status, stdout } = run("--root", createFolder({ "README.md": "[a](README.md)\n" }));

    expect(status).toBe(0);
    expect(stdout).toContain("PASS doc-links");
  });

  it("exits 1 and names the dead link", () => {
    const { status, stdout } = run("--root", createFolder({ "README.md": "[a](gone.md)\n" }));

    expect(status).toBe(1);
    expect(stdout).toContain("README.md:1");
  });

  it("exits 2 when the folder does not exist", () => {
    const { status, stderr } = run("--root", join(createFolder(), "nowhere"));

    expect(status).toBe(2);
    expect(stderr).toContain("check:doc-links could not run:");
  });

  it("exits 2 on an argument it does not know", () => {
    expect(run("--fix").status).toBe(2);
  });
});
