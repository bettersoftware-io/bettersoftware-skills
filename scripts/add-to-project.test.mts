import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { addToProject, listAddons } from "./add-to-project.mts";
import { InstallError } from "./lib/install.mts";

describe("adding the kit", () => {
  it("copies the kit to tools/arch, without its tests, and records what it installed", () => {
    const { repository, project } = createWorld();

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.written.sort()).toEqual(KIT_FILES);
    expect(existsSync(join(project, "tools/arch/gates/run.test.mts"))).toBe(false);
    expect(existsSync(join(project, "tools/arch/architecture.config.example.mts"))).toBe(false);
    expect(Object.keys(readJson(project, "tools/installed.json").kit.files)).toEqual(KIT_FILES);
  });

  it("replaces an untouched file with the newer version on a second run", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });

    write(repository, "kit/gates/run.mts", "// gates, version 2\n");
    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.written).toEqual(["tools/arch/gates/run.mts"]);
    expect(result.files.unchanged.sort()).toEqual(KIT_FILES.filter((path) => path !== "tools/arch/gates/run.mts"));
    expect(read(project, "tools/arch/gates/run.mts")).toBe("// gates, version 2\n");
  });

  it("refuses to overwrite a file edited in the project, and changes nothing", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/run.mts", "// edited in the project\n");
    write(repository, "kit/gates/run.mts", "// gates, version 2\n");
    write(repository, "kit/hooks/after-edit.mts", "// hook, version 2\n");

    expect(() => addToProject({ project, unit: "kit", repository })).toThrow(/tools\/arch\/gates\/run\.mts/);

    expect(read(project, "tools/arch/gates/run.mts")).toBe("// edited in the project\n");
    expect(read(project, "tools/arch/hooks/after-edit.mts")).toBe("// hook, version 1\n");
  });

  it("overwrites an edited file when forced", () => {
    const { repository, project } = createWorld();
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/run.mts", "// edited in the project\n");
    write(repository, "kit/gates/run.mts", "// gates, version 2\n");

    addToProject({ project, unit: "kit", repository, force: true });

    expect(read(project, "tools/arch/gates/run.mts")).toBe("// gates, version 2\n");
  });

  it("removes a file the kit no longer ships, unless it was edited", () => {
    const { repository, project } = createWorld();
    write(repository, "kit/gates/old.mts", "// dropped later\n");
    write(repository, "kit/gates/older.mts", "// dropped later too\n");
    addToProject({ project, unit: "kit", repository });
    write(project, "tools/arch/gates/older.mts", "// someone still uses this\n");

    rmSync(join(repository, "kit/gates/old.mts"));
    rmSync(join(repository, "kit/gates/older.mts"));
    const result = addToProject({ project, unit: "kit", repository });

    expect(result.files.removed).toEqual(["tools/arch/gates/old.mts"]);
    expect(result.files.kept).toEqual(["tools/arch/gates/older.mts"]);
    expect(existsSync(join(project, "tools/arch/gates/old.mts"))).toBe(false);
    expect(existsSync(join(project, "tools/arch/gates/older.mts"))).toBe(true);
  });

  it("sets up what the kit needs in a project that has none of it, and says what is left", () => {
    const { repository, project } = createWorld();

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual(["architecture.config.mts", ".claude/settings.json", ".codex/hooks.json"]);
    expect(read(project, "architecture.config.mts")).toBe("// the example config\n");
    expect(read(project, ".claude/settings.json")).toContain("tools/arch/hooks/after-edit.mts");
    expect(readJson(project, "package.json").scripts.gates).toBe("node tools/arch/gates/run.mts");
    expect(result.notes.join("\n")).toMatch(/list this project's own packages/);
    expect(result.notes.join("\n")).toMatch(/dependency-cruiser/);
    expect(result.notes.join("\n")).toMatch(/eslint\.config\.mts/);
  });

  it("leaves the project's own settings alone, and says how to merge the hooks in", () => {
    const { repository, project } = createWorld();
    write(project, ".claude/settings.json", '{ "permissions": {} }\n');
    write(project, "architecture.config.mts", "// the project's own config\n");

    const result = addToProject({ project, unit: "kit", repository });

    expect(read(project, ".claude/settings.json")).toBe('{ "permissions": {} }\n');
    expect(read(project, "architecture.config.mts")).toBe("// the project's own config\n");
    expect(result.created).toEqual([".codex/hooks.json"]);
    expect(result.notes.join("\n")).toMatch(/\.claude\/settings\.json exists and does not run the hooks/);
  });

  it("has nothing left to say once the project is set up", () => {
    const { repository, project } = createWorld();
    const manifest = readJson(project, "package.json");
    manifest.devDependencies = { "dependency-cruiser": "^18.0.0" };
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    write(project, "eslint.config.mts", "export default [];\n");
    write(project, "architecture.config.mts", "// the project's own config\n");
    addToProject({ project, unit: "kit", repository });

    const result = addToProject({ project, unit: "kit", repository });

    expect(result.created).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.packageChanges).toEqual([]);
  });

  it("refuses a folder that is not a project", () => {
    const { repository } = createWorld();
    const empty = mkdtempSync(join(tmpdir(), "not-a-project-"));
    onTestFinished(() => {
      rmSync(empty, { recursive: true, force: true });
    });

    expect(() => addToProject({ project: empty, unit: "kit", repository })).toThrow(InstallError);
  });
});

describe("adding an add-on", () => {
  it("copies its files with the project's package scope in place of the starter's", () => {
    const { repository, project } = createWorldWithKit();

    const result = addToProject({ project, unit: "demo", repository });

    expect(result.files.written.sort()).toEqual(["packages/web/tests/demo.ts", "tools/demo/check.mts"]);
    expect(read(project, "packages/web/tests/demo.ts")).toBe('import { thing } from "@acme/web";\n');
    expect(result.verify).toBe("pnpm --filter @acme/web demo");
  });

  it("adds its scripts and dependencies to the root and to every package it names", () => {
    const { repository, project } = createWorldWithKit();

    addToProject({ project, unit: "demo", repository });

    expect(readJson(project, "package.json").scripts.demo).toBe("node tools/demo/check.mts");
    expect(readJson(project, "package.json").devDependencies).toEqual({ "demo-tool": "^1.0.0" });
    expect(readJson(project, "packages/web/package.json").scripts["test:demo"]).toBe("demo --filter @acme/web");
    expect(readJson(project, "packages/api/package.json").scripts["test:demo"]).toBe("demo --filter @acme/web");
  });

  it("joins the project's gates once, however often it is added", () => {
    const { repository, project } = createWorldWithKit();

    addToProject({ project, unit: "demo", repository });
    addToProject({ project, unit: "demo", repository });

    expect(readJson(project, "package.json").scripts["gate:fast"]).toBe("pnpm gates && pnpm lint && pnpm demo");
    expect(readJson(project, "package.json").scripts["gate:full"]).toBe("pnpm gate:fast && pnpm test && pnpm demo:slow");
  });

  it("appends its section to AGENTS.md once, and replaces it when the section changes", () => {
    const { repository, project } = createWorldWithKit();

    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("added");
    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("unchanged");

    write(repository, "addons/demo/AGENTS.section.md", "## Demo\n\nThe second wording.\n");

    expect(addToProject({ project, unit: "demo", repository }).agents).toBe("updated");
    expect(read(project, "AGENTS.md")).toBe(
      "# Working here\n\nThe project's own text.\n\n<!-- add-on: demo -->\n## Demo\n\nThe second wording.\n<!-- /add-on: demo -->\n",
    );
  });

  it("refuses a script the project already defines differently, and changes nothing", () => {
    const { repository, project } = createWorldWithKit();
    const manifest = readJson(project, "package.json");
    manifest.scripts.demo = "echo mine";
    write(project, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/scripts\.demo is "echo mine"/);

    expect(existsSync(join(project, "tools/demo/check.mts"))).toBe(false);
    expect(readJson(project, "package.json").scripts["gate:fast"]).toBe("pnpm gates && pnpm lint");
    expect(read(project, "AGENTS.md")).not.toContain("add-on: demo");
  });

  it("refuses a project that does not have the kit", () => {
    const { repository, project } = createWorld();

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/does not have the kit/);
  });

  it("names the add-ons that exist when asked for one that does not", () => {
    const { repository, project } = createWorldWithKit();

    expect(() => addToProject({ project, unit: "nope", repository })).toThrow(/available: demo/);
    expect(listAddons(repository)).toEqual([{ name: "demo", summary: "A demo add-on." }]);
  });

  it("asks for the scope when the project's packages do not share one", () => {
    const { repository, project } = createWorldWithKit();
    write(project, "packages/api/package.json", '{ "name": "@other/api" }\n');

    expect(() => addToProject({ project, unit: "demo", repository })).toThrow(/pass --scope/);
    expect(addToProject({ project, unit: "demo", repository, scope: "@acme" }).files.written).toHaveLength(2);
  });
});

const KIT_FILES = [
  "tools/arch/gates/run.mts",
  "tools/arch/hooks/after-edit.mts",
  "tools/arch/hooks/claude.settings.json",
  "tools/arch/hooks/codex.hooks.json",
];

function createWorldWithKit(): { repository: string; project: string } {
  const world = createWorld();

  addToProject({ project: world.project, unit: "kit", repository: world.repository });

  return world;
}

/** A small stand-in for this repository, and a project with two packages. */
function createWorld(): { repository: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "add-to-project-"));

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repository = join(root, "repository");
  const project = join(root, "project");

  write(repository, "kit/gates/run.mts", "// gates, version 1\n");
  write(repository, "kit/gates/run.test.mts", "// the kit's own test\n");
  write(repository, "kit/hooks/after-edit.mts", "// hook, version 1\n");
  write(repository, "kit/hooks/claude.settings.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts" }\n');
  write(repository, "kit/hooks/codex.hooks.json", '{ "hooks": "node tools/arch/hooks/after-edit.mts" }\n');
  write(repository, "kit/architecture.config.example.mts", "// the example config\n");
  write(
    repository,
    "addons/demo/addon.json",
    JSON.stringify({
      name: "demo",
      summary: "A demo add-on.",
      packageJson: {
        ".": { scripts: { demo: "node tools/demo/check.mts" }, devDependencies: { "demo-tool": "^1.0.0" } },
        "packages/*": { scripts: { "test:demo": "demo --filter @app/web" } },
      },
      gates: { fast: ["pnpm demo"], full: ["pnpm demo:slow"] },
      verify: "pnpm --filter @app/web demo",
    }),
  );
  write(repository, "addons/demo/files/tools/demo/check.mts", "// the add-on's check\n");
  write(repository, "addons/demo/files/packages/web/tests/demo.ts", 'import { thing } from "@app/web";\n');
  write(repository, "addons/demo/AGENTS.section.md", "## Demo\n\nThe first wording.\n");
  write(repository, "addons/demo/tests/check.test.mts", "// never copied: it is outside files/\n");

  write(
    project,
    "package.json",
    `${JSON.stringify(
      { name: "project", scripts: { "gate:fast": "pnpm gates && pnpm lint", "gate:full": "pnpm gate:fast && pnpm test" } },
      null,
      2,
    )}\n`,
  );
  write(project, "packages/web/package.json", '{ "name": "@acme/web", "scripts": {} }\n');
  write(project, "packages/api/package.json", '{ "name": "@acme/api" }\n');
  write(project, "AGENTS.md", "# Working here\n\nThe project's own text.\n");

  return { repository, project };
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Loosely typed on purpose: each test asserts the shape of the file it reads. */
function readJson(root: string, path: string): any {
  return JSON.parse(read(root, path));
}
