import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

import { CoverageError } from "../files/tools/coverage/lib/config.mts";
import type { RunVitest } from "../files/tools/coverage/lib/measure.mts";
import { checkCoverage, readBuild } from "../files/tools/coverage/run.mts";
import { createCheckout, createConfig, createFileCoverage, createFolder, createWorkspace, git, TOOLS, writeRunOutput } from "./support.mts";

describe("the coverage gate", () => {
  it("measures every workspace package with its own tests and judges each", () => {
    const root = createWorkspace(["packages/strong", "packages/weak"]);
    const announced: string[] = [];
    const results = checkCoverage({
      root,
      config: createConfig(),
      run: createVitestRun(root),
      announce: (directory) => {
        announced.push(directory);
      },
    });

    expect(results.map(({ directory, verdict }) => ({ directory, verdict }))).toEqual([
      { directory: "packages/strong", verdict: "PASS" },
      { directory: "packages/weak", verdict: "FAIL" },
    ]);
    expect(results[1]?.underTheBar.map(({ file }) => file)).toEqual(["packages/weak/src/price.ts"]);
    expect(announced).toEqual(["packages/strong", "packages/weak"]);
  });

  it("measures only the packages asked for", () => {
    const root = createWorkspace(["packages/strong", "packages/weak"]);
    const results = checkCoverage({ root, config: createConfig(), packages: ["packages/weak"], run: createVitestRun(root) });

    expect(results.map(({ directory }) => directory)).toEqual(["packages/weak"]);
  });

  it("neither measures nor judges a package whose port tests cannot run here", () => {
    const root = createWorkspace(["packages/server", "packages/strong"], { "packages/server/src/startServer.port.test.ts": "" });
    const measured: string[] = [];
    const results = checkCoverage({
      root,
      config: createConfig(),
      portTestsSkipped: true,
      run: (directory, ...rest) => {
        measured.push(basename(directory));

        return createVitestRun(root)(directory, ...rest);
      },
    });

    expect(results.map(({ directory, verdict }) => ({ directory, verdict }))).toEqual([
      { directory: "packages/server", verdict: "SKIP" },
      { directory: "packages/strong", verdict: "PASS" },
    ]);
    expect(results[0]?.reason).toContain("need a port");
    expect(measured).toEqual(["strong"]);
  });

  it("measures that package like any other where a port can be opened", () => {
    const root = createWorkspace(["packages/server"], { "packages/server/src/startServer.port.test.ts": "" });
    const results = checkCoverage({ root, config: createConfig(), portTestsSkipped: false, run: createVitestRun(root) });

    expect(results.map(({ directory, verdict }) => ({ directory, verdict }))).toEqual([{ directory: "packages/server", verdict: "PASS" }]);
  });

  it("skips a package whose tests are Playwright's, by name, and runs nothing in it", () => {
    const root = createWorkspace(["packages/e2e", "packages/strong"], {
      "packages/e2e/playwright.config.ts": "",
      "packages/e2e/src/sim/prices.spec.ts": "",
    });
    const measured: string[] = [];
    const announced: string[] = [];

    const results = checkCoverage({
      root,
      config: createConfig(),
      announce: (directory) => {
        announced.push(directory);
      },
      run: (directory, ...rest) => {
        measured.push(basename(directory));

        return createVitestRun(root)(directory, ...rest);
      },
    });

    expect(results.map(({ directory, verdict }) => ({ directory, verdict }))).toEqual([
      { directory: "packages/e2e", verdict: "SKIP" },
      { directory: "packages/strong", verdict: "PASS" },
    ]);
    expect(results[0]?.reason).toContain("its tests are Playwright's (playwright.config.ts, and no test script)");
    expect(measured).toEqual(["strong"]);
    expect(announced).toEqual(["packages/strong"]);
  });

  it("measures a package that has a Playwright config and a test script of its own", () => {
    const root = createWorkspace(["packages/strong"], { "packages/strong/playwright.config.ts": "" });

    writeFileSync(join(root, "packages/strong/package.json"), JSON.stringify({ name: "strong", scripts: { "test:unit": "vitest run" } }));

    const results = checkCoverage({ root, config: createConfig(), run: createVitestRun(root) });

    expect(results.map(({ verdict }) => verdict)).toEqual(["PASS"]);
  });

  it("refuses a folder that is not a workspace package", () => {
    const root = createWorkspace(["packages/strong"]);
    const check = (): unknown => checkCoverage({ root, config: createConfig(), packages: ["packages/strnog"], run: createVitestRun(root) });

    expect(check).toThrow(CoverageError);
    expect(check).toThrow("not a workspace package: packages/strnog — the packages are packages/strong");
  });

  it("refuses an exclusion that is in no workspace package, before measuring anything", () => {
    const root = createWorkspace(["packages/strong"]);
    const config = createConfig({ exclude: { "src/index.ts": "the entry point" } });
    let runs = 0;
    const check = (): unknown =>
      checkCoverage({
        root,
        config,
        run: () => {
          runs += 1;

          return { status: 0 };
        },
      });

    expect(check).toThrow('excludes "src/index.ts", which is in no workspace package');
    expect(runs).toBe(0);
  });

  it("exits 2 and says why when it is not run from a project root", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "run.mts"), "--root", createFolder()], { encoding: "utf8" });

    expect(stderr).toContain("coverage could not run: pnpm-workspace.yaml not found");
    expect(status).toBe(2);
  });

  it("exits 2 on an argument it does not know", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "run.mts"), "--jsno"], { cwd: createFolder(), encoding: "utf8" });

    expect(stderr).toContain('coverage could not run: unknown argument "--jsno"');
    expect(status).toBe(2);
  });
});

describe("reading which commit a report is built from", () => {
  it("reads the commit and the branch from git", () => {
    const checkout = createCheckout();
    const build = readBuild(checkout, {}, new Date("2026-10-04T19:56:31Z"));

    expect(build).toEqual({
      commit: git(checkout, "rev-parse", "HEAD"),
      dirty: false,
      ref: "main",
      builtAt: new Date("2026-10-04T19:56:31Z"),
      runUrl: undefined,
    });
    expect(build.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("marks a tree that has changes the commit does not hold", () => {
    const checkout = createCheckout();

    writeFileSync(join(checkout, "notes.txt"), "not committed");

    expect(readBuild(checkout, {}).dirty).toBe(true);
  });

  it("takes the branch name and the run link from CI when CI gives them", () => {
    const build = readBuild(createCheckout(), {
      GITHUB_REF_NAME: "feature/prices",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_RUN_ID: "7",
    });

    expect(build.ref).toBe("feature/prices");
    expect(build.runUrl).toBe("https://github.com/acme/app/actions/runs/7");
  });

  it("names no commit outside a git checkout, and does not call the tree changed", () => {
    const build = readBuild(createFolder(), {});

    expect(build.commit).toBeUndefined();
    expect(build.ref).toBeUndefined();
    expect(build.dirty).toBe(false);
  });
});

/** Stands in for vitest: a package called "weak" has a file under the bar, any other is fully covered. */
function createVitestRun(root: string): RunVitest {
  return (directory) => {
    const weak = basename(directory) === "weak";
    const inProject = `packages/${basename(directory)}`;

    writeRunOutput(root, inProject, [createFileCoverage("src/price.ts", weak ? { lines: [1, 10] } : {})], {
      numTotalTests: 1,
      testResults: [],
    });

    return { status: weak ? 1 : 0 };
  };
}
