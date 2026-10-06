#!/usr/bin/env node
// Checks that no Playwright config starts its server through pnpm.
//
//   node tools/visual/check-server.mts
//
// Playwright starts the page's server from `webServer.command` and stops it
// when the tests are done. With `pnpm exec vite …` as the command, the
// process it stops is pnpm. Since pnpm 12.6 that wrapper dies and the server
// lives on with no parent, and the runner waits for it: every test passes,
// then the run never ends. In CI it holds the job until the job's own time
// limit. Measured in a project with this add-on: the tests passed in three
// seconds and the run was still there 45 seconds later; stopping the
// leftover vite by hand let it finish.
//
// Called by its own path (`node_modules/.bin/vite`, from the package's
// folder), the server is the process Playwright stops.
//
// Exit 0: no server is started through pnpm (or SKIP: no config starts a
// server). 1: one is. 2: a command could not be read, so nothing was judged.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = "web-server";

/** `playwright.config.ts`, `playwright.visual.config.mts`, and the like. */
const CONFIG = /^playwright(\.[\w-]+)*\.config\.(ts|mts)$/;

/** Never looked into: installed and generated folders. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist", "coverage", "reports", ".turbo", ".vite", ".cache"]);

/** At the root only: the installed kit and add-ons. */
const INSTALLED_TOOLING = "tools";

/** `command:` and the string after it, in any of the three quotes. The value may be on the next line. */
const COMMAND = /\bcommand:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|(\S))/g;

/**
 * pnpm where a command starts: at the beginning, or after `&&`, `||`, `;` or
 * `|`, behind any `NAME=value` settings, called by name or by a path.
 */
const THROUGH_PNPM = /(?:^|&&|\|\||;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:corepack\s+)?(?:\S*\/)?pnpm(?:\s|$)/;

export interface ServerVerdict {
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export function checkServer(root: string): ServerVerdict {
  const findings: string[] = [];
  const unread: string[] = [];
  let configs = 0;
  let commands = 0;

  for (const file of listConfigs(root)) {
    const text = readFileSync(join(root, file), "utf8");

    if (!/\bwebServer\b/.test(text)) {
      continue;
    }

    configs += 1;

    const found = [...text.matchAll(COMMAND)];

    if (found.length === 0) {
      unread.push(`${file}: it has a webServer and no \`command:\` this check can find. Write the command as a string beside \`command:\`.`);
    }

    for (const match of found) {
      const where = `${file}:${text.slice(0, match.index).split("\n").length}`;
      const command = match[1] ?? match[2] ?? match[3];

      if (command === undefined) {
        unread.push(`${where}: the command is not a string written here, so it cannot be read. Write it as a string beside \`command:\`.`);
        continue;
      }

      commands += 1;

      if (THROUGH_PNPM.test(command)) {
        findings.push(
          `${where}: the server is started through pnpm (\`${command}\`). Playwright stops the process it started, which is pnpm; since pnpm 12.6 the server itself lives on with no parent, and the run never ends after its tests pass. Start the program by its own path, from the package's folder: \`cwd\` set to the package, and \`command: "node_modules/.bin/vite …"\`.`,
        );
      }
    }
  }

  if (unread.length > 0) {
    return { exitCode: 2, lines: [`${GATE} could not run:`, ...unread.map((line) => `  ${line}`)] };
  }

  if (findings.length > 0) {
    return { exitCode: 1, lines: [`FAIL ${GATE}`, ...findings.map((finding) => `  ${finding}`)] };
  }

  if (commands === 0) {
    return { exitCode: 0, lines: [`SKIP ${GATE}: no Playwright config in the project starts a server, so there was nothing to check.`] };
  }

  return { exitCode: 0, lines: [`PASS ${GATE}: ${commands} server command(s) in ${configs} Playwright config(s), none through pnpm.`] };
}

/** Every Playwright config in the project, as sorted paths from the root. */
export function listConfigs(root: string, folder = ""): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true })
    .flatMap((entry) => {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

      if (entry.isDirectory()) {
        return SKIPPED_FOLDERS.has(entry.name) || path === INSTALLED_TOOLING ? [] : listConfigs(root, path);
      }

      return entry.isFile() && CONFIG.test(entry.name) ? [path] : [];
    })
    .sort();
}

/** True when Node was asked to run this file. Real paths, so a symlinked copy still runs. */
function isMainModule(): boolean {
  const entry = process.argv[1];

  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const verdict = checkServer(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

  console.log(verdict.lines.join("\n"));
  process.exit(verdict.exitCode);
}
