// Loads and normalises the architecture config, the one place a project
// declares which package plays which role. Every gate reads this, so the rules
// follow the declaration and never a hard-coded folder name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type Role = "domain" | "shared" | "core" | "bindings" | "client" | "server" | "leaf" | "integration";

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
];

/**
 * Which roles a package of each role may import. Anything else is forbidden.
 *
 * `integration` is the one role that may import every other: it holds the
 * tests that run two sides against each other (a client adapter against the
 * real server), which no package inside the layers is allowed to do. No role
 * lists it, so nothing can import it, and the structure gate holds it to
 * tests only.
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
};

const CLIENT_DEFAULTS = {
  app: "src/app",
  ui: "src/ui",
  uiBridge: "viewModel",
  entry: ["main.tsx", "main.ts", "*.d.ts", "*.css"],
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
          ? { ports: "src/ports", ...declaration }
          : { ...declaration };
  }

  return {
    root: absoluteRoot,
    config: { ...DEFAULTS, ...declared, packages },
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
export function packagesWithRole(config: ResolvedConfig, role: "domain"): DomainPackage[];
export function packagesWithRole(config: ResolvedConfig, role: Role): DeclaredPackage[];
export function packagesWithRole(config: ResolvedConfig, role: Role): DeclaredPackage[] {
  return declaredPackages(config).filter((declared) => declared.role === role);
}

function stripSlashes(path: string): string {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}
