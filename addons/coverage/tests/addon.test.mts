import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPORTS_DIRECTORY } from "../files/tools/coverage/lib/measure.mts";
import { REPORT_DIRECTORY, TEST_REPORT_DIRECTORY } from "../files/tools/coverage/lib/site.mts";
import { createFolder, git } from "./support.mts";

const ADDON = join(import.meta.dirname, "..");
const STARTER = join(ADDON, "..", "..", "starter");
const WORKFLOW = readFileSync(join(ADDON, "files/.github/workflows/coverage.yml"), "utf8");

describe("the add-on in a project created from the starter", () => {
  it("has its tools tracked by git, although the starter ignores every folder called coverage", () => {
    const project = createProject();

    expect(isIgnored(project, "tools/coverage/run.mts")).toBe(false);
    expect(isIgnored(project, "tools/coverage/lib/config.mts")).toBe(false);
  });

  it("writes its reports only where the starter's .gitignore already covers them", () => {
    const project = createProject();

    expect(isIgnored(project, `packages/domain/${REPORTS_DIRECTORY}/index.html`)).toBe(true);
    expect(isIgnored(project, `${REPORT_DIRECTORY}/index.html`)).toBe(true);
    expect(isIgnored(project, `${TEST_REPORT_DIRECTORY}/packages/domain.json`)).toBe(true);
  });

  it("adds only scripts that run a tool it ships", () => {
    const { packageJson } = JSON.parse(readFileSync(join(ADDON, "addon.json"), "utf8")) as {
      packageJson: Record<string, { scripts?: Record<string, string> }>;
    };
    const tools = Object.values(packageJson["."]?.scripts ?? {}).map((script) => /^node (tools\/coverage\/[\w-]+\.mts)$/.exec(script)?.[1]);

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool !== undefined && existsSync(join(ADDON, "files", tool)))).toEqual([true, true, true]);
  });
});

describe("the workflow", () => {
  it("pins every action to a full commit hash, with the version beside it", () => {
    const uses = WORKFLOW.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));

    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((line) => !/uses: [\w-]+\/[\w-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/.test(line))).toEqual([]);
  });

  it("uploads and publishes the folders the tools write", () => {
    expect(WORKFLOW).toContain(`path: ${REPORT_DIRECTORY}/\n`);
    expect(WORKFLOW).toContain(`path: ${TEST_REPORT_DIRECTORY}/\n`);
    expect(WORKFLOW).toContain(`[ -f ${REPORT_DIRECTORY}/index.html ]`);
  });

  it("runs the gate with the script the add-on adds, and publishes with the tool it ships", () => {
    expect(WORKFLOW).toContain("run: pnpm coverage\n");
    expect(existsSync(join(ADDON, "files/tools/coverage/publish-to-pages.mts"))).toBe(true);
    expect(WORKFLOW).toContain("run: node tools/coverage/publish-to-pages.mts --source _pages ");
  });

  it("gives write access to the repository to the publish job only", () => {
    const [beforeJobs = "", jobs = ""] = WORKFLOW.split("\njobs:\n");
    const [coverageJob = "", publishJob = ""] = jobs.split("\n  publish:\n");

    expect(beforeJobs).toContain("\npermissions:\n  contents: read\n");
    expect(coverageJob).not.toContain("permissions:");
    expect(publishJob).toContain("    permissions:\n      contents: write\n");
    expect(WORKFLOW.match(/: write/g)).toHaveLength(1);
  });

  it("keeps the token out of the job that installs dependencies and runs the tests", () => {
    const [coverageJob = "", publishJob = ""] = WORKFLOW.split("\n  publish:\n");

    expect(coverageJob).toContain("persist-credentials: false");
    expect(coverageJob).not.toContain("persist-credentials: true");
    expect(publishJob).not.toContain("pnpm install");
  });
});

/** A git checkout with the starter's own .gitignore and the add-on's files beside it. */
function createProject(): string {
  const project = createFolder({
    ".gitignore": readFileSync(join(STARTER, ".gitignore"), "utf8"),
    "tools/.gitignore": readFileSync(join(ADDON, "files/tools/.gitignore"), "utf8"),
  });

  git(project, "init", "--quiet");

  return project;
}

function isIgnored(project: string, path: string): boolean {
  return spawnSync("git", ["check-ignore", "--quiet", path], { cwd: project }).status === 0;
}
