import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { noBrowserDriverInSpecs } from "./no-browser-driver-in-specs.mts";

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

ruleTester.run("no-browser-driver-in-specs", noBrowserDriverInSpecs, {
  valid: [
    {
      name: "a spec that takes page objects from the fixtures file",
      code: 'import { expect, test } from "#/testing/test.ts";\n\ntest("lists a price", async ({ priceList }) => {\n  await priceList.open();\n  await expect.poll(priceList.rows).not.toEqual([]);\n});\n',
    },
    {
      name: "a type-only import of the driver",
      code: 'import type { Page } from "@playwright/test";\n\nexport type Opened = Page;\n',
    },
    {
      name: "an import that names only types, each marked inline",
      code: 'import { type Locator, type Page } from "@playwright/test";\n\nexport type Found = Locator | Page;\n',
    },
    {
      name: "a fixture that is not the driver, even beside testInfo",
      code: 'test("x", async ({ priceList, serverFeed }, testInfo) => {\n  await priceList.open();\n});\n',
    },
    {
      name: "a function whose first parameter is not destructured",
      code: "function rowsOf(page) {\n  return page.rows();\n}\n",
    },
    {
      name: "waiting for a state the page object reports",
      code: "await expect(async () => {\n  expect(await priceList.rows()).toEqual(feed.sent());\n}).toPass();\n",
    },
  ],
  invalid: [
    {
      name: "a value import of the driver",
      code: 'import { expect, test } from "@playwright/test";\n',
      errors: [{ messageId: "importsDriver" }],
    },
    {
      name: "a value beside an inline type",
      code: 'import { type Page, test } from "@playwright/test";\n',
      errors: [{ messageId: "importsDriver" }],
    },
    {
      name: "a side-effect import of the driver",
      code: 'import "playwright";\n',
      errors: [{ messageId: "importsDriver" }],
    },
    {
      name: "a test that takes the page",
      code: 'test("x", async ({ page }) => {\n  await page.goto("/");\n});\n',
      errors: [{ messageId: "takesDriver", data: { fixture: "page" } }],
    },
    {
      name: "a hook that takes the context and the browser, as a function expression",
      code: "test.beforeEach(async function prepare({ context, browser, priceList }) {\n  await priceList.open();\n});\n",
      errors: [
        { messageId: "takesDriver", data: { fixture: "context" } },
        { messageId: "takesDriver", data: { fixture: "browser" } },
      ],
    },
    {
      name: "a helper declared in the spec that takes the page",
      code: "async function openList({ page }) {\n  await page.goto('/');\n}\n",
      errors: [{ messageId: "takesDriver", data: { fixture: "page" } }],
    },
    {
      name: "a locator built in the spec",
      code: 'const row = somewhere.locator("tbody tr");\n',
      errors: [{ messageId: "driverCall", data: { method: "locator" } }],
    },
    {
      name: "a query by test id and one by role",
      code: 'await list.getByTestId(TESTIDS.priceRow).getByRole("rowheader").click();\n',
      errors: [
        { messageId: "driverCall", data: { method: "getByRole" } },
        { messageId: "driverCall", data: { method: "getByTestId" } },
      ],
    },
    {
      name: "a script run in the page",
      code: "const count = await list.evaluate((element) => element.childElementCount);\n",
      errors: [{ messageId: "driverCall", data: { method: "evaluate" } }],
    },
    {
      name: "a wait for a selector",
      code: 'await anything.waitForSelector(".row");\n',
      errors: [{ messageId: "driverCall", data: { method: "waitForSelector" } }],
    },
  ],
});
