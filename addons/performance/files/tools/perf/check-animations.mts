#!/usr/bin/env node
// The static animation check: what can be decided about an animation from its
// source, before anything runs.
//
//   node tools/perf/check-animations.mts              judge the project
//   node tools/perf/check-animations.mts --root <dir> judge another folder
//   node tools/perf/check-animations.mts --json       machine-readable
//
// Reads every `.css` file, and every `element.animate()` call in `.ts` and
// `.tsx` files that are not tests. See docs/performance.md for the rules.
//
// Exit 0: no findings, or nothing to judge (SKIP). Exit 1: findings.
// Exit 2: the check could not run.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ALLOWED_FILE, type AllowedAnimation, AllowedError, loadAllowed } from "./lib/allowed.mts";
import { type CssDeclaration, scanCss } from "./lib/css.mts";
import { isMainModule, isTestFile, listFiles } from "./lib/files.mts";
import {
  type Finding,
  indexKeyframes,
  judgeAnimateCalls,
  type Judgement,
  judgeStylesheet,
  type Tally,
  type Unjudged,
} from "./lib/rules.mts";
import { scanAnimateCalls } from "./lib/waapi.mts";

const GATE = "animations";

export interface CheckOptions {
  root?: string;
  /** Replaces the project's `tools/perf/allowed.mts`. For tests. */
  allowed?: AllowedAnimation[];
}

export interface CheckResult {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  findings: Finding[];
  /** Animation code the source does not settle. Never counted as clean. */
  unjudged: Unjudged[];
  /** Findings accepted by the allow-list, each with its reason. */
  accepted: { finding: Finding; reason: string }[];
  tally: Tally;
  files: { css: number; typescript: number };
}

export class CheckError extends Error {}

export async function checkAnimations({ root = process.cwd(), allowed }: CheckOptions = {}): Promise<CheckResult> {
  const project = resolve(root);

  if (!existsSync(project)) {
    throw new CheckError(`${project} does not exist`);
  }

  const allowList = allowed ?? (await loadAllowed(project)).animations;
  const stylesheets = listFiles(project, /\.css$/).map((file): [string, CssDeclaration[]] => [
    file,
    scanCss(readFileSync(join(project, file), "utf8")),
  ]);
  const scripts = listFiles(project, /\.tsx?$/).filter((file) => !isTestFile(file) && !file.endsWith(".d.ts"));
  const elsewhere = keyframesAcrossFiles(stylesheets);

  const judgements: Judgement[] = [
    ...stylesheets.map(([file, declarations]) => judgeStylesheet(file, declarations, elsewhere)),
    ...scripts.map((file) => judgeAnimateCalls(file, scanAnimateCalls(readFileSync(join(project, file), "utf8")))),
  ];

  const tally: Tally = { transitions: 0, keyframes: 0, animateCalls: 0 };

  for (const judgement of judgements) {
    tally.transitions += judgement.tally.transitions;
    tally.keyframes += judgement.tally.keyframes;
    tally.animateCalls += judgement.tally.animateCalls;
  }

  const unjudged = judgements.flatMap((judgement) => judgement.unjudged);
  const { findings, accepted } = applyAllowList(
    judgements.flatMap((judgement) => judgement.findings),
    allowList,
  );
  const judged = tally.transitions + tally.keyframes + tally.animateCalls;
  const files = { css: stylesheets.length, typescript: scripts.length };

  return {
    gate: GATE,
    ...(judged === 0 ? { skipped: skipReason(files, unjudged.length) } : {}),
    findings,
    unjudged,
    accepted,
    tally,
    files,
  };
}

function skipReason(files: CheckResult["files"], unjudged: number): string {
  const read = `${files.css} stylesheet(s) and ${files.typescript} TypeScript file(s)`;

  return unjudged === 0
    ? `no transition, no @keyframes and no .animate( call in ${read}`
    : `nothing could be judged from source in ${read}`;
}

/** Resolves a keyframes name to its properties when exactly one stylesheet defines it. */
function keyframesAcrossFiles(stylesheets: [string, CssDeclaration[]][]): (name: string) => Set<string> | undefined {
  const definitions = new Map<string, Set<string>[]>();

  for (const [, declarations] of stylesheets) {
    for (const [name, properties] of indexKeyframes(declarations)) {
      definitions.set(name, [...(definitions.get(name) ?? []), properties]);
    }
  }

  return (name) => {
    const found = definitions.get(name) ?? [];

    return found.length === 1 ? found[0] : undefined;
  };
}

/**
 * Moves each finding the allow-list names to `accepted`. An entry that names no
 * finding is itself a finding: an exception nobody needs any more is removed,
 * so the list cannot quietly cover a later change.
 */
function applyAllowList(all: Finding[], allowList: AllowedAnimation[]): Pick<CheckResult, "findings" | "accepted"> {
  const findings: Finding[] = [];
  const accepted: CheckResult["accepted"] = [];
  const used = new Set<AllowedAnimation>();

  for (const finding of all) {
    const entry = allowList.find(
      ({ file, rule, property }) => file === finding.file && rule === finding.rule && property === finding.property,
    );

    if (entry === undefined) {
      findings.push(finding);
    } else {
      used.add(entry);
      accepted.push({ finding, reason: entry.reason });
    }
  }

  for (const entry of allowList) {
    if (!used.has(entry)) {
      findings.push({
        file: ALLOWED_FILE,
        line: 0,
        rule: entry.rule,
        property: entry.property,
        message: `This entry accepts nothing: the check has no finding in ${entry.file} for rule "${entry.rule}", property "${entry.property}". Remove the entry, or correct it to match the finding as printed.`,
      });
    }
  }

  return { findings, accepted };
}

export function formatResult({ gate, skipped, findings, unjudged, accepted, tally, files }: CheckResult): string {
  const lines: string[] = [];
  const judged = `${tally.transitions} transition(s), ${tally.keyframes} @keyframes and ${tally.animateCalls} .animate( call(s) in ${files.css} stylesheet(s) and ${files.typescript} TypeScript file(s)`;

  if (findings.length > 0) {
    lines.push(`FAIL ${gate} (${findings.length})`);

    for (const finding of findings) {
      lines.push(
        `  ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}`,
        `    ${finding.message}`,
        `    rule "${finding.rule}", property "${finding.property}"`,
      );
    }
  } else if (skipped !== undefined) {
    // Nothing to judge is reported as such: it is not a pass.
    lines.push(`SKIP ${gate} — ${skipped}`);
  } else {
    lines.push(`PASS ${gate} — judged ${judged}`);
  }

  if (accepted.length > 0) {
    lines.push("", `Accepted by ${ALLOWED_FILE} (${accepted.length}):`);

    for (const { finding, reason } of accepted) {
      lines.push(`  ${finding.file}:${finding.line} ${finding.rule}, ${finding.property}: ${reason}`);
    }
  }

  if (unjudged.length > 0) {
    lines.push("", `Not judged (${unjudged.length}): the source does not settle these. Run \`pnpm perf:motion-audit\`.`);

    for (const { file, line, why } of unjudged) {
      lines.push(`  ${file}:${line} ${why}`);
    }
  }

  if (findings.length > 0) {
    lines.push(
      "",
      `${findings.length} finding(s). Fix the animation; docs/performance.md has a pattern for each case.`,
      `An exception is accepted only in ${ALLOWED_FILE}, as { file, rule, property, reason }, and only for`,
      "an animation that live data cannot trigger (docs/performance.md, \"Exceptions\").",
    );
  }

  return lines.join("\n");
}

interface CommandLine {
  root?: string;
  json: boolean;
}

function parseArguments(argv: string[]): CommandLine {
  const options: CommandLine = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--root" && argv[index + 1] !== undefined) {
      options.root = argv[index + 1];
      index += 1;
    } else {
      throw new CheckError(`unknown argument "${argument}" (use --root <dir>, --json)`);
    }
  }

  return options;
}

if (isMainModule(import.meta.url)) {
  try {
    const { json, root } = parseArguments(process.argv.slice(2));
    const result = await checkAnimations({ root });

    console.log(json ? JSON.stringify(result, null, 2) : formatResult(result));
    process.exit(result.findings.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(
      error instanceof CheckError || error instanceof AllowedError ? `perf:check could not run: ${error.message}` : error,
    );
    process.exit(2);
  }
}
