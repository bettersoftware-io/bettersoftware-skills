import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { Finding } from "./lib/config.mts";
import { ConfigError } from "./lib/config.mts";
import { formatFindings, runGates } from "./run.mts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const clean = join(fixtures, "clean");
const broken = join(fixtures, "broken");

const UI = "packages/client-react/src/ui/PriceList.tsx";

describe("a project that follows the rules", () => {
  it("passes every gate", async () => {
    const result = await runGates({ root: clean });

    expect(result.findings).toEqual([]);
    expect(result.gates).toEqual([
      "structure",
      "typescript-only",
      "dumb-ui",
      "port-contracts",
      "dependencies",
      "agent-docs",
      "task-cache",
      "package-scripts",
      "app-harness",
      "test-ids",
      "types-only",
    ]);
    expect(result.skipped).toEqual({});
    expect(formatFindings(result)).toContain("all gates passed.");
  });

  it("does not read a rule name in a comment as a violation", async () => {
    const result = await runGates({ root: clean, files: [UI] });

    expect(result.findings).toEqual([]);
  });
});

// `gates.json` is what an update of the kit reads to tell a project which
// gates are new to it. Nothing runs from it, so only this holds it to the truth.
describe("the kit's list of its gates", () => {
  const list = JSON.parse(readFileSync(join(here, "gates.json"), "utf8")) as Record<string, string[]>;

  it("names every gate that runs, in the order they run, and no other", async () => {
    expect(Object.keys(list)).toEqual((await runGates({ root: clean })).gates);
  });

  it("names only options the architecture config has", () => {
    const declared = readFileSync(join(here, "lib", "config.mts"), "utf8");
    const unknown = Object.values(list)
      .flat()
      .filter((option) => !new RegExp(`^  ${option}\\??:`, "m").test(declared));

    expect(unknown).toEqual([]);
  });
});

describe("a project that breaks the rules", () => {
  let findings: Finding[] = [];

  const of = (gate: string, file?: string): Finding[] =>
    findings.filter((finding) => finding.gate === gate && (file === undefined || finding.file === file));
  const messages = (gate: string, file?: string): string =>
    of(gate, file)
      .map((finding) => finding.message)
      .join("\n");

  // Judged once, before any case, so that one case can be run alone.
  beforeAll(async () => {
    findings = (await runGates({ root: broken })).findings;
  });

  it("is judged", () => {
    expect(findings.length).toBeGreaterThan(0);
  });

  it("names a package that has no declared role", () => {
    expect(messages("structure", "packages/rogue")).toContain("no declared role");
  });

  it("names a runtime dependency outside the package's closed list", () => {
    expect(messages("structure", "packages/domain/package.json")).toContain('"lodash"');
    expect(messages("structure", "packages/domain/package.json")).not.toContain('"rxjs" is');
  });

  it("names logic and components that sit outside the client's two folders", () => {
    expect(messages("structure", "packages/client-react/src/feed.ts")).toContain("belong in the core package");
    expect(messages("structure", "packages/client-react/src/Stray.tsx")).toContain("A component outside");
    expect(of("structure", "packages/client-react/src/main.tsx")).toEqual([]);
  });

  it("does not report a test for sitting beside a misplaced subject", () => {
    expect(of("structure", "packages/client-react/src/feed.test.ts")).toEqual([]);
  });

  it("names a JavaScript file, and leaves alone one a tool can only load as JavaScript", () => {
    expect(messages("typescript-only", "scripts/build.mjs")).toContain("A JavaScript file in a TypeScript project");
    expect(of("typescript-only", "stylelint.config.mjs")).toEqual([]);
    expect(of("typescript-only").map((finding) => finding.file)).toEqual([
      ".github/scripts/release.js",
      "scripts/build.mjs",
    ]);
  });

  it("judges source in a dot-folder, and skips only folders of generated files", () => {
    expect(messages("typescript-only", ".github/scripts/release.js")).toContain("A JavaScript file");
    expect(of("typescript-only", ".vite/deps/chunk.js")).toEqual([]);
    expect(messages("dumb-ui", "packages/client-react/src/ui/.drafts/Hidden.tsx")).toContain("timer");
  });

  it("names every dumb-UI violation with its line", () => {
    const lines = of("dumb-ui", UI).map((finding) => finding.line);

    expect(lines).toEqual([1, 2, 7, 8, 9]);
    expect(messages("dumb-ui", UI)).toContain("stream library");
    expect(messages("dumb-ui", UI)).toContain("Storage");
    expect(messages("dumb-ui", UI)).toContain("configuration");
    expect(messages("dumb-ui", UI)).toContain("timer");
  });

  it("holds a stray component to the dumb-UI rules too", () => {
    expect(messages("dumb-ui", "packages/client-react/src/Stray.tsx")).toContain("stream library");
  });

  it("leaves the composition root and the bridge alone", () => {
    expect(of("dumb-ui", "packages/client-react/src/app/startApp.ts")).toEqual([]);
    expect(of("dumb-ui", "packages/client-react/src/ui/viewModel/usePrices.ts")).toEqual([]);
  });

  it("names a port with no contract and an adapter that does not run one", () => {
    expect(messages("port-contracts", "packages/domain/src/ports/orderPort.ts")).toContain("OrderPort has no contract test");
    expect(messages("port-contracts", "packages/client-core/src/adapters/wsPrice.ts")).toContain("describePricePortContract");
    expect(of("port-contracts", "packages/domain/src/simulators/priceSimulator.ts")).toEqual([]);
  });

  it("names a port method its contract never calls, and is not fooled by a comment", () => {
    const uncalled = messages("port-contracts", "packages/domain/src/ports/__contracts__/PricePortContract.ts");

    expect(uncalled).toContain("never calls history(");
    expect(uncalled).toContain("never calls latest(");
    expect(uncalled).not.toContain("never calls prices(");
  });

  it("names a port that is not declared as an interface, since its methods cannot be read", () => {
    expect(messages("port-contracts", "packages/domain/src/ports/quotePort.ts")).toContain(
      "does not declare `interface QuotePort`",
    );
  });

  it("names every cached task whose key ignores the packages it imports", () => {
    const blind = of("task-cache", "turbo.json").map((finding) => finding.message);

    expect(blind.filter((message) => message.startsWith("The task"))).toHaveLength(4);
    expect(blind.join("\n")).toContain('The task "build"');
    expect(blind.join("\n")).toContain('The task "typecheck"');
    expect(blind.join("\n")).toContain('The task "test"');
    expect(blind.join("\n")).toContain('The task "lint"');
    expect(blind.join("\n")).not.toContain('The task "dev"');
  });

  it("names a package whose port tests have a cached result, which a sandbox's skip would be replayed from", () => {
    const cached = of("task-cache").filter((finding) => finding.message.includes("need a port"));

    expect(cached.map((finding) => finding.file)).toEqual(["packages/checks/turbo.json", "packages/client-core"]);
    expect(cached[0]?.message).toContain('"cache": false');
  });

  it("names a shared tsconfig that no task's cache key includes", () => {
    expect(messages("task-cache", "turbo.json")).toContain(
      "packages/domain/tsconfig.json extends tsconfig.base.json",
    );
    expect(messages("task-cache", "turbo.json")).toContain(
      "packages/client-core/tsconfig.json extends tsconfig.base.json",
    );
  });

  it("names an import that points outward", () => {
    const outward = messages("dependencies", "packages/domain/src/useCases/reachesOutward.ts");

    expect(outward).toContain("domain-imports-inward-only");
    expect(outward).toContain("domain-no-node-builtins");
  });

  it("names production code in an integration package, and leaves its tests alone", () => {
    expect(messages("structure", "packages/checks/src/retryPolicy.ts")).toContain("holds only tests");
    expect(of("structure", "packages/checks/src/priceAgreement.test.ts")).toEqual([]);
  });

  it("names a package that imports the integration tier", () => {
    expect(messages("dependencies", "packages/client-core/src/usesTheChecks.ts")).toContain(
      "client-core-imports-inward-only",
    );
  });

  it("names every path in the agent instructions that does not exist, with its line", () => {
    expect(of("agent-docs").map(({ file, line }) => `${file}:${line}`)).toEqual([
      "AGENTS.md:7",
      "AGENTS.md:8",
      "AGENTS.md:10",
      "AGENTS.md:16",
      "CLAUDE.md:1",
    ]);
    expect(messages("agent-docs", "AGENTS.md")).toContain("packages/client-core/src/presenters/pricesPresenter.ts");
    expect(messages("agent-docs", "AGENTS.md")).toContain("packages/client-react/src/ui/PriceList.page.tsx");
    expect(messages("agent-docs", "AGENTS.md")).toContain("tools/arch/docs/review.md");
    expect(messages("agent-docs", "AGENTS.md")).not.toContain("pricePort.ts");
  });

  it("names the UI importing the composition root and an adapter", () => {
    const edges = messages("dependencies", UI);

    expect(edges).toContain("client-react-ui-never-imports-app");
    expect(edges).toContain("client-react-ui-never-imports-adapters");
  });

  it("names a package with no typecheck script or no test script, an integration package too", () => {
    const unchecked = messages("package-scripts", "packages/react-bindings/package.json");

    expect(unchecked).toContain('no "typecheck" script');
    expect(unchecked).toContain('no "test" script');
    expect(of("package-scripts", "packages/checks/package.json").map((finding) => finding.message)).toEqual([
      expect.stringContaining('no "test" script'),
    ]);
  });

  it("accepts a test:* script, and a package listed as having no tests with the reason", () => {
    expect(of("package-scripts", "packages/client-react/package.json")).toEqual([]);
    expect(of("package-scripts", "packages/rogue/package.json")).toEqual([]);
    expect(of("package-scripts", "packages/domain/package.json")).toEqual([]);
  });

  it("names production code that imports test scaffolding, and leaves a test that does alone", () => {
    expect(messages("dependencies", "packages/client-core/src/presenters/ratesPresenter.ts")).toContain(
      "no-test-scaffolding-in-production: imports packages/client-core/src/testing/fakePrices.ts",
    );
    expect(messages("dependencies", "packages/client-core/src/presenters/ratesPresenter.test.ts")).not.toContain(
      "no-test-scaffolding-in-production",
    );
  });

  it("names a presenter that imports an adapter, and leaves the entry, the harness and a test alone", () => {
    expect(messages("dependencies", "packages/client-core/src/presenters/ratesPresenter.ts")).toContain(
      "client-core-takes-ports-as-arguments: imports packages/client-core/src/adapters/wsPrice.ts",
    );
    expect(messages("dependencies")).toContain("client-core-takes-ports-as-arguments");
    expect(
      of("dependencies")
        .filter((finding) => finding.message.includes("takes-ports-as-arguments"))
        .map((finding) => finding.file),
    ).toEqual(["packages/client-core/src/presenters/ratesPresenter.ts"]);
  });

  it("names a contract that imports an implementation, with its line", () => {
    const impure = of("port-contracts", "packages/domain/src/ports/__contracts__/QuotePortContract.ts");

    expect(impure.map((finding) => finding.line)).toEqual([1, 3, 4]);
    expect(impure[0]?.message).toContain("packages/domain/src/simulators");
    expect(impure[1]?.message).toContain("packages/client-core/src/adapters");
    expect(impure[2]?.message).toContain("@fx/rogue");
  });

  it("names a test that builds the application itself, with its line", () => {
    expect(of("app-harness").map(({ file, line }) => `${file}:${line}`)).toEqual([
      "packages/client-core/src/presenters/ratesPresenter.test.ts:10",
    ]);
    expect(messages("app-harness")).toContain("packages/client-core/src/testing/appHarness.ts");
  });

  it("names a raw test id in a component, a selector and a query, with its line", () => {
    const lines = (file: string): (number | undefined)[] => of("test-ids", file).map((finding) => finding.line);

    expect(lines("packages/client-react/src/ui/PriceRow.tsx")).toEqual([6, 8]);
    expect(lines("packages/client-react/src/ui/PriceRow.page.tsx")).toEqual([12, 13, 15]);
    expect(of("test-ids", "packages/client-react/src/ui/testids.ts")).toEqual([]);
    expect(messages("test-ids")).toContain("packages/client-react/src/ui/testids.ts");
  });

  it("names a Node built-in in a package that asked to run anywhere, and leaves its tests alone", () => {
    expect(messages("dependencies", "packages/client-core/src/machines/clock.ts")).toContain(
      "client-core-no-node-builtins: imports os",
    );
    expect(messages("dependencies", "packages/client-core/src/presenters/ratesPresenter.test.ts")).not.toContain(
      "no-node-builtins",
    );
  });

  it("names a vendor imported outside the packages it is confined to", () => {
    const confined = of("dependencies").filter((finding) => finding.message.startsWith("ws-only-in-its-packages"));

    expect(confined.map((finding) => finding.file)).toEqual(["packages/client-core/src/machines/clock.ts"]);
    expect(confined[0]?.message).toContain("imports ws.");
    expect(confined[0]?.message).toContain("packages/checks");
  });

  it("names every runtime export of a types-only package, with its line", () => {
    expect(of("types-only").map(({ file, line }) => `${file}:${line}`)).toEqual(
      [3, 4, 5, 6, 11, 14, 15].map((line) => `packages/contract-types/src/index.ts:${line}`),
    );
    expect(messages("types-only")).toContain("VERSION");
  });
});

describe("the per-file path the editor hook uses", () => {
  it("judges only the files it is given", async () => {
    const result = await runGates({ root: broken, files: [UI, "packages/client-react/src/feed.ts"] });

    expect(result.gates).toEqual([
      "structure",
      "typescript-only",
      "dumb-ui",
      "port-contracts",
      "package-scripts",
      "app-harness",
      "test-ids",
      "types-only",
    ]);
    expect(new Set(result.findings.map((finding) => finding.file))).toEqual(
      new Set([UI, "packages/client-react/src/feed.ts"]),
    );
  });

  it("judges a file in an integration package", async () => {
    const result = await runGates({
      root: broken,
      files: ["packages/checks/src/retryPolicy.ts", "packages/checks/src/priceAgreement.test.ts"],
    });

    expect(result.findings.map((finding) => finding.file)).toEqual(["packages/checks/src/retryPolicy.ts"]);
  });

  it("judges a contract, a manifest, a test, a query and a types-only file given alone", async () => {
    const files = [
      "packages/domain/src/ports/__contracts__/QuotePortContract.ts",
      "packages/checks/package.json",
      "packages/client-core/src/presenters/ratesPresenter.test.ts",
      "packages/client-react/src/ui/PriceRow.page.tsx",
      "packages/contract-types/src/index.ts",
    ];
    const result = await runGates({ root: broken, files });
    const gateOf = (file: string): string[] => [
      ...new Set(result.findings.filter((finding) => finding.file === file).map((finding) => finding.gate)),
    ];

    expect(files.map(gateOf)).toEqual([["port-contracts"], ["package-scripts"], ["app-harness"], ["test-ids"], ["types-only"]]);
  });

  it("says nothing about the same kinds of file when they follow the rules", async () => {
    const result = await runGates({
      root: clean,
      files: [
        "packages/domain/src/ports/__contracts__/PricePortContract.ts",
        "packages/contract-types/package.json",
        "packages/client-core/src/presenters/pricesPresenter.test.ts",
        "packages/client-core/src/testing/appHarness.ts",
        "packages/client-react/src/ui/PriceList.page.tsx",
        "packages/contract-types/src/index.ts",
      ],
    });

    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual({});
  });

  it("reports a per-file gate the project gave nothing to judge as skipped", async () => {
    const result = await runGates({ root: join(fixtures, "dormant"), files: ["packages/domain/src/main.ts"] });

    expect(Object.keys(result.skipped)).toEqual(["app-harness", "test-ids", "types-only"]);
  });

  it("ignores a file outside the project and a file that no longer exists", async () => {
    const result = await runGates({ root: broken, files: ["/etc/hosts", "packages/client-react/src/gone.tsx"] });

    expect(result.findings).toEqual([]);
  });
});

describe("dependency rules that would be blind", () => {
  it("reports a workspace import that does not land in that package's source", async () => {
    const { findings } = await runGates({ root: join(fixtures, "dormant") });
    const blind = findings.filter((finding) => finding.gate === "dependencies");

    expect(blind).toHaveLength(1);
    expect(blind[0].file).toBe("packages/client-core/src/index.ts");
    expect(blind[0].message).toContain('"@fx/domain"');
    expect(blind[0].message).toContain("cannot see this edge");
  });
});

describe("a project that declares JavaScript", () => {
  it("skips the language gate and says why", async () => {
    const result = await runGates({ root: join(fixtures, "javascript") });

    expect(result.findings.filter((finding) => finding.gate === "typescript-only")).toEqual([]);
    expect(formatFindings(result)).toContain('SKIP typescript-only — the project declares language "javascript"');
  });
});

describe("the command itself", () => {
  it("judges when run through a symlink, instead of exiting clean having done nothing", () => {
    const link = join(mkdtempSync(join(tmpdir(), "arch-link-")), "run.mts");

    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "run.mts"), link);

    const run = spawnSync(process.execPath, [link, "--root", broken], { encoding: "utf8" });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL structure");
  });

  it("exits 2 when it cannot run", () => {
    const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "run.mts"), "--root", fixtures], {
      encoding: "utf8",
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("gates could not run");
  });
});

describe("a gate with nothing to judge", () => {
  it("is reported as skipped, never as passed", async () => {
    const result = await runGates({ root: join(fixtures, "dormant") });
    const report = formatFindings(result);

    expect(result.skipped).toEqual({
      "dumb-ui": "no UI files were found, so there was nothing to check",
      "port-contracts": "no port interfaces were found, so there was nothing to check",
      "agent-docs": "no AGENTS.md or CLAUDE.md was found, so there was nothing to check",
      "task-cache": "no turbo.json was found, so there was nothing to check",
      "app-harness": "no core package defines createApp(…), so there was no application for a test to build",
      "test-ids": "no client package is declared, so there was nothing to check",
      "types-only": "no package is declared typesOnly, so there was nothing to check",
    });
    expect(report).toContain("SKIP dumb-ui");
    expect(report).toContain("SKIP port-contracts");
    expect(report).not.toContain("PASS dumb-ui");
  });

  it("skips the script check when the project has no workspace package", async () => {
    const result = await runGates({ root: join(fixtures, "no-workspace") });

    expect(result.skipped["package-scripts"]).toBe("no workspace package was found, so there was nothing to check");
    expect(formatFindings(result)).toContain("SKIP package-scripts");
  });
});

describe("a project that cannot be judged", () => {
  it("refuses instead of passing when no layers are declared", async () => {
    await expect(runGates({ root: fixtures })).rejects.toBeInstanceOf(ConfigError);
  });
});
