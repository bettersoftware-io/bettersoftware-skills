import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { classFilenameMatch } from "./class-filename-match.mts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: "module",
  },
});

ruleTester.run("class-filename-match", classFilenameMatch, {
  valid: [
    {
      name: "exported class matches filename",
      filename: "AnalyticsPresenter.ts",
      code: "export class AnalyticsPresenter {}\n",
    },
    {
      name: "testHelpers sub-extension: first segment matches the class",
      filename: "MockWebSocket.testHelpers.ts",
      code: "export class MockWebSocket {}\n",
    },
    {
      name: "abstract class matches filename",
      filename: "MountedComponent.ts",
      code: "export abstract class MountedComponent {}\n",
    },
    {
      name: "non-exported class that matches is fine",
      filename: "MemoryStorage.ts",
      code: "class MemoryStorage {}\n",
    },
    {
      name: ".tsx file with a matching class",
      filename: "WsAdapter.tsx",
      code: "export class WsAdapter {}\n",
    },
    {
      name: "nested class is ignored (not top-level)",
      filename: "WsAdapter.test.ts",
      code: "it('x', () => {\n  class Local {}\n  return Local;\n});\n",
    },
    {
      name: "file with no class is never flagged",
      filename: "helpers.ts",
      code: "export function f(): number {\n  return 1;\n}\n",
    },
  ],
  invalid: [
    {
      name: "non-exported top-level double mismatches its test filename",
      filename: "WsAdapter.test.ts",
      code: "class MockWebSocket {}\n",
      errors: [
        {
          messageId: "mismatch",
          data: { className: "MockWebSocket", base: "WsAdapter" },
        },
      ],
    },
    {
      name: "exported class mismatches a plural module filename",
      filename: "MetricsPresenters.ts",
      code: "export class LatencyPresenter {}\n",
      errors: [
        {
          messageId: "mismatch",
          data: { className: "LatencyPresenter", base: "MetricsPresenters" },
        },
      ],
    },
    {
      name: "camelCase module name does not match its class",
      filename: "creditReferenceDataSimulator.ts",
      code: "export class InstrumentSimulator {}\n",
      errors: [
        {
          messageId: "mismatch",
          data: {
            className: "InstrumentSimulator",
            base: "creditReferenceDataSimulator",
          },
        },
      ],
    },
  ],
});
