// Starts the programs a run needs and stops them again, whatever happens.
//
// Each program is started as the leader of a process group of its own, and is
// stopped by signalling the whole group. A server often starts a child (a
// bundler, a worker); signalling only the program that was started would
// leave that child holding the port.

import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

/** How long a group is given to leave after SIGTERM before it is killed. */
const GRACE_MS = 5000;
const POLL_MS = 50;
/** How long a program that has exited is given to finish printing. */
const LAST_WORDS_MS = 1000;
/** How much of a program's output is kept, for the message when it fails. */
const KEPT_OUTPUT = 8000;

const ESCAPE = String.fromCharCode(0x1b);
const COLOUR = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

export class StartError extends Error {}

export interface Launch {
  /** For messages: "the server of mode fullstack". */
  label: string;
  command: string[];
  /** An absolute folder. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface Started {
  label: string;
  /** The process, and the id of the group it leads. */
  pid: number;
  /** The first group of the `ready` pattern: the address it printed. */
  address: string;
}

export interface Finished {
  exitCode: number;
  /** The end of what it printed, both streams together. */
  output: string;
}

/** Every group this run started and has not yet seen gone. */
export interface Groups {
  start: (launch: Launch, ready: RegExp, timeoutMs: number) => Promise<Started>;
  /** Runs a program to its end, in a group of its own, with this run's terminal. Resolves with its exit code. */
  run: (launch: Launch) => Promise<number>;
  /** Runs a program to its end, in a group of its own, and keeps what it printed. */
  finish: (launch: Launch) => Promise<Finished>;
  /** Passes a signal on to every group. From then on nothing new is started. */
  signal: (signal: NodeJS.Signals) => void;
  /** SIGTERM to every group, SIGKILL to what is left after the grace time. Resolves when none is left. */
  stopAll: () => Promise<void>;
  /** SIGKILL to every group, at once. For the last moment of a process that is going away. */
  killAllNow: () => void;
}

export function createGroups(graceMs: number = GRACE_MS): Groups {
  const live = new Set<number>();
  let stopping = false;

  function launchGroup({ label, command, cwd, env }: Launch, stdio: "inherit" | "pipe"): ChildProcess {
    // A run that was told to stop starts nothing more: a program started now
    // would never hear the signal that was already passed on.
    if (stopping) {
      throw new StartError(`${label} was not started: the run is stopping`);
    }

    const [program = "", ...programArguments] = command;

    const child = spawn(resolveProgram(program, cwd), programArguments, {
      cwd,
      env,
      // The leader of its own group, so the whole group can be signalled.
      detached: true,
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    if (child.pid !== undefined) {
      live.add(child.pid);
    }

    return child;
  }

  return {
    start: (launch: Launch, ready: RegExp, timeoutMs: number): Promise<Started> => {
      return new Promise((resolve, reject) => {
        const child = launchGroup(launch, "pipe");
        let output = "";
        let settled = false;

        function fail(why: string): void {
          if (!settled) {
            settled = true;
            clearTimeout(deadline);
            reject(new StartError(`${launch.label} ${why}\n--- its output ---\n${output.trim() || "(none)"}`));
          }
        }

        const deadline = setTimeout(() => {
          fail(`did not say it was ready within ${timeoutMs / 1000}s (waited for ${ready})`);
        }, timeoutMs);

        function read(chunk: Buffer): void {
          output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT);

          const address = ready.exec(output.replace(COLOUR, ""))?.[1];

          if (address !== undefined && !settled && child.pid !== undefined) {
            settled = true;
            clearTimeout(deadline);
            resolve({ label: launch.label, pid: child.pid, address });
          }
        }

        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
        child.once("error", (error) => {
          fail(`could not be started (${error.message})`);
        });
        child.once("exit", (code, signal) => {
          const why = `stopped before it was ready (${signal ?? `exit code ${code}`})`;
          // Its last words may still be on their way: `close` comes when they
          // have all been read. A child of its own can hold the stream open,
          // so that is not waited for long.
          const lastWords = setTimeout(() => {
            fail(why);
          }, LAST_WORDS_MS);

          child.once("close", () => {
            clearTimeout(lastWords);
            fail(why);
          });
        });
      });
    },

    run: (launch: Launch): Promise<number> => {
      return new Promise((resolve, reject) => {
        const child = launchGroup(launch, "inherit");

        child.once("error", (error) => {
          reject(new StartError(`${launch.label} could not be started (${error.message})`));
        });
        child.once("exit", (code, signal) => {
          resolve(code ?? exitCodeOfSignal(signal));
        });
      });
    },

    finish: (launch: Launch): Promise<Finished> => {
      return new Promise((resolve, reject) => {
        const child = launchGroup(launch, "pipe");
        let output = "";

        function read(chunk: Buffer): void {
          output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT);
        }

        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
        child.once("error", (error) => {
          reject(new StartError(`${launch.label} could not be started (${error.message})`));
        });
        // `close`, not `exit`: by then everything it printed has been read.
        child.once("close", (code, signal) => {
          resolve({ exitCode: code ?? exitCodeOfSignal(signal), output: output.trim() });
        });
      });
    },

    signal: (signal: NodeJS.Signals): void => {
      stopping = true;

      for (const pid of live) {
        signalGroup(pid, signal);
      }
    },

    stopAll: async (): Promise<void> => {
      stopping = true;

      for (const pid of live) {
        signalGroup(pid, "SIGTERM");
      }

      await untilGone(live, graceMs);

      for (const pid of live) {
        signalGroup(pid, "SIGKILL");
      }

      await untilGone(live, graceMs);
    },

    killAllNow: (): void => {
      for (const pid of live) {
        signalGroup(pid, "SIGKILL");
      }
    },
  };
}

/** What a shell reports for a program a signal ended: 128 plus the signal's number. */
export function exitCodeOfSignal(signal: NodeJS.Signals | null): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

  return signal === null ? 1 : 128 + (numbers[signal] ?? 0);
}

/** True while any process of the group is left. */
export function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);

    return true;
  } catch (error) {
    // EPERM: it is there, and not ours to signal. Anything else: it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Waits until every group has left, dropping each as it does, or until the time is up. */
async function untilGone(live: Set<number>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    for (const pid of [...live]) {
      if (!isGroupAlive(pid)) {
        live.delete(pid);
      }
    }

    if (live.size === 0 || Date.now() >= deadline) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** A path with a folder in it is read from the program's own folder; a bare name is looked up on the PATH. */
function resolveProgram(program: string, cwd: string): string {
  return program.includes("/") && !isAbsolute(program) ? join(cwd, program) : program;
}
