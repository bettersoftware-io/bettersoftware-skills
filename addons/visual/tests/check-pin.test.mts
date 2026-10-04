import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkPin } from "../files/tools/visual/check-pin.mts";

describe("checkPin", () => {
  it("passes when the npm version and every workflow image agree", () => {
    const verdict = checkPin(createProject({ declared: "1.63.0", images: ["v1.63.0-noble", "v1.63.0-noble"] }));

    expect(verdict).toEqual({ exitCode: 0, lines: ["PASS playwright-pin: @playwright/test 1.63.0 and 2 workflow image(s) agree."] });
  });

  it("fails when a workflow's image is another Playwright version, and names the file", () => {
    const verdict = checkPin(createProject({ declared: "1.63.0", images: ["v1.63.0-noble", "v1.62.1-noble"] }));

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines.join("\n")).toContain(".github/workflows/workflow-1.yml: the container image is Playwright 1.62.1, but @playwright/test is 1.63.0");
    expect(verdict.lines.join("\n")).not.toContain("workflow-0.yml");
  });

  it("fails when the npm version is a range", () => {
    const verdict = checkPin(createProject({ declared: "^1.63.0", images: [] }));

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines.join("\n")).toContain("Write the exact version");
  });

  it("fails when another version is installed than the one declared", () => {
    const verdict = checkPin(createProject({ declared: "1.63.0", installed: "1.62.0", images: ["v1.63.0-noble"] }));

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines.join("\n")).toContain("1.62.0 is installed but package.json says 1.63.0");
  });

  it("says SKIP, not PASS, when no workflow uses the image", () => {
    const verdict = checkPin(createProject({ declared: "1.63.0", images: [] }));

    expect(verdict.exitCode).toBe(0);
    expect(verdict.lines[0]).toMatch(/^SKIP playwright-pin/);
  });

  it("could not run when the package does not depend on Playwright", () => {
    expect(checkPin(createProject({ images: ["v1.63.0-noble"] })).exitCode).toBe(2);
  });

  it("could not run when the client package is not there", () => {
    expect(checkPin(mkdtempSync(join(tmpdir(), "visual-pin-empty-"))).exitCode).toBe(2);
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ProjectShape {
  /** The @playwright/test entry in the client's package.json. Left out: no entry. */
  declared?: string;
  /** The version in node_modules. Left out: not installed. */
  installed?: string;
  /** One workflow file per image tag. */
  images: string[];
}

function createProject({ declared, installed, images }: ProjectShape): string {
  const root = mkdtempSync(join(tmpdir(), "visual-pin-"));

  scratch.push(root);
  writeJson(join(root, "packages/client-react/package.json"), {
    name: "client",
    devDependencies: declared === undefined ? {} : { "@playwright/test": declared },
  });

  if (installed !== undefined) {
    writeJson(join(root, "packages/client-react/node_modules/@playwright/test/package.json"), { version: installed });
  }

  images.forEach((tag, index) => {
    const file = join(root, `.github/workflows/workflow-${index}.yml`);

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `jobs:\n  visual:\n    container: mcr.microsoft.com/playwright:${tag}\n`);
  });

  return root;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
