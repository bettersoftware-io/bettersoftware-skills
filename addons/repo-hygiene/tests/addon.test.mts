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

  it("ships each settings file as a starting file, as JSON a tool can read", () => {
    expect(manifest.startingFiles).toEqual(["tools/repo-hygiene/syncpack.json", "tools/repo-hygiene/stylelint.json"]);

    for (const file of manifest.startingFiles) {
      expect(() => JSON.parse(readFileSync(join(addon, "files", file), "utf8")) as unknown).not.toThrow();
    }
  });

  it("installs the package the stylelint settings extend", () => {
    const settings = JSON.parse(readFileSync(join(addon, "files/tools/repo-hygiene/stylelint.json"), "utf8")) as { extends: string[] };

    expect(Object.keys(devDependencies)).toEqual(expect.arrayContaining(settings.extends));
  });

  it("lists its dev dependencies in the order a sorted package.json has them", () => {
    expect(Object.keys(devDependencies)).toEqual(Object.keys(devDependencies).sort());
  });
});
