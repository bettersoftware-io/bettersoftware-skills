// Agent-docs gate: every path the agent instructions name exists.
//
// AGENTS.md tells an agent which file shows each pattern. When that file is
// renamed or deleted the line still reads well, and an agent told to copy a
// file that is gone invents one. Nothing else notices: a path in prose is not
// an import.
//
// What is judged, so the verdict never depends on a guess:
//   - a path in `backticks` that starts at the repository root, meaning its
//     first part exists there (`packages/…`, `tools/…`);
//   - the target of a [link](relative/path).
// What is not: a path that starts somewhere else (`src/app`), anything with a
// placeholder or a wildcard, a command, a fenced code block, a folder of
// generated files, and a block a tool manages (`<!-- BEGIN:name -->` to
// `<!-- END:name -->`), whose paths are about that tool's own repository.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import type { Finding, Project } from "./config.mts";
import { isGeneratedPath } from "./files.mts";

const GATE = "agent-docs";
const CODE_SPAN = /`([^`]+)`/g;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const NOT_A_PLAIN_PATH = /[\s*<>{}$…|]/;

function instructionFilesOf({ root, config }: Project): string[] {
  return config.instructionFiles.filter((file) => existsSync(join(root, file)));
}

/** Why this gate judged nothing, if it did. */
export function instructionsSkipReason(project: Project): string | undefined {
  return instructionFilesOf(project).length === 0
    ? `no ${project.config.instructionFiles.join(" or ")} was found, so there was nothing to check`
    : undefined;
}

export function checkInstructionPaths(project: Project): Finding[] {
  return instructionFilesOf(project).flatMap((file) => checkFile(project.root, file));
}

function checkFile(root: string, file: string): Finding[] {
  const findings: Finding[] = [];
  let inFence = false;
  let inManagedBlock = false;

  readFileSync(join(root, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;

        return;
      }

      if (/<!--\s*BEGIN:/.test(line)) {
        inManagedBlock = true;
      }

      if (/<!--\s*END:/.test(line)) {
        inManagedBlock = false;

        return;
      }

      if (inFence || inManagedBlock) {
        return;
      }

      const missing = [
        ...[...line.matchAll(CODE_SPAN)].map((match) => rootPathOf(root, match[1])),
        ...[...line.matchAll(LINK)].map((match) => linkedPathOf(file, match[1])),
      ].filter((path): path is string => path !== undefined && !existsSync(join(root, path)));

      for (const path of missing) {
        findings.push({
          gate: GATE,
          file,
          line: index + 1,
          message: `Names ${path}, which does not exist. An agent told to read or copy a file that is gone will invent one. Point this at the file that shows the pattern now, or remove the mention.`,
        });
      }
    });

  return findings;
}

/** The path a code span names, if it is one that starts at the repository root. */
function rootPathOf(root: string, span: string): string | undefined {
  const path = span.replace(/:\d+(:\d+)?$/, "");
  const first = path.split("/")[0];

  if (!path.includes("/") || NOT_A_PLAIN_PATH.test(path) || path.startsWith("/") || path.includes("..")) {
    return undefined;
  }

  return existsSync(join(root, first)) && !isGeneratedPath(path) ? path : undefined;
}

/** The path a link points at, from the root, if it points into the repository. */
function linkedPathOf(file: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) {
    return undefined;
  }

  const path = normalize(join(dirname(file), target.replace(/[#?].*$/, "")));

  return path.startsWith("..") || isGeneratedPath(path) ? undefined : path;
}
