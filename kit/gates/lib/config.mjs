// Loads and normalises `architecture.config.mjs`, the one place a project
// declares which package plays which role. Every gate reads this, so the rules
// follow the declaration and never a hard-coded folder name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"domain" | "shared" | "core" | "bindings" | "client" | "server" | "leaf"} Role
 *
 * @typedef {object} PackageDeclaration
 * @property {Role} role
 * @property {string[]} [npm] Closed list of runtime npm dependencies.
 * @property {string[]} [mayImport] Extra workspace package paths this one may import.
 * @property {string} [ports] domain only: folder holding the port interfaces.
 * @property {string} [app] client only: the composition root folder.
 * @property {string} [ui] client only: the dumb-UI folder.
 * @property {string} [uiBridge] client only: subfolder of `ui` allowed to touch the stream library.
 * @property {string[]} [entry] client only: files allowed directly in `src`.
 *
 * @typedef {object} ArchitectureConfig
 * @property {Record<string, PackageDeclaration>} packages Keyed by path from the repo root.
 * @property {string[]} [adapters] Folders whose modules implement ports.
 * @property {string[]} [streamLibraries] Banned from the UI. A trailing `/` means "any package under this scope".
 * @property {string[]} [frameworks] npm packages the core must never import.
 * @property {Role[]} [requiredRoles]
 * @property {Record<string, string>} [contractExempt] Port name → the reason it has no contract test.
 */

export const ROLES = ["domain", "shared", "core", "bindings", "client", "server", "leaf"];

/** Which roles a package of each role may import. Anything else is forbidden. */
export const ROLE_MAY_IMPORT = {
  domain: [],
  leaf: [],
  shared: ["domain", "leaf"],
  core: ["domain", "shared", "leaf"],
  bindings: ["core", "domain", "leaf"],
  client: ["bindings", "core", "domain", "leaf"],
  server: ["domain", "shared", "leaf"],
};

const DEFAULTS = {
  streamLibraries: ["rxjs", "@react-rxjs/", "@rx-state/"],
  frameworks: ["react", "react-dom", "react-native", "solid-js", "vue", "svelte"],
  requiredRoles: ["domain", "core"],
  adapters: [],
  contractExempt: {},
};

const CLIENT_DEFAULTS = {
  app: "src/app",
  ui: "src/ui",
  uiBridge: "viewModel",
  entry: ["main.tsx", "main.ts", "*.d.ts", "*.css"],
};

export class ConfigError extends Error {}

/** @returns {Promise<{ root: string, config: Required<ArchitectureConfig>, workspace: { path: string, name: string }[] }>} */
export async function loadConfig(root, configFile = "architecture.config.mjs") {
  const absoluteRoot = resolve(root);
  const file = resolve(absoluteRoot, configFile);

  if (!existsSync(file)) {
    throw new ConfigError(
      `no ${configFile} in ${absoluteRoot} — the gates cannot judge a project that has not declared its layers`,
    );
  }

  const declared = (await import(pathToFileURL(file).href)).default;

  if (!declared || typeof declared.packages !== "object") {
    throw new ConfigError(`${configFile} must default-export an object with a "packages" map`);
  }

  const packages = {};

  for (const [path, declaration] of Object.entries(declared.packages)) {
    if (!ROLES.includes(declaration.role)) {
      throw new ConfigError(
        `${configFile}: "${path}" has role "${declaration.role}" — expected one of ${ROLES.join(", ")}`,
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
export function discoverWorkspace(root) {
  const manifest = join(root, "pnpm-workspace.yaml");

  if (!existsSync(manifest)) {
    return [];
  }

  const patterns = [];
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

  const found = [];

  for (const pattern of patterns) {
    const directories = pattern.endsWith("/*")
      ? listDirectories(root, pattern.slice(0, -2))
      : [stripSlashes(pattern)];

    for (const path of directories) {
      const packageJson = join(root, path, "package.json");

      if (existsSync(packageJson)) {
        found.push({ path, name: JSON.parse(readFileSync(packageJson, "utf8")).name ?? path });
      }
    }
  }

  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function listDirectories(root, parent) {
  const directory = join(root, parent);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => `${stripSlashes(parent)}/${entry.name}`);
}

export function packagesWithRole(config, role) {
  return Object.entries(config.packages)
    .filter(([, declaration]) => declaration.role === role)
    .map(([path, declaration]) => ({ path, ...declaration }));
}

function stripSlashes(path) {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}
