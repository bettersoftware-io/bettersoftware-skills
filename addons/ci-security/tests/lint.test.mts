import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { installVerified } from "../files/tools/ci-security/lib/install.mts";
import type { Installed } from "../files/tools/ci-security/lib/install.mts";
import { lintWorkflows, LINTERS } from "../files/tools/ci-security/lib/lint.mts";
import type { LintOptions } from "../files/tools/ci-security/lib/lint.mts";
import { ACTIONLINT, ZIZMOR } from "../files/tools/ci-security/lib/pins.mts";
import { createFakeDownload, createFakeExtract, createFolder, TAMPERED } from "./support.mts";

describe("linting the workflows", () => {
  it("passes when both linters ran and found nothing", async () => {
    const { options, lines } = createLint();

    expect(await lintWorkflows(options)).toBe(0);
    expect(lines).toEqual([`PASS actionlint ${ACTIONLINT.version}: every workflow is valid`, `PASS zizmor ${ZIZMOR.version}: no security finding`]);
  });

  it("runs each linter in the project root, on the binary that was installed, with its own arguments", async () => {
    const { options, runs } = createLint();

    await lintWorkflows(options);

    expect(runs).toEqual([
      { binary: "/verified/actionlint", arguments: [], root: options.root },
      { binary: "/verified/zizmor", arguments: ["--no-progress", ".github/"], root: options.root },
    ]);
  });

  it("fails when actionlint reports a problem", async () => {
    const { options, lines } = createLint({ statuses: { actionlint: 1 } });

    expect(await lintWorkflows(options)).toBe(1);
    expect(lines[0]).toBe(`FAIL actionlint ${ACTIONLINT.version}: it found the problems listed above. Fix the workflow; do not silence the linter.`);
  });

  it.each([10, 11, 12, 13, 14])("fails when zizmor reports findings (its exit status %i)", async (status) => {
    const { options, lines } = createLint({ statuses: { zizmor: status } });

    expect(await lintWorkflows(options)).toBe(1);
    expect(lines[1]).toMatch(/^FAIL zizmor /);
  });

  it("says a linter could not run, and does not fail it, when the linter itself broke", async () => {
    const { options, lines } = createLint({ statuses: { actionlint: 3, zizmor: 1 } });

    expect(await lintWorkflows(options)).toBe(2);
    expect(lines).toEqual([
      `SKIP actionlint ${ACTIONLINT.version}: could not run. It stopped with exit status 3, which is an error of its own and not a finding; its message is above.`,
      `SKIP zizmor ${ZIZMOR.version}: could not run. It stopped with exit status 1, which is an error of its own and not a finding; its message is above.`,
    ]);
  });

  it("says a linter could not run when its process was killed or never started", async () => {
    const { options, lines } = createLint({ statuses: { actionlint: null } });

    expect(await lintWorkflows(options)).toBe(2);
    expect(lines[0]).toBe(`SKIP actionlint ${ACTIONLINT.version}: could not run. Its process was killed or did not start.`);
  });

  it("says a linter could not run, and runs nothing, when it could not be installed", async () => {
    const { options, lines, runs } = createLint({ install: () => Promise.resolve({ ok: false, reason: "could not download it: no network." }) });

    expect(await lintWorkflows(options)).toBe(2);
    expect(runs).toEqual([]);
    expect(lines).toEqual([
      `SKIP actionlint ${ACTIONLINT.version}: could not run. could not download it: no network.`,
      `SKIP zizmor ${ZIZMOR.version}: could not run. could not download it: no network.`,
    ]);
  });

  it("runs nothing when the download has another checksum than the pinned one", async () => {
    const cache = createFolder();
    const { options, lines, runs } = createLint({
      install: (pin) =>
        installVerified({
          pin,
          platform: "linux-x64",
          cache,
          download: createFakeDownload(TAMPERED).download,
          extract: createFakeExtract(readFileSync).extract,
        }),
    });

    expect(await lintWorkflows(options)).toBe(2);
    expect(runs).toEqual([]);
    expect(lines[0]).toContain("its checksum is wrong");
  });

  it("is a failure, not a could-not-run, when one linter found a problem and the other could not run", async () => {
    const { options } = createLint({ statuses: { actionlint: 1, zizmor: 1 } });

    expect(await lintWorkflows(options)).toBe(1);
  });

  it("is a could-not-run, not a pass, when one linter passed and the other could not run", async () => {
    const { options } = createLint({ statuses: { zizmor: 1 } });

    expect(await lintWorkflows(options)).toBe(2);
  });

  it("runs only the linter that was asked for", async () => {
    const { options, runs } = createLint({ names: ["zizmor"] });

    expect(await lintWorkflows(options)).toBe(0);
    expect(runs.map((run) => run.binary)).toEqual(["/verified/zizmor"]);
  });

  it("refuses a name that is not a linter, and installs nothing", async () => {
    const { options, lines, installs } = createLint({ names: ["actionlint", "toString"] });

    expect(await lintWorkflows(options)).toBe(2);
    expect(installs).toEqual([]);
    expect(lines).toEqual(['SKIP workflow lint: there is no linter called "toString". Choose from: actionlint, zizmor.']);
  });

  it("says there was nothing to lint, and installs nothing, when the project has no workflow", async () => {
    const { options, lines, installs } = createLint({ root: createFolder({ ".github/dependabot.yml": "version: 2\n", ".github/workflows/notes.md": "" }) });

    expect(await lintWorkflows(options)).toBe(2);
    expect(installs).toEqual([]);
    expect(lines).toEqual(["SKIP workflow lint: .github/workflows holds no .yml or .yaml file, so there was nothing to lint."]);
  });

  it("says so when shellcheck is not installed, since actionlint then leaves the shell in run: steps unchecked", async () => {
    const { options, lines } = createLint({ commands: [] });

    expect(await lintWorkflows(options)).toBe(0);
    expect(lines[0]).toBe(
      `PASS actionlint ${ACTIONLINT.version}: every workflow is valid (not checked here: the shell in run: steps, because shellcheck is not installed; CI checks it)`,
    );
  });

  it("says so when no GitHub token is set, since zizmor then runs only the checks that need no network", async () => {
    const { options, lines } = createLint({ env: {} });

    expect(await lintWorkflows(options)).toBe(0);
    expect(lines[1]).toBe(
      `PASS zizmor ${ZIZMOR.version}: no security finding (not checked here: what must be asked of GitHub, such as an action with a known advisory, because GH_TOKEN is not set; CI checks it)`,
    );
  });

  it.each(["GH_TOKEN", "GITHUB_TOKEN", "ZIZMOR_GITHUB_TOKEN"])("takes %s as the token zizmor reads", async (name) => {
    const { options, lines } = createLint({ env: { [name]: "a-token" } });

    await lintWorkflows(options);

    expect(lines[1]).toBe(`PASS zizmor ${ZIZMOR.version}: no security finding`);
  });

  it("keeps the note on a failure too, so a clean shell is not read into it", async () => {
    const { options, lines } = createLint({ statuses: { actionlint: 1 }, commands: [] });

    await lintWorkflows(options);

    expect(lines[0]).toContain("FAIL actionlint");
    expect(lines[0]).toContain("because shellcheck is not installed");
  });
});

describe("the linters", () => {
  it("are actionlint, then zizmor: validity before safety", () => {
    expect(Object.keys(LINTERS)).toEqual(["actionlint", "zizmor"]);
    expect([LINTERS.actionlint?.pin, LINTERS.zizmor?.pin]).toEqual([ACTIONLINT, ZIZMOR]);
  });
});

interface LintShape {
  root?: string;
  names?: string[];
  /** The exit status each linter ends with. Left out: 0. */
  statuses?: Record<string, number | null>;
  install?: LintOptions["install"];
  /** A token is set unless this says otherwise. */
  env?: Record<string, string>;
  /** The commands found on the PATH. shellcheck is there unless this says otherwise. */
  commands?: string[];
}

interface Lint {
  options: LintOptions;
  lines: string[];
  runs: { binary: string; arguments: string[]; root: string }[];
  /** The name of every linter an install was asked for. */
  installs: string[];
}

/** A project with one workflow, both linters installable, and every run recorded. */
function createLint(shape: LintShape = {}): Lint {
  const lines: string[] = [];
  const runs: Lint["runs"] = [];
  const installs: string[] = [];
  const install = shape.install ?? ((pin): Promise<Installed> => Promise.resolve({ ok: true, binary: `/verified/${pin.name}` }));

  return {
    lines,
    runs,
    installs,
    options: {
      root: shape.root ?? createFolder({ ".github/workflows/ci.yml": "name: CI\n" }),
      names: shape.names ?? [],
      install: (pin) => {
        installs.push(pin.name);

        return install(pin);
      },
      run: (binary, runArguments, root) => {
        runs.push({ binary, arguments: runArguments, root });

        const name = binary.slice(binary.lastIndexOf("/") + 1);

        return shape.statuses !== undefined && name in shape.statuses ? (shape.statuses[name] as number | null) : 0;
      },
      env: shape.env ?? { GH_TOKEN: "a-token" },
      hasCommand: (name) => (shape.commands ?? ["shellcheck"]).includes(name),
      report: (line) => lines.push(line),
    },
  };
}
