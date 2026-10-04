// Contract gate: every port has a contract test, and every adapter folder that
// implements a port runs that contract. One suite, run against the simulator
// and the real adapter alike, is what proves they are interchangeable.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { packagesWithRole } from "./config.mjs";
import { isTestFile, listSourceFiles } from "./files.mjs";

const GATE = "port-contracts";
const PORT_FILE = /Port\.ts$/;

function portNameOf(file) {
  const stem = basename(file).replace(/\.ts$/, "");

  return stem[0].toUpperCase() + stem.slice(1);
}

function portFilesOf(root, domain) {
  return listSourceFiles(root, `${domain.path}/${domain.ports}`).filter(
    (file) => PORT_FILE.test(file) && !isTestFile(file) && !file.includes("/__contracts__/"),
  );
}

/** Why this gate judged nothing, if it did. A gate with nothing to judge has not passed. */
export function portContractsSkipReason({ root, config }) {
  const ports = packagesWithRole(config, "domain").flatMap((domain) => portFilesOf(root, domain));

  return ports.length === 0 ? "no port interfaces were found, so there was nothing to check" : undefined;
}

export function checkPortContracts({ root, config }) {
  const findings = [];

  for (const domain of packagesWithRole(config, "domain")) {
    const portsFolder = `${domain.path}/${domain.ports}`;
    const portFiles = portFilesOf(root, domain);

    for (const portFile of portFiles) {
      const port = portNameOf(portFile);

      if (config.contractExempt[port]) {
        continue;
      }

      const contractFile = `${portsFolder}/__contracts__/${port}Contract.ts`;
      const describer = `describe${port}Contract`;

      if (!existsSync(join(root, contractFile))) {
        findings.push({
          gate: GATE,
          file: portFile,
          message: `${port} has no contract test. Add ${contractFile} exporting ${describer}(label, createHarness), or list ${port} under contractExempt in architecture.config.mjs with the reason.`,
        });
        continue;
      }

      const usesPort = new RegExp(`\\b${port}\\b`);

      for (const adapterFolder of config.adapters) {
        const files = listSourceFiles(root, adapterFolder);
        const implementers = files.filter(
          (file) => !isTestFile(file) && usesPort.test(readFileSync(join(root, file), "utf8")),
        );

        if (implementers.length === 0) {
          continue;
        }

        const runsContract = files.some(
          (file) => isTestFile(file) && readFileSync(join(root, file), "utf8").includes(`${describer}(`),
        );

        if (!runsContract) {
          findings.push({
            gate: GATE,
            file: implementers[0],
            message: `${adapterFolder} implements ${port} but no test there calls ${describer}(…). Run the port's contract against this adapter so it is proven interchangeable with the others.`,
          });
        }
      }
    }
  }

  return findings;
}
