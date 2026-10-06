import { defineConfig, devices } from "@playwright/test";

// What `pnpm e2e` started, by mode: where the built client is served and,
// when the mode has one, its server: the address it printed, and its host and
// port. The runner (tools/e2e/run.mts) starts them, passes this on, and stops
// them again.
interface RunningMode {
  baseURL: string;
  serverURL?: string;
  serverHost?: string;
}

/**
 * What every test of a mode is handed about the mode's server. A fixture
 * reads one by declaring an option of that name (src/testing/test.ts, which
 * is the project's). Both are empty in a mode that has no server.
 *
 * Declared here, not imported from the project's file: this config belongs to
 * the add-on, and must not stop typechecking because a project's fixtures
 * read one of the two and not the other.
 */
interface HandedToTests {
  /** The server's host and port, as in `localhost:4000`. */
  serverHost: string;
  /** The server's address as it printed it. */
  serverUrl: string;
}

const MODES_VARIABLE = "E2E_MODES";

/** Undefined when the runner did not start this: `playwright test` was called by hand. */
function readModes(): Record<string, RunningMode> | undefined {
  const passed = process.env[MODES_VARIABLE];

  return passed === undefined
    ? undefined
    : (JSON.parse(passed) as Record<string, RunningMode>);
}

const modes = readModes();

export default defineConfig<HandedToTests>({
  testDir: "src",
  testMatch: "**/*.spec.ts",
  // A spec waits on what the page shows, never on time, and each test opens a
  // page of its own, so the specs can run side by side.
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  // A retry would hide a spec that only sometimes passes. That is a spec, or
  // an application, to fix.
  retries: 0,
  // Room for the one wait that is on chance (see src/sim/priceList.spec.ts).
  // A spec that waits on a state fails on that wait's own, shorter, limit.
  timeout: 60_000,
  // The HTML report holds the trace of each failure: every step, the page at
  // that step, the network and the console. The JSON file is how the runner
  // knows how many specs ran.
  reporter: [
    [process.env.CI === undefined ? "list" : "github"],
    ["html", { outputFolder: "reports/html", open: "never" }],
    ["json", { outputFile: "reports/results.json" }],
  ],
  outputDir: "reports/artifacts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects:
    modes === undefined
      ? // This config starts no server, so on its own it has nothing to
        // open. The one test of this project fails and says how to start.
        [
          {
            name: "not-started",
            testDir: ".",
            testMatch: "notStarted.setup.ts",
          },
        ]
      : // One project for each mode that was started. A mode's specs are in
        // the folder of its name, so a spec runs against the stack it was
        // written for.
        Object.entries(modes).map(
          ([name, { baseURL, serverURL, serverHost }]) => {
            return {
              name,
              testDir: `src/${name}`,
              use: {
                ...devices["Desktop Chrome"],
                baseURL,
                serverHost: serverHost ?? "",
                serverUrl: serverURL ?? "",
              },
            };
          },
        ),
});
