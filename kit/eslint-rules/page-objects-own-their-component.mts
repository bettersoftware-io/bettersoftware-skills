// arch/page-objects-own-their-component — a page object CONSTRUCTS the thing it
// is named for; it does not accept one already built.
//
// `arch/no-framework-calls-in-specs` already states the doctrine: a spec says
// WHAT, a page object knows HOW. But it enforces the doctrine by banning
// testing-library imports, `screen`/`fireEvent`/`userEvent`, and raw DOM
// queries — so a page whose contract is `mount(element: ReactElement)` passes
// it cleanly while leaving the entire ARRANGE half in the spec. The type
// erases the component, so nothing about the page can encapsulate it.
//
// That is not hypothetical. `DockviewLayoutEngineDockedPage` took a
// `ReactElement`, and its spec consequently wrote all FIFTEEN props at each of
// its SIXTEEN render sites — NINE of them byte-identical every single time,
// 144 lines of pure noise in a 747-line file. Two cases differing in one prop
// could only be told apart by eye-diffing two fifteen-line blocks. The package
// was marked "migrated" for spec-purity the whole time, because the rule that
// checks it cannot see this shape.
//
// The fix is a props object: the page owns the component, the invariant props
// and the callback slots, and a case states only what it varies.
//
// SCOPED BY CONFIG to page-object directories, and UNCONDITIONAL there — no
// ignore list. An earlier cut shipped one as a "migration ledger"; that is a
// suppression whatever it is called, and the files on it were precisely the
// ones the rule existed for. All five offenders were converted instead, so a
// regression fails the build rather than being parked.
//
// ONLY THE PUBLISHED INTERFACE IS CHECKED. A page's own plumbing legitimately
// holds an element — RTL's `rerender` takes one, so a page that wraps it keeps
// a `(element: ReactElement) => void` internally. What must not accept an
// element is the CONTRACT the spec calls through, so the rule fires only on a
// parameter inside a `TSInterfaceBody`.
//
// Deliberately NOT flagged:
// - A parameter named `children`. A provider/harness page legitimately wraps
//   arbitrary children (`ThemeProviderPage`, the RN scene harness); that is
//   composition, not handing over the subject under test.
// - `ReactNode` anywhere. It is the conventional `children` type, and banning
//   it would hit every legitimate wrapper. `ReactElement`/`JSX.Element` in a
//   NAMED parameter is the shape that means "the spec built the subject".
// - Return types (`engineOf(): ReactElement` is exactly right — the page
//   BUILDING an element is the behaviour this rule wants).
//
// Known trade-off, mirroring `no-framework-calls-in-specs`'s own: a QUALIFIED
// type is matched on its right-hand name only, so a hypothetical `Foo.Element`
// parameter would false-positive. Measured against all 162 page-object files —
// every qualified `.Element` hit is `JSX.Element`. A BARE `Element` is the DOM
// interface and stays legal, which is the distinction that matters in practice.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "acceptsElement";
type Context = TSESLint.RuleContext<MessageIds, []>;

/** Unqualified, only `ReactElement` is a rendered element. A BARE `Element` is
 * the DOM interface — `UseFlipGridPage`'s `measure(el: Element)` is a page
 * measuring a node it was handed, which is exactly what a page object should
 * do. An earlier cut banned the bare name so that `JSX.Element` would match on
 * its right-hand side, and false-positived both clients' FlipGrid pages. */
const BANNED_BARE = new Set(["ReactElement"]);
/** Qualified, the right-hand name carries it: `JSX.Element`,
 * `React.ReactElement`, `React.JSX.Element`. */
const BANNED_QUALIFIED = new Set(["ReactElement", "Element"]);
const EXEMPT_PARAM = new Set(["children"]);
/** Types that describe a function rather than declare one. */
const FUNCTION_TYPE = new Set(["TSFunctionType", "TSConstructorType"]);
/** Type-parameter lists: generic arguments and generic declarations. */
const TYPE_PARAMETER_LIST = new Set([
  "TSTypeParameterInstantiation",
  "TSTypeParameterDeclaration",
]);

/** The banned name this reference resolves to, or null when it is not one. */
function bannedNameOf(typeName: TSESTree.EntityName): string | null {
  if (typeName.type === "Identifier") {
    return BANNED_BARE.has(typeName.name) ? typeName.name : null;
  }

  if (
    typeName.type === "TSQualifiedName" &&
    typeName.right.type === "Identifier"
  ) {
    return BANNED_QUALIFIED.has(typeName.right.name)
      ? typeName.right.name
      : null;
  }

  return null;
}

/** Walks out to the parameter this annotation belongs to, stopping at the
 * enclosing function-ish node. Returns the parameter node, or null when the
 * reference is not in a parameter position (a return type, a variable, a
 * generic argument). */
function parameterOf(
  ancestors: TSESTree.Node[],
  node: TSESTree.Node,
): TSESTree.Node | null {
  let child: TSESTree.Node = node;

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];

    // A generic argument or constraint (`Map<string, ReactElement>`,
    // `<T extends ReactElement>`) is not a parameter position. These two nodes
    // also carry a `params` array — of TYPES — so they are answered here,
    // before the signature check below can mistake them for a signature.
    if (TYPE_PARAMETER_LIST.has(parent.type)) {
      return null;
    }

    const params: TSESTree.Node[] | undefined =
      "params" in parent ? parent.params : undefined;

    if (Array.isArray(params) && params.includes(child)) {
      return child;
    }

    // A FUNCTION TYPE (`() => X`, `new () => X`) is part of some parameter's
    // TYPE, not a signature of its own, so climb through it. Without this,
    // `mount(element: () => JSX.Element)` read as a harmless return type and
    // slipped through — and that is Solid's natural shape, since Solid's
    // `render()` takes a function. The rule was effectively React-only until
    // this: five page objects (four Solid, one RN) held the defect unseen.
    if (FUNCTION_TYPE.has(parent.type)) {
      child = parent;
      continue;
    }

    // A real signature's own return type (`engineOf(): ReactElement`) stops
    // the walk: the page BUILDING an element is the behaviour we want.
    if (params !== undefined && !params.includes(child)) {
      return null;
    }

    child = parent;
  }

  return null;
}

/** Whether this node sits inside an interface body — the page's PUBLISHED
 * contract, as opposed to its internal plumbing. */
function insideInterfaceBody(ancestors: TSESTree.Node[]): boolean {
  return ancestors.some((node) => {
    return node.type === "TSInterfaceBody";
  });
}

export const pageObjectsOwnTheirComponent: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "a page object constructs the component it is named for; its contract takes props, never a rendered element",
    },
    schema: [],
    messages: {
      acceptsElement:
        "A page object must CONSTRUCT its component, not accept one: `{{name}}: {{type}}` leaves every prop in the spec, so the arrange half never moves behind the page. Take a props object instead, and let the page own the component, the invariant props and the callback slots.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    const sourceCode = context.sourceCode;

    return {
      TSTypeReference(node: TSESTree.TSTypeReference): void {
        if (bannedNameOf(node.typeName) === null) {
          return;
        }

        const ancestors = sourceCode.getAncestors(node);

        if (!insideInterfaceBody(ancestors)) {
          return;
        }

        const parameter = parameterOf(ancestors, node);

        if (parameter === null || parameter.type !== "Identifier") {
          return;
        }

        if (EXEMPT_PARAM.has(parameter.name)) {
          return;
        }

        context.report({
          node: parameter,
          messageId: "acceptsElement",
          data: { name: parameter.name, type: sourceCode.getText(node) },
        });
      },
    };
  },
};
