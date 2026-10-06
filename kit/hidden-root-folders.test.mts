import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureLint } from "./eslint.config.mts";
import { runGates } from "./gates/run.mts";

// A hidden folder at the project root belongs to a tool, not to the project's
// code. A plugin's working folder (`.remember/`) held a timestamp file ending
// in `.ts`, and the typed lint failed on it on one machine. The lint leaves
// such a folder out, by one pattern. Nothing else decides what it reads: not
// git, and not a list of where code may be.

/** A JavaScript file: the lint's JavaScript ban reports one, and so does the `typescript-only` gate. */
const SCRIPT = "export const one = 1;\n";

const HIDDEN = "packages/domain/src/hidden.js";

const PROJECT = {
  "architecture.config.mts": 'export default { packages: { "packages/domain": { role: "domain" } } };\n',
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "packages/domain/package.json": '{ "name": "@app/domain", "scripts": { "test": "vitest run", "typecheck": "tsc" } }\n',
  "packages/domain/src/index.ts": SCRIPT,
};

describe("what the kit's lint reads", () => {
  it("is nothing in a hidden folder at the project root, however deep", async () => {
    const root = createFolder({ ...PROJECT, ".remember/tmp/x.ts": SCRIPT, ".remember/tmp/x.js": SCRIPT, ".cache/deep/er/y.js": SCRIPT, ".github/scripts/z.js": SCRIPT });
    const results = await lint(root).lintFiles(["."]);

    expect(results.map(({ filePath }) => filePath.slice(root.length + 1)).filter((file) => file.startsWith("."))).toEqual([]);

    for (const path of [".remember/tmp/x.ts", ".remember/tmp/x.js", ".cache/deep/er/y.js", ".github/scripts/z.js"]) {
      expect(await lint(root).isPathIgnored(join(root, path)), path).toBe(true);
    }
  });

  it("is still a visible folder at the root, a file at the root, and a hidden folder inside a package", async () => {
    const root = createFolder({ ...PROJECT, "scratch/x.js": SCRIPT, "at-the-root.js": SCRIPT, ".at-the-root.js": SCRIPT, "packages/domain/.storybook/main.js": SCRIPT, "packages/domain/src/.hidden/y.js": SCRIPT });
    const results = await lint(root).lintFiles(["."]);
    const reported = results.filter(({ messages }) => messages.some(({ ruleId }) => ruleId === "no-restricted-syntax")).map(({ filePath }) => filePath.slice(root.length + 1));

    expect(reported.sort()).toEqual([".at-the-root.js", "at-the-root.js", "packages/domain/.storybook/main.js", "packages/domain/src/.hidden/y.js", "scratch/x.js"]);
  });
});

describe("a rule-breaking file in a package", () => {
  // The lint asks git nothing, so none of these takes the file out of it.
  const WAYS: [how: string, files: Record<string, string>][] = [
    ["that nothing ignores", {}],
    ["that the root .gitignore names", { ".gitignore": "hidden.js\n" }],
    ["that a .gitignore beside it names", { "packages/domain/src/.gitignore": "*\n" }],
    ["whose whole package a .gitignore names", { ".gitignore": "/packages/\n" }],
  ];

  it.each(WAYS)("fails the lint and the gates, %s", async (_how, files) => {
    const root = createFolder({ ...PROJECT, [HIDDEN]: SCRIPT });

    spawnSync("git", ["init", "--quiet"], { cwd: root });
    write(root, files);

    const results = await lint(root).lintFiles(["."]);
    const { findings } = await runGates({ root });

    expect(results.filter(({ filePath }) => filePath.endsWith(HIDDEN)).flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId))).toEqual(["no-restricted-syntax"]);
    expect(findings.filter(({ gate, file }) => gate === "typescript-only" && file === HIDDEN)).toHaveLength(1);
  });
});

function lint(root: string): ESLint {
  return new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint({ packages: { "packages/domain": { role: "domain" } } }) as Linter.Config[] });
}

function createFolder(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hidden-root-")));

  write(root, files);

  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
