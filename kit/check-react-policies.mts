#!/usr/bin/env node
// Every package that imports React is under the rules its role asks for, and
// a client's declaration about the React Compiler matches its build.
//
//   node tools/arch/check-react-policies.mts      run in the project root
//
// The lint applies React's rules by role: the hook rules, the inline-style ban
// and (where the compiler runs) the memoization ban to a client, and the
// memoization ban to the bindings. Three things make such a rule silently
// absent, with every run green:
//
//   - a package imports React and has another role, so it gets none of them;
//   - a client bans manual memoization but its build does not run the
//     compiler, so nothing memoizes; or it runs the compiler and does not say
//     so, so a hand-written memo is not banned;
//   - a later block in the project's own ESLint config sets the same rule.
//     ESLint keeps one set of options per rule, so the kit's are replaced.
//
// The last is why this asks ESLint what it resolves for a real file of each
// package, and does not read the config: the answer is the one a developer
// gets.
//
// Exit 0: every React package is covered, or none imports React (SKIP).
// Exit 1: findings. Exit 2: the check could not run.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { ConfigError, loadConfig, type Project } from "./gates/lib/config.mts";
import { isMainModule, isTestScaffolding, listSourceFiles, readCodeLines } from "./gates/lib/files.mts";

const IMPORTS_REACT = /\bfrom\s*["']react["']/;
const INLINE_STYLE = "JSXAttribute[name.name='style']";
const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts"];
// The preset called, or the plugin named in a string. An import of the preset
// that nothing calls does not run the compiler.
const RUNS_COMPILER = /\breactCompilerPreset\s*\(|["']babel-plugin-react-compiler["']/;
const MEMOIZATION = ["useMemo", "useCallback", "memo"];

type RuleOption = string | Record<string, unknown> | null;
type RuleEntry = number | string | [number | string, ...RuleOption[]];

/** The part of ESLint's resolved config for one file that is read here. */
export interface ResolvedLint {
  rules?: Record<string, RuleEntry | undefined>;
}

export type ResolveLint = (file: string) => Promise<ResolvedLint>;

export interface ReactPackage {
  path: string;
  /** A production file that imports React, and a `.tsx` one if there is one. */
  sample: string;
  markup?: string;
}

export interface PolicyVerdict {
  packages: ReactPackage[];
  findings: string[];
}

/** The packages whose production source imports React: found, never declared, so a new one cannot go unnoticed. */
export function findReactPackages({ root, config, workspace }: Project): ReactPackage[] {
  const paths = [...new Set([...Object.keys(config.packages), ...workspace.map(({ path }) => path)])].sort();
  const found: ReactPackage[] = [];

  for (const path of paths) {
    const importing = listSourceFiles(root, `${path}/src`).filter(
      (file) => !isTestScaffolding(file) && readCodeLines(root, file).some((line) => IMPORTS_REACT.test(line)),
    );
    const [sample] = importing;

    if (sample !== undefined) {
      found.push({ path, sample, markup: importing.find((file) => file.endsWith(".tsx")) });
    }
  }

  return found;
}

export async function judgeReactPolicies(project: Project, resolveLint: ResolveLint): Promise<PolicyVerdict> {
  const { root, config } = project;
  const packages = findReactPackages(project);
  const findings: string[] = [];

  for (const { path, sample, markup } of packages) {
    const declared = config.packages[path];

    if (declared?.role !== "client" && declared?.role !== "bindings") {
      if (!config.reactWithoutPolicies[path]) {
        findings.push(
          `${path} imports React (${sample}) and ${declared ? `has the role "${declared.role}"` : "has no declared role"}. The lint applies React's rules by role, to a client and to the bindings, so this package gets none: no hook rules, no inline-style ban, no memoization ban. Move the React code into a client or the bindings, or list "${path}" under reactWithoutPolicies in architecture.config.mts with the reason.`,
        );
      }

      continue;
    }

    const lint = await resolveLint(sample);
    const compiles = runsCompiler(root, path);
    const declaresCompiler = declared.role === "client" && declared.reactCompiler === true;

    if (declared.role === "client") {
      findings.push(...judgeCompiler(path, declaresCompiler, compiles));

      if (!isError(lint, "react-hooks/rules-of-hooks")) {
        findings.push(missing(path, sample, "the hook rules (react-hooks/rules-of-hooks)", "react-hooks/rules-of-hooks"));
      }

      if (markup !== undefined && !bansInlineStyle(await resolveLint(markup))) {
        findings.push(missing(path, markup, "the inline-style ban (no-restricted-syntax)", "no-restricted-syntax"));
      }
    }

    if ((declared.role === "bindings" || declaresCompiler) && !bansMemoization(lint)) {
      findings.push(missing(path, sample, "the memoization ban (no-restricted-imports of useMemo, useCallback and memo from react)", "no-restricted-imports"));
    }
  }

  for (const path of Object.keys(config.reactWithoutPolicies)) {
    if (!packages.some((found) => found.path === path)) {
      findings.push(`${path} is listed under reactWithoutPolicies and does not import React. Remove the entry: a list that is not true hides the next package that belongs in it.`);
    }
  }

  return { packages, findings };
}

function judgeCompiler(path: string, declared: boolean, compiles: boolean | undefined): string[] {
  if (declared && compiles !== true) {
    return [
      `${path} declares reactCompiler: true, so manual memoization is banned there, but ${compiles === undefined ? "it has no vite.config.ts" : "its vite.config.ts does not run the React Compiler"}. Nothing memoizes in its place. Run the compiler in the build (plugins: [react(), babel({ presets: [reactCompilerPreset()] })], with reactCompilerPreset from @vitejs/plugin-react and babel from @rolldown/plugin-babel), or remove reactCompiler from its declaration in architecture.config.mts.`,
    ];
  }

  if (!declared && compiles === true) {
    return [
      `${path} runs the React Compiler in its vite.config.ts and does not declare it, so manual memoization is not banned there: a hand-written useMemo is then noise the compiler repeats, with a dependency list that can drift. Add reactCompiler: true to its declaration in architecture.config.mts.`,
    ];
  }

  return [];
}

function missing(path: string, file: string, what: string, rule: string): string {
  return `${path} is not under ${what}: ESLint resolves no such rule, at error, for ${file}. ESLint keeps one set of options per rule, so a later block in eslint.config.mts that sets "${rule}" for this file replaces the kit's. Spread the kit's options into that block, or give the file's rule back.`;
}

/** True, false, or undefined when the package has no Vite config to read. Comments are not read. */
export function runsCompiler(root: string, path: string): boolean | undefined {
  const config = VITE_CONFIGS.map((name) => `${path}/${name}`).find((file) => existsSync(join(root, file)));

  return config === undefined ? undefined : readCodeLines(root, config).some((line) => RUNS_COMPILER.test(line));
}

function optionsOf(lint: ResolvedLint, rule: string): RuleOption[] | undefined {
  const entry = lint.rules?.[rule];
  const [level, ...options] = Array.isArray(entry) ? entry : [entry];

  return level === 2 || level === "error" ? (options as RuleOption[]) : undefined;
}

function isError(lint: ResolvedLint, rule: string): boolean {
  return optionsOf(lint, rule) !== undefined;
}

/** By its options, not its level: the rule also carries the bans on unnamed object types. */
function bansInlineStyle(lint: ResolvedLint): boolean {
  return (optionsOf(lint, "no-restricted-syntax") ?? []).some(
    (option) => typeof option === "object" && option !== null && String(option.selector ?? "").includes(INLINE_STYLE),
  );
}

interface RestrictedPath {
  name?: string;
  importNames?: string[];
}

function bansMemoization(lint: ResolvedLint): boolean {
  return (optionsOf(lint, "no-restricted-imports") ?? []).some((option) => {
    const paths = typeof option === "object" && option !== null ? ((option.paths ?? []) as RestrictedPath[]) : [];

    return paths.some(({ name, importNames = [] }) => name === "react" && MEMOIZATION.every((banned) => importNames.includes(banned)));
  });
}

export function formatVerdict({ packages, findings }: PolicyVerdict): string {
  if (packages.length === 0) {
    return "SKIP react-policies — no package imports React, so there was nothing to check";
  }

  if (findings.length === 0) {
    return `PASS react-policies — ${packages.length} package(s) import React, each under the rules its role asks for`;
  }

  return [`FAIL react-policies (${findings.length})`, ...findings.map((finding) => `  ${finding}`), "", `${findings.length} finding(s).`].join("\n");
}

const LINT_CONFIGS = ["mts", "ts", "mjs", "js", "cts", "cjs"].map((extension) => `eslint.config.${extension}`);

export class NoLintConfigError extends Error {}

/** ESLint itself, asked from the project root: the config a developer's run resolves. */
async function createResolver(root: string): Promise<ResolveLint> {
  // Asked about a file with no config above it, ESLint answers with no rules
  // and no error, which would read here as "every rule was replaced".
  if (!LINT_CONFIGS.some((name) => existsSync(join(root, name)))) {
    throw new NoLintConfigError(`there is no eslint.config.mts in ${root}, so nothing says which rules apply to a file`);
  }

  const { ESLint } = await import("eslint");
  // The project's config is TypeScript, which ESLint loads through Node.
  const eslint = new ESLint({ cwd: root, flags: ["unstable_native_nodejs_ts_config"] });

  // A file the config ignores resolves to nothing: it is under no rule.
  return async (file) => ((await eslint.calculateConfigForFile(join(root, file))) as ResolvedLint | undefined) ?? {};
}

if (isMainModule(import.meta.url)) {
  try {
    const project = await loadConfig(process.cwd());
    // With no React package there is no file to ask ESLint about, and a
    // project without ESLint is still told "nothing to check".
    const nothingToAsk: ResolveLint = async () => ({});
    const resolveLint = findReactPackages(project).length === 0 ? nothingToAsk : await createResolver(project.root);
    const verdict = await judgeReactPolicies(project, resolveLint);

    console.log(formatVerdict(verdict));
    process.exit(verdict.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? `react-policies could not run: ${error.message}`
        : `react-policies could not run, which is no verdict and not a pass: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
