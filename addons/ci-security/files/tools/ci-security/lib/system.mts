// The four places the tool touches the machine: the network, tar, a child
// process and the PATH. Everything that decides something is in install.mts
// and lint.mts, and takes these as arguments.

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Download, Extract } from "./install.mts";

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** A download over https. `request` is Node's own `fetch` unless a test gives another. */
export function createDownload(request: typeof fetch = fetch): Download {
  return async (url) => {
    let response: Response;

    try {
      // A release download answers with a redirect to where the file is stored.
      response = await request(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      // fetch says only "fetch failed"; the reason (no DNS, refused, timed out) is in `cause`.
      const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;

      throw new Error(reason instanceof Error ? reason.message : String(reason));
    }

    if (!response.ok) {
      throw new Error(`the server answered ${response.status} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  };
}

/** Takes one file out of a .tar.gz with the system's tar. Throws when tar fails or is missing. */
export const extractWithTar: Extract = (archive, directory, member) => {
  execFileSync("tar", ["-xzf", archive, "-C", directory, member], { stdio: "pipe" });
};

/** Runs a program in `root` with the terminal as its output. Null: it was killed or did not start. */
export function runInherited(binary: string, runArguments: string[], root: string): number | null {
  return spawnSync(binary, runArguments, { cwd: root, stdio: "inherit" }).status;
}

/** True when a file of that name in a folder of `path` can be run. */
export function hasCommand(name: string, path: string | undefined): boolean {
  return (path ?? "")
    .split(delimiter)
    .filter((folder) => folder !== "")
    .some((folder) => isExecutable(join(folder, name)));
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);

    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * True when the module at `moduleUrl` is the script Node was asked to run.
 * Compares real paths: reached through a symlink, a naive comparison is false
 * and the script would exit 0 having done nothing.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}
