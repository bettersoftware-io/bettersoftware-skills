// Reads a stylesheet into its declarations, each with the rule it sits in.
//
// A scanner, not a full CSS parser: it follows braces, semicolons, comments
// and strings, which is all the animation rules need. It reads plain CSS,
// nested rules included. It does not read Sass, Less or CSS written inside
// TypeScript.

import { normaliseProperty } from "./properties.mts";

export interface CssDeclaration {
  /** 1-based line the declaration starts on. */
  line: number;
  /** Lower-cased, vendor prefix removed. */
  property: string;
  value: string;
  /** The style rule's selector, or `@keyframes <name>` inside keyframes. */
  rule: string;
  /** Set when the declaration is inside `@keyframes`. */
  keyframes?: string;
}

interface Block {
  prelude: string;
}

const KEYFRAMES = /^@(?:-\w+-)?keyframes\s+(.+)$/i;

export function scanCss(source: string): CssDeclaration[] {
  const text = blankCommentsAndStrings(source);
  const declarations: CssDeclaration[] = [];
  const stack: Block[] = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;

  function closeDeclaration(): void {
    const colon = buffer.indexOf(":");
    const statement = buffer.trim();

    if (colon !== -1 && stack.length > 0 && !statement.startsWith("@")) {
      const keyframes = keyframesName(stack);

      declarations.push({
        line: bufferLine,
        property: normaliseProperty(buffer.slice(0, colon)),
        value: buffer.slice(colon + 1).replace(/\s+/g, " ").trim(),
        rule: keyframes === undefined ? selectorOf(stack) : `@keyframes ${keyframes}`,
        ...(keyframes === undefined ? {} : { keyframes }),
      });
    }

    buffer = "";
  }

  for (const character of text) {
    if (character === "{") {
      stack.push({ prelude: buffer.replace(/\s+/g, " ").trim() });
      buffer = "";
    } else if (character === ";") {
      closeDeclaration();
    } else if (character === "}") {
      closeDeclaration();
      stack.pop();
    } else {
      if (buffer.trim() === "" && !/\s/.test(character)) {
        bufferLine = line;
      }

      buffer += character;
    }

    if (character === "\n") {
      line += 1;
    }
  }

  return declarations;
}

function keyframesName(stack: Block[]): string | undefined {
  for (const { prelude } of stack) {
    const name = KEYFRAMES.exec(prelude)?.[1];

    if (name !== undefined) {
      return name.trim();
    }
  }

  return undefined;
}

/** The selectors of the style rules around a declaration, outermost first. */
function selectorOf(stack: Block[]): string {
  return stack
    .map(({ prelude }) => prelude)
    .filter((prelude) => !prelude.startsWith("@"))
    .join(" ");
}

/**
 * Comments become spaces and the inside of a string becomes spaces, so a brace
 * or a semicolon in either is not read as structure. Line breaks are kept, so
 * line numbers still match the file.
 */
function blankCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const character = source[index] as string;

    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;

      result += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (character === '"' || character === "'") {
      let end = index + 1;

      while (end < source.length && source[end] !== character && source[end] !== "\n") {
        end += source[end] === "\\" ? 2 : 1;
      }

      // An unclosed string ends at the line break, which is kept.
      const closed = source[end] === character;

      result += `${character}${" ".repeat(Math.max(0, Math.min(end, source.length) - index - 1))}${closed ? character : ""}`;
      index = closed ? end + 1 : Math.min(end, source.length);
    } else {
      result += character;
      index += 1;
    }
  }

  return result;
}
