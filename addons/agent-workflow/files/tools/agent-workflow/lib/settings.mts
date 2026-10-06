// Reads the add-on's setting: what the hook may approve.
//
// The setting is data, read with `JSON.parse`. It was a `.mts` file once,
// which the hook imported on every shell command: whatever that file held ran
// inside the hook before any decision was made.

import { readFileSync } from "node:fs";

export interface Settings {
  /** A push of a work branch, and `gh pr create` for one, run without a prompt. */
  approvePushAndCreate: boolean;
  /** `gh pr merge` of this checkout's own pull request runs without a prompt. */
  approveMerge: boolean;
}

/** What a project starts with, and what anything unreadable means. */
export const NOTHING_APPROVED: Settings = { approvePushAndCreate: false, approveMerge: false };

/**
 * The setting in `file`. Only a literal `true` turns an approval on: a file
 * that is missing or is not a JSON object, a key that is missing, `"true"`
 * and `1` all leave it off.
 */
export function readSettings(file: string | URL): Settings {
  try {
    // A list, a number or `true` has neither key; `null` has none to read, and ends below.
    const { approvePushAndCreate, approveMerge } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    return { approvePushAndCreate: approvePushAndCreate === true, approveMerge: approveMerge === true };
  } catch {
    // No setting that can be read is not a yes.
    return NOTHING_APPROVED;
  }
}
