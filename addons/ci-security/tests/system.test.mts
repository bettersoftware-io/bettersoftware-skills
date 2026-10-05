import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDownload, extractWithTar, hasCommand, runInherited } from "../files/tools/ci-security/lib/system.mts";
import { ADDON, createFolder } from "./support.mts";

describe("createDownload", () => {
  it("returns the bytes of the response", async () => {
    const download = createDownload(() => Promise.resolve(new Response("the archive")));

    expect(Buffer.from(await download("https://example.test/a.tar.gz")).toString()).toBe("the archive");
  });

  it("follows the redirect a release download answers with, and gives up after a minute", async () => {
    const requests: { url: string; redirect?: string; hasTimeout: boolean }[] = [];
    const download = createDownload((url, init) => {
      requests.push({ url: String(url), redirect: init?.redirect, hasTimeout: init?.signal instanceof AbortSignal });

      return Promise.resolve(new Response(""));
    });

    await download("https://example.test/a.tar.gz");

    expect(requests).toEqual([{ url: "https://example.test/a.tar.gz", redirect: "follow", hasTimeout: true }]);
  });

  it("fails on an answer that is not the file, such as a 404 page", async () => {
    const download = createDownload(() => Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" })));

    await expect(download("https://example.test/a.tar.gz")).rejects.toThrow("the server answered 404 Not Found");
  });

  it("gives the reason under fetch's own 'fetch failed'", async () => {
    const download = createDownload(() => Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND github.com") })));

    await expect(download("https://example.test/a.tar.gz")).rejects.toThrow("getaddrinfo ENOTFOUND github.com");
  });
});

describe("extractWithTar", () => {
  it("takes the one named file out of a gzipped tar archive", () => {
    const folder = createFolder({ "in/linter": "the linter", "in/README.md": "notes", "out/.keep": "" });

    execFileSync("tar", ["-czf", join(folder, "archive.tar.gz"), "-C", join(folder, "in"), "linter", "README.md"]);
    extractWithTar(join(folder, "archive.tar.gz"), join(folder, "out"), "linter");

    expect(readFileSync(join(folder, "out/linter"), "utf8")).toBe("the linter");
    expect(spawnSync("ls", [join(folder, "out/README.md")]).status).not.toBe(0);
  });

  it("throws when the archive does not hold the file", () => {
    const folder = createFolder({ "in/other": "x", "out/.keep": "" });

    execFileSync("tar", ["-czf", join(folder, "archive.tar.gz"), "-C", join(folder, "in"), "other"]);

    expect(() => extractWithTar(join(folder, "archive.tar.gz"), join(folder, "out"), "linter")).toThrow();
  });
});

describe("runInherited", () => {
  it("returns the exit status of the program, run in the folder given", () => {
    const folder = createFolder({ "marker.txt": "" });
    const script = 'process.exit(require("node:fs").existsSync("marker.txt") ? 14 : 99)';

    expect(runInherited(process.execPath, ["-e", script], folder)).toBe(14);
  });

  it("returns null for a program that does not start", () => {
    expect(runInherited(join(createFolder(), "not-there"), [], createFolder())).toBeNull();
  });
});

describe("hasCommand", () => {
  it("finds a program that is in a folder of the PATH and can be run", () => {
    const folder = createFolder({ "bin/shellcheck": "#!/bin/sh\n" });

    chmodSync(join(folder, "bin/shellcheck"), 0o755);

    expect(hasCommand("shellcheck", `/nowhere:${join(folder, "bin")}`)).toBe(true);
  });

  it("does not take a file that cannot be run, a missing program or an empty PATH for one", () => {
    const folder = createFolder({ "bin/shellcheck": "notes" });

    chmodSync(join(folder, "bin/shellcheck"), 0o644);

    expect(hasCommand("shellcheck", join(folder, "bin"))).toBe(false);
    expect(hasCommand("pyflakes", join(folder, "bin"))).toBe(false);
    expect(hasCommand("shellcheck", undefined)).toBe(false);
  });
});

describe("node tools/ci-security/lint-workflows.mts", () => {
  it("exits 2 and says there was nothing to lint in a project with no workflow, before it downloads anything", () => {
    const result = runTool(createProject({}));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("SKIP workflow lint: .github/workflows holds no .yml or .yaml file, so there was nothing to lint.\n");
  });

  it("exits 2 on a name that is not a linter", () => {
    const result = runTool(createProject({ ".github/workflows/ci.yml": "name: CI\n" }), "eslint");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('SKIP workflow lint: there is no linter called "eslint". Choose from: actionlint, zizmor.\n');
  });
});

/** A project folder holding the add-on's tools, where a project has them. */
function createProject(files: Record<string, string>): string {
  const project = createFolder(files);

  cpSync(join(ADDON, "files/tools"), join(project, "tools"), { recursive: true });

  return project;
}

function runTool(project: string, ...toolArguments: string[]): { status: number | null; stdout: string } {
  const { status, stdout } = spawnSync(process.execPath, [join(project, "tools/ci-security/lint-workflows.mts"), ...toolArguments], { encoding: "utf8" });

  return { status, stdout };
}
