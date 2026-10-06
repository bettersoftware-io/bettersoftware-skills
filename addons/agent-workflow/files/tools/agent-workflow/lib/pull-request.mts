// Asks GitHub what a pull request is, before a merge of it is approved.
//
// `gh pr merge 12` says nothing about pull request 12. It may be a stranger's,
// from a fork, and text in it may be what told the agent to merge it. So a
// merge is approved only for a pull request that is this checkout's own work:
//
//   - it is open, and its head and its base are in the same repository;
//   - its head is a `worktree-…` branch;
//   - that branch exists here, and here, on GitHub and in the command
//     (`--match-head-commit`) it is at one and the same commit;
//   - its base is the repository's default branch.
//
// Two reads, both through `gh`: `gh pr view` and `gh repo view`. Neither
// changes anything. `gh` is started by name, so it is the one first on the
// `PATH` of the hook's own process. The command that follows is run by a
// shell the host starts, and that shell may find another `gh` (a `PATH` set
// in a profile, an alias, a function): then the program that was asked is
// not the program that merges. The hook cannot see that.

import { spawnSync } from "node:child_process";

import { WORK_BRANCH } from "./approve.mts";

/** Runs a program in the checkout and gives what it printed, or undefined when it failed, was not found, or took too long. */
export type Ask = (program: string, args: string[]) => string | undefined;

/** Each read waits this long. The hook's own time limit in the host's settings is longer than both together. */
const LONGEST_READ_MS = 10_000;

export function createAsk(cwd: string, env: NodeJS.ProcessEnv = process.env): Ask {
  return (program, args) => {
    const ran = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: LONGEST_READ_MS, stdio: ["ignore", "pipe", "ignore"] });

    return ran.error === undefined && ran.status === 0 ? ran.stdout : undefined;
  };
}

/** Why pull request `number` is not this checkout's own work at `commit`. Undefined when it is. */
export function mergeObstacle(number: string, commit: string, ask: Ask): string | undefined {
  const pull = readObject(ask("gh", ["pr", "view", number, "--json", "number,state,isCrossRepository,headRefName,headRefOid,baseRefName,url"]));
  const repository = readObject(ask("gh", ["repo", "view", "--json", "defaultBranchRef,url"]));

  if (pull === undefined || repository === undefined) {
    return "gh could not be asked about the pull request or the repository";
  }

  const { headRefName: head, headRefOid: headCommit, baseRefName: base } = pull;
  const defaultBranch = (repository.defaultBranchRef as { name?: unknown } | null | undefined)?.name;

  if (String(pull.number) !== number || pull.state !== "OPEN") {
    return `pull request ${number} is not open`;
  }

  // Only a literal `false` is "the same repository": a field that is missing is not.
  if (pull.isCrossRepository !== false || typeof repository.url !== "string" || pull.url !== `${repository.url}/pull/${number}`) {
    return `pull request ${number} is not from a branch of this repository`;
  }

  if (typeof head !== "string" || !WORK_BRANCH.test(head)) {
    return `the head of pull request ${number} is not a worktree- branch`;
  }

  if (typeof defaultBranch !== "string" || defaultBranch === "" || base !== defaultBranch) {
    return `pull request ${number} does not go into the default branch`;
  }

  if (headCommit !== commit) {
    return `pull request ${number} is not at the commit the command names`;
  }

  // `^{commit}` and `--verify`: one name, read as a commit, or nothing.
  if (ask("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${head}^{commit}`])?.trim() !== commit) {
    return `the branch ${head} is not at that commit in this checkout`;
  }

  return undefined;
}

function readObject(text: string | undefined): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text ?? "");

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
