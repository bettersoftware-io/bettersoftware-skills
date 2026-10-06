import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which set of goldens this machine compares against. Pixels differ between
 * operating systems and processor families (fonts are drawn differently), so
 * each has a set of its own. CI's set is `linux-x64`, drawn in the pinned
 * Playwright container.
 */
const PLATFORM = `${os.platform()}-${os.arch()}`;

/**
 * Where this run reads and writes its goldens. `pnpm visual:jitter` points it
 * at a scratch folder so a measurement never touches the committed images.
 */
export const GOLDENS_DIRECTORY: string =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Playwright runs this file, not a turbo task, so turbo neither strips the variable nor caches on it
  process.env.VISUAL_GOLDENS_DIR ??
  fileURLToPath(new URL(`./goldens/${PLATFORM}`, import.meta.url));

const PROJECT_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

export function locateGolden(scenario: string): string {
  return join(GOLDENS_DIRECTORY, `${scenario}.png`);
}

/** What to do about a scenario that has no golden. The run fails; nothing is written. */
export function describeMissingGolden(scenario: string): string {
  return [
    `No golden for the scenario "${scenario}" on ${PLATFORM}.`,
    `Expected: ${relative(PROJECT_ROOT, locateGolden(scenario))}`,
    "",
    "A golden is never created by a plain run, so a new scenario cannot pass unseen.",
    "To create it on this machine: run `pnpm visual:update`, open the new image, check it shows what the scenario says, and commit it.",
    'The linux-x64 set is the one CI compares against, and it can only be drawn in CI\'s container: run the "Update visual goldens" workflow on your branch and commit the images from its artifact.',
  ].join("\n");
}

/** Images in the goldens folder that no scenario owns: left behind by a rename or a removal. */
export function findOrphanGoldens(scenarioNames: readonly string[]): string[] {
  if (!existsSync(GOLDENS_DIRECTORY)) {
    return [];
  }

  return readdirSync(GOLDENS_DIRECTORY)
    .filter((file) => {
      return (
        file.endsWith(".png") &&
        !scenarioNames.includes(file.slice(0, -".png".length))
      );
    })
    .map((file) => {
      return relative(PROJECT_ROOT, join(GOLDENS_DIRECTORY, file));
    });
}
