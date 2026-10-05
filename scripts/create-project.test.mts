import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createProject, ProjectError } from "./create-project.mts";

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
