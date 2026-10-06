// Types-only gate: a package declared `typesOnly` exports no runtime value.
//
// A package of contracts (the types several implementations share) is safe to
// import from anywhere because importing it costs nothing at runtime and pulls
// no implementation along. One exported constant or function ends that: the
// package becomes a place for shared code, and every importer now runs it.

import type { DeclaredPackage, Finding, Project } from "./config.mts";
import { declaredPackages } from "./config.mts";
import { isInside, isTestScaffolding, lineAt, listSourceFiles, readCodeLines } from "./files.mts";

const GATE = "types-only";

const DECLARATION = /^[ \t]*export\s+(?:default\s+)?(?:async\s+function|function|const|let|var|class|abstract\s+class|enum)\b[^\n]*/gm;
const DEFAULT = /^[ \t]*export\s+default\s+(?!interface\b|type\b|async\s+function\b|function\b|class\b|abstract\b)[^\n]*/gm;
const EXPORT_LIST = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}/gm;
const EXPORT_ALL = /^[ \t]*export\s+\*[^\n]*/gm;

interface Export {
  index: number;
  text: string;
}

function typesOnlyPackagesOf({ config }: Project): DeclaredPackage[] {
  return declaredPackages(config).filter(({ typesOnly }) => typesOnly);
}

/** Why this gate judged nothing, if it did. */
export function typesOnlySkipReason(project: Project): string | undefined {
  return typesOnlyPackagesOf(project).length === 0
    ? "no package is declared typesOnly, so there was nothing to check"
    : undefined;
}

export function checkTypesOnly(project: Project, onlyFiles?: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const pkg of typesOnlyPackagesOf(project)) {
    const source = `${pkg.path}/src`;
    const files = (onlyFiles?.filter((file) => isInside(file, source)) ?? listSourceFiles(project.root, source)).filter(
      (file) => !isTestScaffolding(file),
    );

    for (const file of files) {
      const code = readCodeLines(project.root, file).join("\n");

      for (const { index, text } of runtimeExportsOf(code)) {
        findings.push({
          gate: GATE,
          file,
          line: lineAt(code, index),
          message: `\`${text}\` exports a runtime value from ${pkg.path}, which is declared typesOnly. Every package may import this one because it adds nothing at runtime; a value here makes it shared code that all of them run. Export a type (\`export type\`, \`export interface\`, \`export type { … }\`), and move the value to the package that owns the behaviour.`,
        });
      }
    }
  }

  return findings;
}

/** Every export that leaves something behind once the types are stripped. */
function runtimeExportsOf(code: string): Export[] {
  const declared = [...code.matchAll(DECLARATION), ...code.matchAll(DEFAULT), ...code.matchAll(EXPORT_ALL)].map(
    (match) => ({ index: match.index, text: match[0] }),
  );
  // A list is reported by the members that are values, so a long one still
  // says which name to move.
  const listed = [...code.matchAll(EXPORT_LIST)].flatMap((match) => {
    const [, typeOnly, members = ""] = match;
    const values = members
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member !== "" && !/^type\s/.test(member));

    return typeOnly === undefined && values.length > 0
      ? [{ index: match.index, text: `export { ${values.join(", ")} }` }]
      : [];
  });

  return [...declared, ...listed]
    .map(({ index, text }) => ({ index: index + (text.length - text.trimStart().length), text: shortened(text.trim()) }))
    .sort((a, b) => a.index - b.index);
}

function shortened(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
