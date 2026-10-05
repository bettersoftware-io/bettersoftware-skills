// The ESLint rules that need type information, as a block a config spreads
// after its other blocks:
//
//   import { typedLint } from "./eslint.typed.base.mts";
//   export default [...base, ...typedLint()];
//
// This file belongs to the add-on: an update replaces it. The project's rules
// go in `tools/strict-lint/eslint.config.mts`.
//
// Types come from TypeScript's project service: each file is read with the
// `tsconfig.json` nearest to it, the one its package is typechecked with. A
// file that no `tsconfig.json` includes is a parsing error, not a silent
// pass: it is a file `pnpm typecheck` does not check either. The `.mts` files
// at the project root have no `tsconfig.json` beside them and are read with
// `tsconfig.tooling.json`.

import type { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";

/** Installed tooling and generated folders. Nothing in them is the project's to fix. */
export const NOT_JUDGED: string[] = [
  "tools/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/reports/**",
  "**/.turbo/**",
];

export const TYPED_RULES: TSESLint.FlatConfig.Rules = {
  // A promise nobody waits for: its rejection is unhandled, and the code after
  // it runs before the work is done.
  "@typescript-eslint/no-floating-promises": "error",
  // A promise where the caller does not wait for one: an `async` callback
  // given to `forEach` or to an event handler, a promise tested in an `if`
  // (always true).
  "@typescript-eslint/no-misused-promises": "error",
  // A `switch` over a union names every member, so a new member is a lint
  // error at each switch and not a case that silently does nothing. A
  // `default` branch counts as naming the rest.
  "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
};

export function typedLint(): TSESLint.FlatConfig.ConfigArray {
  return [
    { ignores: NOT_JUDGED },
    {
      files: ["**/*.{ts,tsx,mts}"],
      plugins: { "@typescript-eslint": tseslint.plugin },
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          projectService: { allowDefaultProject: ["*.mts"], defaultProject: "tsconfig.tooling.json" },
          // The check is run from the project root (`pnpm lint:types`).
          tsconfigRootDir: process.cwd(),
        },
      },
      rules: TYPED_RULES,
    },
  ];
}
