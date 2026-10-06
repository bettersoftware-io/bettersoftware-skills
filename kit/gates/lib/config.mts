// Loads and normalises the architecture config, the one place a project
// declares which package plays which role. Every gate reads this, so the rules
// follow the declaration and never a hard-coded folder name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Role = "domain" | "shared" | "core" | "bindings" | "client" | "server" | "leaf" | "integration" | "e2e";

export interface PackageDeclaration {
  role: Role;
  /** Closed list of runtime npm dependencies. */
  npm?: string[];
  /** Extra workspace package paths this one may import. */
  mayImport?: string[];
  /** domain only: folder holding the port interfaces. */
  ports?: string;
  /** client only: the composition root folder. */
  app?: string;
  /** client only: the dumb-UI folder. */
  ui?: string;
  /** client only: subfolder of `ui` allowed to touch the stream library. */
  uiBridge?: string;
  /** client only: files allowed directly in `src`. */
  entry?: string[];
  /** client only: the file in `ui` that holds every test id. */
  testIds?: string;
  /** client only: the build runs the React Compiler, so the lint bans manual memoization. */
  reactCompiler?: boolean;
  /** client only: what relies on the compiler to memoize. `check-compiler.mts` holds the compiler to each. */
  compilerTracked?: CompilerTracked[];
  /** Production code here uses no Node built-in. On by default for a domain. */
  noNodeBuiltins?: boolean;
  /** This package exports types and no runtime value. */
  typesOnly?: boolean;
  /** core only: the files that may import an adapter, to re-export it. */
  mayImportAdapters?: string[];
  /** core only: the function that builds the whole application. */
  compose?: string;
  /** core only: the one test helper that may call `compose`. */
  appHarness?: string;
}

export interface CompilerTracked {
  /** From the package's folder. */
  file: string;
  /** The component or hook, by name. */
  fn: string;
  /** Values in it that must each be memoized. Without them: the function memoizes at least `minMemoValues` values. */
  values?: string[];
  /** Default 1. */
  minMemoValues?: number;
}

export interface ArchitectureConfig {
  /** Keyed by path from the repo root. */
  packages: Record<string, PackageDeclaration>;
  /** Folders whose modules implement ports. */
  adapters?: string[];
  /** Banned from the UI. A trailing `/` means "any package under this scope". */
  streamLibraries?: string[];
  /** npm packages the core must never import. */
  frameworks?: string[];
  requiredRoles?: Role[];
  /** Port name → the reason it has no contract test. */
  contractExempt?: Record<string, string>;
  /** "typescript" (the default) fails on any JavaScript source file. */
  language?: "typescript" | "javascript";
  /** JavaScript file → the reason its loader cannot read TypeScript. */
  javascriptAllowed?: Record<string, string>;
  /** The files that tell an agent how to work here. Every path they name must exist. */
  instructionFiles?: string[];
  /** Cached task → the reason its result cannot depend on another package's source. */
  tasksThatReadNothingUpstream?: Record<string, string>;
  /** Package path → the reason it has no `test` script. */
  packagesWithoutTests?: Record<string, string>;
  /** npm package → the only packages that may import it. A trailing `/` means "any package under this scope". */
  vendorOnlyIn?: Record<string, string[]>;
  /** Package path → the reason it imports React and gets none of the lint rules a client or the bindings get. */
  reactWithoutPolicies?: Record<string, string>;
}

export type ResolvedConfig = Required<ArchitectureConfig>;

export interface DeclaredPackage extends PackageDeclaration {
  path: string;
}

export interface DomainPackage extends DeclaredPackage {
  ports: string;
}

export interface ClientPackage extends DeclaredPackage {
  app: string;
  ui: string;
  uiBridge: string;
  entry: string[];
  testIds: string;
}

export interface CorePackage extends DeclaredPackage {
  mayImportAdapters: string[];
  compose: string;
  appHarness: string;
}

export interface WorkspacePackage {
  path: string;
  name: string;
}

export interface Project {
  root: string;
  config: ResolvedConfig;
  workspace: WorkspacePackage[];
}

export interface Finding {
  gate: string;
  file?: string;
  line?: number;
  message: string;
}

export const ROLES: readonly Role[] = [
  "domain",
  "shared",
  "core",
  "bindings",
  "client",
  "server",
  "leaf",
  "integration",
  "e2e",
];

/**
 * Which roles a package of each role may import. Anything else is forbidden.
 *
 * `integration` is the one role that may import every other: it holds the
 * tests that run two sides against each other (a client adapter against the
 * real server), which no package inside the layers is allowed to do. No role
 * lists it, so nothing can import it, and the structure gate holds it to
 * tests only.
 *
 * `e2e` is the other end: it drives the built application from outside, in a
 * browser, so it imports no layer at all. The one file of the application it
 * may read is a client's test-ids file, which the dependency gate adds by
 * name. An import that names only types is not an edge, so the types of the
 * wire protocol stay within reach.
 */
export const ROLE_MAY_IMPORT: Record<Role, readonly Role[]> = {
  domain: [],
  leaf: [],
  shared: ["domain", "leaf"],
  core: ["domain", "shared", "leaf"],
  bindings: ["core", "domain", "leaf"],
  client: ["bindings", "core", "domain", "leaf"],
  server: ["domain", "shared", "leaf"],
  integration: ["domain", "shared", "core", "bindings", "client", "server", "leaf"],
  e2e: [],
};

/** Tried in order. A TypeScript project declares its layers in TypeScript. */
export const CONFIG_FILES = ["architecture.config.mts", "architecture.config.mjs"];

const DEFAULTS: Omit<ResolvedConfig, "packages"> = {
  streamLibraries: ["rxjs", "@react-rxjs/", "@rx-state/"],
  frameworks: ["react", "react-dom", "react-native", "solid-js", "vue", "svelte"],
  requiredRoles: ["domain", "core"],
  adapters: [],
  contractExempt: {},
  language: "typescript",
  javascriptAllowed: {},
  instructionFiles: ["AGENTS.md", "CLAUDE.md"],
  tasksThatReadNothingUpstream: {},
  packagesWithoutTests: {},
  vendorOnlyIn: {},
  reactWithoutPolicies: {},
};

const CLIENT_DEFAULTS = {
  app: "src/app",
  ui: "src/ui",
  uiBridge: "viewModel",
  entry: ["main.tsx", "main.ts", "*.d.ts", "*.css"],
  testIds: "testids.ts",
};

// The entry re-exports the adapters for the client's composition root. Nothing
// else in a core names one: the application is handed its ports.
const CORE_DEFAULTS = {
  mayImportAdapters: ["src/index.ts"],
  compose: "createApp",
  appHarness: "src/testing/appHarness.ts",
};

export class ConfigError extends Error {}

export async function loadConfig(root: string, configFile?: string): Promise<Project> {
  const absoluteRoot = resolve(root);
  const candidates = configFile ? [configFile] : CONFIG_FILES;
  const found = candidates.find((candidate) => existsSync(resolve(absoluteRoot, candidate)));

  if (!found) {
    throw new ConfigError(
      `no ${candidates.join(" or ")} in ${absoluteRoot} — the gates cannot judge a project that has not declared its layers`,
    );
  }

  const module: { default?: ArchitectureConfig } = await import(pathToFileURL(resolve(absoluteRoot, found)).href);
  const declared = module.default;

  if (!declared || typeof declared.packages !== "object") {
    throw new ConfigError(`${found} must default-export an object with a "packages" map`);
  }

  const packages: Record<string, PackageDeclaration> = {};

  for (const [path, declaration] of Object.entries(declared.packages)) {
    if (!ROLES.includes(declaration.role)) {
      throw new ConfigError(
        `${found}: "${path}" has role "${declaration.role}" — expected one of ${ROLES.join(", ")}`,
      );
    }

    packages[stripSlashes(path)] =
      declaration.role === "client"
        ? { ...CLIENT_DEFAULTS, ...declaration }
        : declaration.role === "domain"
          ? { ports: "src/ports", noNodeBuiltins: true, ...declaration }
          : declaration.role === "core"
            ? { ...CORE_DEFAULTS, ...declaration }
            : { ...declaration };
  }

  return {
    root: absoluteRoot,
    config: {
      ...DEFAULTS,
      ...declared,
      packages,
      packagesWithoutTests: withPlainPaths(declared.packagesWithoutTests ?? {}),
      reactWithoutPolicies: withPlainPaths(declared.reactWithoutPolicies ?? {}),
      vendorOnlyIn: Object.fromEntries(
        Object.entries(declared.vendorOnlyIn ?? {}).map(([vendor, paths]) => [vendor, paths.map(stripSlashes)]),
      ),
    },
    workspace: discoverWorkspace(absoluteRoot),
  };
}

/** Every workspace package on disk, from `pnpm-workspace.yaml`. */
export function discoverWorkspace(root: string): WorkspacePackage[] {
  const manifest = join(root, "pnpm-workspace.yaml");

  if (!existsSync(manifest)) {
    return [];
  }

  const patterns: string[] = [];
  let inPackages = false;

  for (const line of readFileSync(manifest, "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
    } else if (inPackages && /^\s+-\s+/.test(line)) {
      patterns.push(line.replace(/^\s+-\s+/, "").replace(/["']/g, "").trim());
    } else if (/^\S/.test(line)) {
      inPackages = false;
    }
  }

  const found: WorkspacePackage[] = [];

  for (const pattern of patterns) {
    const directories = pattern.endsWith("/*")
      ? listDirectories(root, pattern.slice(0, -2))
      : [stripSlashes(pattern)];

    for (const path of directories) {
      const packageJson = join(root, path, "package.json");

      if (existsSync(packageJson)) {
        const { name } = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string };

        found.push({ path, name: name ?? path });
      }
    }
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function listDirectories(root: string, parent: string): string[] {
  const directory = join(root, parent);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `${stripSlashes(parent)}/${entry.name}`);
}

export function declaredPackages(config: ResolvedConfig): DeclaredPackage[] {
  return Object.entries(config.packages).map(([path, declaration]) => ({ path, ...declaration }));
}

export function packagesWithRole(config: ResolvedConfig, role: "client"): ClientPackage[];
export function packagesWithRole(config: ResolvedConfig, role: "core"): CorePackage[];
export function packagesWithRole(config: ResolvedConfig, role: "domain"): DomainPackage[];
export function packagesWithRole(config: ResolvedConfig, role: Role): DeclaredPackage[];
export function packagesWithRole(config: ResolvedConfig, role: Role): DeclaredPackage[] {
  return declaredPackages(config).filter((declared) => declared.role === role);
}

function withPlainPaths<T>(byPath: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(byPath).map(([path, value]) => [stripSlashes(path), value]));
}

function stripSlashes(path: string): string {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}
