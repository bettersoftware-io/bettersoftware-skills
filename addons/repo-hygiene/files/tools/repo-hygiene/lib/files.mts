// Which files the hygiene checks read. Node built-ins only.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Folders that hold only installed or generated files. A closed list on
// purpose: skipping every dot-folder would let a file in `.github/` slip past
// the checks.
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

/**
 * The folder of installed tooling: the kit and the add-ons. The project does
 * not own those files (an update replaces them), so a finding in one is not
 * the project's to fix, and the project's lint leaves the folder out too. A
 * link that points into it is still checked.
 */
export const INSTALLED_TOOLING = "tools";

/**
 * Every file under `root` whose name matches, as paths from `root`. Leaves out
 * installed and generated folders, the installed tooling, and any folder that
 * is a checkout of its own (a git worktree, a nested clone).
 */
export function listFiles(root: string, matching: RegExp): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && path !== INSTALLED_TOOLING && !existsSync(join(root, path, ".git"))) {
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

/**
 * `files` without the ones git ignores. A file git ignores is not part of the
 * repository: nobody else has it, and CI never sees it, so a finding in it
 * would fail here and pass there. Outside a git repository nothing is dropped.
 */
export function dropIgnored(root: string, files: string[]): string[] {
  if (files.length === 0) {
    return files;
  }

  const asked = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: root,
    input: files.join("\0"),
    encoding: "utf8",
  });

  // 0: some are ignored, and are listed. 1: none is. Anything else: git is
  // missing or this is not a repository.
  if (asked.status !== 0) {
    return files;
  }

  const ignored = new Set(asked.stdout.split("\0"));

  return files.filter((file) => !ignored.has(file));
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
