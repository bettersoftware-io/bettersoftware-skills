import { describe, expect, it } from "vitest";

import { CoverageError } from "../files/tools/coverage/lib/config.mts";
import { listPackages } from "../files/tools/coverage/lib/workspace.mts";
import { createFolder } from "./support.mts";

describe("finding the workspace packages", () => {
  it("lists every folder a pattern matches that holds a package.json, sorted", () => {
    const root = createFolder({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/server/package.json": "{}",
      "packages/domain/package.json": "{}",
      "packages/notes/README.md": "not a package",
    });

    expect(listPackages(root)).toEqual(["packages/domain", "packages/server"]);
  });

  it("reads a quoted entry, a literal folder and a name with a star in it", () => {
    const root = createFolder({
      "pnpm-workspace.yaml": "packages:\n  - \"apps/web\"\n  - 'libs/client-*'\n",
      "apps/web/package.json": "{}",
      "libs/client-react/package.json": "{}",
      "libs/server/package.json": "{}",
    });

    expect(listPackages(root)).toEqual(["apps/web", "libs/client-react"]);
  });

  it("leaves out what an entry that starts with ! names", () => {
    const root = createFolder({
      "pnpm-workspace.yaml": 'packages:\n  - packages/*\n  - "!packages/legacy"\n',
      "packages/domain/package.json": "{}",
      "packages/legacy/package.json": "{}",
    });

    expect(listPackages(root)).toEqual(["packages/domain"]);
  });

  it("stops reading at the next top-level key", () => {
    const root = createFolder({
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n\nonlyBuiltDependencies:\n  - esbuild\n",
      "packages/domain/package.json": "{}",
      "esbuild/package.json": "{}",
    });

    expect(listPackages(root)).toEqual(["packages/domain"]);
  });

  it("says so when the folder has no workspace file", () => {
    expect(() => listPackages(createFolder())).toThrow(CoverageError);
    expect(() => listPackages(createFolder())).toThrow(/pnpm-workspace.yaml not found/);
  });

  it("says so when the workspace file names no package that exists", () => {
    const root = createFolder({ "pnpm-workspace.yaml": "packages:\n  - packages/*\n" });

    expect(() => listPackages(root)).toThrow(/lists no package that exists/);
  });

  it("refuses ** instead of guessing what it covers", () => {
    const root = createFolder({
      "pnpm-workspace.yaml": "packages:\n  - packages/**\n",
      "packages/domain/package.json": "{}",
    });

    expect(() => listPackages(root)).toThrow(/uses \*\*/);
  });
});
