// Dumb-UI gate: a UI file renders what the view model gives it. It never
// touches the stream library, storage, the network, configuration or a timer.

import type { ClientPackage, Finding, Project } from "./config.mts";
import { packagesWithRole } from "./config.mts";
import { isInside, isTestFile, listSourceFiles, matchesName, readCodeLines } from "./files.mts";
import { basename } from "node:path";

const GATE = "dumb-ui";

const BANS = [
  {
    pattern: /\b(localStorage|sessionStorage|AsyncStorage)\b/,
    message: "Storage in the UI. Persistence belongs behind a port (a preferences port and its adapter); the UI reads it through the view model.",
  },
  {
    pattern: /\bfetch\(|\bnew WebSocket\b|\bimport\.meta\.env\b|\bprocess\.env\b/,
    message: "Transport or configuration in the UI. Reading the environment and opening connections belong in the composition root; the UI receives the result through the view model.",
  },
  {
    pattern: /\b(setTimeout|setInterval)\b/,
    message: "A timer in the UI. Anything that happens after a delay is application behaviour: put it in a state machine or presenter in the core, where it can be tested on fake timers.",
  },
];

function streamImportPattern(streamLibraries: string[]): RegExp {
  const alternatives = streamLibraries.map((library) => {
    const escaped = library.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return library.endsWith("/") ? `${escaped}[^"']*` : `${escaped}(?:/[^"']*)?`;
  });

  return new RegExp(`(?:from|import)\\s*\\(?\\s*["'](?:${alternatives.join("|")})["']`);
}

/** Which files count as UI: the UI folder, plus any stray component. */
function uiFilesOf(root: string, client: ClientPackage, onlyFiles?: string[]): string[] {
  const source = `${client.path}/src`;
  const app = `${client.path}/${client.app}`;
  const ui = `${client.path}/${client.ui}`;
  const bridge = `${ui}/${client.uiBridge}`;
  const candidates = onlyFiles ?? listSourceFiles(root, source);

  return candidates.filter((file) => {
    if (!isInside(file, source) || isTestFile(file) || isInside(file, bridge)) {
      return false;
    }

    if (isInside(file, ui)) {
      return true;
    }

    const isEntry =
      file.slice(source.length + 1) === basename(file) &&
      client.entry.some((pattern) => matchesName(basename(file), pattern));

    return /\.[jt]sx$/.test(file) && !isInside(file, app) && !isEntry;
  });
}

/** Why this gate judged nothing, if it did. */
export function dumbUiSkipReason({ root, config }: Project, onlyFiles?: string[]): string | undefined {
  const files = packagesWithRole(config, "client").flatMap((client) => uiFilesOf(root, client, onlyFiles));

  return files.length === 0 ? "no UI files were found, so there was nothing to check" : undefined;
}

export function checkDumbUi({ root, config }: Project, onlyFiles?: string[]): Finding[] {
  const streamImport = streamImportPattern(config.streamLibraries);
  const findings: Finding[] = [];

  for (const client of packagesWithRole(config, "client")) {
    for (const file of uiFilesOf(root, client, onlyFiles)) {
      readCodeLines(root, file).forEach((code, index) => {
        if (streamImport.test(code)) {
          findings.push({
            gate: GATE,
            file,
            line: index + 1,
            message: `The stream library in the UI. Only ${client.ui}/${client.uiBridge} may import it; a component subscribes through a view-model hook and never sees an Observable.`,
          });
        }

        for (const ban of BANS) {
          if (ban.pattern.test(code)) {
            findings.push({ gate: GATE, file, line: index + 1, message: ban.message });
          }
        }
      });
    }
  }

  return findings;
}
