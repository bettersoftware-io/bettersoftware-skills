import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureLint, codeFoldersOf } from "../eslint.config.mts";
import type { ArchitectureConfig } from "./lib/config.mts";
import { listSourceFiles } from "./lib/files.mts";
import { runGates } from "./run.mts";

// The lint reads where it is told the code is. The gates walk the declared
// packages. If the two lists came from different places, a file the gates
// judge could be one the lint never opens, and nobody would be told. So both
// come from the architecture config, and this holds them together: for a
// project of any layout, every file the gates' walker reads in a package, and
// every source file at the root, is a file the lint reads.

const SOURCE = "export const one = 1;\n";

const LAYOUTS: [name: string, packages: Record<string, { role: string }>, files: string[]][] = [
  [
    "the starter's",
    { "packages/domain": { role: "domain" }, "packages/client-react": { role: "client" }, "packages/e2e": { role: "e2e" }, "packages/integration": { role: "integration" } },
    [
      "packages/domain/src/index.ts",
      "packages/domain/vitest.config.ts",
      "packages/client-react/vite.config.ts",
      "packages/client-react/playwright.config.mts",
      "packages/client-react/src/ui/App.tsx",
      "packages/client-react/tests/visual/host/main.tsx",
      "packages/e2e/playwright.config.ts",
      "packages/e2e/src/sim/list.spec.ts",
      "packages/integration/src/both.test.ts",
      "eslint.config.mts",
      "architecture.config.mts",
    ],
  ],
  ["apps and libs", { "apps/web": { role: "client" }, "libs/core/domain": { role: "domain" } }, ["apps/web/src/main.tsx", "apps/web/vite.config.ts", "libs/core/domain/src/index.ts", "probe.mts"]],
  ["one package at the root's side, with dots in its folders", { "packages/a.b": { role: "domain" } }, ["packages/a.b/src/.hidden/x.ts", "packages/a.b/.storybook/main.ts", "packages/a.b/src/[id]/y.ts"]],
];

describe("what the lint reads, against what the gates read", () => {
  it.each(LAYOUTS)("covers every file the gates' walker reads in a declared package, and every source file at the root: %s", async (_name, packages, files) => {
    const root = createFolder(Object.fromEntries(files.map((path) => [path, SOURCE])));
    const config = { packages } as ArchitectureConfig;
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint(config, root) as Linter.Config[] });
    const read = [...Object.keys(packages).flatMap((path) => listSourceFiles(root, path)), ...files.filter((path) => !path.includes("/"))];

    expect(read.sort()).toEqual([...files].sort());

    for (const path of read) {
      expect(await eslint.isPathIgnored(join(root, path)), path).toBe(false);
    }
  });

  it("names the same places for the lint as the config declares, and a workspace package the config does not declare as well", () => {
    const root = createFolder({ "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n', "packages/domain/package.json": "{}", "apps/rogue/package.json": "{}", "apps/rogue/src/x.ts": SOURCE });

    expect(codeFoldersOf({ packages: { "packages/domain/": { role: "domain" } }, codeFolders: ["./scripts"] }, root)).toEqual(["apps/rogue", "packages/domain", "scripts", "tools"]);
  });

  it("lints a workspace package that nothing declares, and the structure gate says it is not declared", async () => {
    const root = createFolder({
      "architecture.config.mts": 'export default { packages: { "packages/domain": { role: "domain" } } };\n',
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
      "packages/domain/package.json": '{ "name": "@app/domain" }\n',
      "packages/domain/src/index.ts": SOURCE,
      "apps/rogue/package.json": '{ "name": "@app/rogue" }\n',
      "apps/rogue/src/x.js": SOURCE,
    });
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint({ packages: { "packages/domain": { role: "domain" } } }, root) as Linter.Config[] });
    const { findings } = await runGates({ root });

    expect(await eslint.isPathIgnored(join(root, "apps/rogue/src/x.js"))).toBe(false);
    expect(findings.filter(({ gate, file }) => gate === "structure" && file === "apps/rogue").map(({ message }) => message)[0]).toContain("no declared role");
  });
});

describe("a root folder that holds source and is no declared place", () => {
  const PROJECT = {
    "architecture.config.mts": 'export default { packages: { "packages/domain": { role: "domain" } } };\n',
    "packages/domain/package.json": '{ "name": "@app/domain" }\n',
    "packages/domain/src/index.ts": SOURCE,
  };
  const undeclared = async (files: Record<string, string>, config = PROJECT["architecture.config.mts"]): Promise<string[]> =>
    (await runGates({ root: createFolder({ ...PROJECT, "architecture.config.mts": config, ...files }) })).findings.filter(({ message }) => message.includes("no declared place of code")).map(({ file }) => file ?? "");

  it("fails the structure gate when it is visible: scratch/x.ts is caught, not passed over", async () => {
    expect(await undeclared({ "scratch/x.ts": SOURCE, "scripts/deep/y.mts": SOURCE })).toEqual(["scratch", "scripts"]);
  });

  it("is passed over when its name starts with a dot: the reproduction, a plugin's folder, fails nothing", async () => {
    const root = createFolder({ ...PROJECT, ".remember/tmp/x.ts": SOURCE });

    expect((await runGates({ root })).findings.filter(({ file }) => file?.startsWith(".remember"))).toEqual([]);
  });

  it("is no finding once it is named under codeFolders, when it is tools/, when it holds no source, or when it is an installed or built folder", async () => {
    const named = 'export default { packages: { "packages/domain": { role: "domain" } }, codeFolders: ["scripts"] };\n';

    expect(await undeclared({ "scripts/y.mts": SOURCE, "tools/own/z.mts": SOURCE, "docs/a.md": "", "node_modules/x/index.js": SOURCE, "dist/out.js": SOURCE, "coverage/prettify.js": SOURCE }, named)).toEqual([]);
  });
});

function createFolder(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-covers-")));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  return root;
}
