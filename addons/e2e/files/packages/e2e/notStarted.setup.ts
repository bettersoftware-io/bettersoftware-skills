import { test } from "@playwright/test";

// The only test there is when `playwright test` is called by hand. The
// Playwright config builds and serves nothing: the runner does, and passes
// the addresses on.
test("the run is started with `pnpm e2e`, from the project root", () => {
  throw new Error(
    "There is no address to open: nothing has built or served the client. From the project root, run `pnpm e2e`. It builds the client, serves the build, starts the server, runs the specs and stops everything again. Arguments are passed on to Playwright: `pnpm e2e src/sim/priceList.spec.ts`, `pnpm e2e --headed`, `pnpm e2e --ui`.",
  );
});
