// Runs the workflow linters and says what happened, in three words:
//
//   PASS  the linter ran and found nothing
//   FAIL  the linter found a problem; its own output, printed above the line, names it
//   SKIP  the linter could not run here, and the reason is given. Not a pass
//
// A linter that could not be installed, that broke, or that had nothing to
// read is always a SKIP with exit 2. It is never counted as clean.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Installed } from "./install.mts";
import type { Pin } from "./pins.mts";
import { ACTIONLINT, ZIZMOR } from "./pins.mts";

export const WORKFLOWS = ".github/workflows";

/** What the machine this runs on has, as far as a linter's reach depends on it. */
export interface Surroundings {
  env: Record<string, string | undefined>;
  /** True when a program of that name is on the PATH. */
  hasCommand: (name: string) => boolean;
}

type Outcome = "clean" | "findings" | "broken";

export interface Linter {
  pin: Pin;
  arguments: string[];
  /** What a clean run means, for the PASS line. */
  clean: string;
  /** Reads the linter's exit status. */
  judge: (status: number) => Outcome;
  /** What the linter leaves unchecked on this machine. Undefined: nothing. */
  unchecked: (surroundings: Surroundings) => string | undefined;
}

/** The names zizmor reads a GitHub token from. With none, it runs only the checks that need no network. */
const ZIZMOR_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "ZIZMOR_GITHUB_TOKEN"];

/** In the order they run: there is no use asking whether an invalid workflow is safe. */
export const LINTERS: Record<string, Linter> = {
  actionlint: {
    pin: ACTIONLINT,
    arguments: [],
    clean: "every workflow is valid",
    // actionlint: 0 no problem, 1 problems found, 2 bad options, 3 fatal error.
    judge: (status) => (status === 0 ? "clean" : status === 1 ? "findings" : "broken"),
    unchecked: ({ hasCommand }) => (hasCommand("shellcheck") ? undefined : "the shell in run: steps, because shellcheck is not installed"),
  },
  zizmor: {
    pin: ZIZMOR,
    arguments: ["--no-progress", ".github/"],
    clean: "no security finding",
    // zizmor: 0 no finding, 1 an error of its own, 10 to 14 findings, by the highest severity among them.
    judge: (status) => (status === 0 ? "clean" : status >= 10 && status <= 14 ? "findings" : "broken"),
    unchecked: ({ env }) =>
      ZIZMOR_TOKENS.some((name) => (env[name] ?? "") !== "")
        ? undefined
        : "what must be asked of GitHub, such as an action with a known advisory, because GH_TOKEN is not set",
  },
};

export interface LintOptions extends Surroundings {
  /** The project root. Each linter runs here. */
  root: string;
  /** Which linters to run, by name. Empty: all of them. */
  names: string[];
  install: (pin: Pin) => Promise<Installed>;
  /** Runs the binary in `root`, its output going straight to the terminal. Null: it was killed or did not start. */
  run: (binary: string, runArguments: string[], root: string) => number | null;
  /** Called with each line as soon as it is known, so it follows the linter's own output. */
  report: (line: string) => void;
}

/** Exit 0: every linter ran and found nothing. 1: one found a problem. 2: one could not run, or there was nothing to lint. */
export type ExitCode = 0 | 1 | 2;

export async function lintWorkflows({ root, names, install, run, report, ...surroundings }: LintOptions): Promise<ExitCode> {
  const unknown = names.find((name) => !Object.hasOwn(LINTERS, name));

  if (unknown !== undefined) {
    report(`SKIP workflow lint: there is no linter called "${unknown}". Choose from: ${Object.keys(LINTERS).join(", ")}.`);

    return 2;
  }

  if (listWorkflows(root).length === 0) {
    report(`SKIP workflow lint: ${WORKFLOWS} holds no .yml or .yaml file, so there was nothing to lint.`);

    return 2;
  }

  let found = false;
  let couldNotRun = false;

  for (const name of names.length === 0 ? Object.keys(LINTERS) : names) {
    const linter = LINTERS[name] as Linter;
    const label = `${linter.pin.name} ${linter.pin.version}`;
    const installed = await install(linter.pin);

    if (!installed.ok) {
      report(`SKIP ${label}: could not run. ${installed.reason}`);
      couldNotRun = true;
      continue;
    }

    const status = run(installed.binary, linter.arguments, root);
    const outcome = status === null ? "broken" : linter.judge(status);

    if (outcome === "broken") {
      report(
        `SKIP ${label}: could not run. ${
          status === null
            ? "Its process was killed or did not start."
            : `It stopped with exit status ${status}, which is an error of its own and not a finding; its message is above.`
        }`,
      );
      couldNotRun = true;
      continue;
    }

    const unchecked = linter.unchecked(surroundings);
    const note = unchecked === undefined ? "" : ` (not checked here: ${unchecked}; CI checks it)`;

    if (outcome === "findings") {
      report(`FAIL ${label}: it found the problems listed above. Fix the workflow; do not silence the linter.${note}`);
      found = true;
    } else {
      report(`PASS ${label}: ${linter.clean}${note}`);
    }
  }

  return found ? 1 : couldNotRun ? 2 : 0;
}

/** The workflow files in the project, as paths from its root. */
export function listWorkflows(root: string): string[] {
  const directory = join(root, WORKFLOWS);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => `${WORKFLOWS}/${name}`);
}
