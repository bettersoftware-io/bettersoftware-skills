// Finds Web Animations calls (`element.animate(keyframes, options)`) in
// TypeScript and reads the properties out of keyframes written as a literal.
//
// Keyframes held in a variable, built by a function or spread from another
// object cannot be judged from source. Such a call is returned as unjudged; it
// is never counted as clean.

import { lineAt } from "./files.mts";
import { fromKeyframeKey } from "./properties.mts";

export interface KeyframeProperty {
  property: string;
  /** The source text of the value; empty when the key is written as a shorthand. */
  value: string;
}

export interface AnimateCall {
  line: number;
  /** Set when the keyframes are a literal. */
  properties?: KeyframeProperty[];
  /** Set when they are not: why the call could not be judged. */
  unjudged?: string;
}

/** Keys of a keyframe that are not animated properties. */
const NOT_A_PROPERTY = new Set(["offset", "easing", "composite"]);

const KEY = /^(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')\s*(?::([\s\S]*))?$/;

export function scanAnimateCalls(source: string): AnimateCall[] {
  const text = blankComments(source);
  const calls: AnimateCall[] = [];

  for (const match of text.matchAll(/\.animate\s*\(/g)) {
    let start = match.index + match[0].length;

    while (/\s/.test(text[start] ?? "")) {
      start += 1;
    }

    const line = lineAt(text, match.index);
    const opening = text[start];
    const literal = opening === "[" || opening === "{" ? readBalanced(text, start) : undefined;

    if (literal === undefined) {
      calls.push({ line, unjudged: "the keyframes are not written as a literal in the call" });
      continue;
    }

    const objects = opening === "{" ? [literal] : splitParts(literal.slice(1, -1));
    const properties: KeyframeProperty[] = [];
    let unjudged: string | undefined;

    for (const object of objects) {
      if (!object.startsWith("{") || !object.endsWith("}")) {
        unjudged = "a keyframe is not written as an object literal";
        break;
      }

      for (const part of splitParts(object.slice(1, -1))) {
        const key = KEY.exec(part);

        if (part.startsWith("...") || part.startsWith("[")) {
          unjudged = "a keyframe is built with a spread or a computed key";
        } else if (key !== null) {
          const name = (key[1] ?? key[2] ?? key[3]) as string;

          if (!NOT_A_PROPERTY.has(name)) {
            properties.push({ property: fromKeyframeKey(name), value: (key[4] ?? "").trim() });
          }
        }
      }
    }

    calls.push(unjudged === undefined ? { line, properties } : { line, unjudged });
  }

  return calls;
}

/** The text from the bracket at `start` to the bracket that closes it. */
function readBalanced(text: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index] as string;

    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

/** Splits on commas that are outside brackets and outside strings. */
function splitParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;

    if (quote !== undefined) {
      if (character === "\\") {
        current += character + (text[index + 1] ?? "");
        index += 1;
        continue;
      }

      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Comments become spaces; strings are kept, since keyframe values are strings. */
function blankComments(source: string): string {
  let result = "";
  let index = 0;
  let quote: string | undefined;

  while (index < source.length) {
    const character = source[index] as string;

    if (quote !== undefined) {
      if (character === "\\") {
        result += source.slice(index, index + 2);
        index += 2;
        continue;
      }

      if (character === quote || (character === "\n" && quote !== "`")) {
        quote = undefined;
      }

      result += character;
      index += 1;
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;

      result += " ".repeat(stop - index);
      index = stop;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;

      result += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else {
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
      }

      result += character;
      index += 1;
    }
  }

  return result;
}
