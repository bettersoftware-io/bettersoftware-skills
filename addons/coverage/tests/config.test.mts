import { describe, expect, it } from "vitest";

import { CoverageError, DEFAULTS, loadConfig, mergeConfig } from "../files/tools/coverage/lib/config.mts";
import { createFolder } from "./support.mts";

describe("the bar and what is measured", () => {
  it("holds every file to 95% of lines, statements and functions and 85% of branches by default", async () => {
    const config = await loadConfig(createFolder());

    expect(config.thresholds).toEqual({ lines: 95, statements: 95, functions: 95, branches: 85 });
    expect(config).toBe(DEFAULTS);
  });

  it("leaves test code out by default, each pattern with its reason", () => {
    expect(Object.keys(DEFAULTS.exclude)).toEqual(
      expect.arrayContaining(["**/*.d.ts", "**/*.page.{ts,tsx}", "**/__contracts__/**", "**/testing/**"]),
    );
    expect(Object.values(DEFAULTS.exclude).every((reason) => reason.length > 0)).toBe(true);
  });

  it("reads the project's own file, adding its exclusions and replacing only the metrics it names", async () => {
    const root = createFolder({
      "tools/coverage.config.mts": createConfigModule({
        thresholds: { branches: 90 },
        exclude: { "packages/shared/src/generated/**": "written by the schema generator" },
      }),
    });
    const config = await loadConfig(root);

    expect(config.thresholds).toEqual({ lines: 95, statements: 95, functions: 95, branches: 90 });
    expect(config.exclude).toEqual({ ...DEFAULTS.exclude, "packages/shared/src/generated/**": "written by the schema generator" });
    expect(config.include).toEqual(DEFAULTS.include);
  });

  it("replaces the include patterns when the project gives its own", () => {
    expect(mergeConfig({ include: ["lib/**/*.ts"] }).include).toEqual(["lib/**/*.ts"]);
  });

  it("refuses an exclusion without a reason", () => {
    expect(() => mergeConfig({ exclude: { "src/hard-to-test/**": " " } })).toThrow(CoverageError);
    expect(() => mergeConfig({ exclude: { "src/hard-to-test/**": " " } })).toThrow(/excluded without a reason/);
  });

  it("refuses a bar that is not a percentage", () => {
    expect(() => mergeConfig({ thresholds: { lines: 950 } })).toThrow(/number from 0 to 100/);
  });

  it("refuses a metric it does not know", () => {
    expect(() => mergeConfig({ thresholds: { line: 95 } })).toThrow(/"line" is not a metric/);
  });

  it("refuses a key it does not know, so a misspelt one is not silently ignored", () => {
    expect(() => mergeConfig({ excludes: {} })).toThrow(/unknown key "excludes"/);
  });

  it("refuses an empty include, which would measure nothing", () => {
    expect(() => mergeConfig({ include: [] })).toThrow(/at least one glob/);
  });

  it("refuses a file that exports no object", () => {
    expect(() => mergeConfig(undefined)).toThrow(/must default-export an object/);
  });
});

function createConfigModule(config: object): string {
  return `export default ${JSON.stringify(config, null, 2)};\n`;
}
