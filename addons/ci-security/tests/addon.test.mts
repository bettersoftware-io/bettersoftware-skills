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
  choice: { default: string; options: Record<string, string> };
  verify: string;
};
const DEPENDABOT = "choice/dependabot/files/.github/dependabot.yml";
const RENOVATE = "choice/renovate/files/.github/renovate.json5";

describe("the add-on in a project created from the starter", () => {
  it("adds two scripts, each of which runs a tool it ships, and proves itself with the workflow lint", () => {
    const scripts = MANIFEST.packageJson["."]?.scripts ?? {};
    const tools = Object.values(scripts).map((script) => /^node (tools\/ci-security\/[\w-]+\.mts)$/.exec(script)?.[1]);

    expect(Object.keys(scripts)).toEqual(["lint:workflows", "check:dockerfiles"]);
    expect(tools.map((tool) => tool !== undefined && existsSync(join(ADDON, "files", tool)))).toEqual([true, true]);
    expect(MANIFEST.verify).toBe("pnpm lint:workflows");
  });

  it("joins gate:fast with the one check that needs no network, and with no check that needs it", () => {
    expect(MANIFEST.gates).toEqual({ fast: ["pnpm check:dockerfiles"], full: [] });
    expect(readFileSync(join(ADDON, "files/tools/ci-security/check-dockerfiles.mts"), "utf8")).not.toMatch(/\bfetch\(|node:https?|createDownload|child_process/);
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

  it("leaves the security policy to the project once it is written", () => {
    expect(MANIFEST.startingFiles).toEqual(["SECURITY.md"]);
    expect(existsSync(join(ADDON, "files/SECURITY.md"))).toBe(true);
  });

  it("offers one update bot or the other, Dependabot when none is named, each as one file of its own", () => {
    expect(MANIFEST.choice.default).toBe("dependabot");
    expect(Object.keys(MANIFEST.choice.options)).toEqual(["dependabot", "renovate"]);
    expect(listUnder("choice")).toEqual([DEPENDABOT, RENOVATE]);
    expect(listUnder("files").filter((file) => /dependabot|renovate/i.test(file))).toEqual([]);
  });

  it("says in the list of options that Renovate needs a person to install its app", () => {
    expect(MANIFEST.choice.options.renovate).toContain("A person installs its GitHub App on the repository first");
  });
});

describe("the security policy", () => {
  const policy = readFileSync(join(ADDON, "files/SECURITY.md"), "utf8");
  /** What a reader sees: the note to the maintainers is a comment. */
  const shown = policy.replace(/<!--[\s\S]*?-->/g, "");

  it("is where GitHub and Scorecard look for it: SECURITY.md at the root", () => {
    expect(listUnder("files").filter((file) => /security/i.test(file) && file.endsWith(".md"))).toEqual(["files/SECURITY.md"]);
  });

  it("has what Scorecard scores: a link, text of its own, and a disclosure time in days", () => {
    const links = shown.match(/https?:\/\/[^\s)]+/g) ?? [];

    expect(links.length).toBeGreaterThan(0);
    expect(shown.replace(/https?:\/\/[^\s)]+/g, "").length).toBeGreaterThan(500);
    expect(shown).toMatch(/vulnerab/i);
    expect(shown).toMatch(/disclos/i);
    expect(shown).toMatch(/\b\d{1,3} days\b/);
  });

  it("says how to report in private, what is in scope and what is not", () => {
    expect(shown).toContain("## Reporting a vulnerability");
    expect(shown).toContain("open **Security**,\nthen **Report a vulnerability**");
    expect(shown).toContain("Do not open a public issue or pull request");
    expect(shown).toContain("\n## In scope\n");
    expect(shown).toContain("\n## Out of scope\n");
  });

  it("names the project's packages by the scope the installer rewrites, and names no other project", () => {
    expect(policy).toContain("`@app/*`");
    expect(policy).not.toMatch(/(?<!docs\.)github\.com\/[\w-]+\/[\w-]+/);
  });

  it("links to nothing in the repository, so the project's link check has nothing of it to resolve", () => {
    const targets = [...shown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? "");

    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !target.startsWith("https://"))).toEqual([]);
  });

  it("tells the maintainers what is theirs to change, where a reader of the page does not see it", () => {
    const note = /<!--([\s\S]*?)-->/.exec(policy)?.[1] ?? "";

    expect(note).toContain("Switch on private vulnerability reporting");
    expect(note).toContain("times you will keep");
    expect(shown).not.toContain("For the maintainers");
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
  const config = readFileSync(join(ADDON, DEPENDABOT), "utf8");
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

describe("the Renovate config", () => {
  const text = readFileSync(join(ADDON, RENOVATE), "utf8");
  const config = parseCommented(text) as {
    extends: string[];
    minimumReleaseAge: string;
    internalChecksFilter: string;
    schedule: string[];
    prConcurrentLimit: number;
    vulnerabilityAlerts: { enabled: boolean };
    ignorePaths: string[];
    packageRules: Record<string, unknown>[];
    automerge?: boolean;
  };
  const dependabot = readFileSync(join(ADDON, DEPENDABOT), "utf8");

  it("is where Renovate looks for it, in a form with comments", () => {
    expect(RENOVATE.endsWith("/.github/renovate.json5")).toBe(true);
    expect(text.startsWith("// Renovate:")).toBe(true);
  });

  it("pins every action by its commit, as the workflows are written", () => {
    expect(config.extends).toEqual(["config:recommended", "helpers:pinGitHubActionDigests"]);
  });

  it("waits as long as Dependabot does before it takes a release, and holds the pull request back until then", () => {
    const days = /default-days: (\d+)/.exec(dependabot)?.[1];

    expect(config.minimumReleaseAge).toBe(`${days} days`);
    expect(config.internalChecksFilter).toBe("strict");
  });

  it("never waits less than pnpm itself does, or its pull request could not update the lockfile", () => {
    const minutes = Number(/^minimumReleaseAge: (\d+)$/m.exec(readFileSync(join(STARTER, "pnpm-workspace.yaml"), "utf8"))?.[1]);

    expect(minutes).toBeGreaterThan(0);
    expect(Number.parseInt(config.minimumReleaseAge, 10) * 24 * 60).toBeGreaterThanOrEqual(minutes);
  });

  it("looks once a week, and keeps as many pull requests open as Dependabot does", () => {
    expect(config.schedule).toEqual(["before 6am on monday"]);
    expect(config.prConcurrentLimit).toBe(Number(/open-pull-requests-limit: (\d+)/.exec(dependabot)?.[1]));
  });

  it("groups as Dependabot does: minor and patch together, the actions together, the actions rule last so it wins", () => {
    const groups = config.packageRules.filter((rule) => rule.groupName !== undefined);

    expect(groups).toEqual([
      { groupName: "minor and patch", matchUpdateTypes: ["minor", "patch"] },
      { groupName: "actions", matchManagers: ["github-actions"] },
    ]);
    expect(dependabot).toContain('update-types: ["minor", "patch"]');
    expect(dependabot).toContain('      actions:\n        patterns: ["*"]');
  });

  it("leaves security fixes to Dependabot's repository setting, so that none arrives twice", () => {
    expect(config.vulnerabilityAlerts).toEqual({ enabled: false });
  });

  it("moves nothing in pnpm-workspace.yaml and nothing the add-ons installed", () => {
    expect(config.packageRules).toContainEqual({ matchFileNames: ["pnpm-workspace.yaml"], enabled: false });
    expect(config.ignorePaths).toEqual(["**/node_modules/**", "tools/**"]);
  });

  it("merges nothing by itself", () => {
    expect(text).not.toMatch(/automerge/i);
  });

  it("says at the top that nothing happens until a person installs the app", () => {
    const [head = ""] = text.split("\n{\n");

    expect(head).toContain("It does nothing until the Renovate GitHub App is installed");
    expect(head).toContain("https://github.com/apps/renovate");
    expect(head).toContain("A person does that");
  });
});

/** JSON with whole-line `//` comments, which is all of JSON5 these files use. */
function parseCommented(text: string): unknown {
  return JSON.parse(
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
}

/** Every file under a folder of the add-on, as sorted paths from the add-on. */
function listUnder(folder: string): string[] {
  return readdirSync(join(ADDON, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(ADDON.length + 1))
    .sort();
}

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
