// Small file helpers shared by the gates. Node built-ins only.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILES, discoverWorkspace } from "./config.mts";

const require = createRequire(import.meta.url);

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

/**
 * Every source file under `directory`, as paths from `root`. Missing folder →
 * none. A file git ignores outside every package is left out, like a
 * generated one; inside a package nothing is. See `listGitIgnored` and
 * `listPackageFolders`.
 */
export function listSourceFiles(root: string, directory: string): string[] {
  const found: string[] = [];
  const { skipped: ignored } = ignoredUnder(root);

  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (isAmong(ignored, path)) {
        continue;
      }

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
 * What git ignores under `root`, as git lists it: a file by its path, and a
 * folder with a `/` at its end. A folder ignored from outside it is listed
 * once, with nothing of what it holds. Undefined when git cannot say: it is
 * not installed, or `root` is in no repository.
 *
 * Git is asked which paths are ignored. No `.gitignore` is read or turned
 * into patterns here: a rule in a folder's own `.gitignore` is relative to
 * that folder, and has negations, anchors and escapes that only git reads
 * the way git does.
 *
 * Only the `.gitignore` files inside the repository count. A rule in
 * `.git/info/exclude`, or in a person's global list, is on one machine and in
 * no commit, so it can hide nothing from a check: a file it names is judged
 * like any other.
 *
 * A file that is committed is never in this list, whatever a pattern says:
 * git does not ignore what it tracks.
 */
export function listGitIgnored(root: string, rules: "the repository's own" | "any" = "the repository's own"): string[] | undefined {
  // `--directory` names an ignored folder once and does not walk it, so this never reads node_modules.
  const from = rules === "any" ? ["--exclude-standard"] : ["--exclude-per-directory=.gitignore"];
  const listed = askGit(root, ["ls-files", "--others", "--ignored", ...from, "--directory"]);

  // An answer that cannot be right is no answer. Every entry is a path under
  // the root that is there: one that leaves the root, or names nothing (a
  // name git could not write as text), means the list is not to be trusted,
  // and then nothing is left out.
  return listed?.every((entry) => isUnderRoot(entry) && lstatSync(join(root, entry), { throwIfNoEntry: false }) !== undefined) ? listed : undefined;
}

/** How long git is given to answer. A git that hangs (a lock, a network file system) is one that cannot say. */
export const GIT_TIMEOUT_MS = 30_000;

/**
 * Asks git for a list of paths under `root`, with `-z`: a name may hold a
 * newline. Undefined when git cannot say, for any reason: it is not
 * installed, it exits with an error (no repository, a bare or broken one),
 * it does not answer in time. The caller must read undefined as "nothing is
 * known", never as an empty list.
 *
 * Git is asked about the files in the folder, and by nothing else. Every
 * `GIT_*` variable is taken out of its environment: one of them can point it
 * at another repository or another index (`GIT_DIR`, `GIT_INDEX_FILE`) or
 * hand it settings (`GIT_CONFIG_COUNT`). And the one setting that names a
 * list of ignore rules outside the repository is set to nothing.
 */
export function askGit(root: string, command: string[], timeoutMs: number = GIT_TIMEOUT_MS): string[] | undefined {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const asked = spawnSync("git", ["-c", "core.excludesFile=", ...command, "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env: environment,
  });

  return asked.error === undefined && asked.status === 0 ? asked.stdout.split("\0").filter(Boolean) : undefined;
}

function isUnderRoot(entry: string): boolean {
  return !entry.startsWith("/") && !entry.split("/").includes("..");
}

/**
 * The folders that hold the project's code: every workspace package, and
 * every package the architecture config declares. Nothing in one of them is
 * ever left out for being ignored. Otherwise the one being checked could take
 * a file out of every check with a line in a `.gitignore`, and the file would
 * still be built.
 */
export function listPackageFolders(root: string): string[] {
  const declared = CONFIG_FILES.map((name) => join(root, name)).find((file) => existsSync(file));
  let packages: string[] = [];

  try {
    // Node can `require()` an ES module, so the config is read without waiting.
    packages = declared === undefined ? [] : Object.keys((require(declared) as { default?: { packages?: object } }).default?.packages ?? {});
  } catch {
    // A config that cannot be loaded stops the gates by itself, with its own message.
  }

  return [...new Set([...packages.map((path) => path.replace(/^\.?\/+/, "").replace(/\/+$/, "")), ...discoverWorkspace(root).map(({ path }) => path)])].sort();
}

interface Ignored {
  /** What may be left out: ignored, and neither in a package, nor a package, nor a folder that holds one. */
  skipped: string[];
  /**
   * What git ignores that touches a package, by any rule: a `.gitignore`, the
   * exclude list, a global one. Judged like any other file, and reported by
   * the `ignored-source` gate: other tools (a formatter, a CSS lint) read
   * those rules for themselves and would pass over the file.
   */
  inPackages: string[];
}

/** Asked once for each root in a run: every gate lists files, and the answer does not change under them. */
const IGNORED = new Map<string, Ignored>();

function ignoredUnder(root: string): Ignored {
  let ignored = IGNORED.get(root);

  if (ignored === undefined) {
    // Outside a repository nothing is ignored, and every file is judged.
    const entries = listGitIgnored(root) ?? [];
    const byAnyRule = listGitIgnored(root, "any") ?? [];
    const packages = byAnyRule.length === 0 ? [] : listPackageFolders(root);
    // In a package, the package itself, or a folder that holds one. A link
    // is listed as a file, with no `/`: a package that is a link is still a
    // package. Compared without regard to case, which only ever protects
    // more: on a file system that ignores case the declared name and the
    // name on disk may differ by it.
    const touchesPackage = (entry: string): boolean => {
      const path = entry.replace(/\/$/, "").toLowerCase();

      return packages.some((folder) => {
        const declared = folder.toLowerCase();

        return path === declared || path.startsWith(`${declared}/`) || declared.startsWith(`${path}/`);
      });
    };

    ignored = { skipped: entries.filter((entry) => !touchesPackage(entry)), inPackages: byAnyRule.filter(touchesPackage) };
    IGNORED.set(root, ignored);
  }

  return ignored;
}

/**
 * True when `path` (from `root`) is left out of every check: git ignores it,
 * or a folder it is in, and it is not part of a package. Always false outside
 * a repository.
 */
export function isGitIgnored(root: string, path: string): boolean {
  return isAmong(ignoredUnder(root).skipped, path);
}

function isAmong(ignored: string[], path: string): boolean {
  return ignored.some((entry) => (entry.endsWith("/") ? `${path}/`.startsWith(entry) : entry === path));
}

/**
 * What is left out, as patterns for a tool that takes globs (ESLint's
 * `ignores`): a folder with everything under it, a file by its path, and every
 * character a glob would read as a pattern taken literally. Made from the
 * paths git listed, never from the text of a `.gitignore`.
 */
export function gitIgnoredGlobs(root: string): string[] {
  return ignoredUnder(root).skipped.map((entry) => {
    const literal = entry.replace(/[\\*?[\]{}()!+@]/g, "\\$&");

    return entry.endsWith("/") ? `${literal}**` : literal;
  });
}

const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/;

/**
 * Every file in a package that git ignores, by a rule of the repository's
 * own, outside the installed and generated folders. The gates judge these,
 * so whatever remembers a verdict must read them too (the stop hook's hash
 * does).
 */
export function listIgnoredInPackages(root: string): string[] {
  const packages = listPackageFolders(root).map((folder) => folder.toLowerCase());
  const inPackage = (path: string): boolean => packages.some((folder) => path.toLowerCase().startsWith(`${folder}/`));
  const found = new Set<string>();

  function walk(folder: string): void {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
      } else if (inPackage(path)) {
        found.add(path);
      }
    }
  }

  for (const entry of listGitIgnored(root) ?? []) {
    const path = entry.replace(/\/$/, "");

    if (isGeneratedPath(path)) {
      continue;
    }

    if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory()) {
      walk(path);
    } else if (inPackage(path)) {
      found.add(path);
    }
  }

  return [...found].sort();
}

/**
 * Every code file in a package that git ignores, as paths from `root`: the
 * files themselves, and the ones in an ignored folder. Installed and
 * generated folders are the closed list of what a package may ignore, and
 * nothing in them is listed.
 */
export function listIgnoredCode(root: string): string[] {
  const packages = listPackageFolders(root);
  const inPackage = (path: string): boolean => packages.some((folder) => path.startsWith(`${folder}/`));
  const found = new Set<string>();

  function walk(folder: string): void {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          walk(path);
        }
      } else if (CODE_FILE.test(entry.name) && inPackage(path)) {
        found.add(path);
      }
    }
  }

  for (const entry of ignoredUnder(root).inPackages) {
    if (isGeneratedPath(entry.replace(/\/$/, ""))) {
      continue;
    }

    if (entry.endsWith("/")) {
      walk(entry.slice(0, -1));
    } else if (CODE_FILE.test(entry) && inPackage(entry)) {
      found.add(entry);
    }
  }

  return [...found].sort();
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
