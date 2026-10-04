import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PublishError, publishToPages } from "../files/tools/coverage/publish-to-pages.mts";
import { createCheckout, createFolder, git, ISOLATED_GIT, TOOLS } from "./support.mts";

const BRANCH = "refs/heads/gh-pages";

describe("publishing a folder to the Pages branch", () => {
  const isolation = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
  const before = isolation.map((name) => process.env[name]);

  // The tool runs git with this process's settings; keep the user's own out of it.
  beforeAll(() => {
    for (const name of isolation) {
      process.env[name] = ISOLATED_GIT[name];
    }
  });

  afterAll(() => {
    for (const [index, name] of isolation.entries()) {
      if (before[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = before[index];
      }
    }
  });

  it("creates the branch when the remote does not have it, holding only what was published", () => {
    const { checkout, remote } = createRepository();
    const outcome = publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>report</p>" }) });

    expect(outcome).toBe("published");
    expect(listTree(remote)).toEqual([".nojekyll", "coverage/index.html"]);
    expect(git(remote, "rev-list", "--count", BRANCH)).toBe("1");
  });

  it("keeps what other producers published under other names", () => {
    const { checkout, remote } = createRepository();

    publishToPages({ repository: checkout, source: createFolder({ "visual/index.html": "<p>visual diff</p>" }) });
    publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>report</p>" }) });

    expect(listTree(remote)).toEqual([".nojekyll", "coverage/index.html", "visual/index.html"]);
  });

  it("replaces its own entry whole, so a page that is gone from the report is gone from the site", () => {
    const { checkout, remote } = createRepository();

    publishToPages({ repository: checkout, source: createFolder({ "coverage/removed-package/index.html": "<p>old</p>" }) });
    publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>new</p>" }) });

    expect(listTree(remote)).toEqual([".nojekyll", "coverage/index.html"]);
    expect(git(remote, "show", `${BRANCH}:coverage/index.html`)).toBe("<p>new</p>");
  });

  it("makes no commit when nothing has changed", () => {
    const { checkout, remote } = createRepository();
    const source = createFolder({ "coverage/index.html": "<p>report</p>" });

    publishToPages({ repository: checkout, source });

    expect(publishToPages({ repository: checkout, source })).toBe("no changes");
    expect(git(remote, "rev-list", "--count", BRANCH)).toBe("1");
  });

  it("adds .nojekyll, so Pages serves folders whose name starts with an underscore", () => {
    const { checkout, remote } = createRepository();

    publishToPages({ repository: checkout, source: createFolder({ "coverage/__fixtures__/index.html": "<p>report</p>" }) });

    expect(listTree(remote)).toContain(".nojekyll");
  });

  it("tries again when the remote rejects the push", () => {
    const { checkout, remote } = createRepository();

    rejectFirstPush(remote);

    expect(publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>report</p>" }) })).toBe("published");
    expect(listTree(remote)).toEqual([".nojekyll", "coverage/index.html"]);
  });

  it("commits with the given message as the workflow bot, without writing to the checkout's git config", () => {
    const { checkout, remote } = createRepository();

    publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>report</p>" }), message: "coverage report for abc1234" });

    expect(git(remote, "log", "-1", "--format=%an|%s", BRANCH)).toBe("github-actions[bot]|coverage report for abc1234");
    expect(spawnSync("git", ["config", "--local", "user.name"], { cwd: checkout, env: ISOLATED_GIT }).status).toBe(1);
  });

  it("leaves no worktree behind, and leaves the checkout on its own branch", () => {
    const { checkout } = createRepository();

    publishToPages({ repository: checkout, source: createFolder({ "coverage/index.html": "<p>report</p>" }) });

    expect(git(checkout, "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it("refuses a source that is not a folder", () => {
    const { checkout } = createRepository();

    expect(() => publishToPages({ repository: checkout, source: join(checkout, "no-such-folder") })).toThrow(PublishError);
  });

  it("refuses an empty source, so an empty report is not published as if it were one", () => {
    const { checkout, remote } = createRepository();

    expect(() => publishToPages({ repository: checkout, source: createFolder() })).toThrow(/there is nothing to publish/);
    expect(spawnSync("git", ["rev-parse", "--verify", "--quiet", BRANCH], { cwd: remote }).status).toBe(1);
  });

  it("exits 2 with the usage when --source is missing", () => {
    const { status, stderr } = spawnSync("node", [join(TOOLS, "publish-to-pages.mts"), "--branch", "gh-pages"], { encoding: "utf8" });

    expect(stderr).toContain("publish-to-pages could not run: usage:");
    expect(status).toBe(2);
  });

  it("exits 1 with git's own words when git fails", () => {
    const source = createFolder({ "coverage/index.html": "<p>report</p>" });
    const { status, stderr } = spawnSync("node", [join(TOOLS, "publish-to-pages.mts"), "--source", source], {
      cwd: createFolder(),
      encoding: "utf8",
      env: ISOLATED_GIT,
    });

    expect(stderr).toContain("not a git repository");
    expect(status).toBe(1);
  });
});

/** A bare remote and a checkout of it with one commit on `main`, pushed. */
function createRepository(): { checkout: string; remote: string } {
  const remote = createFolder();
  const checkout = createCheckout();

  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "--quiet", "origin", "main");

  return { checkout, remote };
}

/** Every file on the Pages branch of `remote`, sorted. */
function listTree(remote: string): string[] {
  return git(remote, "ls-tree", "-r", "--name-only", BRANCH).split("\n").sort();
}

/** Makes `remote` refuse the next push to it, once, the way it refuses when someone else pushed first. */
function rejectFirstPush(remote: string): void {
  const hook = join(remote, "hooks", "update");

  mkdirSync(join(remote, "hooks"), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nif [ ! -f "$GIT_DIR/rejected-once" ]; then\n  touch "$GIT_DIR/rejected-once"\n  exit 1\nfi\n');
  chmodSync(hook, 0o755);
}
