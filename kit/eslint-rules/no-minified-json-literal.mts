// arch/no-minified-json-literal — a JSON payload pasted as a single-line string
// is opaque: its diffs are unreadable, nothing type-checks it, and a wrong
// value inside it is invisible on review. Write the object literal and derive
// the string with `JSON.stringify`.
//
// The swap is always safe. `JSON.stringify` re-emits the captured payload BYTE
// FOR BYTE (key order is insertion order), so nothing downstream — a store, a
// wire frame, a visual golden — can observe the change. It is a legibility
// change, never a data one.
//
// WHY THIS EXISTS. The `shell/layout-dockview-stacked` seed lived as an
// 880-char single-line literal, duplicated byte-for-byte across three files,
// for months. Spelling it as a literal immediately surfaced that `orientation`
// was dockview's `Orientation` ENUM rather than the bare string the blob
// carried — correct by accident, and unverifiable in the minified form.
//
// THE THRESHOLD IS MEASURED, NOT ASSUMED (surveyed 2026-09-16). Every string
// literal in the repo that parses as a JSON object/array is <= 41 chars; the
// blob this rule exists to prevent was 880. Nothing lives in between, so 120
// sits in an empirically EMPTY band and cannot fire on legitimate code.
// Re-measure before moving it — a threshold set from an assumption is how the
// visual tier's tolerance ended up wrong in both directions at once.
//
// Deliberately NOT flagged:
// - Short JSON literals (`'{"a":1}'`). Extracting those buys indirection and
//   costs locality.
// - A long string that merely LOOKS structured but does not parse — a CSS
//   blob, a template, a truncated sample. `JSON.parse` is the test, not a
//   regex, so a near-miss stays legal.
// - Scalars: `JSON.parse("12345")` succeeds, so the parsed value must be a
//   non-null object AND the text must open with `{` or `[`.
// - A template literal with interpolation — that is being composed, not
//   pasted, and has no object-literal form to prefer.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "minifiedLiteral";
type Context = TSESLint.RuleContext<MessageIds, []>;

const MAX_JSON_LITERAL = 120;

/** Whether `text` is a serialized JSON object/array rather than a scalar, a
 * near-miss, or prose that happens to be long. */
function parsesAsJsonContainer(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    const value: unknown = JSON.parse(trimmed);

    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

export const noMinifiedJsonLiteral: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "a JSON payload is spelled as an object literal + JSON.stringify, never pasted as a minified string",
    },
    schema: [],
    messages: {
      minifiedLiteral:
        "Minified JSON string literal ({{length}} chars) — write the object literal and derive the string with JSON.stringify. The emitted bytes are identical (key order is insertion order), so this is a legibility change, not a data one.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    /** Reports a string-shaped node whose contents are minified JSON. */
    function checkLiteralText(node: TSESTree.Node, text: string): void {
      if (text.length <= MAX_JSON_LITERAL || !parsesAsJsonContainer(text)) {
        return;
      }

      context.report({
        node,
        messageId: "minifiedLiteral",
        data: { length: String(text.length) },
      });
    }

    return {
      Literal(node: TSESTree.Literal): void {
        if (typeof node.value === "string") {
          checkLiteralText(node, node.value);
        }
      },
      TemplateLiteral(node: TSESTree.TemplateLiteral): void {
        // Only a template with no interpolation can be a fixed JSON payload;
        // one with expressions is being composed, not pasted.
        if (node.expressions.length === 0 && node.quasis.length === 1) {
          checkLiteralText(node, node.quasis[0].value.cooked ?? "");
        }
      },
    };
  },
};
