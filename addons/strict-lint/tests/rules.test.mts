import { describe, expect, it } from "vitest";

import { checkTypes, formatResult } from "../files/tools/strict-lint/check-types.mts";
import { createPackageJson, createProject, createTsconfig, REAL_TOOL_TIMEOUT, writeFiles } from "./support.mts";

// These tests run the real ESLint with the shipped configs, in a project of
// one package. They are slow for unit tests (about a second each).

const SAVE = "export function save(): Promise<void> {\n  return Promise.resolve();\n}\n";
const SHAPE = 'export type Shape = "circle" | "square" | "line";\n';

const RULES: [rule: string, violating: string, corrected: string][] = [
  [
    "@typescript-eslint/no-floating-promises",
    'import { save } from "./save.ts";\n\nexport function run(): void {\n  save();\n}\n',
    'import { save } from "./save.ts";\n\nexport async function run(): Promise<void> {\n  await save();\n}\n',
  ],
  [
    "@typescript-eslint/no-misused-promises",
    'import { save } from "./save.ts";\n\nexport function run(all: number[]): void {\n  all.forEach(async () => {\n    await save();\n  });\n}\n',
    'import { save } from "./save.ts";\n\nexport async function run(all: number[]): Promise<void> {\n  for (const _one of all) {\n    await save();\n  }\n}\n',
  ],
  [
    "@typescript-eslint/switch-exhaustiveness-check",
    'import type { Shape } from "./shape.ts";\n\nexport function corners(shape: Shape): number {\n  switch (shape) {\n    case "circle":\n      return 0;\n    case "square":\n      return 4;\n  }\n\n  return -1;\n}\n',
    'import type { Shape } from "./shape.ts";\n\nexport function corners(shape: Shape): number {\n  switch (shape) {\n    case "circle":\n      return 0;\n    case "square":\n      return 4;\n    case "line":\n      return 2;\n  }\n}\n',
  ],
];

describe("the rules that need types", { timeout: REAL_TOOL_TIMEOUT }, () => {
  it.each(RULES)("%s: fails on a file that breaks it, names the file, and passes the corrected one", (rule, violating, corrected) => {
    const broken = checkTypes(createPackage({ "src/run.ts": violating }));

    expect(broken.findings.map((finding) => `${finding.file} ${finding.rule}`)).toEqual([`packages/app/src/run.ts ${rule}`]);

    const fixed = checkTypes(createPackage({ "src/run.ts": corrected }));

    expect(formatResult(fixed)).toBe("PASS lint:types — 4 file(s) linted with type information");
  });

  it("accepts a promise marked void", () => {
    const marked = 'import { save } from "./save.ts";\n\nexport function run(): void {\n  // Nothing waits: the caller is an event handler.\n  void save();\n}\n';

    expect(checkTypes(createPackage({ "src/run.ts": marked })).findings).toEqual([]);
  });

  it("accepts a switch whose default branch stands for the rest of a union", () => {
    const withDefault =
      'import type { Shape } from "./shape.ts";\n\nexport function corners(shape: Shape): number {\n  switch (shape) {\n    case "square":\n      return 4;\n    default:\n      return 0;\n  }\n}\n';

    expect(checkTypes(createPackage({ "src/run.ts": withDefault })).findings).toEqual([]);
  });
});

describe("what the rules are kept away from", { timeout: REAL_TOOL_TIMEOUT }, () => {
  const FLOATING = "function save(): Promise<void> {\n  return Promise.resolve();\n}\n\nsave();\n";

  it.each(["tools/probe.mts", "packages/app/dist/probe.ts", "packages/app/coverage/probe.ts", "packages/app/reports/probe.ts", "packages/app/.turbo/probe.ts"])(
    "does not judge %s",
    (path) => {
      const project = createPackage();

      writeFiles(project, { [path]: FLOATING });

      expect(formatResult(checkTypes(project))).toBe("PASS lint:types — 3 file(s) linted with type information");
    },
  );

  it("still judges a package's own folder called tools", () => {
    const project = createPackage({ "tools/probe.ts": FLOATING }, ["src", "tools"]);

    expect(checkTypes(project).findings.map((finding) => `${finding.file} ${finding.rule}`)).toEqual([
      "packages/app/tools/probe.ts @typescript-eslint/no-floating-promises",
    ]);
  });
});

describe("where the types come from", { timeout: REAL_TOOL_TIMEOUT }, () => {
  it("reports a file no tsconfig.json includes, and does not pass it", () => {
    const result = checkTypes(createPackage({ "vitest.config.ts": "export default {};\n" }));

    expect(result.findings).toEqual([
      { file: "packages/app/vitest.config.ts", line: 0, column: 0, rule: "parse", message: "no tsconfig.json includes this file" },
    ]);
  });

  it("judges a .mts file at the project root, with tsconfig.tooling.json", () => {
    const project = createPackage();

    writeFiles(project, { "probe.mts": "function save(): Promise<void> {\n  return Promise.resolve();\n}\n\nsave();\n" });

    expect(checkTypes(project).findings.map((finding) => `${finding.file} ${finding.rule}`)).toEqual([
      "probe.mts @typescript-eslint/no-floating-promises",
    ]);
  });
});

describe("the project's own config", { timeout: REAL_TOOL_TIMEOUT }, () => {
  it("runs the project's other ESLint rules in the same run", () => {
    const project = createPackage({ "src/run.ts": "export function run(): void {\n  debugger;\n}\n" });

    writeFiles(project, { "eslint.config.mts": 'export default [{ rules: { "no-debugger": "error" } }];\n' });

    expect(checkTypes(project).findings.map((finding) => `${finding.file} ${finding.rule}`)).toEqual(["packages/app/src/run.ts no-debugger"]);
  });

  it("fails on a warning too", () => {
    const project = createPackage({ "src/run.ts": "export function run(): void {\n  debugger;\n}\n" });

    writeFiles(project, { "eslint.config.mts": 'export default [{ rules: { "no-debugger": "warn" } }];\n' });

    expect(formatResult(checkTypes(project))).toContain("FAIL lint:types — 1 finding(s)");
  });
});

/**
 * A project with one package, `packages/app`, typechecked by a tsconfig.json
 * of its own. It holds two clean modules the cases import, and `files` (paths
 * from the package).
 */
function createPackage(files: Record<string, string> = {}, include: string[] = ["src"]): string {
  const inPackage = { "package.json": createPackageJson({ name: "@app/app" }), "tsconfig.json": createTsconfig(include), "src/save.ts": SAVE, "src/shape.ts": SHAPE, ...files };

  return createProject(Object.fromEntries(Object.entries(inPackage).map(([path, content]) => [`packages/app/${path}`, content])));
}
