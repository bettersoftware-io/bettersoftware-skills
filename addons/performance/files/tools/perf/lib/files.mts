// Small file helpers for the performance checks. Node built-ins only.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Folders that hold only installed or generated files. A closed list on
// purpose: skipping every dot-folder would let a stylesheet in a dot-named
// folder slip past the check.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  "reports",
  ".git",
  ".turbo",
  ".vite",
  ".next",
  ".expo",
  ".cache",
]);

const TEST_FILE = /(\.(test|spec|page)\.[cm]?tsx?$|\/__tests__\/|\/__testUtils__\/)/;

/** Every file under `root` whose name matches, as paths from `root`. */
export function listFiles(root: string, matching: RegExp): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
      } else if (matching.test(entry.name)) {
        found.push(path);
      }
    }
  }

  if (existsSync(root)) {
    walk("");
  }

  return found.sort();
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/**
 * True when the module at `moduleUrl` is the script Node was asked to run.
 * Compares real paths: reached through a symlink, a naive comparison is false
 * and the script would exit 0 having done nothing.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

/** The 1-based line of the character at `index`. */
export function lineAt(text: string, index: number): number {
  let line = 1;

  for (let at = 0; at < index && at < text.length; at += 1) {
    if (text[at] === "\n") {
      line += 1;
    }
  }

  return line;
}

/** Splits on `separator` where it is not inside brackets of any kind. */
export function splitTopLevel(text: string, separator: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const character of text) {
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    }

    const splits = separator === " " ? /\s/.test(character) : character === separator;

    if (splits && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part !== "");
}
