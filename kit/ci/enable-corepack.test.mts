import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Command, type CommandResult, CorepackError, enableCorepack } from "./enable-corepack.mts";

const PINNED = join(import.meta.dirname, "corepack");

interface Lockfile {
  packages: Record<string, { version?: string; integrity?: string; dependencies?: Record<string, string> }>;
}

describe("enabling Corepack in CI", () => {
  it("installs from the lockfile, with no install script, in a folder of its own", () => {
    const home = createFolder();
    const { commands, run } = createRecorder();

    enableCorepack({ home, env: {}, run });

    expect(commands[0]).toEqual({
      command: "npm",
      args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      cwd: join(home, "pkg"),
    });
    expect(readFileSync(join(home, "pkg/package-lock.json"), "utf8")).toBe(
      readFileSync(join(PINNED, "package-lock.json"), "utf8"),
    );
    expect(readFileSync(join(home, "pkg/package.json"), "utf8")).toBe(readFileSync(join(PINNED, "package.json"), "utf8"));
  });

  it("enables the Corepack it installed, with the shims in the folder it returns", () => {
    const home = createFolder();
    const { commands, run } = createRecorder();

    const { bin } = enableCorepack({ home, env: {}, run });

    expect(bin).toBe(join(home, "bin"));
    expect(existsSync(bin)).toBe(true);
    expect(commands[1]).toEqual({
      command: join(home, "pkg/node_modules/.bin/corepack"),
      args: ["enable", "--install-directory", bin],
    });
    expect(commands).toHaveLength(2);
  });

  it("puts the shims on the path of the later steps in GitHub Actions, in the runner's temporary folder", () => {
    const runnerTemp = createFolder();
    const githubPath = join(createFolder(), "path");

    writeFileSync(githubPath, "/already/there\n");

    const { bin } = enableCorepack({ env: { RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath }, run: createRecorder().run });

    expect(bin).toBe(join(runnerTemp, "corepack/bin"));
    expect(readFileSync(githubPath, "utf8")).toBe(`/already/there\n${bin}\n`);
  });

  it("refuses when it has no folder to install into", () => {
    const { commands, run } = createRecorder();

    expect(() => enableCorepack({ env: {}, run })).toThrow(CorepackError);
    expect(() => enableCorepack({ env: {}, run })).toThrow(/RUNNER_TEMP/);
    expect(commands).toEqual([]);
  });

  it("stops at a step that fails, says which and why, and leaves the path alone", () => {
    const githubPath = join(createFolder(), "path");
    const { commands, run } = createRecorder({ npm: { status: 1, output: "npm error EINTEGRITY sha512 mismatch\n" } });

    writeFileSync(githubPath, "");

    expect(() => enableCorepack({ home: createFolder(), env: { GITHUB_PATH: githubPath }, run })).toThrow(
      /npm ci failed \(exit 1\), so pnpm was not provided\.\nnpm error EINTEGRITY sha512 mismatch$/,
    );
    expect(commands).toHaveLength(1);
    expect(readFileSync(githubPath, "utf8")).toBe("");
  });

  it("fails when Corepack itself cannot be enabled", () => {
    const { run } = createRecorder({ corepack: { status: null, output: "spawn ENOENT" } });

    expect(() => enableCorepack({ home: createFolder(), env: {}, run })).toThrow(/corepack enable failed \(exit none\)/);
  });

  it("pins one exact version of Corepack, with a sha512 hash and nothing else to install", () => {
    const { dependencies } = JSON.parse(readFileSync(join(PINNED, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const { packages } = JSON.parse(readFileSync(join(PINNED, "package-lock.json"), "utf8")) as Lockfile;

    expect(Object.keys(dependencies)).toEqual(["corepack"]);
    expect(dependencies.corepack).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(packages)).toEqual(["", "node_modules/corepack"]);
    expect(packages[""]?.dependencies).toEqual(dependencies);
    expect(packages["node_modules/corepack"]?.version).toBe(dependencies.corepack);
    expect(packages["node_modules/corepack"]?.integrity).toMatch(/^sha512-/);
  });
});

interface Recorder {
  commands: Command[];
  run: (command: Command) => CommandResult;
}

/** Records each command instead of running it. A result given by name (`npm`, `corepack`) replaces success. */
function createRecorder(results: Record<string, CommandResult> = {}): Recorder {
  const commands: Command[] = [];

  return {
    commands,
    run: (command: Command): CommandResult => {
      commands.push(command);

      const name = Object.keys(results).find((key) => command.command.endsWith(key));

      return name === undefined ? { status: 0, output: "" } : (results[name] as CommandResult);
    },
  };
}

function createFolder(): string {
  return mkdtempSync(join(tmpdir(), "corepack-"));
}
