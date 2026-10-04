// arch/newspaper-order — in a test file the TESTS are the lede. Supporting
// declarations sit below them, so a reader meets what the file asserts before
// the machinery that makes it possible.
//
// TWO ARMS, deliberately different in strength:
//
// 1. HELPERS AND TYPES — always on, repo-wide. Function declarations, type
//    aliases, interfaces and the hoisted `vi.mock`/`jest.mock` calls are moved
//    below the tests. All four are safe to move UNCONDITIONALLY: declarations
//    hoist, types are erased, and both runners hoist their mock factories above
//    the imports, so physical position cannot change behaviour.
//
// 2. FIXTURES — module-level (and describe-level) `const`/`let` fixtures join
//    the move, but NOT unconditionally, because a `const` does NOT hoist:
//    Vitest and Jest both run every `describe` callback synchronously at
//    COLLECTION time, so a fixture a describe body reads would land in the
//    temporal dead zone and kill the file at import. The rule therefore moves a
//    fixture only when every reference to it is DEFERRED — read after module
//    evaluation finishes — following helper calls transitively to decide (see
//    isMovableFixture / isDeferredReference). A `jest.mock`/`vi.mock` factory
//    is NOT a deferred caller: both are hoisted above the imports, so a fixture
//    a factory closes over stays put. Anything it cannot prove deferred is left
//    exactly where it is.
//
// The fixtures arm was introduced as a per-package opt-in (`{ fixtures: true }`)
// because it began as a burn-down — 493 declarations across ~300 test files.
// Once every package was covered the option was removed and the behaviour made
// the default: an option only ever set to `true` is dead configuration.
//
// ONE HAZARD THE AUTOFIX CANNOT SEE: TypeScript control-flow narrowing. A
// `const` annotated with a UNION is narrowed by its initialiser, and because a
// const cannot be reassigned that narrowing is preserved into closures — but
// only for references that appear AFTER the declaration. Move the declaration
// below the tests and every `it` that read the narrowed member now sees the
// declared union instead:
//
//   const TREND: Drawing = { kind: "trendline", a, b };   // narrowed to trendline
//   it("...", () => { TREND.b });                         // fine BEFORE the move
//                                                         // TS2339 AFTER it
//
// This is a TYPE break, never a runtime one, and `pnpm typecheck` catches it
// immediately — it surfaced in exactly one file (motion-core's drawingScene
// fixtures) across the whole repo. The fix is `satisfies` rather than an
// annotation: `const TREND = { … } satisfies Drawing` keeps the conformance
// check while letting inference hold the narrow literal type, so the
// declaration's POSITION stops mattering. The rule is syntactic and has no
// types, so it cannot pre-empt this; run typecheck after a bulk --fix.
//
// class/enum/`vi.doMock`/`jest.doMock`/`vi.hoisted` always stay put — the first
// two because a class is not hoisted the way a function is and moving it can
// break `extends`, the rest because they run in place by design.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "moveDown";
type Context = TSESLint.RuleContext<MessageIds, []>;

/** A statement of a Program or of a `describe` block body. */
type Stmt = TSESTree.ProgramStatement;

interface Violations {
  violations: Stmt[];
  before: TSESTree.Node | null;
}

const PRIMARY_CALLERS = new Set([
  "describe",
  "it",
  "test",
  "suite",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
]);

/** Whether a value met while walking a node's own properties is itself an AST
 * node (anything carrying a string `type`). */
function isNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function baseCalleeName(callee: TSESTree.Node): string | null {
  let node: TSESTree.Node = callee;

  while (node) {
    if (node.type === "MemberExpression") {
      node = node.object;
    } else if (node.type === "CallExpression") {
      node = node.callee;
    } else if (node.type === "TaggedTemplateExpression") {
      node = node.tag;
    } else {
      break;
    }
  }

  return node && node.type === "Identifier" ? node.name : null;
}

function isPrimary(stmt: Stmt): boolean {
  if (stmt.type !== "ExpressionStatement") {
    return false;
  }

  const expr = stmt.expression;

  if (expr?.type !== "CallExpression") {
    return false;
  }

  const name = baseCalleeName(expr.callee);
  return name !== null && PRIMARY_CALLERS.has(name);
}

// `vi.mock`/`vi.unmock` (Vitest) and `jest.mock`/`jest.unmock` (Jest) are all
// hoisted above the imports by their respective transforms, so their physical
// position is irrelevant to behaviour and they can sit below the tests like any
// other helper. The non-hoisted variants (`vi.doMock`, `jest.doMock`) run in
// place and must NOT be moved — they are deliberately excluded here.
function isMovableMock(stmt: Stmt): boolean {
  if (stmt.type !== "ExpressionStatement") {
    return false;
  }

  const expr = stmt.expression;

  if (expr?.type !== "CallExpression") {
    return false;
  }

  const callee = expr.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    (callee.object.name === "vi" || callee.object.name === "jest") &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "mock" || callee.property.name === "unmock")
  );
}

// Callbacks these receive are registered now and RUN LATER, after the module has
// finished evaluating. `describe` is deliberately NOT here: its callback runs
// SYNCHRONOUSLY at collection, so anything it dereferences is read while the
// module is still evaluating.
const DEFERRED_CALLERS = new Set([
  "it",
  "test",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
]);

/** True when this identifier is only ever read after module evaluation finishes
 * — i.e. it sits inside a callback handed to `it`/`test`/a hook. Walking out to
 * Program without crossing one of those boundaries means the read happens
 * DURING evaluation (top-level code, or a `describe` body at collection time).
 *
 * Indirection through helpers is followed: a read inside a function declaration
 * is deferred exactly when every call to that function is itself deferred,
 * recursively. Without this the check is far too weak to be useful — fixtures
 * are overwhelmingly reached through a `base()`/`seed()` helper rather than
 * named in the `it` body.
 *
 * Nesting depth is deliberately NOT part of the test. The helpers that matter
 * here are declared INSIDE a `describe` body, not at module level, and an
 * earlier cut that only followed top-level declarations moved 2 of the 8
 * fixtures in `createDockEngine.test.ts` while leaving every prominent one in
 * place. `seen` breaks mutual recursion; a cycle no eager caller enters is by
 * definition never evaluated at module time. */
function isDeferredReference(
  identifier: TSESTree.Node,
  sourceCode: TSESLint.SourceCode,
  seen: Set<TSESTree.FunctionDeclaration>,
): boolean {
  let node: TSESTree.Node | undefined = identifier;

  while (node && node.type !== "Program") {
    const parent: TSESTree.Node | undefined = node.parent;

    if (
      (node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression") &&
      parent?.type === "CallExpression" &&
      parent.arguments.includes(node)
    ) {
      const name = baseCalleeName(parent.callee);

      if (name !== null && DEFERRED_CALLERS.has(name)) {
        return true;
      }
    }

    if (node.type === "FunctionDeclaration") {
      return isCalledOnlyWhenDeferred(node, sourceCode, seen);
    }

    node = parent;
  }

  return false;
}

/** True when nothing calls this helper during module evaluation, so a binding it
 * closes over is not read then either. A helper merely MENTIONED at
 * top level (`[build]`, `register(build)`) fails here: the reference is not
 * inside a deferred callback, and where the value ends up is unknowable. */
function isCalledOnlyWhenDeferred(
  fnDecl: TSESTree.FunctionDeclaration,
  sourceCode: TSESLint.SourceCode,
  seen: Set<TSESTree.FunctionDeclaration>,
): boolean {
  if (seen.has(fnDecl)) {
    return true;
  }

  seen.add(fnDecl);

  return sourceCode.getDeclaredVariables(fnDecl).every((variable) => {
    return variable.references.every((ref) => {
      return isDeferredReference(ref.identifier, sourceCode, seen);
    });
  });
}

/** `vi.hoisted`/`jest.hoisted` initialisers must stay above the mocks they feed,
 * so a binding holding one is never moved — the same exclusion the non-hoisted
 * `vi.doMock` gets above. */
function holdsHoistedCall(stmt: TSESTree.VariableDeclaration): boolean {
  return stmt.declarations.some((d) => {
    const init = d.init;
    return (
      init?.type === "CallExpression" &&
      init.callee.type === "MemberExpression" &&
      init.callee.object.type === "Identifier" &&
      (init.callee.object.name === "vi" ||
        init.callee.object.name === "jest") &&
      init.callee.property.type === "Identifier" &&
      init.callee.property.name === "hoisted"
    );
  });
}

/** True when a module-level `const`/`let` can be moved below the tests WITHOUT
 * changing behaviour.
 *
 * Unlike a function declaration, a `const` is not hoisted: moving one below a
 * `describe` that reads it during collection puts that read in the temporal
 * dead zone, and the file dies at import. So this is gated on every reference
 * being DEFERRED — read only after module evaluation completes.
 *
 * The check is deliberately CONSERVATIVE and lexical. A reference reached
 * through a top-level helper (`it(... build() ...)` where `build()` closes over
 * the binding) is reported as NOT movable, even though it usually would be,
 * because proving it needs a call graph: the same helper could equally be
 * invoked from a `describe` body. Skipping a safe move costs nothing; making an
 * unsafe one breaks the suite at import time. */
function isMovableFixture(
  stmt: Stmt,
  sourceCode: TSESLint.SourceCode,
): boolean {
  if (stmt.type !== "VariableDeclaration") {
    return false;
  }

  if (stmt.kind !== "const" && stmt.kind !== "let") {
    return false;
  }

  if (holdsHoistedCall(stmt)) {
    return false;
  }

  return sourceCode.getDeclaredVariables(stmt).length > 0;
}

/** The statement in `candidates` whose source range encloses this node, or null.
 * Used to tell "read by another fixture's initialiser" from "read by live code". */
function enclosingCandidate(
  node: TSESTree.Node,
  candidates: ReadonlySet<TSESTree.Node>,
): TSESTree.Node | null {
  let current: TSESTree.Node | undefined = node;

  while (current) {
    if (candidates.has(current)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

/** Which of `candidates` can move below the tests, as a GROUP.
 *
 * A fixture read by another fixture's initialiser is read during evaluation, so
 * on its own it can never move. But if that other fixture is moving too, the
 * pair stays in the same relative order — the fixer preserves it — and the
 * initialisation sequence is unchanged. So movability is not a per-declaration
 * property; it is the greatest fixpoint over the whole set.
 *
 * Start by assuming every candidate moves, then repeatedly drop any whose
 * reference is neither deferred nor inside a still-moving candidate. Dropping
 * one can strand another (its reader now stays put), hence the loop. Converges:
 * the set only ever shrinks.
 *
 * `const user = {...}; const session = { user };` is the motivating case — the
 * per-declaration check moved `session` and stranded `user` at the top, which
 * splits a pair that belongs together and reads worse than not moving at all. */
function movableFixtureGroup(
  candidates: ReadonlySet<Stmt>,
  sourceCode: TSESLint.SourceCode,
  below: ReadonlySet<Stmt>,
): Set<Stmt> {
  const movable = new Set(candidates);
  let settled = false;

  while (!settled) {
    settled = true;

    for (const stmt of [...movable]) {
      const blocked = sourceCode.getDeclaredVariables(stmt).some((variable) => {
        return variable.references.some((ref) => {
          // The declaration's OWN initialiser is not a read of the binding —
          // it is what creates it, and travels with the statement.
          if (ref.init) {
            return false;
          }

          if (isDeferredReference(ref.identifier, sourceCode, new Set())) {
            return false;
          }

          // Read by a fixture that is ALSO moving: order is preserved, fine.
          if (enclosingCandidate(ref.identifier, movable) !== null) {
            return false;
          }

          // Read by a statement that ALREADY sits below the tests: still fine,
          // provided we land ABOVE that reader rather than at the very end.
          // This is the common leftover shape once an outer fixture has been
          // moved in an earlier pass and its inner one was stranded at the top.
          return enclosingCandidate(ref.identifier, below) === null;
        });
      });

      if (blocked) {
        movable.delete(stmt);
        settled = false;
      }
    }
  }

  return movable;
}

/** The earliest already-below statement that EAGERLY reads one of `moved`, or
 * null. Moved fixtures must be initialised before it runs, so it is the fixer's
 * insertion point; without one, they go to the end of the block. */
function earliestEagerReader(
  moved: ReadonlySet<Stmt>,
  below: ReadonlySet<Stmt>,
  sourceCode: TSESLint.SourceCode,
): TSESTree.Node | null {
  let earliest: TSESTree.Node | null = null;

  for (const stmt of moved) {
    for (const variable of sourceCode.getDeclaredVariables(stmt)) {
      for (const ref of variable.references) {
        if (ref.init) {
          continue;
        }

        const owner = enclosingCandidate(ref.identifier, below);

        if (owner === null) {
          continue;
        }

        if (earliest === null || owner.range[0] < earliest.range[0]) {
          earliest = owner;
        }
      }
    }
  }

  return earliest;
}

function declKind(stmt: Stmt): string {
  const node =
    stmt.type === "ExportNamedDeclaration" && stmt.declaration
      ? stmt.declaration
      : stmt;
  return node.type;
}

function isSecondary(stmt: Stmt): boolean {
  if (isMovableMock(stmt)) {
    return true;
  }

  const kind = declKind(stmt);
  return (
    kind === "FunctionDeclaration" ||
    kind === "TSTypeAliasDeclaration" ||
    kind === "TSInterfaceDeclaration"
  );
}

function startWithLeadingComments(
  node: TSESTree.Node,
  sourceCode: TSESLint.SourceCode,
): number {
  const comments = sourceCode.getCommentsBefore(node);
  let start = node.range[0];

  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const tokenBefore = sourceCode.getTokenBefore(comment, {
      includeComments: true,
    });

    if (tokenBefore && tokenBefore.loc.end.line === comment.loc.start.line) {
      break;
    }

    start = comment.range[0];
  }

  return start;
}

/** Statements above the last test in `body` that belong below it. */
function violationsIn(
  body: Stmt[],
  sourceCode: TSESLint.SourceCode,
): Violations {
  let lastPrimary = -1;

  for (let i = 0; i < body.length; i++) {
    if (isPrimary(body[i])) {
      lastPrimary = i;
    }
  }

  if (lastPrimary === -1) {
    return { violations: [], before: null };
  }

  const above = body.slice(0, lastPrimary);
  // Only statements whose POSITION decides when they run can serve as an
  // insertion anchor. A `function` declaration below the tests is hoisted, so
  // landing above it proves nothing — it may still be called during collection,
  // which is exactly the case isDeferredReference already rejected. Restrict to
  // const/let declarations, whose initialiser runs where it is written.
  const below = new Set(
    body.slice(lastPrimary + 1).filter((stmt) => {
      return (
        stmt.type === "VariableDeclaration" &&
        (stmt.kind === "const" || stmt.kind === "let")
      );
    }),
  );

  const candidates = new Set(
    above.filter((stmt) => {
      return isMovableFixture(stmt, sourceCode);
    }),
  );
  const movableFixtures = movableFixtureGroup(candidates, sourceCode, below);

  const violations = above.filter((stmt) => {
    return isSecondary(stmt) || movableFixtures.has(stmt);
  });

  return {
    violations,
    before: earliestEagerReader(movableFixtures, below, sourceCode),
  };
}

function create(context: Context): TSESLint.RuleListener {
  const sourceCode = context.sourceCode;

  function reportBlock(
    violations: Stmt[],
    insertAt: number,
    indent: string | null,
    insertBefore = false,
  ): void {
    if (violations.length === 0) {
      return;
    }

    context.report({
      node: violations[0],
      messageId: "moveDown",
      data: { count: String(violations.length) },
      fix(fixer: TSESLint.RuleFixer): TSESLint.RuleFix[] {
        const fixes: TSESLint.RuleFix[] = [];
        const chunks: string[] = [];

        for (const node of violations) {
          const start = startWithLeadingComments(node, sourceCode);
          const nextToken = sourceCode.getTokenAfter(node, {
            includeComments: true,
          });
          const end = nextToken ? nextToken.range[0] : node.range[1];
          fixes.push(fixer.removeRange([start, end]));
          chunks.push(sourceCode.text.slice(start, node.range[1]));
        }

        // Three shapes. Inserting BEFORE a statement (because it eagerly reads
        // what we are moving) leads each chunk and trails a blank line. Program
        // scope appends past the final newline, so it opens with one "\n" and
        // closes with another. Block scope inserts after the last statement,
        // where the closing "\n}" already follows.
        const pad = indent ?? "";
        const text = insertBefore
          ? chunks
              .map((chunk) => {
                return `${pad}${chunk}\n\n`;
              })
              .join("")
          : indent === null
            ? `\n${chunks.join("\n\n")}\n`
            : chunks
                .map((chunk) => {
                  return `\n\n${indent}${chunk}`;
                })
                .join("");
        fixes.push(fixer.insertTextAfterRange([insertAt, insertAt], text));
        return fixes;
      },
    });
  }

  return {
    // `:exit` rather than enter: isDeferredReference walks `parent` pointers,
    // which ESLint only populates as it traverses.
    "Program:exit"(program: TSESTree.Program): void {
      const top = violationsIn(program.body, sourceCode);

      if (top.before) {
        reportBlock(
          top.violations,
          startWithLeadingComments(top.before, sourceCode),
          "",
          true,
        );
      } else {
        reportBlock(top.violations, sourceCode.ast.range[1], null);
      }

      // The same treatment INSIDE each describe. A helper used by one describe
      // belongs at the end of THAT block, not at the bottom of a 4,500-line
      // file, so the insertion point is the block rather than the program.
      function visit(node: TSESTree.Node): void {
        if (!node || typeof node.type !== "string") {
          return;
        }

        if (
          node.type === "CallExpression" &&
          baseCalleeName(node.callee) === "describe"
        ) {
          for (const arg of node.arguments) {
            if (
              (arg.type === "ArrowFunctionExpression" ||
                arg.type === "FunctionExpression") &&
              arg.body?.type === "BlockStatement"
            ) {
              const body = arg.body.body;
              const found = violationsIn(body, sourceCode);

              if (found.violations.length > 0) {
                const indent = " ".repeat(body[0].loc.start.column);

                if (found.before) {
                  reportBlock(
                    found.violations,
                    startWithLeadingComments(found.before, sourceCode),
                    indent,
                    true,
                  );
                } else {
                  reportBlock(
                    found.violations,
                    body[body.length - 1].range[1],
                    indent,
                  );
                }
              }
            }
          }
        }

        const entries: [string, unknown][] = Object.entries(node);

        for (const [key, value] of entries) {
          if (key === "parent") {
            continue;
          }

          if (Array.isArray(value)) {
            const children: unknown[] = value;

            for (const child of children) {
              if (isNode(child)) {
                visit(child);
              }
            }
          } else if (isNode(value)) {
            visit(value);
          }
        }
      }

      visit(program);
    },
  };
}

export const newspaperOrder: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Test files: keep type/helper declarations below the tests (newspaper order).",
    },
    fixable: "code",
    schema: [],
    messages: {
      moveDown:
        "Newspaper order: move type/helper declarations below the tests ({{count}} found).",
    },
  },
  create,
};
