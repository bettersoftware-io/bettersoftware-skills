import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const addon = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(addon, "addon.json"), "utf8")) as {
  packageJson: { ".": { scripts: Record<string, string>; devDependencies: Record<string, string> } };
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  verify: string;
};
const { scripts, devDependencies } = manifest.packageJson["."];

describe("the add-on as shipped", () => {
  it("has the file every script runs", () => {
    for (const command of Object.values(scripts)) {
      expect(existsSync(join(addon, "files", command.replace(/^node /, "")))).toBe(true);
    }
  });

  it("joins every script to gate:fast, and verifies with all of them", () => {
    const commands = Object.keys(scripts).map((name) => `pnpm ${name}`);

    expect(manifest.gates).toEqual({ fast: commands, full: [] });
    expect(manifest.verify).toBe(commands.join(" && "));
  });

  it("ships the project's two settings files as starting files, as JSON a tool can read", () => {
    expect(manifest.startingFiles).toEqual(["tools/repo-hygiene/syncpack.json", "tools/repo-hygiene/stylelint.json"]);

    for (const file of manifest.startingFiles) {
      expect(() => JSON.parse(readFileSync(join(addon, "files", file), "utf8")) as unknown).not.toThrow();
    }
  });

  it("keeps the stylelint rules for itself, in a base the project's file extends", () => {
    expect(manifest.startingFiles).not.toContain("tools/repo-hygiene/stylelint.base.json");
    expect(existsSync(join(addon, "files/tools/repo-hygiene/stylelint.base.json"))).toBe(true);
  });

  it("installs every package the stylelint base extends or loads, in the range this repository tests with", () => {
    const base = JSON.parse(readFileSync(join(addon, "files/tools/repo-hygiene/stylelint.base.json"), "utf8")) as { extends: string[]; plugins: string[] };
    const tested = (JSON.parse(readFileSync(join(addon, "..", "..", "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies;
    const needed = ["stylelint", ...base.extends, ...base.plugins];

    expect(base.plugins.length).toBeGreaterThan(0);
    expect(base.extends.length).toBeGreaterThan(0);
    expect(needed.map((name) => [name, devDependencies[name]])).toEqual(needed.map((name) => [name, tested[name]]));
    expect(needed.filter((name) => devDependencies[name] === undefined)).toEqual([]);
  });

  it("lists its dev dependencies in the order a sorted package.json has them", () => {
    expect(Object.keys(devDependencies)).toEqual(Object.keys(devDependencies).sort());
  });
});
