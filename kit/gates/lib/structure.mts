// Structure gate: the project has the layers it declared, every package has a
// declared role, and a client package holds only its composition root and its
// dumb UI.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type {
  ClientPackage,
  DeclaredPackage,
  Finding,
  Project,
  ResolvedConfig,
  WorkspacePackage,
} from "./config.mts";
import { packagesWithRole } from "./config.mts";
import { isInside, isTestFile, isTestScaffolding, listSourceFiles, matchesName } from "./files.mts";

const GATE = "structure";

export function checkStructure({ root, config, workspace }: Project): Finding[] {
  return [
    ...checkEveryPackageIsDeclared(config, workspace),
    ...checkDeclaredPackagesExist(root, config),
    ...checkRequiredRoles(config),
    ...checkPortsFolder(root, config),
    ...checkNpmAllowlists(root, config, workspace),
    ...packagesWithRole(config, "client").flatMap((client) => checkClientLayout(root, client)),
    ...packagesWithRole(config, "integration").flatMap((integration) => checkHoldsOnlyTests(root, integration)),
    ...packagesWithRole(config, "e2e").flatMap((e2e) => checkHoldsOnlyEndToEndTests(root, e2e)),
  ];
}

/** Layout findings for some files only — the after-edit path. */
export function checkStructureOfFiles({ root, config }: Project, files: string[]): Finding[] {
  return [
    ...packagesWithRole(config, "client").flatMap((client) =>
      checkClientLayout(root, client, files.filter((file) => isInside(file, client.path))),
    ),
    ...packagesWithRole(config, "integration").flatMap((integration) =>
      checkHoldsOnlyTests(root, integration, files.filter((file) => isInside(file, integration.path))),
    ),
    ...packagesWithRole(config, "e2e").flatMap((e2e) =>
      checkHoldsOnlyEndToEndTests(root, e2e, files.filter((file) => isInside(file, e2e.path))),
    ),
  ];
}

function checkEveryPackageIsDeclared(config: ResolvedConfig, workspace: WorkspacePackage[]): Finding[] {
  return workspace
    .filter(({ path }) => !config.packages[path])
    .map(({ path, name }) => ({
      gate: GATE,
      file: path,
      message: `${name} has no declared role. A new package is forbidden by default: add "${path}" to architecture.config.mts with the role it plays.`,
    }));
}

function checkDeclaredPackagesExist(root: string, config: ResolvedConfig): Finding[] {
  return Object.keys(config.packages)
    .filter((path) => !existsSync(join(root, path, "package.json")))
    .map((path) => ({
      gate: GATE,
      file: path,
      message: `architecture.config.mts declares "${path}" but no package lives there.`,
    }));
}

function checkRequiredRoles(config: ResolvedConfig): Finding[] {
  return config.requiredRoles
    .filter((role) => packagesWithRole(config, role).length === 0)
    .map((role) => ({
      gate: GATE,
      message:
        role === "domain"
          ? "No package has the role \"domain\". Entities, use cases and the port interfaces need a package that depends on nothing else."
          : role === "core"
            ? "No package has the role \"core\". Presenters, state machines and adapters need a framework-free package between the domain and the clients."
            : `No package has the role "${role}".`,
    }));
}

function checkPortsFolder(root: string, config: ResolvedConfig): Finding[] {
  return packagesWithRole(config, "domain")
    .filter((domain) => existsSync(join(root, domain.path)))
    .filter((domain) => !existsSync(join(root, domain.path, domain.ports)))
    .map((domain) => ({
      gate: GATE,
      file: `${domain.path}/${domain.ports}`,
      message: "The domain has no ports folder. Every interface an adapter implements is declared here, so the domain owns the contract and adapters depend on it.",
    }));
}

function checkNpmAllowlists(root: string, config: ResolvedConfig, workspace: WorkspacePackage[]): Finding[] {
  const workspaceNames = new Set(workspace.map(({ name }) => name));
  const findings: Finding[] = [];

  for (const [path, declaration] of Object.entries(config.packages)) {
    const manifest = join(root, path, "package.json");

    if (!declaration.npm || !existsSync(manifest)) {
      continue;
    }

    const { dependencies: declaredDependencies } = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(declaredDependencies ?? {});

    for (const dependency of dependencies) {
      if (!workspaceNames.has(dependency) && !declaration.npm.includes(dependency)) {
        findings.push({
          gate: GATE,
          file: `${path}/package.json`,
          message: `"${dependency}" is a runtime dependency, but this package may depend only on [${declaration.npm.join(", ")}]. Move the code that needs it outward, or extend the "npm" list in architecture.config.mts deliberately.`,
        });
      }
    }
  }

  return findings;
}

function checkClientLayout(root: string, client: ClientPackage, onlyFiles?: string[]): Finding[] {
  const source = `${client.path}/src`;
  const app = `${client.path}/${client.app}`;
  const ui = `${client.path}/${client.ui}`;
  const findings: Finding[] = [];

  if (!onlyFiles) {
    const folders: [string, string][] = [
      [app, "the composition root: the one place that reads configuration and picks adapters"],
      [ui, "the dumb UI: components that render what the view model gives them"],
    ];

    for (const [folder, purpose] of folders) {
      if (existsSync(join(root, client.path)) && !existsSync(join(root, folder))) {
        findings.push({ gate: GATE, file: folder, message: `Missing folder. A client has ${purpose}.` });
      }
    }
  }

  const files = onlyFiles ?? listSourceFiles(root, source);

  for (const file of files) {
    // A test sits beside its subject, so it is misplaced only if the subject is.
    if (!isInside(file, source) || isInside(file, app) || isInside(file, ui) || isTestFile(file)) {
      continue;
    }

    const directlyInSource = file.slice(source.length + 1) === basename(file);

    if (directlyInSource && client.entry.some((pattern) => matchesName(basename(file), pattern))) {
      continue;
    }

    findings.push({
      gate: GATE,
      file,
      message: /\.[jt]sx$/.test(file)
        ? `A component outside ${client.ui}. Components live in the UI folder so the dumb-UI rules apply to them.`
        : `Logic in a client package outside ${client.app} and ${client.ui}. Presenters, state machines and adapters belong in the core package, where no framework can reach them; wiring belongs in ${client.app}.`,
    });
  }

  return findings;
}

/**
 * An integration package may import every layer, so it must not become a
 * place to put code the layers forbid. It holds tests and their helpers only.
 */
function checkHoldsOnlyTests(root: string, integration: DeclaredPackage, onlyFiles?: string[]): Finding[] {
  const source = `${integration.path}/src`;

  return (onlyFiles ?? listSourceFiles(root, source))
    .filter((file) => isInside(file, source) && !isTestFile(file))
    .map((file) => ({
      gate: GATE,
      file,
      message:
        "An integration package holds only tests: files named *.test.ts, and helpers in a __testUtils__ folder. This package may import every layer, so production code here would escape every dependency rule. Move the code to the package whose layer it belongs to.",
    }));
}

/**
 * An end-to-end package has three kinds of file, and the lint rules follow
 * the kind: a spec says what happens, a page object knows how the screen is
 * driven, and a `testing` folder holds what both are built on. A file of no
 * kind is under none of those rules, so a spec could reach the browser
 * through it.
 */
function checkHoldsOnlyEndToEndTests(root: string, e2e: DeclaredPackage, onlyFiles?: string[]): Finding[] {
  const source = `${e2e.path}/src`;

  return (onlyFiles ?? listSourceFiles(root, source))
    .filter((file) => isInside(file, source) && !isTestScaffolding(file))
    .map((file) => ({
      gate: GATE,
      file,
      message:
        "An e2e package holds only specs (*.spec.ts), page objects (*.page.ts) and what they are built on, in a testing folder. Each kind has its own lint rules, and this file is of no kind, so none of them reads it. Name it for what it is, or move it into a testing folder.",
    }));
}
