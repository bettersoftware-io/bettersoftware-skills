#!/usr/bin/env node
// Checks that every relative link in the project's markdown leads somewhere:
// the file exists, and when the link names a heading (`#anchor`) in another
// markdown file, that file has it.
//
//   node tools/repo-hygiene/check-doc-links.mts              check the project
//   node tools/repo-hygiene/check-doc-links.mts --root <dir> check another folder
//
// Reads every `.md` file that git does not ignore, outside installed and
// generated folders and outside `tools/` (the installed tooling: its files
// are not the project's to fix). Links with a scheme (`https:`, `mailto:`)
// are not followed.
//
// Exit 0: every link resolves, or there was no link to check (SKIP).
// Exit 1: a link is dead. Exit 2: the check could not run.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { dropIgnored, isMainModule, listFiles } from "./lib/files.mts";
import { readAnchors, readLinks } from "./lib/markdown.mts";

const GATE = "doc-links";

export interface DeadLink {
  /** The markdown file the link is written in, from the root. */
  file: string;
  line: number;
  message: string;
}

export interface LinkCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  findings: DeadLink[];
  /** Markdown files read. */
  files: number;
  /** Relative links checked. */
  links: number;
}

export class CheckError extends Error {}

export function checkDocLinks(root: string = process.cwd()): LinkCheck {
  const project = resolve(root);

  if (!existsSync(project)) {
    throw new CheckError(`${project} does not exist`);
  }

  const files = dropIgnored(project, listFiles(project, /\.md$/i));
  const findings: DeadLink[] = [];
  const anchorsOf = new Map<string, Set<string>>();
  let links = 0;

  function anchors(file: string): Set<string> {
    if (!anchorsOf.has(file)) {
      anchorsOf.set(file, readAnchors(readFileSync(file, "utf8")));
    }

    return anchorsOf.get(file) as Set<string>;
  }

  for (const file of files) {
    const source = join(project, file);

    for (const { line, target } of readLinks(readFileSync(source, "utf8"))) {
      if (isExternal(target)) {
        continue;
      }

      links += 1;

      const at = target.indexOf("#");
      const path = decode(at === -1 ? target : target.slice(0, at)).replace(/\?.*$/, "");
      const anchor = at === -1 ? "" : decode(target.slice(at + 1));
      // A path that starts with `/` is read from the top of the repository, as GitHub reads it.
      const destination = path === "" ? source : path.startsWith("/") ? join(project, path) : resolve(dirname(source), path);
      const shown = relative(project, destination).split(sep).join("/");
      const problem = missingPart(project, destination);

      if (problem !== undefined) {
        findings.push({ file, line, message: `The link \`${target}\` leads to ${shown}, ${problem} Correct the path, or remove the link.` });
      } else if (anchor !== "" && /\.md$/i.test(destination) && statSync(destination).isFile() && !anchors(destination).has(anchor)) {
        findings.push({ file, line, message: `The link \`${target}\` names the anchor \`#${anchor}\`, and ${shown} has no heading with that anchor.${suggest(anchor, anchors(destination))}` });
      }
    }
  }

  return {
    gate: GATE,
    ...(links === 0 ? { skipped: files.length === 0 ? "no markdown file" : `no relative link in ${files.length} markdown file(s)` } : {}),
    findings,
    files: files.length,
    links,
  };
}

/** `https:`, `mailto:`, `//host`: somewhere else, and not checked. */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What is wrong with `destination` as a place on disk, or undefined when it is
 * there. Names are compared exactly: on macOS and Windows `readme.md` opens
 * `README.md`, on GitHub and in CI it does not.
 */
function missingPart(project: string, destination: string): string | undefined {
  if (!existsSync(destination)) {
    return "which does not exist.";
  }

  const inside = relative(project, destination);

  if (inside === "" || inside.startsWith("..")) {
    return undefined;
  }

  let folder = project;

  for (const name of inside.split(sep)) {
    if (!readdirSync(folder).includes(name)) {
      const real = readdirSync(folder).find((entry) => entry.toLowerCase() === name.toLowerCase());

      return `but the name on disk is \`${real}\`, not \`${name}\`: the link works on this machine and is dead on GitHub.`;
    }

    folder = join(folder, name);
  }

  return undefined;
}

/** Letters and digits only: what two spellings of one heading still share. */
function bare(anchor: string): string {
  return anchor.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function suggest(anchor: string, anchors: Set<string>): string {
  const close = [...anchors].filter((candidate) => bare(candidate) === bare(anchor));

  return close.length === 0
    ? " Correct the anchor, or remove it."
    : ` It has ${close.map((candidate) => `\`#${candidate}\``).join(" and ")}: GitHub lowers the case, drops punctuation and turns every space into a dash, so \`A -- B\` is \`#a----b\`.`;
}

export function formatResult({ gate, skipped, findings, files, links }: LinkCheck): string {
  if (findings.length > 0) {
    return [
      `FAIL ${gate} (${findings.length})`,
      ...findings.flatMap(({ file, line, message }) => [`  ${file}:${line}`, `    ${message}`]),
      "",
      `${findings.length} dead link(s) among ${links} in ${files} markdown file(s).`,
    ].join("\n");
  }

  // Nothing to judge is reported as such: it is not a pass.
  return skipped === undefined ? `PASS ${gate} — ${links} relative link(s) in ${files} markdown file(s) resolve` : `SKIP ${gate} — ${skipped}`;
}

function parseArguments(argv: string[]): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }

  if (argv.length === 2 && argv[0] === "--root") {
    return argv[1];
  }

  throw new CheckError(`unknown arguments "${argv.join(" ")}" (use --root <dir>)`);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkDocLinks(parseArguments(process.argv.slice(2)));

    console.log(formatResult(result));
    process.exit(result.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof CheckError ? `check:doc-links could not run: ${error.message}` : error);
    process.exit(2);
  }
}
