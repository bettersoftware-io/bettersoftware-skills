#!/usr/bin/env node
// Holds the React Compiler to what the project relies on it for.
//
//   node tools/arch/check-compiler.mts      run in the project root
//
// A client that declares `reactCompiler: true` writes no `useMemo` and no
// `useCallback`: the compiler memoizes instead. It does so only for code it
// can compile. A component that breaks a rule of React, or takes its hooks
// from a value, is skipped without a word, and the build stays green with
// nothing memoized. So the functions that matter are listed, in
// architecture.config.mts, and this compiles each one and reads the result:
//
//   "packages/client-react": {
//     role: "client",
//     reactCompiler: true,
//     compilerTracked: [
//       { file: "src/ui/PriceList.tsx", fn: "PriceRowView" },
//       { file: "src/ui/Chart.tsx", fn: "Chart", values: ["path"] },
//     ],
//   },
//
// Without `values`, the function must compile and memoize at least
// `minMemoValues` values (default 1). With `values`, each named value must be
// memoized itself. "The function compiled" is not enough for that: the
// compiler caches what a render reads, and a value read only inside a
// callback can sit in a compiled function with no cache around it.
//
// How a memoized value is told from one that is not: the compiler writes
//
//     let t0;
//     if ($[0] !== dep) { t0 = expr; $[0] = dep; $[1] = t0; } else { t0 = $[1]; }
//     const name = t0;
//
// so a memoized value is declared as a bare temporary, and one that is not
// keeps its expression. Two more shapes count, both of a value the compiler
// merged into the cache block of a neighbour that reads it: declared bare
// (`let name;`) and read back from the slot it was written to, or declared
// with its expression inside the `if ($[0] !== dep) { … }` branch itself, so
// that it is computed only when that check says so.
//
// The compiler is loaded from the client package, so this judges with the
// version the build uses.
//
// Exit 0: every tracked function holds, or nothing is tracked (SKIP).
// Exit 1: findings. Exit 2: the check could not run.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { type CompilerTracked, ConfigError, loadConfig, packagesWithRole, type Project } from "./gates/lib/config.mts";
import { isMainModule } from "./gates/lib/files.mts";

// The compiler's log events, as far as they are read here. A success names
// its function; a function the compiler gave up on has only a place.
export interface CompilerEvent {
  kind: string;
  fnName?: string | null;
  memoValues?: number;
  detail?: { reason?: string | null; description?: string | null } | null;
  fnLoc?: { start?: { line?: number } } | null;
}

export interface Compiled {
  /** Undefined when the transform produced no code. */
  code: string | undefined;
  events: CompilerEvent[];
}

/** Compiles one file of a client with that client's own compiler. */
export type Compile = (clientPath: string, file: string) => Compiled;

export interface CompilerVerdict {
  /** Why nothing was judged, if nothing was. */
  skipped?: string;
  passed: string[];
  findings: string[];
}

export class CompilerMissingError extends Error {}

export function judgeCompiler({ root, config }: Project, compile: Compile): CompilerVerdict {
  const clients = packagesWithRole(config, "client").filter(({ reactCompiler }) => reactCompiler === true);

  if (clients.length === 0) {
    return { skipped: "no client declares reactCompiler: true, so there was nothing to check", passed: [], findings: [] };
  }

  const passed: string[] = [];
  const findings: string[] = [];

  for (const client of clients) {
    for (const tracked of client.compilerTracked ?? []) {
      const file = `${client.path}/${tracked.file}`;

      if (!existsSync(join(root, file))) {
        findings.push(`${file}: the file does not exist, so nothing holds the compiler to ${tracked.fn}. Was it moved or renamed? Update compilerTracked in architecture.config.mts.`);
        continue;
      }

      const verdict = judgeTracked(file, tracked, compile(client.path, file));

      passed.push(...verdict.passed);
      findings.push(...verdict.findings);
    }
  }

  if (passed.length === 0 && findings.length === 0) {
    return {
      skipped: `${clients.map(({ path }) => path).join(", ")} relies on the compiler and lists no function under compilerTracked, so nothing was held to it`,
      passed,
      findings,
    };
  }

  return { passed, findings };
}

/** What the compiled output says about one tracked function. */
export function judgeTracked(file: string, { fn, values, minMemoValues = 1 }: CompilerTracked, { code, events }: Compiled): Omit<CompilerVerdict, "skipped"> {
  if (code === undefined) {
    return { passed: [], findings: [`${file}: the compiler returned no output, so nothing can be said about ${fn}.`] };
  }

  const success = events.find((event) => event.kind === "CompileSuccess" && event.fnName === fn);

  if (success === undefined) {
    return { passed: [], findings: [notCompiled(file, fn, events)] };
  }

  if (values === undefined) {
    const memoized = success.memoValues ?? 0;

    return memoized >= minMemoValues
      ? { passed: [`${file}  ${fn}  (${memoized} memoized value(s), at least ${minMemoValues} asked)`], findings: [] }
      : {
          passed: [],
          findings: [
            `${file}: ${fn} compiles and memoizes ${memoized} value(s), below the ${minMemoValues} asked. The memoization this entry protects is gone: look for a value now built on every render (an object or a function made in a useState argument, a read of a ref).`,
          ],
        };
  }

  const passed: string[] = [];
  const lost: string[] = [];

  for (const name of values) {
    const problem = whyNotMemoized(code, name);

    if (problem === undefined) {
      passed.push(`${file}  ${fn}  ${name}  (memoized)`);
    } else {
      lost.push(problem);
    }
  }

  return {
    passed,
    findings: lost.length === 0 ? [] : [`${file}: ${fn} compiles, and these values in it are not memoized:\n      ${lost.join("\n      ")}`],
  };
}

function notCompiled(file: string, fn: string, events: CompilerEvent[]): string {
  // An event for a function the compiler gave up on has no name, only a
  // place. So every one in the file is listed, with its line.
  // The compiler reports a function once for each place that breaks a rule.
  const givenUp = [
    ...new Set(
      events
        .filter((event) => event.kind === "CompileError" || event.kind === "CompileSkip")
        .map((event) => {
          const reason = event.detail?.reason ?? event.detail?.description ?? "no reason given";

          return `line ${event.fnLoc?.start?.line ?? "?"}: ${String(reason).split("\n")[0]}`;
        }),
    ),
  ];

  return givenUp.length === 0
    ? `${file}: the compiler compiled no function called ${fn}, and gave up on none. Was it renamed or moved? Update compilerTracked in architecture.config.mts.`
    : `${file}: ${fn} is not compiled, so nothing in it is memoized. What the compiler gave up on in this file:\n      ${givenUp.join("\n      ")}\n      Fix what it names (the hook rules of the lint say the same), or cache the value another way and take ${fn} out of compilerTracked.`;
}

/** Undefined when `name` is memoized in the compiled code; otherwise what it is instead. */
export function whyNotMemoized(code: string, name: string): string | undefined {
  const declared = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([^;\\n]+)`).exec(code);

  if (declared === null) {
    if (isMemoizedInSharedBlock(code, name)) {
      return undefined;
    }

    return new RegExp(`function\\s+${name}\\s*\\(`).test(code)
      ? `${name} is a \`function ${name}(…)\` declaration in the compiled code, a shape this check cannot classify. Read the output and decide; do not take it as memoized.`
      : `${name} is not in the compiled code. Was it renamed or removed? Update compilerTracked.`;
  }

  const value = (declared[1] ?? "").trim();

  if (/^t\d+$/.test(value) || isInsideCacheCheck(code, declared.index)) {
    return undefined;
  }

  return `${name} is computed on every render (\`${value.slice(0, 60)}\`): no cache check stands around it.`;
}

const CACHE_CHECK = /\bif\s*\(\s*\$\[\d+\]\s*[!=]==[^{]*$/;

/**
 * True when the code at `index` is inside the branch of a cache check, at any
 * depth: `if ($[0] !== dep) {` or `if ($[0] === Symbol.for(…)) {`. Comments
 * and strings are blanked first, so a brace in one is not counted.
 */
export function isInsideCacheCheck(code: string, index: number): boolean {
  const plain = code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gm, (text) => " ".repeat(text.length));
  const open: boolean[] = [];

  for (let position = 0; position < index; position += 1) {
    if (plain[position] === "{") {
      open.push(CACHE_CHECK.test(plain.slice(Math.max(0, position - 200), position)));
    } else if (plain[position] === "}") {
      open.pop();
    }
  }

  return open.includes(true);
}

// `let name;` with no value, then `name = …` and `$[k] = name` in one branch
// and `name = $[k]` in the other: the compiler merged the value into the cache
// block of a neighbour that reads it. The read back from the same slot is the
// proof. `[\s\S]*?` and not `[^}]*?`: the branch may hold an object literal.
function isMemoizedInSharedBlock(code: string, name: string): boolean {
  if (!new RegExp(`(?:const|let)\\s+${name};`).test(code)) {
    return false;
  }

  return new RegExp(
    `if\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\b${name}\\s*=\\s*[^;\\n]+;[\\s\\S]*?\\$\\[(\\d+)\\]\\s*=\\s*${name};[\\s\\S]*?\\}\\s*else\\s*\\{?[\\s\\S]*?\\b${name}\\s*=\\s*\\$\\[\\1\\];`,
  ).test(code);
}

export function formatVerdict({ skipped, passed, findings }: CompilerVerdict): string {
  if (skipped !== undefined) {
    return `SKIP compiler — ${skipped}`;
  }

  if (findings.length === 0) {
    return [...passed.map((line) => `ok  ${line}`), "", `PASS compiler — ${passed.length} tracked value(s) and function(s) are memoized`].join("\n");
  }

  return [`FAIL compiler (${findings.length})`, ...findings.map((finding) => `  ${finding}`), "", `${findings.length} finding(s).`].join("\n");
}

// The part of @babel/core that is called. Declared here because the package
// is loaded from the client, where this file has no types for it.
interface BabelCore {
  transformSync: (source: string, options: object) => { code?: string | null } | null;
}

/** Babel and the compiler, resolved from the client package: the versions its build runs. */
function createCompile(root: string): Compile {
  return (clientPath, file) => {
    const require = createRequire(join(root, clientPath, "package.json"));
    let babel: BabelCore;
    let compiler: string;

    try {
      babel = require("@babel/core") as BabelCore;
      compiler = require.resolve("babel-plugin-react-compiler");
    } catch (error) {
      throw new CompilerMissingError(
        `${clientPath} declares reactCompiler: true, and @babel/core or babel-plugin-react-compiler cannot be loaded from it (${(error as NodeJS.ErrnoException).code ?? "error"}). Add both as dev dependencies of that package.`,
      );
    }

    const events: CompilerEvent[] = [];
    const logger = {
      logEvent: (_file: string | null, event: CompilerEvent): void => {
        events.push(event);
      },
    };
    const absolute = join(root, file);
    const result = babel.transformSync(readFileSync(absolute, "utf8"), {
      filename: absolute,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [[compiler, { logger }]],
    });

    return { code: result?.code ?? undefined, events };
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const project = await loadConfig(process.cwd());
    const verdict = judgeCompiler(project, createCompile(project.root));

    console.log(formatVerdict(verdict));
    process.exit(verdict.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(
      error instanceof ConfigError || error instanceof CompilerMissingError
        ? `compiler check could not run: ${error.message}`
        : `compiler check could not run, which is no verdict and not a pass: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
