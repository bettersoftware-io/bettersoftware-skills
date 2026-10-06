import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureLint, foldersOutsideTheCode } from "./eslint.config.mts";
import type { ArchitectureConfig } from "./gates/lib/config.mts";
import { runGates } from "./gates/run.mts";

// Where the lint looks. It is told where the project's code is (its packages,
// `tools/`, the root folders it names, the files at the root) and opens no
// other root folder. A plugin's working folder (`.remember/`, with a
// timestamp file ending in `.ts`) once failed the typed lint on one machine.
//
// What git ignores decides nothing. An earlier answer to that failure asked
// git, and so gave the one being checked a switch: a line in a `.gitignore`
// took a file in a package out of the lint. These tests hold that closed.

/** A JavaScript file: the lint's JavaScript ban reports one, and so does the `typescript-only` gate. */
const SCRIPT = "export const one = 1;\n";

const LAYERS: ArchitectureConfig = { packages: { "packages/domain": { role: "domain" } } };

const HIDDEN = "packages/domain/src/hidden.js";

/** A project with one declared package, and the files given. */
const PROJECT = {
  "architecture.config.mts": 'export default { packages: { "packages/domain": { role: "domain" } } };\n',
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "packages/domain/package.json": '{ "name": "@app/domain", "scripts": { "test": "vitest run", "typecheck": "tsc" } }\n',
  "packages/domain/src/index.ts": SCRIPT,
};

describe("the root folders the lint does not open", () => {
  it("are every one that holds no package, is not tools/ and is not named, hidden or not", () => {
    const root = createFolder({ ...PROJECT, ".remember/tmp/x.ts": SCRIPT, "scratch/x.ts": SCRIPT, "docs/a.md": "", ".github/workflows/ci.yml": "", "tools/arch/x.mts": SCRIPT, "eslint.config.mts": SCRIPT });

    expect(foldersOutsideTheCode(LAYERS, root)).toEqual([".github/**", ".remember/**", "docs/**", "scratch/**"]);
  });

  it("do not include a folder the project names as code, by its first part", () => {
    const root = createFolder({ ...PROJECT, "scripts/build/a.mts": SCRIPT, ".storybook/main.ts": SCRIPT, "scratch/x.ts": SCRIPT });

    expect(foldersOutsideTheCode({ ...LAYERS, codeFolders: ["scripts/build/", "./.storybook"] }, root)).toEqual(["scratch/**"]);
  });

  it("do not include the folder of a package that is declared somewhere else than packages/", () => {
    const root = createFolder({ "apps/web/src/a.ts": SCRIPT, "libs/core/src/b.ts": SCRIPT, "other/c.ts": SCRIPT });

    expect(foldersOutsideTheCode({ packages: { "apps/web": { role: "client" }, "libs/core": { role: "core" } } }, root)).toEqual(["other/**"]);
  });

  it("are written so that a name a glob would read as a pattern is taken literally", async () => {
    const root = createFolder({ ...PROJECT, "[draft]/x.js": SCRIPT, "d/x.js": SCRIPT, "a(b)!+@{c}/x.js": SCRIPT });

    expect(foldersOutsideTheCode(LAYERS, root)).toEqual(["\\[draft\\]/**", "a\\(b\\)\\!\\+\\@\\{c\\}/**", "d/**"]);
    expect(await lint(root).isPathIgnored(join(root, "[draft]/x.js"))).toBe(true);
    expect(await lint(root).isPathIgnored(join(root, "a(b)!+@{c}/x.js"))).toBe(true);
  });

  it("are none when the project declares no layers: there is no list to go by, and every file is linted", async () => {
    const root = createFolder({ "scratch/x.js": SCRIPT });

    expect(foldersOutsideTheCode(undefined, root)).toEqual([]);
    expect(await new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint(undefined, root) as Linter.Config[] }).isPathIgnored(join(root, "scratch/x.js"))).toBe(false);
  });

  it("are none for a root that is not there", () => {
    expect(foldersOutsideTheCode(LAYERS, join(tmpdir(), "no-such-folder-for-the-lint"))).toEqual([]);
  });
});

describe("what the lint reads", () => {
  it("is the packages, tools/, the named folders and the files at the root; and nothing in any other root folder", async () => {
    const root = createFolder({
      ...PROJECT,
      // The reproduction: a plugin's folder, and a scratch folder.
      ".remember/tmp/x.ts": SCRIPT,
      ".remember/tmp/x.js": SCRIPT,
      "scratch/x.ts": SCRIPT,
      "scratch/x.js": SCRIPT,
      // Code, each with the same mistake.
      "packages/domain/src/in-package.js": SCRIPT,
      "tools/own/in-tools.js": SCRIPT,
      "scripts/in-named-folder.js": SCRIPT,
      "at-the-root.js": SCRIPT,
    });
    const results = await lint(root, { ...LAYERS, codeFolders: ["scripts"] }).lintFiles(["."]);
    const reported = results.filter(({ messages }) => messages.length > 0).map(({ filePath }) => filePath.slice(root.length + 1));

    expect(reported.sort()).toEqual(["at-the-root.js", "packages/domain/src/in-package.js", "scripts/in-named-folder.js", "tools/own/in-tools.js"]);
    expect(results.map(({ filePath }) => filePath.slice(root.length + 1)).filter((file) => /^(\.remember|scratch)\//.test(file))).toEqual([]);
  });

  it("does not read a new root folder until the project names it", async () => {
    const root = createFolder({ ...PROJECT, "scripts/y.js": SCRIPT });

    expect(await lint(root).isPathIgnored(join(root, "scripts/y.js"))).toBe(true);
    expect(await lint(root, { ...LAYERS, codeFolders: ["scripts"] }).isPathIgnored(join(root, "scripts/y.js"))).toBe(false);
  });

  it("is the same in a folder that is no git repository and in one that is", async () => {
    const files = { ...PROJECT, ".remember/tmp/x.js": SCRIPT, [HIDDEN]: SCRIPT };
    const plain = createFolder(files);
    const repository = createFolder(files);

    spawnSync("git", ["init", "--quiet"], { cwd: repository });

    for (const root of [plain, repository]) {
      expect(await lint(root).isPathIgnored(join(root, ".remember/tmp/x.js")), root).toBe(true);
      expect(await lint(root).isPathIgnored(join(root, HIDDEN)), root).toBe(false);
    }
  });
});

describe("a file in a package that a .gitignore names", () => {
  // Each took the file out of the lint while git was asked what to leave out.
  const WAYS: [how: string, files: Record<string, string>][] = [
    ["in the root .gitignore", { ".gitignore": "hidden.js\n" }],
    ["in a .gitignore beside it", { "packages/domain/src/.gitignore": "hidden.js\n" }],
    ["in a .gitignore beside it that ignores everything", { "packages/domain/src/.gitignore": "*\n" }],
    ["by its whole package", { ".gitignore": "/packages/domain/\n" }],
    ["by the folder that holds the packages", { ".gitignore": "/packages/\n" }],
    ["in .git/info/exclude", { ".git/info/exclude": "hidden.js\n" }],
  ];

  it.each(WAYS)("is still linted, %s", async (_how, files) => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, ...files });

    // Git does ignore it. The lint does not ask.
    expect(spawnSync("git", ["check-ignore", HIDDEN], { cwd: root }).status).toBe(0);

    const results = await lint(root).lintFiles(["."]);

    expect(results.filter(({ filePath }) => filePath.endsWith(HIDDEN)).flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId))).toEqual(["no-restricted-syntax"]);
  });

  it.each(WAYS)("still fails the gates, %s", async (_how, files) => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, ...files });
    const { findings } = await runGates({ root });

    expect(findings.filter(({ gate, file }) => gate === "typescript-only" && file === HIDDEN)).toHaveLength(1);
  });

  it("gives the lint the same list of folders whatever the .gitignore says", () => {
    const without = createRepository({ ...PROJECT, "scratch/x.ts": SCRIPT });
    const withRules = createRepository({ ...PROJECT, "scratch/x.ts": SCRIPT, ".gitignore": "/packages/\n!scratch/\ntools/\n" });

    expect(foldersOutsideTheCode(LAYERS, withRules).filter((pattern) => pattern !== ".git/**")).toEqual(foldersOutsideTheCode(LAYERS, without).filter((pattern) => pattern !== ".git/**"));
  });
});

/** The kit's lint, run in `root`. */
function lint(root: string, layers: ArchitectureConfig = LAYERS): ESLint {
  return new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint(layers, root) as Linter.Config[] });
}

/** A fresh folder holding `files` (path → content). */
function createFolder(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-scope-")));

  write(root, files);

  return root;
}

/** The same, as a git repository with nothing committed. */
function createRepository(files: Record<string, string>): string {
  const root = createFolder({});

  spawnSync("git", ["init", "--quiet"], { cwd: root });
  write(root, files);

  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
