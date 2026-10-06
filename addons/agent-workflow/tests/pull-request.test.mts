// The check before a merge is approved. GitHub is a stand-in for `gh`, first
// on the `PATH` of the hook under test and of nothing else: no test here
// reaches the real `gh` or a network. The repository is a real one.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Ask, createAsk, mergeObstacle } from "../files/tools/agent-workflow/lib/pull-request.mts";
import { commit, createProject, ghCalls, git, type Project, runHook, sessionEnvironment, writeGh } from "./support.mts";

const REPOSITORY = { defaultBranchRef: { name: "main" }, url: "https://github.com/acme/desk" };

describe("a merge of this checkout's own pull request", () => {
  it("is approved: open, same repository, a worktree- branch, into the default branch, at one commit here, on GitHub and in the command", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });

    const run = runHook(project, `gh pr merge 12 --match-head-commit ${commitName} --squash`);

    expect(run.decision).toBe("allow");
    expect(run.reason).toBe("Approved by tools/agent-workflow: merging pull request 12, in the exact form the project pre-approves.");
  });

  it("is checked with two reads and nothing that writes", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });
    runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`);

    expect(ghCalls(project.home)).toEqual([
      "pr view 12 --json number,state,isCrossRepository,headRefName,headRefOid,baseRefName,url",
      "repo view --json defaultBranchRef,url",
    ]);
  });

  it("is not approved, and GitHub is not asked, with approveMerge off: that is a setting of its own", () => {
    const project = createProject({ approvePushAndCreate: true, approveMerge: false });
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`)).toMatchObject({ status: 0, stdout: "" });
    expect(runHook(project, "git push origin worktree-a").decision).toBe("allow");
    expect(ghCalls(project.home)).toEqual([]);
  });

  it("is approved with approveMerge alone, and a push is then not", () => {
    const project = createProject({ approveMerge: true });
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).decision).toBe("allow");
    expect(runHook(project, "git push origin worktree-a")).toMatchObject({ status: 0, stdout: "" });
  });

  it("is not approved without the commit in the command, whatever the pull request is", () => {
    const project = createProject();

    writeGh(project.home, { pull: createPull(git(project.project, "rev-parse", "worktree-a")), repository: REPOSITORY });

    expect(runHook(project, "gh pr merge 12 --squash")).toMatchObject({ status: 0, stdout: "" });
    expect(ghCalls(project.home)).toEqual([]);
  });

  it("is not approved, and GitHub is not asked, when gh may choose another repository", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });
    git(project.project, "remote", "add", "upstream", "https://github.com/someone/else.git");

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).reason).toContain("there is a second remote, upstream");
    expect(ghCalls(project.home)).toEqual([]);
  });
});

describe("a merge of a pull request that is not this checkout's own work", () => {
  it.each([
    ["a stranger's, from a fork", { isCrossRepository: true }, /is not from a branch of this repository/],
    ["one that does not say whether it is from a fork", { isCrossRepository: undefined }, /is not from a branch of this repository/],
    ["one whose address is in another repository", { url: "https://github.com/someone/else/pull/12" }, /is not from a branch of this repository/],
    ["one with another number than was asked for", { number: 13 }, /pull request 12 is not open/],
    ["a closed one", { state: "CLOSED" }, /pull request 12 is not open/],
    ["a merged one", { state: "MERGED" }, /pull request 12 is not open/],
    ["one from main", { headRefName: "main" }, /is not a worktree- branch/],
    ["one from a branch that is not a work branch", { headRefName: "feature-x" }, /is not a worktree- branch/],
    ["one with no head", { headRefName: undefined }, /is not a worktree- branch/],
    ["one into a branch that is not the default", { baseRefName: "release" }, /does not go into the default branch/],
    ["one that has been pushed to since", { headRefOid: "f".repeat(40) }, /is not at the commit the command names/],
    ["one whose branch is not in this checkout", { headRefName: "worktree-other" }, /the branch worktree-other is not at that commit in this checkout/],
  ])("is not approved for %s", (_name, change, reason) => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: { ...createPull(commitName), ...change }, repository: REPOSITORY });

    const run = runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`);

    expect(run.decision).toBe("ask");
    expect(run.reason).toMatch(reason);
  });

  it("is not approved when the branch here has moved on from the commit GitHub has", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY });
    git(project.project, "checkout", "--quiet", "worktree-a");
    commit(project.project, "one more", { "more.txt": "x\n" });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).reason).toContain("the branch worktree-a is not at that commit in this checkout");
  });

  it.each([
    ["has no default branch", { defaultBranchRef: null, url: REPOSITORY.url }, /does not go into the default branch/],
    ["names an empty default branch", { defaultBranchRef: { name: "" }, url: REPOSITORY.url }, /does not go into the default branch/],
    ["has no address", { defaultBranchRef: { name: "main" } }, /is not from a branch of this repository/],
  ])("is not approved when the repository gh works on %s", (_name, repository, reason) => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).reason).toMatch(reason);
  });

  // Each of these agrees with the repository only because both sides are missing the same thing.
  it.each([
    ["names no base, where the repository has no default branch", { baseRefName: undefined }, { defaultBranchRef: null, url: REPOSITORY.url }, /does not go into the default branch/],
    ["names an empty base, where the repository names an empty default branch", { baseRefName: "" }, { defaultBranchRef: { name: "" }, url: REPOSITORY.url }, /does not go into the default branch/],
    ["has the address a missing one would spell, where the repository has no address", { url: "undefined/pull/12" }, { defaultBranchRef: { name: "main" } }, /is not from a branch of this repository/],
  ])("is not approved when the pull request %s", (_name, change, repository, reason) => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: { ...createPull(commitName), ...change }, repository });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).reason).toMatch(reason);
  });

  it.each([
    ["gh fails on the pull request", { repository: REPOSITORY }],
    ["gh fails on the repository", { pull: createPull("0".repeat(40)) }],
    ["gh prints something that is not JSON", { pull: "<html>", repository: REPOSITORY }],
    ["gh prints a list", { pull: "[]", repository: REPOSITORY }],
  ])("is not approved when %s", (_name, answers) => {
    const project = createProject();

    writeGh(project.home, answers);

    const run = runHook(project, `gh pr merge 12 --match-head-commit ${"0".repeat(40)}`);

    expect(run.decision).toBe("ask");
    expect(run.reason).toContain("gh could not be asked about the pull request or the repository");
  });

  it("is not approved when gh prints the right answer and exits with an error", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    writeGh(project.home, { pull: createPull(commitName), repository: REPOSITORY, exit: 1 });

    expect(runHook(project, `gh pr merge 12 --match-head-commit ${commitName}`).reason).toContain("gh could not be asked");
  });

  it("is not approved when there is no gh on the hook's PATH", () => {
    const project = createProject();
    const commitName = git(project.project, "rev-parse", "worktree-a");

    rmSync(join(project.home, "bin/gh"));

    // Asked with a PATH that holds git and nothing named gh, so that the real one is never started.
    const ask = createAsk(project.project, { ...sessionEnvironment(project.home), PATH: createGitOnlyPath(project) });

    expect(ask("git", ["rev-parse", "worktree-a"])?.trim()).toBe(commitName);
    expect(ask("gh", ["pr", "view", "12"])).toBeUndefined();
    expect(mergeObstacle("12", commitName, ask)).toBe("gh could not be asked about the pull request or the repository");
  });
});

describe("the check, asked with answers given by hand", () => {
  const commitName = "a".repeat(40);
  const answering =
    (pull: unknown, repository: unknown, local: string | undefined): Ask =>
    (program, args) =>
      program === "git" ? local : JSON.stringify(args[0] === "pr" ? pull : repository);

  it("passes for the pull request that is the checkout's own", () => {
    expect(mergeObstacle("12", commitName, answering(createPull(commitName), REPOSITORY, `${commitName}\n`))).toBeUndefined();
  });

  it("reads the branch here as a commit, by its whole name under refs/heads", () => {
    const asked: string[][] = [];

    mergeObstacle("12", commitName, (program, args) => {
      asked.push([program, ...args]);

      return program === "git" ? commitName : JSON.stringify(args[0] === "pr" ? createPull(commitName) : REPOSITORY);
    });

    expect(asked.at(-1)).toEqual(["git", "rev-parse", "--verify", "--quiet", "--end-of-options", "refs/heads/worktree-a^{commit}"]);
  });

  it("does not pass when git cannot say where the branch is", () => {
    expect(mergeObstacle("12", commitName, answering(createPull(commitName), REPOSITORY, undefined))).toContain("is not at that commit in this checkout");
  });

  it("takes only the literal false for 'not from a fork'", () => {
    for (const value of [0, "false", null, "", []]) {
      expect(mergeObstacle("12", commitName, answering({ ...createPull(commitName), isCrossRepository: value }, REPOSITORY, commitName))).toContain("is not from a branch of this repository");
    }
  });
});

/** What `gh pr view --json …` prints for pull request 12 of the stand-in repository: open, from `worktree-a`, into `main`. */
function createPull(commitName: string): Record<string, unknown> {
  return {
    number: 12,
    state: "OPEN",
    isCrossRepository: false,
    headRefName: "worktree-a",
    headRefOid: commitName,
    baseRefName: "main",
    url: `${REPOSITORY.url}/pull/12`,
  };
}

/** A folder to use as the whole PATH: it holds a link to git, and so nothing named gh. */
function createGitOnlyPath({ home }: Project): string {
  const folder = join(home, "only-git");
  const where = git(home, "--exec-path");

  // git's own folder of programs holds `git` and no `gh`.
  return [folder, where].join(":");
}
