// What a push would really do, asked of real repositories: each test makes a
// project with an `origin` beside it in a temporary folder, changes one thing
// an agent can change without being asked, and reads the hook's answer. For
// the changes that send a push elsewhere or run a program, the push is also
// run, so the test is known to hold the redirect it is named for.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkoutObstacle, judgeCall } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { type ConfigEntry, judgeEntry, obstacle, readConfig } from "../files/tools/agent-workflow/lib/push.mts";
import { APPROVED, LONGEST } from "./shapes.mts";
import { commit, createProject, git, type Project, runHook, sessionEnvironment, writeFile } from "./support.mts";

const PUSH = "git push origin worktree-a";
const BRANCH = { branch: "worktree-a" };

describe("a push of a work branch, in a checkout as a clone leaves it", () => {
  it("is plain, and is approved", () => {
    const project = createProject();

    expect(obstacle(project.project, BRANCH, sessionEnvironment(project.home))).toBeUndefined();
    expect(runHook(project, PUSH).decision).toBe("allow");
  });

  it("goes to the branch of the same name on origin, and nowhere else", () => {
    const project = createProject();

    advance(project);
    push(project);

    expect(refsOf(project.origin)).toEqual({ "refs/heads/main": refOf(project, "main"), "refs/heads/worktree-a": refOf(project, "worktree-a") });
    expect(refOf(project, "main")).not.toBe(refOf(project, "worktree-a"));
  });

  it("is still plain with what a person's own machine needs: a credential helper, an ssh command, a proxy and a URL rewrite in their global settings", () => {
    const project = createProject();

    writeFile(
      project.home,
      ".gitconfig",
      [
        "[credential]\n\thelper = osxkeychain",
        '[credential "https://github.com"]\n\thelper = !gh auth git-credential',
        "[core]\n\tsshCommand = ssh -i ~/.ssh/work\n\thooksPath = ~/no-such-hooks",
        "[http]\n\tproxy = http://proxy.example.test:3128",
        '[url "git@github.com:"]\n\tinsteadOf = https://github.com/',
        "[push]\n\tdefault = current\n\tautoSetupRemote = true\n\tfollowTags = false",
        "[user]\n\tname = A Person",
        "",
      ].join("\n"),
    );

    expect(obstacle(project.project, BRANCH, sessionEnvironment(project.home))).toBeUndefined();
    expect(runHook(project, PUSH).decision).toBe("allow");
  });

  it("is still plain once the branch tracks its own name on origin, which is what push -u leaves", () => {
    const project = createProject();

    configure(project, "branch.worktree-a.remote", "origin");
    configure(project, "branch.worktree-a.merge", "refs/heads/worktree-a");
    configure(project, "push.default", "upstream");

    expect(runHook(project, "git push -u origin worktree-a").decision).toBe("allow");
  });
});

describe("a push that would land on another branch", () => {
  it("is not approved when the branch tracks main and push.default is upstream: the push goes to main", () => {
    const project = createProject();

    configure(project, "push.default", "upstream");
    configure(project, "branch.worktree-a.remote", "origin");
    configure(project, "branch.worktree-a.merge", "refs/heads/main");
    advance(project);

    expectAsked(project, /branch\.worktree-a\.merge is refs\/heads\/main: the branch tracks another one/);
    expect(push(project)).toContain("worktree-a -> main");
    expect(refsOf(project.origin)["refs/heads/main"]).toBe(refOf(project, "worktree-a"));
  });

  it("is not approved when the branch tracks main, whatever push.default is", () => {
    const project = createProject();

    configure(project, "branch.worktree-a.remote", "origin");
    configure(project, "branch.worktree-a.merge", "refs/heads/main");

    expectAsked(project, /the branch tracks another one/);
  });

  it("is not approved when origin has a push refspec: main is updated by force with no + in the command", () => {
    const project = createProject();

    configure(project, "remote.origin.push", "+refs/heads/worktree-a:refs/heads/main");
    // A commit that is not a descendant of origin's main: only a forced update can put it there.
    git(project.project, "checkout", "--quiet", "--orphan", "rewritten");
    commit(project.project, "another history", { "other.txt": "x\n" });
    git(project.project, "branch", "--force", "worktree-a", "rewritten");

    expectAsked(project, /remote\.origin\.push is set in the repository's own configuration/);
    expect(push(project)).toMatch(/\+ .*worktree-a -> main \(forced update\)/);
    expect(refsOf(project.origin)["refs/heads/main"]).toBe(refOf(project, "worktree-a"));
  });

  it("is not approved when the branch is a symbolic ref to main: the push follows it", () => {
    const project = createProject();

    git(project.project, "branch", "-D", "worktree-a");
    git(project.project, "symbolic-ref", "refs/heads/worktree-a", "refs/heads/main");
    commit(project.project, "straight to main", { "direct.txt": "x\n" });

    expectAsked(project, /the branch worktree-a is a symbolic ref/);
    expect(push(project)).toContain("worktree-a -> main");
    expect(refsOf(project.origin)["refs/heads/main"]).toBe(refOf(project, "main"));
  });

  it("is not approved when the name is a tag and no branch: the push makes a tag", () => {
    const project = createProject();

    git(project.project, "tag", "worktree-a", "worktree-a");
    git(project.project, "branch", "-D", "worktree-a");

    expectAsked(project, /there is no local branch worktree-a/);
    expect(push(project)).toContain("[new tag]");
    expect(Object.keys(refsOf(project.origin))).toContain("refs/tags/worktree-a");
  });

  it("is not approved when the name is a branch and a tag", () => {
    const project = createProject();

    git(project.project, "tag", "worktree-a");

    expectAsked(project, /there is a tag named worktree-a too/);
  });

  it("is not approved when the name is some other ref and no branch", () => {
    const project = createProject();

    git(project.project, "update-ref", "refs/remotes/worktree-a", "HEAD");
    git(project.project, "branch", "-D", "worktree-a");

    expectAsked(project, /there is no local branch worktree-a/);
  });
});

describe("a push that would go to another place", () => {
  it("is not approved when origin has a push URL: the commits go there", () => {
    const project = createProject();
    const elsewhere = createBare(project, "elsewhere.git");

    configure(project, "remote.origin.pushurl", elsewhere);

    expectAsked(project, /remote\.origin\.pushurl is set/);
    push(project);
    expect(Object.keys(refsOf(elsewhere))).toEqual(["refs/heads/worktree-a"]);
    expect(Object.keys(refsOf(project.origin))).toEqual(["refs/heads/main"]);
  });

  it("is not approved when origin has two URLs: the commits go to both", () => {
    const project = createProject();
    const elsewhere = createBare(project, "elsewhere.git");

    git(project.project, "config", "--add", "remote.origin.url", elsewhere);

    expectAsked(project, /origin has 2 URLs, and a push goes to each/);
    push(project);
    expect(Object.keys(refsOf(elsewhere))).toEqual(["refs/heads/worktree-a"]);
  });

  it.each([
    ["insteadOf", "insteadOf"],
    ["pushInsteadOf", "pushInsteadOf"],
  ])("is not approved when the repository rewrites origin's address with %s: the commits go there", (_name, key) => {
    const project = createProject();
    const elsewhere = createBare(project, "elsewhere.git");

    configure(project, `url.${elsewhere}.${key}`, project.origin);

    expectAsked(project, new RegExp(`url\\..*\\.${key.toLowerCase()} is set in the repository's own configuration`));
    push(project);
    expect(Object.keys(refsOf(elsewhere))).toEqual(["refs/heads/worktree-a"]);
  });

  it.each([
    ["a command to run", "ext::sh -c 'touch ran'"],
    ["a scheme git has no transport for, which runs git-remote-<scheme>", "evil://example.test/x.git"],
    ["a path that is not whole", "../origin.git"],
    ["plain http", "http://example.test/x.git"],
    ["the git protocol", "git://example.test/x.git"],
    ["an option", "--upload-pack=evil"],
    ["an ssh address whose host is an option", "-oProxyCommand=evil:path"],
  ])("is not approved when origin's address is %s", (_name, url) => {
    const project = createProject();

    git(project.project, "config", "remote.origin.url", url);

    expectAsked(project, /remote\.origin\.url is not a plain address/);
  });

  it.each([["https://github.com/o/r.git"], ["ssh://git@github.com/o/r.git"], ["git@github.com:o/r.git"], ["file:///srv/git/r.git"], ["/srv/git/r.git"]])(
    "takes %s for a plain address",
    (url) => {
      expect(judgeEntry({ scope: "local", key: "remote.origin.url", value: url }, BRANCH)).toBeUndefined();
    },
  );

  it("is not approved when origin's address comes from anywhere but the repository's own configuration", () => {
    expect(judgeEntry({ scope: "global", key: "remote.origin.url", value: "/srv/git/r.git" }, BRANCH)).toBeDefined();
    expect(judgeEntry({ scope: "command", key: "remote.origin.url", value: "/srv/git/r.git" }, BRANCH)).toBeDefined();
    expect(judgeEntry({ scope: "worktree", key: "remote.origin.url", value: "/srv/git/r.git" }, BRANCH)).toBeDefined();
  });

  it("is not approved when there is no origin at all", () => {
    const project = createProject();

    git(project.project, "remote", "remove", "origin");

    expectAsked(project, /there is no remote named origin/);
  });

  it.each([
    ["remote.pushDefault", "remote.pushDefault", "elsewhere"],
    ["the branch's pushRemote", "branch.worktree-a.pushRemote", "elsewhere"],
    ["the branch's remote", "branch.worktree-a.remote", "."],
    ["origin as a mirror", "remote.origin.mirror", "true"],
    ["origin through a helper", "remote.origin.vcs", "ext"],
    ["origin through a proxy", "remote.origin.proxy", "http://example.test"],
  ])("is not approved with %s set", (_name, key, value) => {
    const project = createProject();

    configure(project, key, value);

    expectAsked(project, new RegExp(`${key.toLowerCase().replaceAll(".", "\\.")} is`, "i"));
  });
});

describe("a push that would run a program of the project's", () => {
  it("is not approved when there is a pre-push hook: the push runs it", () => {
    const project = createProject();
    const marker = join(project.home, "pre-push-ran");

    writeHook(join(project.project, ".git/hooks/pre-push"), marker);

    expectAsked(project, /there is a pre-push hook .*which a push runs/);
    push(project);
    expect(existsSync(marker)).toBe(true);
  });

  it("is not approved when core.hooksPath names a folder with a pre-push hook, wherever that is set", () => {
    const project = createProject();
    const marker = join(project.home, "pre-push-ran");

    writeHook(join(project.project, "hooks-here/pre-push"), marker);
    configure(project, "core.hooksPath", "hooks-here");

    expectAsked(project, /there is a pre-push hook .*hooks-here\/pre-push/);
    push(project);
    expect(existsSync(marker)).toBe(true);
  });

  it("is not approved when there is a reference-transaction hook: the push runs it too", () => {
    const project = createProject();
    const marker = join(project.home, "transaction-ran");

    writeHook(join(project.project, ".git/hooks/reference-transaction"), marker);

    expectAsked(project, /there is a reference-transaction hook/);
    push(project);
    expect(existsSync(marker)).toBe(true);
  });

  it("is approved beside the hooks a push does not run, and beside the samples git ships", () => {
    const project = createProject();

    writeHook(join(project.project, ".git/hooks/pre-commit"), join(project.home, "never"));
    writeHook(join(project.project, ".git/hooks/pre-push.sample"), join(project.home, "never"));

    expect(runHook(project, PUSH).decision).toBe("allow");
  });

  it("is not approved when origin names the program to receive with: the push runs it", () => {
    const project = createProject();
    const marker = join(project.home, "receive-ran");

    configure(project, "remote.origin.receivepack", `touch ${marker}; git-receive-pack`);

    expectAsked(project, /remote\.origin\.receivepack is set/);
    push(project);
    expect(existsSync(marker)).toBe(true);
  });

  it.each([
    ["an ssh command", "core.sshCommand", "touch ran; ssh"],
    ["a proxy command", "core.gitProxy", "./proxy.sh"],
    ["a program to ask for a password", "core.askPass", "./ask.sh"],
    ["a credential helper", "credential.helper", "!touch ran"],
    ["a credential helper for one host", "credential.https://github.com.helper", "!touch ran"],
    ["an http proxy", "http.proxy", "http://example.test:3128"],
    ["a protocol let through", "protocol.ext.allow", "always"],
    ["an ssh variant", "ssh.variant", "simple"],
  ])("is not approved when the repository's own configuration names %s", (_name, key, value) => {
    const project = createProject();

    configure(project, key, value);

    expectAsked(project, / is set in the repository's own configuration/);
  });

  it("is not approved when the configuration names a hook, in any scope", () => {
    const project = createProject();

    configure(project, "hook.steal.command", "touch ran");
    configure(project, "hook.steal.event", "pre-push");

    expectAsked(project, /hook\.steal\.(?:command|event) is set, and names a program git runs/);
    expect(judgeEntry({ scope: "global", key: "hook.steal.command", value: "x" }, BRANCH)).toBeDefined();
  });
});

describe("a push that would send more than the branch", () => {
  it.each([
    ["push.followTags", "push.followTags", "true"],
    ["push.recurseSubmodules", "push.recurseSubmodules", "on-demand"],
    ["submodule.recurse", "submodule.recurse", "true"],
    ["a push option for the server", "push.pushOption", "ci.skip"],
    ["a signed push, which runs the signing program", "push.gpgSign", "if-asked"],
    ["a push setting nobody has decided on", "push.someLaterSetting", "true"],
    ["a setting of origin nobody has decided on", "remote.origin.someLaterSetting", "true"],
    ["a setting of the branch nobody has decided on", "branch.worktree-a.someLaterSetting", "true"],
  ])("is not approved with %s", (_name, key, value) => {
    const project = createProject();

    configure(project, key, value);

    expectAsked(project, new RegExp(key.toLowerCase().replaceAll(".", "\\."), "i"));
  });

  it("is not approved with a push.default git does not know, and is with each one it does", () => {
    // Asked of the judge alone: with such a value in its configuration git itself refuses to say which repository a folder is in.
    expect(judgeEntry({ scope: "local", key: "push.default", value: "everything" }, BRANCH)).toBeDefined();

    for (const value of ["simple", "current", "upstream", "tracking", "nothing", "matching"]) {
      expect(judgeEntry({ scope: "local", key: "push.default", value }, BRANCH)).toBeUndefined();
    }
  });

  it("judges those the same in a person's global settings, since they change what is pushed and not how the machine reaches origin", () => {
    const project = createProject();

    writeFile(project.home, ".gitconfig", "[push]\n\tfollowTags = true\n");

    expectAsked(project, /push\.followtags is true/);
  });

  it.each([
    ["push.followTags off", "push.followTags", "false"],
    ["push.recurseSubmodules as a check only", "push.recurseSubmodules", "check"],
    ["submodule.recurse off", "submodule.recurse", "false"],
    ["a setting of another branch", "branch.main.merge", "refs/heads/elsewhere"],
    ["how origin is fetched", "remote.origin.prune", "true"],
    ["a setting that has nothing to do with a push", "diff.renames", "copies"],
  ])("is still approved with %s", (_name, key, value) => {
    const project = createProject();

    configure(project, key, value);

    expect(runHook(project, PUSH).decision).toBe("allow");
  });
});

describe("a setting that reaches git from somewhere other than the repository's config file", () => {
  it("is read from a file the repository's configuration includes", () => {
    const project = createProject();

    writeFile(project.project, "extra.gitconfig", '[remote "origin"]\n\tpush = refs/heads/worktree-a:refs/heads/main\n');
    configure(project, "include.path", "../extra.gitconfig");

    expectAsked(project, /remote\.origin\.push is set in the repository's own configuration/);
  });

  it("is read from a file included on a condition", () => {
    const project = createProject();

    writeFile(project.project, "extra.gitconfig", "[core]\n\tsshCommand = touch ran\n");
    configure(project, "includeIf.gitdir:**.path", "../extra.gitconfig");

    expectAsked(project, /core\.sshcommand is set in the repository's own configuration/);
  });

  it("is read from a worktree's own configuration", () => {
    const project = createProject();

    configure(project, "extensions.worktreeConfig", "true");
    git(project.project, "config", "--worktree", "remote.origin.pushurl", "/elsewhere.git");

    expect(readConfig(project.project, sessionEnvironment(project.home))).toContainEqual({ scope: "worktree", key: "remote.origin.pushurl", value: "/elsewhere.git" });
    expectAsked(project, /remote\.origin\.pushurl is set/);
  });

  it.each([
    ["a setting given in the environment", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: "/elsewhere.git" }, /GIT_CONFIG_/],
    ["a file named as the global configuration", { GIT_CONFIG_GLOBAL: "/tmp/agent-wrote-this" }, /GIT_CONFIG_GLOBAL/],
    ["an ssh command", { GIT_SSH_COMMAND: "touch ran; ssh" }, /GIT_SSH_COMMAND/],
    ["another repository", { GIT_WORK_TREE: "/elsewhere" }, /GIT_WORK_TREE/],
    ["a variable nobody has decided on", { GIT_SOME_LATER_VARIABLE: "1" }, /GIT_SOME_LATER_VARIABLE/],
  ])("is not approved when the session's environment holds %s", (_name, env, reason) => {
    const project = createProject();
    const run = runHook(project, PUSH, { env });

    expect(run.decision).toBe("ask");
    expect(run.reason).toMatch(reason);
  });

  it("is approved with the variables a session has for other reasons", () => {
    const project = createProject();
    const env = { GIT_EDITOR: "true", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.test", GIT_OPTIONAL_LOCKS: "0" };

    expect(runHook(project, PUSH, { env }).decision).toBe("allow");
  });

  it("is listed with its scope, and a key with no value is read as true", () => {
    const project = createProject();

    writeFile(project.home, ".gitconfig", "[push]\n\tfollowTags\n");

    const entries = readConfig(project.project, sessionEnvironment(project.home, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "two\nlines" })) as ConfigEntry[];

    expect(entries).toContainEqual({ scope: "global", key: "push.followtags", value: "true" });
    expect(entries).toContainEqual({ scope: "local", key: "remote.origin.url", value: project.origin });
    expect(entries).toContainEqual({ scope: "command", key: "a.b", value: "two\nlines" });
  });

  it("is not listed at all where git cannot list it, and then nothing is approved", () => {
    const project = createProject();

    expect(readConfig(join(project.project, "gone"), sessionEnvironment(project.home))).toBeUndefined();
    expect(readConfig(project.project, { ...sessionEnvironment(project.home), PATH: project.home })).toBeUndefined();
    expect(obstacle(project.project, BRANCH, { ...sessionEnvironment(project.home), PATH: project.home })).toBe("git could not list its configuration here");
  });
});

describe("a gh call, which chooses its repository from more than origin", () => {
  const CREATE = "gh pr create --head worktree-a --fill";
  const hosting = { hosting: true };

  it("is approved with origin as the only remote", () => {
    const project = createProject();

    expect(obstacle(project.project, hosting, sessionEnvironment(project.home))).toBeUndefined();
    expect(runHook(project, CREATE).decision).toBe("allow");
  });

  it.each([["upstream"], ["github"], ["fork"]])("is not approved with a second remote named %s", (name) => {
    const project = createProject();

    git(project.project, "remote", "add", name, "https://github.com/someone/else.git");

    const run = runHook(project, CREATE);

    expect(run.decision).toBe("ask");
    expect(run.reason).toContain(`there is a second remote, ${name}, and gh may choose it`);
    // A push names its remote, so a second one changes nothing for it.
    expect(runHook(project, PUSH).decision).toBe("allow");
  });

  it("is not approved when a remote is marked as the one gh resolved", () => {
    const project = createProject();

    configure(project, "remote.origin.gh-resolved", "base");

    expect(runHook(project, CREATE).reason).toContain("remote.origin.gh-resolved is set, which tells gh which repository to use");
    expect(runHook(project, PUSH).decision).toBe("allow");
  });

  it.each([
    ["GH_REPO", { GH_REPO: "someone/else" }],
    ["GH_HOST", { GH_HOST: "example.test" }],
    ["GH_CONFIG_DIR", { GH_CONFIG_DIR: "/tmp/agent-wrote-this" }],
    ["a GH_ variable nobody has decided on", { GH_SOME_LATER_VARIABLE: "1" }],
  ])("is not approved with %s in the session's environment", (_name, env) => {
    const project = createProject();
    const run = runHook(project, CREATE, { env });

    expect(run.decision).toBe("ask");
    expect(run.reason).toContain(`the variable ${Object.keys(env)[0]} is set in the session`);
    expect(runHook(project, PUSH, { env }).decision).toBe("allow");
  });

  it("is approved with a token in the session's environment", () => {
    expect(runHook(createProject(), CREATE, { env: { GH_TOKEN: "x", GH_PROMPT_DISABLED: "1" } }).decision).toBe("allow");
  });

  it("is held to the settings a push is held to", () => {
    const project = createProject();

    configure(project, `url.${project.home}.insteadOf`, project.origin);

    expect(runHook(project, CREATE).decision).toBe("ask");
  });

  it("is not held to the branch being a plain branch here, since it pushes nothing", () => {
    const project = createProject();

    writeHook(join(project.project, ".git/hooks/pre-push"), join(project.home, "never"));

    expect(runHook(project, CREATE).decision).toBe("allow");
  });
});

// The near-miss sweep of `approve.test.mts` asks about words, with a checkout
// nothing is unusual about. This one turns it round: every approved command,
// in a real checkout with one thing changed that an agent can change without
// being asked. The hook is given the real checks, and must approve none.
describe("every approved command, in every checkout that is not plain", () => {
  const pushes = APPROVED.map(([command]) => command).filter((command) => command.startsWith("git"));
  const hosted = APPROVED.map(([command]) => command).filter((command) => command.startsWith("gh"));
  const answersIn = (project: Project, commands: string[], env: Record<string, string> = {}): string[] =>
    commands.map(
      (command) =>
        judgeCall(
          { tool_name: "Bash", tool_input: { command }, cwd: project.project, permission_mode: "default" },
          {
            settings: { approvePushAndCreate: true, approveMerge: true },
            isOwnCheckout: () => true,
            obstacle: (cwd, shape) => checkoutObstacle(cwd, shape, sessionEnvironment(project.home, env)),
          },
        )?.decision ?? "",
    );

  it("is tried with every push, every pull request opened and every merge in the table", () => {
    expect(pushes.length).toBeGreaterThan(5);
    expect(hosted.length).toBeGreaterThan(15);
    expect(pushes.length + hosted.length).toBe(APPROVED.length);
    expect(CONFIGURATIONS.length).toBeGreaterThan(35);
    expect(new Set(CONFIGURATIONS.map(([name]) => name)).size).toBe(CONFIGURATIONS.length);
  });

  it("approves every push and every pull request opened in the plain checkout, so the sweep is known to ask something", () => {
    const project = createProject();

    // The pushes in the table name branches of their own.
    for (const branch of ["worktree-rates-filter", "worktree-a.b_c-1", LONGEST]) {
      git(project.project, "branch", branch);
    }

    expect(answersIn(project, pushes)).toEqual(pushes.map(() => "allow"));
    expect(answersIn(project, hosted.filter((command) => command.includes("pr create")))).toEqual(hosted.filter((command) => command.includes("pr create")).map(() => "allow"));
  });

  it.each(CONFIGURATIONS)("approves none of them with %s", (_name, stops, change, env = {}) => {
    const project = createProject();

    for (const branch of ["worktree-rates-filter", "worktree-a.b_c-1", LONGEST]) {
      git(project.project, "branch", branch);
    }

    change(project);

    const commands = [...(stops === "gh" ? [] : pushes.filter((command) => stops !== "a push of worktree-a" || / worktree-a(?: |$)/.test(command))), ...(stops === "gh" || stops === "every step" ? hosted : [])];
    const answers = answersIn(project, commands, env);

    expect(commands.length).toBeGreaterThan(3);
    expect(answers.filter((answer) => answer === "allow")).toEqual([]);
    // Each is an exact shape, so each is asked about, with a reason.
    expect(answers.filter((answer) => answer !== "ask")).toEqual([]);
  });
});

type Stops = "every step" | "a push" | "a push of worktree-a" | "gh";

/** One change to a plain checkout, what it must stop, and the variables it adds to the session, if any. */
const CONFIGURATIONS: [name: string, stops: Stops, change: (project: Project) => void, env?: Record<string, string>][] = [
  ["the branch tracking main under push.default upstream", "a push of worktree-a", (project) => {
    configure(project, "push.default", "upstream");
    configure(project, "branch.worktree-a.remote", "origin");
    configure(project, "branch.worktree-a.merge", "refs/heads/main");
  }],
  ["the branch tracking main", "a push of worktree-a", (project) => configure(project, "branch.worktree-a.merge", "refs/heads/main")],
  ["a push refspec on origin", "every step", (project) => configure(project, "remote.origin.push", "+refs/heads/*:refs/heads/main")],
  ["the branch as a symbolic ref to main", "a push of worktree-a", ({ project }) => {
    git(project, "branch", "-D", "worktree-a");
    git(project, "symbolic-ref", "refs/heads/worktree-a", "refs/heads/main");
  }],
  ["a tag of the same name and no branch", "a push of worktree-a", ({ project }) => {
    git(project, "tag", "worktree-a", "worktree-a");
    git(project, "branch", "-D", "worktree-a");
  }],
  ["a tag of the same name beside the branch", "a push of worktree-a", ({ project }) => git(project, "tag", "worktree-a")],
  ["a push URL on origin", "every step", (project) => configure(project, "remote.origin.pushurl", "/elsewhere.git")],
  ["a second URL on origin", "every step", ({ project }) => git(project, "config", "--add", "remote.origin.url", "/elsewhere.git")],
  ["origin's address rewritten by insteadOf", "every step", (project) => configure(project, "url./elsewhere.git.insteadOf", project.origin)],
  ["origin's address rewritten by pushInsteadOf", "every step", (project) => configure(project, "url./elsewhere.git.pushInsteadOf", project.origin)],
  ["origin's address a command", "every step", ({ project }) => git(project, "config", "remote.origin.url", "ext::sh -c true")],
  ["origin's address a scheme with no transport", "every step", ({ project }) => git(project, "config", "remote.origin.url", "evil://example.test/x")],
  ["origin as a mirror", "every step", (project) => configure(project, "remote.origin.mirror", "true")],
  ["a program to receive with", "every step", (project) => configure(project, "remote.origin.receivepack", "touch ran; git-receive-pack")],
  ["a helper for origin", "every step", (project) => configure(project, "remote.origin.vcs", "ext")],
  ["remote.pushDefault elsewhere", "every step", (project) => configure(project, "remote.pushDefault", "elsewhere")],
  ["the branch's pushRemote elsewhere", "a push of worktree-a", (project) => configure(project, "branch.worktree-a.pushRemote", "elsewhere")],
  ["the branch's remote elsewhere", "a push of worktree-a", (project) => configure(project, "branch.worktree-a.remote", "elsewhere")],
  ["push.followTags", "every step", (project) => configure(project, "push.followTags", "true")],
  ["push.recurseSubmodules on demand", "every step", (project) => configure(project, "push.recurseSubmodules", "on-demand")],
  ["submodule.recurse", "every step", (project) => configure(project, "submodule.recurse", "true")],
  ["a push option", "every step", (project) => configure(project, "push.pushOption", "ci.skip")],
  ["a signed push", "every step", (project) => configure(project, "push.gpgSign", "true")],
  ["an ssh command in the repository", "every step", (project) => configure(project, "core.sshCommand", "touch ran; ssh")],
  ["a credential helper in the repository", "every step", (project) => configure(project, "credential.helper", "!touch ran")],
  ["a proxy in the repository", "every step", (project) => configure(project, "http.proxy", "http://example.test")],
  ["a protocol let through in the repository", "every step", (project) => configure(project, "protocol.ext.allow", "always")],
  ["a hook named in the configuration", "every step", (project) => configure(project, "hook.steal.command", "touch ran")],
  ["a pre-push hook", "a push", ({ project }) => writeHook(join(project, ".git/hooks/pre-push"), "/dev/null")],
  ["a reference-transaction hook", "a push", ({ project }) => writeHook(join(project, ".git/hooks/reference-transaction"), "/dev/null")],
  ["core.hooksPath at a folder with a pre-push hook", "a push", (project) => {
    writeHook(join(project.project, "hooks-here/pre-push"), "/dev/null");
    configure(project, "core.hooksPath", "hooks-here");
  }],
  ["a redirect in an included file", "every step", (project) => {
    writeFile(project.project, "extra.gitconfig", '[remote "origin"]\n\tpushurl = /elsewhere.git\n');
    configure(project, "include.path", "../extra.gitconfig");
  }],
  ["a redirect in a worktree's own configuration", "every step", (project) => {
    configure(project, "extensions.worktreeConfig", "true");
    git(project.project, "config", "--worktree", "remote.origin.pushurl", "/elsewhere.git");
  }],
  ["a redirect given in the environment", "every step", () => undefined, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl", GIT_CONFIG_VALUE_0: "/elsewhere.git" }],
  ["an ssh command in the environment", "every step", () => undefined, { GIT_SSH_COMMAND: "touch ran; ssh" }],
  ["another file named as the global configuration", "every step", () => undefined, { GIT_CONFIG_GLOBAL: "/dev/null" }],
  ["another repository named in the environment", "every step", () => undefined, { GIT_DIR: "/elsewhere/.git" }],
  ["followTags in the person's global settings", "every step", ({ home }) => writeFile(home, ".gitconfig", "[push]\n\tfollowTags = true\n")],
  ["no origin", "every step", ({ project }) => git(project, "remote", "remove", "origin")],
  ["a second remote named upstream", "gh", ({ project }) => git(project, "remote", "add", "upstream", "https://github.com/someone/else.git")],
  ["a second remote named github", "gh", ({ project }) => git(project, "remote", "add", "github", "https://github.com/someone/else.git")],
  ["a remote marked as the one gh resolved", "gh", (project) => configure(project, "remote.origin.gh-resolved", "base")],
  ["GH_REPO in the environment", "gh", () => undefined, { GH_REPO: "someone/else" }],
  ["GH_HOST in the environment", "gh", () => undefined, { GH_HOST: "example.test" }],
  ["GH_CONFIG_DIR in the environment", "gh", () => undefined, { GH_CONFIG_DIR: "/tmp/elsewhere" }],
];

/** Sets one key in the repository's own configuration. */
function configure({ project }: Project, key: string, value: string): void {
  git(project, "config", key, value);
}

/** Puts a commit on `worktree-a` that `main` does not have. */
function advance({ project }: Project): void {
  git(project, "checkout", "--quiet", "worktree-a");
  commit(project, "work", { "work.txt": "x\n" });
  git(project, "checkout", "--quiet", "main");
}

/** Runs the push the hook was asked about, as the session would, and returns what git said. */
function push({ project, home }: Project): string {
  const run = spawnSync("git", ["push", "origin", "worktree-a"], { cwd: project, encoding: "utf8", env: sessionEnvironment(home) });

  return `${run.stdout}${run.stderr}`;
}

function createBare({ project }: Project, name: string): string {
  const folder = join(project, "..", name);

  mkdirSync(folder);
  git(folder, "init", "--quiet", "--bare", "--initial-branch=main");

  return join(folder);
}

function refsOf(repository: string): Record<string, string> {
  const listed = git(repository, "for-each-ref", "--format=%(refname) %(objectname)");

  return Object.fromEntries(listed === "" ? [] : listed.split("\n").map((line) => line.split(" ") as [string, string]));
}

function refOf({ project }: Project, name: string): string {
  return git(project, "rev-parse", name);
}

/** A hook that leaves `marker` behind when it runs. */
function writeHook(file: string, marker: string): void {
  writeFile(file, "", `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(file, 0o755);
}

/** The hook asks, gives this reason, and so does the function it asks. */
function expectAsked(project: Project, reason: RegExp): void {
  const run = runHook(project, PUSH);

  expect(obstacle(project.project, BRANCH, sessionEnvironment(project.home))).toMatch(reason);
  expect(run.decision).toBe("ask");
  expect(run.reason).toMatch(reason);
  expect(run.reason).toContain("Not approved by tools/agent-workflow, though it is a push of the work branch worktree-a to origin in the exact form");
}
