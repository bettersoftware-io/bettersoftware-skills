// Small file helpers shared by the gates. Node built-ins only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "reports", ".turbo", ".git"]);
const SOURCE_FILE = /\.(ts|tsx|mts|js|jsx|mjs)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/__testUtils__\/)/;

/** Every source file under `directory`, as paths from `root`. Missing folder → none. */
export function listSourceFiles(root, directory) {
  const found = [];

  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;

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

export function isTestFile(path) {
  return TEST_FILE.test(path);
}

export function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

/** Matches a file name against `name` or a `*.suffix` pattern. */
export function matchesName(name, pattern) {
  return pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : name === pattern;
}

/**
 * The file's lines with comments blanked, so a rule name mentioned in a comment
 * is not read as a violation. Line numbers are preserved.
 */
export function readCodeLines(root, path) {
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
