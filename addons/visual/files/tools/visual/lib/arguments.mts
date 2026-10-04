// What `pnpm visual:jitter` was asked to do.

import { resolve } from "node:path";

const DEFAULT_RUNS = 3;

export class UsageError extends Error {}

export type JitterRequest = { mode: "capture"; runs: number } | { mode: "compare"; directories: string[] };

export function parseArguments(argv: string[]): JitterRequest {
  const directories: string[] = [];
  let runs: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (argument === "--runs") {
      runs = Number(argv[index + 1]);
      index += 1;

      if (!Number.isInteger(runs) || runs < 2) {
        throw new UsageError("--runs needs a whole number of 2 or more: noise is a difference between captures");
      }
    } else if (argument.startsWith("--")) {
      throw new UsageError(`unknown argument "${argument}"`);
    } else {
      directories.push(resolve(argument));
    }
  }

  if (directories.length === 0) {
    return { mode: "capture", runs: runs ?? DEFAULT_RUNS };
  }

  if (runs !== undefined) {
    throw new UsageError("give --runs or folders to compare, not both");
  }

  if (directories.length < 2) {
    throw new UsageError("give at least two folders to compare");
  }

  return { mode: "compare", directories };
}
