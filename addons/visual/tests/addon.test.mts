import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What the add-on promises about who owns what. The host is the add-on's and
// an update replaces it; how a scenario's data becomes app state is the
// project's. A feature once had to edit the host, and every update after
// that was refused.

const ADDON = dirname(dirname(fileURLToPath(import.meta.url)));
const VISUAL = "packages/client-react/tests/visual";
const MANIFEST = JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as {
  startingFiles: string[];
  movedToProject: Record<string, { to: string; note: string }>;
};

function readShipped(path: string): string {
  return readFileSync(join(ADDON, "files", VISUAL, path), "utf8");
}

/** The fields a scenario may hold, read from the shipped `Scenario`. */
function scenarioFields(): string[] {
  const body = /export interface Scenario \{([\s\S]*?)\n\}/.exec(readShipped("scenarios.ts"))?.[1] ?? "";

  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1] as string);
}

describe("who owns what in the visual tier", () => {
  it("gives the project the scenarios and the seeding, and keeps the host", () => {
    expect(MANIFEST.startingFiles).toContain(`${VISUAL}/scenarios.ts`);
    expect(MANIFEST.startingFiles).toContain(`${VISUAL}/seeding.ts`);
    expect(MANIFEST.startingFiles.filter((path) => path.includes("/host/"))).toEqual([]);
  });

  it("sends a project that edited the host to the seeding", () => {
    expect(Object.keys(MANIFEST.movedToProject)).toEqual([`${VISUAL}/host/main.tsx`]);
    expect(MANIFEST.movedToProject[`${VISUAL}/host/main.tsx`]?.to).toBe(`${VISUAL}/seeding.ts`);
  });

  it("reads the fields of a scenario from the shipped file", () => {
    expect(scenarioFields()).toEqual(["stalePrices", "prices", "selected"]);
  });

  it.each(["host/main.tsx", "host/ScenarioFrame.tsx", "host/seeded.ts"])("%s names no field of a scenario and builds no harness", (file) => {
    const source = readShipped(file);

    for (const field of scenarioFields()) {
      expect(source, `${file} reads "${field}": that belongs in seeding.ts`).not.toMatch(new RegExp(`\\b${field}\\b`));
    }

    expect(source).not.toContain("appHarness");
    expect(source).not.toContain("/presenters/");
  });

  it("has the host take the application and the deliveries from the seeding, after its clock is installed", () => {
    const host = readShipped("host/main.tsx");

    expect(host).toContain('import { seedScenario } from "../seeding.ts";');
    expect(host.indexOf("FakeTimers.install(")).toBeGreaterThan(-1);
    expect(host.indexOf("seedScenario(scenario,")).toBeGreaterThan(host.indexOf("FakeTimers.install("));
    expect(host).toContain("createViewModel(seeded.app)");
    expect(host).toContain("<ScenarioFrame seed={seeded.deliver}>");
  });

  it("has the seeding export what the host imports, with the host's types", () => {
    const seeding = readShipped("seeding.ts");

    expect(seeding).toMatch(/export function seedScenario\(scenario: Scenario, clock: HostClock\): Seeded \{/);
    expect(seeding).toContain('import type { HostClock, Seeded } from "./host/seeded.ts";');
  });
});
