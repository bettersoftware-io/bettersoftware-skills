import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureLint } from "../eslint.config.mts";
import { gitIgnoredGlobs, isGitIgnored, listGitIgnored, listSourceFiles } from "./lib/files.mts";
import { runGates } from "./run.mts";

// A file git ignores is not the project's: nobody else has it, and CI never
// sees it. A plugin's working folder (`.remember/`, which ignores itself with
// a `.gitignore` of its own) once failed the typed lint with a file that only
// one machine had. So the gates' file walker and the lint ask git, and these
// tests ask a real git in a real repository.

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

/** A JavaScript file: the `typescript-only` gate and the lint's JavaScript ban both report one. */
const SCRIPT = "export const one = 1;\n";

const CONFIG = "export default { packages: {} };\n";

describe.skipIf(!HAS_GIT)("what git ignores", () => {
  it("is listed whichever file says so: the root's, a folder's own, or the repository's exclude list; and a folder ignored from outside is named once and not walked", () => {
    const root = createRepository({
      ".gitignore": "scratch.js\ngenerated/\n",
      ".remember/.gitignore": "*\n",
      ".remember/tmp/last.ts": SCRIPT,
      ".remember/now.js": SCRIPT,
      "scratch.js": SCRIPT,
      "generated/a.js": SCRIPT,
      "generated/deep/b.js": SCRIPT,
      "local/notes.js": SCRIPT,
      "src/kept.js": SCRIPT,
      ".git/info/exclude": "local/\n",
    });

    const listed = listGitIgnored(root) ?? [];

    // A folder that ignores itself is listed with what it holds; one ignored from above is one entry.
    expect(listed.filter((entry) => !entry.startsWith(".remember/")).sort()).toEqual(["generated/", "local/", "scratch.js"]);
    expect(listed).toContain(".remember/");

    for (const path of [".remember/tmp/last.ts", ".remember/now.js", "scratch.js", "generated/deep/b.js", "local/notes.js"]) {
      expect(isGitIgnored(root, path), path).toBe(true);
    }

    expect(isGitIgnored(root, "src/kept.js")).toBe(false);
  });

  it("never holds a file that is committed, whatever a pattern says", () => {
    const root = createRepository({ ".gitignore": "*.js\n", "kept.js": SCRIPT, "dropped.js": SCRIPT });

    spawnSync("git", ["add", "--force", "kept.js"], { cwd: root });

    expect(listGitIgnored(root)).toEqual(["dropped.js"]);
    expect(listSourceFiles(root, "")).toEqual(["kept.js"]);
  });

  it("is left out by the gates' file walker, at any depth, and a file that is only new is not", () => {
    const root = createRepository({
      ".remember/.gitignore": "*\n",
      ".remember/tmp/last.ts": SCRIPT,
      "packages/app/.gitignore": "generated/\nlocal.ts\n",
      "packages/app/generated/a.ts": SCRIPT,
      "packages/app/local.ts": SCRIPT,
      "packages/app/src/new.ts": SCRIPT,
    });

    expect(listSourceFiles(root, "")).toEqual(["packages/app/src/new.ts"]);
    expect(listSourceFiles(root, "packages/app")).toEqual(["packages/app/src/new.ts"]);
    // Asked for a folder inside an ignored one: still nothing.
    expect(listSourceFiles(root, ".remember/tmp")).toEqual([]);
    expect(listSourceFiles(root, "packages/app/generated")).toEqual([]);
  });

  it("is told from a name that only begins the same way", () => {
    const root = createRepository({ ".gitignore": "gen/\nnotes.ts\n", "gen/a.ts": SCRIPT, "generated/b.ts": SCRIPT, "notes.ts": SCRIPT, "notes.tsx": SCRIPT });

    expect(listSourceFiles(root, "")).toEqual(["generated/b.ts", "notes.tsx"]);
    expect(isGitIgnored(root, "gen")).toBe(true);
    expect(isGitIgnored(root, "gen/a.ts")).toBe(true);
    expect(isGitIgnored(root, "generated")).toBe(false);
  });

  it("is judged by no gate: the JavaScript file a full run reports is the one git does not ignore", async () => {
    const root = createRepository({
      "architecture.config.mts": CONFIG,
      ".remember/.gitignore": "*\n",
      ".remember/tmp/x.js": SCRIPT,
      "scripts/y.js": SCRIPT,
    });

    const { findings } = await runGates({ root });

    expect(findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual(["scripts/y.js"]);
  });

  it("is not judged when the editor hook names it either", async () => {
    const root = createRepository({
      "architecture.config.mts": CONFIG,
      ".remember/.gitignore": "*\n",
      ".remember/tmp/x.js": SCRIPT,
      "scripts/y.js": SCRIPT,
    });

    const { findings } = await runGates({ root, files: [".remember/tmp/x.js", "scripts/y.js"] });

    expect(findings.map(({ file }) => file)).toEqual(["scripts/y.js"]);
  });

  it("becomes patterns that mean those paths and no others, with a name a glob would read as a pattern taken literally", async () => {
    const root = createRepository({
      ".gitignore": "/app/\\[id\\]/\n/a(b)!+@{c}.ts\n",
      "app/[id]/page.ts": SCRIPT,
      "app/i/page.ts": SCRIPT,
      "a(b)!+@{c}.ts": SCRIPT,
      "ab.ts": SCRIPT,
    });
    const globs = gitIgnoredGlobs(root);
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{ ignores: globs }, { files: ["**/*.ts"] }] });

    expect(globs.sort()).toEqual(["a\\(b\\)\\!\\+\\@\\{c\\}.ts", "app/\\[id\\]/**"]);
    expect(await eslint.isPathIgnored(join(root, "app/[id]/page.ts"))).toBe(true);
    expect(await eslint.isPathIgnored(join(root, "a(b)!+@{c}.ts"))).toBe(true);
    expect(await eslint.isPathIgnored(join(root, "app/i/page.ts"))).toBe(false);
    expect(await eslint.isPathIgnored(join(root, "ab.ts"))).toBe(false);
  });

  it("is not linted: the kit's lint config ignores it, and still reports the same mistake in a file that is only new", async () => {
    const root = createRepository({
      ".remember/.gitignore": "*\n",
      ".remember/tmp/x.js": SCRIPT,
      ".remember/tmp/last.ts": SCRIPT,
      "scripts/y.js": SCRIPT,
    });
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint({ packages: {} }, root) as Linter.Config[] });
    const results = await eslint.lintFiles(["."]);

    expect(results.map(({ filePath, messages }) => [filePath.slice(root.length + 1), messages.map(({ ruleId }) => ruleId)])).toEqual([["scripts/y.js", ["no-restricted-syntax"]]]);
    expect(await eslint.isPathIgnored(join(root, ".remember/tmp/last.ts"))).toBe(true);
  });
});

describe("a folder that is in no repository", () => {
  it("has nothing git ignores: git cannot say, and every file is judged", async () => {
    const root = createFolder({ "architecture.config.mts": CONFIG, ".gitignore": "scratch.js\n", "scratch.js": SCRIPT, ".remember/.gitignore": "*\n", ".remember/x.js": SCRIPT });

    expect(listGitIgnored(root)).toBeUndefined();
    expect(gitIgnoredGlobs(root)).toEqual([]);
    expect(isGitIgnored(root, "scratch.js")).toBe(false);
    expect(listSourceFiles(root, "").filter((file) => file.endsWith(".js"))).toEqual([".remember/x.js", "scratch.js"]);
    expect((await runGates({ root })).findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual([".remember/x.js", "scratch.js"]);
  });

  it("is linted as before: the config is built, with the kit's own list of generated folders and nothing more", () => {
    const root = createFolder({ ".gitignore": "scratch.js\n" });

    expect(architectureLint({ packages: {} }, root)[0]?.ignores).toEqual([
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/reports/**",
      "**/.turbo/**",
      "**/__screenshots__/**",
    ]);
  });

  it("is no error when the folder does not exist", () => {
    expect(listSourceFiles(join(tmpdir(), "no-such-folder-for-the-gates"), "")).toEqual([]);
  });
});

/** A fresh folder holding `files` (path → content), outside every repository. */
function createFolder(files: Record<string, string>): string {
  // The real path: git prints paths from it, and on macOS the temporary folder is behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-ignored-")));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}

/** The same, as a git repository with nothing committed. */
function createRepository(files: Record<string, string>): string {
  const root = createFolder({});

  spawnSync("git", ["init", "--quiet"], { cwd: root });

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}
