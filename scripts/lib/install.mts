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
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** Files replaced under `--force` whose content now has a place in the project's own files, each with where the project's version was kept. */
  saved: { path: string; copy: string }[];
}

/**
 * A file of the unit that projects used to edit, and the file of the project's
 * own where those edits go now. See `movedToProject` in an add-on's manifest.
 */
export interface Handover {
  /** The project's own file that took over what was edited. */
  to: string;
  /** One sentence for the person: what belongs in `to`. */
  note: string;
}

/** Where the project's version of a file is kept when `--force` replaces it. Flat and `.txt`, like a template: no tool reads it as source. */
export function savedCopyOf(unit: string, path: string): string {
  return `tools/templates/${unit}.replaced.${path.replaceAll("/", "__")}.txt`;
}

interface InstalledRecord {
  [unit: string]: {
    files: Record<string, string>;
    /** The option of the add-on's choice the project has, when the add-on offers one. */
    choice?: string;
    /**
     * The starting files the project has been given, or told of: every one
     * the unit shipped at its last update. A starting file that is not here
     * is new to the project; one that is here and gone was deleted by it.
     */
    starting?: string[];
  };
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

const TEXT_FILE = /\.(ts|tsx|mts|json|json5|md|yaml|yml|html|css)$|^\.gitignore$/;

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

    rewritten.set(path, TEXT_FILE.test(name) ? Buffer.from(renameScope(name, content.toString("utf8"), from, to)) : content);
  }

  return rewritten;
}

/**
 * One text file with the scope replaced. A package.json also gets its
 * dependencies back in name order: the files here are written in order for
 * the starter's scope, and another scope sorts elsewhere (`@zeta/shared`
 * comes after `@playwright/test`, `@app/shared` before it).
 */
export function renameScope(fileName: string, text: string, from: string, to: string): string {
  const renamed = text.replaceAll(`${from}/`, `${to}/`);

  return fileName === "package.json" && renamed !== text ? sortDependencies(renamed) : renamed;
}

/** The maps of a package.json that hold dependencies. The tools that compare versions want each in name order. */
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** Name order as package managers write it: by character code, so every `@scope/…` comes before a plain name. */
export function byName([a]: [string, unknown], [b]: [string, unknown]): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The text of a package.json with each dependency map in name order. A file
 * already in order, or one that is not a JSON object, comes back as it was,
 * byte for byte: only a file that needs it is written again.
 */
export function sortDependencies(text: string): string {
  let manifest: unknown;

  try {
    manifest = JSON.parse(text);
  } catch {
    return text;
  }

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return text;
  }

  const sorted = manifest as Record<string, unknown>;
  let moved = false;

  for (const map of DEPENDENCY_MAPS) {
    const entries = sorted[map];

    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
      continue;
    }

    const names = Object.keys(entries);
    const inOrder = Object.entries(entries).sort(byName);

    if (inOrder.some(([name], index) => name !== names[index])) {
      sorted[map] = Object.fromEntries(inOrder);
      moved = true;
    }
  }

  return moved ? `${JSON.stringify(sorted, null, 2)}\n` : text;
}

/**
 * Installs `files` as the unit `unit` (the kit, or an add-on's name), replacing
 * whatever that unit installed before. `choice` is the option of the add-on's
 * choice the project has from now on, recorded beside the files.
 */
export function installFiles(
  project: string,
  unit: string,
  files: FileSet,
  force = false,
  choice?: string,
  handovers: Record<string, Handover> = {},
): InstallOutcome {
  const record = readRecord(project);
  const before = record[unit]?.files ?? {};
  const conflicts: string[] = [];
  /** Files the project changed that `--force` is about to replace. */
  const edited: string[] = [];
  const outcome: InstallOutcome = { written: [], unchanged: [], removed: [], kept: [], refused: [], saved: [] };

  // Both lists of paths are checked before anything is touched. The record is
  // a file in the project, so it is input like any other: a path in it that
  // leaves the project must never reach `rmSync`.
  for (const path of [...files.keys(), ...Object.keys(before), RECORD, ...Object.keys(handovers).map((path) => savedCopyOf(unit, path))]) {
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
    } else if (current === before[path]) {
      outcome.written.push(path);
    } else if (force) {
      outcome.written.push(path);
      edited.push(path);
    } else {
      conflicts.push(path);
    }
  }

  if (conflicts.length > 0) {
    throw new InstallError(
      [
        `${conflicts.length} file(s) in the project differ from what was installed and would be overwritten:`,
        ...conflicts.flatMap((path) => [`  ${path}`, ...describeHandover(unit, path, handovers[path])]),
        "Nothing was changed. Move your edits out of these files, or pass --force to replace them.",
      ].join("\n"),
    );
  }

  // Before anything is replaced: the project's version of a file whose edits
  // have a new home is kept, so `--force` costs no work and needs no git.
  for (const path of edited.filter((candidate) => handovers[candidate] !== undefined)) {
    const copy = savedCopyOf(unit, path);

    writeProjectFile(project, copy, readFileSync(join(project, path)));
    outcome.saved.push({ path, copy });
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
    // Written with every install, so an update that names no option must pass the one the project has.
    ...(choice === undefined ? {} : { choice }),
    // Kept through the install: it is read after it, to tell a new starting file from a deleted one.
    ...(record[unit]?.starting === undefined ? {} : { starting: record[unit].starting }),
  };
  writeRecord(project, record);

  return outcome;
}

/** What a refusal says under a file whose edits have a place in the project's own files. Nothing for any other file. */
function describeHandover(unit: string, path: string, handover: Handover | undefined): string[] {
  if (handover === undefined) {
    return [];
  }

  return [
    `      What a project changes in this file now goes in ${handover.to}, which is the project's own: no update replaces it. ${handover.note}`,
    `      Run this again with --force. It replaces this file, keeps your version as ${savedCopyOf(unit, path)},`,
    `      and writes ${handover.to} if the project has none. Then move your lines from the copy into ${handover.to}, and delete the copy.`,
  ];
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

/**
 * Writes a file in one step: the content goes to a new file beside it, which
 * then takes its place. A reader sees the old file or the new one, never a
 * part of either, and a write that fails leaves the old file as it was. The
 * file keeps its permissions, and one that may not be written is refused.
 */
export function replaceProjectFile(project: string, path: string, content: string): void {
  assertInside(project, path);

  const target = join(project, path);
  const beside = `${target}.${process.pid}.new`;

  mkdirSync(dirname(target), { recursive: true });

  // A file its owner made read-only is refused, as writing into it would be: taking its place would get round that.
  if (existsSync(target)) {
    accessSync(target, constants.W_OK);
  }

  try {
    writeFileSync(beside, content, { flag: "wx", mode: existsSync(target) ? statSync(target).mode : 0o644 });
    renameSync(beside, target);
  } catch (error) {
    rmSync(beside, { force: true });

    throw error;
  }
}

export function installedUnits(project: string): string[] {
  return Object.keys(readRecord(project));
}

/** The option the project has of a unit's choice. Undefined: none was ever recorded. */
export function installedChoice(project: string, unit: string): string | undefined {
  return readRecord(project)[unit]?.choice;
}

/** The starting files the project was given or told of at the unit's last update. Undefined: the record is from before that was kept. */
export function installedStarting(project: string, unit: string): string[] | undefined {
  return readRecord(project)[unit]?.starting;
}

/** Records the starting files the unit ships now. Called after an install, which made the unit's entry. */
export function recordStarting(project: string, unit: string, starting: string[]): void {
  const record = readRecord(project);
  const entry = record[unit];

  if (entry !== undefined && JSON.stringify(entry.starting) !== JSON.stringify(starting)) {
    record[unit] = { ...entry, starting };
    writeRecord(project, record);
  }
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
