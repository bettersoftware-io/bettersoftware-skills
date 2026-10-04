#!/usr/bin/env node
// PostToolUse hook: judges the file the agent just wrote with the per-file
// gates and hands any finding straight back to it.
//
// Works under Claude Code (Write/Edit: `tool_input.file_path`) and Codex
// (`apply_patch`: the patch text in `tool_input.command`). Both read the same
// reply: `{"decision":"block","reason":…}` on stdout.
//
// A hook that crashes must not look like a pass, so every failure to judge is
// reported as "no verdict" instead of being swallowed.

import { readFileSync } from "node:fs";

import { ConfigError } from "../gates/lib/config.mts";
import { isMainModule } from "../gates/lib/files.mts";
import { formatFindings, runGates } from "../gates/run.mts";

const PATCH_FILE = /^\*\*\* (?:Add|Update) File: (.+)$/gm;

/** The fields both hosts send that this hook reads. */
export interface EditPayload {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; command?: unknown };
}

/** The files a tool call wrote, from either host's payload. */
export function editedFilesOf(payload: EditPayload): string[] {
  const input = payload.tool_input ?? {};

  if (typeof input.file_path === "string") {
    return [input.file_path];
  }

  if (typeof input.command === "string") {
    return [...input.command.matchAll(PATCH_FILE)].map((match) => (match[1] ?? "").trim());
  }

  return [];
}

export async function judgeEdit(payload: EditPayload): Promise<string | undefined> {
  const files = editedFilesOf(payload);

  if (files.length === 0) {
    return undefined;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();

  try {
    const result = await runGates({ root, files });

    return result.findings.length === 0
      ? undefined
      : `The file you just wrote breaks an architecture rule. Fix it before going on.\n\n${formatFindings(result)}`;
  } catch (error) {
    return error instanceof ConfigError
      ? undefined // a project without declared layers has no rules to break
      : `The architecture gates crashed, so this edit has no verdict: ${error instanceof Error ? error.message : String(error)}`;
  }
}

if (isMainModule(import.meta.url)) {
  const reason = await judgeEdit(JSON.parse(readFileSync(0, "utf8") || "{}") as EditPayload);

  if (reason) {
    console.log(JSON.stringify({ decision: "block", reason }));
  }
}

