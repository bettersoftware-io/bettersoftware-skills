import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspace, type Project, type ResolvedConfig } from "./lib/config.mts";
import { checkPlaywrightPin, playwrightPinSkipReason } from "./lib/playwright-pin.mts";

describe("the Playwright pin", () => {
  it("passes when every package and every workflow image name one exact version", () => {
    const project = createProject({
      declared: { "packages/client-react": "1.63.0", "packages/e2e": "1.63.0" },
      images: ["v1.63.0-noble", "v1.63.0-noble"],
    });

    expect(checkPlaywrightPin(project)).toEqual([]);
    expect(playwrightPinSkipReason(project)).toBeUndefined();
  });

  it("fails when a workflow's image is another Playwright version, and names the file", () => {
    const findings = checkPlaywrightPin(createProject({ declared: { "packages/e2e": "1.63.0" }, images: ["v1.63.0-noble", "v1.62.1-noble"] }));

    expect(findings.map(({ file }) => file)).toEqual([".github/workflows/workflow-1.yml"]);
    expect(findings[0]?.message).toContain("The container image is Playwright 1.62.1, but @playwright/test is 1.63.0 in packages/e2e/package.json");
    expect(findings[0]?.message).toContain("v1.63.0-…");
  });

  it("fails when the version is a range", () => {
    const findings = checkPlaywrightPin(createProject({ declared: { "packages/e2e": "^1.63.0" }, images: [] }));

    expect(findings.map(({ file, message }) => `${file}: ${message}`)).toEqual([
      expect.stringContaining('packages/e2e/package.json: @playwright/test is "^1.63.0". Write the exact version'),
    ]);
  });

  it("fails when two packages name two versions, and names the second", () => {
    const findings = checkPlaywrightPin(
      createProject({ declared: { "packages/client-react": "1.63.0", "packages/e2e": "1.62.1" }, images: ["v1.63.0-noble"] }),
    );

    expect(findings.map(({ file, message }) => `${file}: ${message}`)).toEqual([
      "packages/e2e/package.json: @playwright/test is 1.62.1 here and 1.63.0 in packages/client-react/package.json. Two versions are two browser builds on one machine: write the same version in both.",
    ]);
  });

  it("fails when another version is installed than the one declared", () => {
    const findings = checkPlaywrightPin(
      createProject({ declared: { "packages/e2e": "1.63.0" }, installed: { "packages/e2e": "1.62.0" }, images: ["v1.63.0-noble"] }),
    );

    expect(findings.map(({ message }) => message)).toEqual(["@playwright/test 1.62.0 is installed but this file says 1.63.0. Run pnpm install."]);
  });

  it("reads the root package.json and a runtime dependency too", () => {
    const project = createProject({ declared: { "": "1.63.0" }, runtime: { "packages/e2e": "1.62.1" }, images: [] });

    expect(checkPlaywrightPin(project).map(({ file }) => file)).toEqual(["packages/e2e/package.json"]);
  });

  it("holds the library to the test runner's version, and names both", () => {
    const project = createProject({ declared: { "packages/e2e": "1.63.0" }, library: { "": "1.62.1" }, images: ["v1.63.0-noble"] });

    expect(checkPlaywrightPin(project).map(({ file, message }) => `${file}: ${message}`)).toEqual([
      "package.json: playwright is 1.62.1 here and @playwright/test is 1.63.0 in packages/e2e/package.json. Two versions are two browser builds on one machine: write the same version in both.",
    ]);
  });

  it("holds a project that uses the library alone: a range, and a workflow image of another version", () => {
    const range = createProject({ declared: {}, library: { "": "^1.63.0" }, images: [] });
    const image = createProject({ declared: {}, library: { "": "1.63.0" }, images: ["v1.62.1-noble"] });

    expect(playwrightPinSkipReason(range)).toBeUndefined();
    expect(checkPlaywrightPin(range).map(({ message }) => message)).toEqual([expect.stringContaining('playwright is "^1.63.0". Write the exact version')]);
    expect(checkPlaywrightPin(image).map(({ message }) => message)).toEqual([
      expect.stringContaining("The container image is Playwright 1.62.1, but playwright is 1.63.0 in package.json"),
    ]);
  });

  it("judged nothing, and says so, when no package asks for Playwright", () => {
    const project = createProject({ declared: {}, images: ["v1.63.0-noble"] });

    expect(checkPlaywrightPin(project)).toEqual([]);
    expect(playwrightPinSkipReason(project)).toBe(
      "no package.json asks for @playwright/test, or for the playwright library, so there was no version to hold",
    );
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ProjectShape {
  /** Package folder ("" for the root) → its @playwright/test dev dependency. */
  declared: Record<string, string>;
  /** Package folder → its @playwright/test runtime dependency. */
  runtime?: Record<string, string>;
  /** Package folder → its dev dependency on the `playwright` library. */
  library?: Record<string, string>;
  /** Package folder → the version in its node_modules. Left out: not installed. */
  installed?: Record<string, string>;
  /** One workflow file per image tag. */
  images: string[];
}

function createProject({ declared, runtime = {}, library = {}, installed = {}, images }: ProjectShape): Project {
  const root = mkdtempSync(join(tmpdir(), "playwright-pin-"));

  scratch.push(root);
  writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeJson(join(root, "packages/domain/package.json"), { name: "domain" });

  for (const directory of new Set([...Object.keys(declared), ...Object.keys(runtime), ...Object.keys(library)])) {
    const devDependencies = {
      ...(declared[directory] === undefined ? {} : { "@playwright/test": declared[directory] }),
      ...(library[directory] === undefined ? {} : { playwright: library[directory] }),
    };

    writeJson(join(root, directory, "package.json"), {
      name: directory || "root",
      devDependencies,
      ...(runtime[directory] === undefined ? {} : { dependencies: { "@playwright/test": runtime[directory] } }),
    });
  }

  for (const [directory, version] of Object.entries(installed)) {
    writeJson(join(root, directory, "node_modules/@playwright/test/package.json"), { version });
  }

  images.forEach((tag, index) => {
    writeFile(join(root, `.github/workflows/workflow-${index}.yml`), `jobs:\n  e2e:\n    container: mcr.microsoft.com/playwright:${tag}\n`);
  });

  // The gate reads the root and the workspace, and nothing of the declared layers.
  return { root, config: { packages: {} } as ResolvedConfig, workspace: discoverWorkspace(root) };
}

function writeJson(file: string, value: unknown): void {
  writeFile(file, JSON.stringify(value));
}

function writeFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
