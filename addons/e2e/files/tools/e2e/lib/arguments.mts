// What `pnpm e2e` was asked to do.

export class UsageError extends Error {}

export interface Request {
  /** The modes named with --mode. Empty: every mode. */
  modes: string[];
  /** Everything else, handed to the test runner as it is. */
  forwarded: string[];
}

export const USAGE = [
  "usage: pnpm e2e [--mode <name>]... [-- <arguments for playwright test>]",
  "",
  "  pnpm e2e                                   every mode, every spec",
  "  pnpm e2e --mode sim                        one mode: only what it needs is built and started",
  "  pnpm e2e src/sim/priceList.spec.ts         one spec",
  '  pnpm e2e -g "selects the row"              the tests whose title matches',
  "  pnpm e2e --mode sim --headed               a visible browser",
].join("\n");

export function parseArguments(argv: string[]): Request {
  const request: Request = { modes: [], forwarded: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (argument === "--") {
      // pnpm hands the separator on. What follows is the test runner's.
      request.forwarded.push(...argv.slice(index + 1));
      break;
    }

    if (argument === "--mode") {
      const name = argv[index + 1];

      if (name === undefined || name.startsWith("-")) {
        throw new UsageError('"--mode" needs the name of a mode');
      }

      request.modes.push(name);
      index += 1;
    } else if (argument.startsWith("--mode=")) {
      request.modes.push(argument.slice("--mode=".length));
    } else {
      request.forwarded.push(argument);
    }
  }

  return { modes: [...new Set(request.modes)], forwarded: request.forwarded };
}
