import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ConfigError } from "./lib/config.mjs";
import { formatFindings, runGates } from "./run.mjs";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const clean = join(fixtures, "clean");
const broken = join(fixtures, "broken");

const UI = "packages/client-react/src/ui/PriceList.tsx";

describe("a project that follows the rules", () => {
  it("passes every gate", async () => {
    const result = await runGates({ root: clean });

    expect(result.findings).toEqual([]);
    expect(result.gates).toEqual(["structure", "dumb-ui", "port-contracts", "dependencies"]);
    expect(result.skipped).toEqual({});
    expect(formatFindings(result)).toContain("all gates passed.");
  });

  it("does not read a rule name in a comment as a violation", async () => {
    const result = await runGates({ root: clean, files: [UI] });

    expect(result.findings).toEqual([]);
  });
});

describe("a project that breaks the rules", () => {
  let findings;

  const of = (gate, file) =>
    findings.filter((finding) => finding.gate === gate && (file === undefined || finding.file === file));
  const messages = (gate, file) => of(gate, file).map((finding) => finding.message).join("\n");

  it("is judged", async () => {
    findings = (await runGates({ root: broken })).findings;

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

  it("names an import that points outward", () => {
    const outward = messages("dependencies", "packages/domain/src/useCases/reachesOutward.ts");

    expect(outward).toContain("domain-imports-inward-only");
    expect(outward).toContain("domain-no-node-builtins");
  });

  it("names the UI importing the composition root and an adapter", () => {
    const edges = messages("dependencies", UI);

    expect(edges).toContain("client-react-ui-never-imports-app");
    expect(edges).toContain("client-react-ui-never-imports-adapters");
  });
});

describe("the per-file path the editor hook uses", () => {
  it("judges only the files it is given", async () => {
    const result = await runGates({ root: broken, files: [UI, "packages/client-react/src/feed.ts"] });

    expect(result.gates).toEqual(["structure", "dumb-ui"]);
    expect(new Set(result.findings.map((finding) => finding.file))).toEqual(
      new Set([UI, "packages/client-react/src/feed.ts"]),
    );
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

describe("a gate with nothing to judge", () => {
  it("is reported as skipped, never as passed", async () => {
    const result = await runGates({ root: join(fixtures, "dormant") });
    const report = formatFindings(result);

    expect(result.skipped).toEqual({
      "dumb-ui": "no UI files were found, so there was nothing to check",
      "port-contracts": "no port interfaces were found, so there was nothing to check",
    });
    expect(report).toContain("SKIP dumb-ui");
    expect(report).toContain("SKIP port-contracts");
    expect(report).not.toContain("PASS dumb-ui");
  });
});

describe("a project that cannot be judged", () => {
  it("refuses instead of passing when no layers are declared", async () => {
    await expect(runGates({ root: fixtures })).rejects.toBeInstanceOf(ConfigError);
  });
});
