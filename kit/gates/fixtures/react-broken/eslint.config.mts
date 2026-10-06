import { architectureLint } from "../../../eslint.config.mts";

// Each block below sets a rule the kit has already set for the same files.
// ESLint keeps one set of options per rule, so the kit's are gone.
export default [
  { ignores: ["packages/client-unlinted/**"] },
  ...architectureLint(),
  {
    files: ["packages/react-bindings/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "lodash", message: "Use the standard library." }] }],
    },
  },
  {
    files: ["packages/client-loose/src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "no-restricted-imports": ["warn", { paths: [{ name: "react", importNames: ["default", "useMemo", "useCallback", "memo"] }] }],
      "no-restricted-syntax": ["error", { selector: "WithStatement", message: "No with." }],
    },
  },
];
