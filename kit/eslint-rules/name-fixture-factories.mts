// arch/name-fixture-factories — a test's fixture factory is named `create…`.
//
// `docs/handler-naming.md` requires a function's name to state its EFFECT. A
// bare noun (`poppedBlob()`, `sampleTree()`, `legacyRailBlob()`) names a THING,
// so it reads as a constant until you notice the parens — which matters
// precisely because a factory returns a FRESH value per call. Sharing one
// constant instead would couple cases through mutable state, and the name is
// what tells a reader which they are getting.
//
// `arch/name-functions-by-effect` cannot catch this. That rule works from a
// BLOCKLIST of bad prefixes (`on*`, `handle*`, a vacuous-verb set) and passes
// everything else, so a noun-named function sails through it. Requiring a verb
// instead would need a verb LEXICON, which is unbounded and would fail the
// build on the first word nobody thought of. This rule takes the two shapes
// that need no lexicon.
//
// ARM 1 — FACTORY-SYNONYM PREFIXES. `make*`, `build*`, `fake*` and `stub*` are
// unambiguously factory prefixes; nothing named that way is anything else. They
// map to `create*` (and `createFake*` / `createStub*`, which keep the xUnit
// test-double vocabulary rather than flattening it). Decidable from the name
// alone, so it holds however many parameters the factory takes.
//
// ARM 2 — NOUN-NAMED FIXTURES. A zero-parameter function whose entire body is
// a single `return` of an object or array literal is a fixture factory and
// nothing else. The SINGLE-STATEMENT requirement is what makes this safe: it is
// the discriminator that separates a fixture from an ACTION that happens to
// return something. Measured against the tree, the broader "returns an
// object/array anywhere in the body" test caught seven genuine action helpers
// and hooks — `mountPillWorkspace`, `wireAppToInspector`, `renderModal`,
// `useTicketSubmission` … — every one of them correctly named already. The
// single-statement form caught none of them.
//
// NO IGNORE LIST. Every fixture factory in the repo was renamed rather than
// parked; a suppression list would make the rule's live coverage exactly the
// set of files that were already fine.
//
// KNOWN LIMIT, stated rather than hidden: arm 2 sees only the single-return
// shape, so a noun-named factory that builds up locals before returning
// (`function poppedBlob() { const x = …; return { … } }`) is NOT caught. There
// is no syntactic discriminator that separates those from actions without the
// verb lexicon this rule is designed to avoid. Arm 1 still covers them whenever
// they carry a factory-synonym prefix.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "factorySynonym" | "bareNoun";
type Context = TSESLint.RuleContext<MessageIds, []>;

interface PrefixFix {
  prefix: string;
  replacement: string;
}

const PREFIX_FIX: PrefixFix[] = [
  { prefix: "make", replacement: "create" },
  { prefix: "build", replacement: "create" },
  { prefix: "fake", replacement: "createFake" },
  { prefix: "stub", replacement: "createStub" },
];

const FACTORY_PREFIX = "create";

/** `makeFoo` -> `createFoo`, `fakePort` -> `createFakePort`, else null. */
function prefixRenameOf(name: string): string | null {
  for (const { prefix, replacement } of PREFIX_FIX) {
    if (
      name.startsWith(prefix) &&
      name.length > prefix.length &&
      name[prefix.length] === name[prefix.length].toUpperCase() &&
      name[prefix.length] !== name[prefix.length].toLowerCase()
    ) {
      return replacement + name.slice(prefix.length);
    }
  }

  return null;
}

/** Whether the body is exactly `return <object|array literal>;` — the shape a
 * fixture has and an action does not. */
function isSingleLiteralReturn(node: TSESTree.FunctionDeclaration): boolean {
  const statements = node.body?.body ?? [];

  if (statements.length !== 1 || statements[0].type !== "ReturnStatement") {
    return false;
  }

  const returned = statements[0].argument;

  return (
    returned !== null &&
    returned !== undefined &&
    (returned.type === "ObjectExpression" ||
      returned.type === "ArrayExpression")
  );
}

export const nameFixtureFactories: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "a test's fixture factory is named create… — never a bare noun, make*, build*, fake* or stub*",
    },
    schema: [],
    messages: {
      factorySynonym:
        "`{{name}}` is a factory — name it `{{suggestion}}`. This repo spells fixture factories `create…` so the name states its effect (docs/handler-naming.md); `createFake…`/`createStub…` keep the test-double vocabulary.",
      bareNoun:
        "`{{name}}` returns a fresh fixture, so name it `{{suggestion}}`. A bare noun names a THING and reads as a constant until you notice the parens — which matters because each call returns a NEW value.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    /** Reports `node.id` under `messageId` unless it is already a factory. */
    function check(node: TSESTree.FunctionDeclaration): void {
      const id = node.id;

      if (id === null || id === undefined || id.type !== "Identifier") {
        return;
      }

      const name = id.name;

      if (name.startsWith(FACTORY_PREFIX)) {
        return;
      }

      const renamed = prefixRenameOf(name);

      if (renamed !== null) {
        context.report({
          node: id,
          messageId: "factorySynonym",
          data: { name, suggestion: renamed },
        });

        return;
      }

      if (isSingleLiteralReturn(node)) {
        context.report({
          node: id,
          messageId: "bareNoun",
          data: {
            name,
            suggestion: FACTORY_PREFIX + name[0].toUpperCase() + name.slice(1),
          },
        });
      }
    }

    return {
      FunctionDeclaration(node: TSESTree.FunctionDeclaration): void {
        // Arm 2 is zero-parameter only; arm 1 holds at any arity, so the
        // parameter test lives inside `isSingleLiteralReturn`'s branch.
        if (node.params.length === 0 || prefixRenameOf(node.id?.name ?? "")) {
          check(node);
        }
      },
    };
  },
};
