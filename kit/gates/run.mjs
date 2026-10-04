#!/usr/bin/env node
// The architecture gates. One entry point for the editor hook, the local check
// and CI, so a file cannot pass in one place and fail in another.
//
//   node run.mjs                     every gate
//   node run.mjs --file a.tsx …      only the per-file gates, for the files given
//   node run.mjs --root <dir>        judge another folder
//   node run.mjs --json              machine-readable findings
//
// Exit 0: no findings. Exit 1: findings. Exit 2: the gates could not run.

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "./lib/config.mjs";
import { checkPortContracts, portContractsSkipReason } from "./lib/contracts.mjs";
import { checkDependencies } from "./lib/depcruise.mjs";
import { checkStructure, checkStructureOfFiles } from "./lib/structure.mjs";
import { checkDumbUi, dumbUiSkipReason } from "./lib/ui-bans.mjs";

/**
 * @param {{ root?: string, files?: string[], configFile?: string }} options
 * @returns {Promise<{ gates: string[], skipped: Record<string, string>, findings: { gate: string, file?: string, line?: number, message: string }[] }>}
 */
export async function runGates({ root = process.cwd(), files, configFile } = {}) {
  const project = await loadConfig(root, configFile);

  if (files) {
    const relativeFiles = files
      .map((file) => relative(project.root, resolve(project.root, file)))
      .filter((file) => !file.startsWith("..") && existsSync(join(project.root, file)));

    return {
      gates: ["structure", "dumb-ui"],
      skipped: {},
      findings: [...checkStructureOfFiles(project, relativeFiles), ...checkDumbUi(project, relativeFiles)],
    };
  }

  return {
    gates: ["structure", "dumb-ui", "port-contracts", "dependencies"],
    skipped: dropUndefined({
      "dumb-ui": dumbUiSkipReason(project),
      "port-contracts": portContractsSkipReason(project),
    }),
    findings: [
      ...checkStructure(project),
      ...checkDumbUi(project),
      ...checkPortContracts(project),
      ...checkDependencies(project),
    ],
  };
}

function dropUndefined(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function formatFindings({ gates, findings, skipped = {} }) {
  const lines = [];

  for (const gate of gates) {
    const ofGate = findings.filter((finding) => finding.gate === gate);

    if (ofGate.length === 0) {
      // Nothing to judge is reported as such: it is not a pass.
      lines.push(skipped[gate] ? `SKIP ${gate} — ${skipped[gate]}` : `PASS ${gate}`);
      continue;
    }

    lines.push(`FAIL ${gate} (${ofGate.length})`);

    for (const finding of ofGate) {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(project)";
      lines.push(`  ${where}`, `    ${finding.message}`);
    }
  }

  lines.push("", findings.length === 0 ? "all gates passed." : `${findings.length} finding(s).`);

  return lines.join("\n");
}

function parseArguments(argv) {
  const options = { files: undefined, json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--root") {
      options.root = argv[(index += 1)];
    } else if (argument === "--config") {
      options.configFile = argv[(index += 1)];
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--file") {
      options.files = [...(options.files ?? []), argv[(index += 1)]];
    } else {
      throw new ConfigError(`unknown argument "${argument}"`);
    }
  }

  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { json, ...options } = parseArguments(process.argv.slice(2));
    const result = await runGates(options);

    console.log(json ? JSON.stringify(result, null, 2) : formatFindings(result));
    process.exit(result.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof ConfigError ? `gates could not run: ${error.message}` : error);
    process.exit(2);
  }
}
