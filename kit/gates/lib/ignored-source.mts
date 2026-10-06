// Ignored-source gate: a package holds no code that git ignores.
//
// The checks leave out what git ignores outside the packages: a tool's
// working folder, an editor's. Inside a package they leave out nothing,
// because "ignored" would otherwise be a way round every one of them: a line
// in a `.gitignore`, and a file is still built and bundled here, checked by
// nothing, and missing in CI. So such a file is judged like any other, and is
// a finding by itself.
//
// Installed and generated folders (`node_modules`, `dist`, `coverage`,
// `reports`, the caches) are the closed list of what a package may ignore.

import type { Finding, Project } from "./config.mts";
import { listIgnoredCode } from "./files.mts";

const GATE = "ignored-source";

export function checkIgnoredSource({ root }: Project, onlyFiles?: string[]): Finding[] {
  return listIgnoredCode(root)
    .filter((file) => onlyFiles === undefined || onlyFiles.includes(file))
    .map((file) => ({
      gate: GATE,
      file,
      message:
        "This file is in a package and git ignores it. It is built here and checked by nothing, and it would be missing in CI. Take the line that ignores it out of the .gitignore (`git check-ignore -v` names the line) and commit the file, or delete the file. Only installed and generated folders are ignored inside a package.",
    }));
}
