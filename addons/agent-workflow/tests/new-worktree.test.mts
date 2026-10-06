import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Ran, type Run, run } from "../files/tools/agent-workflow/lib/system.mts";
import { newWorktree } from "../files/tools/agent-workflow/new-worktree.mts";
import { commit, createRemote, git, type Remote, writeFile } from "./support.mts";

describe("a new worktree", () => {
  it("is cut from the remote's main as it is now, not from a local main that has fallen behind", () => {
    const remote = createRemote();
    const stale = git(remote.clone, "rev-parse", "main");
    const newest = moveOriginOn(remote);

    // Nothing has been fetched: the clone's main and its origin/main are both the old commit.
    expect(git(remote.clone, "rev-parse", "origin/main")).toBe(stale);

    const { status, path } = create(remote.clone, ["fix"]);

    expect(status).toBe(0);
    expect(git(path, "rev-parse", "HEAD")).toBe(newest);
    expect(git(path, "rev-parse", "HEAD")).not.toBe(stale);
    expect(git(remote.clone, "rev-parse", "main")).toBe(stale);
  });

  it("is not cut from HEAD: work on the branch that is checked out stays out of it", () => {
    const remote = createRemote();

    git(remote.clone, "checkout", "--quiet", "-b", "someone-elses-work");

    const unrelated = commit(remote.clone, "not merged anywhere", { "wip.txt": "wip\n" });
    const newest = moveOriginOn(remote);
    const { path } = create(remote.clone, ["fix"]);

    expect(git(path, "rev-parse", "HEAD")).toBe(newest);
    expect(git(path, "log", "--format=%H")).not.toContain(unrelated);
    expect(existsSync(join(path, "wip.txt"))).toBe(false);
  });

  it("is not cut from a local main that is ahead of the remote either", () => {
    const remote = createRemote();
    const onOrigin = git(remote.clone, "rev-parse", "origin/main");

    commit(remote.clone, "committed to main by mistake, never pushed", { "oops.txt": "oops\n" });

    const { path } = create(remote.clone, ["fix"]);

    expect(git(path, "rev-parse", "HEAD")).toBe(onOrigin);
  });

  it("goes beside the project, on a branch named for it, that tracks nothing", () => {
    const remote = createRemote();
    const { path, lines } = create(remote.clone, ["rates-filter"]);

    expect(path).toBe(join(dirname(remote.clone), "project-worktrees", "rates-filter"));
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-rates-filter");
    expect(git(path, "config", "--default", "none", "branch.worktree-rates-filter.merge")).toBe("none");
    expect(lines.slice(0, 3)).toEqual([
      `worktree: ${path}`,
      "branch:   worktree-rates-filter",
      `base:     origin/main at ${git(path, "log", "-1", "--format=%h %s")}`,
    ]);
  });

  it("goes beside the main checkout when it is asked for from inside another worktree", () => {
    const remote = createRemote();
    const first = create(remote.clone, ["first"]);
    const second = create(first.path, ["second"]);

    const beside = join(dirname(remote.clone), "project-worktrees", "second");

    expect(second.status).toBe(0);
    expect(second.lines[0]).toBe(`worktree: ${beside}`);
    expect(git(beside, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-second");
    expect(existsSync(join(first.path, "..", "first-worktrees"))).toBe(false);
  });

  it("is cut from the branch origin calls its default, or from the one named with --base", () => {
    const remote = createRemote();

    git(remote.other, "checkout", "--quiet", "-b", "release");

    const release = commit(remote.other, "on release", { "release.txt": "1\n" });

    git(remote.other, "push", "--quiet", "origin", "release");
    git(remote.clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
    git(remote.clone, "fetch", "--quiet", "origin", "release");

    expect(git(create(remote.clone, ["by-default"]).path, "rev-parse", "HEAD")).toBe(release);
    expect(git(create(remote.clone, ["by-name", "--base", "main"]).path, "rev-parse", "HEAD")).toBe(git(remote.origin, "rev-parse", "main"));
    expect(git(create(remote.clone, ["--base", "release", "name-last"]).path, "rev-parse", "HEAD")).toBe(release);
  });

  it("says the worktree is not ready, and how to make it so, unless it was asked to", () => {
    const remote = createRemote();
    const { status, lines, ran } = create(remote.clone, ["fix"]);

    expect(status).toBe(0);
    expect(ran).toEqual([]);
    expect(lines[3]).toMatch(/^state: {4}NOT READY/);
    expect(lines[4]).toContain("pnpm install && pnpm gate:fast");
  });
});

describe("--ready", () => {
  it("installs, proves the worktree with the fast gate, and only then says READY", () => {
    const remote = createRemote();
    const { status, lines, ran, path } = create(remote.clone, ["fix", "--ready"]);

    expect(status).toBe(0);
    expect(ran).toEqual([
      { command: "pnpm install", cwd: path },
      { command: "pnpm gate:fast", cwd: path },
    ]);
    expect(lines.at(-1)).toBe("state:    READY — dependencies installed, pnpm gate:fast passed");
  });

  it("says NOT READY and fails when the install fails, without running the gate", () => {
    const remote = createRemote();
    const { status, lines, ran } = create(remote.clone, ["fix", "--ready"], { "pnpm install": 1 });

    expect(status).toBe(1);
    expect(ran.map(({ command }) => command)).toEqual(["pnpm install"]);
    expect(lines.at(-1)).toMatch(/^state: {4}NOT READY — pnpm install failed/);
  });

  it("says NOT READY and fails when the gate fails in the untouched worktree", () => {
    const remote = createRemote();
    const { status, lines } = create(remote.clone, ["fix", "--ready"], { "pnpm gate:fast": 1 });

    expect(status).toBe(1);
    expect(lines.at(-1)).toMatch(/^state: {4}NOT READY — pnpm gate:fast failed in a worktree nobody has edited/);
    expect(lines.join("\n")).not.toContain("state:    READY");
  });

  it("does not call a worktree ready when the project has nothing to prove it with", () => {
    const remote = createRemote();

    commit(remote.other, "no gate", { "package.json": '{ "name": "project", "scripts": {} }\n' });
    git(remote.other, "push", "--quiet", "origin", "main");

    const { status, lines, ran } = create(remote.clone, ["fix", "--ready"]);

    expect(status).toBe(1);
    expect(ran.map(({ command }) => command)).toEqual(["pnpm install"]);
    expect(lines.at(-1)).toMatch(/^state: {4}INSTALLED, NOT PROVEN/);
  });
});

describe("a worktree that cannot be made", () => {
  it("is refused when the folder is there already, and nothing changes", () => {
    const remote = createRemote();
    const taken = join(dirname(remote.clone), "project-worktrees", "fix");

    mkdirSync(taken, { recursive: true });

    const { status, lines } = create(remote.clone, ["fix"]);

    expect(status).toBe(1);
    expect(lines).toEqual([`FAIL new-worktree: ${taken} already exists. Pick another name, or remove it with: git worktree remove ${taken}`]);
    expect(git(remote.clone, "branch", "--list", "worktree-fix")).toBe("");
  });

  it("is refused when the branch is there already", () => {
    const remote = createRemote();

    git(remote.clone, "branch", "worktree-fix");

    const { status, lines, path } = create(remote.clone, ["fix"]);

    expect(status).toBe(1);
    expect(lines[0]).toMatch(/^FAIL new-worktree: the branch worktree-fix already exists/);
    expect(existsSync(path)).toBe(false);
  });

  it("is not made from an old copy of the remote's main when the fetch fails", () => {
    const remote = createRemote();

    git(remote.clone, "remote", "set-url", "origin", join(dirname(remote.clone), "gone.git"));

    const { status, lines, path } = create(remote.clone, ["fix"]);

    expect(status).toBe(2);
    expect(lines[0]).toMatch(/^SKIP new-worktree: could not fetch main from origin .*Nothing was made$/s);
    expect(existsSync(path)).toBe(false);
    expect(git(remote.clone, "branch", "--list", "worktree-fix")).toBe("");
  });

  it("is not made outside a git repository", () => {
    const folder = dirname(createRemote().clone);
    const { status, lines } = create(folder, ["fix"]);

    expect(status).toBe(2);
    expect(lines[0]).toMatch(/is not inside a git repository/);
  });

  it.each([[[]], [["--ready"]], [["a", "b"]], [["../escape"]], [["-rf"]], [["with space"]], [["fix", "--base"]]])(
    "is not made from %j, which names no worktree",
    (argv) => {
      const remote = createRemote();
      const { status, lines } = create(remote.clone, argv);

      expect(status).toBe(2);
      expect(lines[0]).toMatch(/^usage: /);
      expect(existsSync(join(dirname(remote.clone), "project-worktrees"))).toBe(false);
    },
  );
});

interface Created {
  status: number;
  lines: string[];
  /** Where the worktree was to go. */
  path: string;
  /** The install and the proof that were run, in order. */
  ran: { command: string; cwd: string }[];
}

/** Runs the tool with the real git. `pnpm` is not run: each call exits as `exits` says, 0 by default. */
function create(cwd: string, argv: string[], exits: Record<string, number> = {}): Created {
  const lines: string[] = [];
  const ran: Created["ran"] = [];
  const runGit: Run = (program, args, where) => run(program, ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], where);
  const runShown: Run = (program, args, where): Ran => {
    const command = [program, ...args].join(" ");

    ran.push({ command, cwd: where });

    return { status: exits[command] ?? 0, stdout: "", stderr: "" };
  };
  const status = newWorktree({ cwd, argv, run: runGit, runShown, report: (line) => lines.push(line) });
  const name = argv.filter((argument, index) => !argument.startsWith("--") && argv[index - 1] !== "--base")[0] ?? "";
  const project = existsSync(join(cwd, ".git")) ? realpathSync(git(cwd, "worktree", "list", "--porcelain").split("\n")[0]?.replace(/^worktree /, "") ?? cwd) : cwd;

  return { status, lines, ran, path: join(dirname(project), "project-worktrees", name) };
}

/** Someone else merges to main: origin moves on, and the first clone has not heard. */
function moveOriginOn(remote: Remote): string {
  const newest = commit(remote.other, "merged by someone else", { "new.txt": "new\n" });

  git(remote.other, "push", "--quiet", "origin", "main");
  writeFile(remote.other, ".keep", "");

  return newest;
}
