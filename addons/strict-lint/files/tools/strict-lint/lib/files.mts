// Which files the two checks have to judge. Node built-ins only.

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Folders that hold only installed or generated files. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "reports", ".git", ".turbo"]);

/**
 * The folder of installed tooling: the kit and the add-ons. The project does
 * not own those files (an update replaces them), so neither check judges them.
 */
const INSTALLED_TOOLING = "tools";

const TYPESCRIPT = /\.(ts|tsx|mts)$/;

/**
 * Every TypeScript file under `root` that is the project's own, as paths from
 * `root`. Used to tell a project with nothing to judge from a clean one.
 */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && path !== INSTALLED_TOOLING) {
          walk(path);
        }
      } else if (TYPESCRIPT.test(entry.name)) {
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
 * True when the module at `moduleUrl` is the script Node was asked to run.
 * Compares real paths: reached through a symlink, a naive comparison is false
 * and the script would exit 0 having done nothing.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
