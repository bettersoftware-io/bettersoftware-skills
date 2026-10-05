// Contract gate: every port has a contract test, the contract calls every
// method of the port, and every adapter folder that implements a port runs
// that contract. One suite, run against the simulator and the real adapter
// alike, is what proves they are interchangeable.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DomainPackage, Finding, Project } from "./config.mts";
import { packagesWithRole } from "./config.mts";
import { isTestFile, listSourceFiles, readCodeLines } from "./files.mts";

const GATE = "port-contracts";
const PORT_FILE = /Port\.ts$/;

function portNameOf(file: string): string {
  const stem = basename(file).replace(/\.ts$/, "");

  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function portFilesOf(root: string, domain: DomainPackage): string[] {
  return listSourceFiles(root, `${domain.path}/${domain.ports}`).filter(
    (file) => PORT_FILE.test(file) && !isTestFile(file) && !file.includes("/__contracts__/"),
  );
}

/** Why this gate judged nothing, if it did. A gate with nothing to judge has not passed. */
export function portContractsSkipReason({ root, config }: Project): string | undefined {
  const ports = packagesWithRole(config, "domain").flatMap((domain) => portFilesOf(root, domain));

  return ports.length === 0 ? "no port interfaces were found, so there was nothing to check" : undefined;
}

export function checkPortContracts({ root, config }: Project): Finding[] {
  const findings: Finding[] = [];

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
          message: `${port} has no contract test. Add ${contractFile} exporting ${describer}(label, createHarness), or list ${port} under contractExempt in architecture.config.mts with the reason.`,
        });
        continue;
      }

      findings.push(...checkContractCallsEveryMethod(root, portFile, port, contractFile));

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

/**
 * A method the contract never calls is held to nothing: the simulator and the
 * real adapter can disagree about it with every test green. Read from source,
 * with comments blanked, so a mention in prose does not count as a call.
 */
function checkContractCallsEveryMethod(root: string, portFile: string, port: string, contractFile: string): Finding[] {
  const methods = portMethodsOf(readCodeLines(root, portFile), port);

  if (methods === undefined) {
    return [
      {
        gate: GATE,
        file: portFile,
        message: `${basename(portFile)} does not declare \`interface ${port}\`, so the gate cannot read the port's methods and cannot tell whether the contract covers them. Declare the port as an interface of that name.`,
      },
    ];
  }

  const contract = readCodeLines(root, contractFile).join("\n");

  return methods
    .filter((method) => !new RegExp(`\\.${method}\\s*\\(`).test(contract))
    .map((method) => ({
      gate: GATE,
      file: contractFile,
      message: `The contract never calls ${method}(…), a method of ${port}. Nothing holds the port's implementations to the same behaviour for it, so they can disagree with every test green. Add a case that calls it.`,
    }));
}

const MEMBER_NAME = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*(.*)$/s;

/** The names of the function members of `interface <port>`, or undefined when the file declares no such interface. */
export function portMethodsOf(codeLines: string[], port: string): string[] | undefined {
  const code = codeLines.join("\n");
  const declared = new RegExp(`\\binterface\\s+${port}\\b[^{]*\\{`).exec(code);

  if (declared === null) {
    return undefined;
  }

  const methods: string[] = [];
  let depth = 0;
  let member = "";

  // One member is the text between two points where every bracket is closed.
  for (const character of code.slice(declared.index + declared[0].length)) {
    if (character === "}" && depth === 0) {
      break;
    }

    if ("{(<".includes(character)) {
      depth += 1;
    } else if ("})>".includes(character) && !member.endsWith("=")) {
      depth -= 1;
    }

    if (depth === 0 && (character === ";" || character === "\n")) {
      const method = methodNameOf(member);

      if (method !== undefined) {
        methods.push(method);
      }

      member = "";
    } else {
      member += character;
    }
  }

  return methods;
}

/** `name(…)`, `name<T>(…)` and `name: (…) => …` are functions; `name: string` is not. */
function methodNameOf(member: string): string | undefined {
  const [, name, rest] = MEMBER_NAME.exec(member) ?? [];

  if (name === undefined || rest === undefined) {
    return undefined;
  }

  const isMethod = /^(<[^(]*>)?\s*\(/.test(rest);
  const isFunctionProperty = /^:\s*(<[^(]*>)?\s*\(/.test(rest) && rest.includes("=>");

  return isMethod || isFunctionProperty ? name : undefined;
}
