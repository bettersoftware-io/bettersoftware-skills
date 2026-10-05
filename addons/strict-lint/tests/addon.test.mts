import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkTypes, formatResult } from "../files/tools/strict-lint/check-types.mts";
import { ADDON, copyInto, createProject, readManifest, REAL_TOOL_TIMEOUT, REPOSITORY, TOOLS } from "./support.mts";

describe("what the add-on adds to package.json", () => {
  it("joins gate:fast with both checks, and verifies with the same two", () => {
    const { gates, verify } = readManifest();

    expect(gates.fast).toEqual(["pnpm lint:types", "pnpm lint:dead"]);
    expect(gates.full).toEqual([]);
    expect(verify).toBe("pnpm lint:types && pnpm lint:dead");
  });

  it("adds one script for each check, each run by plain node", () => {
    expect(readManifest().packageJson["."]?.scripts).toEqual({
      "lint:types": `node ${TOOLS}/check-types.mts`,
      "lint:dead": `node ${TOOLS}/check-dead.mts`,
    });
  });

  it("adds knip and nothing else, at the range this repository installs and these tests ran", () => {
    const repository = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { devDependencies: Record<string, string> };

    expect(readManifest().packageJson["."]?.devDependencies).toEqual({ knip: repository.devDependencies.knip });
  });
});

describe("the files the add-on ships", () => {
  it("gives the project the two configs to keep, and keeps the rules for itself", () => {
    expect(readManifest().startingFiles).toEqual([`${TOOLS}/eslint.config.mts`, `${TOOLS}/knip.jsonc`]);

    for (const name of ["eslint.config.mts", "knip.jsonc", "eslint.typed.base.mts", "check-types.mts", "check-dead.mts"]) {
      expect(existsSync(join(ADDON, "files", TOOLS, name)), name).toBe(true);
    }
  });

  it("ships no JavaScript file, and nothing outside tools/", () => {
    const shipped = readdirSync(join(ADDON, "files"), { recursive: true, encoding: "utf8" });

    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.filter((path) => /\.(js|mjs|cjs|jsx)$/.test(path))).toEqual([]);
    expect(shipped.filter((path) => path !== "tools" && !path.startsWith("tools/"))).toEqual([]);
  });
});

describe("the starter and the other add-ons", { timeout: REAL_TOOL_TIMEOUT }, () => {
  // This repository does not install the starter's dependencies, so in these
  // two tests an import of `rxjs` or of `@app/domain` has no type and the
  // promise rules see little. What they do prove is that every TypeScript
  // file a new project has is in a tsconfig.json: one that is not is a finding.

  /** What scripts/create-project.mts leaves out of the starter. */
  const NOT_COPIED = new Set(["node_modules", "dist", "coverage", ".turbo", "tools", ".claude", ".codex"]);

  it("has every TypeScript file of the starter in a tsconfig.json", () => {
    const result = checkTypes(createStarter(NOT_COPIED));

    expect(result.findings).toEqual([]);
    expect(formatResult(result)).toMatch(/^PASS lint:types — [5-9]\d file\(s\)/);
  });

  it("has every TypeScript file the visual add-on puts in a package in a tsconfig.json", () => {
    const project = createStarter(NOT_COPIED);

    const before = checkTypes(project).files;

    copyInto(project, join(REPOSITORY, "addons", "visual", "files"));

    const result = checkTypes(project);

    expect(existsSync(join(project, "packages/client-react/tests/visual/scenarios.ts"))).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.files).toBeGreaterThan(before);
  });
});

/** A project made from the starter, with the kit where the starter's ESLint config expects it. */
function createStarter(notCopied: ReadonlySet<string>): string {
  const project = createProject();

  copyInto(project, join(REPOSITORY, "starter"), notCopied);
  copyInto(join(project, "tools", "arch"), join(REPOSITORY, "kit"), new Set(["fixtures", "node_modules"]));

  return project;
}
