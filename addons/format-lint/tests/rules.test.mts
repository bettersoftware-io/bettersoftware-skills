import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ADDON, BASE_CONFIG, createProject, runScript } from "./support.mts";

const CHECK = "biome:check";

const PRICE = "export interface Price {\n  mid: number;\n}\n";

describe("the formatter's settings", () => {
  it("accepts a line of 80 characters and breaks one of 81", () => {
    const fits = `export const text: string = "${"a".repeat(80 - 31)}";\n`;
    const tooLong = `export const text: string = "${"a".repeat(81 - 31)}";\n`;

    expect(fits.length - 1).toBe(80);
    expect(runScript(createProject({ "src/text.ts": fits }), CHECK).status).toBe(0);
    expect(runScript(createProject({ "src/text.ts": tooLong }), CHECK).output).toContain("src/text.ts format");
  });

  it.each([
    ["two spaces, not a tab", "export function one(): number {\n\treturn 1;\n}\n"],
    ["double quotes", "export const text: string = 'a';\n"],
    ["a semicolon after every statement", "export const one: number = 1\n"],
    ["a trailing comma in a list that spans lines", `export const list: string[] = [\n  "${"a".repeat(60)}",\n  "${"b".repeat(60)}"\n];\n`],
  ])("wants %s", (_setting, source) => {
    const run = runScript(createProject({ "src/sample.ts": source }), CHECK);

    expect(run.output).toContain("src/sample.ts format");
    expect(run.status).toBe(1);
  });

  it("formats JSON and CSS too", () => {
    const run = runScript(createProject({ "src/data.json": '{"a":1}\n', "src/page.css": "a{color:red}\n" }), CHECK);

    expect(run.output).toContain("src/data.json format");
    expect(run.output).toContain("src/page.css format");
  });
});

describe("the order of imports", () => {
  const ordered = [
    'import { join } from "node:path";',
    "",
    'import { map } from "rxjs";',
    "",
    'import { track } from "@app/domain";',
    "",
    'import { price } from "../price.ts";',
    'import { rows } from "./rows.ts";',
    "",
    'import "./page.css";',
    "",
    "export const all: unknown[] = [join, map, track, price, rows];",
    "",
  ].join("\n");

  it("accepts Node, then packages, then the workspace's own packages, then paths, then styles, a blank line between each", () => {
    const run = runScript(createProject({ "src/ui/list.ts": ordered }), CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });

  it("fails a workspace package that is sorted among the third-party ones", () => {
    const mixed = ordered.replace('import { map } from "rxjs";\n\nimport { track } from "@app/domain";', 'import { track } from "@app/domain";\nimport { map } from "rxjs";');
    const run = runScript(createProject({ "src/ui/list.ts": mixed }), CHECK);

    expect(mixed).not.toBe(ordered);
    expect(run.output).toContain("src/ui/list.ts:1:1 assist/source/organizeImports");
    expect(run.status).toBe(1);
  });

  it("sorts an import that is there for its effect like any other: after the code's imports, in name order", () => {
    const start = "export function start(): void {}\n";
    const sorted = 'import { start } from "./start.ts";\n\nimport "./app.css";\nimport "./reset.css";\n\nstart();\n';
    const asWritten = 'import "./reset.css";\nimport "./app.css";\n\nimport { start } from "./start.ts";\n\nstart();\n';
    const accepted = runScript(createProject({ "src/main.ts": sorted, "src/start.ts": start }), CHECK);
    const refused = runScript(createProject({ "src/main.ts": asWritten, "src/start.ts": start }), CHECK);

    expect(accepted.output).not.toContain("Found");
    expect(accepted.status).toBe(0);
    expect(refused.output).toContain("src/main.ts:1:1 assist/source/organizeImports");
    expect(refused.status).toBe(1);
  });

  it("puts a stylesheet reached through the #/ alias with the aliases, so before one beside the file", () => {
    const files = {
      "src/ui/App.ts": "export const app: number = 1;\n",
      "tests/host/main.ts": 'import "#/index.css";\nimport { app } from "#/ui/App.ts";\n\nimport "./host.css";\n\nexport const shown: number = app;\n',
    };
    const run = runScript(createProject(files), CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });
});

describe("the lint rules the base sets", () => {
  it.each([
    ["lint/style/useBlockStatements", { "src/a.ts": "export function pick(first: boolean): number {\n  if (first) return 1;\n\n  return 2;\n}\n" }],
    ["lint/style/noNonNullAssertion", { "src/a.ts": "export function first(all: string[]): string {\n  return all[0]!;\n}\n" }],
    ["lint/style/useImportType", { "src/price.ts": PRICE, "src/a.ts": 'import { Price } from "./price.ts";\n\nexport function keep(price: Price): Price {\n  return price;\n}\n' }],
    ["lint/style/useExportType", { "src/price.ts": PRICE, "src/a.ts": 'import type { Price } from "./price.ts";\n\nexport { Price };\n' }],
    ["lint/style/noDefaultExport", { "src/a.ts": "export default function one(): number {\n  return 1;\n}\n" }],
    ["lint/nursery/useExplicitType", { "src/a.ts": "export function one() {\n  return 1;\n}\n" }],
    ["lint/correctness/useImportExtensions", { "src/price.ts": PRICE, "src/a.ts": 'export type { Price } from "./price";\n' }],
    ["lint/style/noRestrictedImports", { "src/entities/price.ts": PRICE, "src/ports/contracts/a.ts": 'export type { Price } from "../../entities/price.ts";\n' }],
    ["lint/style/noRestrictedImports", { "src/price.ts": PRICE, "tests/visual/host/a.ts": 'export type { Price } from "../../../src/price.ts";\n' }],
    [
      "lint/correctness/noPrivateImports",
      { "src/inner/secret.ts": "/** @private */\nexport const hidden: number = 1;\n", "src/a.ts": 'import { hidden } from "./inner/secret.ts";\n\nexport const shown: number = hidden;\n' },
    ],
    ["lint/suspicious/noUndeclaredEnvVars", { "src/a.ts": "export const port: string | undefined = process.env.NOT_DECLARED;\n" }],
    ["lint/suspicious/noLeakedRender", { "src/Count.tsx": 'import type { ReactElement } from "react";\n\nexport function Count({ count }: { count: number }): ReactElement {\n  return <p>{count && <b>some</b>}</p>;\n}\n' }],
    ["lint/correctness/useUniqueElementIds", { "src/Field.tsx": 'import type { ReactElement } from "react";\n\nexport function Field(): ReactElement {\n  return <input id="name" />;\n}\n' }],
    [
      "lint/style/useComponentExportOnlyModules",
      { "src/Field.tsx": 'import type { ReactElement } from "react";\n\nexport const LIMIT: number = 3;\n\nexport function Field(): ReactElement {\n  return <input />;\n}\n' },
    ],
  ])("fails on %s", (rule, files) => {
    const run = runScript(createProject(files), CHECK);

    expect(run.output).toContain(` ${rule} `);
    expect(run.status).toBe(1);
  });

  it("accepts an import that climbs one folder, and one written from src with the #/ alias", () => {
    const files = {
      "src/entities/price.ts": PRICE,
      "src/ports/a.ts": 'export type { Price } from "../entities/price.ts";\n',
      "src/ports/contracts/b.ts": 'export type { Price } from "#/entities/price.ts";\n',
    };
    const run = runScript(createProject(files), CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });

  it("says where a deep import is written from instead", () => {
    const files = { "src/entities/price.ts": PRICE, "src/ports/contracts/a.ts": 'export type { Price } from "../../entities/price.ts";\n' };

    expect(runScript(createProject(files), CHECK).output).toContain("with its #/ alias: #/entities/price.ts");
  });

  it("accepts an environment variable that turbo.json declares", () => {
    const run = runScript(createProject({ "src/a.ts": "export const port: string | undefined = process.env.DECLARED;\n" }), CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });
});

describe("the rule sets the base turns on", () => {
  it("runs the recommended rules", () => {
    const run = runScript(createProject({ "src/a.ts": "export function same(a: number): boolean {\n  return a == 1;\n}\n" }), CHECK);

    expect(run.output).toContain(" lint/suspicious/noDoubleEquals ");
  });

  it("runs the React rules in a project whose package.json does not name React", () => {
    const hook =
      'import { useEffect } from "react";\n\nexport function useLog(text: string): void {\n  useEffect(() => {\n    console.info(text);\n  }, []);\n}\n';
    const run = runScript(createProject({ "src/useLog.ts": hook }), CHECK);

    expect(run.output).toContain(" lint/correctness/useExhaustiveDependencies ");
  });

  it("runs the test rules in a project whose package.json names no test runner", () => {
    const run = runScript(createProject({ "src/a.test.ts": 'export const shared: number = 1;\n\nit("runs", () => {});\n' }), CHECK);

    expect(run.output).toContain(" lint/suspicious/noExportsInTest ");
  });

  it("names every domain itself, so none depends on what Biome finds in a package.json", () => {
    const base = JSON.parse(readFileSync(join(ADDON, "files", BASE_CONFIG), "utf8")) as { linter: { domains: Record<string, string> } };

    expect(base.linter.domains).toEqual({
      react: "recommended",
      test: "recommended",
      playwright: "recommended",
      project: "recommended",
      turborepo: "recommended",
      types: "recommended",
    });
  });

  it("lints CSS", () => {
    const run = runScript(createProject({ "src/page.css": "a {\n  colour: red;\n}\n" }), CHECK);

    expect(run.output).toContain(" lint/correctness/noUnknownProperty ");
  });
});

describe("the exceptions the base makes", () => {
  it.each(["vite.config.ts", "packages/app/vitest.config.mts", "src/vite-env.d.ts"])("allows a default export in %s", (path) => {
    const run = runScript(createProject({ [path]: "declare const config: { name: string };\n\nexport default config;\n" }), CHECK);

    expect(run.output).not.toContain("Found");
    expect(run.status).toBe(0);
  });

  it.each(["packages/app/vitest.config.ts", "packages/app/tests/host/vite.config.mts"])(
    "allows a config file to reach the tooling outside its package, which no alias can: %s",
    (path) => {
      const files = {
        "tooling/skip.mts": "export const skipped: string[] = [];\n",
        [path]: `import { skipped } from "${"../".repeat(path.split("/").length - 1)}tooling/skip.mts";\n\nexport default { skipped };\n`,
      };
      const run = runScript(createProject(files), CHECK);

      expect(files[path]).toContain('from "../../');
      expect(run.output).not.toContain("Found");
      expect(run.status).toBe(0);
    },
  );

  it("reads a tsconfig with a comment and a trailing comma", () => {
    const project = createProject({ "tsconfig.base.json": '{\n  // why\n  "compilerOptions": {\n    "strict": true,\n  },\n}\n' });
    const run = runScript(project, CHECK);

    // The formatter still takes the trailing comma out; what the exception buys is that the file is read at all.
    expect(run.output).toContain("tsconfig.base.json format");
    expect(run.output).not.toContain("parse");
  });

  it("does not read a comment in any other JSON file", () => {
    const run = runScript(createProject({ "data.json": '{\n  // why\n  "a": 1\n}\n' }), CHECK);

    expect(run.output).toContain("data.json:2:3 parse");
    expect(run.status).toBe(1);
  });

  it.each(["src/List.page.tsx", "src/List.test.tsx", "src/List.spec.tsx", "tests/host/main.tsx", "src/__tests__/Probe.tsx", "src/page-objects/list.tsx"])(
    "allows a component that is not exported in test code: %s",
    (path) => {
      const source =
        'import type { ReactElement } from "react";\n\nexport function mount(): ReactElement {\n  return <Probe />;\n}\n\nfunction Probe(): ReactElement {\n  return <output />;\n}\n';
      const run = runScript(createProject({ [path]: source }), CHECK);

      expect(run.output).not.toContain("lint/style/useComponentExportOnlyModules");
    },
  );
});
