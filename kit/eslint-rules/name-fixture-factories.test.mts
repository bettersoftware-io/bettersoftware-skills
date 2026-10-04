import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { nameFixtureFactories } from "./name-fixture-factories.mts";

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

ruleTester.run("name-fixture-factories", nameFixtureFactories, {
  valid: [
    {
      name: "the sanctioned shape",
      code: "function createSampleTree() {\n  return [{ id: 'all' }];\n}\n",
    },
    {
      name: "createFake* keeps the test-double vocabulary",
      code: "function createFakePort() {\n  return { send() {} };\n}\n",
    },
    {
      name: "createStub* likewise",
      code: "function createStubPresenters() {\n  return { blotter: null };\n}\n",
    },
    {
      name: "a factory taking parameters is fine once it is create*",
      code: "function createSingleLeafBlob(leaves) {\n  return { grid: leaves };\n}\n",
    },
    {
      name: "an ACTION that returns something is not a fixture — it has more than one statement",
      code: "function mountPillWorkspace() {\n  render(<App />);\n  return { root: screen.root };\n}\n",
    },
    {
      name: "a hook probe is likewise multi-statement",
      code: "function useTicketSubmission() {\n  const [x] = useState(0);\n  return { x };\n}\n",
    },
    {
      name: "a zero-param function returning a CALL is not a literal fixture",
      code: "function harness() {\n  return buildIt();\n}\n",
    },
    {
      name: "a zero-param function returning a scalar is not a fixture",
      code: "function count() {\n  return 3;\n}\n",
    },
    {
      name: "a noun-named function WITH parameters is out of arm 2's reach (documented limit)",
      code: "function quoteFor(ccy) {\n  return { ccy };\n}\n",
    },
    {
      name: "a lowercase-after-prefix name is not a factory synonym (`maker`, not `makeX`)",
      code: "function maker(x) {\n  return doThing(x);\n}\n",
    },
  ],
  invalid: [
    {
      name: "make* is a factory synonym",
      code: "function makeHarness() {\n  return { a: 1 };\n}\n",
      errors: [{ messageId: "factorySynonym" }],
    },
    {
      name: "build* likewise, and at any arity",
      code: "function buildDeps(ports, clock) {\n  const x = 1;\n  return { ports, clock, x };\n}\n",
      errors: [{ messageId: "factorySynonym" }],
    },
    {
      name: "fake* maps to createFake*, not create*",
      code: "function fakeReferenceData() {\n  return { pairs: [] };\n}\n",
      errors: [{ messageId: "factorySynonym" }],
    },
    {
      name: "stub* maps to createStub*",
      code: "function stubWorkflow(deps) {\n  return { run: () => deps };\n}\n",
      errors: [{ messageId: "factorySynonym" }],
    },
    {
      name: "a bare-noun single-return object literal is a fixture",
      code: "function poppedBlob() {\n  return { grid: {} };\n}\n",
      errors: [{ messageId: "bareNoun" }],
    },
    {
      name: "a bare-noun single-return ARRAY literal is a fixture too",
      code: "function sampleTree() {\n  return [{ id: 'all' }];\n}\n",
      errors: [{ messageId: "bareNoun" }],
    },
  ],
});
