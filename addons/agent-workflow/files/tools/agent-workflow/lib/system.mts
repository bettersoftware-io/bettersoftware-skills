import { spawnSync } from "node:child_process";

export interface Ran {
  /** The exit code; 127 when the program could not be started. */
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a program and waits for it. Replaced in tests. */
export type Run = (program: string, args: string[], cwd: string) => Ran;

/** Runs the program with its output captured. A program that is not installed is a failed run, not a crash. */
export const run: Run = (program, args, cwd) => {
  const result = spawnSync(program, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  return {
    status: result.error === undefined ? (result.status ?? 1) : 127,
    stdout: result.stdout ?? "",
    stderr: result.error === undefined ? (result.stderr ?? "") : result.error.message,
  };
};

/** Runs the program with its output shown as it comes: for an install, which takes a while. */
export const runShown: Run = (program, args, cwd) => {
  const result = spawnSync(program, args, { cwd, stdio: "inherit" });

  return {
    status: result.error === undefined ? (result.status ?? 1) : 127,
    stdout: "",
    stderr: result.error === undefined ? "" : result.error.message,
  };
};
