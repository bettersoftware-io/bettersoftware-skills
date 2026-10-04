import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { noFrameworkCallsInSpecs } from "./no-framework-calls-in-specs.mts";

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

ruleTester.run("no-framework-calls-in-specs", noFrameworkCallsInSpecs, {
  valid: [
    {
      name: "page-object import + semantic calls only",
      code: 'import { navTreePage } from "../pages/NavTreePage";\nconst tree = navTreePage();\ntree.toggle("Evicted (2)");\n',
    },
    {
      name: "type-only testing-library import is legal",
      code: 'import type { RenderResult } from "@testing-library/react";\n',
    },
    {
      name: "vitest itself is not banned",
      code: 'import { describe, expect, it } from "vitest";\n',
    },
    {
      name: "a local object named screen-like is not the RTL screen",
      code: "const screens = { lock: 1 };\nconst n = screens.lock;\n",
    },
  ],
  invalid: [
    {
      name: "runtime testing-library import",
      code: 'import { fireEvent, screen } from "@testing-library/react";\n',
      errors: [{ messageId: "bannedImport" }],
    },
    {
      name: "solid testing-library import",
      code: 'import { render } from "@solidjs/testing-library";\n',
      errors: [{ messageId: "bannedImport" }],
    },
    {
      name: "screen member call",
      code: 'screen.getByText("Evicted (2)");\n',
      errors: [{ messageId: "bannedGlobal" }],
    },
    {
      name: "fireEvent member call",
      code: "fireEvent.click(el);\n",
      errors: [{ messageId: "bannedGlobal" }],
    },
    {
      name: "closest/querySelector chain",
      code: 'label.closest("[data-depth]")?.querySelector("[aria-label]");\n',
      errors: [
        { messageId: "bannedDomQuery" },
        { messageId: "bannedDomQuery" },
      ],
    },
  ],
});
