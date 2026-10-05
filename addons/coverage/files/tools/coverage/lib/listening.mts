// Whether the tests that need a port can run here, and which packages have any.
//
// Some sandboxes do not let a process listen on a port: Codex's default one
// does not. A project's packages leave out their `*.port.test.ts` files there
// (see `tools/arch/testing/portTests.mts`). A package measured without them
// would read lower than it is and fail the bar for a reason that is not in the
// code, so the gate does not judge it there. In CI nothing is ever skipped.
//
// The probe is repeated here, small as it is, so that this tool depends on no
// file outside its own folder.

import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

const PORT_TEST = /\.port\.test\.[cm]?tsx?$/;
const NOT_SOURCE = new Set(["node_modules", "dist", "coverage", ".turbo"]);

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

/** True where the packages leave their port tests out. Never in CI, which is not even asked. */
export async function portTestsAreSkipped(
  environment: NodeJS.ProcessEnv = process.env,
  probe: () => Promise<boolean> = canListen,
): Promise<boolean> {
  return !environment.CI && !(await probe());
}

/** True when the package in `directory` holds a test that needs a port. */
export function hasPortTests(root: string, directory: string): boolean {
  const folder = join(root, directory);

  if (!existsSync(folder)) {
    return false;
  }

  return readdirSync(folder, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? !NOT_SOURCE.has(entry.name) && hasPortTests(root, `${directory}/${entry.name}`)
      : PORT_TEST.test(entry.name),
  );
}
