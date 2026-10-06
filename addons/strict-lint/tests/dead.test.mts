import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkDead, formatResult } from "../files/tools/strict-lint/check-dead.mts";
import { createPackageJson, createProject, REAL_TOOL_TIMEOUT, writeFiles } from "./support.mts";

// These tests run the real knip with the shipped config, in a small project
// that has the starter's shapes. They are slow for unit tests (about a second
// each).

const CLEAN = "PASS lint:dead — knip found nothing unused";

describe("what knip finds", { timeout: REAL_TOOL_TIMEOUT }, () => {
  it("finds an export of a library package that nothing imports, and names the file", () => {
    const project = createWorkspace();

    writeFiles(project, { "packages/lib/src/add.ts": `${ADD}\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n` });

    const report = formatResult(checkDead(project));

    expect(report).toMatch(/Unused exports \(1\)\nsubtract +function +packages\/lib\/src\/add\.ts:9:17/);
  });

  it("finds a line of a package's index that nothing imports", () => {
    const project = createWorkspace();

    writeFiles(project, { "packages/lib/src/index.ts": `${INDEX}export { createHarness } from "./testing/harness.ts";\n` });

    expect(formatResult(checkDead(project))).toMatch(/Unused exports \(1\)\ncreateHarness +packages\/lib\/src\/index\.ts:2:10/);
  });

  it("finds a file nothing imports, in a package with no exports map", () => {
    const project = createWorkspace();

    writeFiles(project, { "packages/app/src/lonely.ts": 'console.info("nobody imports this");\n' });

    expect(formatResult(checkDead(project))).toMatch(/Unused files \(1\)\npackages\/app\/src\/lonely\.ts/);
  });

  it("finds a dependency in a package.json that no file of the package imports", () => {
    const project = createWorkspace();

    writeFiles(project, { "packages/lib/package.json": createPackageJson({ ...LIB, dependencies: { rxjs: "^7.8.2" } }) });

    expect(formatResult(checkDead(project))).toMatch(/Unused dependencies \(1\)\nrxjs +packages\/lib\/package\.json/);
  });
});

describe("what knip leaves alone", { timeout: REAL_TOOL_TIMEOUT }, () => {
  it("finds nothing in a project with the starter's shapes", () => {
    const result = checkDead(createWorkspace());

    expect(result.report).toBe("");
    expect(formatResult(result)).toContain(CLEAN);
  });

  it("counts an export that only a test imports as used", () => {
    const project = createWorkspace();

    writeFiles(project, {
      "packages/app/src/double.ts": "export function double(a: number): number {\n  return a * 2;\n}\n",
      "packages/app/src/double.test.ts": 'import { expect, it } from "vitest";\n\nimport { double } from "./double.ts";\n\nit("doubles", () => {\n  expect(double(2)).toBe(4);\n});\n',
    });

    expect(formatResult(checkDead(project))).toContain(CLEAN);
  });

  it("does not report architecture.config.mts, which the kit loads by its name", () => {
    expect(formatResult(checkDead(createWorkspace()))).not.toContain("architecture.config.mts");
  });

  it("does not report a file or an export under tools/", () => {
    expect(formatResult(checkDead(createWorkspace()))).not.toContain("tools/");
  });

  it.each(["dependency-cruiser", "@manypkg/cli", "stylelint", "syncpack"])("does not report %s, which a script in tools/ runs as a program", (dependency) => {
    const project = createWorkspace();

    writeFiles(project, { "package.json": createPackageJson({ ...ROOT, devDependencies: { ...ROOT.devDependencies, [dependency]: "^1.0.0" } }) });

    expect(formatResult(checkDead(project))).toContain(CLEAN);
  });

  it("does not report the compiler the kit loads from the client package, which the root does not list", () => {
    const project = createWorkspace();
    const loaded =
      'import { createRequire } from "node:module";\n\nconst require = createRequire(import.meta.url);\n\nexport const loaded: unknown[] = [require("@babel/core"), require.resolve("babel-plugin-react-compiler")];\n';

    writeFiles(project, { "tools/arch/check-compiler.mts": loaded });

    expect(formatResult(checkDead(project))).toContain(CLEAN);

    writeFiles(project, { "tools/arch/check-compiler.mts": loaded.replace("@babel/core", "@babel/parser") });

    expect(formatResult(checkDead(project))).toContain("@babel/parser");
  });

  it("reads the stylelint rules the repo-hygiene add-on keeps under tools/, and counts what they extend and load as used", () => {
    const project = createWorkspace();
    const hygiene = join(import.meta.dirname, "..", "..", "repo-hygiene");
    const { devDependencies } = (JSON.parse(readFileSync(join(hygiene, "addon.json"), "utf8")) as { packageJson: { ".": { devDependencies: Record<string, string> } } })
      .packageJson["."];
    const styleDependencies = Object.fromEntries(Object.entries(devDependencies).filter(([name]) => name.startsWith("stylelint")));

    writeFiles(project, {
      "package.json": createPackageJson({ ...ROOT, devDependencies: { ...ROOT.devDependencies, ...styleDependencies } }),
      "tools/repo-hygiene/stylelint.json": readFileSync(join(hygiene, "files/tools/repo-hygiene/stylelint.json"), "utf8"),
      "tools/repo-hygiene/stylelint.base.json": readFileSync(join(hygiene, "files/tools/repo-hygiene/stylelint.base.json"), "utf8"),
    });

    expect(Object.keys(styleDependencies)).toEqual(["stylelint", "stylelint-config-standard", "stylelint-declaration-strict-value"]);
    expect(formatResult(checkDead(project))).toContain(CLEAN);
  });

  it("follows a Playwright config kept under tests/ to the tests it names", () => {
    const project = createWorkspace();

    writeFiles(project, {
      "packages/app/package.json": createPackageJson({ ...APP, devDependencies: { ...APP.devDependencies, "@playwright/test": "1.63.0" } }),
      "packages/app/tests/visual/playwright.config.ts": 'export default { testDir: ".", testMatch: "visual.pw.ts" };\n',
      "packages/app/tests/visual/visual.pw.ts": 'import { test } from "@playwright/test";\n\ntest("draws", () => {});\n',
    });

    expect(formatResult(checkDead(project))).toContain(CLEAN);
  });

  it("does not report Playwright as missing at the root when a root script runs it in the package that installs it", () => {
    const project = createWorkspace();
    const visual = "pnpm --dir packages/app exec playwright test --config tests/visual/playwright.config.ts";

    writeFiles(project, {
      "package.json": createPackageJson({ ...ROOT, scripts: { ...ROOT.scripts, visual } }),
      "packages/app/package.json": createPackageJson({ ...APP, devDependencies: { ...APP.devDependencies, "@playwright/test": "1.63.0" } }),
      "packages/app/tests/visual/playwright.config.ts": 'export default { testDir: ".", testMatch: "visual.pw.ts" };\n',
      "packages/app/tests/visual/visual.pw.ts": 'import { test } from "@playwright/test";\n\ntest("draws", () => {});\n',
    });

    expect(formatResult(checkDead(project))).toContain(CLEAN);
  });

  it("follows a Vite config kept under tests/ to the page it serves", () => {
    const project = createWorkspace();

    writeFiles(project, {
      "packages/app/package.json": createPackageJson({ ...APP, devDependencies: { ...APP.devDependencies, vite: "^8" } }),
      "packages/app/tests/visual/host/vite.config.ts": "export default { root: import.meta.dirname };\n",
      "packages/app/tests/visual/host/index.html": '<!doctype html>\n<html>\n  <body>\n    <script type="module" src="/main.ts"></script>\n  </body>\n</html>\n',
      "packages/app/tests/visual/host/main.ts": 'console.info("the visual host");\n',
    });

    // Vite is not installed in this repository, so knip cannot tie the `vite`
    // program to the package and would report the dependency. What is pinned
    // here is the page: nothing under the host folder is reported.
    const report = formatResult(checkDead(project));

    expect(report).not.toContain("tests/visual/host");
    expect(report).not.toContain("Unused files");
  });
});

const ROOT = {
  name: "fixture",
  scripts: { gates: "node tools/arch/gates/run.mts", lint: "eslint .", test: "vitest run", "lint:dead": "node tools/strict-lint/check-dead.mts" },
  devDependencies: { "@typescript-eslint/utils": "^8.70.1", eslint: "^10.5.0", knip: "^6.17.1", "typescript-eslint": "^8.61.1", vitest: "^5.0.3" },
};

/** A library the way the starter writes one: its exports map gives out every file under src/. */
const LIB = {
  name: "@app/lib",
  exports: { ".": "./src/index.ts", "./*": "./src/*" },
  scripts: { test: "vitest run" },
};

/** An application: no exports map, started by a script. */
const APP = {
  name: "@app/app",
  scripts: { start: "node src/main.ts", test: "vitest run" },
  dependencies: { "@app/lib": "workspace:*" },
  devDependencies: {},
};

/** A package that is tests only, like the starter's integration package. */
const INTEGRATION = {
  name: "@app/integration",
  scripts: { test: "vitest run" },
  devDependencies: { "@app/lib": "workspace:*" },
};

const INDEX = 'export { add } from "./add.ts";\n';
const ADD = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function negate(a: number): number {\n  return -a;\n}\n";
const VITEST_CONFIG = 'import { defineConfig } from "vitest/config";\n\nimport { skipped } from "../../tools/arch/testing/portTests.mts";\n\nexport default defineConfig({ test: { exclude: skipped } });\n';

/**
 * A project with the starter's shapes and nothing unused: a library that
 * exports its source, an application that imports it by name and by path, a
 * package of tests only, a vitest config that reaches into tools/, and a kit
 * under tools/ with a script nothing in the project imports.
 */
function createWorkspace(): string {
  return createProject({
    "package.json": createPackageJson(ROOT),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "architecture.config.mts": "export default { packages: {} };\n",
    "tools/arch/gates/run.mts": 'console.info("gates");\n',
    "tools/arch/hooks/before-stop.mts": "export const unused: number = 1;\n",
    "tools/arch/testing/portTests.mts": "export const skipped: string[] = [];\n\nexport const alsoUnused: number = 1;\n",
    "packages/lib/package.json": createPackageJson(LIB),
    "packages/lib/src/index.ts": INDEX,
    "packages/lib/src/add.ts": ADD,
    "packages/lib/src/add.test.ts": 'import { expect, it } from "vitest";\n\nimport { negate } from "./add.ts";\n\nit("negates", () => {\n  expect(negate(1)).toBe(-1);\n});\n',
    "packages/lib/src/testing/harness.ts": "export function createHarness(): number {\n  return 1;\n}\n",
    "packages/app/package.json": createPackageJson(APP),
    "packages/app/vitest.config.ts": VITEST_CONFIG,
    "packages/app/src/main.ts": 'import { add } from "@app/lib";\n\nconsole.info(add(1, 2));\n',
    "packages/app/src/main.test.ts": 'import { expect, it } from "vitest";\n\nimport { createHarness } from "@app/lib/testing/harness.ts";\n\nit("starts", () => {\n  expect(createHarness()).toBe(1);\n});\n',
    "packages/integration/package.json": createPackageJson(INTEGRATION),
    "packages/integration/vitest.config.ts": VITEST_CONFIG,
    "packages/integration/src/whole.port.test.ts": 'import { expect, it } from "vitest";\n\nimport { add } from "@app/lib";\n\nit("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
  });
}
