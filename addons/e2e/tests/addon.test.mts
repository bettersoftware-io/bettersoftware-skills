import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { describe, expect, it, onTestFinished } from "vitest";

import { architectureLint } from "../../../kit/eslint.config.mts";
import type { ArchitectureConfig } from "../../../kit/gates/lib/config.mts";
import { runGates } from "../../../kit/gates/run.mts";
import { declarePackages } from "../../../scripts/lib/architecture.mts";
import { RESULTS } from "../files/tools/e2e/lib/counts.mts";
import { ADDON, REPOSITORY } from "./support.mts";

const PACKAGE = "packages/e2e";
const WORKFLOW = readFileSync(join(ADDON, "files/.github/workflows/e2e.yml"), "utf8");

interface Manifest {
  recommended: boolean;
  requiresGates: string[];
  architecture: { packages: Record<string, Record<string, string>> };
  packageJson: Record<string, { scripts?: Record<string, string>; devDependencies?: Record<string, string> }>;
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  verify: string;
}

interface PackageJson {
  name: string;
  scripts: Record<string, string>;
  imports: Record<string, string>;
  devDependencies: Record<string, string>;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as Manifest;
}

function readShippedPackage(): PackageJson {
  return JSON.parse(readFileSync(join(ADDON, "files", PACKAGE, "package.json"), "utf8")) as PackageJson;
}

describe("what the add-on asks of a project", () => {
  it("is optional, and joins neither gate: the run needs a browser and a port", () => {
    const { recommended, gates, verify } = readManifest();

    expect(recommended).toBe(false);
    expect(gates).toEqual({ fast: [], full: [] });
    expect(verify).toBe("pnpm e2e");
  });

  it("needs a kit that knows the e2e role, which came with the playwright-pin gate", () => {
    const gates = JSON.parse(readFileSync(join(REPOSITORY, "kit/gates/gates.json"), "utf8")) as Record<string, string[]>;

    expect(readManifest().requiresGates).toEqual(["playwright-pin"]);
    expect(Object.keys(gates)).toContain("playwright-pin");
    expect(readFileSync(join(REPOSITORY, "kit/gates/lib/config.mts"), "utf8")).toContain('| "e2e";');
  });

  it("declares the package it brings, with the role the kit holds it to", () => {
    expect(readManifest().architecture).toEqual({ packages: { [PACKAGE]: { role: "e2e" } } });
    expect(existsSync(join(ADDON, "files", PACKAGE, "package.json"))).toBe(true);
  });

  it("adds two root scripts: the run, by plain node, and the browser's download", () => {
    expect(readManifest().packageJson).toEqual({
      ".": {
        scripts: {
          e2e: "node tools/e2e/run.mts",
          "e2e:install": `pnpm --dir ${PACKAGE} exec playwright install chromium`,
        },
      },
    });
    expect(existsSync(join(ADDON, "files/tools/e2e/run.mts"))).toBe(true);
  });

  it("leaves the project its config, the package's manifest and every spec and page object", () => {
    expect(readManifest().startingFiles).toEqual(["tools/e2e.config.mts", `${PACKAGE}/package.json`, `${PACKAGE}/src/`]);

    for (const path of ["tools/e2e.config.mts", `${PACKAGE}/package.json`, `${PACKAGE}/src/testing/test.ts`, `${PACKAGE}/src/sim/priceList.spec.ts`]) {
      expect(existsSync(join(ADDON, "files", path)), path).toBe(true);
    }
  });

  it("ships no JavaScript file", () => {
    const shipped = readdirSync(join(ADDON, "files"), { recursive: true, encoding: "utf8" });

    expect(shipped.length).toBeGreaterThan(10);
    expect(shipped.filter((path) => /\.(js|mjs|cjs|jsx)$/.test(path))).toEqual([]);
  });
});

describe("the package the add-on brings", () => {
  it("has a typecheck script and no test script, so the task runner never starts a browser", () => {
    const { scripts } = readShippedPackage();

    expect(scripts).toEqual({ typecheck: "tsc --noEmit -p tsconfig.json" });
  });

  it("asks for the exact Playwright version the visual add-on asks for, and the workflow's image carries it", () => {
    const visual = JSON.parse(readFileSync(join(REPOSITORY, "addons/visual/addon.json"), "utf8")) as Manifest;
    const version = readShippedPackage().devDependencies["@playwright/test"];

    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(visual.packageJson["packages/client-react"]?.devDependencies?.["@playwright/test"]);
    expect([...WORKFLOW.matchAll(/mcr\.microsoft\.com\/playwright:v([^\s-]+)-/g)].map((match) => match[1])).toEqual([version]);
  });

  it("asks for the Node types at the range the starter does, so one version is installed", () => {
    const starter = JSON.parse(readFileSync(join(REPOSITORY, "starter/package.json"), "utf8")) as PackageJson;

    expect(readShippedPackage().devDependencies["@types/node"]).toBe(starter.devDependencies["@types/node"]);
  });

  it("depends on the client for its test ids and on the wire protocol for its types, and on no other package of the project", () => {
    const workspace = Object.keys(readShippedPackage().devDependencies).filter((name) => name.startsWith("@app/"));

    expect(workspace).toEqual(["@app/client-react", "@app/shared"]);
    expect(readShippedPackage().imports).toEqual({ "#/*": "./src/*" });
  });

  it("has every TypeScript file it ships in its tsconfig.json", () => {
    const { include } = JSON.parse(stripComments(readFileSync(join(ADDON, "files", PACKAGE, "tsconfig.json"), "utf8"))) as { include: string[] };
    const atRoot = readdirSync(join(ADDON, "files", PACKAGE)).filter((name) => name.endsWith(".ts"));

    expect(include).toEqual(["src", "*.ts"]);
    expect(atRoot.sort()).toEqual(["notStarted.setup.ts", "playwright.config.ts"]);
  });

  it("has a spec in every mode of the config it ships, and no spec outside one", async () => {
    const { default: config } = (await import(join(ADDON, "files/tools/e2e.config.mts"))) as { default: { tests: string; modes: Record<string, unknown> } };
    const specs = readdirSync(join(ADDON, "files", PACKAGE, "src"), { recursive: true, encoding: "utf8" }).filter((path) => path.endsWith(".spec.ts"));

    expect(config.tests).toBe(PACKAGE);

    for (const mode of Object.keys(config.modes)) {
      expect(specs.filter((spec) => spec.startsWith(`${mode}/`)), mode).not.toEqual([]);
    }

    expect(specs.filter((spec) => !Object.keys(config.modes).some((mode) => spec.startsWith(`${mode}/`)))).toEqual([]);
  });
});

describe("the Playwright config", () => {
  const config = readFileSync(join(ADDON, "files", PACKAGE, "playwright.config.ts"), "utf8");

  it("starts no server of its own: the runner does, and stops them", () => {
    expect(config).not.toContain("webServer");
    expect(config).toContain('process.env[MODES_VARIABLE]');
    expect(config).toContain('const MODES_VARIABLE = "E2E_MODES";');
    expect(readFileSync(join(ADDON, "files/tools/e2e/lib/stack.mts"), "utf8")).toContain('export const MODES_VARIABLE = "E2E_MODES";');
  });

  it("never retries, keeps a trace of each failure, and writes its report where the workflow uploads it", () => {
    expect(config).toContain("retries: 0,");
    expect(config).toContain('trace: "retain-on-failure"');
    expect(config).toContain('["html", { outputFolder: "reports/html", open: "never" }]');
    expect(config).toContain('outputDir: "reports/artifacts"');
    expect(config).toContain(`["json", { outputFile: "${RESULTS}" }]`);
    expect(WORKFLOW).toContain(`path: ${PACKAGE}/reports\n`);
  });

  it("has a test that says how to start the run, for when it is run by hand", () => {
    expect(config).toContain('testMatch: "notStarted.setup.ts"');
    expect(readFileSync(join(ADDON, "files", PACKAGE, "notStarted.setup.ts"), "utf8")).toContain("run `pnpm e2e`");
  });
});

describe("the workflow", () => {
  it("pins every action to a full commit hash, with the version beside it", () => {
    const uses = WORKFLOW.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));

    expect(uses).toHaveLength(3);
    expect(uses.filter((line) => !/uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/.test(line))).toEqual([]);
  });

  it("runs on pull requests and on main, with read access only and no token left in the checkout", () => {
    expect(WORKFLOW).toContain("\non:\n  pull_request:\n  push:\n    branches: [main]\n");
    expect(WORKFLOW).toContain("\npermissions:\n  contents: read\n");
    expect(WORKFLOW).not.toMatch(/: write/);
    expect(WORKFLOW).toContain("persist-credentials: false");
  });

  it("runs the script the add-on adds, unfiltered, in the pinned container, and cannot hang for hours", () => {
    expect(WORKFLOW).toContain("        run: pnpm e2e\n");
    expect(WORKFLOW).toMatch(/\n {4}container: mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble\n/);
    expect(WORKFLOW).toContain("    timeout-minutes: 15\n");
  });

  it("uploads the report only when the run failed", () => {
    expect(WORKFLOW).toMatch(/if: failure\(\)\n\s+uses: actions\/upload-artifact@/);
  });
});

describe("the shipped specs and page objects, under the kit's own rules", { timeout: 60_000 }, () => {
  it("pass the kit's lint as an e2e package, and a spec that takes the page does not", async () => {
    const project = createStarterWithAddon();
    // The two packages type a config differently; the shape is the same.
    const eslint = new ESLint({ cwd: project, overrideConfigFile: true, overrideConfig: architectureLint(await readLayers(project)) as Linter.Config[] });

    const clean = await eslint.lintFiles([PACKAGE]);

    expect(clean.length).toBeGreaterThanOrEqual(8);
    expect(clean.flatMap(({ filePath, messages }) => messages.map(({ ruleId, line }) => `${basename(filePath)}:${line} ${ruleId}`))).toEqual([]);

    const spec = join(project, PACKAGE, "src/sim/selection.spec.ts");

    writeFileSync(spec, readFileSync(spec, "utf8").replace("async ({\n    priceList,\n  }) => {", "async ({\n    priceList,\n    page,\n  }) => {\n    await page.waitForTimeout(100);"));

    const broken = await eslint.lintFiles([spec]);

    expect(broken.flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId)).sort()).toEqual([
      "arch/no-browser-driver-in-specs",
      "arch/no-real-sleeps-in-tests",
    ]);
  });

  it("pass the kit's per-file gates, once the package is declared the way the installer declares it", async () => {
    const project = createStarterWithAddon();
    const files = readdirSync(join(project, PACKAGE), { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(ts|json)$/.test(path))
      .map((path) => `${PACKAGE}/${path}`);

    const result = await runGates({ root: project, files });

    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(result.findings).toEqual([]);
  });

  it("fail the structure gate until the package is declared", async () => {
    const project = createStarterWithAddon({ declared: false });

    const result = await runGates({ root: project });

    expect(result.findings.filter(({ gate, file }) => gate === "structure" && file === PACKAGE).map(({ message }) => message)).toEqual([
      expect.stringContaining("has no declared role"),
    ]);
  });
});

interface StarterOptions {
  declared?: boolean;
}

/** What scripts/create-project.mts leaves out of the starter. */
const NOT_COPIED = new Set(["node_modules", "dist", "coverage", ".turbo", "tools", ".claude", ".codex"]);

/** A project as the installer leaves it: the starter, the kit in tools/arch, the add-on's files, the package declared. */
function createStarterWithAddon({ declared = true }: StarterOptions = {}): string {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "e2e-addon-starter-")));

  onTestFinished(() => {
    rmSync(project, { recursive: true, force: true });
  });

  cpSync(join(REPOSITORY, "starter"), project, { recursive: true, filter: (path) => !NOT_COPIED.has(basename(path)) });
  cpSync(join(REPOSITORY, "kit"), join(project, "tools/arch"), { recursive: true, filter: (path) => !["fixtures", "node_modules"].includes(basename(path)) });
  cpSync(join(ADDON, "files"), project, { recursive: true });

  if (declared) {
    const config = join(project, "architecture.config.mts");
    const { text } = declarePackages(readFileSync(config, "utf8"), readManifest().architecture.packages);

    writeFileSync(config, text as string);
  }

  return project;
}

async function readLayers(project: string): Promise<ArchitectureConfig> {
  return ((await import(join(project, "architecture.config.mts"))) as { default: ArchitectureConfig }).default;
}

/** A tsconfig may hold comments. None of the shipped one's holds a quote. */
function stripComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "");
}
