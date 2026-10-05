import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createProject, parseArguments, ProjectError, type ProjectSteps } from "./create-project.mts";

describe("creating a project from the starter", () => {
  it("copies the starter and names the root package after the target folder", () => {
    const { destination: project } = createProject({ target: createTarget("price-desk") });

    expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).name).toBe("price-desk");
    expect(existsSync(join(project, "packages/domain/src/ports/pricePort.ts"))).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(project, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(project, ".codex/hooks.json"))).toBe(true);
  });

  it("puts a real copy of the kit at tools/arch, without the kit's own tests and fixtures", () => {
    const { destination: project } = createProject({ target: createTarget("price-desk") });
    const kit = join(project, "tools/arch");

    expect(lstatSync(kit).isSymbolicLink()).toBe(false);
    expect(existsSync(join(kit, "gates/run.mts"))).toBe(true);
    expect(existsSync(join(kit, "hooks/after-edit.mts"))).toBe(true);
    expect(existsSync(join(kit, "eslint-rules/newspaper-order.mts"))).toBe(true);
    expect(existsSync(join(kit, "gates/fixtures"))).toBe(false);
    expect(listFiles(kit).filter((file) => file.endsWith(".test.mts"))).toEqual([]);
  });

  it("leaves out anything installed or generated", () => {
    const { destination: project } = createProject({ target: createTarget("price-desk") });

    expect(listFiles(project).filter((file) => /\/(node_modules|dist|\.turbo)\//.test(file))).toEqual([]);
  });

  it("renames the package scope everywhere, the lockfile included", () => {
    const { destination: project } = createProject({ target: createTarget("price-desk"), scope: "@acme" });
    const withOldScope = listFiles(project)
      .filter((file) => !file.includes("/tools/"))
      .filter((file) => readFileSync(file, "utf8").includes("@app/"));

    expect(withOldScope).toEqual([]);
    expect(readFileSync(join(project, "packages/domain/package.json"), "utf8")).toContain('"@acme/domain"');
    expect(readFileSync(join(project, "pnpm-lock.yaml"), "utf8")).toContain("'@acme/domain'");
  });

  it("refuses a target that already holds files", () => {
    const target = createTarget("taken");

    writeFileSync(join(target, "notes.txt"), "mine");

    expect(() => createProject({ target })).toThrow(ProjectError);
    expect(readdirSync(target)).toEqual(["notes.txt"]);
  });

  it("adds the add-ons asked for, in the order given", () => {
    const added: string[] = [];
    const { addons } = createProject(
      { target: createTarget("price-desk"), addons: ["coverage", "format-lint"] },
      createStepsThatRecord(added),
    );

    expect(added).toEqual(["coverage", "format-lint"]);
    expect(addons).toEqual(["coverage", "format-lint"]);
  });

  it("adds every recommended add-on when asked for the recommended set, and no other", () => {
    const added: string[] = [];

    createProject({ target: createTarget("price-desk"), addons: ["recommended"] }, createStepsThatRecord(added));

    expect(added).toEqual(["coverage", "format-lint"]);
  });

  it("lists what each add-on asks to be run once, in order, for the person to run after installing", () => {
    const { firstRuns } = createProject(
      { target: createTarget("price-desk"), addons: ["coverage", "format-lint"] },
      { ...createStepsThatRecord([]), addAddon: (_project, name) => (name === "format-lint" ? { firstRun: "pnpm biome:fix" } : {}) },
    );

    expect(firstRuns).toEqual(["pnpm biome:fix"]);
  });

  it("adds none unless asked", () => {
    const added: string[] = [];

    createProject({ target: createTarget("price-desk") }, createStepsThatRecord(added));

    expect(added).toEqual([]);
  });

  it("refuses an add-on that does not exist before writing anything, and names the ones that do", () => {
    const target = createTarget("price-desk");
    const create = (): unknown => createProject({ target, addons: ["coverge"] }, createStepsThatRecord([]));

    expect(create).toThrow(/"coverge" is not an add-on.*coverage, format-lint, visual/s);
    expect(readdirSync(target)).toEqual([]);
  });

  it("reads the choice from the command line as one list", () => {
    expect(parseArguments(["desk", "--with", "coverage,format-lint"]).addons).toEqual(["coverage", "format-lint"]);
    expect(parseArguments(["desk", "--with", "recommended"]).addons).toEqual(["recommended"]);
    expect(parseArguments(["desk"]).addons).toBeUndefined();
  });

  it("has nothing left for a person to do after a normal run", () => {
    expect(createProject({ target: createTarget("price-desk") }).notes).toEqual([]);
  });

  it("passes on what the kit's setup could not do", () => {
    const { notes } = createProject({ target: createTarget("price-desk") }, { installKit: () => ({ notes: ["copy the hook file yourself"] }) });

    expect(notes).toEqual(["copy the hook file yourself"]);
  });

  it("leaves nothing behind in a folder that was empty, when a step fails", () => {
    const target = createTarget("half-made");

    expect(() => createProject({ target }, { installKit: failToInstall })).toThrow(/removed what it had written.*disk full/s);
    expect(readdirSync(target)).toEqual([]);
  });

  it("removes a folder it made itself, when a step fails", () => {
    const target = join(createTarget("parent"), "half-made");

    expect(() => createProject({ target }, { installKit: failToInstall })).toThrow(ProjectError);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a scope or a name that is not a valid package name", () => {
    expect(() => createProject({ target: createTarget("ok"), scope: "acme" })).toThrow(/not a package scope/);
    expect(() => createProject({ target: createTarget("ok"), name: "My App" })).toThrow(/not a package name/);
  });
});

/** Steps with three add-ons to choose from, two of them recommended, that record what was added. */
function createStepsThatRecord(added: string[]): Partial<ProjectSteps> {
  return {
    listAddons: () => [
      { name: "coverage", summary: "", recommended: true },
      { name: "format-lint", summary: "", recommended: true },
      { name: "visual", summary: "", recommended: false },
    ],
    addAddon: (_project, name) => {
      added.push(name);

      return {};
    },
  };
}

function failToInstall(): never {
  throw new Error("disk full");
}

/** An empty folder with the given name, inside a fresh temporary folder. */
function createTarget(name: string): string {
  const target = join(mkdtempSync(join(tmpdir(), "create-project-")), name);

  mkdirSync(target);

  return target;
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}
