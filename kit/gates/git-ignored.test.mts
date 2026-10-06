import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ESLint, type Linter } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";

import { architectureLint } from "../eslint.config.mts";
import { askGit, gitIgnoredGlobs, isGitIgnored, listGitIgnored, listIgnoredCode, listPackageFolders, listSourceFiles } from "./lib/files.mts";
import { runGates } from "./run.mts";

// Two rules, and they pull against each other.
//
// A file git ignores outside every package is not the project's: nobody else
// has it, and CI never sees it. A plugin's working folder (`.remember/`, which
// ignores itself with a `.gitignore` of its own) once failed the typed lint
// with a file that only one machine had. So the gates and the lint leave such
// a file out.
//
// Inside a package nothing is left out for being ignored. If it were, the one
// being checked could take a file past every check with one line in a
// `.gitignore`: the file is still built. So such a file is judged, and is a
// finding of its own (`ignored-source`).
//
// Git is asked which paths are ignored, by a real git in a real repository.

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

/** A JavaScript file: the `typescript-only` gate and the lint's JavaScript ban both report one. */
const SCRIPT = "export const one = 1;\n";

const CONFIG = "export default { packages: {} };\n";

/** A project with one declared package, in a workspace. */
const PROJECT = {
  "architecture.config.mts": 'export default { packages: { "packages/domain": { role: "domain" } } };\n',
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": '{ "name": "project", "private": true }\n',
  "packages/domain/package.json": '{ "name": "@app/domain", "scripts": { "test": "vitest run", "typecheck": "tsc" } }\n',
  "packages/domain/src/index.ts": SCRIPT,
  "packages/domain/src/ports/pricePort.ts": SCRIPT,
};

const HIDDEN = "packages/domain/src/hidden.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(!HAS_GIT)("what git ignores, outside every package", () => {
  it("is listed whether the root's .gitignore says so or a folder's own, and a folder ignored from outside is named once and not walked", () => {
    const root = createRepository({
      ".gitignore": "scratch.js\ngenerated/\n",
      ".remember/.gitignore": "*\n",
      ".remember/tmp/last.ts": SCRIPT,
      ".remember/now.js": SCRIPT,
      "scratch.js": SCRIPT,
      "generated/a.js": SCRIPT,
      "generated/deep/b.js": SCRIPT,
      "src/kept.js": SCRIPT,
    });
    const listed = listGitIgnored(root) ?? [];

    // A folder that ignores itself is listed with what it holds; one ignored from above is one entry.
    expect(listed.filter((entry) => !entry.startsWith(".remember/")).sort()).toEqual(["generated/", "scratch.js"]);
    expect(listed).toContain(".remember/");

    for (const path of [".remember/tmp/last.ts", ".remember/now.js", "scratch.js", "generated/deep/b.js"]) {
      expect(isGitIgnored(root, path), path).toBe(true);
    }

    expect(isGitIgnored(root, "src/kept.js")).toBe(false);
  });

  it("a folder's own `*` hides that folder and nothing else of the project", () => {
    const root = createRepository({ ".remember/.gitignore": "*\n", ".remember/tmp/last.ts": SCRIPT, "scripts/a.ts": SCRIPT, "b.ts": SCRIPT });

    expect(listSourceFiles(root, "")).toEqual(["b.ts", "scripts/a.ts"]);
    expect(gitIgnoredGlobs(root).every((glob) => glob.startsWith(".remember/"))).toBe(true);
  });

  it("never holds a file that is committed, whatever a pattern says", () => {
    const root = createRepository({ ".gitignore": "*.js\n", "kept.js": SCRIPT, "dropped.js": SCRIPT });

    spawnSync("git", ["add", "--force", "kept.js"], { cwd: root });

    expect(listGitIgnored(root)).toEqual(["dropped.js"]);
    expect(listSourceFiles(root, "")).toEqual(["kept.js"]);
  });

  it("is left out by the gates' file walker, at any depth, and a file that is only new is not", () => {
    const root = createRepository({
      ".remember/.gitignore": "*\n",
      ".remember/tmp/last.ts": SCRIPT,
      "misc/.gitignore": "generated/\nlocal.ts\n",
      "misc/generated/a.ts": SCRIPT,
      "misc/local.ts": SCRIPT,
      "misc/src/new.ts": SCRIPT,
    });

    expect(listSourceFiles(root, "")).toEqual(["misc/src/new.ts"]);
    expect(listSourceFiles(root, "misc")).toEqual(["misc/src/new.ts"]);
    // Asked for a folder inside an ignored one: still nothing.
    expect(listSourceFiles(root, ".remember/tmp")).toEqual([]);
    expect(listSourceFiles(root, "misc/generated")).toEqual([]);
  });

  it("is told from a name that only begins the same way", () => {
    const root = createRepository({ ".gitignore": "gen/\nnotes.ts\n", "gen/a.ts": SCRIPT, "generated/b.ts": SCRIPT, "notes.ts": SCRIPT, "notes.tsx": SCRIPT });

    expect(listSourceFiles(root, "")).toEqual(["generated/b.ts", "notes.tsx"]);
    expect(isGitIgnored(root, "gen")).toBe(true);
    expect(isGitIgnored(root, "gen/a.ts")).toBe(true);
    expect(isGitIgnored(root, "generated")).toBe(false);
  });

  it("is judged by no gate: the JavaScript file a full run reports is the one git does not ignore", async () => {
    const root = createRepository({ "architecture.config.mts": CONFIG, ".remember/.gitignore": "*\n", ".remember/tmp/x.js": SCRIPT, "scripts/y.js": SCRIPT });

    const { findings } = await runGates({ root });

    expect(findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual(["scripts/y.js"]);
  });

  it("is not judged when the editor hook names it either", async () => {
    const root = createRepository({ "architecture.config.mts": CONFIG, ".remember/.gitignore": "*\n", ".remember/tmp/x.js": SCRIPT, "scripts/y.js": SCRIPT });

    const { findings } = await runGates({ root, files: [".remember/tmp/x.js", "scripts/y.js"] });

    expect(findings.map(({ file }) => file)).toEqual(["scripts/y.js"]);
  });

  it("is not linted: the kit's lint config ignores it, and still reports the same mistake in a file that is only new", async () => {
    const root = createRepository({ ".remember/.gitignore": "*\n", ".remember/tmp/x.js": SCRIPT, ".remember/tmp/last.ts": SCRIPT, "scripts/y.js": SCRIPT });
    const results = await lint(root).lintFiles(["."]);

    expect(results.map(({ filePath, messages }) => [filePath.slice(root.length + 1), messages.map(({ ruleId }) => ruleId)])).toEqual([["scripts/y.js", ["no-restricted-syntax"]]]);
    expect(await lint(root).isPathIgnored(join(root, ".remember/tmp/last.ts"))).toBe(true);
  });
});

describe.skipIf(!HAS_GIT)("a .gitignore in a folder, read the way git reads it", () => {
  // Every kind of line: anchored to the folder, a name at any depth, a
  // negation, `**`, a `#` that is a name and not a comment, a folder only.
  const RULES = ["/out", "build", "*.gen.ts", "!keep.gen.ts", "/deep/**/tmp", "\\#notes.ts", "only-folder/", "# a comment: a.ts", ""].join("\n");
  const FILES: [path: string, ignored: boolean][] = [
    ["misc/out/a.ts", true],
    ["misc/sub/out/b.ts", false],
    ["misc/build/c.ts", true],
    ["misc/sub/build/d.ts", true],
    ["misc/x.gen.ts", true],
    ["misc/sub/y.gen.ts", true],
    ["misc/keep.gen.ts", false],
    ["misc/deep/one/two/tmp/e.ts", true],
    ["misc/tmp/f.ts", false],
    ["misc/#notes.ts", true],
    ["misc/only-folder/g.ts", true],
    ["misc/only-folder.ts", false],
    ["misc/a.ts", false],
    // The same names beside the folder: its rules do not reach them.
    ["out/a.ts", false],
    ["build/c.ts", false],
    ["x.gen.ts", false],
    ["other/build/c.ts", false],
  ];
  const create = (): string => createRepository({ "misc/.gitignore": RULES, ...Object.fromEntries(FILES.map(([path]) => [path, SCRIPT])) });
  const KEPT = FILES.filter(([, ignored]) => !ignored).map(([path]) => path).sort();

  it("leaves out exactly the files git ignores, from that folder down and nowhere else", () => {
    const root = create();

    expect(listSourceFiles(root, "")).toEqual(KEPT);
    expect(FILES.filter(([path]) => isGitIgnored(root, path)).map(([path]) => path).sort()).toEqual(FILES.filter(([, ignored]) => ignored).map(([path]) => path).sort());
  });

  it("agrees with git itself, asked about each file", () => {
    const root = create();
    const asked = spawnSync("git", ["check-ignore", "--stdin", "-z"], { cwd: root, input: FILES.map(([path]) => path).join("\0"), encoding: "utf8" });

    expect(asked.stdout.split("\0").filter(Boolean).sort()).toEqual(FILES.filter(([, ignored]) => ignored).map(([path]) => path).sort());
  });

  it("gives the lint the same answer for every file, through patterns made from the paths git listed", async () => {
    const root = create();
    const eslint = lint(root);

    for (const [path, ignored] of FILES) {
      expect(await eslint.isPathIgnored(join(root, path)), path).toBe(ignored);
    }
  });

  it("makes each pattern a path git listed, with a name a glob would read as a pattern taken literally", async () => {
    const root = createRepository({
      ".gitignore": "/app/\\[id\\]/\n/a(b)!+@{c}.ts\n",
      "app/[id]/page.ts": SCRIPT,
      "app/i/page.ts": SCRIPT,
      "a(b)!+@{c}.ts": SCRIPT,
      "ab.ts": SCRIPT,
    });
    const globs = gitIgnoredGlobs(root);
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{ ignores: globs }, { files: ["**/*.ts"] }] });

    expect(globs.sort()).toEqual(["a\\(b\\)\\!\\+\\@\\{c\\}.ts", "app/\\[id\\]/**"]);
    expect(await eslint.isPathIgnored(join(root, "app/[id]/page.ts"))).toBe(true);
    expect(await eslint.isPathIgnored(join(root, "a(b)!+@{c}.ts"))).toBe(true);
    expect(await eslint.isPathIgnored(join(root, "app/i/page.ts"))).toBe(false);
    expect(await eslint.isPathIgnored(join(root, "ab.ts"))).toBe(false);
  });
});

describe.skipIf(!HAS_GIT)("a rule that is in no file of the repository", () => {
  it("hides nothing when it is in .git/info/exclude", async () => {
    const root = createRepository({ "architecture.config.mts": CONFIG, "local/notes.js": SCRIPT, ".git/info/exclude": "local/\n" });

    // Git itself does ignore it: the gates do not take that as a reason.
    expect(spawnSync("git", ["check-ignore", "local/notes.js"], { cwd: root }).status).toBe(0);
    expect(listGitIgnored(root)).toEqual([]);
    expect((await runGates({ root })).findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual(["local/notes.js"]);
    expect(await lint(root).isPathIgnored(join(root, "local/notes.js"))).toBe(false);
  });

  it("hides nothing when it is in the person's global list", async () => {
    const home = createFolder({ gitconfig: "", ignore: "local/\n" });

    writeFileSync(join(home, "gitconfig"), `[core]\n\texcludesFile = ${join(home, "ignore")}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));

    const root = createRepository({ "architecture.config.mts": CONFIG, "local/notes.js": SCRIPT });

    expect(spawnSync("git", ["check-ignore", "local/notes.js"], { cwd: root }).status).toBe(0);
    expect(listGitIgnored(root)).toEqual([]);
    expect((await runGates({ root })).findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual(["local/notes.js"]);
  });
});

describe.skipIf(!HAS_GIT)("a file in a package that git ignores", () => {
  // Each is a way to take the file out of a check that only asks "does git ignore it?".
  const WAYS: [how: string, files: Record<string, string>][] = [
    ["a line in the root .gitignore", { ".gitignore": "hidden.js\n" }],
    ["a .gitignore beside it", { "packages/domain/src/.gitignore": "hidden.js\n" }],
    ["a .gitignore beside it that ignores everything", { "packages/domain/src/.gitignore": "*\n" }],
    ["the whole package ignored", { ".gitignore": "/packages/domain/\n" }],
    ["the folder that holds the packages ignored", { ".gitignore": "/packages/\n" }],
  ];

  it.each(WAYS)("is still judged by the gates, and is a finding of its own, with %s", async (_how, files) => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, ...files });

    expect(spawnSync("git", ["check-ignore", HIDDEN], { cwd: root }).status).toBe(0);
    expect(isGitIgnored(root, HIDDEN)).toBe(false);
    expect(listSourceFiles(root, "packages/domain")).toContain(HIDDEN);

    const { findings } = await runGates({ root });

    expect(findings.filter(({ gate, file }) => gate === "typescript-only" && file === HIDDEN)).toHaveLength(1);
    expect(findings.filter(({ gate, file }) => gate === "ignored-source" && file === HIDDEN).map(({ message }) => message)).toEqual([
      "This file is in a package and git ignores it. It is built here and checked by nothing, and it would be missing in CI. Take the line that ignores it out of the .gitignore (`git check-ignore -v` names the line) and commit the file, or delete the file. Only installed and generated folders are ignored inside a package.",
    ]);
  });

  it.each(WAYS)("is still linted, with %s", async (_how, files) => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, ...files });
    const results = await lint(root).lintFiles(["."]);

    expect(results.filter(({ filePath }) => filePath.endsWith(HIDDEN)).flatMap(({ messages }) => messages.map(({ ruleId }) => ruleId))).toEqual(["no-restricted-syntax"]);
  });

  it("is a finding when the rule is in .git/info/exclude: the gates judge the file anyway, and a tool that reads that list for itself would not", async () => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, "packages/domain/src/theme.css": "a {}\n", ".git/info/exclude": "hidden.js\ntheme.css\n" });
    const { findings } = await runGates({ root });

    expect(findings.filter(({ gate }) => gate === "ignored-source").map(({ file }) => file)).toEqual([HIDDEN, "packages/domain/src/theme.css"]);
    expect(findings.filter(({ gate, file }) => gate === "typescript-only" && file === HIDDEN)).toHaveLength(1);
  });

  it("is judged when the editor hook names it, and reported as ignored there too", async () => {
    const root = createRepository({ ...PROJECT, [HIDDEN]: SCRIPT, "packages/domain/src/.gitignore": "hidden.js\n" });
    const { findings } = await runGates({ root, files: [HIDDEN] });

    expect(findings.map(({ gate, file }) => `${gate} ${file}`).sort()).toEqual([`ignored-source ${HIDDEN}`, `typescript-only ${HIDDEN}`]);
  });

  it("is found in an ignored folder of a package, every code file of it, TypeScript and CSS included", () => {
    const root = createRepository({
      ...PROJECT,
      "packages/domain/.gitignore": "/src/secret/\n",
      "packages/domain/src/secret/a.ts": SCRIPT,
      "packages/domain/src/secret/deep/b.tsx": SCRIPT,
      "packages/domain/src/secret/c.css": "a {}\n",
      "packages/domain/src/secret/notes.txt": "",
    });

    expect(listIgnoredCode(root)).toEqual(["packages/domain/src/secret/a.ts", "packages/domain/src/secret/c.css", "packages/domain/src/secret/deep/b.tsx"]);
    expect(listSourceFiles(root, "packages/domain/src/secret")).toEqual(["packages/domain/src/secret/a.ts", "packages/domain/src/secret/deep/b.tsx"]);
  });

  it("is not a finding in an installed or generated folder, or when it is no code: that is what a package may ignore", async () => {
    const root = createRepository({
      ...PROJECT,
      ".gitignore": "node_modules/\ndist/\ncoverage/\nreports/\n.turbo/\n*.tsbuildinfo\n.env.local\n.DS_Store\n*.log\n",
      "packages/domain/node_modules/x/index.js": SCRIPT,
      "packages/domain/dist/index.js": SCRIPT,
      "packages/domain/coverage/lcov-report/prettify.js": SCRIPT,
      "packages/domain/reports/html/trace.js": SCRIPT,
      "packages/domain/.turbo/cache.js": SCRIPT,
      "packages/domain/tsconfig.tsbuildinfo": "{}",
      "packages/domain/.env.local": "A=1\n",
      "packages/domain/src/.DS_Store": "",
      "packages/domain/debug.log": "",
    });

    expect(listIgnoredCode(root)).toEqual([]);
    expect((await runGates({ root })).findings.filter(({ gate }) => gate === "ignored-source" || gate === "typescript-only")).toEqual([]);
  });

  it("is protected in a package the config declares, with no workspace file to say so, and in a workspace package nothing declares", () => {
    const declared = createRepository({ "architecture.config.mts": PROJECT["architecture.config.mts"], "packages/domain/src/.gitignore": "*\n", [HIDDEN]: SCRIPT });
    const undeclared = createRepository({ "pnpm-workspace.yaml": PROJECT["pnpm-workspace.yaml"], "packages/rogue/package.json": "{}", "packages/rogue/.gitignore": "*.js\n", "packages/rogue/src/x.js": SCRIPT });

    expect(listPackageFolders(declared)).toEqual(["packages/domain"]);
    expect(listIgnoredCode(declared)).toEqual([HIDDEN]);
    expect(listPackageFolders(undeclared)).toEqual(["packages/rogue"]);
    expect(listIgnoredCode(undeclared)).toEqual(["packages/rogue/src/x.js"]);
  });

  it("does not make a folder beside the packages judged: only what is in one", () => {
    const root = createRepository({ ...PROJECT, ".gitignore": "/packages-old/\n/packages/domain-old/\n", "packages-old/domain/src/x.js": SCRIPT, "packages/domain-old/src/y.js": SCRIPT });

    expect(listIgnoredCode(root)).toEqual([]);
    expect(isGitIgnored(root, "packages-old/domain/src/x.js")).toBe(true);
    // A name that only begins like a package's.
    expect(isGitIgnored(root, "packages/domain-old/src/y.js")).toBe(true);
  });
});

describe.skipIf(!HAS_GIT)("the files that are judged, for any tree", () => {
  const POOL = [
    "a.ts",
    "scripts/b.mts",
    "scratch/c.ts",
    "scratch/deep/d.ts",
    ".tool/e.ts",
    "packages/domain/src/f.ts",
    "packages/domain/src/sub/g.ts",
    "packages/domain/tests/h.ts",
    "packages/domain/local/i.ts",
    "packages/ui/src/j.tsx",
    "packages/ui/gen/k.ts",
    "packages-old/l.ts",
  ];
  const RULES: [file: string, line: string][] = [
    [".gitignore", "scratch/"],
    [".gitignore", "*.mts"],
    [".gitignore", "/packages/"],
    [".gitignore", "g.ts"],
    [".gitignore", "local"],
    [".gitignore", "!d.ts"],
    [".tool/.gitignore", "*"],
    ["scratch/.gitignore", "/deep"],
    ["packages/.gitignore", "gen/"],
    ["packages/domain/.gitignore", "/src/sub"],
    ["packages/domain/src/.gitignore", "*"],
    ["packages/ui/.gitignore", "*.tsx"],
    ["packages-old/.gitignore", "*"],
  ];

  // Thirty trees, each with its own pick of the files and of the rules. The
  // pick is made from the number, so a failure names a tree that can be made again.
  it.each(Array.from({ length: 30 }, (_, seed) => seed))("tree %i: every file git does not ignore, and every file in a package, and nothing else", (seed) => {
    const picked = <T,>(items: T[], salt: number): T[] => items.filter((_, index) => ((seed + 1) * (index + 3) * salt) % 7 < 4);
    const files = Object.fromEntries(picked(POOL, 5).map((path) => [path, SCRIPT]));
    const rules: Record<string, string> = {};

    for (const [file, line] of picked(RULES, 11)) {
      rules[file] = `${rules[file] ?? ""}${line}\n`;
    }

    const root = createRepository({
      "pnpm-workspace.yaml": PROJECT["pnpm-workspace.yaml"],
      "packages/domain/package.json": "{}",
      "packages/ui/package.json": "{}",
      ...files,
      ...rules,
    });
    const source = (path: string): boolean => /\.(ts|tsx|mts)$/.test(path);
    const notIgnored = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-per-directory=.gitignore", "-z"], { cwd: root, encoding: "utf8" })
      .stdout.split("\0")
      .filter(source);
    const inPackages = listAll(root, "").filter((path) => source(path) && /^packages\/(domain|ui)\//.test(path));
    const judged = listSourceFiles(root, "");

    expect(judged).toEqual([...new Set([...notIgnored, ...inPackages])].sort());
    // Said the other way round as well: nothing git ignores outside a package is judged.
    expect(judged.filter((path) => !notIgnored.includes(path) && !inPackages.includes(path))).toEqual([]);
  });
});

describe.skipIf(!HAS_GIT)("when git cannot say, or its answer cannot be right: every file is judged", () => {
  const FILES = { "architecture.config.mts": CONFIG, ".gitignore": "scratch/\n", "scratch/x.js": SCRIPT, "kept.js": SCRIPT };
  const judged = (root: string): string[] => listSourceFiles(root, "").filter((file) => file.endsWith(".js"));

  it("leaves the ignored file out when git answers: the cases below are told from this one", () => {
    expect(judged(createRepository(FILES))).toEqual(["kept.js"]);
  });

  it("when git is not installed", () => {
    const root = createRepository(FILES);

    vi.stubEnv("PATH", createFolder({}));

    expect(listGitIgnored(root)).toBeUndefined();
    expect(judged(root)).toEqual(["kept.js", "scratch/x.js"]);
  });

  it("when git does not answer in time", () => {
    const root = createRepository(FILES);

    vi.stubEnv("PATH", createFakeGit("sleep 5"));

    expect(askGit(root, ["ls-files"], 200)).toBeUndefined();
  });

  it.each([
    ["exits with an error after printing a list", "printf 'kept.js\\0'; exit 1"],
    // A folder that is there: the one the project is in.
    ["names a path outside the project", "printf '../\\0'"],
    ["names a path from the root of the disk", "printf '/etc/\\0'"],
    ["names a path that is not there", "printf 'packages/\\0nothing-here.js\\0'"],
  ])("when git %s", (_what, script) => {
    const root = createRepository(FILES);

    vi.stubEnv("PATH", createFakeGit(script));

    expect(listGitIgnored(root)).toBeUndefined();
    expect(gitIgnoredGlobs(root)).toEqual([]);
    expect(judged(root)).toEqual(["kept.js", "scratch/x.js"]);
  });

  it("when the repository is bare, or its .git is broken", () => {
    const bare = createFolder(FILES);
    const broken = createRepository(FILES);

    spawnSync("git", ["init", "--quiet", "--bare", ".git"], { cwd: bare });
    spawnSync("git", ["config", "--file", join(bare, ".git/config"), "core.bare", "true"]);
    writeFileSync(join(broken, ".git/HEAD"), "not a head\n");

    expect(listGitIgnored(bare)).toBeUndefined();
    expect(judged(bare)).toEqual(["kept.js", "scratch/x.js"]);
    expect(listGitIgnored(broken)).toBeUndefined();
    expect(judged(broken)).toEqual(["kept.js", "scratch/x.js"]);
  });

  it("is asked about this folder whatever GIT_* says: another repository, another index, settings handed in", () => {
    const elsewhere = createRepository({ ".gitignore": "*\n" });
    // Made before any variable is set: `git init` would follow it too.
    const root = createRepository(FILES);
    const expected = listGitIgnored(root);

    expect(expected).toEqual(["scratch/"]);

    for (const [name, value] of [
      ["GIT_DIR", join(elsewhere, ".git")],
      ["GIT_WORK_TREE", elsewhere],
      ["GIT_INDEX_FILE", join(elsewhere, "no-such-index")],
      ["GIT_DIR", "/nowhere"],
    ] as const) {
      vi.stubEnv(name, value);
      expect(listGitIgnored(root), name).toEqual(expected);
      vi.unstubAllEnvs();
    }

    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.excludesFile");
    vi.stubEnv("GIT_CONFIG_VALUE_0", join(createFolder({ rules: "kept.js\n" }), "rules"));

    expect(listGitIgnored(root, "any")).toEqual(expected);
    vi.unstubAllEnvs();

    // And a list of rules named in the person's own settings, which no variable carries.
    const home = createFolder({ ".gitconfig": "", rules: "kept.js\n" });

    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${join(home, "rules")}\n`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, "none"));

    expect(listGitIgnored(root, "any")).toEqual(expected);
  });

  it("reads a name with a newline in it as one name", () => {
    const root = createRepository({ ".gitignore": "*.tmp.ts\n", "we\nird.tmp.ts": SCRIPT, "ird.tmp.tsx": SCRIPT, "kept.ts": SCRIPT });

    expect(listGitIgnored(root)).toEqual(["we\nird.tmp.ts"]);
    expect(listSourceFiles(root, "")).toEqual(["ird.tmp.tsx", "kept.ts"]);
  });

  it("judges a package that is a link, ignored or not: git lists a link as a file", async () => {
    const root = createRepository({ ...PROJECT, ".gitignore": "/packages/domain\n", "elsewhere/domain/src/hidden.js": SCRIPT, "elsewhere/domain/package.json": "{}" });

    rmSync(join(root, "packages/domain"), { recursive: true });
    symlinkSync("../elsewhere/domain", join(root, "packages/domain"));

    // The link, with no `/` at its end; and the folder around it, which now holds nothing else.
    expect(listGitIgnored(root)).toContain("packages/domain");
    expect(isGitIgnored(root, "packages/domain")).toBe(false);
    expect(gitIgnoredGlobs(root)).toEqual([]);
    expect(listSourceFiles(root, "packages/domain/src")).toEqual([HIDDEN]);
    expect(await lint(root).isPathIgnored(join(root, HIDDEN))).toBe(false);
  });

  it("protects a package whose declared name and name on disk differ by case", () => {
    const root = createRepository({ "architecture.config.mts": 'export default { packages: { "Packages/Domain": { role: "domain" } } };\n', ".gitignore": "/packages/\n", [HIDDEN]: SCRIPT });

    expect(isGitIgnored(root, HIDDEN)).toBe(false);
    expect(listSourceFiles(root, "packages")).toEqual([HIDDEN]);
  });

  it("judges the files of a repository inside the project by the outer rules only: the inner one's are not asked", () => {
    const root = createRepository({ "architecture.config.mts": CONFIG, "vendor/tool/.gitignore": "x.js\n", "vendor/tool/x.js": SCRIPT });

    spawnSync("git", ["init", "--quiet"], { cwd: join(root, "vendor/tool") });
    spawnSync("git", ["add", ".gitignore"], { cwd: join(root, "vendor/tool") });

    // The inner repository does ignore it.
    expect(spawnSync("git", ["check-ignore", "x.js"], { cwd: join(root, "vendor/tool") }).status).toBe(0);
    expect(listSourceFiles(root, "")).toContain("vendor/tool/x.js");
  });

  it("answers for a project that is a folder of a larger repository, in paths from the project", () => {
    const repository = createRepository({ ".gitignore": "scratch/\n", "app/scratch/x.js": SCRIPT, "app/kept.js": SCRIPT, "scratch/y.js": SCRIPT });

    expect(listGitIgnored(join(repository, "app"))).toEqual(["scratch/"]);
    expect(listSourceFiles(join(repository, "app"), "")).toEqual(["kept.js"]);
  });
});

describe("a run that judged nothing", () => {
  it("fails when the project declares packages and no source file is found in any of them", async () => {
    const root = createFolder({ "architecture.config.mts": PROJECT["architecture.config.mts"], "packages/domain/package.json": PROJECT["packages/domain/package.json"] });
    const { findings } = await runGates({ root });

    expect(findings.map(({ message }) => message)).toContain(
      "The project declares 1 package(s) and no source file was found in any of them, so the gates judged nothing. That is not a pass. Check that the gates run in the project root and that the packages are there: packages/domain.",
    );
  });

  it("does not fail for that when one declared package has a source file, or when none is declared", async () => {
    const withSource = createFolder(PROJECT);
    const none = createFolder({ "architecture.config.mts": CONFIG });

    expect((await runGates({ root: withSource })).findings.filter(({ message }) => message.includes("judged nothing"))).toEqual([]);
    expect((await runGates({ root: none })).findings.filter(({ message }) => message.includes("judged nothing"))).toEqual([]);
  });
});

describe("a folder that is in no repository", () => {
  it("has nothing git ignores: git cannot say, and every file is judged", async () => {
    const root = createFolder({ "architecture.config.mts": CONFIG, ".gitignore": "scratch.js\n", "scratch.js": SCRIPT, ".remember/.gitignore": "*\n", ".remember/x.js": SCRIPT });

    expect(listGitIgnored(root)).toBeUndefined();
    expect(gitIgnoredGlobs(root)).toEqual([]);
    expect(isGitIgnored(root, "scratch.js")).toBe(false);
    expect(listIgnoredCode(root)).toEqual([]);
    expect(listSourceFiles(root, "").filter((file) => file.endsWith(".js"))).toEqual([".remember/x.js", "scratch.js"]);
    expect((await runGates({ root })).findings.filter(({ gate }) => gate === "typescript-only").map(({ file }) => file)).toEqual([".remember/x.js", "scratch.js"]);
  });

  it("is linted as before: the config is built, with the kit's own list of generated folders and nothing more", () => {
    const root = createFolder({ ".gitignore": "scratch.js\n" });

    expect(architectureLint({ packages: {} }, root)[0]?.ignores).toEqual([
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/reports/**",
      "**/.turbo/**",
      "**/__screenshots__/**",
    ]);
  });

  it("is no error when the folder does not exist", () => {
    expect(listSourceFiles(join(tmpdir(), "no-such-folder-for-the-gates"), "")).toEqual([]);
  });
});

/** The kit's lint, run in `root`, with no role declared: the rules for every file. */
function lint(root: string): ESLint {
  return new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: architectureLint({ packages: {} }, root) as Linter.Config[] });
}

/** Every file under `folder`, as paths from `root`, `.git` left out. */
function listAll(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

    return entry.isDirectory() ? (entry.name === ".git" ? [] : listAll(root, path)) : [path];
  });
}

/** A folder to put first on PATH: its `git` is a shell script that runs `script`. Nothing else is on that PATH but the shell's own tools. */
function createFakeGit(script: string): string {
  const bin = createFolder({ git: `#!/bin/sh\n${script}\n` });

  chmodSync(join(bin, "git"), 0o755);

  return `${bin}:/bin:/usr/bin`;
}

/** A fresh folder holding `files` (path → content), outside every repository. */
function createFolder(files: Record<string, string>): string {
  // The real path: git prints paths from it, and on macOS the temporary folder is behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-ignored-")));

  write(root, files);

  return root;
}

/** The same, as a git repository with nothing committed. */
function createRepository(files: Record<string, string>): string {
  const root = createFolder({});

  spawnSync("git", ["init", "--quiet"], { cwd: root });
  write(root, files);

  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
