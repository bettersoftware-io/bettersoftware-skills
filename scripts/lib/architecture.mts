// Declares a package an add-on brings in the project's architecture config.
//
// `architecture.config.mts` belongs to the project, and a workspace package
// that is not listed in it fails the structure gate. An add-on that brings a
// package of its own therefore adds one entry to the `packages` map, the way
// it adds a script to a package.json:
//
//   - an entry the project already has is left as it is, whatever it says;
//   - nothing else in the file is touched, and nothing is ever removed;
//   - a file this cannot read as a `packages: { … }` map is left alone, and
//     the caller is told which line to add by hand.
//
// Adding the same entries a second time changes nothing.

import type { Json } from "./host-settings.mts";

export interface Declaration {
  [option: string]: Json;
}

export interface DeclareResult {
  /** The file's new text. Undefined when nothing was added. */
  text?: string;
  /** The entries added, as the lines written. */
  added: string[];
  /** The entries that could not be added, as the lines to write by hand. */
  byHand: string[];
}

/** Adds each package of `packages` that `text` does not declare yet to its `packages: { … }` map. */
export function declarePackages(text: string, packages: Record<string, Declaration>): DeclareResult {
  // Read without its comments: an entry that is commented out is not declared,
  // and a brace in a comment closes nothing. Every character keeps its place.
  const code = blankComments(text);
  const missing = Object.entries(packages).filter(([path]) => code === undefined || !declares(code, path));
  const entries = missing.map(([path, declaration]) => `${JSON.stringify(path)}: ${renderDeclaration(declaration)},`);

  if (entries.length === 0) {
    return { added: [], byHand: [] };
  }

  const block = code === undefined ? undefined : findPackagesBlock(code);

  if (block === undefined) {
    return { added: [], byHand: entries };
  }

  const { lastEntryEnd, closingLineStart, indent, needsComma } = block;
  const lines = entries.map((entry) => `${indent}  ${entry}\n`).join("");

  return {
    text: `${text.slice(0, lastEntryEnd)}${needsComma ? "," : ""}${text.slice(lastEntryEnd, closingLineStart)}${lines}${text.slice(closingLineStart)}`,
    added: entries,
    byHand: [],
  };
}

/** True when the code has a key for this path, in either kind of quote. */
function declares(code: string, path: string): boolean {
  return [`"${path}"`, `'${path}'`].some((key) => new RegExp(`${escapeForRegExp(key)}\\s*:`).test(code));
}

/** `{ role: "e2e" }`: keys bare where they can be, values as JSON, on one line. */
export function renderDeclaration(declaration: Declaration): string {
  const members = Object.entries(declaration).map(
    ([key, value]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );

  return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`;
}

/**
 * The text with every comment turned into spaces, so that each character of
 * code is where it was. Undefined when a string or a block comment does not
 * end.
 */
export function blankComments(text: string): string | undefined {
  let code = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    let end: number | undefined;

    if (character === '"' || character === "'" || character === "`") {
      end = findStringEnd(text, index);

      if (end === undefined) {
        return undefined;
      }

      code += text.slice(index, end + 1);
    } else if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index);

      // The last line of a file may be a comment with no line end after it.
      end = (newline === -1 ? text.length : newline) - 1;
      code += " ".repeat(end + 1 - index);
    } else if (text.startsWith("/*", index)) {
      const closing = text.indexOf("*/", index + 2);

      if (closing === -1) {
        return undefined;
      }

      end = closing + 1;
      code += text.slice(index, end + 1).replace(/[^\n]/g, " ");
    } else {
      end = index;
      code += character;
    }

    index = end;
  }

  return code;
}

interface PackagesBlock {
  /** Just after the last character of code inside the block. */
  lastEntryEnd: number;
  /** The start of the line that holds the closing brace. */
  closingLineStart: number;
  /** What the `packages:` line is indented by. */
  indent: string;
  /** True when the last entry does not end in a comma. */
  needsComma: boolean;
}

/**
 * The `packages: {` map of the config, read from its code with the comments
 * blanked: where its last entry ends and where it closes. Strings are stepped
 * over, so a brace inside one is not counted. Undefined when there is no such
 * map, when it does not close, or when it closes on the line it opens on.
 */
function findPackagesBlock(code: string): PackagesBlock | undefined {
  const opening = /^([ \t]*)packages:\s*\{/m.exec(code);

  if (opening === null) {
    return undefined;
  }

  const start = opening.index + opening[0].length;
  let depth = 1;
  let lastEntryEnd = start;
  let lastCharacter = "{";

  for (let index = start; index < code.length; index += 1) {
    const character = code[index] as string;

    if (character === '"' || character === "'" || character === "`") {
      // Blanking the comments has already shown that every string ends.
      index = findStringEnd(code, index) as number;
      lastEntryEnd = index + 1;
      lastCharacter = character;
    } else if (character === "}" && depth === 1) {
      const closingLineStart = code.lastIndexOf("\n", index) + 1;

      // Opened and closed on one line: there is no line of its own to add before.
      if (closingLineStart <= opening.index) {
        return undefined;
      }

      return { lastEntryEnd, closingLineStart, indent: opening[1] ?? "", needsComma: lastCharacter !== "," && lastCharacter !== "{" };
    } else if (!/\s/.test(character)) {
      depth += character === "{" ? 1 : character === "}" ? -1 : 0;
      lastEntryEnd = index + 1;
      lastCharacter = character;
    }
  }

  return undefined;
}

/** The index of the quote that closes the string opened at `from`. */
function findStringEnd(text: string, from: number): number | undefined {
  const quote = text[from];

  for (let index = from + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === quote) {
      return index;
    }
  }

  return undefined;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
