// Asks git what `git push origin <branch>` would do, and says why it is not
// the plain push the words describe, when it is not.
//
// The words of a push name a remote and a branch. Where the commits go is
// decided by more than the words:
//
//   - `remote.origin.push`, or the branch's upstream under
//     `push.default = upstream`, sends a branch to another name. So does a
//     branch that is a symbolic ref: `worktree-x` that points at `main`
//     pushes `main` to `main`.
//   - a tag of the same name and no such branch is pushed as a tag.
//   - `remote.origin.pushurl`, a second `remote.origin.url`, and
//     `url.<base>.insteadOf` send it to another place.
//   - `core.sshCommand`, `credential.helper`, `remote.origin.receivepack`, a
//     `pre-push` hook, a hook named in the config and a URL such as `ext::…`
//     name a program that the push runs.
//
// `git push --dry-run` is not asked. It was tried: it contacts the remote and
// it runs the `pre-push` hook, so asking it would itself be the push's side
// effects, before any decision.
//
// So the configuration is read, every scope of it, and judged by an
// allowlist. Git has no closed list of settings, so the allowlist is by
// section: in each section that exists to steer a push (`remote`,
// `branch.<the branch>`, `push`, `url`, `credential`, `http`, `protocol`,
// `ssh`, `hook`) a key this file does not name is "not plain". Outside those
// sections only the keys named here are read (`core.sshCommand`,
// `core.gitProxy`, `core.askPass`, `submodule.recurse`): that part is a list
// of known settings, and a setting git gains later is not on it.
//
// The line between the person's machine and the project: a setting from the
// system or the global configuration is the person's own, as their shell and
// their `PATH` are, and a credential helper, an ssh command, a proxy or a URL
// rewrite there is how their machine reaches a remote at all. The same
// setting in the repository's configuration (`.git/config`, a worktree's, a
// file either includes) or on the command line is one an agent can write
// without being asked, and is "not plain". Settings that change which branch
// is updated, or that push more than the branch, are judged the same in
// every scope.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The only remote a push is approved to, and the only one `gh` may be left to choose from. */
const REMOTE = "origin";

/** One line of `git config --list --show-scope`. */
export interface ConfigEntry {
  /** `system`, `global`, `local`, `worktree` or `command`. */
  scope: string;
  /** Section and name in lower case, the part between them as written: `remote.origin.pushurl`. */
  key: string;
  /** A key with no value is `true`, as git reads it. */
  value: string;
}

/** What is asked of the checkout. Undefined is "plain"; text is the first reason it is not. */
export interface Asked {
  /** The branch a push names. Left out for a `gh` call, which pushes nothing. */
  branch?: string;
  /** True for a `gh` call: `gh` picks its repository from the remotes, so `origin` must be the only one. */
  hosting?: boolean;
}

const PERSONS_OWN = ["system", "global"];
const OFF = ["false", "no", "off", "0"];

/**
 * Variables that are in a session for reasons that have nothing to do with
 * where a push goes. Any other `GIT_…` variable is "not plain": among them
 * are the ones that name the configuration files (`GIT_CONFIG_GLOBAL`, which
 * would make a file of the project's "the person's own"), the repository
 * (`GIT_DIR`), and a program (`GIT_SSH_COMMAND`, `GIT_ASKPASS`).
 */
const PLAIN_GIT_VARIABLES =
  /^GIT_(?:AUTHOR_(?:NAME|EMAIL|DATE)|COMMITTER_(?:NAME|EMAIL|DATE)|EDITOR|SEQUENCE_EDITOR|PAGER|TERMINAL_PROMPT|OPTIONAL_LOCKS|MERGE_AUTOEDIT|PS1_\w+|COMPLETION_\w+)$/;

/** `gh` reads these and they change nothing about which repository it works on or which program it runs. */
const PLAIN_GH_VARIABLES = /^GH_(?:TOKEN|ENTERPRISE_TOKEN|NO_UPDATE_NOTIFIER|NO_EXTENSION_UPDATE_NOTIFIER|PROMPT_DISABLED|SPINNER_DISABLED|FORCE_TTY|MDWIDTH)$/;

/** Keys of `remote.origin` that only say how to fetch. */
const FETCH_ONLY = ["fetch", "prune", "prunetags", "tagopt", "promisor", "partialclonefilter", "skipdefaultupdate", "skipfetchall", "followremotehead"];

/**
 * Where `origin` may point: `https://`, `ssh://`, `file://`, a whole path, or
 * `user@host:path`. Not `ext::…` or `fd::…`, which run a command; not a
 * scheme git does not know, which runs `git-remote-<scheme>` from the `PATH`;
 * not `http://` or `git://`, which anyone on the way can answer.
 */
const PLAIN_URL = /^(?:(?:https|ssh|file):\/\/[^\s-][^\s]*|\/[^\s]*|(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*:(?!:|\/\/)[^\s]+)$/;

/** Hooks git runs in this checkout during a push. Either one is a program of the project's that would run with the person's credentials at hand. */
const PUSH_HOOKS = ["pre-push", "reference-transaction"];

/** Why the checkout at `cwd` is not one where the asked step does only what its words say. Undefined when it is. */
export function obstacle(cwd: string, asked: Asked, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const variable = Object.keys(env).find(
    (name) => (name.startsWith("GIT_") && !PLAIN_GIT_VARIABLES.test(name)) || (asked.hosting === true && name.startsWith("GH_") && !PLAIN_GH_VARIABLES.test(name)),
  );

  if (variable !== undefined) {
    return `the variable ${variable} is set in the session`;
  }

  const entries = readConfig(cwd, env);

  if (entries === undefined) {
    return "git could not list its configuration here";
  }

  const urls = entries.filter(({ key }) => key === `remote.${REMOTE}.url`);

  if (urls.length !== 1) {
    return urls.length === 0 ? `there is no remote named ${REMOTE}` : `${REMOTE} has ${urls.length} URLs, and a push goes to each`;
  }

  const setting = entries.map((entry) => judgeEntry(entry, asked)).find((reason) => reason !== undefined);

  if (setting !== undefined || asked.branch === undefined) {
    return setting;
  }

  return judgeBranch(cwd, asked.branch, env) ?? judgeHooks(cwd, env);
}

/** Every setting git would read in `cwd`, from every scope and every included file. Undefined when git cannot say. */
export function readConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigEntry[] | undefined {
  // `--show-scope` is from git 2.26. An older git fails here, and nothing is approved.
  const listed = spawnSync("git", ["config", "--list", "--show-scope", "-z"], { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const fields = listed.status === 0 ? listed.stdout.split("\0") : [];

  // scope NUL key LF value NUL, and nothing after the last NUL.
  if (listed.status !== 0 || fields.pop() !== "" || fields.length % 2 !== 0) {
    return undefined;
  }

  const entries: ConfigEntry[] = [];

  for (let index = 0; index < fields.length; index += 2) {
    const pair = fields[index + 1] as string;
    const end = pair.indexOf("\n");

    entries.push({ scope: fields[index] as string, key: end === -1 ? pair : pair.slice(0, end), value: end === -1 ? "true" : pair.slice(end + 1) });
  }

  return entries;
}

/** Why one setting makes the step not plain. Undefined for a setting that does not. */
export function judgeEntry({ scope, key, value }: ConfigEntry, asked: Asked): string | undefined {
  const section = key.slice(0, key.indexOf("."));
  const name = key.slice(key.lastIndexOf(".") + 1);
  const subsection = key.slice(section.length + 1, Math.max(section.length + 1, key.length - name.length - 1));
  const own = PERSONS_OWN.includes(scope);
  const no = `${key} is set${own ? "" : " in the repository's own configuration"}`;

  switch (section) {
    case "remote":
      if (subsection === "") {
        return name === "pushdefault" && value === REMOTE ? undefined : no;
      }

      if (subsection !== REMOTE) {
        return asked.hosting === true ? `there is a second remote, ${subsection}, and gh may choose it` : undefined;
      }

      if (name === "url") {
        return scope === "local" && PLAIN_URL.test(value) ? undefined : `${key} is not a plain address in the repository's own configuration`;
      }

      if (name === "gh-resolved") {
        return asked.hosting === true ? `${key} is set, which tells gh which repository to use` : undefined;
      }

      return FETCH_ONLY.includes(name) ? undefined : no;
    case "branch":
      if (subsection === "" || subsection !== asked.branch) {
        return undefined;
      }

      if (name === "remote" || name === "pushremote") {
        return value === REMOTE ? undefined : `${key} is ${value}, not ${REMOTE}`;
      }

      if (name === "merge") {
        // Under `push.default = upstream` this, and not the branch's name, is where the push goes.
        return value === `refs/heads/${subsection}` ? undefined : `${key} is ${value}: the branch tracks another one`;
      }

      return name === "rebase" || name === "description" ? undefined : no;
    case "push":
      switch (name) {
        case "default":
          return ["simple", "current", "upstream", "tracking", "nothing", "matching"].includes(value) ? undefined : no;
        case "followtags":
        case "gpgsign":
          return OFF.includes(value) ? undefined : `${key} is ${value}`;
        case "recursesubmodules":
          return [...OFF, "check"].includes(value) ? undefined : `${key} is ${value}`;
        case "autosetupremote":
        case "useforceifincludes":
        case "negotiate":
        case "usebitmaps":
          return undefined;
        default:
          return no;
      }
    case "url":
    case "credential":
    case "http":
    case "protocol":
    case "ssh":
      return own ? undefined : no;
    case "hook":
      return `${key} is set, and names a program git runs`;
    case "core":
      return ["sshcommand", "gitproxy", "askpass"].includes(name) && !own ? no : undefined;
    case "submodule":
      return subsection === "" && name === "recurse" && !OFF.includes(value) ? `${key} is ${value}` : undefined;
    default:
      return undefined;
  }
}

/** The name must be a branch, a real one, and nothing else of that name that a push would take in its place. */
function judgeBranch(cwd: string, branch: string, env: NodeJS.ProcessEnv): string | undefined {
  const git = (...args: string[]): number | null => spawnSync("git", args, { cwd, env, encoding: "utf8" }).status;

  if (git("show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== 0) {
    return `there is no local branch ${branch}`;
  }

  // Exit 1 is "not symbolic". Anything else is a symbolic ref, or an answer that cannot be read as "no".
  if (git("symbolic-ref", "--quiet", `refs/heads/${branch}`) !== 1) {
    return `the branch ${branch} is a symbolic ref, and a push follows it to another branch`;
  }

  if (git("show-ref", "--verify", "--quiet", `refs/tags/${branch}`) !== 1) {
    return `there is a tag named ${branch} too`;
  }

  return undefined;
}

function judgeHooks(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  // Honours `core.hooksPath`, from whichever scope sets it.
  const asked = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { cwd, env, encoding: "utf8" });
  const folder = asked.status === 0 ? asked.stdout.replace(/\n$/, "") : "";

  if (folder === "") {
    return "git could not say where its hooks are";
  }

  const hook = PUSH_HOOKS.find((name) => existsSync(resolve(cwd, folder, name)));

  return hook === undefined ? undefined : `there is a ${hook} hook (${resolve(cwd, folder, hook)}), which a push runs`;
}
