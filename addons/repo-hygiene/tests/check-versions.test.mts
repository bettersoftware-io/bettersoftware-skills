import { describe, expect, it } from "vitest";

import { checkVersions, formatResult } from "../files/tools/repo-hygiene/check-versions.mts";
import { CouldNotRun } from "../files/tools/repo-hygiene/lib/run.mts";
import { createEntry, createFakeTools, createFolder } from "./support.mts";

const LISTING = [createEntry("/p/package.json", "vitest"), createEntry("/p/packages/a/package.json"), createEntry("/p/packages/a/package.json", "react")].join("\n");
const MISMATCH = "☔️ error @app/server has a dependency on rxjs@^7.8.1 but the most common range in the repo is ^7.8.2, the range should be set to ^7.8.2";
const UNSORTED = "☔️ error app's dependencies are unsorted, this can cause large diffs when packages are added, resulting in dependencies being sorted";
const HINT = "☔️ info the above errors may be fixable with yarn manypkg fix";

const createProject = (): string => createFolder({ "tools/repo-hygiene/syncpack.json": "{}" });

describe("a workspace whose versions agree", () => {
  it("runs manypkg, then syncpack with the project's settings file", () => {
    const tools = createFakeTools({ "syncpack json": { stdout: LISTING } });

    checkVersions(createProject(), tools.run);

    expect(tools.calls).toEqual([
      "manypkg check",
      "syncpack lint --config tools/repo-hygiene/syncpack.json",
      "syncpack json --config tools/repo-hygiene/syncpack.json",
    ]);
  });

  it("passes, and says how many entries in how many files it compared", () => {
    const result = checkVersions(createProject(), createFakeTools({ "syncpack json": { stdout: `${LISTING}\n` } }).run);

    expect(result).toMatchObject({ manypkg: [], syncpack: "", entries: 3, packages: 2 });
    expect(formatResult(result)).toBe("PASS versions — 3 dependency entries in 2 package.json file(s) agree");
  });

  it("is skipped when no package.json has a dependency, and never passes", () => {
    const result = checkVersions(createProject(), createFakeTools().run);

    expect(result.skipped).toBe("no dependency in any package.json");
    expect(formatResult(result)).toBe("SKIP versions — no dependency in any package.json");
  });
});

describe("manypkg", () => {
  it("fails the check with each rule it reports, without its hint", () => {
    const tools = createFakeTools({ manypkg: { status: 1, stderr: `${MISMATCH}\n`, stdout: `${HINT}\n` }, "syncpack json": { stdout: LISTING } });

    expect(checkVersions(createProject(), tools.run).manypkg).toEqual([MISMATCH.replace("☔️ error ", "")]);
  });

  it("reports dependencies that are not in order, like any other finding", () => {
    const tools = createFakeTools({ manypkg: { status: 1, stderr: `${UNSORTED}\n${MISMATCH}\n` }, "syncpack json": { stdout: LISTING } });

    expect(checkVersions(createProject(), tools.run).manypkg).toHaveLength(2);
  });

  it("could not run when it fails and names no rule", () => {
    const tools = createFakeTools({ manypkg: { status: 1, stderr: "\nSyntaxError: Unexpected token\n    at parse\n" } });

    expect(() => checkVersions(createProject(), tools.run)).toThrow(new CouldNotRun("manypkg stopped with exit 1: SyntaxError: Unexpected token"));
  });
});

describe("syncpack", () => {
  const report = "= Default Version Group =\n   4x rxjs\n      ✘ ^7.8.1 → ^7.8.2 in packages/server/package.json at .dependencies";

  it("fails the check with its report when a version differs", () => {
    const tools = createFakeTools({ "syncpack lint": { status: 1, stdout: `${report}\n`, stderr: "✗ Issues found\n" }, "syncpack json": { status: 1, stdout: LISTING } });
    const result = checkVersions(createProject(), tools.run);

    expect(result.syncpack).toBe(`${report}\n✗ Issues found`);
    expect(formatResult(result)).toBe(
      [
        "FAIL versions",
        "",
        "syncpack:",
        ...`${report}\n✗ Issues found`.split("\n").map((line) => `  ${line}`),
        "",
        "Give every package the same range for the dependency, then run `pnpm install`.",
        "A dependency that must differ on purpose gets a version group in tools/repo-hygiene/syncpack.json, with a label that says why.",
      ].join("\n"),
    );
  });

  it("could not run, and has not failed, when it stops before reading the workspace", () => {
    const stopped = { status: 1, stderr: "✗ error: invalid value 'x' for '--config <PATH>'\n" };
    const tools = createFakeTools({ "syncpack lint": stopped, "syncpack json": stopped });

    expect(() => checkVersions(createProject(), tools.run)).toThrow(
      new CouldNotRun("syncpack stopped with exit 1: ✗ error: invalid value 'x' for '--config <PATH>'"),
    );
  });

  it("could not run when it exits with a code that is not a verdict", () => {
    const tools = createFakeTools({ "syncpack lint": { status: 101, stderr: "thread 'main' panicked\n" }, "syncpack json": { stdout: LISTING } });

    expect(() => checkVersions(createProject(), tools.run)).toThrow(new CouldNotRun("syncpack stopped with exit 101: thread 'main' panicked"));
  });

  it("could not run when its listing is not what was expected", () => {
    const tools = createFakeTools({ "syncpack json": { stdout: "Scope: all 8 workspace projects\n" } });

    expect(() => checkVersions(createProject(), tools.run)).toThrow(/a line that is not JSON: Scope: all 8/);
  });
});

describe("the settings file", () => {
  it("must be there: without it the check could not run", () => {
    const tools = createFakeTools({ "syncpack json": { stdout: LISTING } });

    expect(() => checkVersions(createFolder(), tools.run)).toThrow(/tools\/repo-hygiene\/syncpack\.json is missing/);
    expect(tools.calls).toEqual([]);
  });

  it("must be JSON: syncpack would go on without it", () => {
    const tools = createFakeTools({ "syncpack json": { stdout: LISTING } });

    expect(() => checkVersions(createFolder({ "tools/repo-hygiene/syncpack.json": "{ bad" }), tools.run)).toThrow(/tools\/repo-hygiene\/syncpack\.json is not JSON: /);
  });
});

describe("a failed check, printed", () => {
  it("puts manypkg's findings under its name", () => {
    const tools = createFakeTools({ manypkg: { status: 1, stderr: MISMATCH }, "syncpack json": { stdout: LISTING } });

    expect(formatResult(checkVersions(createProject(), tools.run)).split("\n").slice(0, 4)).toEqual([
      "FAIL versions",
      "",
      "manypkg:",
      `  ${MISMATCH.replace("☔️ error ", "")}`,
    ]);
  });
});
