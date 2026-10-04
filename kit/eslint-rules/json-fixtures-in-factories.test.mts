import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { jsonFixturesInFactories } from "./json-fixtures-in-factories.mts";

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

/** An object literal spanning well over MAX_INLINE_LINES (10). */
const WIDE_OBJECT = `{
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
  f: 6,
  g: 7,
  h: 8,
  i: 9,
  j: 10,
  k: 11,
}`;

/** Exactly at the 10-line bar — must stay legal (the ban is > MAX). */
const AT_THRESHOLD_OBJECT = `{
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
  f: 6,
  g: 7,
  h: 8,
}`;

ruleTester.run("json-fixtures-in-factories", jsonFixturesInFactories, {
  valid: [
    {
      name: "a small inline JSON.stringify stays inline",
      code: `const msg = JSON.stringify({ type: "PRICE", seq: 1 });\n`,
    },
    {
      name: "an object exactly at the threshold stays legal",
      code: `const blob = JSON.stringify(${AT_THRESHOLD_OBJECT});\n`,
    },
    {
      name: "JSON.stringify over a NAMED object is the sanctioned shape at any size",
      code: `const layout = ${WIDE_OBJECT};\nexport const blob = JSON.stringify(layout);\n`,
    },
    {
      name: "a large fixture returned from a create* factory is the sanctioned factory shape",
      code: `function createStackedBlob() {\n  return JSON.stringify(${WIDE_OBJECT});\n}\n`,
    },
    {
      name: "JSON.stringify with no argument is not a fixture",
      code: `const s = JSON.stringify();\n`,
    },
    {
      name: "a same-named method on another object is not JSON.stringify",
      code: `const s = codec.stringify(${WIDE_OBJECT});\n`,
    },
  ],
  invalid: [
    {
      name: "a large inline JSON.stringify in a case body must be extracted",
      code: `it("x", () => {\n  const blob = JSON.stringify(${WIDE_OBJECT});\n});\n`,
      errors: [{ messageId: "inlineFixture" }],
    },
    {
      name: "a large inline JSON.stringify at module scope must be extracted",
      code: `const blob = JSON.stringify(${WIDE_OBJECT});\n`,
      errors: [{ messageId: "inlineFixture" }],
    },
    {
      name: "a bare-noun fixture factory must be renamed to create*",
      code: `function stackedRatesAndBlotterBlob() {\n  return JSON.stringify(${WIDE_OBJECT});\n}\n`,
      errors: [{ messageId: "factoryNaming" }],
    },
    {
      name: "a make*-prefixed factory is still not create*",
      code: `function makeStackedBlob() {\n  return JSON.stringify(${WIDE_OBJECT});\n}\n`,
      errors: [{ messageId: "factoryNaming" }],
    },
    {
      name: "an arrow-bound factory is not a named declaration, so it reads as inline",
      code: `const createBlob = () => {\n  return JSON.stringify(${WIDE_OBJECT});\n};\n`,
      errors: [{ messageId: "inlineFixture" }],
    },
    {
      name: "a named function that does not RETURN the payload is not a factory — a void serializer is reported as inline, never renamed",
      code: `function serializeLayout() {\n  store.save(JSON.stringify(${WIDE_OBJECT}));\n}\n`,
      errors: [{ messageId: "inlineFixture" }],
    },
  ],
});
