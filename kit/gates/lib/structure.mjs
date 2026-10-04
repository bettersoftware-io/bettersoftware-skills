// Structure gate: the project has the layers it declared, every package has a
// declared role, and a client package holds only its composition root and its
// dumb UI.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { packagesWithRole } from "./config.mjs";
import { isInside, isTestFile, listSourceFiles, matchesName } from "./files.mjs";

const GATE = "structure";

export function checkStructure({ root, config, workspace }) {
  return [
    ...checkEveryPackageIsDeclared(config, workspace),
    ...checkDeclaredPackagesExist(root, config),
    ...checkRequiredRoles(config),
    ...checkPortsFolder(root, config),
    ...checkNpmAllowlists(root, config, workspace),
    ...packagesWithRole(config, "client").flatMap((client) => checkClientLayout(root, client)),
  ];
}

/** Layout findings for some files only — the after-edit path. */
export function checkStructureOfFiles({ root, config }, files) {
  return packagesWithRole(config, "client").flatMap((client) =>
    checkClientLayout(root, client, files.filter((file) => isInside(file, client.path))),
  );
}

function checkEveryPackageIsDeclared(config, workspace) {
  return workspace
    .filter(({ path }) => !config.packages[path])
    .map(({ path, name }) => ({
      gate: GATE,
      file: path,
      message: `${name} has no declared role. A new package is forbidden by default: add "${path}" to architecture.config.mjs with the role it plays.`,
    }));
}

function checkDeclaredPackagesExist(root, config) {
  return Object.keys(config.packages)
    .filter((path) => !existsSync(join(root, path, "package.json")))
    .map((path) => ({
      gate: GATE,
      file: path,
      message: `architecture.config.mjs declares "${path}" but no package lives there.`,
    }));
}

function checkRequiredRoles(config) {
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

function checkPortsFolder(root, config) {
  return packagesWithRole(config, "domain")
    .filter((domain) => existsSync(join(root, domain.path)))
    .filter((domain) => !existsSync(join(root, domain.path, domain.ports)))
    .map((domain) => ({
      gate: GATE,
      file: `${domain.path}/${domain.ports}`,
      message: "The domain has no ports folder. Every interface an adapter implements is declared here, so the domain owns the contract and adapters depend on it.",
    }));
}

function checkNpmAllowlists(root, config, workspace) {
  const workspaceNames = new Set(workspace.map(({ name }) => name));
  const findings = [];

  for (const [path, declaration] of Object.entries(config.packages)) {
    const manifest = join(root, path, "package.json");

    if (!declaration.npm || !existsSync(manifest)) {
      continue;
    }

    const dependencies = Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {});

    for (const dependency of dependencies) {
      if (!workspaceNames.has(dependency) && !declaration.npm.includes(dependency)) {
        findings.push({
          gate: GATE,
          file: `${path}/package.json`,
          message: `"${dependency}" is a runtime dependency, but this package may depend only on [${declaration.npm.join(", ")}]. Move the code that needs it outward, or extend the "npm" list in architecture.config.mjs deliberately.`,
        });
      }
    }
  }

  return findings;
}

function checkClientLayout(root, client, onlyFiles) {
  const source = `${client.path}/src`;
  const app = `${client.path}/${client.app}`;
  const ui = `${client.path}/${client.ui}`;
  const findings = [];

  if (!onlyFiles) {
    for (const [folder, purpose] of [
      [app, "the composition root: the one place that reads configuration and picks adapters"],
      [ui, "the dumb UI: components that render what the view model gives them"],
    ]) {
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
