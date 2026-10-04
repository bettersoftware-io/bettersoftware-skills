// arch/no-framework-calls-in-specs — a spec states WHAT, a page object knows
// HOW. Testing-framework surface (testing-library imports, screen/fireEvent/
// userEvent, raw DOM queries) is confined to page modules under
// tests/**/pages/ (and the other chokepoints exempted in eslint.config.mts),
// so specs read as semantic verbs and a runner/query-library migration
// touches pages, not every spec. Doctrine:
// docs/architecture/09-test-strategy.md §"Page objects in the co-located
// tier"; design:
// docs/superpowers/specs/2026-09-01-spec-page-object-isolation-design.md.
//
// Deliberately NOT flagged:
// - Type-only imports (importKind === "type") — types don't couple runtime
//   behaviour to a library.
// - `render(...)` by name — banning the imports is sufficient; a page module
//   re-exporting a mount helper is the sanctioned path.
// - Playwright's `page` — the Playwright tiers are governed by grep gates
//   9–11 instead (this rule runs on the vitest/jest co-located tiers).
// - `within(...).getByRole(...)` chains — only the named globals are matched,
//   so a `within` call slips through the visitor; the import ban still
//   catches the file (within must be imported from a banned package), which
//   is why per-call coverage isn't needed.
//
// Known trade-off: BANNED_DOM_QUERY matches by method NAME regardless of
// receiver, so a non-DOM object with a `.closest()`/`.querySelector()` method
// would false-positive. Measured against the full baseline backlog
// (156 files): every real hit is a genuine DOM query — revisit only if a
// false positive actually appears.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "bannedImport" | "bannedGlobal" | "bannedDomQuery";
type Context = TSESLint.RuleContext<MessageIds, []>;

const BANNED_IMPORT = [
  /^@testing-library\//,
  /^@solidjs\/testing-library$/,
  /^vitest-browser-/,
];

const BANNED_GLOBAL = new Set(["screen", "fireEvent", "userEvent"]);

const BANNED_DOM_QUERY = new Set([
  "closest",
  "querySelector",
  "querySelectorAll",
]);

export const noFrameworkCallsInSpecs: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "specs call page objects; testing-framework surface lives in tests/**/pages/",
    },
    schema: [],
    messages: {
      bannedImport:
        "Specs must not import {{source}} — move the framework surface into a page module (tests/**/pages/<Thing>Page.ts) and call its semantic methods.",
      bannedGlobal:
        "Specs must not call {{object}}.* — express this as a page-object method (what, not how).",
      bannedDomQuery:
        "Raw DOM traversal ({{method}}) belongs inside a page object, behind a semantically named method.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (node.importKind === "type") {
          return;
        }

        const source = node.source.value;

        if (
          BANNED_IMPORT.some((re) => {
            return re.test(source);
          })
        ) {
          context.report({
            node,
            messageId: "bannedImport",
            data: { source },
          });
        }
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (
          node.object.type === "Identifier" &&
          BANNED_GLOBAL.has(node.object.name)
        ) {
          context.report({
            node,
            messageId: "bannedGlobal",
            data: { object: node.object.name },
          });
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        const callee = node.callee;

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          BANNED_DOM_QUERY.has(callee.property.name)
        ) {
          context.report({
            node,
            messageId: "bannedDomQuery",
            data: { method: callee.property.name },
          });
        }
      },
    };
  },
};
