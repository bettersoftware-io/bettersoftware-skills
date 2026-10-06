import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import type { Finding, ResolvedConfig } from "./lib/config.mts";
import { ConfigError, readVendorEntries } from "./lib/config.mts";
import { buildRules, type Rule, vendorRuleName } from "./lib/depcruise.mts";
import { resolveSubpathImport } from "./lib/files.mts";
import { checkNodeFloor } from "./lib/node-floor.mts";
import { checkPackageManager } from "./lib/package-manager.mts";
import { lenientLintCommands } from "./lib/package-scripts.mts";
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
      "node-floor",
      "package-manager",
      "app-harness",
      "test-ids",
      "types-only",
      "playwright-pin",
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

  it("says of every gate, and of no other, what it fails on, in one sentence a person is shown when the gate is new to their project", () => {
    const failsOn = JSON.parse(readFileSync(join(here, "fails-on.json"), "utf8")) as Record<string, string>;

    expect(Object.keys(failsOn)).toEqual(Object.keys(list));

    for (const [gate, sentence] of Object.entries(failsOn)) {
      expect(sentence.length, gate).toBeGreaterThan(30);
      expect(sentence, gate).not.toMatch(/\.$/);
    }
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

  it("names a file of an e2e package that is neither a spec, a page object nor in a testing folder", () => {
    expect(messages("structure", "packages/browser-tests/src/helpers.ts")).toContain("holds only specs (*.spec.ts), page objects (*.page.ts)");
    expect(of("structure", "packages/browser-tests/src/sim/prices.spec.ts")).toEqual([]);
  });

  it("names an e2e package that imports the application, from a spec and from its config, and leaves the test ids and a type alone", () => {
    const fromSpec = of("dependencies", "packages/browser-tests/src/sim/prices.spec.ts").map((finding) => finding.message);

    expect(fromSpec).toEqual([expect.stringContaining("browser-tests-imports-test-ids-only: imports packages/client-core/src/index.ts")]);
    expect(fromSpec.join("\n")).toContain("except the test ids (packages/client-react/src/ui/testids.ts)");
    expect(messages("dependencies", "packages/browser-tests/playwright.config.ts")).toContain(
      "browser-tests-imports-test-ids-only: imports packages/client-react/src/app/startApp.ts",
    );
  });

  it("names each test script of an e2e package, and asks it for no test script", () => {
    expect(of("package-scripts", "packages/browser-tests/package.json").map((finding) => finding.message)).toEqual([
      expect.stringContaining('has a "test" script'),
      expect.stringContaining('has a "test:headed" script'),
    ]);
  });

  it("names a Playwright version that is a range, and compares nothing with it", () => {
    expect(messages("playwright-pin", "packages/browser-tests/package.json")).toContain('is "^1.63.0". Write the exact version');
    expect(of("playwright-pin", ".github/workflows/e2e.yml")).toEqual([]);
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

  it("names each script that runs ESLint and lets a warning through, in the root and in a package", () => {
    const lenient = (file: string): string[] =>
      of("package-scripts", file)
        .map((finding) => finding.message)
        .filter((message) => message.includes("--max-warnings 0"));

    expect(lenient("package.json")).toEqual([
      expect.stringContaining('The script "lint" runs `eslint .` without'),
      expect.stringContaining('The script "gate:fast" runs `eslint --max-warnings 5 .` without'),
    ]);
    expect(lenient("packages/contract-types/package.json")).toEqual([
      expect.stringContaining('The script "lint" runs `eslint src`'),
    ]);
    expect(lenient("packages/domain/package.json")).toEqual([]);
  });

  it("names engines.node in the root and in a package, and a root with no floor in devEngines", () => {
    expect(of("node-floor").map((finding) => finding.file)).toEqual([
      "package.json",
      "package.json",
      "packages/rogue/package.json",
    ]);
    expect(of("node-floor", "package.json")[0]?.message).toContain('engines.node is ">=26"');
    expect(of("node-floor", "package.json")[0]?.message).toContain("refuses a range above the Node it offers");
    expect(of("node-floor", "package.json")[1]?.message).toContain('devEngines.runtime does not name "node"');
    expect(messages("node-floor", "packages/rogue/package.json")).toContain('"version": ">=24", "onFail": "error"');
    expect(of("node-floor", "packages/domain/package.json")).toEqual([]);
  });

  it("names a package manager pinned by version alone, and says how to add the hash", () => {
    expect(of("package-manager").map((finding) => finding.file)).toEqual(["package.json"]);
    expect(messages("package-manager", "package.json")).toContain('packageManager is "pnpm@12.6.0" and has no hash after the version');
    expect(messages("package-manager", "package.json")).toContain("node tools/arch/ci/pin-package-manager.mts --write");
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
    ).toEqual([
      "packages/client-core/src/presenters/aliasedPresenter.ts",
      "packages/client-core/src/presenters/ratesPresenter.ts",
    ]);
  });

  it("names a forbidden import written through the package's own #/ alias, by where it lands", () => {
    const aliased = messages("dependencies", "packages/client-core/src/presenters/aliasedPresenter.ts");

    expect(aliased).toContain("client-core-takes-ports-as-arguments: imports packages/client-core/src/adapters/wsPrice.ts");
    expect(aliased).toContain("no-test-scaffolding-in-production: imports packages/client-core/src/testing/fakePrices.ts");
    expect(messages("dependencies", "packages/client-react/src/ui/AliasedList.tsx")).toContain(
      "client-react-ui-never-imports-app: imports packages/client-react/src/app/startApp.ts",
    );
  });

  it("names an alias that leads nowhere, since no rule can see that edge", () => {
    const blind = of("dependencies", "packages/react-bindings/src/aliased.ts");

    expect(blind).toHaveLength(1);
    expect(blind[0]?.message).toContain('The import "#/missing.ts" did not resolve');
    expect(blind[0]?.message).toContain('"imports": { "#/*": "./src/*" }');
    expect(messages("dependencies")).not.toContain('The import "#/adapters/wsPrice.ts" did not resolve');
  });

  it("names a contract that imports an implementation, with its line", () => {
    const impure = of("port-contracts", "packages/domain/src/ports/__contracts__/QuotePortContract.ts");

    expect(impure.map((finding) => finding.line)).toEqual([1, 3, 4, 7]);
    expect(impure[0]?.message).toContain("packages/domain/src/simulators");
    expect(impure[1]?.message).toContain("packages/client-core/src/adapters");
    expect(impure[2]?.message).toContain("@fx/rogue");
  });

  it("names a contract that reaches an implementation through the package's #/ alias", () => {
    const [aliased] = of("port-contracts", "packages/domain/src/ports/__contracts__/QuotePortContract.ts").slice(3);

    expect(aliased?.message).toContain('The contract imports "#/simulators/priceSimulator.ts", an implementation (packages/domain/src/simulators)');
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

  it("gives each of two entries that share a word a rule of its own, so each finding says its own entry's list", () => {
    const of_ = (rule: string): string[] =>
      of("dependencies", "packages/client-core/src/machines/clock.ts")
        .map((finding) => finding.message)
        .filter((message) => message.startsWith(`${rule}: `));

    expect(of_("hono-only-in-its-packages")).toEqual([expect.stringContaining('imports hono. "hono" may be imported only from: packages/checks. Keeping')]);
    expect(of_("@hono/*-only-in-its-packages")).toEqual([
      expect.stringContaining('imports @hono/node-server. "@hono/" may be imported only from: packages/checks, packages/react-bindings. Keeping'),
    ]);
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
      "node-floor",
      "package-manager",
      "app-harness",
      "test-ids",
      "types-only",
    ]);
    expect(new Set(result.findings.map((finding) => finding.file))).toEqual(
      new Set([UI, "packages/client-react/src/feed.ts"]),
    );
  });

  it("judges a file in an e2e package", async () => {
    const result = await runGates({
      root: broken,
      files: ["packages/browser-tests/src/helpers.ts", "packages/browser-tests/src/sim/prices.spec.ts", "packages/browser-tests/package.json"],
    });

    expect(result.findings.map(({ gate, file }) => `${gate} ${file}`)).toEqual([
      "structure packages/browser-tests/src/helpers.ts",
      "package-scripts packages/browser-tests/package.json",
      "package-scripts packages/browser-tests/package.json",
    ]);
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

  it("judges the root manifest and a package's given alone, and asks no floor of a package", async () => {
    const result = await runGates({ root: broken, files: ["package.json", "packages/rogue/package.json"] });

    expect(result.findings.map(({ gate, file }) => `${gate} ${file}`)).toEqual([
      "package-scripts package.json",
      "package-scripts package.json",
      "node-floor package.json",
      "node-floor package.json",
      "node-floor packages/rogue/package.json",
      "package-manager package.json",
    ]);
  });

  it("says nothing about the same kinds of file when they follow the rules", async () => {
    const result = await runGates({
      root: clean,
      files: [
        "packages/domain/src/ports/__contracts__/PricePortContract.ts",
        "package.json",
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

    expect(Object.keys(result.skipped)).toEqual(["node-floor", "package-manager", "app-harness", "test-ids", "types-only"]);
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
      "node-floor": "no package.json was found at the root, so there was nothing to check",
      "package-manager": "no package.json was found at the root, so there was nothing to check",
      "app-harness": "no core package defines createApp(…), so there was no application for a test to build",
      "test-ids": "no client package is declared, so there was nothing to check",
      "types-only": "no package is declared typesOnly, so there was nothing to check",
      "playwright-pin": "no package.json asks for @playwright/test, or for the playwright library, so there was no version to hold",
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

describe("a #… import, read from the package's own package.json", () => {
  const imports = (declared: object): string => {
    const root = mkdtempSync(join(tmpdir(), "arch-alias-"));

    mkdirSync(join(root, "packages/domain"), { recursive: true });
    writeFileSync(join(root, "packages/domain/package.json"), JSON.stringify({ imports: declared }));

    return root;
  };

  it("lands in the folder the pattern names", () => {
    const root = imports({ "#/*": "./src/*" });

    expect(resolveSubpathImport(root, "packages/domain", "#/simulators/priceSimulator.ts")).toBe(
      "packages/domain/src/simulators/priceSimulator.ts",
    );
    expect(resolveSubpathImport(root, "packages/domain", "#/index.ts")).toBe("packages/domain/src/index.ts");
  });

  it("takes an exact name, a second pattern, and a target given by condition", () => {
    const root = imports({ "#config": "./src/config.ts", "#tests/*.ts": { import: "./tests/*.mts" }, "#/*": "./src/*" });

    expect(resolveSubpathImport(root, "packages/domain", "#config")).toBe("packages/domain/src/config.ts");
    expect(resolveSubpathImport(root, "packages/domain", "#tests/pages/list.ts")).toBe("packages/domain/tests/pages/list.mts");
    expect(resolveSubpathImport(root, "packages/domain", "#/a.ts")).toBe("packages/domain/src/a.ts");
  });

  it("matches a pattern only by both of its ends, with something in between", () => {
    const root = imports({ "#tests/*.ts": "./tests/*.mts" });

    expect(resolveSubpathImport(root, "packages/domain", "#tests/host.css")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/domain", "#tests/.ts")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/domain", "#tests/a.ts")).toBe("packages/domain/tests/a.mts");
  });

  it("is undefined for an alias nobody declared, a package with no manifest, and a specifier that is no alias", () => {
    const root = imports({ "#tests/*": "./tests/*", "#off": null });

    expect(resolveSubpathImport(root, "packages/domain", "#/a.ts")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/domain", "#tests")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/domain", "#off")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/shared", "#tests/a.ts")).toBeUndefined();
    expect(resolveSubpathImport(root, "packages/domain", "./tests/a.ts")).toBeUndefined();
  });
});

describe("an ESLint command in a script", () => {
  it("is held to --max-warnings 0, wherever in the script it is", () => {
    expect(lenientLintCommands("eslint .")).toEqual(["eslint ."]);
    expect(lenientLintCommands("pnpm gates && eslint --flag x . && pnpm typecheck")).toEqual(["eslint --flag x ."]);
    expect(lenientLintCommands("eslint --max-warnings 0 . && eslint --config typed.mts .")).toEqual(["eslint --config typed.mts ."]);
    expect(lenientLintCommands("eslint")).toEqual(["eslint"]);
  });

  it("passes with the flag in either spelling, and only with zero", () => {
    expect(lenientLintCommands("eslint . --max-warnings 0")).toEqual([]);
    expect(lenientLintCommands("eslint --max-warnings=0 .")).toEqual([]);
    expect(lenientLintCommands("eslint --max-warnings 05 .")).toEqual(["eslint --max-warnings 05 ."]);
    expect(lenientLintCommands("eslint --max-warnings 10 .")).toEqual(["eslint --max-warnings 10 ."]);
  });

  it("is judged in a project that has a root package.json and no workspace package", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-scripts-"));

    writeFileSync(join(root, "architecture.config.mts"), "export default { packages: {} };\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));

    const result = await runGates({ root });

    expect(result.skipped["package-scripts"]).toBeUndefined();
    expect(result.findings.filter((finding) => finding.gate === "package-scripts")).toHaveLength(1);
  });

  it("leaves a fixer alone, and a command that only has eslint in its name", () => {
    expect(lenientLintCommands("eslint --fix .")).toEqual([]);
    expect(lenientLintCommands("eslint . --fix-dry-run")).toEqual([]);
    expect(lenientLintCommands("eslint-config-inspector && node_modules/eslint/bin/x && my-eslint .")).toEqual([]);
    expect(lenientLintCommands("eslint --fixture .")).toEqual(["eslint --fixture ."]);
  });
});

describe("the Node floor in devEngines", () => {
  it("accepts the floor as one of several runtimes", () => {
    expect(floorFindings({ devEngines: { runtime: [{ name: "bun", version: ">=1" }, { name: "node", version: ">=26", onFail: "error" }] } })).toEqual([]);
  });

  it("names a runtime that is not node, and one with no version", () => {
    expect(floorFindings({ devEngines: { runtime: { name: "bun", version: ">=1", onFail: "error" } } })).toEqual([
      expect.stringContaining('does not name "node" with a version range'),
    ]);
    expect(floorFindings({ devEngines: { runtime: { name: "node", onFail: "error" } } })).toEqual([
      expect.stringContaining('does not name "node" with a version range'),
    ]);
  });

  it("names a floor that an install is allowed to ignore, set or not", () => {
    expect(floorFindings({ devEngines: { runtime: { name: "node", version: ">=26", onFail: "warn" } } })).toEqual([
      expect.stringContaining('has onFail "warn". Set "onFail": "error"'),
    ]);
    expect(floorFindings({ devEngines: { runtime: { name: "node", version: ">=26" } } })).toEqual([
      expect.stringContaining("has no onFail"),
    ]);
  });
});

describe("the package manager the root package.json names", () => {
  const HASH = "0123456789abcdef".repeat(8);

  it("accepts one exact version with the sha512 hash of its release", () => {
    expect(managerFindings({ packageManager: `pnpm@12.6.0+sha512.${HASH}` })).toEqual([]);
    expect(managerFindings({ packageManager: `yarn@4.1.0+sha512.${HASH}` })).toEqual([]);
  });

  it("names a root with no packageManager field, or an empty one", () => {
    expect(managerFindings({})).toEqual([expect.stringContaining("There is no packageManager field")]);
    expect(managerFindings({ packageManager: "" })).toEqual([expect.stringContaining("There is no packageManager field")]);
  });

  it("names a version that is a range, a tag or half a version", () => {
    for (const packageManager of ["pnpm@^12.6.0", "pnpm@latest", "pnpm@12", "pnpm"]) {
      expect(managerFindings({ packageManager })).toEqual([expect.stringContaining(`packageManager is "${packageManager}". Write one exact version`)]);
    }
  });

  it("names a hash that is too short, in capitals, or of a weaker kind", () => {
    expect(managerFindings({ packageManager: `pnpm@12.6.0+sha512.${HASH.slice(1)}` })).toEqual([expect.stringContaining("which is not +sha512. and 128 hex digits")]);
    expect(managerFindings({ packageManager: `pnpm@12.6.0+sha512.${HASH.toUpperCase()}` })).toEqual([expect.stringContaining("which is not +sha512.")]);
    expect(managerFindings({ packageManager: `pnpm@12.6.0+sha1.${HASH.slice(0, 40)}` })).toEqual([expect.stringContaining('ends in "+sha1.')]);
    expect(managerFindings({ packageManager: `pnpm@12.6.0+sha512.${HASH}0` })).toEqual([expect.stringContaining("which is not +sha512.")]);
  });

  it("is asked of the root manifest only, and only when that file is among the files given", () => {
    const root = createRoot({ packageManager: "pnpm@12.6.0" });

    expect(checkPackageManager({ root }, ["packages/domain/package.json"])).toEqual([]);
    expect(checkPackageManager({ root }, ["package.json"])).toHaveLength(1);
  });
});

describe("the rule for an entry of vendorOnlyIn", () => {
  const config = (vendorOnlyIn: Record<string, string[]>): ResolvedConfig =>
    ({ packages: { "packages/server": { role: "server" } }, adapters: [], frameworks: [], vendorOnlyIn }) as unknown as ResolvedConfig;
  const vendorRules = (vendorOnlyIn: Record<string, string[]>): Rule[] => buildRules(config(vendorOnlyIn), []).filter((rule) => rule.name.endsWith("-only-in-its-packages"));

  it("is named by the entry's own key, with a scope written as a scope", () => {
    expect(["ws", "react-dom", "@hono/", "@hono/node-server", "hono"].map(vendorRuleName)).toEqual([
      "ws-only-in-its-packages",
      "react-dom-only-in-its-packages",
      "@hono/*-only-in-its-packages",
      "@hono/node-server-only-in-its-packages",
      "hono-only-in-its-packages",
    ]);
  });

  it("has a name no other entry can have, whatever the set", () => {
    // Every pair here had one name under the old naming, which dropped the `@` and turned each `/` into a dash.
    const keys = ["hono", "@hono/", "@hono/node-server", "hono-node-server", "hono/node-server", "@a/b-c", "@a-b/c", "a-b-c", "a/b/c", "@a/"];
    const names = vendorRules(Object.fromEntries(keys.map((key) => [key, ["packages/server"]]))).map((rule) => rule.name);

    expect(names).toHaveLength(keys.length);
    expect(new Set(names).size).toBe(keys.length);
  });

  it("keeps its name when other entries come and go, in any order", () => {
    const alone = vendorRules({ "@hono/": ["packages/server"] }).map((rule) => rule.name);
    const amongOthers = vendorRules({ hono: ["packages/server"], ws: [], "@hono/": ["packages/server"] }).map((rule) => rule.name);

    expect(amongOthers).toContain(alone[0]);
  });

  it("carries its own list for the demo's pair, when the two lists differ", () => {
    const rules = vendorRules({ hono: ["packages/server"], "@hono/": ["packages/server", "packages/integration"] });

    expect(rules.map(({ name, comment, to }) => [name, comment.split(". ")[0], to.path])).toEqual([
      ["hono-only-in-its-packages", '"hono" may be imported only from: packages/server', "(^|node_modules/)hono(/|$)"],
      ["@hono/*-only-in-its-packages", '"@hono/" may be imported only from: packages/server, packages/integration', "(^|node_modules/)@hono(/|$)"],
    ]);
  });
});

describe("two entries of vendorOnlyIn that cannot both mean what they say", () => {
  it("accepts a package and a scope of the same word, with different lists: no import is under both", () => {
    expect(readVendorEntries("architecture.config.mts", { hono: ["packages/server/"], "@hono/": ["packages/server", "packages/integration"] })).toEqual({
      hono: ["packages/server"],
      "@hono/": ["packages/server", "packages/integration"],
    });
  });

  it.each([
    [{ "@hono": ["packages/server"], "@hono/": ["packages/integration"] }, 'architecture.config.mts: vendorOnlyIn names "@hono" and "@hono/", which are the same thing: both cover every import of "@hono" and of anything under it. Keep one, with the list that is meant.'],
    [{ "ws/": [], ws: ["packages/server"] }, 'architecture.config.mts: vendorOnlyIn names "ws/" and "ws", which are the same thing: both cover every import of "ws" and of anything under it. Keep one, with the list that is meant.'],
  ])("refuses two keys for one thing, even with one list: %j", (entries, message) => {
    expect(() => readVendorEntries("architecture.config.mts", entries)).toThrow(new ConfigError(message));
  });

  it("refuses a narrower entry that allows what the wider one refuses, in either order, and says both ways out", () => {
    const message =
      'architecture.config.mts: vendorOnlyIn allows "@hono/node-server" in packages/integration, but "@hono/" covers that import too and does not allow it there, so it would still be refused. Add packages/integration to "@hono/", or take it out of "@hono/node-server".';

    expect(() => readVendorEntries("architecture.config.mts", { "@hono/": ["packages/server"], "@hono/node-server": ["packages/server", "packages/integration"] })).toThrow(new ConfigError(message));
    expect(() => readVendorEntries("architecture.config.mts", { "@hono/node-server": ["packages/server", "packages/integration"], "@hono/": ["packages/server"] })).toThrow(new ConfigError(message));
  });

  it("accepts a narrower entry that only takes packages away: both rules hold, each with its own name", () => {
    expect(() => readVendorEntries("architecture.config.mts", { "@hono/": ["packages/server", "packages/integration"], "@hono/node-server": ["packages/server"] })).not.toThrow();
    expect(() => readVendorEntries("architecture.config.mts", { hono: ["packages/server"], "hono/jsx": [] })).not.toThrow();
  });

  it("does not read a name that only begins like another as inside it", () => {
    expect(() => readVendorEntries("architecture.config.mts", { ws: ["packages/server"], "ws-extra": ["packages/integration"], "@hono/": [], "@hono-tools/x": ["packages/server"] })).not.toThrow();
  });

  it("stops the gates with that message: a project so declared is not judged", async () => {
    const root = mkdtempSync(join(tmpdir(), "vendor-entries-"));

    writeFileSync(join(root, "architecture.config.mts"), 'export default { packages: {}, vendorOnlyIn: { "@hono": [], "@hono/": [] } };\n');

    await expect(runGates({ root })).rejects.toThrow(/vendorOnlyIn names "@hono" and "@hono\/", which are the same thing/);
    await expect(runGates({ root })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("a project that cannot be judged", () => {
  it("refuses instead of passing when no layers are declared", async () => {
    await expect(runGates({ root: fixtures })).rejects.toBeInstanceOf(ConfigError);
  });
});

/** What the package-manager gate says about a project whose root package.json is this. */
function managerFindings(manifest: object): string[] {
  return checkPackageManager({ root: createRoot(manifest) }).map((finding) => finding.message);
}

function createRoot(manifest: object): string {
  const root = mkdtempSync(join(tmpdir(), "arch-manager-"));

  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));

  return root;
}

/** What the node-floor gate says about a project whose root package.json is this. */
function floorFindings(manifest: object): string[] {
  const root = mkdtempSync(join(tmpdir(), "arch-floor-"));

  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));

  return checkNodeFloor({ root, workspace: [] }).map((finding) => finding.message);
}
