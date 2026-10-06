// Puts a set of files into a project and remembers what it put there.
//
// The kit and every add-on reach a project the same way: files are copied in,
// and `tools/installed.json` records a hash of each one. The record is what
// makes a later update safe. A file whose hash still matches the record has
// not been touched since it was installed, so a newer version may replace it;
// a file that differs was edited in the project, and is never overwritten
// without `--force`.
//
// Nothing is written until the whole change is known to be free of conflicts.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export class InstallError extends Error {}

/** Path in the project (posix separators) → content to write there. */
export type FileSet = Map<string, Buffer>;

export interface InstallOutcome {
  written: string[];
  unchanged: string[];
  removed: string[];
  /** Files no longer shipped that were edited in the project, so were left alone. */
  kept: string[];
  /** Files in a host's own folder that the host did not let be written. Not recorded, so the next run tries again. */
  refused: string[];
}

interface InstalledRecord {
  [unit: string]: { files: Record<string, string> };
}

const RECORD = "tools/installed.json";

/**
 * Folders a host may keep read-only for whatever runs inside it. Codex's
 * sandbox does so for `.codex` and `.agents`, so that an agent cannot install
 * hooks or skills for itself.
 */
const HOST_FOLDER = /^\.(agents|claude|codex)\//;

/** True when a write failed because the place is read-only for this process. */
export function isRefusal(error: unknown): boolean {
  return ["EPERM", "EACCES", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
}

const TEXT_FILE = /\.(ts|tsx|mts|json|md|yaml|yml|html|css)$|^\.gitignore$/;

export function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Reads every file under `source` into a set keyed by its path under `prefix`. */
export function readFileSet(source: string, prefix: string, skip: (path: string) => boolean = () => false): FileSet {
  const files: FileSet = new Map();

  for (const file of listFiles(source)) {
    if (skip(file)) {
      continue;
    }

    const inProject = join(prefix, relative(source, file)).split(sep).join("/");

    files.set(inProject, readFileSync(file));
  }

  return files;
}

/** Replaces the starter's package scope in every text file of the set. */
export function rewriteScope(files: FileSet, from: string, to: string): FileSet {
  if (from === to) {
    return files;
  }

  const rewritten: FileSet = new Map();

  for (const [path, content] of files) {
    const name = path.slice(path.lastIndexOf("/") + 1);

    rewritten.set(path, TEXT_FILE.test(name) ? Buffer.from(content.toString("utf8").replaceAll(`${from}/`, `${to}/`)) : content);
  }

  return rewritten;
}

/**
 * Installs `files` as the unit `unit` (the kit, or an add-on's name), replacing
 * whatever that unit installed before.
 */
export function installFiles(project: string, unit: string, files: FileSet, force = false): InstallOutcome {
  const record = readRecord(project);
  const before = record[unit]?.files ?? {};
  const conflicts: string[] = [];
  const outcome: InstallOutcome = { written: [], unchanged: [], removed: [], kept: [], refused: [] };

  // Both lists of paths are checked before anything is touched. The record is
  // a file in the project, so it is input like any other: a path in it that
  // leaves the project must never reach `rmSync`.
  for (const path of [...files.keys(), ...Object.keys(before), RECORD]) {
    assertInside(project, path);
  }

  for (const [path, content] of files) {
    const target = join(project, path);

    if (!existsSync(target)) {
      outcome.written.push(path);
      continue;
    }

    const current = hash(readFileSync(target));

    if (current === hash(content)) {
      outcome.unchanged.push(path);
    } else if (current === before[path] || force) {
      outcome.written.push(path);
    } else {
      conflicts.push(path);
    }
  }

  if (conflicts.length > 0) {
    throw new InstallError(
      [
        `${conflicts.length} file(s) in the project differ from what was installed and would be overwritten:`,
        ...conflicts.map((path) => `  ${path}`),
        "Nothing was changed. Move your edits out of these files, or pass --force to replace them.",
      ].join("\n"),
    );
  }

  for (const path of Object.keys(before)) {
    const target = join(project, path);

    if (files.has(path) || !existsSync(target)) {
      continue;
    }

    if (hash(readFileSync(target)) === before[path] || force) {
      rmSync(target);
      outcome.removed.push(path);
    } else {
      outcome.kept.push(path);
    }
  }

  for (const path of outcome.written) {
    try {
      writeProjectFile(project, path, files.get(path) as Buffer);
    } catch (error) {
      // That is the host's rule to make. The rest goes in, and the caller says what is left.
      if (!HOST_FOLDER.test(path) || !isRefusal(error)) {
        throw error;
      }

      outcome.refused.push(path);
    }
  }

  outcome.written = outcome.written.filter((path) => !outcome.refused.includes(path));

  record[unit] = {
    files: Object.fromEntries(
      [...files]
        .filter(([path]) => !outcome.refused.includes(path))
        .map(([path, content]) => [path, hash(content)])
        .sort(),
    ),
  };
  writeRecord(project, record);

  return outcome;
}

/**
 * Throws unless `path` is a plain place inside the project: relative, with no
 * `..`, and with no symbolic link anywhere on the way, the last part included.
 *
 * Links are refused outright instead of being resolved. Resolving asks "where
 * does this lead?", and a link that points at nothing yet has no answer until
 * the write creates its target, outside. Refusing has no such gap.
 */
export function assertInside(project: string, path: string): void {
  const outside = new InstallError(`"${path}" is outside the project, or reaches it through a link — nothing was changed`);
  const parts = path.split(/[\\/]/);

  if (path === "" || isAbsolute(path) || parts.includes("..")) {
    throw outside;
  }

  let current = project;

  for (const part of parts) {
    current = join(current, part);

    const found = lstatSync(current, { throwIfNoEntry: false });

    if (found === undefined) {
      return;
    }

    if (found.isSymbolicLink()) {
      throw outside;
    }
  }
}

/** The only way this installer writes a file: checked, then written. */
export function writeProjectFile(project: string, path: string, content: string | Buffer): void {
  assertInside(project, path);

  const target = join(project, path);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function installedUnits(project: string): string[] {
  return Object.keys(readRecord(project));
}

function readRecord(project: string): InstalledRecord {
  const file = join(project, RECORD);

  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as InstalledRecord) : {};
}

function writeRecord(project: string, record: InstalledRecord): void {
  writeProjectFile(project, RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
