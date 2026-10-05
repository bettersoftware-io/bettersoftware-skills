// Tests that open a real port, and what to do where none can be opened.
//
// Some sandboxes do not let a process listen: Codex's default one does not.
// A test that starts a real server fails there with `listen EPERM`, the
// project's gate goes red on work that is correct, and the steps after the
// failing package never run.
//
// So a test that needs a port says so in its name, `*.port.test.ts`, and the
// package's vitest config leaves those files out where a port cannot be
// opened, with one line that says they were not verified:
//
//   import { configDefaults, defineConfig } from "vitest/config";
//   import { portTestsToSkip } from "../../tools/arch/testing/portTests.mts";
//
//   export default defineConfig(async () => {
//     const skipped = await portTestsToSkip();
//
//     return { test: { exclude: [...configDefaults.exclude, ...skipped], passWithNoTests: skipped.length > 0 } };
//   });
//
// Never in CI: there a test that cannot run is a failure, so a skip can never
// be how a change reaches the main branch. And a package with such tests must
// not have its `test` task cached, or a run that skipped them inside a sandbox
// would be replayed as the result outside it.

import { createServer, type Server } from "node:net";

/** The files that need a port, as a glob from a package's folder. */
export const PORT_TESTS = "**/*.port.test.{ts,tsx,mts}";

/** True when a process may listen on a port here. */
export function canListen(open: () => Server = createServer): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = open();

    server.once("error", (error: NodeJS.ErrnoException) => {
      // A refusal is an answer. Anything else is a fault to report, not a "no".
      if (error.code === "EPERM" || error.code === "EACCES") {
        resolve(false);
      } else {
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export interface PortTestsOptions {
  environment?: NodeJS.ProcessEnv;
  probe?: () => Promise<boolean>;
  say?: (line: string) => void;
}

/**
 * The test files to leave out of this run: those that need a port, where none
 * can be opened. Empty where one can, and always empty in CI.
 */
export async function portTestsToSkip({
  environment = process.env,
  probe = canListen,
  say = console.log,
}: PortTestsOptions = {}): Promise<string[]> {
  if (environment.CI || (await probe())) {
    return [];
  }

  say(
    `SKIP tests that need a port (${PORT_TESTS}) — this environment does not let a process listen on one, as Codex's sandbox does not. They are not verified here. They run where a port can be opened: outside the sandbox, in the stop hook, and in CI.`,
  );

  return [PORT_TESTS];
}
