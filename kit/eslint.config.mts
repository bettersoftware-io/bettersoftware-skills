// The architecture lint rules, as a block a project spreads into its own flat
// config:
//
//   import { architectureLint } from "./tools/arch/eslint.config.mts";
//   export default [...architectureLint()];
//
// Every rule is an AST rule: none needs type information, so the block lints a
// file in isolation and is fast enough for an editor hook.
//
// Some rules apply to one kind of package only: React's rules to a client and
// to the bindings, and so on. Which package is which is read from the
// project's `architecture.config.mts`, the same declaration the gates read, so
// a rule follows the role and never a folder name.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";

import { classFilenameMatch } from "./eslint-rules/class-filename-match.mts";
import { componentNewspaper } from "./eslint-rules/component-newspaper.mts";
import { jsonFixturesInFactories } from "./eslint-rules/json-fixtures-in-factories.mts";
import { nameFixtureFactories } from "./eslint-rules/name-fixture-factories.mts";
import { nameFunctionsByEffect } from "./eslint-rules/name-functions-by-effect.mts";
import { nameJsxHandlers } from "./eslint-rules/name-jsx-handlers.mts";
import { newspaperOrder } from "./eslint-rules/newspaper-order.mts";
import { noBrowserDriverInSpecs } from "./eslint-rules/no-browser-driver-in-specs.mts";
import { noFrameworkCallsInSpecs } from "./eslint-rules/no-framework-calls-in-specs.mts";
import { noMinifiedJsonLiteral } from "./eslint-rules/no-minified-json-literal.mts";
import { noRealSleepsInTests } from "./eslint-rules/no-real-sleeps-in-tests.mts";
import { noRenderFunctions } from "./eslint-rules/no-render-functions.mts";
import { oneImportPerModule } from "./eslint-rules/one-import-per-module.mts";
import { pageObjectsOwnTheirComponent } from "./eslint-rules/page-objects-own-their-component.mts";
import { type ArchitectureConfig, CONFIG_FILES, type PackageDeclaration, type Role } from "./gates/lib/config.mts";
import { type LintDependency, REACT_HOOKS } from "./lint-dependencies.mts";

export const architecturePlugin: TSESLint.FlatConfig.Plugin = {
  rules: {
    "class-filename-match": classFilenameMatch,
    "component-newspaper": componentNewspaper,
    "json-fixtures-in-factories": jsonFixturesInFactories,
    "name-fixture-factories": nameFixtureFactories,
    "name-functions-by-effect": nameFunctionsByEffect,
    "name-jsx-handlers": nameJsxHandlers,
    "newspaper-order": newspaperOrder,
    "no-browser-driver-in-specs": noBrowserDriverInSpecs,
    "no-framework-calls-in-specs": noFrameworkCallsInSpecs,
    "no-minified-json-literal": noMinifiedJsonLiteral,
    "no-real-sleeps-in-tests": noRealSleepsInTests,
    "no-render-functions": noRenderFunctions,
    "one-import-per-module": oneImportPerModule,
    "page-objects-own-their-component": pageObjectsOwnTheirComponent,
  },
};

const SOURCE = ["**/*.{ts,tsx,mts}"];
const JAVASCRIPT = ["**/*.{js,mjs,cjs,jsx}"];
const COMMONJS_TYPESCRIPT = ["**/*.cts"];
const TESTS = ["**/*.{test,spec}.{ts,tsx,mts}"];
const TEST_SUPPORT = ["**/tests/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"];
const PAGE_OBJECTS = ["**/tests/**/pages/**/*.{ts,tsx}", "**/page-objects/**/*.{ts,tsx}", "**/*.page.{ts,tsx}"];
const plugins = { arch: architecturePlugin };

interface RestrictedSyntax {
  selector: string;
  message: string;
}

interface RestrictedGlobal {
  name: string;
  message: string;
}

const FUNCTIONS = ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSMethodSignature, TSFunctionType, TSConstructorType)";

// An object type written where it is USED has no name: a reader cannot search
// for it, two uses of the same shape drift apart, and an error message prints
// the whole shape. Each one is extracted to a named interface or type alias.
// Where a type is DEFINED an object type stays legal: `type X = { … }`, a
// member of a union, an interface body, a property of a named type.
//
// Each position has its own entry so that the message names it.
//
// ESLint keeps only ONE set of options for a rule on a file: a later block
// that sets `no-restricted-syntax` replaces this list, it does not add to it.
// So every block below that adds an entry spreads this list in first.
const RESTRICTED_SYNTAX: RestrictedSyntax[] = [
  {
    selector: `${FUNCTIONS} > .returnType TSTypeLiteral`,
    message: "Inline object return type — extract to a named interface/type alias.",
  },
  {
    selector: `${FUNCTIONS} > .params TSTypeLiteral`,
    message: "Inline object parameter type — extract to a named interface/type alias.",
  },
  {
    selector: "VariableDeclarator > .id > TSTypeAnnotation TSTypeLiteral",
    message: "Inline object variable type — extract to a named interface/type alias.",
  },
  {
    selector: "PropertyDefinition > .typeAnnotation TSTypeLiteral",
    message: "Inline object property type — extract to a named interface/type alias.",
  },
  {
    selector: ":matches(TSAsExpression, TSSatisfiesExpression) > TSTypeLiteral",
    message: "Inline object type in a cast — extract to a named interface/type alias.",
  },
  {
    selector: "TSTypeParameterInstantiation > TSTypeLiteral",
    message: "Inline object as a type argument — extract to a named interface/type alias.",
  },
  // The view model is a bundle of hooks. A component that keeps the whole
  // bundle in a variable hides which hooks it uses; one that names them in a
  // destructuring shows its inputs on one line. (In a project whose bindings
  // have no `useViewModel`, these two match nothing.)
  {
    selector: "VariableDeclarator[init.callee.name='useViewModel'][id.type='Identifier']",
    message: "Destructure the hooks you need: const { useX } = useViewModel().",
  },
  // `useViewModel().useX()` reaches into the bundle inline, and hides the hook
  // call from a reader scanning for `useX(`. Destructure first, then call.
  {
    selector: "MemberExpression[object.callee.name='useViewModel']",
    message: "Don't chain off useViewModel(). Destructure first: const { useX } = useViewModel(); then call useX().",
  },
];

const INLINE_STYLE_OBJECT = "JSXAttribute[name.name='style'] > JSXExpressionContainer > ObjectExpression";
const INLINE_STYLE_CAST = "JSXAttribute[name.name='style'] > JSXExpressionContainer > TSAsExpression > ObjectExpression";

// A `style={{ … }}` object literal puts styling in the markup, where no
// stylesheet rule, theme or media query can reach it. The second selector is
// the same literal behind an `as CSSProperties` cast. `style={variable}` and
// `style={compute()}` are not matched: a value worked out at run time has no
// other way in.
const INLINE_STYLE: RestrictedSyntax = {
  selector: `${INLINE_STYLE_OBJECT}, ${INLINE_STYLE_CAST}`,
  message:
    "Inline style={{…}} is banned — move static styling to a stylesheet and use a class. Only a value computed at run time (a CSS custom property) is exempt; if one is truly needed, add: // eslint-disable-next-line no-restricted-syntax -- <reason>.",
};

// The names CommonJS gives a module. In an ES module they do not exist, so a
// file that uses one works only where a tool happens to load it as CommonJS.
// Only the GLOBAL name is reported: a local
// `const require = createRequire(import.meta.url)`, the ES-module way to load
// a CommonJS-only file or to resolve from another package, is not.
const COMMONJS_GLOBALS: RestrictedGlobal[] = [
  { name: "module", message: "CommonJS `module.exports` — use an ES `export`." },
  { name: "exports", message: "CommonJS `exports` — use an ES `export`." },
  { name: "__dirname", message: "CommonJS `__dirname` — use `import.meta.dirname`." },
  { name: "__filename", message: "CommonJS `__filename` — use `import.meta.filename`." },
  {
    name: "require",
    message:
      "CommonJS `require()` — use an ES `import`. To resolve from another package or load a CommonJS-only file, build one explicitly: `createRequire(import.meta.url)`.",
  },
];

// `default` is in the list because it is the one form the named list cannot
// see: `import React from "react"` and then `React.useMemo(…)`. The rule
// matches imported NAMES, and a default import names none of them. A
// namespace import (`import * as React`) is caught without help. React's
// automatic JSX runtime makes the default import unnecessary.
const MEMOIZATION_IMPORTS = ["default", "useMemo", "useCallback", "memo"];

const require = createRequire(import.meta.url);

export class MissingLintDependencyError extends Error {}

/**
 * Loads an npm package the lint rules need. A project that updates its kit
 * does not get the kit's new dependencies with it, so a missing one is said in
 * words: what is missing, what needs it, and the command that adds it.
 */
export function loadLintDependency({ name, version, neededFor }: LintDependency, load: () => unknown): unknown {
  try {
    return load();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
      throw error;
    }

    throw new MissingLintDependencyError(
      `${name} is not installed, so the lint rules could not run. That is no verdict, not a pass. ${neededFor} need it: add it as a dev dependency of the project root (pnpm add -D -w ${name}@${version}).`,
    );
  }
}

interface ReactHooksPlugin extends TSESLint.FlatConfig.Plugin {
  configs: Record<string, ReactHooksPreset>;
}

interface ReactHooksPreset {
  rules: Record<string, TSESLint.FlatConfig.RuleLevel>;
}

function loadReactHooks(): ReactHooksPlugin {
  // The name is written out here, and not taken from REACT_HOOKS, so that a
  // tool that looks for unused dependencies (knip) can see this one is used.
  return loadLintDependency(REACT_HOOKS, () => require("eslint-plugin-react-hooks")) as ReactHooksPlugin;
}

/**
 * The project's declared layers, read from the folder the lint is run in. The
 * gates read the same file; the lint needs only who plays which role. Without
 * the file the rules that depend on a role are not applied (the gates refuse
 * to run at all there, so that is not a silent pass).
 */
export function readDeclaredLayers(root: string = process.cwd()): ArchitectureConfig | undefined {
  const found = CONFIG_FILES.map((name) => join(root, name)).find((file) => existsSync(file));

  if (found === undefined) {
    return undefined;
  }

  return (require(found) as { default?: ArchitectureConfig }).default;
}

function stripSlashes(path: string): string {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

// The source files of every package with one of these roles, and, when asked, only those that pass `only`.
function sourceOf(
  config: ArchitectureConfig | undefined,
  roles: Role[],
  extensions: string,
  only: (declared: PackageDeclaration) => boolean = () => true,
): string[] {
  return Object.entries(config?.packages ?? {})
    .filter(([, declared]) => roles.includes(declared.role) && only(declared))
    .map(([path]) => `${stripSlashes(path)}/src/**/*.${extensions}`);
}

/**
 * @param config The project's layers. Read from `architecture.config.mts` in
 *   the current folder when not given.
 */
export function architectureLint(config: ArchitectureConfig | undefined = readDeclaredLayers()): TSESLint.FlatConfig.ConfigArray {
  const clientMarkup = sourceOf(config, ["client"], "tsx");
  const clientSource = sourceOf(config, ["client"], "{ts,tsx}");
  const compiledSource = sourceOf(config, ["client"], "{ts,tsx}", ({ reactCompiler }) => reactCompiler === true);
  const bindingsSource = sourceOf(config, ["bindings"], "{ts,tsx}");
  const endToEndSource = sourceOf(config, ["e2e"], "{ts,tsx}");
  const endToEndSpecs = sourceOf(config, ["e2e"], "spec.{ts,tsx}");

  return [
    // Installed and generated files. Nothing in them is the project's to fix.
    {
      ignores: [
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
        "**/reports/**",
        "**/.turbo/**",
        "**/__screenshots__/**",
      ],
    },
    {
      files: [...SOURCE, ...JAVASCRIPT, ...COMMONJS_TYPESCRIPT],
      languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    ...javascriptBan(config),
    {
      // The TypeScript twin of a `.cjs` file. Every loader that takes
      // TypeScript takes an ES module (`.mts`), including the ones that
      // `require()` their config: Node can `require()` an ES module.
      files: COMMONJS_TYPESCRIPT,
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "Program",
            message:
              "CommonJS files are banned — write an ES module and name it `.mts`. A tool that `require()`s its config can still load it: Node can `require()` an ES module.",
          },
        ],
      },
    },
    {
      files: SOURCE,
      rules: {
        "no-restricted-globals": ["error", ...COMMONJS_GLOBALS],
      },
    },
    {
      // One way to write a function, so that a reader never has to ask why
      // this one is different, and so that every function has a name in a
      // stack trace.
      files: SOURCE,
      rules: {
        // A named function is a `function` declaration, never a `const`
        // holding an arrow or a function expression. A declaration is hoisted,
        // which is what lets a file put its main export first and its helpers
        // below.
        "func-style": ["error", "declaration", { allowArrowFunctions: false }],
        // An arrow always has a block body and a `return`. A statement can
        // then be added, or a breakpoint set, without rewriting the arrow.
        "arrow-body-style": ["error", "always"],
        // A function expression has a name, so a stack trace shows it.
        "func-names": ["error", "always"],
        // A blank line between the members of a class, after a one-line
        // member as well.
        "lines-between-class-members": ["error", "always", { exceptAfterSingleLine: false }],
        // A function, and any statement with a block that spans lines, stands
        // as its own paragraph: one blank line before it and one after.
        "padding-line-between-statements": [
          "error",
          { blankLine: "always", prev: "*", next: "function" },
          { blankLine: "always", prev: "function", next: "*" },
          { blankLine: "always", prev: "multiline-block-like", next: "*" },
          { blankLine: "always", prev: "*", next: "multiline-block-like" },
          // A declaration that spans lines is not "block-like", so the entries
          // above miss a run of them and they pack together. One blank line
          // between two such neighbours. (No rule here limits blank lines to
          // one; a formatter does that.)
          {
            blankLine: "always",
            prev: ["multiline-const", "multiline-let", "multiline-var"],
            next: ["multiline-const", "multiline-let", "multiline-var"],
          },
        ],
        "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX],
        // One class per file, so a class is found by its file name.
        "max-classes-per-file": ["error", 1],
      },
    },
    ...(clientMarkup.length === 0
      ? []
      : [
          {
            // Production markup only. A test harness outside `src` may use an
            // inline style as scaffolding (a wrapper of a fixed width).
            files: clientMarkup,
            rules: {
              "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, INLINE_STYLE],
            },
          } satisfies TSESLint.FlatConfig.Config,
        ]),
    ...(clientSource.length === 0 ? [] : [reactRules(clientSource)]),
    ...(compiledSource.length === 0
      ? []
      : [
          {
            // A client that declares `reactCompiler: true` has the React
            // Compiler in its build, which memoizes every derived value and
            // every callback. A hand-written `useMemo` is then noise the
            // compiler repeats, with a dependency list that can drift from
            // what the code reads. The ban is what makes relying on the
            // compiler real; `check-react-policies.mts` fails when the
            // declaration and the build disagree.
            //
            // Not applied to a client without the declaration: there nothing
            // would replace the memoization. Tests and page objects are out of
            // scope: nothing compiles them.
            //
            // `no-restricted-imports` and not `no-restricted-syntax`: a later
            // block replaces a rule's options, and this rule has no other
            // block on these files.
            files: compiledSource,
            ignores: ["**/__tests__/**", ...TESTS, ...PAGE_OBJECTS],
            rules: {
              "no-restricted-imports": [
                "error",
                {
                  paths: [
                    {
                      name: "react",
                      importNames: MEMOIZATION_IMPORTS,
                      message:
                        "Manual memoization is banned here: the React Compiler memoizes at build time. Write the plain value, or a function declaration for a callback. For an instance built once (not a cache), use useRef with `if (ref.current === null)`. A default React import is banned for the same reason: it is the one form that could reach React.useMemo unseen. Use named imports.",
                    },
                  ],
                },
              ],
            },
          } satisfies TSESLint.FlatConfig.Config,
        ]),
    ...(bindingsSource.length === 0
      ? []
      : [
          {
            // The bindings are a thin bridge from the stream library to React.
            // A `useMemo` there is a sign that logic has moved into the
            // bridge: it belongs in the core (a presenter or a state machine)
            // or in a pure function. So the bridge stays free of manual
            // memoization by design. That is a different reason from a
            // client's, and it holds whether or not a compiler ever reads
            // this package (where packages export their source, a client's
            // build compiles it too). Tests are out of scope.
            files: bindingsSource,
            ignores: ["**/__tests__/**", ...TESTS],
            rules: {
              "no-restricted-imports": [
                "error",
                {
                  paths: [
                    {
                      name: "react",
                      importNames: MEMOIZATION_IMPORTS,
                      message:
                        "Manual memoization is banned in a bindings package: the bridge stays memo-free by design. If you need memoization, the logic likely belongs in the core (a presenter or a state machine) or in a pure function. A default React import is banned for the same reason: it is the one form that could reach React.useMemo unseen. Use named imports.",
                    },
                  ],
                },
              ],
            },
          } satisfies TSESLint.FlatConfig.Config,
        ]),
    {
      files: SOURCE,
      plugins,
      rules: {
        "arch/name-functions-by-effect": "error",
        "arch/no-minified-json-literal": "error",
        // A file names a module in ONE import statement: a type rides beside
        // the values with an inline `type`, never in a second `import type`
        // statement. Re-exports follow the same rule. It has a fixer.
        "arch/one-import-per-module": "error",
      },
    },
    {
      files: SOURCE,
      ignores: [...TESTS, ...TEST_SUPPORT, "**/setup/**"],
      plugins,
      rules: { "arch/class-filename-match": "error" },
    },
    {
      files: ["**/*.tsx"],
      plugins,
      rules: { "arch/no-render-functions": "error" },
    },
    {
      files: ["**/*.tsx"],
      ignores: [...TESTS, ...TEST_SUPPORT],
      plugins,
      rules: {
        "arch/component-newspaper": "error",
        "arch/name-jsx-handlers": "error",
      },
    },
    {
      files: TESTS,
      plugins,
      rules: {
        "arch/newspaper-order": "error",
        "arch/name-fixture-factories": "error",
        "arch/no-real-sleeps-in-tests": "error",
      },
    },
    {
      files: [...TESTS, ...TEST_SUPPORT],
      plugins,
      rules: { "arch/json-fixtures-in-factories": "error" },
    },
    {
      files: TESTS,
      ignores: [...PAGE_OBJECTS, "**/harness/**", "**/setup/**", "**/*fixtures*", "**/*.testHelpers.*"],
      plugins,
      rules: { "arch/no-framework-calls-in-specs": "error" },
    },
    {
      files: PAGE_OBJECTS,
      plugins,
      rules: { "arch/page-objects-own-their-component": "error" },
    },
    ...(endToEndSource.length === 0
      ? []
      : [
          {
            // An end-to-end package drives a real browser, and every wait in
            // it is on something the application does in its own time. A
            // fixed wait is a guess wherever it is written, so the ban that
            // holds for tests holds for the page objects and the fixtures
            // here as well.
            files: endToEndSource,
            plugins,
            rules: { "arch/no-real-sleeps-in-tests": "error" },
          } satisfies TSESLint.FlatConfig.Config,
          {
            // The spec says what happens; the driver stays behind the page
            // objects. Only the specs: a page object and the fixtures file
            // are where the driver is meant to be.
            files: endToEndSpecs,
            plugins,
            rules: { "arch/no-browser-driver-in-specs": "error" },
          } satisfies TSESLint.FlatConfig.Config,
        ]),
  ];
}

/**
 * No JavaScript source: Node runs TypeScript directly, so a script or a tool
 * config is written as `.mts` and typechecked, while a `.js` file is checked
 * by nothing. `.cjs` is covered here too. The selector matches the root of the
 * file, so each JavaScript file is reported once, at line 1.
 *
 * The exemptions are the project's `javascriptAllowed` list, the one the
 * `typescript-only` gate reads: files whose loader cannot read TypeScript. A
 * project that declares `language: "javascript"` has no ban.
 */
function javascriptBan(config: ArchitectureConfig | undefined): TSESLint.FlatConfig.ConfigArray {
  if (config?.language === "javascript") {
    return [];
  }

  return [
    {
      files: JAVASCRIPT,
      ignores: Object.keys(config?.javascriptAllowed ?? {}).map(stripSlashes),
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "Program",
            message:
              "JavaScript files are banned — write TypeScript. Name a Node script or a tool config `.mts` (Node runs it directly) and make sure a tsconfig includes it. A file whose loader cannot read TypeScript is listed in architecture.config.mts under `javascriptAllowed`, with the reason.",
          },
        ],
      },
    },
  ];
}

/**
 * React's own rules for components and hooks: a hook is called at the top
 * level and in the same order on every render, an effect lists what it reads,
 * and a component stays pure (no mutation of props or state, no ref read
 * during render, no state set during render). The preset also holds the
 * checks the React Compiler relies on: it skips a component that breaks one,
 * without a word, so these are what keep a component compiled.
 *
 * Scoped to a client's `src`: in any other package a function whose name
 * happens to start with `use` (a use case) would be read as a hook.
 *
 * The preset marks a few of its rules "warn". A warning does not fail
 * `eslint`, so nothing would hold them; every rule here is an error.
 */
function reactRules(files: string[]): TSESLint.FlatConfig.Config {
  const reactHooks = loadReactHooks();
  const preset = reactHooks.configs["recommended-latest"]?.rules ?? {};

  return {
    files,
    plugins: { "react-hooks": reactHooks },
    rules: Object.fromEntries(Object.keys(preset).map((rule) => [rule, "error"])),
  };
}

export default architectureLint();
