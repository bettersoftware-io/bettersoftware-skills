import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));

// An add-on is a folder. Three other places name each one by hand, and a new
// add-on that is left out of one is not tested in a created project, or not
// found by a reader. Nothing else would say so.
const ADDONS = readdirSync(join(REPOSITORY, "addons"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("every add-on", () => {
  it("is found", () => {
    expect(ADDONS.length).toBeGreaterThanOrEqual(9);
    expect(ADDONS).toContain("e2e");
  });

  it("is in the CI matrix, so a created project is held to its gate with the add-on in", () => {
    const workflow = readFileSync(join(REPOSITORY, ".github/workflows/ci.yml"), "utf8");
    const matrix = /^\s+addon: \[(.+)\]$/m.exec(workflow)?.[1]?.split(",").map((name) => name.trim()) ?? [];

    expect([...matrix].sort()).toEqual(["none", ...ADDONS].sort());
  });

  it("is in the job that creates one project with all of them, under a scope that sorts first and one that sorts last", () => {
    const workflow = readFileSync(join(REPOSITORY, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  project-with-every-add-on:"));
    const together = /^\s+ADDONS: (.+)$/m.exec(job)?.[1]?.split(",") ?? [];
    const scopes = (/^\s+scope: \[(.+)\]$/m.exec(job)?.[1] ?? "").split(",").map((scope) => scope.trim().replaceAll('"', ""));

    expect([...together].sort()).toEqual(ADDONS);
    expect(job).toContain('--with "$ADDONS"');
    expect(job).toContain("run: pnpm gate:full");
    // The `@` names that share a map with the project's own packages (`@playwright`, `@rx-state`, `@types`, `@vitejs`) lie between the two.
    expect(scopes.some((scope) => scope < "@playwright")).toBe(true);
    expect(scopes.some((scope) => scope > "@vitest")).toBe(true);
  });

  it("has a row in the README's table that links to its own README", () => {
    const readme = readFileSync(join(REPOSITORY, "README.md"), "utf8");

    expect(ADDONS.filter((name) => !readme.includes(`| [\`${name}\`](addons/${name}/README.md) |`))).toEqual([]);
  });

  it.each(ADDONS)("%s has the parts the contract names", (name) => {
    const folder = join(REPOSITORY, "addons", name);
    const manifest = JSON.parse(readFileSync(join(folder, "addon.json"), "utf8")) as Record<string, unknown>;

    expect(manifest.name).toBe(name);
    expect(typeof manifest.summary).toBe("string");
    expect(typeof manifest.recommended).toBe("boolean");
    expect(typeof manifest.verify).toBe("string");

    for (const part of ["files", "tests", "README.md", "AGENTS.section.md"]) {
      expect(existsSync(join(folder, part)), `addons/${name}/${part}`).toBe(true);
    }
  });
});
