import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADDON,
  BASE_CONFIG,
  copyInto,
  createProject,
  createRootConfig,
  readInstalledVersion,
  readManifest,
  readScripts,
  REPOSITORY,
  ROOT_CONFIG,
  runScript,
} from "./support.mts";

const CHECK = "biome:check";
const FIX = "biome:fix";
const FORMAT = "biome:format";

const CLEAN = "export const answer: number = 42;\n";
const UNFORMATTED = "export const answer:number=42\n";
const SORTED = 'import { join } from "node:path";\n\nimport { map } from "rxjs";\n\nexport const both: unknown[] = [join, map];\n';
const UNSORTED = 'import { map } from "rxjs";\nimport { join } from "node:path";\n\nexport const both: unknown[] = [join, map];\n';
/** Formatted, and wrong for the linter: a branch without braces. */
const LINT_ERROR = "export function pick(first: boolean): number {\n  if (first) return 1;\n\n  return 2;\n}\n";

describe("the scripts the add-on adds", () => {
  it("pins Biome to one exact version, the one these tests ran", () => {
    const pinned = readManifest().packageJson["."]?.devDependencies?.["@biomejs/biome"];

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned).toBe(readInstalledVersion());
  });

  it("joins gate:fast with the check, and verifies with the same command", () => {
    const { gates, verify } = readManifest();

    expect(gates.fast).toEqual([`pnpm ${CHECK}`]);
    expect(gates.full).toEqual([]);
    expect(verify).toBe(`pnpm ${CHECK}`);
  });

  it("passes a clean project with the check", () => {
    const run = runScript(createProject({ "src/answer.ts": CLEAN }), CHECK);

    expect(run.output).toContain("Checked 3 files");
    expect(run.status).toBe(0);
  });

  it("fails the check on a file that is not formatted, names the file, and leaves it as it was", () => {
    const project = createProject({ "src/answer.ts": UNFORMATTED });
    const run = runScript(project, CHECK);

    expect(run.status).toBe(1);
    expect(run.output).toContain("src/answer.ts format");
    expect(readFileSync(join(project, "src/answer.ts"), "utf8")).toBe(UNFORMATTED);
  });

  it("fails the check on a warning, not only on an error", () => {
    const run = runScript(createProject({ "src/answer.test.ts": 'it.only("runs alone", () => {});\n' }), CHECK);

    expect(run.output).toContain("lint/suspicious/noFocusedTests");
    expect(run.output).toContain("Found 1 warning");
    expect(run.status).toBe(1);
  });

  it("rewrites an unformatted file with the formatter", () => {
    const project = createProject({ "src/answer.ts": UNFORMATTED });

    expect(runScript(project, FORMAT).status).toBe(0);
    expect(readFileSync(join(project, "src/answer.ts"), "utf8")).toBe(CLEAN);
  });

  it("leaves the order of imports alone with the formatter, and repairs it with the fixer", () => {
    const project = createProject({ "src/list.ts": UNSORTED });

    runScript(project, FORMAT);

    expect(readFileSync(join(project, "src/list.ts"), "utf8")).toBe(UNSORTED);
    expect(runScript(project, CHECK).output).toContain("src/list.ts:1:1 assist/source/organizeImports");

    runScript(project, FIX);

    expect(readFileSync(join(project, "src/list.ts"), "utf8")).toBe(SORTED);
    expect(runScript(project, CHECK).status).toBe(0);
  });

  it("does not apply a fix that Biome calls unsafe", () => {
    const project = createProject({ "src/pick.ts": LINT_ERROR });
    const run = runScript(project, FIX);

    expect(readFileSync(join(project, "src/pick.ts"), "utf8")).toBe(LINT_ERROR);
    expect(run.output).toContain("src/pick.ts:2:3 lint/style/useBlockStatements");
    expect(run.status).toBe(1);
  });
});

describe("the files the add-on ships", () => {
  it("gives the project the root config to keep, and keeps the base for itself", () => {
    expect(readManifest().startingFiles).toEqual([ROOT_CONFIG]);
    expect(existsSync(join(ADDON, "files", ROOT_CONFIG))).toBe(true);
    expect(existsSync(join(ADDON, "files", BASE_CONFIG))).toBe(true);
  });

  it("has a root config that only extends the base", () => {
    const root = JSON.parse(readFileSync(join(ADDON, "files", ROOT_CONFIG), "utf8")) as Record<string, unknown>;

    expect(Object.keys(root).filter((key) => key !== "$schema")).toEqual(["extends"]);
    expect(root.extends).toEqual([`./${BASE_CONFIG}`]);
  });

  it("ships no JavaScript file", () => {
    const shipped = readdirSync(join(ADDON, "files"), { recursive: true, encoding: "utf8" });

    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.filter((path) => /\.(js|mjs|cjs|jsx)$/.test(path))).toEqual([]);
  });
});

describe("the two layers", () => {
  it("lets the project's root config switch off a rule the base sets", () => {
    const project = createProject({ "src/pick.ts": LINT_ERROR, [ROOT_CONFIG]: createRootConfig("useBlockStatements", "off") });

    expect(runScript(project, CHECK).status).toBe(0);
  });

  it("keeps the base's other rules when the project adds one of its own", () => {
    const project = createProject({
      "src/pick.ts": LINT_ERROR,
      "src/grow.ts": "export function grow(size: number): number {\n  size += 1;\n\n  return size;\n}\n",
      [ROOT_CONFIG]: createRootConfig("noParameterAssign", "error"),
    });
    const run = runScript(project, CHECK);

    expect(run.output).toContain("src/pick.ts:2:3 lint/style/useBlockStatements");
    expect(run.output).toContain("src/grow.ts:2:3 lint/style/noParameterAssign");
  });
});

describe("what Biome is kept away from", () => {
  it.each(["tools", ".claude", ".codex", "dist", "coverage", "reports", ".turbo"])("does not judge %s/ at the root", (folder) => {
    const run = runScript(createProject({ "src/answer.ts": CLEAN, [`${folder}/broken.ts`]: UNFORMATTED }), CHECK);

    expect(run.output).toContain("Checked 3 files");
    expect(run.status).toBe(0);
  });

  it.each(["dist", "coverage", "reports", ".turbo"])("does not judge %s/ inside a package", (folder) => {
    const run = runScript(createProject({ "src/answer.ts": CLEAN, [`packages/app/${folder}/broken.ts`]: UNFORMATTED }), CHECK);

    expect(run.output).toContain("Checked 3 files");
    expect(run.status).toBe(0);
  });

  it("still judges a package's own folder called tools", () => {
    const run = runScript(createProject({ "packages/app/tools/broken.ts": UNFORMATTED }), CHECK);

    expect(run.output).toContain("packages/app/tools/broken.ts format");
    expect(run.status).toBe(1);
  });
});

describe("a project with no .gitignore", () => {
  it("is told so by the check, which does not pass", () => {
    const project = createProject({ "src/answer.ts": CLEAN });

    rmSync(join(project, ".gitignore"));

    const run = runScript(project, CHECK);

    expect(run.output).toContain("Biome couldn't find an ignore file");
    expect(run.status).not.toBe(0);
  });
});

describe("the starter and the other add-ons", () => {
  /** What scripts/create-project.mts leaves out of the starter. */
  const NOT_COPIED = new Set(["node_modules", "dist", "coverage", ".turbo", "tools", ".claude", ".codex"]);

  it("finds nothing in a project made from the starter", () => {
    const project = createProject();

    copyInto(project, join(REPOSITORY, "starter"), NOT_COPIED);

    const run = runScript(project, CHECK);

    expect(run.output).toMatch(/Checked [1-9]\d files/);
    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });

  it.each(["coverage", "visual", "performance"])("finds nothing in what the %s add-on puts outside tools/", (addon) => {
    const project = createProject();

    copyInto(project, join(REPOSITORY, "starter"), NOT_COPIED);
    copyInto(project, join(REPOSITORY, "addons", addon, "files"));

    const run = runScript(project, CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });

  it("judges the files the visual add-on puts in a package", () => {
    const project = createProject();

    copyInto(project, join(REPOSITORY, "addons", "visual", "files"));

    const before = runScript(project, CHECK);
    const scenarios = "packages/client-react/tests/visual/scenarios.ts";

    expect(existsSync(join(project, scenarios))).toBe(true);
    expect(before.output).not.toContain("Found");

    const after = runScript(createProject({ [scenarios]: UNFORMATTED }), CHECK);

    expect(after.output).toContain(`${scenarios} format`);
  });
});

describe("the scripts named by the tests", () => {
  it("are all the scripts the add-on adds", () => {
    expect(Object.keys(readScripts()).sort()).toEqual([CHECK, FIX, FORMAT].sort());
  });
});
