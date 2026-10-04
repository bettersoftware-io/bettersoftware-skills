// Dependency gate: generates dependency-cruiser rules from the declared roles,
// runs them, and refuses to report a clean result it cannot stand behind.
//
// Two things make a dependency rule silently do nothing, and both are checked:
// a workspace import that resolves to built output (or not at all) never
// matches a source-path rule, and a rule set run over no files passes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Finding, Project, ResolvedConfig, WorkspacePackage } from "./config.mts";
import { declaredPackages, packagesWithRole, ROLE_MAY_IMPORT } from "./config.mts";

const GATE = "dependencies";

interface RulePath {
  path?: string;
  pathNot?: string;
  circular?: boolean;
  dependencyTypes?: string[];
}

export interface Rule {
  name: string;
  severity: "error";
  comment: string;
  from: RulePath;
  to: RulePath;
}

interface CruisedDependency {
  module: string;
  resolved: string;
  couldNotResolve: boolean;
}

interface CruiseReport {
  summary?: { violations?: { from: string; to: string; rule: { name: string } }[] };
  modules?: { source: string; dependencies?: CruisedDependency[] }[];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (paths: string[]): string => `^(${paths.map(escape).join("|")})/`;
const slug = (path: string): string => path.replace(/^.*\//, "");

export function buildRules(config: ResolvedConfig, workspace: WorkspacePackage[]): Rule[] {
  const declared = declaredPackages(config);
  const everyPackage = [...new Set([...declared.map(({ path }) => path), ...workspace.map(({ path }) => path)])];
  const rules: Rule[] = [
    {
      name: "no-circular",
      severity: "error",
      comment: "A circular dependency. Type-only imports are not counted; break the cycle by moving the shared part inward.",
      from: {},
      to: { circular: true },
    },
  ];

  for (const pkg of declared) {
    const allowed = [
      pkg.path,
      ...declared.filter((other) => ROLE_MAY_IMPORT[pkg.role].includes(other.role)).map(({ path }) => path),
      ...(pkg.mayImport ?? []),
    ];

    rules.push({
      name: `${slug(pkg.path)}-imports-inward-only`,
      severity: "error",
      comment: `A ${pkg.role} package may import only: ${allowed.slice(1).join(", ") || "nothing"}. Dependencies point inward; if this code needs something further out, declare an interface here and let the outer package implement it.`,
      from: { path: `^${escape(pkg.path)}/src` },
      to: { path: anyOf(everyPackage), pathNot: anyOf(allowed) },
    });
  }

  for (const domain of packagesWithRole(config, "domain")) {
    rules.push({
      name: `${slug(domain.path)}-no-node-builtins`,
      severity: "error",
      comment: "The domain runs in any JavaScript environment, so its production code uses no Node built-in. Reach the platform through a port.",
      from: { path: `^${escape(domain.path)}/src`, pathNot: "(\\.(test|spec)\\.[cm]?tsx?$|/__tests__/|/__testUtils__/)" },
      to: { dependencyTypes: ["core"] },
    });
  }

  for (const core of packagesWithRole(config, "core")) {
    rules.push({
      name: `${slug(core.path)}-framework-free`,
      severity: "error",
      comment: "The core is framework-free: no UI framework import. That is what lets a second client, or a different framework, reuse it unchanged.",
      from: { path: `^${escape(core.path)}/src` },
      to: { path: `node_modules/(${config.frameworks.map(escape).join("|")})/` },
    });
  }

  for (const client of packagesWithRole(config, "client")) {
    const ui = `^${escape(`${client.path}/${client.ui}`)}/`;
    const tests = "(\\.(test|spec)\\.[cm]?tsx?$|/__tests__/)";

    rules.push({
      name: `${slug(client.path)}-ui-never-imports-app`,
      severity: "error",
      comment: "The UI imports the composition root. Wiring flows one way: the root builds the view model and hands it to the UI.",
      from: { path: ui, pathNot: tests },
      to: { path: `^${escape(`${client.path}/${client.app}`)}/` },
    });

    if (config.adapters.length > 0) {
      rules.push({
        name: `${slug(client.path)}-ui-never-imports-adapters`,
        severity: "error",
        comment: "The UI imports an adapter. Only the composition root picks adapters; the UI reaches data through the view model.",
        from: { path: ui, pathNot: tests },
        to: { path: anyOf(config.adapters) },
      });
    }
  }

  return rules;
}

/** The project's own dependency-cruiser if it has one, else the one beside these gates. */
function locateDependencyCruiser(root: string): string | undefined {
  for (const start of [root, dirname(fileURLToPath(import.meta.url))]) {
    for (let directory = start; ; directory = dirname(directory)) {
      const manifest = join(directory, "node_modules", "dependency-cruiser", "package.json");

      if (existsSync(manifest)) {
        const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> };
        const script = typeof bin === "string" ? bin : (bin.depcruise ?? Object.values(bin)[0]);

        if (script) {
          return join(dirname(manifest), script);
        }
      }

      if (directory === dirname(directory)) {
        break;
      }
    }
  }

  return undefined;
}

export function checkDependencies({ root, config, workspace }: Project): Finding[] {
  const cruiser = locateDependencyCruiser(root);

  if (!cruiser) {
    return [{ gate: GATE, message: "dependency-cruiser is not installed, so the dependency rules were not checked. That is no verdict, not a pass: add it as a dev dependency." }];
  }

  const targets = Object.keys(config.packages).filter((path) => existsSync(join(root, path)));

  if (targets.length === 0) {
    return [{ gate: GATE, message: "No declared package exists on disk, so there was nothing to check." }];
  }

  const scratch = mkdtempSync(join(tmpdir(), "arch-gates-"));

  try {
    const paths: Record<string, string[]> = {};

    for (const { path, name } of workspace) {
      paths[name] = [`${path}/src/index.ts`];
      paths[`${name}/*`] = [`${path}/src/*`];
    }

    // Read for module resolution only. TypeScript still wants one input file.
    const tsconfig = join(scratch, "tsconfig.json");
    writeFileSync(join(scratch, "empty.ts"), "export {};\n");
    writeFileSync(
      tsconfig,
      JSON.stringify({ compilerOptions: { baseUrl: root, paths, ignoreDeprecations: "6.0" }, files: ["empty.ts"] }),
    );

    const rules = buildRules(config, workspace);
    const configFile = join(scratch, ".dependency-cruiser.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        forbidden: rules,
        options: {
          tsPreCompilationDeps: false,
          tsConfig: { fileName: tsconfig },
          doNotFollow: { path: "node_modules" },
          exclude: { path: `(${anyOf(workspace.map(({ path }) => path)).slice(1, -1)}/dist/|\\.turbo|/coverage/|/reports/)` },
          enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "node", "default"] },
        },
      }),
    );

    const run = spawnSync(process.execPath, [cruiser, "--config", configFile, "--output-type", "json", ...targets], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

    let report: CruiseReport;

    try {
      report = JSON.parse(run.stdout) as CruiseReport;
    } catch {
      return [{ gate: GATE, message: `dependency-cruiser did not produce a report, so there is no verdict.\n${(run.stderr || run.stdout).trim().slice(0, 600)}` }];
    }

    return [...findDormantRules(report, workspace), ...toFindings(report, rules)];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function toFindings(report: CruiseReport, rules: Rule[]): Finding[] {
  const commentOf = new Map(rules.map((rule) => [rule.name, rule.comment]));

  return (report.summary?.violations ?? []).map((violation) => ({
    gate: GATE,
    file: violation.from,
    message: `${violation.rule.name}: imports ${violation.to}. ${commentOf.get(violation.rule.name) ?? ""}`.trim(),
  }));
}

/** A workspace import that does not land in that package's source makes every path rule blind to it. */
function findDormantRules(report: CruiseReport, workspace: WorkspacePackage[]): Finding[] {
  const modules = report.modules ?? [];

  if (modules.length === 0) {
    return [{ gate: GATE, message: "dependency-cruiser read no files, so the rules checked nothing." }];
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const module of modules) {
    for (const dependency of module.dependencies ?? []) {
      const owner = workspace.find(({ name }) => dependency.module === name || dependency.module.startsWith(`${name}/`));

      if (!owner) {
        continue;
      }

      const landsInSource = !dependency.couldNotResolve && dependency.resolved.startsWith(`${owner.path}/`) && !dependency.resolved.includes("/dist/");

      if (!landsInSource && !seen.has(dependency.module)) {
        seen.add(dependency.module);
        findings.push({
          gate: GATE,
          file: module.source,
          message: `The import "${dependency.module}" resolved to "${dependency.resolved}", not to ${owner.path}/src. Rules about ${owner.path} cannot see this edge, so a clean result here would mean nothing. Check that the package has src/index.ts.`,
        });
      }
    }
  }

  return findings;
}
