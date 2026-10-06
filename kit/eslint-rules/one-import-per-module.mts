// arch/one-import-per-module — a file names a module in ONE import statement.
// When it needs both types and values from that module, the types ride in the
// same statement with an inline `type`:
//
//   import { findUser, type User } from "./users.ts";
//
// never as a separate `import type { User }` block beside the value import.
// Re-exports (`export … from`) follow the same rule, as their own group: an
// import and a re-export of one module are never merged.
//
// A STATEMENT THAT NAMES ONLY TYPES STAYS `import type { … }`. Under
// `verbatimModuleSyntax` an `import { type A }` with nothing but inline-type
// names survives as a runtime `import "m"`, which loads a module the file only
// wanted a type from. This rule does not police that spelling; the format-lint
// add-on does (Biome's `useImportType` / `useExportType`), so the two hold
// each other up: delete the last value from a merged statement and Biome turns
// what is left back into `import type`.
//
// ESLint's own `no-duplicate-imports` finds the same imports but cannot fix
// them, and reaches re-exports only through `includeExports`, which also
// reports a file that imports from a module and re-exports from it.
//
// Deliberately NOT reported:
// - A namespace import or `export *` beside named ones — the syntax has no
//   single statement for the pair.
// - A side-effect import (`import "./x.css"`) — it names nothing to merge.
// - A statement with import attributes — two attribute sets are two requests.
//
// Reported WITHOUT a fix, because the rewrite would need a judgment:
// - a type-only default import (`import type X from "m"`), which can only
//   merge as `{ type default as X }`;
// - two default imports of one module;
// - a comment inside either statement, trailing the one that would be
//   removed, or above it when its partner is not the next statement — the
//   fixer would have to decide where the comment goes. A comment trailing
//   the statement directly above counts as "above", so it blocks too.
//
// A comment above the PAIR is no judgment: it stays above the merged
// statement. That includes a directive (`// @ts-expect-error`,
// `// eslint-disable-next-line`), which goes on covering the names it covered
// and now covers their neighbours in the same statement as well.
//
// ONE `eslint --fix` MAY NOT FINISH A FILE. A fix edits two places, ESLint
// applies it as one range from the first to the second, and overlapping
// ranges wait for the next of its ten passes. A file whose type blocks and
// value blocks interleave across more than ten modules needs a second run.
// An import sorter keeps the statements of one module adjacent, and then one
// run is enough.

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "splitStatements";
type Context = TSESLint.RuleContext<MessageIds, []>;
type Keyword = "import" | "export";

/** An import or re-export statement the rule can reason about. */
interface Statement {
  node: TSESTree.ImportDeclaration | TSESTree.ExportNamedDeclaration;
  keyword: Keyword;
  source: TSESTree.StringLiteral;
  /** Spelled `import type` / `export type`. */
  typeOnly: boolean;
  defaultName: string | null;
  named: (TSESTree.ImportSpecifier | TSESTree.ExportSpecifier)[];
}

export const oneImportPerModule: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "a file names a module in one import statement (and one re-export statement), with an inline `type` on each type",
    },
    fixable: "code",
    schema: [],
    messages: {
      splitStatements:
        '"{{module}}" has more than one {{keyword}} statement in this file — merge them into one, marking each type with an inline `type` ({{keyword}} { type A, b } from "{{module}}"). A statement that names only types stays `{{keyword}} type`.',
    },
  },
  create(context: Context): TSESLint.RuleListener {
    const { sourceCode } = context;

    /** Reports `extra`, the statement that should fold into `kept`. */
    function reportSplit(kept: Statement, extra: Statement): void {
      context.report({
        node: extra.node,
        messageId: "splitStatements",
        data: { module: extra.source.value, keyword: extra.keyword },
        fix: canMerge(kept, extra, sourceCode)
          ? (fixer: TSESLint.RuleFixer): TSESLint.RuleFix[] => {
              return [
                fixer.replaceTextRange(
                  [kept.node.range[0], kept.source.range[0]],
                  printMergedHead(kept, extra, sourceCode),
                ),
                fixer.removeRange(rangeWithItsLine(extra.node, sourceCode)),
              ];
            }
          : null,
      });
    }

    return {
      // A `declare module` block is a module body too, with groups of its own.
      "Program, TSModuleBlock"(
        scope: TSESTree.Program | TSESTree.TSModuleBlock,
      ): void {
        for (const statements of groupByModule(scope).values()) {
          // The value statement is the one that exists at runtime, so it stays
          // where it is and the emitted JavaScript does not move.
          const kept =
            statements.find((s) => {
              return !s.typeOnly;
            }) ?? statements[0];

          for (const extra of statements) {
            if (extra !== kept) {
              reportSplit(kept, extra);
            }
          }
        }
      },
    };
  },
};

/** The mergeable statements of one module body, keyed by keyword + module, in
 * source order. */
function groupByModule(
  scope: TSESTree.Program | TSESTree.TSModuleBlock,
): Map<string, Statement[]> {
  const groups = new Map<string, Statement[]>();

  for (const node of scope.body) {
    const statement = readStatement(node);

    if (statement !== null) {
      const key = `${statement.keyword} ${statement.source.value}`;
      const group = groups.get(key) ?? [];

      group.push(statement);
      groups.set(key, group);
    }
  }

  return groups;
}

/** `node` as a statement that could share a line with another of its module,
 * or null when the syntax rules that out. */
function readStatement(node: TSESTree.ProgramStatement): Statement | null {
  if (node.type === "ImportDeclaration") {
    const hasNamespace = node.specifiers.some((s) => {
      return s.type === "ImportNamespaceSpecifier";
    });

    if (hasNamespace || isBare(node)) {
      return null;
    }

    return {
      node,
      keyword: "import",
      source: node.source,
      typeOnly: node.importKind === "type",
      defaultName:
        node.specifiers.find((s) => {
          return s.type === "ImportDefaultSpecifier";
        })?.local.name ?? null,
      named: node.specifiers.filter((s) => {
        return s.type === "ImportSpecifier";
      }),
    };
  }

  if (node.type === "ExportNamedDeclaration" && node.source !== null) {
    if (isBare(node)) {
      return null;
    }

    return {
      node,
      keyword: "export",
      source: node.source,
      typeOnly: node.exportKind === "type",
      defaultName: null,
      named: node.specifiers,
    };
  }

  return null;
}

/** Whether `node` names nothing (a side-effect import) or carries import
 * attributes — either way it is not a candidate for merging. */
function isBare(
  node: TSESTree.ImportDeclaration | TSESTree.ExportNamedDeclaration,
): boolean {
  return node.specifiers.length === 0 || node.attributes.length > 0;
}

/** Whether folding `extra` into `kept` is a pure respelling, with nothing for
 * the fixer to decide. */
function canMerge(
  kept: Statement,
  extra: Statement,
  sourceCode: TSESLint.SourceCode,
): boolean {
  const hasTypeOnlyDefault = [kept, extra].some((s) => {
    return s.typeOnly && s.defaultName !== null;
  });

  const hasTwoDefaults =
    kept.defaultName !== null && extra.defaultName !== null;

  return (
    !hasTypeOnlyDefault &&
    !hasTwoDefaults &&
    !strandsAComment(kept, extra, sourceCode)
  );
}

/** Whether a comment would lose its place if `extra` folded into `kept`. */
function strandsAComment(
  kept: Statement,
  extra: Statement,
  sourceCode: TSESLint.SourceCode,
): boolean {
  const isInside = [kept, extra].some((s) => {
    return sourceCode.getCommentsInside(s.node).length > 0;
  });

  const isTrailing = sourceCode.getCommentsAfter(extra.node).some((comment) => {
    return comment.loc.start.line === extra.node.loc.end.line;
  });

  // A comment above the pair stays above the merged statement. Above a
  // statement whose partner is elsewhere, it would be left describing a
  // neighbour.
  const isAboveALoneStatement =
    sourceCode.getCommentsBefore(extra.node).length > 0 &&
    sourceCode.getTokenAfter(extra.node)?.range[0] !== kept.node.range[0];

  return isInside || isTrailing || isAboveALoneStatement;
}

/** Everything of the merged statement up to its module string:
 * `import React, { type FC, useState } from `. */
function printMergedHead(
  kept: Statement,
  extra: Statement,
  sourceCode: TSESLint.SourceCode,
): string {
  const typeOnly = kept.typeOnly && extra.typeOnly;
  const names = [kept, extra].flatMap((statement) => {
    return statement.named.map((specifier) => {
      const text = sourceCode.getText(specifier);

      return statement.typeOnly && !typeOnly ? `type ${text}` : text;
    });
  });
  const defaultName = kept.defaultName ?? extra.defaultName;
  const bindings = [
    ...(defaultName === null ? [] : [defaultName]),
    ...(names.length === 0 ? [] : [`{ ${names.join(", ")} }`]),
  ];

  return `${kept.keyword} ${typeOnly ? "type " : ""}${bindings.join(", ")} from `;
}

/** `node`'s range, widened to its whole line — indentation and line break —
 * so removing it leaves neither an empty line nor a stray indent behind. */
function rangeWithItsLine(
  node: TSESTree.Node,
  sourceCode: TSESLint.SourceCode,
): TSESTree.Range {
  const [start, end] = node.range;
  const indent = /(?<=^|\n)[ \t]*$/.exec(sourceCode.text.slice(0, start));
  const rest = /^[ \t]*\r?\n/.exec(sourceCode.text.slice(end));

  return [start - (indent?.[0].length ?? 0), end + (rest?.[0].length ?? 0)];
}
