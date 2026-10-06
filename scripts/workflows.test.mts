import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = 26;

// pnpm as a command: after `run: `, at the start of a line of a longer script,
// or inside `$( … )`. Not the word in a step's name.
const PNPM_COMMAND = /(?:run: |\$\(|^\s+)pnpm [a-z-]/m;

// Every workflow this repository runs or ships: its own, the starter's, and
// each add-on's. In a project the kit is `tools/arch`; here it is `kit`.
const WORKFLOWS = [
  ...workflowsIn(".github/workflows", "kit"),
  ...workflowsIn("starter/.github/workflows", "tools/arch"),
  ...readdirSync(join(REPOSITORY, "addons")).flatMap((addon) =>
    workflowsIn(`addons/${addon}/files/.github/workflows`, "tools/arch"),
  ),
];

describe("the workflows this repository runs and ships", () => {
  it("are found", () => {
    expect(WORKFLOWS.length).toBeGreaterThanOrEqual(9);
    expect(WORKFLOWS.map(({ file }) => file)).toContain("starter/.github/workflows/ci.yml");
  });

  it.each(WORKFLOWS)("$file sets up the Node the package.json files ask for", ({ text }) => {
    const versions = [...text.matchAll(/node-version: (.+)\n/g)].map((match) => match[1]);

    expect(new Set(versions).size).toBeLessThanOrEqual(1);
    expect(versions.every((version) => version === String(NODE))).toBe(true);
  });

  it.each(WORKFLOWS)("$file gets pnpm from the pinned Corepack, never from the one Node no longer ships", ({ text, kit }) => {
    const usesPnpm = PNPM_COMMAND.test(withoutComments(text));
    const enabled = text.split(`run: node ${kit}/ci/enable-corepack.mts\n`).length - 1;
    const jobsWithPnpm = jobsOf(text).filter((job) => PNPM_COMMAND.test(withoutComments(job)));

    expect(text).not.toMatch(/run: corepack enable|npm install -g|npm i -g/);
    expect(enabled).toBe(jobsWithPnpm.length);
    expect(existsSync(join(REPOSITORY, "kit/ci/enable-corepack.mts"))).toBe(true);

    if (usesPnpm) {
      expect(text).toMatch(/\nenv:\n(?: {2}.*\n)*? {2}COREPACK_ENABLE_DOWNLOAD_PROMPT: "0"\n/);
    }
  });

  it.each(WORKFLOWS)("$file enables Corepack after the checkout that brings the script, and before pnpm is used", ({ text, kit }) => {
    for (const job of jobsOf(text)) {
      const enable = job.indexOf(`${kit}/ci/enable-corepack.mts`);

      if (enable === -1) {
        continue;
      }

      const firstPnpm = withoutComments(job).search(PNPM_COMMAND);

      expect(job.indexOf("actions/checkout@")).toBeGreaterThan(-1);
      expect(job.indexOf("actions/checkout@")).toBeLessThan(enable);
      expect(job.indexOf("actions/setup-node@")).toBeLessThan(enable);
      expect(enable).toBeLessThan(firstPnpm);
    }
  });

  it("the Node they set up is the floor both package.json files declare, and the starter's .nvmrc", () => {
    for (const manifest of ["package.json", "starter/package.json"]) {
      const { devEngines, engines } = JSON.parse(readFileSync(join(REPOSITORY, manifest), "utf8")) as Manifest;

      expect(engines).toBeUndefined();
      expect(devEngines?.runtime).toEqual({ name: "node", version: `>=${NODE}`, onFail: "error" });
    }

    expect(readFileSync(join(REPOSITORY, "starter/.nvmrc"), "utf8")).toBe(`${NODE}\n`);
  });
});

interface Manifest {
  engines?: unknown;
  devEngines?: { runtime?: unknown };
}

interface Workflow {
  file: string;
  text: string;
  /** Where the kit is, from the root of the repository the workflow runs in. */
  kit: string;
}

function workflowsIn(folder: string, kit: string): Workflow[] {
  const directory = join(REPOSITORY, folder);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ file: `${folder}/${name}`, text: readFileSync(join(directory, name), "utf8"), kit }));
}

/** The text of each job: from a line indented by two spaces that ends in a colon, to the next one. */
function jobsOf(text: string): string[] {
  const jobs = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);

  return jobs.split(/\n(?= {2}[\w-]+:\n)/).filter((job) => /^ {2}[\w-]+:\n/.test(job));
}

/** Comments blanked, with every other character where it was. */
function withoutComments(text: string): string {
  return text.replace(/#.*$/gm, (comment) => " ".repeat(comment.length));
}
