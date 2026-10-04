// Small file helpers shared by the gates. Node built-ins only.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Folders that hold only installed or generated files. This is a closed list on
// purpose: skipping every dot-folder would let source in `.github/`,
// `.storybook/` or a dot-named folder under `src/ui` slip past every gate.
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
const SOURCE_FILE = /\.(ts|tsx|mts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/__testUtils__\/)/;

/** Every source file under `directory`, as paths from `root`. Missing folder → none. */
export function listSourceFiles(root: string, directory: string): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
      } else if (SOURCE_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  }

  if (existsSync(join(root, directory))) {
    walk(directory);
  }

  return found.sort();
}

/**
 * True when the module at `moduleUrl` is the script Node was asked to run.
 * Compares real paths: reached through a symlink, a naive comparison is false
 * and the script would exit 0 having done nothing — a silent pass.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/** Matches a file name against `name` or a `*.suffix` pattern. */
export function matchesName(name: string, pattern: string): boolean {
  return pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : name === pattern;
}

/**
 * The file's lines with comments blanked, so a rule name mentioned in a comment
 * is not read as a violation. Line numbers are preserved.
 */
export function readCodeLines(root: string, path: string): string[] {
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  let inBlockComment = false;

  return lines.map((line) => {
    let code = "";
    let index = 0;

    while (index < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("*/", index);

        if (end === -1) {
          return code;
        }

        inBlockComment = false;
        index = end + 2;
      } else if (line.startsWith("/*", index)) {
        inBlockComment = true;
        index += 2;
      } else if (line.startsWith("//", index) && line[index - 1] !== ":") {
        // `://` is a URL scheme inside a string, not a comment.
        return code;
      } else {
        code += line[index];
        index += 1;
      }
    }

    return code;
  });
}
