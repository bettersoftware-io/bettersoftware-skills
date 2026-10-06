import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { chooseFixers, CouldNotRun, exitCodeOf, fix, type Fixer, type FixerRun, formatResult, MAX_ROUNDS, type RunFixer } from "../files/tools/format-lint/fix.mts";
import { createProject, readManifest, readScripts, REPOSITORY } from "./support.mts";

// `pnpm fix`: the two fixers, in turn, until each has seen the files and left
// them. The first tests give it fixers that are scripted, so each ending can
// be reached on purpose; the last ones run the real Biome and the real ESLint
// on a file that needs both more than once.

const LINT = "eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .";

describe("which fixers run", () => {
  it("runs Biome, then ESLint with the arguments of the project's own lint script and --fix", () => {
    expect(chooseFixers(createProjectWithLint(LINT))).toEqual({
      fixers: [
        { name: "biome", command: ["node_modules/.bin/biome", "check", "--write", "."] },
        { name: "eslint", command: ["node_modules/.bin/eslint", "--flag", "unstable_native_nodejs_ts_config", "--max-warnings", "0", ".", "--fix"] },
      ],
    });
  });

  it("adds --fix once to a lint script that has it already", () => {
    expect(chooseFixers(createProjectWithLint("eslint --fix .")).fixers[1]?.command).toEqual(["node_modules/.bin/eslint", ".", "--fix"]);
  });

  it.each([
    [undefined, 'the root package.json has no "lint" script'],
    ["turbo run lint", 'the "lint" script is not a plain eslint call (turbo run lint)'],
    ["eslint . && stylelint .", 'the "lint" script is not a plain eslint call (eslint . && stylelint .)'],
    ["eslint $FILES", 'the "lint" script is not a plain eslint call (eslint $FILES)'],
  ])("runs Biome alone, and says why, when the lint script is %j", (lint, why) => {
    const chosen = chooseFixers(createProjectWithLint(lint));

    expect(chosen.fixers.map(({ name }) => name)).toEqual(["biome"]);
    expect(chosen.withoutEslint).toBe(why);
  });

  it("says in what it prints that ESLint was not run", () => {
    const project = createProjectWithLint("turbo run lint");

    expect(formatResult(fix(project, createScript(project, []))).split("\n")).toEqual([
      'fix: biome only: the "lint" script is not a plain eslint call (turbo run lint), so eslint --fix was not run.',
      "  1. biome: changed nothing",
      "",
      "PASS fix — nothing to change, settled after 1 run(s) of biome.",
    ]);
  });
});

describe("running the fixers until nothing changes", () => {
  it("stops once each fixer has seen the files and left them, and says what each run changed", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0", "b.ts": "0" });
    // Biome rewraps both; ESLint adds a blank line to one; Biome lays that one out again.
    const result = fix(project, createScript(project, [{ "a.ts": "1", "b.ts": "1" }, { "a.ts": "2" }, { "a.ts": "3" }]));

    expect(result.steps).toEqual([
      { fixer: "biome", changed: ["a.ts", "b.ts"] },
      { fixer: "eslint", changed: ["a.ts"] },
      { fixer: "biome", changed: ["a.ts"] },
      { fixer: "eslint", changed: [] },
      { fixer: "biome", changed: [] },
    ]);
    expect(result).toMatchObject({ settled: true, changed: ["a.ts", "b.ts"], stillChanging: [], remaining: [] });
    expect(exitCodeOf(result)).toBe(0);
    expect(formatResult(result).split("\n")).toEqual([
      "  1. biome: changed 2 file(s)",
      "  2. eslint: changed 1 file(s)",
      "  3. biome: changed 1 file(s)",
      "  4. eslint: changed nothing",
      "  5. biome: changed nothing",
      "",
      "PASS fix — 2 file(s) changed, settled after 5 run(s) of biome and eslint.",
    ]);
  });

  it("runs each fixer once on a project with nothing to fix", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    const result = fix(project, createScript(project, []));

    expect(result.steps.map(({ fixer }) => fixer)).toEqual(["biome", "eslint"]);
    expect(formatResult(result)).toContain("PASS fix — nothing to change, settled after 2 run(s) of biome and eslint.");
  });

  it("does not stop while the other fixer has not seen the last change", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    // Biome changes nothing, then ESLint does: Biome must look again.
    const result = fix(project, createScript(project, [{}, { "a.ts": "1" }]));

    expect(result.steps.map(({ fixer, changed }) => `${fixer} ${changed.length}`)).toEqual(["biome 0", "eslint 1", "biome 0", "eslint 0"]);
    expect(result.settled).toBe(true);
  });

  it("counts a file as changed by what it holds at the end: one put back as it was is not in the list", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0", "b.ts": "0" });
    const result = fix(project, createScript(project, [{ "a.ts": "1", "b.ts": "1" }, { "a.ts": "2", "b.ts": "0" }]));

    expect(result.settled).toBe(true);
    expect(result.changed).toEqual(["a.ts"]);
  });

  it("sees a file a fixer made, and reads no installed or generated folder", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0", "node_modules/x/index.ts": "0", "dist/out.ts": "0" });
    const result = fix(project, createScript(project, [{ "new.ts": "1", "node_modules/x/index.ts": "1", "dist/out.ts": "1" }]));

    expect(result.changed).toEqual(["new.ts"]);
  });
});

describe("fixers that undo each other", () => {
  it("stops as soon as the files are back in a state they were in, names the files, and exits 3", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0", "b.ts": "0", "calm.ts": "0" });
    // Biome joins a line that ESLint breaks again.
    const result = fix(project, createScript(project, [{ "a.ts": "joined", "calm.ts": "1" }, { "a.ts": "broken" }, { "a.ts": "joined" }, { "a.ts": "broken" }, { "a.ts": "joined" }]));

    expect(result.steps).toHaveLength(3);
    expect(result).toMatchObject({ settled: false, stillChanging: ["a.ts"], remaining: [] });
    expect(exitCodeOf(result)).toBe(3);
    expect(formatResult(result).split("\n")).toEqual([
      "  1. biome: changed 2 file(s)",
      "  2. eslint: changed 1 file(s)",
      "  3. biome: changed 1 file(s)",
      "",
      "FAIL fix — not settled after 3 run(s) of biome and eslint. They are still rewriting:",
      "  a.ts",
      "",
      "Each fixer undoes what the other did there, so running this again changes nothing about that.",
      "It is a conflict between biome.json and the ESLint config. To see it, run one after the other on one of the files:",
      "  node_modules/.bin/biome check --write <file> && git diff <file>",
      "  node_modules/.bin/eslint --fix <file> && git diff <file>",
      "Then change the rule of one tool so that both accept the same text.",
    ]);
  });

  it("gives up after each has run five times when the files never come back to a state they were in", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0", "calm.ts": "0" });
    let run = 0;
    const grow: RunFixer = () => {
      run += 1;
      writeFileSync(join(project, "a.ts"), `${run}`);

      return { status: 0, output: "" };
    };
    const result = fix(project, grow);

    expect(MAX_ROUNDS).toBe(5);
    expect(result.steps).toHaveLength(10);
    expect(result.settled).toBe(false);
    expect(result.stillChanging).toEqual(["a.ts"]);
    expect(exitCodeOf(result)).toBe(3);
    expect(formatResult(result)).toContain(`FAIL fix — not settled after ${MAX_ROUNDS * 2} run(s) of biome and eslint. They are still rewriting:\n  a.ts\n`);
  });

  it("takes the number of rounds it is given", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    let run = 0;
    const result = fix(
      project,
      () => {
        run += 1;
        writeFileSync(join(project, "a.ts"), `${run}`);

        return { status: 0, output: "" };
      },
      2,
    );

    expect(result.steps).toHaveLength(4);
  });
});

describe("findings no fixer repairs", () => {
  it("are printed once the files have settled, under the fixer that has them, and the exit code is 1", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    const result = fix(
      project,
      createScript(project, [{ "a.ts": "1" }], (fixer, step) => (fixer.name === "biome" ? { status: 1, output: `a.ts: a branch without braces (run ${step})\nFound 1 error.\n` } : { status: 0, output: "" })),
    );

    expect(result.settled).toBe(true);
    expect(result.remaining).toEqual([{ fixer: "biome", output: "a.ts: a branch without braces (run 3)\nFound 1 error." }]);
    expect(exitCodeOf(result)).toBe(1);
    expect(formatResult(result).split("\n").slice(4)).toEqual([
      "FAIL fix — 1 file(s) changed, settled after 3 run(s) of biome and eslint, and biome still has findings no fixer repairs. Fix them in the code:",
      "",
      "biome:",
      "  a.ts: a branch without braces (run 3)",
      "  Found 1 error.",
    ]);
  });

  it("are what a fixer said on its last run: a finding a later run repaired is not among them", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    // ESLint fails while the file is as Biome left it, and passes once it has rewritten it.
    const result = fix(
      project,
      createScript(project, [{}, { "a.ts": "1" }], (fixer, step) => ({ status: fixer.name === "eslint" && step === 2 ? 1 : 0, output: "" })),
    );

    expect(result.remaining).toEqual([]);
    expect(exitCodeOf(result)).toBe(0);
  });

  it("names both fixers when both have some", () => {
    const project = createProjectWithLint(LINT, { "a.ts": "0" });
    const result = fix(project, createScript(project, [], (fixer) => ({ status: 1, output: `${fixer.name} says no` })));

    expect(formatResult(result)).toContain("and biome and eslint still have findings no fixer repairs.");
    expect(result.remaining.map(({ fixer }) => fixer)).toEqual(["biome", "eslint"]);
  });
});

describe("a fixer that cannot run", () => {
  it("is said, not passed over: a project with nothing installed", () => {
    expect(() => fix(createProjectWithLint(LINT))).toThrow(new CouldNotRun("biome is not installed (there is no node_modules/.bin/biome). Run `pnpm install`."));
  });

  it("is told from findings: ESLint's exit 2 is a config it could not load", () => {
    const project = createProjectWithLint(LINT, {
      "node_modules/.bin/biome": "#!/bin/sh\nexit 0\n",
      "node_modules/.bin/eslint": "#!/bin/sh\necho 'Oops! Something went wrong!' >&2\nexit 2\n",
    });

    chmodSync(join(project, "node_modules/.bin/biome"), 0o755);
    chmodSync(join(project, "node_modules/.bin/eslint"), 0o755);

    expect(() => fix(project)).toThrow(new CouldNotRun("eslint stopped with exit 2: Oops! Something went wrong!"));
  });

  it("stops the script with exit 2 and that sentence", () => {
    const project = createProjectWithLint(LINT);
    const ran = spawnSync(process.execPath, [join(REPOSITORY, "addons/format-lint/files/tools/format-lint/fix.mts")], { cwd: project, encoding: "utf8" });

    expect(ran.status).toBe(2);
    expect(ran.stderr.trim()).toBe("fix could not run: biome is not installed (there is no node_modules/.bin/biome). Run `pnpm install`.");
  });
});

describe("in a git repository", () => {
  it.skipIf(spawnSync("git", ["--version"]).status !== 0)("reads the files git lists, new ones included, and nothing git ignores", () => {
    const project = createProjectWithLint(LINT, { ".gitignore": "scratch/\n", "a.ts": "0", "scratch/b.ts": "0" });

    spawnSync("git", ["init", "--quiet"], { cwd: project });

    expect(fix(project, createScript(project, [{ "a.ts": "1", "scratch/b.ts": "1", "new.ts": "1" }])).changed).toEqual(["a.ts", "new.ts"]);
  });
});

describe("what the add-on tells a project to run", () => {
  it("adds the script, by plain node, and asks for it once after installing", () => {
    expect(readScripts().fix).toBe("node tools/format-lint/fix.mts");
    expect((readManifest() as unknown as { firstRun: string }).firstRun).toBe("pnpm fix");
  });

  it("says so in the text an agent reads", () => {
    const section = readFileSync(join(REPOSITORY, "addons/format-lint/AGENTS.section.md"), "utf8");

    expect(section).toContain("Run `pnpm fix` after you finish editing");
    expect(section).not.toMatch(/Run `pnpm biome:fix`/);
  });
});

// One file with the three things the fixers do to each other: two imports of
// one module (ESLint joins them, Biome sorts and lays them out), an arrow with
// an expression body (ESLint writes a block on one line, Biome lays it out),
// and two long declarations side by side (Biome wraps them, ESLint wants a
// blank line between two that span lines).
const SAMPLE = `import { type Price } from "#/entities/price.ts";
import type { PriceTick } from "#/entities/price.ts";

export function describeAll(prices: readonly Price[], ticks: readonly PriceTick[]): string[] {
  const symbols = prices.map((price) => price.symbol.toUpperCase().padStart(12, " ").padEnd(24, " ").trim());
  const movements = ticks.map((tick) => tick.movement.toUpperCase().padStart(12, " ").padEnd(24, " ").trim());

  return [...symbols, ...movements];
}
`;

const SETTLED = `import type { Price, PriceTick } from "#/entities/price.ts";

export function describeAll(
  prices: readonly Price[],
  ticks: readonly PriceTick[],
): string[] {
  const symbols = prices.map((price) => {
    return price.symbol.toUpperCase().padStart(12, " ").padEnd(24, " ").trim();
  });

  const movements = ticks.map((tick) => {
    return tick.movement.toUpperCase().padStart(12, " ").padEnd(24, " ").trim();
  });

  return [...symbols, ...movements];
}
`;

const FILE = "packages/domain/src/useCases/describeAll.ts";

describe("the real Biome and the real ESLint, with the shipped base and the kit's rules", { timeout: 120_000 }, () => {
  it("need more than one pass in either order, and this reaches the text both accept", () => {
    const project = createRealProject({ [FILE]: SAMPLE });
    const result = fix(project);

    expect(result.steps).toEqual([
      { fixer: "biome", changed: [FILE] },
      { fixer: "eslint", changed: [FILE] },
      { fixer: "biome", changed: [FILE] },
      { fixer: "eslint", changed: [] },
      { fixer: "biome", changed: [] },
    ]);
    expect(formatResult(result)).toContain("PASS fix — 1 file(s) changed, settled after 5 run(s) of biome and eslint.");
    expect(readFileSync(join(project, FILE), "utf8")).toBe(SETTLED);
  });

  it("hold that text: neither changes it, neither has a finding in it, and the check of each passes", () => {
    const project = createRealProject({ [FILE]: SETTLED });
    const result = fix(project);

    expect(result.steps).toEqual([
      { fixer: "biome", changed: [] },
      { fixer: "eslint", changed: [] },
    ]);
    expect(exitCodeOf(result)).toBe(0);
    expect(readFileSync(join(project, FILE), "utf8")).toBe(SETTLED);
    expect(runTool(project, "biome", ["ci", "--error-on-warnings", "."])).toBe(0);
    expect(runTool(project, "eslint", ["--flag", "unstable_native_nodejs_ts_config", "--max-warnings", "0", "."])).toBe(0);
  });

  it("reach the same text when ESLint goes first, in three runs and not two", () => {
    const project = createRealProject({ [FILE]: SAMPLE });
    const eslint = ["--flag", "unstable_native_nodejs_ts_config", "--fix", "."];
    const texts: string[] = [];

    for (const [tool, args] of [["eslint", eslint], ["biome", ["check", "--write", "."]], ["eslint", eslint]] as const) {
      runTool(project, tool, [...args]);
      texts.push(readFileSync(join(project, FILE), "utf8"));
    }

    expect(texts[1]).not.toBe(SETTLED);
    expect(texts[2]).toBe(SETTLED);
  });
});

/** A project with a root `lint` script (none when `lint` is undefined) and `files`. Nothing is installed in it. */
function createProjectWithLint(lint: string | undefined, files: Record<string, string> = {}): string {
  return createProject({ "package.json": `${JSON.stringify({ name: "project", scripts: lint === undefined ? {} : { lint } })}\n`, ...files });
}

/**
 * Fixers that follow a script: the run numbered n writes `writes[n - 1]`
 * (path → content) and nothing once the script is over. What each run reports
 * is `report`'s to say; by default every run is clean.
 */
function createScript(project: string, writes: Record<string, string>[], report: (fixer: Fixer, step: number) => FixerRun = () => ({ status: 0, output: "" })): RunFixer {
  let step = 0;

  return (fixer) => {
    for (const [path, content] of Object.entries(writes[step] ?? {})) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), content);
    }

    step += 1;

    return report(fixer, step);
  };
}

/**
 * A project the real tools run in: the shipped Biome configs, the kit's ESLint
 * rules for a domain package, the starter's `lint` script, and this
 * repository's node_modules by a link, so the tools are the versions
 * installed here.
 */
function createRealProject(files: Record<string, string>): string {
  const project = createProject({
    "package.json": `${JSON.stringify({ name: "project", private: true, type: "module", scripts: { lint: LINT } }, null, 2)}\n`,
    "eslint.config.mts": `import { architectureLint } from ${JSON.stringify(join(REPOSITORY, "kit/eslint.config.mts"))};\n\nexport default [...architectureLint({ packages: { "packages/domain": { role: "domain" } } })];\n`,
    ...files,
  });

  symlinkSync(join(REPOSITORY, "node_modules"), join(project, "node_modules"), "dir");
  // The config names this repository by its path, which is as long as the machine makes it: laid out once, so only the sample is left to fix.
  runTool(project, "biome", ["check", "--write", "eslint.config.mts"]);

  return project;
}

function runTool(project: string, tool: string, args: string[]): number | null {
  return spawnSync(join(project, "node_modules/.bin", tool), args, { cwd: project, encoding: "utf8" }).status;
}
