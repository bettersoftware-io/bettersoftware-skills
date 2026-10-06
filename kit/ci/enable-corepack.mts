#!/usr/bin/env node
// Installs Corepack from a lockfile and enables it, so that `pnpm` is the
// version the project's `packageManager` field pins.
//
//   node tools/arch/ci/enable-corepack.mts [home-dir]   default: $RUNNER_TEMP/corepack
//
// Node 25 and later no longer ship Corepack, so a workflow has to install it
// before it can provision pnpm. `npm install -g corepack` is outside every
// lockfile, and the workflow security lint and OpenSSF Scorecard both report
// it. pnpm's own lockfile cannot hold it, since Corepack is what provides
// pnpm. npm ships with Node, so an npm lockfile can: `corepack/package-lock.json`
// pins one version with a sha512 hash, and `npm ci` installs that or fails.
//
// Nothing is written into the checkout. The install goes to <home-dir>/pkg and
// the `pnpm` shim to <home-dir>/bin, which is added to the PATH of the later
// steps when this runs in GitHub Actions.
//
// Skip it where pnpm is already installed: on a developer's machine, or in a
// workflow that provides pnpm another way.

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "../gates/lib/files.mts";

const PINNED = join(import.meta.dirname, "corepack");

export class CorepackError extends Error {}

export interface Command {
  command: string;
  args: string[];
  cwd?: string;
}

export interface CommandResult {
  status: number | null;
  output: string;
}

export interface CorepackOptions {
  /** Where Corepack is installed. Never inside the checkout. */
  home?: string;
  env?: Record<string, string | undefined>;
  /** Swapped in a test, which must not reach the network. */
  run?: (command: Command) => CommandResult;
}

export interface EnabledCorepack {
  /** The folder that holds the `pnpm` shim. */
  bin: string;
}

export function enableCorepack({ home, env = process.env, run = runCommand }: CorepackOptions = {}): EnabledCorepack {
  const directory = home ?? (env.RUNNER_TEMP === undefined ? undefined : join(env.RUNNER_TEMP, "corepack"));

  if (directory === undefined) {
    throw new CorepackError("no folder to install Corepack into: pass one, or run in GitHub Actions, where RUNNER_TEMP is set");
  }

  const pkg = join(directory, "pkg");
  const bin = join(directory, "bin");

  mkdirSync(pkg, { recursive: true });
  mkdirSync(bin, { recursive: true });

  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(join(PINNED, file), join(pkg, file));
  }

  // Run in the folder, not with `--prefix`: from inside a repository, npm
  // takes the repository as the project and the lockfile no longer matches.
  // `--ignore-scripts`: nothing a package ships runs at install time.
  must(run({ command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd: pkg }), "npm ci");
  must(
    run({ command: join(pkg, "node_modules", ".bin", "corepack"), args: ["enable", "--install-directory", bin] }),
    "corepack enable",
  );

  if (env.GITHUB_PATH) {
    appendFileSync(env.GITHUB_PATH, `${bin}\n`);
  }

  return { bin };
}

function must({ status, output }: CommandResult, step: string): void {
  if (status !== 0) {
    throw new CorepackError(`${step} failed (exit ${status ?? "none"}), so pnpm was not provided.\n${output.trim()}`);
  }
}

function runCommand({ command, args, cwd }: Command): CommandResult {
  const { status, stdout, stderr, error } = spawnSync(command, args, { cwd, encoding: "utf8" });

  return { status, output: error ? error.message : `${stdout}${stderr}` };
}

if (isMainModule(import.meta.url)) {
  try {
    const { bin } = enableCorepack({ home: process.argv[2] });

    console.log(`Corepack is enabled. pnpm is in ${bin}`);
  } catch (error) {
    console.error(error instanceof CorepackError ? `enable-corepack: ${error.message}` : error);
    process.exit(1);
  }
}
