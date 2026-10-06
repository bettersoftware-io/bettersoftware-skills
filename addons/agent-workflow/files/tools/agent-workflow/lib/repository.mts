// Answers whether a folder is a checkout or a worktree of the repository
// another folder is in.
//
// Every checkout and worktree of one repository shares one "common
// directory" (the main `.git`). Two folders are in the same repository when
// git names the same common directory for both.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Variables that make git answer for another repository than the one the folder is in. */
const REPOSITORY_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

/**
 * The repository's common directory for `folder`, as a real path. Undefined
 * when the folder is not given whole, does not exist, or is in no repository.
 */
export function commonDirectory(folder: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A path that is not whole would be read from wherever this process happens to be.
  if (!isAbsolute(folder)) {
    return undefined;
  }

  const asked = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: folder, encoding: "utf8", env });
  const answer = asked.status === 0 ? asked.stdout.replace(/\n$/, "") : "";

  // Nothing was printed when the folder does not exist or is in no repository.
  return answer === "" ? undefined : realpathSync(resolve(folder, answer));
}

/**
 * True when `cwd` is a checkout or a worktree of the repository `home` is in.
 *
 * `home` is asked about with the override variables taken out: it is a fixed
 * place, and its repository is the one it sits in. `cwd` is asked about with
 * the environment as it is: if a variable there points git at another
 * repository, a push from `cwd` goes to that one, and the answer must be no.
 */
export function isCheckoutOf(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const plain = Object.fromEntries(Object.entries(env).filter(([name]) => !REPOSITORY_OVERRIDES.includes(name)));
  const own = commonDirectory(home, plain);

  return own !== undefined && commonDirectory(cwd, env) === own;
}
