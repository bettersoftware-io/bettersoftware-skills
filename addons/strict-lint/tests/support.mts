// Fixture factories shared by the strict-lint add-on's tests.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { RunTool, ToolRun } from "../files/tools/strict-lint/lib/run.mts";

export const ADDON = join(import.meta.dirname, "..");
export const REPOSITORY = join(ADDON, "..", "..");
export const TOOLS = "tools/strict-lint";

/** A case that starts the real ESLint or knip: on a busy machine that is longer than vitest's default five seconds. */
export const REAL_TOOL_TIMEOUT = 60_000;

const SHIPPED = ["eslint.config.mts", "eslint.typed.base.mts", "knip.jsonc"];

export interface Manifest {
  packageJson: Record<string, { scripts?: Record<string, string>; devDependencies?: Record<string, string> }>;
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  verify: string;
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as Manifest;
}

/** A fresh folder holding `files` (path → content). */
export function createFolder(files: Record<string, string> = {}): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "strict-lint-addon-")));

  writeFiles(folder, files);

  return folder;
}

export function writeFiles(folder: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
}

/**
 * A project that has just received the add-on and can run the real tools: the
 * shipped configs under tools/strict-lint, this repository's node_modules (by
 * a link, so ESLint, typescript-eslint and knip are the versions installed
 * here), a root ESLint config with no rule of its own, and `files`.
 */
export function createProject(files: Record<string, string> = {}): string {
  const project = createFolder({
    "eslint.config.mts": "export default [];\n",
    "tsconfig.tooling.json": createTsconfig(["*.mts"]),
    ...Object.fromEntries(SHIPPED.map((name) => [`${TOOLS}/${name}`, readFileSync(join(ADDON, "files", TOOLS, name), "utf8")])),
    ...files,
  });

  symlinkSync(join(REPOSITORY, "node_modules"), join(project, "node_modules"), "dir");

  return project;
}

/** Copies a folder of this repository into a project, leaving out what a created project never receives. */
export function copyInto(project: string, source: string, skipped: ReadonlySet<string> = new Set()): void {
  cpSync(source, project, { recursive: true, filter: (path) => !skipped.has(basename(path)) });
}

/** A tsconfig.json that includes `include`, strict, with no library beyond the language's own. */
export function createTsconfig(include: string[]): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023"],
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
      },
      include,
    },
    null,
    2,
  )}\n`;
}

export function createPackageJson(manifest: Record<string, unknown>): string {
  return `${JSON.stringify({ private: true, type: "module", ...manifest }, null, 2)}\n`;
}

export function createToolRun(overrides: Partial<ToolRun> = {}): ToolRun {
  return { status: 0, stdout: "", stderr: "", ...overrides };
}

export interface FakeTools {
  run: RunTool;
  /** Every call made, as `name arg arg`. */
  calls: string[];
}

/** Stands in for the installed tools: every call gets `answer`. */
export function createFakeTools(answer: Partial<ToolRun> = {}): FakeTools {
  const calls: string[] = [];

  return {
    calls,
    run: (name, args) => {
      calls.push([name, ...args].join(" "));

      return createToolRun(answer);
    },
  };
}
