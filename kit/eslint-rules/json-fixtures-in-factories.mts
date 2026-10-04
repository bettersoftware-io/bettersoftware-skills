// arch/json-fixtures-in-factories — a test's ARRANGEMENT must not drown its
// SUBJECT. When the fixture is thirty lines and the assertion is five, what
// the case actually pins is invisible, and two cases that differ in one value
// can only be told apart by eye-diffing two walls of JSON.
//
// Two shapes are banned:
//
// 1. A LARGE INLINE `JSON.stringify({ … })`. Bind the object to a named
//    constant, or return it from a factory declared BELOW the cases
//    (arch/newspaper-order), so each case writes only what it varies. Three
//    cases in dockBlob.test.ts spent 88 lines of blob to express a difference
//    of "which leaves, at which sizes" — a factory reduced that to three
//    lines and made the difference the only thing written down.
//
// 2. A FIXTURE FACTORY NOT NAMED `create*`. docs/handler-naming.md requires a
//    function's name to state its EFFECT; a bare noun (`stackedFxBlob()`)
//    names a thing and reads as a constant until you notice the parens. That
//    matters precisely because a factory returns a FRESH value per call —
//    sharing one constant instead would couple cases through mutable state,
//    and the name is what tells a reader which they are getting.
//
// SCOPED TO TESTS BY CONFIG, deliberately. "Fixture factory" is a concept that
// only exists in a test; production code that builds JSON is a serializer, and
// naming it for its effect means `serializeLayout`, not `createLayout`. An
// earlier repo-wide draft of this rule flagged exactly that function — the
// rule was wrong, not the code. The `directlyReturned` guard below is a second,
// independent line of defence on the same point: `serializeLayout` returns
// void, so it could never be a factory whatever its scope.
//
// THE THRESHOLD IS MEASURED, NOT ASSUMED (surveyed 2026-09-16). Inline
// `JSON.stringify({ … })` spans in this repo are bimodal — four at >= 15
// lines, eighteen at <= 6, and NOTHING in 7-14. MAX_INLINE_LINES sits in that
// gap, so there is no borderline case to argue about. Re-measure before moving
// it rather than re-guessing.
//
// Deliberately NOT flagged:
// - `JSON.stringify(someIdentifier)` at ANY size. The object is already bound
//   to a name, which is the sanctioned shape (see the stackedFxBlob fixtures)
//   — only an inline object literal is the smell.
// - Short inline objects (`JSON.stringify({ type: "PRICE", seq: 1 })`).
// - A factory whose name merely STARTS with `create`; this rule pins the
//   prefix, and arch/name-functions-by-effect governs the rest of the name.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "inlineFixture" | "factoryNaming";
type Context = TSESLint.RuleContext<MessageIds, []>;

type FunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const MAX_INLINE_LINES = 10;
const FACTORY_PREFIX = "create";

/** The nearest enclosing function, or null at module scope. */
function enclosingFunctionOf(ancestors: TSESTree.Node[]): FunctionNode | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return node;
    }
  }

  return null;
}

export const jsonFixturesInFactories: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "large JSON fixtures live in a named create* factory, not inline in a case body",
    },
    schema: [],
    messages: {
      inlineFixture:
        "Inline JSON.stringify over a {{lines}}-line object literal buries the test's subject. Bind the object to a named constant, or return it from a `{{prefix}}…` fixture factory declared below the cases (newspaper order).",
      factoryNaming:
        "A fixture factory must be named `{{prefix}}…` — `{{name}}` is a bare noun, so it reads as a constant until you notice the parens. A function's name states its effect (docs/handler-naming.md), and a factory's effect is producing a FRESH value per call.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    const sourceCode = context.sourceCode;

    return {
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;
        const isStringify =
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          callee.object.name === "JSON" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "stringify";

        if (!isStringify) {
          return;
        }

        const [argument] = node.arguments;

        // An already-named object is the sanctioned shape at any size.
        if (argument === undefined || argument.type !== "ObjectExpression") {
          return;
        }

        const lines = argument.loc.end.line - argument.loc.start.line + 1;

        if (lines <= MAX_INLINE_LINES) {
          return;
        }

        const enclosing = enclosingFunctionOf(sourceCode.getAncestors(node));
        const directlyReturned = node.parent.type === "ReturnStatement";
        const isFactory =
          directlyReturned &&
          enclosing !== null &&
          enclosing.type === "FunctionDeclaration" &&
          enclosing.id !== null;

        if (!isFactory) {
          context.report({
            node: argument,
            messageId: "inlineFixture",
            data: { lines: String(lines), prefix: FACTORY_PREFIX },
          });

          return;
        }

        // `isFactory` already established a named declaration; the compiler
        // does not carry that through the alias to the `id` property.
        const factoryId = enclosing.id;

        if (factoryId === null) {
          return;
        }

        if (!factoryId.name.startsWith(FACTORY_PREFIX)) {
          context.report({
            node: factoryId,
            messageId: "factoryNaming",
            data: { name: factoryId.name, prefix: FACTORY_PREFIX },
          });
        }
      },
    };
  },
};
