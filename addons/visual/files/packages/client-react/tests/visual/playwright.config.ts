import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { GOLDENS_DIRECTORY } from "./goldens.ts";
import { HOST_URL } from "./host/address.ts";
import { TOLERANCE } from "./tolerance.ts";

// packages/client-react: the server command below runs from here.
const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  // Not `*.spec.ts` or `*.test.ts`: the package's unit test runner collects
  // those names, and this file can only run under Playwright.
  testMatch: "visual.pw.ts",
  snapshotPathTemplate: `${GOLDENS_DIRECTORY}/{arg}{ext}`,
  // A plain run never writes a golden. Playwright's default writes a missing
  // one, which lets a new scenario's first picture in unseen and makes the
  // second run pass. Only `pnpm visual:update` writes.
  updateSnapshots: "none",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  // A retry would hide a picture that only sometimes matches. That is a
  // scenario to fix, not to run twice.
  retries: 0,
  expect: {
    toHaveScreenshot: {
      ...TOLERANCE,
      // Finite animations are jumped to their end and endless ones stopped, so
      // the picture never catches one half-way.
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  // The HTML report shows the committed image, the new one and the difference
  // for every failure. The JSON file feeds the CI job summary.
  reporter: [
    [process.env.CI === undefined ? "list" : "github"],
    ["html", { outputFolder: "reports/html", open: "never" }],
    ["json", { outputFile: "reports/results.json" }],
  ],
  outputDir: "reports/artifacts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: HOST_URL,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    // Pinned, so the picture does not follow the settings of whoever runs it.
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
  },
  webServer: {
    cwd: PACKAGE,
    // The package's own vite, called directly. Through `pnpm exec` the wrapper
    // can die on Playwright's stop signal while vite lives on, and the run
    // then never ends.
    command: "node_modules/.bin/vite --config tests/visual/host/vite.config.ts",
    url: HOST_URL,
    // Never use a server this run did not start. One left over from another
    // checkout, or from before your change, serves the old UI: the tier passes,
    // or an update writes goldens of the wrong code, and nothing says so. With
    // `false` a taken port is an error, which is the right answer.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
