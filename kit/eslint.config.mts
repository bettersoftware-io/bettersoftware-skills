// The architecture lint rules, as a block a project spreads into its own flat
// config:
//
//   import { architectureLint } from "./tools/arch/eslint.config.mts";
//   export default [...architectureLint()];
//
// Every rule is an AST rule: none needs type information, so the block lints a
// file in isolation and is fast enough for an editor hook.

import type { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";

import { classFilenameMatch } from "./eslint-rules/class-filename-match.mts";
import { componentNewspaper } from "./eslint-rules/component-newspaper.mts";
import { jsonFixturesInFactories } from "./eslint-rules/json-fixtures-in-factories.mts";
import { nameFixtureFactories } from "./eslint-rules/name-fixture-factories.mts";
import { nameFunctionsByEffect } from "./eslint-rules/name-functions-by-effect.mts";
import { nameJsxHandlers } from "./eslint-rules/name-jsx-handlers.mts";
import { newspaperOrder } from "./eslint-rules/newspaper-order.mts";
import { noFrameworkCallsInSpecs } from "./eslint-rules/no-framework-calls-in-specs.mts";
import { noMinifiedJsonLiteral } from "./eslint-rules/no-minified-json-literal.mts";
import { noRealSleepsInTests } from "./eslint-rules/no-real-sleeps-in-tests.mts";
import { noRenderFunctions } from "./eslint-rules/no-render-functions.mts";
import { pageObjectsOwnTheirComponent } from "./eslint-rules/page-objects-own-their-component.mts";

export const architecturePlugin: TSESLint.FlatConfig.Plugin = {
  rules: {
    "class-filename-match": classFilenameMatch,
    "component-newspaper": componentNewspaper,
    "json-fixtures-in-factories": jsonFixturesInFactories,
    "name-fixture-factories": nameFixtureFactories,
    "name-functions-by-effect": nameFunctionsByEffect,
    "name-jsx-handlers": nameJsxHandlers,
    "newspaper-order": newspaperOrder,
    "no-framework-calls-in-specs": noFrameworkCallsInSpecs,
    "no-minified-json-literal": noMinifiedJsonLiteral,
    "no-real-sleeps-in-tests": noRealSleepsInTests,
    "no-render-functions": noRenderFunctions,
    "page-objects-own-their-component": pageObjectsOwnTheirComponent,
  },
};

const SOURCE = ["**/*.{ts,tsx,mts}"];
const TESTS = ["**/*.{test,spec}.{ts,tsx,mts}"];
const TEST_SUPPORT = ["**/tests/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"];
const PAGE_OBJECTS = ["**/tests/**/pages/**/*.{ts,tsx}", "**/page-objects/**/*.{ts,tsx}", "**/*.page.{ts,tsx}"];
const plugins = { arch: architecturePlugin };

export function architectureLint(): TSESLint.FlatConfig.ConfigArray {
  return [
    { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/reports/**"] },
    {
      files: [...SOURCE, "**/*.{js,jsx,mjs}"],
      languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    {
      files: SOURCE,
      plugins,
      rules: {
        "arch/name-functions-by-effect": "error",
        "arch/no-minified-json-literal": "error",
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
  ];
}

export default architectureLint();
