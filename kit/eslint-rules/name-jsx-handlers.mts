// arch/name-jsx-handlers — a JSX event slot receives a NAMED handler, never an
// inline function expression.
//
// docs/handler-naming.md: an inline arrow is maximally coupled to its one
// call site and hides its effect behind plumbing; extract and name it —
// `onChange={changeNotional}` over `onChange={(e) => { … }}` — even when the
// body is one line. This rule closes the enforcement gap that
// arch/name-functions-by-effect documents ("the rule cannot enforce
// extraction — it only sees the identifier a handler is already bound to").
//
// Flags: an on[A-Z]* JSX attribute (or Solid's namespaced `on:*`) whose value
// is an ArrowFunctionExpression or FunctionExpression.
//
// Deliberately NOT flagged:
// - Named references and member references (`onClick={submitTicket}`,
//   `onClick={vm.submitTicket}`) — the prescribed form.
// - Call results (`onClick={selectTab(id)}`) — the factory carries the name.
// - Non-handler props (`renderItem={…}`, `children={…}`) — only the on-slot
//   naming convention marks an attribute as an event slot.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "inlineHandler";
type Context = TSESLint.RuleContext<MessageIds, []>;

type InlineFunction =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression;

const HANDLER_ATTR = /^on[A-Z]/;

function isHandlerAttribute(attr: TSESTree.JSXAttribute): boolean {
  if (attr.name.type === "JSXIdentifier") {
    return HANDLER_ATTR.test(attr.name.name);
  }

  // Solid's delegated-vs-native syntax: on:click / oncapture:click.
  if (attr.name.type === "JSXNamespacedName") {
    return /^on(capture)?$/.test(attr.name.namespace.name);
  }

  return false;
}

export const nameJsxHandlers: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "JSX event slots take a named handler, never an inline function — the handler's name must state its effect (docs/handler-naming.md)",
    },
    schema: [],
    messages: {
      inlineHandler:
        "Extract this inline {{kind}} into a named handler whose name states its effect — e.g. onChange={changeNotional}. See docs/handler-naming.md.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    return {
      "JSXAttribute > JSXExpressionContainer > :matches(ArrowFunctionExpression, FunctionExpression)"(
        node: InlineFunction,
      ): void {
        const attr = node.parent.parent;

        if (attr?.type !== "JSXAttribute" || !isHandlerAttribute(attr)) {
          return;
        }

        context.report({
          node,
          messageId: "inlineHandler",
          data: {
            kind:
              node.type === "ArrowFunctionExpression"
                ? "arrow"
                : "function expression",
          },
        });
      },
    };
  },
};
