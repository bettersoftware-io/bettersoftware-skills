// arch/no-browser-driver-in-specs — an end-to-end spec says WHAT happens; a
// page object knows HOW the browser is driven.
//
// `arch/no-framework-calls-in-specs` holds the same line for the tests that
// run in the test runner's own process. This rule holds it for the specs that
// drive a real browser. A spec that holds the driver writes selectors and
// waits inline, so a change to the markup is an edit to every spec, and the
// next spec copies the selector with its wait left out.
//
// SCOPED BY CONFIG to the specs of a package with the role `e2e`.
//
// Flags, in such a spec:
// - A value import from the driver's package. The spec takes `test` and
//   `expect` from the package's own fixtures file, which is where the page
//   objects are handed out.
// - A test function that takes a driver fixture: `async ({ page }) => …`.
//   Without the driver in hand nothing below can be written by accident.
// - A call that finds or reads an element: `locator`, the `getBy…` family,
//   `$`, `$$`, `waitForSelector`, `waitForFunction`, `evaluate`.
//
// Deliberately NOT flagged:
// - A type-only import: a type couples nothing at run time.
// - `expect`, `expect.poll` and `toPass`: waiting for a state is what a spec
//   is for. What it asks about comes from a page object.
// - `waitForTimeout`: `arch/no-real-sleeps-in-tests` reports it, in a spec and
//   in a page object.
//
// Known trade-off, the same as its sibling's: a call is matched by its
// method's NAME, whatever it is called on. A page object with a method named
// `locator` would be reported in the spec that calls it.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "importsDriver" | "takesDriver" | "driverCall";
type Context = TSESLint.RuleContext<MessageIds, []>;

const DRIVER_PACKAGE = /^(@playwright\/test|playwright|playwright-core)$/;

/** The fixtures that are the driver itself. A page object is built from one; a spec never holds one. */
const DRIVER_FIXTURES = new Set(["page", "context", "browser", "request", "playwright"]);

const DRIVER_CALLS = new Set([
  "locator",
  "frameLocator",
  "getByTestId",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "$",
  "$$",
  "waitForSelector",
  "waitForFunction",
  "evaluate",
  "evaluateAll",
  "evaluateHandle",
]);

type FunctionNode = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression | TSESTree.FunctionDeclaration;

function reportDriverFixtures(context: Context, node: FunctionNode): void {
  const [fixtures] = node.params;

  if (fixtures?.type !== "ObjectPattern") {
    return;
  }

  for (const property of fixtures.properties) {
    if (property.type === "Property" && property.key.type === "Identifier" && DRIVER_FIXTURES.has(property.key.name)) {
      context.report({ node: property, messageId: "takesDriver", data: { fixture: property.key.name } });
    }
  }
}

export const noBrowserDriverInSpecs: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description: "an end-to-end spec calls page objects; the browser driver stays in page objects and fixtures",
    },
    schema: [],
    messages: {
      importsDriver:
        "A spec must not import {{source}}. Take `test` and `expect` from the package's fixtures file (src/testing), which hands out the page objects.",
      takesDriver:
        "A spec must not take the `{{fixture}}` fixture: with the driver in hand, selectors and waits end up in the spec. Take a page object instead, and add the page object to the fixtures file if it is not there yet.",
      driverCall:
        "`{{method}}` finds or reads an element, which is a page object's job. Give the page object a method named for what the user sees or does, and call that.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type" || !DRIVER_PACKAGE.test(node.source.value)) {
          return;
        }

        // `import { type Page }` names only types too.
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier) => {
            return specifier.type === "ImportSpecifier" && specifier.importKind === "type";
          })
        ) {
          return;
        }

        context.report({ node, messageId: "importsDriver", data: { source: node.source.value } });
      },
      ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression): void {
        reportDriverFixtures(context, node);
      },
      FunctionExpression(node: TSESTree.FunctionExpression): void {
        reportDriverFixtures(context, node);
      },
      FunctionDeclaration(node: TSESTree.FunctionDeclaration): void {
        reportDriverFixtures(context, node);
      },
      CallExpression(node: TSESTree.CallExpression): void {
        const { callee } = node;

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          DRIVER_CALLS.has(callee.property.name)
        ) {
          context.report({ node, messageId: "driverCall", data: { method: callee.property.name } });
        }
      },
    };
  },
};
