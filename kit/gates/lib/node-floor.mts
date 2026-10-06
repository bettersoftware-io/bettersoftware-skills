// Node-floor gate: the oldest Node the project runs on is declared in the root
// package.json under `devEngines.runtime`, and no package.json has
// `engines.node`.
//
// A hosting build reads `engines.node` and refuses a range above the Node it
// offers (`vercel build` does, and nothing overrides it). The tooling here
// needs a newer Node than a host may offer, while what a client ships is
// static files that no Node runs. So a floor written in `engines.node` passes
// every check in CI and fails the first deploy. `devEngines.runtime` is read
// by the package manager alone, which enforces it on install; it never did
// that for `engines.node`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Finding, Project } from "./config.mts";

const GATE = "node-floor";
const ROOT_MANIFEST = "package.json";

interface Runtime {
  name?: string;
  version?: string;
  onFail?: string;
}

interface Manifest {
  engines?: { node?: string };
  devEngines?: { runtime?: Runtime | Runtime[] };
}

/** Why this gate judged nothing, if it did. */
export function nodeFloorSkipReason({ root }: Project): string | undefined {
  return existsSync(join(root, ROOT_MANIFEST)) ? undefined : "no package.json was found at the root, so there was nothing to check";
}

export function checkNodeFloor({ root, workspace }: Pick<Project, "root" | "workspace">, onlyFiles?: string[]): Finding[] {
  const findings: Finding[] = [];
  const manifests = [ROOT_MANIFEST, ...workspace.map(({ path }) => `${path}/package.json`)];

  for (const file of manifests) {
    if ((onlyFiles && !onlyFiles.includes(file)) || !existsSync(join(root, file))) {
      continue;
    }

    const manifest = JSON.parse(readFileSync(join(root, file), "utf8")) as Manifest;

    if (manifest.engines?.node !== undefined) {
      findings.push({
        gate: GATE,
        file,
        message: `engines.node is "${manifest.engines.node}". A hosting build (vercel build, for one) reads that field and refuses a range above the Node it offers, so a deploy fails before its build starts, with every check here green. Remove it. The floor belongs in the root package.json: "devEngines": { "runtime": { "name": "node", "version": "${manifest.engines.node}", "onFail": "error" } }, which the package manager enforces on install and a host does not read.`,
      });
    }

    if (file === ROOT_MANIFEST) {
      findings.push(...checkDeclaredFloor(file, manifest));
    }
  }

  return findings;
}

function checkDeclaredFloor(file: string, { devEngines }: Manifest): Finding[] {
  const runtimes = [devEngines?.runtime ?? []].flat();
  const node = runtimes.find(({ name }) => name === "node");

  if (node === undefined || !node.version) {
    return [
      {
        gate: GATE,
        file,
        message: `devEngines.runtime does not name "node" with a version range, so nothing says which Node the tooling needs (the .mts scripts are run by Node itself) and an install on an older one goes through. Add "devEngines": { "runtime": { "name": "node", "version": ">=26", "onFail": "error" } }.`,
      },
    ];
  }

  if (node.onFail !== "error") {
    return [
      {
        gate: GATE,
        file,
        message: `devEngines.runtime has ${node.onFail === undefined ? "no onFail" : `onFail "${node.onFail}"`}. Set "onFail": "error": that is what stops an install on a Node below the floor (${node.version}). With "warn" or "ignore" the install goes through, and the first .mts script then fails with a syntax error that names no cause.`,
      },
    ];
  }

  return [];
}
