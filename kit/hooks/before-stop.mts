#!/usr/bin/env node
// Stop hook: the agent may not finish while the project's fast gate is red.
//
// It runs the project's own `gate:fast` script — the same command a person or
// CI runs — so there is one definition of "green". A red gate sends the output
// back as the next instruction. `stop_hook_active` means the agent is already
// continuing because of this hook; it is let through then, so a gate the agent
// cannot fix ends in a report to the user and never in a loop.
//
// Works under Claude Code and Codex: both send `stop_hook_active` and both read
// `{"decision":"block","reason":…}`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "../gates/lib/files.mts";

const SCRIPT = "gate:fast";
const TAIL_CHARACTERS = 4000;

/** The fields both hosts send that this hook reads. */
export interface StopPayload {
  cwd?: string;
  stop_hook_active?: boolean;
}

export interface GateRun {
  status: number;
  output: string;
}

export function judgeStop(payload: StopPayload, run: (root: string) => GateRun = runGate): string | undefined {
  if (payload.stop_hook_active) {
    return undefined;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const manifest = join(root, "package.json");

  if (!existsSync(manifest)) {
    return undefined;
  }

  const { scripts } = JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> };

  if (!scripts?.[SCRIPT]) {
    return undefined;
  }

  const { status, output } = run(root);

  if (status === 0) {
    return undefined;
  }

  return [
    `\`${SCRIPT}\` is red, so the work is not finished. Fix what it reports and run it again.`,
    "If a finding is wrong or outside what you were asked to do, say so plainly instead of working around the gate.",
    "",
    output.slice(-TAIL_CHARACTERS),
  ].join("\n");
}

function runGate(root: string): GateRun {
  const result = spawnSync("pnpm", ["--silent", "run", SCRIPT], { cwd: root, encoding: "utf8" });

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`,
  };
}

if (isMainModule(import.meta.url)) {
  const reason = judgeStop(JSON.parse(readFileSync(0, "utf8") || "{}") as StopPayload);

  if (reason) {
    console.log(JSON.stringify({ decision: "block", reason }));
  }
}
