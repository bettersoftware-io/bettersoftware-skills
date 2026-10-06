#!/usr/bin/env node
// Checks the project's Dockerfiles for three things an image build gets wrong
// without anyone seeing it.
//
//   node tools/ci-security/check-dockerfiles.mts
//
//   base image   every FROM names its image by digest (`@sha256:…`), not by a
//                tag alone. A tag is moved to a new image whenever its owner
//                likes; a digest names one image for good, so what is built
//                is what was reviewed.
//   user         the last stage ends as a user that is not root. The build
//                needs root; the running program does not, and without this a
//                way out of the program is a root shell in the container.
//   packages     no RUN installs a package outside a lockfile (`npm install
//                -g`, `npx`, `pnpm dlx`). Such a package has no pinned
//                version and no checksum.
//
// It reads files only, so it needs no Docker and no network, and it is part of
// `pnpm gate:fast`.
//
// Exit 0: every Dockerfile passes, or the project has none (SKIP, with the
// reason). Exit 1: findings. Exit 2: a Dockerfile could not be read.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/system.mts";

const GATE = "dockerfiles";

/** `Dockerfile`, `Dockerfile.server`, `server.Dockerfile`, and Podman's name for the same file. */
const DOCKERFILE = /^(Dockerfile|Containerfile)(\..+)?$|\.(Dockerfile|Containerfile)$/;

/** Never looked into: installed and generated folders. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist", "coverage", "reports", ".turbo", ".vite", ".cache"]);

/** At the root only: the installed kit and add-ons, which the project does not own. */
const INSTALLED_TOOLING = "tools";

const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** A package fetched and run or installed with no lockfile, by the command that does it. */
const UNPINNED_INSTALLS: { pattern: RegExp; what: string }[] = [
  { pattern: /\bnpm\s+(?:install|i|add)\b[^&|;]*\s(?:-g|--global)\b/, what: "npm install -g" },
  { pattern: /\bpnpm\s+(?:add|install|i)\b[^&|;]*\s(?:-g|--global)\b/, what: "pnpm add -g" },
  { pattern: /\byarn\s+global\s+add\b/, what: "yarn global add" },
  { pattern: /\bnpx\s/, what: "npx" },
  { pattern: /\b(?:pnpm|yarn)\s+dlx\b/, what: "dlx" },
];

export interface DockerFinding {
  file: string;
  line: number;
  message: string;
}

export interface DockerCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  findings: DockerFinding[];
  files: number;
  /** How many FROM lines were judged. */
  images: number;
}

interface Instruction {
  /** Upper case: FROM, RUN, USER. */
  keyword: string;
  /** Everything after the keyword, continuation lines joined. */
  rest: string;
  line: number;
}

export function checkDockerfiles(root: string): DockerCheck {
  const files = listDockerfiles(root);

  if (files.length === 0) {
    return { gate: GATE, skipped: "the project has no Dockerfile, so there was nothing to check", findings: [], files: 0, images: 0 };
  }

  const findings: DockerFinding[] = [];
  let images = 0;

  for (const file of files) {
    const instructions = parseDockerfile(readFileSync(join(root, file), "utf8"));

    images += instructions.filter(({ keyword }) => keyword === "FROM").length;
    findings.push(...checkOne(file, instructions));
  }

  return { gate: GATE, findings, files: files.length, images };
}

function checkOne(file: string, instructions: Instruction[]): DockerFinding[] {
  const findings: DockerFinding[] = [];
  /** What a later FROM may name: each stage by its number, and by its name when it has one. */
  const stages: string[] = [];
  let stageCount = 0;
  let lastFrom: Instruction | undefined;
  let user: Instruction | undefined;

  for (const instruction of instructions) {
    const { keyword, rest, line } = instruction;

    if (keyword === "FROM") {
      const { image, name } = readFrom(rest);

      findings.push(...checkImage(file, line, image, stages));
      stages.push(String(stageCount), ...(name === undefined ? [] : [name]));
      stageCount += 1;
      lastFrom = instruction;
      user = undefined;
    } else if (keyword === "USER") {
      user = instruction;
    } else if (keyword === "RUN") {
      for (const { pattern, what } of UNPINNED_INSTALLS) {
        if (pattern.test(rest)) {
          findings.push({
            file,
            line,
            message: `This RUN installs a package outside a lockfile (${what}). The version is whatever the registry gives on the day of the build, and nothing checks what was downloaded. Put the package in a package.json with a lockfile, copy both into the image, and install with \`npm ci\` or \`pnpm install --frozen-lockfile\`.`,
          });
        }
      }
    }
  }

  if (lastFrom === undefined) {
    return [{ file, line: 1, message: "There is no FROM line, so this is not a Dockerfile that builds. Remove the file, or give it a base image." }];
  }

  if (user === undefined) {
    findings.push({
      file,
      line: lastFrom.line,
      message:
        "The last stage sets no USER, so the program in the container runs as root, and a way out of the program is a root shell. Add a USER line after the last step that needs root (an install, a build): `USER node` in an official Node image, or a user the Dockerfile creates.",
    });
  } else if (/^(root|0)(:|$)/.test(user.rest.trim())) {
    findings.push({
      file,
      line: user.line,
      message: `The last stage ends as \`USER ${user.rest.trim()}\`, so the program in the container runs as root. End it as a user that is not root: \`USER node\` in an official Node image, or a user the Dockerfile creates.`,
    });
  }

  return findings;
}

function checkImage(file: string, line: number, image: string, stages: string[]): DockerFinding[] {
  // Nothing to pin: the empty image, or a stage of this same file.
  if (image === "scratch" || stages.includes(image)) {
    return [];
  }

  if (image.includes("$")) {
    return [
      {
        file,
        line,
        message: `The base image is \`${image}\`, a build argument, so which image is built is decided on the command line and cannot be checked here. Write the image out, with its digest: \`FROM name:tag@sha256:<digest>\`.`,
      },
    ];
  }

  if (!DIGEST.test(image)) {
    const tagged = image.split("@")[0] ?? image;

    return [
      {
        file,
        line,
        message: `The base image is \`${image}\`, with no digest. A tag is moved to a new image whenever its owner pushes one, so two builds of one commit can differ and the image that runs is not the one that was reviewed. Keep the tag for the reader and add the digest: \`FROM ${tagged}@sha256:<digest>\`. \`docker buildx imagetools inspect ${tagged}\` prints it on its Digest line; that one covers every platform.`,
      },
    ];
  }

  return [];
}

/** `--platform=linux/amd64 node:26 AS build` → the image and the stage's name. */
function readFrom(rest: string): { image: string; name?: string } {
  const words = rest.split(/\s+/).filter((word) => word !== "" && !word.startsWith("--"));
  const [image = "", as, name] = words;

  return { image, name: as?.toUpperCase() === "AS" ? name : undefined };
}

/** The instructions of a Dockerfile, with a line that ends in `\` joined to the next and comments dropped. */
export function parseDockerfile(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let pending: { text: string; line: number } | undefined;

  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();

    // A comment is dropped even in the middle of a continued instruction.
    if (trimmed.startsWith("#") || (trimmed === "" && pending === undefined)) {
      return;
    }

    const continued = trimmed.endsWith("\\");
    const part = continued ? trimmed.slice(0, -1).trim() : trimmed;

    pending = pending === undefined ? { text: part, line: index + 1 } : { text: `${pending.text} ${part}`, line: pending.line };

    if (!continued) {
      const [, keyword = "", rest = ""] = /^(\S+)\s*(.*)$/s.exec(pending.text) ?? [];

      instructions.push({ keyword: keyword.toUpperCase(), rest, line: pending.line });
      pending = undefined;
    }
  });

  return instructions;
}

/** Every Dockerfile in the project, as sorted paths from the root. */
export function listDockerfiles(root: string, folder = ""): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true })
    .flatMap((entry) => {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

      if (entry.isDirectory()) {
        return SKIPPED_FOLDERS.has(entry.name) || path === INSTALLED_TOOLING ? [] : listDockerfiles(root, path);
      }

      return entry.isFile() && DOCKERFILE.test(entry.name) ? [path] : [];
    })
    .sort();
}

export function formatResult({ gate, skipped, findings, files, images }: DockerCheck): string {
  if (findings.length > 0) {
    return [`FAIL ${gate} (${findings.length})`, ...findings.flatMap(({ file, line, message }) => [`  ${file}:${line}`, `    ${message}`])].join("\n");
  }

  // Nothing to judge is reported as such: it is not a pass.
  return skipped === undefined ? `PASS ${gate} — ${files} Dockerfile(s), ${images} FROM line(s)` : `SKIP ${gate} — ${skipped}`;
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkDockerfiles(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

    console.log(formatResult(result));
    process.exitCode = result.findings.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`check:dockerfiles could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
