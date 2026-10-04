// Language gate: a project that declares TypeScript holds no JavaScript source.
//
// Node runs `.mts` directly by stripping the types, so a script, a lint rule or
// a tool config has no reason to be untyped. The few files a tool can only load
// as JavaScript are listed in the config, each with the reason.

import type { Finding, Project } from "./config.mts";
import { listSourceFiles } from "./files.mts";

const GATE = "typescript-only";
const JAVASCRIPT_FILE = /\.(js|jsx|mjs|cjs)$/;

/** Why this gate judged nothing, if it did. */
export function languageSkipReason({ config }: Project): string | undefined {
  return config.language === "typescript" ? undefined : `the project declares language "${config.language}"`;
}

export function checkLanguage({ root, config }: Project, onlyFiles?: string[]): Finding[] {
  if (config.language !== "typescript") {
    return [];
  }

  return (onlyFiles ?? listSourceFiles(root, ""))
    .filter((file) => JAVASCRIPT_FILE.test(file) && !config.javascriptAllowed[file])
    .map((file) => ({
      gate: GATE,
      file,
      message:
        "A JavaScript file in a TypeScript project. Write it as TypeScript: a Node script, a lint rule or a tool config is `.mts`, which Node runs directly and the typecheck covers. If the tool that loads this file cannot read TypeScript, list it under javascriptAllowed in the architecture config with the reason.",
    }));
}
