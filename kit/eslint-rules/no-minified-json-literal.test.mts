import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { noMinifiedJsonLiteral } from "./no-minified-json-literal.mts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/** A minified JSON payload comfortably over MAX_JSON_LITERAL (120). */
const LONG_BLOB = JSON.stringify({
  grid: {
    root: { type: "branch", data: ["a", "b", "c"], size: 700 },
    width: 1260,
    height: 700,
    orientation: "HORIZONTAL",
  },
  panels: { rates: { id: "rates" }, blotter: { id: "blotter" } },
  rtcBlobVersion: 2,
});

/** Just under the 120-char bar, to pin that the boundary is inclusive-safe. */
const SHORT_BLOB = JSON.stringify({ id: "g-1", views: ["rates", "blotter"] });

ruleTester.run("no-minified-json-literal", noMinifiedJsonLiteral, {
  valid: [
    {
      name: "a short JSON literal stays legal — extracting it would cost locality",
      code: `const seed = '{"a":1,"b":2}';\n`,
    },
    {
      name: "a JSON literal under the measured threshold stays legal",
      code: `const seed = ${JSON.stringify(SHORT_BLOB)};\n`,
    },
    {
      name: "a long string that does not parse as JSON is not a fixture",
      code: `const css = "${"x".repeat(200)}";\n`,
    },
    {
      name: "a long string opening with a brace but not parsing stays legal",
      code: `const tpl = "{ not json, just ${"y".repeat(150)} }";\n`,
    },
    {
      name: "a long JSON SCALAR is not a container",
      code: `const n = "  1234567890  ";\n`,
    },
    {
      name: "a template literal WITH interpolation is composed, not pasted",
      code: `const blob = \`{"id":\${id},"name":"\${name}"}\`;\n`,
    },
    {
      name: "the sanctioned shape — an object literal plus JSON.stringify",
      code: `const layout = { grid: { root: null } };\nexport const blob = JSON.stringify(layout);\n`,
    },
  ],
  invalid: [
    {
      name: "a minified JSON object literal is reported with its length",
      code: `const blob = ${JSON.stringify(LONG_BLOB)};\n`,
      errors: [{ messageId: "minifiedLiteral" }],
    },
    {
      name: "a minified JSON ARRAY payload is reported too",
      code: `const rows = ${JSON.stringify(JSON.stringify([SHORT_BLOB, SHORT_BLOB, SHORT_BLOB]))};\n`,
      errors: [{ messageId: "minifiedLiteral" }],
    },
    {
      name: "a minified payload in a no-substitution template is reported",
      code: `const blob = \`${LONG_BLOB}\`;\n`,
      errors: [{ messageId: "minifiedLiteral" }],
    },
  ],
});
