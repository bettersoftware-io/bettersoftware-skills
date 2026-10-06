#!/usr/bin/env node
// Adds the kit or an add-on to a project, or updates the copy it already has.
//
//   node scripts/add-to-project.mts <project> <kit|add-on name> [--force] [--scope @acme]
//   node scripts/add-to-project.mts --list
//
// Run it again after this repository changes and the project gets the newer
// files. A file that was edited in the project is never overwritten unless
// --force is given: the script stops, lists those files, and changes nothing.
//
// A file the project owns (its hook settings, its AGENTS.md, its architecture
// config, an add-on's starting files) is never overwritten at all. When the
// template of one changed, the update says so under "Yours to change": which
// file, what changed, and what to do. See `lib/templates.mts`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../kit/gates/lib/files.mts";
import { LINT_DEPENDENCIES } from "../kit/lint-dependencies.mts";
import {
  assertInside,
  type InstallOutcome,
  InstallError,
  installedUnits,
  installFiles,
  readFileSet,
  rewriteScope,
  writeProjectFile,
} from "./lib/install.mts";
import { describeOwnedChange, findOwnedChanges, type OwnedChange, readTemplates, type Template } from "./lib/templates.mts";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const STARTER_SCOPE = "@app";

/** The kit installs under this name; every other unit is an add-on. */
export const KIT = "kit";

/** What setting up the kit may create or edit, beyond the kit's own files. */
const KIT_SETUP_FILES = ["architecture.config.mts", ".claude/settings.json", ".codex/hooks.json", "package.json"];

/**
 * The files of a project that were written from a template the kit ships, and
 * where the kit keeps its copy of each template. The first two copies are the
 * hook files the kit has always installed. The last two have a source outside
 * `kit/`, and are added to the kit's files under the name given.
 */
const KIT_TEMPLATES: (Template & { source?: string })[] = [
  { owned: ".claude/settings.json", template: "tools/arch/hooks/claude.settings.json" },
  { owned: ".codex/hooks.json", template: "tools/arch/hooks/codex.hooks.json" },
  { owned: "AGENTS.md", template: "tools/arch/templates/AGENTS.md.txt", source: "starter/AGENTS.md" },
  { owned: "architecture.config.mts", template: "tools/arch/templates/architecture.config.mts.txt", source: "kit/architecture.config.example.mts" },
];

/** The kit's list of its gates, each with the options of `architecture.config.mts` it reads. */
const GATE_LIST = "tools/arch/gates/gates.json";

/** Never copied from the kit: its own tests and the broken projects they run against. */
export const SKIPPED_IN_KIT = /(\.test\.mts$|\/gates\/fixtures(\/|$)|\/architecture\.config\.example\.mts$)/;

export interface AddOptions {
  project: string;
  /** `kit`, or the name of a folder in `addons/`. */
  unit: string;
  force?: boolean;
  /** The project's package scope. Read from its packages when not given. */
  scope?: string;
  /** Where `kit/` and `addons/` are. Defaults to this repository. */
  repository?: string;
}

export interface AddResult {
  unit: string;
  files: InstallOutcome;
  /** One line per change made to a package.json. */
  packageChanges: string[];
  agents: "added" | "updated" | "unchanged" | "none";
  /** Files written once for the project to own: the kit's set-up files, an add-on's starting files. */
  created: string[];
  /** What is still to be done by hand. */
  notes: string[];
  /** The project's own files whose template this update changed. None was touched. */
  yours: OwnedChange[];
  /** Gates this update of the kit brought, each with the options of the architecture config it reads. */
  newGates: { name: string; options: string[] }[];
  /** A command the add-on asks to be run once, after installing and before anything is checked. */
  firstRun?: string;
  verify?: string;
}

interface PackagePatch {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface AddonManifest {
  name: string;
  summary: string;
  packageJson?: Record<string, PackagePatch>;
  gates?: { fast?: string[]; full?: string[] };
  /**
   * Files the project is meant to edit: its scenarios, its goldens, its
   * settings. Written when the add-on is first added, then never touched
   * again, not even by --force. A path ending in `/` names a whole folder.
   */
  startingFiles?: string[];
  verify?: string;
  /**
   * A command to run once after the add-on is installed, before its check: a
   * fixer, for an add-on whose verdict depends on something the installer
   * changes (a package scope of another length moves where a line wraps).
   */
  firstRun?: string;
  /** True for an add-on a new project should take unless it has a reason not to. */
  recommended?: boolean;
}

type PackageJson = Record<string, unknown> & PackagePatch;

const PATCHED_SECTIONS = ["scripts", "dependencies", "devDependencies"] as const;

export function addToProject({ project, unit, force = false, scope, repository = REPOSITORY }: AddOptions): AddResult {
  const destination = resolve(project);

  if (!existsSync(join(destination, "package.json"))) {
    throw new InstallError(`${destination} has no package.json — it is not a project`);
  }

  if (unit === KIT) {
    const files = readFileSet(join(repository, "kit"), "tools/arch", (path) => SKIPPED_IN_KIT.test(path));

    // Everything the setup below may write is checked before the kit goes in.
    for (const path of KIT_SETUP_FILES) {
      assertInside(destination, path);
    }

    const kitScope = scope ?? scopeIfShared(destination);

    for (const { template, source } of KIT_TEMPLATES) {
      if (source !== undefined && existsSync(join(repository, source))) {
        // In the project's scope, so the copy can be compared with the project's file, and taken as it is.
        files.set(template, Buffer.from(readFileSync(join(repository, source), "utf8").replaceAll(`${STARTER_SCOPE}/`, `${kitScope}/`)));
      }
    }

    // Read before the update replaces them: the old text is what the new is compared with.
    const templatesBefore = readTemplates(destination, KIT_TEMPLATES);
    const gatesBefore = readGateList(readIfThere(join(destination, GATE_LIST)));
    const outcome = installFiles(destination, KIT, files, force);
    const gatesNow = readGateList(files.get(GATE_LIST)?.toString("utf8")) ?? {};

    const setup = setUpKit(destination, repository);

    return {
      unit,
      files: outcome,
      agents: "none",
      // A file the setup has just written from the new template has nothing left to change.
      yours: findOwnedChanges(destination, KIT_TEMPLATES, templatesBefore, outcome.written).filter(({ owned }) => !setup.created.includes(owned)),
      // A project whose kit had no list has nothing to compare with: every gate would read as new.
      newGates: gatesBefore === undefined ? [] : Object.entries(gatesNow).flatMap(([name, options]) => (name in gatesBefore ? [] : [{ name, options }])),
      ...setup,
    };
  }

  const addon = join(repository, "addons", unit);

  if (!existsSync(join(addon, "addon.json"))) {
    throw new InstallError(`there is no add-on called "${unit}" — available: ${listAddons(repository).map((entry) => entry.name).join(", ") || "none"}`);
  }

  if (!existsSync(join(destination, "tools", "arch", "gates", "run.mts"))) {
    throw new InstallError(`${destination} does not have the kit (no tools/arch) — add it first: add-to-project.mts ${project} kit`);
  }

  const projectScope = scope ?? detectScope(destination);
  const manifest = JSON.parse(
    readFileSync(join(addon, "addon.json"), "utf8").replaceAll(`${STARTER_SCOPE}/`, `${projectScope}/`),
  ) as AddonManifest;

  // Everything that can refuse is worked out before anything is written.
  assertInside(destination, "AGENTS.md");

  const packagePlan = planPackageChanges(destination, manifest, force);
  const source = join(addon, "files");
  const files = existsSync(source) ? rewriteScope(readFileSet(source, ""), STARTER_SCOPE, projectScope) : new Map<string, Buffer>();
  const starting = takeStartingFiles(files, manifest.startingFiles ?? []);
  const firstTime = !installedUnits(destination).includes(unit);
  const templates = keepTemplates(files, starting, unit);
  const templatesBefore = readTemplates(destination, templates);

  for (const path of starting.keys()) {
    assertInside(destination, path);
  }

  const outcome = installFiles(destination, unit, files, force);
  const created: string[] = [];

  for (const [path, content] of firstTime ? starting : []) {
    if (!existsSync(join(destination, path))) {
      writeProjectFile(destination, path, content);
      created.push(path);
    }
  }

  for (const { path, json } of packagePlan.writes) {
    writeProjectFile(destination, path, `${JSON.stringify(json, null, 2)}\n`);
  }

  const section = join(addon, "AGENTS.section.md");
  const agents = existsSync(section)
    ? writeAgentsSection(destination, unit, readFileSync(section, "utf8").replaceAll(`${STARTER_SCOPE}/`, `${projectScope}/`))
    : "none";

  return {
    unit,
    files: outcome,
    packageChanges: packagePlan.changes,
    agents,
    created,
    notes: [],
    yours: findOwnedChanges(destination, templates, templatesBefore, outcome.written),
    newGates: [],
    firstRun: manifest.firstRun,
    verify: manifest.verify,
  };
}

/**
 * Writes a host's own settings file, unless the host forbids it. Codex's
 * sandbox keeps `.codex` read-only so that an agent cannot install hooks for
 * itself; that is the host's rule to make, so the answer is to say what is
 * left to do, not to fail and not to find another way in.
 */
export function writeUnlessProtected(project: string, path: string, content: string): boolean {
  try {
    writeProjectFile(project, path, content);

    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }

    throw error;
  }
}

/**
 * What the kit needs around it. A project created from the starter has all of
 * it already, so this does nothing there. In any other project it creates the
 * files that are missing, never touches one that exists, and says what is left
 * to do by hand.
 */
function setUpKit(project: string, repository: string): Pick<AddResult, "created" | "notes" | "packageChanges"> {
  const created: string[] = [];
  const notes: string[] = [];
  const packageChanges: string[] = [];

  if (!existsSync(join(project, "architecture.config.mts")) && !existsSync(join(project, "architecture.config.mjs"))) {
    writeProjectFile(project, "architecture.config.mts", readFileSync(join(repository, "kit", "architecture.config.example.mts"), "utf8"));
    created.push("architecture.config.mts");
    notes.push("architecture.config.mts is an example: list this project's own packages in it, each with its role");
  }

  for (const [template, target] of [
    ["claude.settings.json", ".claude/settings.json"],
    ["codex.hooks.json", ".codex/hooks.json"],
  ] as const) {
    const file = join(project, target);
    const source = join(repository, "kit", "hooks", template);

    if (!existsSync(source)) {
      continue;
    }

    if (!existsSync(file)) {
      if (writeUnlessProtected(project, target, readFileSync(source, "utf8"))) {
        created.push(target);
      } else {
        notes.push(
          `${target} could not be written: the host this ran under keeps that folder read-only. Outside it, copy tools/arch/hooks/${template} to ${target}; until then the hooks do not run there`,
        );
      }
    } else if (!readFileSync(file, "utf8").includes("tools/arch/hooks/")) {
      notes.push(`${target} exists and does not run the hooks: merge in the two entries from tools/arch/hooks/${template}`);
    }
  }

  const manifestFile = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PackageJson;

  if (manifest.scripts?.gates === undefined) {
    manifest.scripts = { ...manifest.scripts, gates: "node tools/arch/gates/run.mts" };
    writeProjectFile(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    packageChanges.push("package.json: scripts.gates");
  }

  // The quiet form of a gate the project has. It names the gate and holds no
  // list of its own, so it never needs editing when the gate changes.
  for (const gate of ["gate:fast", "gate:full"]) {
    if (manifest.scripts?.[gate] !== undefined && manifest.scripts[`${gate}:quiet`] === undefined) {
      manifest.scripts = { ...manifest.scripts, [`${gate}:quiet`]: `node tools/arch/gates/quiet.mts ${gate}` };
      writeProjectFile(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
      packageChanges.push(`package.json: scripts.${gate}:quiet`);
    }
  }

  if (manifest.scripts?.["gate:fast"] === undefined) {
    notes.push('add a "gate:fast" script that runs the gates, lint and typecheck: the stop hook runs it, and so should CI');
  }

  if (manifest.devDependencies?.["dependency-cruiser"] === undefined) {
    notes.push("install dependency-cruiser as a dev dependency: the dependencies gate needs it, and reports that it could not run without it");
  }

  // The kit's files are updated here; its dependencies are the project's to
  // install. Each one the project lacks is named, so an update that brings a
  // rule with a new dependency ends in an instruction, not in a lint run that
  // stops.
  for (const { name, version, neededFor } of LINT_DEPENDENCIES) {
    if (manifest.devDependencies?.[name] === undefined) {
      notes.push(
        `install ${name} as a dev dependency (pnpm add -D -w ${name}@${version}): ${neededFor.charAt(0).toLowerCase()}${neededFor.slice(1)} need it, and the lint stops and says so without it`,
      );
    }
  }

  if (!["eslint.config.mts", "eslint.config.ts", "eslint.config.mjs", "eslint.config.js"].some((name) => existsSync(join(project, name)))) {
    notes.push("for the lint rules, add an eslint.config.mts that spreads architectureLint() from ./tools/arch/eslint.config.mts (see tools/arch/README.md)");
  }

  return { created, notes, packageChanges };
}

function readIfThere(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Gate → the options it reads. Undefined when there is no list, or it cannot be read as one. */
function readGateList(text: string | undefined): Record<string, string[]> | undefined {
  try {
    const list: unknown = JSON.parse(text ?? "");

    return typeof list === "object" && list !== null && !Array.isArray(list) ? (list as Record<string, string[]>) : undefined;
  } catch {
    return undefined;
  }
}

/** The project's scope when its packages share one, and the starter's when that cannot be told. */
function scopeIfShared(project: string): string {
  try {
    return detectScope(project);
  } catch {
    return STARTER_SCOPE;
  }
}

/**
 * Adds a copy of each starting file to the add-on's own files, as the template
 * that file was written from. The copy is the add-on's, so an update replaces
 * it, and that is how a later change to a starting file is noticed.
 *
 * The copy's name is flat and ends in `.txt`: no tool reads it as source, and
 * no folder in it can match a line of the project's `.gitignore` (`coverage/`).
 * A file that is not text (a golden image) gets no copy, and no notice.
 */
function keepTemplates(files: Map<string, Buffer>, starting: Map<string, Buffer>, unit: string): Template[] {
  const templates: Template[] = [];

  for (const [owned, content] of starting) {
    if (TEXT_STARTING_FILE.test(owned)) {
      const template = `tools/templates/${unit}.${owned.replaceAll("/", "__")}.txt`;

      files.set(template, content);
      templates.push({ owned, template });
    }
  }

  return templates;
}

const TEXT_STARTING_FILE = /\.(ts|tsx|mts|json|jsonc|md|yaml|yml|html|css)$|(^|\/)\.gitignore$/;

/** Moves the files the project will own out of `files`, and returns them. */
function takeStartingFiles(files: Map<string, Buffer>, patterns: string[]): Map<string, Buffer> {
  const starting = new Map<string, Buffer>();

  for (const [path, content] of files) {
    if (patterns.some((pattern) => (pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern))) {
      starting.set(path, content);
      files.delete(path);
    }
  }

  return starting;
}

export interface ListedAddon {
  name: string;
  summary: string;
  /** Taken unless there is a reason not to. Said by the add-on's own manifest. */
  recommended: boolean;
}

export function listAddons(repository: string = REPOSITORY): ListedAddon[] {
  const root = join(repository, "addons");

  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "addon.json")))
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(join(root, entry.name, "addon.json"), "utf8")) as AddonManifest;

      return { name: entry.name, summary: manifest.summary, recommended: manifest.recommended === true };
    });
}

/** The scope the project's packages share, e.g. `@acme`. */
function detectScope(project: string): string {
  const scopes = new Set<string>();

  for (const directory of expandPackagePath(project, "packages/*")) {
    const { name } = JSON.parse(readFileSync(join(project, directory, "package.json"), "utf8")) as { name?: string };
    const scope = /^(@[^/]+)\//.exec(name ?? "")?.[1];

    if (scope !== undefined) {
      scopes.add(scope);
    }
  }

  if (scopes.size !== 1) {
    throw new InstallError(
      `cannot tell the project's package scope (found ${scopes.size === 0 ? "none" : [...scopes].join(", ")} under packages/) — pass --scope @yours`,
    );
  }

  return [...scopes][0] as string;
}

/** `packages/*` → every folder under `packages/` that holds a package.json. */
/**
 * The section with one entry added. Dependencies are kept in name order, as
 * package managers write them and as tools that compare versions expect;
 * scripts keep the order their author chose.
 */
function withEntry(
  section: (typeof PATCHED_SECTIONS)[number],
  entries: Record<string, string> | undefined,
  key: string,
  value: string,
): Record<string, string> {
  const added = { ...entries, [key]: value };

  if (section === "scripts") {
    return added;
  }

  return Object.fromEntries(Object.entries(added).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function expandPackagePath(project: string, path: string): string[] {
  if (!path.endsWith("/*")) {
    return [path];
  }

  const parent = path.slice(0, -2);
  const directory = join(project, parent);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isDirectory() && existsSync(join(directory, name, "package.json")))
    .map((name) => `${parent}/${name}`);
}

interface PackagePlan {
  /** `path` is the package.json's place in the project. */
  writes: { path: string; json: PackageJson }[];
  changes: string[];
}

function planPackageChanges(project: string, manifest: AddonManifest, force: boolean): PackagePlan {
  const loaded = new Map<string, PackageJson>();
  const changed = new Set<PackageJson>();
  const changes: string[] = [];
  const conflicts: string[] = [];

  function load(directory: string): PackageJson {
    const path = join(directory, "package.json");

    if (!existsSync(join(project, path))) {
      throw new InstallError(`the add-on "${manifest.name}" needs ${path}, which this project does not have`);
    }

    assertInside(project, path);

    if (!loaded.has(path)) {
      loaded.set(path, JSON.parse(readFileSync(join(project, path), "utf8")) as PackageJson);
    }

    return loaded.get(path) as PackageJson;
  }

  for (const [pattern, patch] of Object.entries(manifest.packageJson ?? {})) {
    for (const path of expandPackagePath(project, pattern)) {
      const json = load(path);

      for (const section of PATCHED_SECTIONS) {
        for (const [key, value] of Object.entries(patch[section] ?? {})) {
          const existing = json[section]?.[key];

          if (existing === value) {
            continue;
          }

          if (existing !== undefined && !force) {
            conflicts.push(`${join(path, "package.json")} ${section}.${key} is "${existing}", the add-on wants "${value}"`);
            continue;
          }

          json[section] = withEntry(section, json[section], key, value);
          changed.add(json);
          changes.push(`${join(path, "package.json")}: ${section}.${key}`);
        }
      }
    }
  }

  const root = load(".");

  for (const [gate, commands] of Object.entries({ "gate:fast": manifest.gates?.fast ?? [], "gate:full": manifest.gates?.full ?? [] })) {
    for (const command of commands) {
      const script = root.scripts?.[gate];

      if (script === undefined) {
        throw new InstallError(`the add-on "${manifest.name}" joins "${gate}", which this project's package.json does not have`);
      }

      if (!script.includes(command)) {
        root.scripts = { ...root.scripts, [gate]: `${script} && ${command}` };
        changed.add(root);
        changes.push(`package.json: scripts.${gate} now also runs "${command}"`);
      }
    }
  }

  if (conflicts.length > 0) {
    throw new InstallError(
      [...conflicts, "Nothing was changed. Rename or remove the entry in the project, or pass --force to replace it."].join("\n"),
    );
  }

  return {
    writes: [...loaded].filter(([, json]) => changed.has(json)).map(([path, json]) => ({ path, json })),
    changes,
  };
}

function writeAgentsSection(project: string, unit: string, section: string): AddResult["agents"] {
  const file = join(project, "AGENTS.md");
  const start = `<!-- add-on: ${unit} -->`;
  const end = `<!-- /add-on: ${unit} -->`;
  const block = `${start}\n${section.trim()}\n${end}`;
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  const from = original.indexOf(start);
  const to = original.indexOf(end);

  if (from === -1 || to === -1) {
    writeProjectFile(project, "AGENTS.md", `${original.trimEnd()}${original.trim() === "" ? "" : "\n\n"}${block}\n`);

    return "added";
  }

  const replaced = `${original.slice(0, from)}${block}${original.slice(to + end.length)}`;

  if (replaced === original) {
    return "unchanged";
  }

  writeProjectFile(project, "AGENTS.md", replaced);

  return "updated";
}

function describe(result: AddResult, project: string): string {
  const { files } = result;
  const lines = [
    `${result.unit}: ${files.written.length} file(s) written, ${files.unchanged.length} already up to date, ${files.removed.length} removed`,
    ...files.written.map((path) => `  wrote    ${path}`),
    ...files.removed.map((path) => `  removed  ${path}`),
    ...files.kept.map((path) => `  kept     ${path} (no longer shipped, but edited in the project)`),
    ...result.created.map((path) => `  created  ${path}`),
    ...result.packageChanges.map((change) => `  changed  ${change}`),
  ];

  if (result.agents === "added" || result.agents === "updated") {
    lines.push(`  ${result.agents === "added" ? "added  " : "updated"}  AGENTS.md: the section for ${result.unit}`);
  }

  if (result.notes.length > 0) {
    lines.push("", "Still to do by hand:", ...result.notes.map((note) => `  - ${note}`));
  }

  lines.push(...describeYours(result));

  lines.push("", "Next:", `  cd ${project}`, "  pnpm install");

  for (const command of [result.firstRun, result.verify]) {
    if (command !== undefined) {
      lines.push(`  ${command}`);
    }
  }

  lines.push("  pnpm gate:full");

  return lines.join("\n");
}

/** The section that says what the update left to the project. Empty when it left nothing. */
export function describeYours({ yours, newGates }: Pick<AddResult, "yours" | "newGates">): string[] {
  const entries = [
    ...yours.map(describeOwnedChange),
    ...newGates.map(({ name, options }) => [
      `architecture.config.mts: the kit has a new gate, ${name}. ${
        options.length === 0 ? "It reads no option of this file." : `It reads ${options.join(", ")}: set what this project needs.`
      }`,
      "    tools/arch/README.md says what it fails on. Run pnpm gates to see what it says here.",
    ]),
  ];

  if (entries.length === 0) {
    return [];
  }

  return [
    "",
    "Yours to change. These files are the project's, so the update did not touch them:",
    ...entries.flatMap(([first, ...rest]) => [`  - ${first}`, ...rest.map((line) => `  ${line}`)]),
  ];
}

function parseArguments(argv: string[]): AddOptions {
  const positional = argv.filter((argument, index) => !argument.startsWith("--") && argv[index - 1] !== "--scope");
  const [project, unit] = positional;

  if (project === undefined || unit === undefined) {
    throw new InstallError(usage());
  }

  const scopeAt = argv.indexOf("--scope");

  return { project, unit, force: argv.includes("--force"), scope: scopeAt === -1 ? undefined : argv[scopeAt + 1] };
}

function usage(): string {
  return [
    "usage: add-to-project.mts <project> <unit> [--force] [--scope @acme]",
    "",
    "units:",
    `  ${KIT.padEnd(12)} the architecture gates, lint rules and hooks (tools/arch)`,
    ...listAddons().map(({ name, summary, recommended }) => `  ${name.padEnd(12)} ${recommended ? "(recommended) " : ""}${summary}`),
  ].join("\n");
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);

  if (argv.includes("--list") || argv.length === 0) {
    console.log(usage());
    process.exit(argv.length === 0 ? 1 : 0);
  }

  try {
    const options = parseArguments(argv);

    console.log(describe(addToProject(options), options.project));
  } catch (error) {
    console.error(error instanceof InstallError ? error.message : error);
    process.exit(1);
  }
}
