// What is measured and how high the bar is: the defaults, and the project's
// own file that adds to them.
//
// A project that needs something else creates `tools/coverage.config.mts`:
//
//   import type { ProjectCoverageConfig } from "./coverage/lib/config.mts";
//
//   const config: ProjectCoverageConfig = {
//     exclude: {
//       "packages/shared/src/generated/**": "written by the schema generator",
//     },
//   };
//
//   export default config;
//
// That file belongs to the project. This one belongs to the add-on and is
// replaced when the add-on is updated, so do not edit it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const METRICS = ["lines", "statements", "functions", "branches"] as const;

export type Metric = (typeof METRICS)[number];

/** The lowest percentage a file may have, per metric. */
export type Thresholds = Record<Metric, number>;

export interface CoverageConfig {
  thresholds: Thresholds;
  /**
   * Globs from a package's folder. Every file they match is measured, whether
   * a test loads it or not, so a file with no test at all reads 0%.
   */
  include: string[];
  // Glob → why the files it matches are left out of the measurement. A glob is
  // written from the project root ("packages/server/src/index.ts"), or starts
  // with "**/" and then applies in every package.
  exclude: Record<string, string>;
}

/** What `tools/coverage.config.mts` may hold. */
export interface ProjectCoverageConfig {
  /** Replaces the bar for the metrics given. */
  thresholds?: Partial<Thresholds>;
  /** Replaces the default `include`. */
  include?: string[];
  /** Added to the default exclusions. Every pattern needs its reason. */
  exclude?: Record<string, string>;
}

/** The check could not run. It is reported with exit code 2, never as a pass. */
export class CoverageError extends Error {}

/** Where the project's own file is, from the project root. */
export const PROJECT_CONFIG = "tools/coverage.config.mts";

// The bar is per file. An average over a package hides one weak file: a
// package can read 99% while one of its files sits at 56%.
export const DEFAULTS: CoverageConfig = {
  thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },

  include: ["src/**/*.{ts,tsx,mts}"],

  // Test code is not what the tests are there to cover.
  exclude: {
    "**/*.d.ts": "declarations hold no code",
    "**/*.page.{ts,tsx}": "page objects are test code",
    "**/__contracts__/**": "port contract tests are test code",
    "**/__tests__/**": "test code",
    "**/__testUtils__/**": "test code",
    "**/testing/**": "test harnesses that other packages' tests import",
  },
};

/** The defaults, with the project's own file applied when there is one. */
export async function loadConfig(root: string): Promise<CoverageConfig> {
  const file = join(root, PROJECT_CONFIG);

  if (!existsSync(file)) {
    return DEFAULTS;
  }

  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };

  return mergeConfig(loaded.default);
}

/** Node runs the project's file without checking its types, so its shape is checked here. */
export function mergeConfig(project: unknown): CoverageConfig {
  if (typeof project !== "object" || project === null || Array.isArray(project)) {
    throw new CoverageError(`${PROJECT_CONFIG} must default-export an object`);
  }

  const { thresholds = {}, include = DEFAULTS.include, exclude = {}, ...unknown } = project as Record<string, unknown>;

  if (Object.keys(unknown).length > 0) {
    throw new CoverageError(`${PROJECT_CONFIG}: unknown key "${Object.keys(unknown)[0]}" — the keys are thresholds, include and exclude`);
  }

  if (typeof thresholds !== "object" || thresholds === null) {
    throw new CoverageError(`${PROJECT_CONFIG}: "thresholds" must be an object`);
  }

  for (const [metric, percent] of Object.entries(thresholds)) {
    if (!METRICS.includes(metric as Metric)) {
      throw new CoverageError(`${PROJECT_CONFIG}: "${metric}" is not a metric — the metrics are ${METRICS.join(", ")}`);
    }

    if (typeof percent !== "number" || !(percent >= 0 && percent <= 100)) {
      throw new CoverageError(`${PROJECT_CONFIG}: the bar for ${metric} must be a number from 0 to 100`);
    }
  }

  if (!Array.isArray(include) || include.length === 0 || include.some((pattern) => typeof pattern !== "string" || pattern === "")) {
    throw new CoverageError(`${PROJECT_CONFIG}: "include" must be a list of at least one glob`);
  }

  if (typeof exclude !== "object" || exclude === null || Array.isArray(exclude)) {
    throw new CoverageError(`${PROJECT_CONFIG}: "exclude" must map each glob to the reason it is left out`);
  }

  for (const [pattern, reason] of Object.entries(exclude)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new CoverageError(`${PROJECT_CONFIG}: "${pattern}" is excluded without a reason — say why no test can cover it`);
    }
  }

  return {
    thresholds: { ...DEFAULTS.thresholds, ...(thresholds as Partial<Thresholds>) },
    include: include as string[],
    exclude: { ...DEFAULTS.exclude, ...(exclude as Record<string, string>) },
  };
}
