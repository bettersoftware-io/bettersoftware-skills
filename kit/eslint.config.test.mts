// Runs ESLint with the kit's config over small sources. For each rule the kit
// switches on: one source that breaks it and is reported, and the corrected
// source, which is not.

import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { architectureLint, loadLintDependency, MissingLintDependencyError, readDeclaredLayers } from "./eslint.config.mts";
import type { ArchitectureConfig } from "./gates/lib/config.mts";

const ROOT = import.meta.dirname;

const LAYERS: ArchitectureConfig = {
  packages: {
    "packages/domain": { role: "domain" },
    "packages/react-bindings": { role: "bindings" },
    "packages/client-react": { role: "client" },
    "packages/client-web": { role: "client", reactCompiler: true },
  },
  javascriptAllowed: { "stylelint.config.mjs": "stylelint's config loader cannot read .mts" },
};

const PLUGIN_X = { name: "eslint-plugin-x", version: "^1.0.0", neededFor: "The rules for X" };

const DOMAIN = "packages/domain/src/thing.ts";
const COMPONENT = "packages/client-react/src/ui/Thing.tsx";
const BINDINGS = "packages/react-bindings/src/useThing.ts";
const COMPILED = "packages/client-web/src/ui/Thing.tsx";

interface RuleCase {
  /** Unique: the test is selected by it. */
  name: string;
  rule: string;
  /** Tells one entry of a rule from another, by its message. */
  message?: RegExp;
  file: string;
  bad: string;
  /** Linted as `file` unless `goodFile` says otherwise. */
  good: string;
  goodFile?: string;
}

describe("the rules the kit switches on", () => {
  // A loop and not `it.each`: a title built from `$name` is cut short, and a
  // test must be selectable by its whole name.
  for (const { name, rule, message, file, bad, good, goodFile } of createRuleCases()) {
    it(name, async () => {
      expect(await findingsOf(bad, file, rule, message)).not.toEqual([]);
      expect(await findingsOf(good, goodFile ?? file, rule, message)).toEqual([]);
    });
  }
});

describe("where a rule applies", () => {
  it("scope: an inline style outside a client's src is scaffolding", async () => {
    const harness = `export function Frame() {\n  return <div style={{ width: 320 }} />;\n}\n`;

    expect(await findingsOf(harness, "packages/client-react/tests/visual/host/Frame.tsx", "no-restricted-syntax", /Inline style/)).toEqual([]);
    expect(await findingsOf(harness, "packages/domain/src/Frame.tsx", "no-restricted-syntax", /Inline style/)).toEqual([]);
  });

  it("scope: a client file keeps the inline type bans beside the style ban", async () => {
    const source = `export function Thing(props: { label: string }) {\n  return <p>{props.label}</p>;\n}\n`;

    expect(await findingsOf(source, COMPONENT, "no-restricted-syntax", /parameter type/)).not.toEqual([]);
  });

  it("scope: a use case in the domain is not a React hook", async () => {
    const source = `declare function useCase(): number;\n\nexport function runWhen(ready: boolean): number {\n  if (ready) {\n    return useCase();\n  }\n\n  return 0;\n}\n`;

    expect(await findingsOf(source, DOMAIN, "react-hooks/rules-of-hooks")).toEqual([]);
    expect(await findingsOf(source, "packages/client-react/src/app/runWhen.ts", "react-hooks/rules-of-hooks")).not.toEqual([]);
  });

  it("scope: a bindings test may memoize", async () => {
    const source = `import { useMemo } from "react";\n\nexport const probe = useMemo;\n`;

    expect(await findingsOf(source, "packages/react-bindings/src/useThing.test.tsx", "no-restricted-imports")).toEqual([]);
    expect(await findingsOf(source, COMPONENT, "no-restricted-imports")).toEqual([]);
  });

  it("scope: only a client that declares the compiler is held to its memoization ban", async () => {
    const source = `import { useCallback } from "react";\n\nexport const probe = useCallback;\n`;

    const every = `import React, { memo, useCallback, useMemo, useState } from "react";\n\nexport const probe = [React, memo, useCallback, useMemo, useState];\n`;

    expect(await findingsOf(source, COMPILED, "no-restricted-imports", /React Compiler/)).not.toEqual([]);
    expect(await findingsOf(every, COMPILED, "no-restricted-imports", /React Compiler/)).toHaveLength(4);
    expect(await findingsOf(source, COMPONENT, "no-restricted-imports")).toEqual([]);
    expect(await findingsOf(source, DOMAIN, "no-restricted-imports")).toEqual([]);
  });

  it("scope: a compiled client's test and page object may memoize, since nothing compiles them", async () => {
    const source = `import { memo } from "react";\n\nexport const probe = memo;\n`;

    expect(await findingsOf(source, "packages/client-web/src/ui/Thing.test.tsx", "no-restricted-imports")).toEqual([]);
    expect(await findingsOf(source, "packages/client-web/src/ui/Thing.page.tsx", "no-restricted-imports")).toEqual([]);
    expect(await findingsOf(source, "packages/client-web/src/app/start.ts", "no-restricted-imports")).not.toEqual([]);
  });

  it("scope: the bindings and a compiled client are each told their own reason", async () => {
    const source = `import { useMemo } from "react";\n\nexport const probe = useMemo;\n`;

    expect(await findingsOf(source, BINDINGS, "no-restricted-imports", /memo-free by design/)).toHaveLength(1);
    expect(await findingsOf(source, BINDINGS, "no-restricted-imports", /React Compiler/)).toEqual([]);
    expect(await findingsOf(source, COMPILED, "no-restricted-imports", /React Compiler memoizes at build time/)).toHaveLength(1);
    expect(await findingsOf(source, COMPILED, "no-restricted-imports", /memo-free by design/)).toEqual([]);
  });

  it("scope: a JavaScript file the project lists as allowed is not reported", async () => {
    expect(await findingsOf("export default {};\n", "stylelint.config.mjs", "no-restricted-syntax", /JavaScript files are banned/)).toEqual([]);
    expect(await findingsOf("export default {};\n", "other.config.mjs", "no-restricted-syntax", /JavaScript files are banned/)).not.toEqual([]);
  });

  it("scope: a project that declares JavaScript as its language has no JavaScript ban", async () => {
    const javascript = createLinter({ ...LAYERS, language: "javascript" });
    const [result] = await javascript.lintText("export const a = 1;\n", { filePath: "packages/domain/src/thing.js" });

    expect(result?.messages).toEqual([]);
  });

  it("scope: without declared layers the rules for every file still apply", async () => {
    const plain = createLinter(undefined);
    const [result] = await plain.lintText("export const add = (a: number, b: number): number => {\n  return a + b;\n};\n", { filePath: DOMAIN });

    expect(result?.messages.map(({ ruleId }) => ruleId)).toEqual(["func-style"]);
  });

  it("severity: every rule is an error, so a plain eslint run fails on it", () => {
    const levels = architectureLint(LAYERS).flatMap(({ rules }) => Object.entries(rules ?? {}));
    const notErrors = levels.filter(([, level]) => (Array.isArray(level) ? level[0] : level) !== "error").map(([rule]) => rule);

    expect(levels.length).toBeGreaterThan(40);
    expect(notErrors).toEqual([]);
  });
});

describe("the declared layers", () => {
  it("layers: are read from the project's architecture config", () => {
    const layers = readDeclaredLayers(`${ROOT}/gates/fixtures/clean`);

    expect(layers?.packages["packages/client-react"]).toEqual({ role: "client" });
  });

  it("layers: a folder with no architecture config has none", () => {
    expect(readDeclaredLayers(`${ROOT}/eslint-rules`)).toBeUndefined();
  });
});

describe("a dependency the project has not installed", () => {
  it("dependency: a missing package is named, with the command that adds it", () => {
    function loadNothing(): never {
      throw Object.assign(new Error("Cannot find module 'eslint-plugin-x'"), { code: "MODULE_NOT_FOUND" });
    }

    expect(() => loadLintDependency(PLUGIN_X, loadNothing)).toThrow(MissingLintDependencyError);
    expect(() => loadLintDependency(PLUGIN_X, loadNothing)).toThrow(
      /eslint-plugin-x is not installed.*no verdict.*The rules for X need it.*pnpm add -D -w eslint-plugin-x@\^1\.0\.0/,
    );
  });

  it("dependency: a package that fails for another reason keeps its own error", () => {
    function loadBroken(): never {
      throw new SyntaxError("Unexpected token");
    }

    expect(() => loadLintDependency(PLUGIN_X, loadBroken)).toThrow(SyntaxError);
  });
});

const eslint = createLinter(LAYERS);

/** ESLint with the kit's config and nothing else. The two packages type a config differently; the shape is the same. */
function createLinter(layers: ArchitectureConfig | undefined): ESLint {
  return new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: architectureLint(layers) as Linter.Config[] });
}

/** The messages of one rule (and, with `message`, of one of its entries) for `source` linted as `file`. */
async function findingsOf(source: string, file: string, rule: string, message?: RegExp): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(source, { filePath: file });

  if (result === undefined) {
    throw new Error(`${file} was not linted: no config block matches it`);
  }

  const fatal = result.messages.find((finding) => finding.fatal);

  if (fatal !== undefined) {
    throw new Error(`${file} did not parse: ${fatal.message}`);
  }

  return result.messages.filter((finding) => finding.ruleId === rule && (message === undefined || message.test(finding.message)));
}

function createRuleCases(): RuleCase[] {
  return [
    {
      name: "func-style: a named function is a declaration",
      rule: "func-style",
      file: DOMAIN,
      bad: `export const add = (a: number, b: number): number => {\n  return a + b;\n};\n`,
      good: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    },
    {
      name: "arrow-body-style: an arrow has a block body",
      rule: "arrow-body-style",
      file: DOMAIN,
      bad: `export function double(values: number[]): number[] {\n  return values.map((value) => value * 2);\n}\n`,
      good: `export function double(values: number[]): number[] {\n  return values.map((value) => {\n    return value * 2;\n  });\n}\n`,
    },
    {
      name: "func-names: a function expression has a name",
      rule: "func-names",
      file: DOMAIN,
      bad: `export function double(values: number[]): number[] {\n  return values.map(function (value) {\n    return value * 2;\n  });\n}\n`,
      good: `export function double(values: number[]): number[] {\n  return values.map(function twice(value) {\n    return value * 2;\n  });\n}\n`,
    },
    {
      name: "lines-between-class-members: a blank line after a one-line member",
      rule: "lines-between-class-members",
      file: DOMAIN,
      bad: `export class Thing {\n  first = 1;\n  second = 2;\n}\n`,
      good: `export class Thing {\n  first = 1;\n\n  second = 2;\n}\n`,
    },
    {
      name: "padding: a blank line before a function",
      rule: "padding-line-between-statements",
      file: DOMAIN,
      bad: `const one = 1;\nfunction two(): number { return one + 1; }\n`,
      good: `const one = 1;\n\nfunction two(): number { return one + 1; }\n`,
    },
    {
      name: "padding: a blank line after a function",
      rule: "padding-line-between-statements",
      file: DOMAIN,
      bad: `function one(): number { return 1; }\nexport const two = one() + 1;\n`,
      good: `function one(): number { return 1; }\n\nexport const two = one() + 1;\n`,
    },
    {
      name: "padding: a blank line after a block that spans lines",
      rule: "padding-line-between-statements",
      file: DOMAIN,
      bad: `let count = 0;\n\nif (count === 0) {\n  count = 1;\n}\ncount += 1;\n`,
      good: `let count = 0;\n\nif (count === 0) {\n  count = 1;\n}\n\ncount += 1;\n`,
    },
    {
      name: "padding: a blank line before a block that spans lines",
      rule: "padding-line-between-statements",
      file: DOMAIN,
      bad: `let count = 0;\nif (count === 0) {\n  count = 1;\n}\n`,
      good: `let count = 0;\n\nif (count === 0) {\n  count = 1;\n}\n`,
    },
    {
      name: "padding: a blank line between two declarations that span lines",
      rule: "padding-line-between-statements",
      file: DOMAIN,
      bad: `const first = {\n  a: 1,\n};\nconst second = {\n  b: 2,\n};\n\nexport { first, second };\n`,
      good: `const first = {\n  a: 1,\n};\n\nconst second = {\n  b: 2,\n};\n\nexport { first, second };\n`,
    },
    {
      name: "max-classes-per-file: one class in a file",
      rule: "max-classes-per-file",
      file: DOMAIN,
      bad: `export class First {}\n\nexport class Second {}\n`,
      good: `export class First {}\n`,
    },
    {
      name: "inline type: a return type",
      rule: "no-restricted-syntax",
      message: /Inline object return type/,
      file: DOMAIN,
      bad: `export function read(): { mid: number } {\n  return { mid: 1 };\n}\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport function read(): Price {\n  return { mid: 1 };\n}\n`,
    },
    {
      name: "inline type: a parameter",
      rule: "no-restricted-syntax",
      message: /Inline object parameter type/,
      file: DOMAIN,
      bad: `export function read(price: { mid: number }): number {\n  return price.mid;\n}\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport function read(price: Price): number {\n  return price.mid;\n}\n`,
    },
    {
      name: "inline type: a variable",
      rule: "no-restricted-syntax",
      message: /Inline object variable type/,
      file: DOMAIN,
      bad: `export const price: { mid: number } = { mid: 1 };\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport const price: Price = { mid: 1 };\n`,
    },
    {
      name: "inline type: a class property",
      rule: "no-restricted-syntax",
      message: /Inline object property type/,
      file: DOMAIN,
      bad: `export class Thing {\n  price: { mid: number } = { mid: 1 };\n}\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport class Thing {\n  price: Price = { mid: 1 };\n}\n`,
    },
    {
      name: "inline type: a cast",
      rule: "no-restricted-syntax",
      message: /Inline object type in a cast/,
      file: DOMAIN,
      bad: `export const price = JSON.parse("{}") as { mid: number };\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport const price = JSON.parse("{}") as Price;\n`,
    },
    {
      name: "inline type: a type argument",
      rule: "no-restricted-syntax",
      message: /Inline object as a type argument/,
      file: DOMAIN,
      bad: `export const prices = new Map<string, { mid: number }>();\n`,
      good: `interface Price {\n  mid: number;\n}\n\nexport const prices = new Map<string, Price>();\n`,
    },
    {
      name: "view model: the bundle is destructured, not kept",
      rule: "no-restricted-syntax",
      message: /Destructure the hooks you need/,
      file: COMPONENT,
      bad: `declare function useViewModel(): { usePrices: () => number[] };\n\nexport function Thing() {\n  const viewModel = useViewModel();\n\n  return <p>{viewModel.usePrices().length}</p>;\n}\n`,
      good: `declare function useViewModel(): { usePrices: () => number[] };\n\nexport function Thing() {\n  const { usePrices } = useViewModel();\n\n  return <p>{usePrices().length}</p>;\n}\n`,
    },
    {
      name: "view model: no call chained off the bundle",
      rule: "no-restricted-syntax",
      message: /Don't chain off useViewModel/,
      file: COMPONENT,
      bad: `declare function useViewModel(): { usePrices: () => number[] };\n\nexport function Thing() {\n  return <p>{useViewModel().usePrices().length}</p>;\n}\n`,
      good: `declare function useViewModel(): { usePrices: () => number[] };\n\nexport function Thing() {\n  const { usePrices } = useViewModel();\n\n  return <p>{usePrices().length}</p>;\n}\n`,
    },
    {
      name: "inline style: an object literal in a client component",
      rule: "no-restricted-syntax",
      message: /Inline style/,
      file: COMPONENT,
      bad: `export function Thing() {\n  return <p style={{ color: "red" }}>x</p>;\n}\n`,
      good: `export function Thing() {\n  return <p className="warning">x</p>;\n}\n`,
    },
    {
      name: "inline style: the same literal behind a cast",
      rule: "no-restricted-syntax",
      message: /Inline style/,
      file: COMPONENT,
      bad: `import type { CSSProperties } from "react";\n\nexport function Thing() {\n  return <p style={{ color: "red" } as CSSProperties}>x</p>;\n}\n`,
      good: `import type { CSSProperties } from "react";\n\nexport function Thing(props: ThingProps) {\n  return <p style={props.computed}>x</p>;\n}\n\ninterface ThingProps {\n  computed: CSSProperties;\n}\n`,
    },
    {
      name: "javascript: a JavaScript file is reported",
      rule: "no-restricted-syntax",
      message: /JavaScript files are banned/,
      file: "packages/domain/src/thing.js",
      bad: `export const one = 1;\n`,
      good: `export const one = 1;\n`,
      goodFile: DOMAIN,
    },
    {
      name: "commonjs file: a .cjs file is reported",
      rule: "no-restricted-syntax",
      message: /JavaScript files are banned/,
      file: "tool.config.cjs",
      bad: `export const one = 1;\n`,
      good: `export const one = 1;\n`,
      goodFile: "tool.config.mts",
    },
    {
      name: "commonjs file: a .cts file is reported",
      rule: "no-restricted-syntax",
      message: /CommonJS files are banned/,
      file: "tool.config.cts",
      bad: `export const one = 1;\n`,
      good: `export const one = 1;\n`,
      goodFile: "tool.config.mts",
    },
    {
      name: "commonjs global: require",
      rule: "no-restricted-globals",
      message: /`require\(\)`/,
      file: DOMAIN,
      bad: `export const fs = require("node:fs");\n`,
      good: `import { createRequire } from "node:module";\n\nconst require = createRequire(import.meta.url);\n\nexport const fs = require("node:fs");\n`,
    },
    {
      name: "commonjs global: module",
      rule: "no-restricted-globals",
      message: /`module\.exports`/,
      file: DOMAIN,
      bad: `module.exports = { one: 1 };\n`,
      good: `export const one = 1;\n`,
    },
    {
      name: "commonjs global: exports",
      rule: "no-restricted-globals",
      message: /CommonJS `exports`/,
      file: DOMAIN,
      bad: `exports.one = 1;\n`,
      good: `export const one = 1;\n`,
    },
    {
      name: "commonjs global: __dirname",
      rule: "no-restricted-globals",
      message: /`__dirname`/,
      file: DOMAIN,
      bad: `export const here = __dirname;\n`,
      good: `export const here = import.meta.dirname;\n`,
    },
    {
      name: "commonjs global: __filename",
      rule: "no-restricted-globals",
      message: /`__filename`/,
      file: DOMAIN,
      bad: `export const self = __filename;\n`,
      good: `export const self = import.meta.filename;\n`,
    },
    {
      name: "react: a hook is not called in a condition",
      rule: "react-hooks/rules-of-hooks",
      file: COMPONENT,
      bad: `import { useState } from "react";\n\nexport function Thing(props: ThingProps) {\n  if (props.open) {\n    const [count] = useState(0);\n\n    return <p>{count}</p>;\n  }\n\n  return null;\n}\n\ninterface ThingProps {\n  open: boolean;\n}\n`,
      good: `import { useState } from "react";\n\nexport function Thing(props: ThingProps) {\n  const [count] = useState(0);\n\n  if (props.open) {\n    return <p>{count}</p>;\n  }\n\n  return null;\n}\n\ninterface ThingProps {\n  open: boolean;\n}\n`,
    },
    {
      name: "react: an effect lists what it reads",
      rule: "react-hooks/exhaustive-deps",
      file: COMPONENT,
      bad: `import { useEffect } from "react";\n\nexport function Thing(props: ThingProps) {\n  useEffect(() => {\n    document.title = props.title;\n  }, []);\n\n  return null;\n}\n\ninterface ThingProps {\n  title: string;\n}\n`,
      good: `import { useEffect } from "react";\n\nexport function Thing(props: ThingProps) {\n  useEffect(() => {\n    document.title = props.title;\n  }, [props.title]);\n\n  return null;\n}\n\ninterface ThingProps {\n  title: string;\n}\n`,
    },
    {
      name: "react: a ref is not read during render",
      rule: "react-hooks/refs",
      file: COMPONENT,
      bad: `import { useRef } from "react";\n\nexport function Thing() {\n  const renders = useRef(0);\n\n  return <p>{renders.current}</p>;\n}\n`,
      good: `import { useState } from "react";\n\nexport function Thing() {\n  const [renders] = useState(0);\n\n  return <p>{renders}</p>;\n}\n`,
    },
    {
      name: "bindings: no manual memoization",
      rule: "no-restricted-imports",
      file: BINDINGS,
      bad: `import { useMemo } from "react";\n\nexport function useThing(): number {\n  return useMemo(() => {\n    return 1;\n  }, []);\n}\n`,
      good: `import { useState } from "react";\n\nexport function useThing(): number {\n  return useState(1)[0];\n}\n`,
    },
    {
      name: "bindings: no default React import",
      rule: "no-restricted-imports",
      file: BINDINGS,
      bad: `import React from "react";\n\nexport function useThing(): number {\n  return React.useState(1)[0];\n}\n`,
      good: `import { useState } from "react";\n\nexport function useThing(): number {\n  return useState(1)[0];\n}\n`,
    },
    {
      name: "compiled client: no manual memoization",
      rule: "no-restricted-imports",
      message: /React Compiler/,
      file: COMPILED,
      bad: `import { useMemo } from "react";\n\nexport function Thing(props: ThingProps) {\n  const doubled = useMemo(() => {\n    return props.count * 2;\n  }, [props.count]);\n\n  return <p>{doubled}</p>;\n}\n\ninterface ThingProps {\n  count: number;\n}\n`,
      good: `export function Thing(props: ThingProps) {\n  const doubled = props.count * 2;\n\n  return <p>{doubled}</p>;\n}\n\ninterface ThingProps {\n  count: number;\n}\n`,
    },
    {
      name: "compiled client: no memo wrapper, no useCallback, no default or namespace React import",
      rule: "no-restricted-imports",
      message: /React Compiler/,
      file: COMPILED,
      bad: `import React, { memo, useCallback } from "react";\n\nexport const probe = [React, memo, useCallback];\n`,
      good: `import { useState } from "react";\n\nexport const probe = [useState];\n`,
    },
    {
      name: "one-import-per-module: a type rides in the value's statement",
      rule: "arch/one-import-per-module",
      file: DOMAIN,
      bad: `import { read } from "./price.ts";\nimport type { Price } from "./price.ts";\n\nexport const price: Price = read();\n`,
      good: `import { type Price, read } from "./price.ts";\n\nexport const price: Price = read();\n`,
    },
  ];
}
