// Test-ids gate: a test id is written once, in the client's test-ids file.
//
// A component marks an element with an id and a page object finds it by the
// same id. Written as two string literals they drift apart: the component is
// renamed, the query finds nothing, and the failure names a missing element,
// not the rename. Both sides read the constant, so a rename is one edit and a
// typo does not compile.

import type { ClientPackage, Finding, Project } from "./config.mts";
import { declaredPackages, packagesWithRole } from "./config.mts";
import { lineAt, listSourceFiles, readCodeLines } from "./files.mts";

const GATE = "test-ids";

// `data-testid="x"`, `data-testid={"x"}`, `[data-testid="x"]`, and the
// attribute passed by name: `"data-testid": "x"`, `("data-testid", "x")`.
const RAW_ATTRIBUTE = /(?:data-testid\s*=\s*\{?\s*["'`]|["']data-testid["']\s*[:,]\s*["'`])(?!\$\{)/g;
// `getByTestId("x")` and every sibling: query, find, All, and a locator's.
// A literal that opens with `${` is a selector built from a constant, and
// holds no id of its own.
const RAW_QUERY = /\b\w*ByTestId\s*\(\s*["'`](?!\$\{)/g;

function testIdsFileOf(client: ClientPackage): string {
  return `${client.path}/${client.ui}/${client.testIds}`;
}

/** Why this gate judged nothing, if it did. */
export function testIdsSkipReason({ config }: Project): string | undefined {
  return packagesWithRole(config, "client").length === 0
    ? "no client package is declared, so there was nothing to check"
    : undefined;
}

export function checkTestIds({ root, config }: Project, onlyFiles?: string[]): Finding[] {
  const clients = packagesWithRole(config, "client");

  if (clients.length === 0) {
    return [];
  }

  const constants = clients.map(testIdsFileOf);
  const packages = declaredPackages(config).map(({ path }) => path);
  const files = (
    onlyFiles?.filter((file) => packages.some((path) => file.startsWith(`${path}/`))) ??
    packages.flatMap((path) => listSourceFiles(root, path))
  ).filter((file) => !constants.includes(file));
  const findings: Finding[] = [];

  for (const file of files) {
    const code = readCodeLines(root, file).join("\n");
    const found = [
      ...[...code.matchAll(RAW_ATTRIBUTE)].map((match) => ({ index: match.index, what: "A test id written as a string literal" })),
      ...[...code.matchAll(RAW_QUERY)].map((match) => ({ index: match.index, what: "A query by a test id written as a string literal" })),
    ].sort((a, b) => a.index - b.index);

    for (const { index, what } of found) {
      findings.push({
        gate: GATE,
        file,
        line: lineAt(code, index),
        message: `${what}. The component and the query that finds it then hold two copies, and renaming one leaves a test that finds nothing. Add the id to ${constants.join(" or ")} and use the constant on both sides.`,
      });
    }
  }

  return findings;
}
