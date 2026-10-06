#!/usr/bin/env node
// Adds the kit or an add-on to a project, or updates the copy it already has.
//
//   node scripts/add-to-project.mts <project> <kit|add-on name> [--force] [--scope @acme]
//   node scripts/add-to-project.mts <project> <add-on name>:<option>
//   node scripts/add-to-project.mts --list
//
// An add-on may offer a choice between sets of starting files (one bot or
// another). `<add-on>:<option>` takes that option, on a first install or to
// switch later; the name alone keeps what the project has.
//
// Run it again after this repository changes and the project gets the newer
// files. A file that was edited in the project is never overwritten unless
// --force is given: the script stops, lists those files, and changes nothing.
//
// A file the project owns (its hook settings, its AGENTS.md, its architecture
// config, an add-on's starting files) is never overwritten at all. When the
// template of one changed, the update says so under "Yours to change": which
// file, what changed, and what to do. See `lib/templates.mts`.
//
// Exit 0: everything went in. Exit 1: refused, and nothing was changed.
// Exit 3: the unit went in, but entries it needs in a host's settings file
// did not, because that file is not JSON or holds a value of another kind
// there. The summary lists them under "Not merged".

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../kit/gates/lib/files.mts";
import { LINT_DEPENDENCIES } from "../kit/lint-dependencies.mts";
import { type Declaration, declarePackages } from "./lib/architecture.mts";
import { type Json, mergeSettings, parseSettings, SettingsError } from "./lib/host-settings.mts";
import {
  assertInside,
  type InstallOutcome,
  InstallError,
  installedChoice,
  installedUnits,
  installFiles,
  isRefusal,
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
/** The kit's checks that `gates/run.mts` does not run: each is a script the project calls. */
const KIT_CHECKS = [
  {
    name: "check:react-policies",
    script: "tools/arch/check-react-policies.mts",
    holds: "every package that imports React is under the lint rules for its role",
  },
  {
    name: "check:compiler",
    script: "tools/arch/check-compiler.mts",
    holds: "the React Compiler still memoizes what a client lists as relying on it",
  },
];

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
  /** `kit`, the name of a folder in `addons/`, or that name with an option of its choice: `ci-security:renovate`. */
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
  /** One line per entry merged into a host's settings file. */
  settingsChanges: string[];
  /** One line per package declared in the architecture config. */
  declared: string[];
  agents: "added" | "updated" | "unchanged" | "none";
  /** Files written once for the project to own: the kit's set-up files, an add-on's starting files. */
  created: string[];
  /** What is still to be done by hand. */
  notes: string[];
  /** Entries a host's settings file needed and did not get, because of what the project's file holds. Each is also a note. */
  unmerged: string[];
  /** The project's own files whose template this update changed. None was touched. */
  yours: OwnedChange[];
  /** Gates this update of the kit brought, each with the options of the architecture config it reads. */
  newGates: { name: string; options: string[] }[];
  /** A command the add-on asks to be run once, after installing and before anything is checked. */
  firstRun?: string;
  verify?: string;
  /** The option of the add-on's choice the project now has. */
  choice?: string;
  /** What the add-on says about that option, in one line. It is where a step for a person is named. */
  choiceSays?: string;
  /** Files of the option the project had before, removed because the project never changed them. */
  choiceRemoved?: string[];
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
  /**
   * Entries to merge into a host's settings file, keyed by the file's path:
   * a hook to register, a permission rule. Merged, never written over: see
   * `lib/host-settings.mts`.
   */
  hostSettings?: Record<string, Json>;
  /**
   * Files an older version of the add-on had the project own and no longer
   * reads, keyed by path. When one is still in the project, the installer
   * says so with `note`, and writes the starting file that took its place
   * (`replacedBy`) if the project does not have it: an update must not leave
   * a setting silently unread.
   */
  retiredFiles?: Record<string, { replacedBy: string; note: string }>;
  /** True for an add-on a new project should take unless it has a reason not to. */
  recommended?: boolean;
  /**
   * Gates the project's copy of the kit must have. An add-on that relies on a
   * gate, or on a role that came with one, is refused by a project whose kit
   * is older, with the command that brings the kit up to date.
   */
  requiresGates?: string[];
  /**
   * The workspace packages the add-on brings, each with its declaration for
   * `architecture.config.mts`. Added to the `packages` map, never written
   * over: see `lib/architecture.mts`.
   */
  architecture?: { packages?: Record<string, Declaration> };
  /**
   * Sets of starting files of which a project has exactly one: one update bot
   * or another. An option's files are in `choice/<option>/files/`, and each is
   * a starting file. `options` maps a name to one line that says what it is.
   */
  choice?: Choice;
}

export interface Choice {
  default: string;
  options: Record<string, string>;
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
      settingsChanges: [],
      unmerged: [],
      declared: [],
      // A file the setup has just written from the new template has nothing left to change.
      yours: findOwnedChanges(destination, KIT_TEMPLATES, templatesBefore, outcome.written).filter(({ owned }) => !setup.created.includes(owned)),
      // A project whose kit had no list has nothing to compare with: every gate would read as new.
      newGates: gatesBefore === undefined ? [] : Object.entries(gatesNow).flatMap(([name, options]) => (name in gatesBefore ? [] : [{ name, options }])),
      ...setup,
    };
  }

  return addAddon(destination, project, unit, force, scope, repository);
}

/** `ci-security:renovate` → the add-on and the option asked for. */
export function parseUnit(unit: string): { name: string; option?: string } {
  const at = unit.indexOf(":");

  return at === -1 ? { name: unit } : { name: unit.slice(0, at), option: unit.slice(at + 1) };
}

function addAddon(destination: string, project: string, asked: string, force: boolean, scope: string | undefined, repository: string): AddResult {
  const { name: unit, option } = parseUnit(asked);
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
  assertKitHasGates(destination, project, manifest);

  const packagePlan = planPackageChanges(destination, manifest, force);
  const settingsPlan = planHostSettings(destination, manifest);
  const architecturePlan = planArchitecture(destination, manifest);
  const source = join(addon, "files");
  const files = existsSync(source) ? rewriteScope(readFileSet(source, ""), STARTER_SCOPE, projectScope) : new Map<string, Buffer>();
  const starting = takeStartingFiles(files, manifest.startingFiles ?? []);
  const firstTime = !installedUnits(destination).includes(unit);
  const readOption = (name: string): Map<string, Buffer> => rewriteScope(readFileSet(join(addon, "choice", name, "files"), ""), STARTER_SCOPE, projectScope);

  // A project that has the add-on and no recorded option took it before the
  // choice existed, and so has what is now the default.
  const chosen = chooseOption(manifest, option, installedChoice(destination, unit));
  const previous = firstTime ? undefined : (installedChoice(destination, unit) ?? manifest.choice?.default);
  const optionFiles = chosen === undefined ? new Map<string, Buffer>() : readOption(chosen);
  const left = previous === undefined || previous === chosen ? [] : [...keepTemplates(new Map(), readOption(previous), unit)];

  for (const [path, content] of optionFiles) {
    starting.set(path, content);
  }

  const templates = keepTemplates(files, starting, unit);
  // Read before the update replaces or removes them: the old text is what the project's file is compared with.
  const templatesBefore = readTemplates(destination, [...templates, ...left]);

  for (const path of [...starting.keys(), ...left.map(({ owned }) => owned), ...Object.keys(manifest.retiredFiles ?? {})]) {
    assertInside(destination, path);
  }

  const outcome = installFiles(destination, unit, files, force, chosen);
  const created: string[] = [];
  const choiceRemoved: string[] = [];
  const choiceNotes: string[] = [];

  // The files of the option the project is leaving. One it never changed goes;
  // one it changed is its own work, so it stays and the project is told.
  for (const { owned, template } of left) {
    if (!existsSync(join(destination, owned))) {
      continue;
    }

    const installed = templatesBefore.get(template);

    if (installed === readFileSync(join(destination, owned), "utf8")) {
      rmSync(join(destination, owned));
      choiceRemoved.push(owned);
    } else {
      const why = installed === undefined ? "No copy of it as it was installed is kept here, so whether it was changed cannot be told" : "It was changed in this project";

      choiceNotes.push(
        `${owned} is from the option "${previous}", which "${chosen}" replaces. ${why}, so it was left where it is. Move what you changed to the new option's file, then delete it: while both are there, both options are in force`,
      );
    }
  }

  // Starting files are written the first time. Later, only one the project
  // was never given: the files of an option it moves to, and a file this
  // version of the add-on is the first to ship. The second is told by its
  // template being new here, in a project that already keeps templates; one
  // the project deleted has its template, and is not brought back.
  const keepsTemplates = templatesBefore.size > 0;
  const neverGiven = (path: string): boolean =>
    (previous !== chosen && optionFiles.has(path)) ||
    (keepsTemplates && templates.some(({ owned, template }) => owned === path && !templatesBefore.has(template)));

  for (const [path, content] of starting) {
    if ((firstTime || neverGiven(path)) && !existsSync(join(destination, path))) {
      writeProjectFile(destination, path, content);
      created.push(path);
    }
  }

  const retired: string[] = [];

  for (const [path, { replacedBy, note }] of Object.entries(manifest.retiredFiles ?? {})) {
    if (!existsSync(join(destination, path))) {
      continue;
    }

    const content = starting.get(replacedBy);
    const written = content !== undefined && !existsSync(join(destination, replacedBy));

    if (written) {
      writeProjectFile(destination, replacedBy, content);
      created.push(replacedBy);
    }

    retired.push(`${path} is no longer read: ${replacedBy} took its place${written ? ", and was written as the add-on ships it" : ""}. ${note}`);
  }

  for (const { path, json } of packagePlan.writes) {
    writeProjectFile(destination, path, `${JSON.stringify(json, null, 2)}\n`);
  }

  const section = join(addon, "AGENTS.section.md");
  const agents = existsSync(section)
    ? writeAgentsSection(destination, unit, readFileSync(section, "utf8").replaceAll(`${STARTER_SCOPE}/`, `${projectScope}/`))
    : "none";

  if (architecturePlan.text !== undefined) {
    writeProjectFile(destination, ARCHITECTURE_CONFIG, architecturePlan.text);
  }

  const notes = [
    ...choiceNotes,
    ...architecturePlan.notes,
    ...settingsPlan.unmerged,
    ...retired,
    ...outcome.refused.map(
      (path) => `${path} could not be written: the host this ran under keeps that folder read-only. Outside it, run this script again`,
    ),
  ];
  const settingsChanges: string[] = [];

  for (const { path, content, added } of settingsPlan.writes) {
    if (writeUnlessProtected(destination, path, content)) {
      settingsChanges.push(...added.map((entry) => `${path}: ${entry}`));
    } else {
      notes.push(
        `${path} could not be written: the host this ran under keeps that folder read-only. Outside it, run this script again; until then these are missing there: ${added.join("; ")}`,
      );
    }
  }

  return {
    unit,
    files: outcome,
    packageChanges: packagePlan.changes,
    settingsChanges,
    declared: architecturePlan.declared,
    agents,
    created,
    notes,
    unmerged: settingsPlan.unmerged,
    yours: findOwnedChanges(destination, templates, templatesBefore, outcome.written),
    newGates: [],
    firstRun: manifest.firstRun,
    verify: manifest.verify,
    choice: chosen,
    choiceSays: chosen === undefined ? undefined : manifest.choice?.options[chosen],
    choiceRemoved,
  };
}

/** The option the project gets: the one asked for, else the one it has, else the add-on's default. */
function chooseOption({ name, choice }: AddonManifest, asked: string | undefined, installed: string | undefined): string | undefined {
  if (choice === undefined) {
    if (asked !== undefined) {
      throw new InstallError(`the add-on "${name}" has no options, so "${name}:${asked}" means nothing — add it as "${name}"`);
    }

    return undefined;
  }

  const options = Object.keys(choice.options);

  if (asked !== undefined && !options.includes(asked)) {
    throw new InstallError(`the add-on "${name}" has no option "${asked}" — it has: ${options.join(", ")} (${choice.default} when none is named)`);
  }

  // An option the add-on no longer offers cannot be kept.
  return asked ?? (installed !== undefined && options.includes(installed) ? installed : choice.default);
}

const ARCHITECTURE_CONFIG = "architecture.config.mts";

/**
 * Refuses an add-on the project's kit is too old for. The kit's list of its
 * gates is the one thing a project's copy says about its own age, so that is
 * what an add-on names. Checked before anything is written: an add-on whose
 * role the gates do not know would leave the project unable to run them.
 */
function assertKitHasGates(destination: string, project: string, manifest: AddonManifest): void {
  const wanted = manifest.requiresGates ?? [];
  const has = readGateList(readIfThere(join(destination, GATE_LIST))) ?? {};
  const missing = wanted.filter((gate) => !(gate in has));

  if (missing.length > 0) {
    throw new InstallError(
      `the add-on "${manifest.name}" needs a newer kit than this project has: tools/arch has no ${missing.map((gate) => `"${gate}"`).join(", ")} gate. Nothing was changed. Bring the kit up to date first: add-to-project.mts ${project} kit`,
    );
  }
}

interface ArchitecturePlan {
  /** The config's new text. Undefined when there is nothing to write. */
  text?: string;
  declared: string[];
  notes: string[];
}

/** Works out the entries the architecture config would gain for the packages the add-on brings. */
function planArchitecture(project: string, manifest: AddonManifest): ArchitecturePlan {
  const packages = manifest.architecture?.packages ?? {};

  if (Object.keys(packages).length === 0) {
    return { declared: [], notes: [] };
  }

  assertInside(project, ARCHITECTURE_CONFIG);

  const file = join(project, ARCHITECTURE_CONFIG);
  const { text, added, byHand } = declarePackages(existsSync(file) ? readFileSync(file, "utf8") : "", packages);

  return {
    text,
    declared: added.map((entry) => `${ARCHITECTURE_CONFIG}: packages gains ${entry.replace(/,$/, "")}`),
    notes: byHand.map(
      (entry) =>
        `add ${entry.replace(/,$/, "")} to the packages of ${ARCHITECTURE_CONFIG}: the file has no \`packages: { … }\` map this script can add to, and the structure gate fails on a package that is not declared`,
    ),
  };
}

interface SettingsPlan {
  writes: { path: string; content: string; added: string[] }[];
  /** What a settings file needed and did not get, each with what to add by hand. */
  unmerged: string[];
}

/**
 * Works out what each host settings file would gain. A file that is missing
 * is created with the add-on's entries alone. A file that cannot be read as
 * JSON is left as it is, and a note says what to add by hand: the project's
 * file is never replaced.
 */
function planHostSettings(project: string, manifest: AddonManifest): SettingsPlan {
  const plan: SettingsPlan = { writes: [], unmerged: [] };

  for (const [path, wanted] of Object.entries(manifest.hostSettings ?? {})) {
    assertInside(project, path);

    const file = join(project, path);

    try {
      const current = existsSync(file) ? parseSettings(readFileSync(file, "utf8"), path) : {};
      const { merged, added, skipped } = mergeSettings(current, wanted);

      if (added.length > 0) {
        plan.writes.push({ path, content: `${JSON.stringify(merged, null, 2)}\n`, added });
      }

      plan.unmerged.push(...skipped.map((entry) => `${path}: ${entry}. The project's value was left as it is: correct it by hand, then run this again`));
    } catch (error) {
      if (!(error instanceof SettingsError)) {
        throw error;
      }

      plan.unmerged.push(`${error.message}, so nothing was merged into it. Add by hand: ${JSON.stringify(wanted)}`);
    }
  }

  return plan;
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
    if (isRefusal(error)) {
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

  // A check that is a script of its own runs only where a script calls it,
  // and a project that updates its kit gets the file and no script.
  for (const { name, script, holds } of KIT_CHECKS) {
    if (!Object.values(manifest.scripts ?? {}).some((command) => command.includes(script))) {
      notes.push(
        `add "${name}": "node ${script}" to the scripts, and \`pnpm ${name}\` to gate:fast: it checks that ${holds}, and reports a skip where there is nothing to judge`,
      );
    }
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

const TEXT_STARTING_FILE = /\.(ts|tsx|mts|json|jsonc|json5|md|yaml|yml|html|css)$|(^|\/)\.gitignore$/;

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
  /** The options to choose between, when the add-on has a choice: `<name>:<option>`. */
  choice?: Choice;
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

      return {
        name: entry.name,
        summary: manifest.summary,
        recommended: manifest.recommended === true,
        ...(manifest.choice === undefined ? {} : { choice: manifest.choice }),
      };
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

export function describe(result: AddResult, project: string): string {
  const { files } = result;
  const lines = [
    `${result.unit}: ${files.written.length} file(s) written, ${files.unchanged.length} already up to date, ${files.removed.length} removed`,
    ...(result.choice === undefined ? [] : [`  option   ${result.choice}: ${result.choiceSays ?? ""}`]),
    ...files.written.map((path) => `  wrote    ${path}`),
    ...files.removed.map((path) => `  removed  ${path}`),
    ...files.kept.map((path) => `  kept     ${path} (no longer shipped, but edited in the project)`),
    ...(result.choiceRemoved ?? []).map((path) => `  removed  ${path} (an option this project no longer has; it was never changed here)`),
    ...result.created.map((path) => `  created  ${path}`),
    ...result.packageChanges.map((change) => `  changed  ${change}`),
    ...result.settingsChanges.map((change) => `  merged   ${change}`),
    ...result.declared.map((change) => `  declared ${change}`),
  ];

  if (result.agents === "added" || result.agents === "updated") {
    lines.push(`  ${result.agents === "added" ? "added  " : "updated"}  AGENTS.md: the section for ${result.unit}`);
  }

  if (result.unmerged.length > 0) {
    lines.push("", `Not merged: ${result.unmerged.length} place(s) in a host's settings file. The add-on is not whole until they are (exit 3):`, ...result.unmerged.map((entry) => `  - ${entry}`));
  }

  const notes = result.notes.filter((note) => !result.unmerged.includes(note));

  if (notes.length > 0) {
    lines.push("", "Still to do by hand:", ...notes.map((note) => `  - ${note}`));
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
    "usage: add-to-project.mts <project> <unit>[:<option>] [--force] [--scope @acme]",
    "",
    "units:",
    `  ${KIT.padEnd(12)} the architecture gates, lint rules and hooks (tools/arch)`,
    ...listAddons().flatMap(({ name, summary, recommended, choice }) => [
      `  ${name.padEnd(12)} ${recommended ? "(recommended) " : ""}${summary}`,
      ...Object.entries(choice?.options ?? {}).map(
        ([option, says]) => `  ${"".padEnd(12)}   ${name}:${option}${option === choice?.default ? " (when none is named)" : ""}: ${says}`,
      ),
    ]),
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

    const result = addToProject(options);

    console.log(describe(result, options.project));

    if (result.unmerged.length > 0) {
      process.exit(3);
    }
  } catch (error) {
    console.error(error instanceof InstallError ? error.message : error);
    process.exit(1);
  }
}
