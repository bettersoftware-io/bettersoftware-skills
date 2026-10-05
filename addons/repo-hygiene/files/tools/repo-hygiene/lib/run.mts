// Runs a command-line tool the project has installed, and tells "it found
// problems" from "it did not run".

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The check has no verdict: a tool is missing, crashed, or said something unreadable. Exit 2. */
export class CouldNotRun extends Error {}

export interface ToolRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the tool called `name` with `args`. Replaced by a fake in tests. */
export type RunTool = (name: string, args: string[]) => ToolRun;

/** Runs tools from the project's own `node_modules/.bin`, in the project root, without colour. */
export function installedTools(root: string): RunTool {
  return (name, args) => {
    const command = join(root, "node_modules", ".bin", name);

    if (!existsSync(command)) {
      throw new CouldNotRun(`${name} is not installed (there is no node_modules/.bin/${name}). Run \`pnpm install\`.`);
    }

    const ran = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    if (ran.error !== undefined || ran.status === null) {
      throw new CouldNotRun(`${name} did not run to the end: ${ran.error?.message ?? `stopped by ${ran.signal}`}`);
    }

    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  };
}

/** The first line of what a tool printed that says anything, for a "could not run" message. */
export function firstLine(...outputs: string[]): string {
  for (const output of outputs) {
    const line = output.split("\n").find((candidate) => candidate.trim() !== "");

    if (line !== undefined) {
      return line.trim();
    }
  }

  return "it printed nothing";
}
