// The allow-list: the only way to accept an animation the checks would fail.
//
// The project keeps it in `tools/perf/allowed.mts`. That file is written once,
// with empty lists, when the add-on is added; after that it belongs to the
// project, and an update of the add-on leaves it alone. If the file is
// missing, nothing is accepted.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ALLOWED_FILE = "tools/perf/allowed.mts";

/** Accepts one finding of the static check (`pnpm perf:check`). */
export interface AllowedAnimation {
  /** Path from the project root, as the finding prints it. */
  file: string;
  /** The selector, `@keyframes <name>` or `.animate()`, as the finding prints it. */
  rule: string;
  /** The property the finding names. */
  property: string;
  /** Why this is not a steady-state cost. */
  reason: string;
}

/** Accepts one animation in the runtime audit (`pnpm perf:motion-audit`). */
export interface AllowedMotion {
  /** The name the audit prints: a keyframes name, `transition:<property>`, or a script animation's id. */
  animation: string;
  /** Why this is not a steady-state cost. */
  reason: string;
}

export interface Allowed {
  animations?: AllowedAnimation[];
  motion?: AllowedMotion[];
}

export class AllowedError extends Error {}

export async function loadAllowed(root: string): Promise<Required<Allowed>> {
  const file = join(root, ALLOWED_FILE);

  if (!existsSync(file)) {
    return { animations: [], motion: [] };
  }

  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };

  return checkAllowed(module.default);
}

/** Refuses a list that is not the declared shape, or an entry with no reason. */
export function checkAllowed(value: unknown): Required<Allowed> {
  if (typeof value !== "object" || value === null) {
    throw new AllowedError(`${ALLOWED_FILE} must default-export an object: { animations: [...], motion: [...] }`);
  }

  const { animations = [], motion = [] } = value as Allowed;

  for (const [list, entries, fields] of [
    ["animations", animations, ["file", "rule", "property", "reason"]],
    ["motion", motion, ["animation", "reason"]],
  ] as const) {
    if (!Array.isArray(entries)) {
      throw new AllowedError(`${ALLOWED_FILE}: "${list}" must be a list`);
    }

    entries.forEach((entry: unknown, index) => {
      for (const field of fields) {
        const text = (entry as Record<string, unknown> | null)?.[field];

        if (typeof text !== "string" || text.trim() === "") {
          throw new AllowedError(
            `${ALLOWED_FILE}: ${list}[${index}] has no "${field}". Every entry says what it accepts and why.`,
          );
        }
      }
    });
  }

  return { animations, motion };
}
