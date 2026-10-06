import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LINTERS } from "../files/tools/ci-security/lib/lint.mts";
import { ADDON, createFolder } from "./support.mts";

const STARTER = join(ADDON, "..", "..", "starter");
const WORKFLOWS = join(ADDON, "files/.github/workflows");
const NAMES = readdirSync(WORKFLOWS).sort();
const SECURITY = readWorkflow("ci-security.yml");
const DEPENDENCY_REVIEW = readWorkflow("dependency-review.yml");
const SCORECARD = readWorkflow("scorecard.yml");
const ALL = NAMES.map((name) => ({ name, text: readWorkflow(name) }));
const MANIFEST = JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as {
  packageJson: Record<string, { scripts?: Record<string, string>; devDependencies?: Record<string, string> }>;
  gates: { fast: string[]; full: string[] };
  startingFiles: string[];
  verify: string;
};

describe("the add-on in a project created from the starter", () => {
  it("adds one script, which runs a tool it ships, and proves itself with that script", () => {
    const scripts = MANIFEST.packageJson["."]?.scripts ?? {};
    const tool = /^node (tools\/ci-security\/[\w-]+\.mts)$/.exec(scripts["lint:workflows"] ?? "")?.[1];

    expect(Object.keys(scripts)).toEqual(["lint:workflows"]);
    expect(tool !== undefined && existsSync(join(ADDON, "files", tool))).toBe(true);
    expect(MANIFEST.verify).toBe("pnpm lint:workflows");
  });

  it("joins no gate, because every check it has needs the network", () => {
    expect(MANIFEST.gates).toEqual({ fast: [], full: [] });
  });

  it("installs no package", () => {
    expect(Object.values(MANIFEST.packageJson).filter((patch) => patch.devDependencies !== undefined)).toEqual([]);
  });

  it("keeps what it downloads where the starter's .gitignore already covers it", () => {
    const project = createFolder({ ".gitignore": readFileSync(join(STARTER, ".gitignore"), "utf8") });
    const tool = readFileSync(join(ADDON, "files/tools/ci-security/lint-workflows.mts"), "utf8");

    spawnSync("git", ["init", "--quiet"], { cwd: project });

    expect(tool).toContain('cache: join(root, "node_modules", ".cache", "ci-security")');
    expect(isIgnored(project, "node_modules/.cache/ci-security/zizmor-1.0.0-linux-x64/zizmor")).toBe(true);
    expect(isIgnored(project, "tools/ci-security/lint-workflows.mts")).toBe(false);
  });

  it("ships no JavaScript file", () => {
    const files = readdirSync(join(ADDON, "files"), { recursive: true, encoding: "utf8" });

    expect(files.filter((file) => /\.(js|mjs|cjs|jsx)$/.test(file))).toEqual([]);
    expect(files.filter((file) => file.endsWith(".mts")).length).toBeGreaterThan(0);
  });

  it("leaves the Dependabot config to the project once it is written", () => {
    expect(MANIFEST.startingFiles).toEqual([".github/dependabot.yml"]);
    expect(existsSync(join(ADDON, "files/.github/dependabot.yml"))).toBe(true);
  });
});

describe("the workflows", () => {
  it("are the three the README describes", () => {
    expect(NAMES).toEqual(["ci-security.yml", "dependency-review.yml", "scorecard.yml"]);
  });

  it.each(ALL)("$name pins every action to a full commit hash, with the version beside it", ({ text }) => {
    const uses = text.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((line) => !/uses: [\w-]+\/[\w-]+(\/[\w-]+)*@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/.test(line))).toEqual([]);
  });

  it.each(ALL)("$name gives the whole workflow read access to the contents and nothing else", ({ text }) => {
    const [beforeJobs = ""] = text.split("\njobs:\n");

    expect(beforeJobs).toMatch(/\npermissions:\n  contents: read\n(\n|$)/);
  });

  it("gives write access in one place only: the Scorecard job's upload to code scanning", () => {
    expect(writesIn(SECURITY)).toEqual([]);
    expect(writesIn(DEPENDENCY_REVIEW)).toEqual([]);
    expect(writesIn(SCORECARD)).toEqual(["security-events: write"]);
    expect(SCORECARD).toContain("    permissions:\n      contents: read\n      security-events: write # to upload");
    expect(SECURITY.split("\njobs:\n")[1]).not.toContain("permissions:");
    expect(DEPENDENCY_REVIEW.split("\njobs:\n")[1]).not.toContain("permissions:");
  });

  it.each(ALL)("$name never leaves the token in a checkout's git config", ({ text }) => {
    const checkouts = text.split("\n").filter((line) => line.includes("uses: actions/checkout@")).length;

    expect(text.match(/persist-credentials: false/g) ?? []).toHaveLength(checkouts);
    expect(text).not.toContain("persist-credentials: true");
  });

  it.each(ALL)("$name is never started by an event that runs a fork's code with the repository's secrets", ({ text }) => {
    expect(text).not.toMatch(/pull_request_target|workflow_run/);
  });

  it.each(ALL)("$name names no secret", ({ text }) => {
    expect(text).not.toContain("secrets.");
  });

  it("uses an expression for the token and to name what a newer run cancels, and never in a shell command", () => {
    const expressions = ALL.flatMap(({ text }) => text.split("\n").filter((line) => line.includes("${{"))).map((line) => line.trim());

    expect(expressions).toEqual([
      "group: ci-security-${{ github.ref }}",
      "GH_TOKEN: ${{ github.token }}",
      "group: dependency-review-${{ github.ref }}",
    ]);
  });

  it.each(ALL)("$name lets a newer run cancel the one in flight", ({ text }) => {
    const [beforeJobs = ""] = text.split("\njobs:\n");

    expect(beforeJobs).toMatch(/\nconcurrency:\n  group: .+\n  cancel-in-progress: true\n/);
  });

  it("installs no dependency in any job, so no package's code runs in CI because of this add-on", () => {
    for (const { text } of ALL) {
      expect(text).not.toMatch(/pnpm (install|i|add|dlx|exec)\b|npm (install|i|ci|exec)\b|npx /);
    }
  });

  it("gives the token to one step only, the zizmor run, in the job that lints", () => {
    const [lintJob = "", auditJob = ""] = SECURITY.split("\n  audit:\n");

    expect(SECURITY.match(/github\.token|GITHUB_TOKEN|GH_TOKEN/g)).toEqual(["GH_TOKEN", "github.token"]);
    expect(lintJob).toContain(
      "      - name: Workflow security lint (zizmor)\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: node tools/ci-security/lint-workflows.mts zizmor\n",
    );
    expect(auditJob).not.toMatch(/token/i);
    expect(DEPENDENCY_REVIEW).not.toMatch(/github\.token|GH_TOKEN|GITHUB_TOKEN/);
    expect(SCORECARD).not.toMatch(/github\.token|GH_TOKEN|GITHUB_TOKEN|repo_token/);
  });

  it("lints with the tool the add-on ships, one linter to a step, each a linter the tool knows", () => {
    const linted = [...SECURITY.matchAll(/run: node (tools\/ci-security\/[\w-]+\.mts) (\w+)\n/g)].map((match) => ({ tool: match[1], linter: match[2] }));

    expect(linted).toEqual([
      { tool: "tools/ci-security/lint-workflows.mts", linter: "actionlint" },
      { tool: "tools/ci-security/lint-workflows.mts", linter: "zizmor" },
    ]);
    expect(linted.map(({ linter }) => linter)).toEqual(Object.keys(LINTERS));
    expect(existsSync(join(ADDON, "files/tools/ci-security/lint-workflows.mts"))).toBe(true);
  });

  it("audits the production dependencies with pnpm, straight from the lockfile", () => {
    const [, auditJob = ""] = SECURITY.split("\n  audit:\n");

    expect(auditJob).toContain("        run: node tools/arch/ci/enable-corepack.mts\n");
    expect(auditJob).toContain("        run: pnpm audit --prod\n");
  });

  it("runs the lint and the audit on pull requests, on main and every week", () => {
    expect(SECURITY).toMatch(/\non:\n  pull_request:\n  push:\n    branches: \[main\]\n  schedule:\n    - cron: "\d+ \d+ \* \* \d"\n/);
  });

  it("reviews dependencies on pull requests only, in both scopes, at any severity", () => {
    expect(DEPENDENCY_REVIEW).toContain("\non:\n  pull_request:\n\n");
    expect(DEPENDENCY_REVIEW).toContain("          fail-on-severity: low\n");
    expect(DEPENDENCY_REVIEW).toContain("          fail-on-scopes: runtime, development, unknown\n");
    expect(DEPENDENCY_REVIEW).not.toContain("actions/checkout");
  });

  it("refuses strong-copyleft licences by name, and keeps no list of allowed ones", () => {
    const denied = /deny-licenses: >-\n((?: {12}.+\n?)+)/.exec(DEPENDENCY_REVIEW)?.[1] ?? "";

    expect(denied.split(/[\s,]+/).filter(Boolean)).toEqual([
      "AGPL-1.0-only",
      "AGPL-1.0-or-later",
      "AGPL-3.0-only",
      "AGPL-3.0-or-later",
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
      "SSPL-1.0",
    ]);
    expect(DEPENDENCY_REVIEW).not.toContain("allow-licenses");
  });

  it("keeps the Scorecard findings in the repository, and gates no pull request with them", () => {
    expect(SCORECARD).toContain("          publish_results: false\n");
    expect(SCORECARD).not.toMatch(/^\s*id-token:/m);
    expect(SCORECARD).not.toMatch(/\n  pull_request:/);
    expect(SCORECARD).toMatch(/\n  schedule:\n    - cron: "\d+ \d+ \* \* \d"\n/);
  });
});

describe("the Dependabot config", () => {
  const config = readFileSync(join(ADDON, "files/.github/dependabot.yml"), "utf8");
  const entries = config.split(/\n  - package-ecosystem: /).slice(1);

  it("covers the packages and the actions", () => {
    expect(entries.map((entry) => entry.split("\n")[0])).toEqual(['"npm"', '"github-actions"']);
  });

  it("waits a week before it takes a release, in both", () => {
    expect(entries.map((entry) => /\n    cooldown:\n      default-days: (\d+)\n/.exec(entry)?.[1])).toEqual(["7", "7"]);
  });

  it("looks once a week, at the root, in both", () => {
    expect(entries.map((entry) => entry.includes('\n    directory: "/"\n    schedule:\n      interval: "weekly"\n'))).toEqual([true, true]);
  });
});

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOWS, name), "utf8");
}

/** Every permission a workflow grants above read, as it is written. Comments are not grants. */
function writesIn(workflow: string): string[] {
  return workflow
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => /^[\w-]+: write(-all)?$/.test(line));
}

function isIgnored(project: string, path: string): boolean {
  return spawnSync("git", ["check-ignore", "--quiet", path], { cwd: project }).status === 0;
}
