import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "check-react-policies.mts");
const fixtures = join(import.meta.dirname, "gates", "fixtures");

describe("a project whose React packages are all under their rules", () => {
  it("passes, and says how many packages it judged", () => {
    const run = runIn("react-clean");

    expect(run.stdout).toBe("PASS react-policies — 5 package(s) import React, each under the rules its role asks for\n");
    expect(run.status).toBe(0);
  });
});

describe("a project whose React packages are not", () => {
  let findings: string[] = [];
  let status: number | null = null;

  const about = (path: string): string[] => findings.filter((finding) => finding.startsWith(`${path} `));

  // Judged once, before any case, so that one case can be run alone.
  beforeAll(() => {
    const run = runIn("react-broken");

    status = run.status;
    findings = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim());
  });

  it("fails, with one line for each finding", () => {
    expect(status).toBe(1);
    expect(findings).toHaveLength(12);
  });

  it("names a client that bans memoization while its build compiles nothing, and is not fooled by a comment or an import", () => {
    expect(about("packages/client-react")).toEqual([
      expect.stringContaining("declares reactCompiler: true, so manual memoization is banned there, but its vite.config.ts does not run the React Compiler"),
    ]);
    expect(about("packages/client-bare")).toEqual([expect.stringContaining("but it has no vite.config.ts")]);
  });

  it("names a client that runs the compiler and does not declare it", () => {
    expect(about("packages/client-quiet")).toEqual([
      expect.stringContaining("runs the React Compiler in its vite.config.ts and does not declare it"),
    ]);
    expect(about("packages/client-quiet")[0]).toContain("Add reactCompiler: true");
  });

  it("names a package that imports React with a role that gets no React rule, declared or not", () => {
    expect(about("packages/ui-kit")).toEqual([expect.stringContaining('imports React (packages/ui-kit/src/Button.tsx) and has the role "leaf"')]);
    expect(about("packages/stray")).toEqual([expect.stringContaining("imports React (packages/stray/src/Stray.tsx) and has no declared role")]);
  });

  it("leaves a package alone that is listed with the reason, and names a listed one that does not import React", () => {
    expect(about("packages/icons")).toEqual([]);
    expect(about("packages/domain")).toEqual([expect.stringContaining("is listed under reactWithoutPolicies and does not import React")]);
  });

  it("names a client the project's lint ignores altogether", () => {
    expect(about("packages/client-unlinted")).toEqual([
      expect.stringContaining("is not under the hook rules"),
      expect.stringContaining("is not under the inline-style ban"),
    ]);
  });

  it("names each of the kit's rules that the project's own config replaced", () => {
    expect(about("packages/react-bindings")).toEqual([
      expect.stringContaining("is not under the memoization ban"),
    ]);
    expect(about("packages/client-loose")).toEqual([
      expect.stringContaining("is not under the hook rules (react-hooks/rules-of-hooks): ESLint resolves no such rule, at error, for packages/client-loose/src/app/useStart.ts"),
      expect.stringContaining("is not under the inline-style ban (no-restricted-syntax): ESLint resolves no such rule, at error, for packages/client-loose/src/ui/App.tsx"),
      expect.stringContaining("is not under the memoization ban"),
    ]);
  });
});

describe("a project it cannot judge", () => {
  it("reports a skip, never a pass, when no package imports React", () => {
    const run = runIn("dormant");

    expect(run.stdout).toBe("SKIP react-policies — no package imports React, so there was nothing to check\n");
    expect(run.status).toBe(0);
  });

  it("exits 2 where no layers are declared", () => {
    const run = runIn(".");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("react-policies could not run");
  });

  it("exits 2 where the project has no ESLint config, and says that is no verdict", () => {
    // The clean fixture of the gates has React packages and no eslint.config.mts.
    const run = runIn("clean");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not run, which is no verdict and not a pass: there is no eslint.config.mts in");
    expect(run.stdout).toBe("");
  });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the script the way a project does: in the project's root. */
function runIn(fixture: string): Run {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT], { cwd: join(fixtures, fixture), encoding: "utf8" });

  return { status, stdout, stderr };
}
