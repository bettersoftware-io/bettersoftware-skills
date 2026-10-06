// Small file helpers shared by the gates. Node built-ins only.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";
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

/** True when the path goes through a folder of installed or generated files. */
export function isGeneratedPath(path: string): boolean {
  return path.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

const SOURCE_FILE = /\.(ts|tsx|mts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/__testUtils__\/)/;

/**
 * Everything written for tests: the tests, and what they are built from (a
 * `testing/` folder, a page object, a `*.testHelpers.*` file). As source for a
 * dependency-cruiser path, and as a pattern for the gates that read files.
 */
export const TEST_SCAFFOLDING_SOURCE =
  "(\\.(test|spec|page|testHelpers)\\.[cm]?[jt]sx?$|/__tests__/|/__testUtils__/|/testing/)";
const TEST_SCAFFOLDING = new RegExp(TEST_SCAFFOLDING_SOURCE);

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

/**
 * True when no part of `path`, a place under `root`, is a symbolic link. A
 * tool that writes at a fixed place in a tree it did not make asks this first:
 * a link there would send the write wherever the link points.
 */
export function isPlainPath(root: string, path: string): boolean {
  let current = root;

  for (const part of path.split("/")) {
    current = join(current, part);

    try {
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return false;
      }
    } catch {
      // A part that is a file, or cannot be read: nothing can be written under it either.
      return false;
    }
  }

  return true;
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** True for a test and for anything only tests are built from. */
export function isTestScaffolding(path: string): boolean {
  return TEST_SCAFFOLDING.test(path);
}

/** The 1-based line of the character at `index` in `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1;

  for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) {
    line += 1;
  }

  return line;
}

export function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

type SubpathTarget = string | { [condition: string]: SubpathTarget } | null;

/**
 * Where a `#…` import lands, as a path from `root`: read from the `imports`
 * of the package's own package.json, the way Node and the bundlers read it.
 * Undefined when the package declares no alias that matches. A gate that reads
 * import paths as text needs this, or a forbidden import written through the
 * alias would pass it.
 */
export function resolveSubpathImport(root: string, packagePath: string, specifier: string): string | undefined {
  const manifest = join(root, packagePath, "package.json");

  if (!specifier.startsWith("#") || !existsSync(manifest)) {
    return undefined;
  }

  const { imports = {} } = JSON.parse(readFileSync(manifest, "utf8")) as { imports?: Record<string, SubpathTarget> };

  for (const [key, declared] of Object.entries(imports)) {
    const target = firstPath(declared);
    const [before, after] = key.split("*");

    if (target === undefined || before === undefined) {
      continue;
    }

    if (after === undefined) {
      if (key === specifier) {
        return normalize(join(packagePath, target));
      }
    } else if (specifier.startsWith(before) && specifier.endsWith(after) && specifier.length >= key.length) {
      const matched = specifier.slice(before.length, specifier.length - after.length);

      return normalize(join(packagePath, target.replace("*", matched)));
    }
  }

  return undefined;
}

/** A target is a path, or paths by condition (`import`, `default`): the first path found is taken. */
function firstPath(target: SubpathTarget): string | undefined {
  if (typeof target === "string" || target === null) {
    return target ?? undefined;
  }

  for (const nested of Object.values(target)) {
    const path = firstPath(nested);

    if (path !== undefined) {
      return path;
    }
  }

  return undefined;
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

/**
 * Parses JSON that may hold comments, as `turbo.json` and `tsconfig.json` may.
 * Returns undefined when it is not JSON even without them.
 */
export function parseJsonWithComments(text: string): unknown {
  let json = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const character = text[index];

    if (inString) {
      json += character;

      if (character === "\\") {
        json += text[index + 1] ?? "";
        index += 1;
      } else if (character === '"') {
        inString = false;
      }

      index += 1;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);

      index = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index);

      index = end === -1 ? text.length : end + 2;
    } else {
      inString = character === '"';
      json += character;
      index += 1;
    }
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}
