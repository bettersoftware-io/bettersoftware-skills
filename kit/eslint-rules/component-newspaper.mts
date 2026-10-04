import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "multipleExports" | "notLede" | "filenameMismatch";
type Context = TSESLint.RuleContext<MessageIds, []>;

interface ComponentInfo {
  name: string;
  exported: boolean;
}

interface ComponentEntry extends ComponentInfo {
  index: number;
  node: TSESTree.ProgramStatement;
}

type Declaration =
  | TSESTree.ProgramStatement
  | TSESTree.NamedExportDeclarations
  | TSESTree.DefaultExportDeclarations;

const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;

function isPascal(name: string): boolean {
  return typeof name === "string" && PASCAL_CASE.test(name);
}

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

// Shallow-recursive search for a JSX node anywhere in a subtree (skips `parent`
// back-references and non-AST values).
function containsJsx(node: TSESTree.Node | null): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }

  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    return true;
  }

  const entries: [string, unknown][] = Object.entries(node);

  for (const [key, value] of entries) {
    if (key === "parent") {
      continue;
    }

    if (Array.isArray(value)) {
      const children: unknown[] = value;

      for (const child of children) {
        if (isNode(child) && containsJsx(child)) {
          return true;
        }
      }
    } else if (isNode(value) && containsJsx(value)) {
      return true;
    }
  }

  return false;
}

// An init expression is a component value if it is an arrow/function returning
// JSX, or a memo(...)/forwardRef(...) wrapper call.
function isComponentInit(init: TSESTree.Expression | null): boolean {
  if (!init) {
    return false;
  }

  if (
    init.type === "ArrowFunctionExpression" ||
    init.type === "FunctionExpression"
  ) {
    return containsJsx(init.body);
  }

  if (init.type === "CallExpression") {
    const callee = init.callee;
    const name =
      callee.type === "Identifier"
        ? callee.name
        : callee.type === "MemberExpression" &&
            callee.property.type === "Identifier"
          ? callee.property.name
          : null;
    return name === "memo" || name === "forwardRef";
  }

  return false;
}

// If a top-level statement declares a React component, return {name, exported};
// else null. Handles `function`, `const = …`, and their `export`/`export
// default` (named) forms.
function componentInfo(stmt: TSESTree.ProgramStatement): ComponentInfo | null {
  let exported = false;
  let decl: Declaration = stmt;

  if (
    stmt.type === "ExportNamedDeclaration" ||
    stmt.type === "ExportDefaultDeclaration"
  ) {
    if (!stmt.declaration) {
      return null;
    }

    exported = true;
    decl = stmt.declaration;
  }

  if (
    decl.type === "FunctionDeclaration" &&
    decl.id &&
    isPascal(decl.id.name) &&
    containsJsx(decl.body)
  ) {
    return { name: decl.id.name, exported };
  }

  if (decl.type === "VariableDeclaration" && decl.declarations.length === 1) {
    const d = decl.declarations[0];

    if (
      d.id.type === "Identifier" &&
      isPascal(d.id.name) &&
      isComponentInit(d.init)
    ) {
      return { name: d.id.name, exported };
    }
  }

  return null;
}

function baseSegment(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.split(".")[0];
}

// Returns the source position that includes `node`'s own-line leading comments.
// Stops at a comment that shares a line with the previous token (trailing comment
// of the preceding statement — must NOT be claimed).
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

function create(context: Context): TSESLint.RuleListener {
  const sourceCode = context.sourceCode;
  const filename = context.filename;
  return {
    Program(program: TSESTree.Program): void {
      const body = program.body;
      const components: ComponentEntry[] = [];

      for (let i = 0; i < body.length; i++) {
        const info = componentInfo(body[i]);

        if (info) {
          components.push({ ...info, index: i, node: body[i] });
        }
      }

      if (components.length === 0) {
        return;
      }

      const exported = components.filter((c) => {
        return c.exported;
      });

      // Facet 1 — one exported component per file.
      if (exported.length > 1) {
        for (let k = 1; k < exported.length; k++) {
          context.report({
            node: exported[k].node,
            messageId: "multipleExports",
            data: { name: exported[k].name },
          });
        }

        return;
      }

      if (exported.length === 0) {
        return;
      }

      const lede = exported[0];

      // Facet 3 — filename === exported component name.
      const base = baseSegment(filename);

      if (lede.name !== base) {
        context.report({
          node: lede.node,
          messageId: "filenameMismatch",
          data: { name: lede.name, base },
        });
      }

      // Facet 2 — the exported component is the lede (first decl after imports).
      let firstNonImport = 0;

      while (
        firstNonImport < body.length &&
        body[firstNonImport].type === "ImportDeclaration"
      ) {
        firstNonImport++;
      }

      if (lede.index === firstNonImport) {
        return;
      }

      context.report({
        node: lede.node,
        messageId: "notLede",
        data: { name: lede.name },
        fix(fixer: TSESLint.RuleFixer): TSESLint.RuleFix[] {
          // Surgical move: relocate ONLY the lede (with its leading comments)
          // to the top; leave every other declaration byte-identical.
          const ledeStart = startWithLeadingComments(lede.node, sourceCode);
          const ledeText = sourceCode.text.slice(ledeStart, lede.node.range[1]);
          const insertPos = startWithLeadingComments(
            body[firstNonImport],
            sourceCode,
          );

          const nextToken = sourceCode.getTokenAfter(lede.node, {
            includeComments: true,
          });
          // Consume the blank-line gap that the moved lede leaves behind.
          const removeEnd = nextToken ? nextToken.range[0] : lede.node.range[1];
          return [
            fixer.insertTextBeforeRange(
              [insertPos, insertPos],
              `${ledeText}\n\n`,
            ),
            fixer.removeRange([ledeStart, removeEnd]),
          ];
        },
      });
    },
  };
}

export const componentNewspaper: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "One component per .tsx file: the exported component is the newspaper lede (private subcomponents/helpers below), and the filename matches it.",
    },
    fixable: "code",
    schema: [],
    messages: {
      multipleExports:
        "A .tsx file may export only one component. Extract '{{name}}' into its own '{{name}}.tsx'.",
      notLede:
        "The exported component '{{name}}' must be the first declaration after imports (newspaper order); private subcomponents and helpers belong below it.",
      filenameMismatch:
        "Filename must match the exported component: expected '{{name}}.tsx' for component '{{name}}' (got '{{base}}').",
    },
  },
  create,
};
