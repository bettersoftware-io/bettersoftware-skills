import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { type Approval, APPROVING_HOST, type CommandPayload, judgeCall, mayApprove } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { approvedShape, readExact } from "../files/tools/agent-workflow/lib/approve.mts";
import { approvableCommand } from "../files/tools/agent-workflow/lib/call.mts";
import { APPROVING_HOST as HOST_IN_CHECK, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, CONFIG_FILE, HOOK_SCRIPT } from "../files/tools/agent-workflow/lib/host.mts";
import { judgeCommand } from "../files/tools/agent-workflow/lib/outward.mts";
import { commonDirectory, isCheckoutOf } from "../files/tools/agent-workflow/lib/repository.mts";
import { APPROVED, NEAR_MISSES } from "./shapes.mts";
import { ADDON, commit, createFolder, createRemote, git, readJson, writeFile } from "./support.mts";

/** A folder that stands for a checkout of the project in tests that never ask git. */
const HOME = "/project";
/** An approval that takes `HOME` for the project's checkout, and nothing else. */
const IN_PROJECT: Approval = { isOwnCheckout: (cwd) => cwd === HOME };

describe("a routine outward step in its exact form", () => {
  it.each(APPROVED)("is approved: %s", (command, shape) => {
    expect(approvedShape(command)).toBe(shape);
  });

  it.each(APPROVED)("is one outward step and no chain, as the refusal reads it: %s", (command) => {
    expect(judgeCommand(command)).toMatchObject({ chained: false });
    expect(judgeCommand(command)?.outward).toHaveLength(1);
  });

  // Read with a model of the documented matching (`*` is any text). An ask
  // rule wins over the hook, so a command both approve would still ask.
  it.each(APPROVED)("meets no ask rule, so the approval is not undone by one: %s", (command) => {
    const matching = ASK_RULES.filter((rule) =>
      new RegExp(`^${rule.slice("Bash(".length, -1).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^]*")}$`).test(command),
    );

    expect(matching).toEqual([]);
  });

  it("covers the three shapes", () => {
    expect([...new Set(APPROVED.map(([command]) => approvedShape(command)?.replace(/worktree-\S+|\d+/, "…")))]).toEqual([
      "a push of the work branch … to origin",
      "opening a pull request",
      "merging pull request …",
    ]);
  });

});

describe("a command one step away from an approved one", () => {
  it("is tried in more than a hundred and fifty ways, no two the same", () => {
    expect(NEAR_MISSES.length).toBeGreaterThan(150);
    expect(new Set(NEAR_MISSES.map(([, command]) => command)).size).toBe(NEAR_MISSES.length);
  });

  it.each(NEAR_MISSES)("is not approved: %s", (_name, command) => {
    expect(approvedShape(command)).toBeUndefined();
  });

  it.each(NEAR_MISSES)("is not approved by the hook either: %s", (_name, command) => {
    expect(judgeCall(createCall(command), IN_PROJECT)?.decision).not.toBe("allow");
  });
});

describe("the reader", () => {
  it("knows three kinds of token and two marks", () => {
    expect(readExact("a-b_c./1 'x $y' \"p q\" 2>&1 | tail")).toEqual([
      { kind: "bare", value: "a-b_c./1" },
      { kind: "single", value: "x $y" },
      { kind: "double", value: "p q" },
      { kind: "mark", value: "2>&1" },
      { kind: "mark", value: "|" },
      { kind: "bare", value: "tail" },
    ]);
  });

  it("keeps a new line and a tab inside quotes as they are", () => {
    expect(readExact("'a\n\tb' \"c\n\td\"")).toEqual([
      { kind: "single", value: "a\n\tb" },
      { kind: "double", value: "c\n\td" },
    ]);
  });

  it("reads text of the longest length it takes, and nothing longer", () => {
    expect(readExact(`'${"x".repeat(19_998)}'`)).toHaveLength(1);
    expect(readExact(`'${"x".repeat(19_999)}'`)).toBeUndefined();
  });

  it.each([
    ["a variable", "$HOME"],
    ["a variable in a word", "a$b"],
    ["a glob", "*.md"],
    ["a question mark", "a?"],
    ["a bracket", "[a]"],
    ["a brace", "{a,b}"],
    ["a tilde", "~"],
    ["a backslash", "a\\b"],
    ["a backtick", "`a`"],
    ["a substitution", "$(a)"],
    ["a substitution in double quotes", '"$(a)"'],
    ["a heredoc in a substitution in double quotes", "\"$(cat <<'E'\nx\nE\n)\""],
    ["a heredoc", "<<'E'\nx\nE"],
    ["a process substitution", "<(a)"],
    ["a redirection", ">f"],
    ["a redirection with a space after it", "> f"],
    ["an input redirection", "<f"],
    ["a semicolon", ";"],
    ["an ampersand", "&"],
    ["a hash", "#a"],
    ["a hash inside a word", "a#b"],
    ["a new line", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a non-breaking space", "a b"],
    ["a colon", "a:b"],
    ["a plus", "+a"],
    ["an equals sign", "a=b"],
    ["an equals sign at the start of a word", "=ls"],
    ["an at sign", "a@b"],
    ["a percent sign", "%1"],
    ["a caret", "a^b"],
    ["a comma", "a,b"],
    ["an exclamation mark outside quotes", "a!"],
    ["an exclamation mark in double quotes", '"a!"'],
    ["a quote that never closes", "'a"],
    ["a double quote that never closes", '"a'],
    ["a variable in double quotes", '"a $b"'],
    ["a backtick in double quotes", '"a `b`"'],
    ["a backslash in double quotes", '"a\\nb"'],
    ["a carriage return in single quotes", "'a\rb'"],
    ["a carriage return in double quotes", '"a\rb"'],
    ["a NUL in single quotes", "'a\u0000b'"],
    ["an escape character in double quotes", '"a\u001bb"'],
    ["a delete character in single quotes", "'a\u007fb'"],
    ["a letter that is not ASCII outside quotes", "café"],
    ["two quotes joined", "'a''b'"],
    ["a mark joined to a word", "2>&1x"],
    ["two pipes", "||"],
  ])("has no token for %s", (_name, text) => {
    expect(readExact(text)).toBeUndefined();
    expect(readExact(`git ${text} push`)).toBeUndefined();
  });
});

describe("the call the command arrives in", () => {
  const command = "git push -u origin worktree-a";
  const isOwn = (cwd: string): boolean => cwd === HOME;

  it("may be approved when the tool is Bash, its fields are known and plain, and it runs in the project", () => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME }, isOwn)).toBe(command);
    expect(
      approvableCommand(
        { tool_name: "Bash", tool_input: { command, description: "Push the branch", timeout: 120_000, run_in_background: false, dangerouslyDisableSandbox: false }, cwd: HOME },
        isOwn,
      ),
    ).toBe(command);
  });

  it.each([
    ["another tool", "Shell"],
    ["the same tool in another case", "bash"],
    ["a tool whose name only starts the same", "BashOutput"],
    ["an MCP tool", "mcp__shell__run"],
    ["no tool name", undefined],
    ["a tool name that is not text", ["Bash"]],
  ])("may not be approved for %s", (_name, tool) => {
    expect(approvableCommand({ tool_name: tool, tool_input: { command }, cwd: HOME }, isOwn)).toBeUndefined();
  });

  it.each([
    ["in the background", { run_in_background: true }],
    ["in the background, said as a word", { run_in_background: "false" }],
    ["with the sandbox off", { dangerouslyDisableSandbox: true }],
    ["with the sandbox setting empty", { dangerouslyDisableSandbox: null }],
    ["with a field nobody has decided on", { shell: "/bin/bash" }],
    ["with a working folder of its own", { cwd: "/elsewhere" }],
    ["with variables of its own", { env: { GIT_DIR: "/elsewhere/.git" } }],
    ["with input of its own", { stdin: "y\n" }],
    ["with a field every object has", { constructor: true }],
    ["with another field every object has", { toString: "x" }],
  ])("may not be approved when it runs %s", (_name, extra) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command, ...extra }, cwd: HOME }, isOwn)).toBeUndefined();
  });

  it.each([
    ["a list of words", ["git", "push", "-u", "origin", "worktree-a"]],
    ["missing", undefined],
    ["a number", 1],
  ])("may not be approved when its command is %s", (_name, value) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command: value }, cwd: HOME }, isOwn)).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["a list", [command]],
    ["text", command],
    ["nothing", null],
  ])("may not be approved when its input is %s", (_name, input) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: input, cwd: HOME }, isOwn)).toBeUndefined();
  });

  it.each([
    ["not said", undefined],
    ["empty", ""],
    ["not text", 3],
    ["another folder", "/elsewhere"],
    ["a folder that only starts the same", `${HOME}-other`],
  ])("may not be approved when where it runs is %s", (_name, cwd) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd }, isOwn)).toBeUndefined();
  });

  it("does not ask where the call runs before the rest of it is known to be plain", () => {
    const asked: string[] = [];
    const record = (cwd: string): boolean => {
      asked.push(cwd);

      return true;
    };

    approvableCommand({ tool_name: "Write", tool_input: { command }, cwd: HOME }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command, run_in_background: true }, cwd: HOME }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: "" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: undefined }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command: ["git", "push"] }, cwd: HOME }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME }, record);

    expect(asked).toEqual([HOME]);
  });
});

describe("where the project's repository is", () => {
  it("is the same place for the main checkout, a worktree of it, and a folder inside either", () => {
    const { clone } = createRemote();
    const worktree = join(dirname(clone), "a-worktree");

    git(clone, "worktree", "add", "--quiet", "-b", "worktree-a", worktree);
    mkdirSync(join(worktree, "deep/er"), { recursive: true });

    expect(commonDirectory(clone)).toBe(join(clone, ".git"));
    expect(commonDirectory(worktree)).toBe(join(clone, ".git"));
    expect(isCheckoutOf(worktree, clone)).toBe(true);
    expect(isCheckoutOf(join(worktree, "deep/er"), clone)).toBe(true);
    expect(isCheckoutOf(clone, join(worktree, "deep"))).toBe(true);
  });

  it("is not the same for another clone of the same remote, or for a repository inside the project", () => {
    const { clone, other } = createRemote();
    const inside = join(clone, "vendor/thing");

    mkdirSync(inside, { recursive: true });
    git(inside, "init", "--quiet");

    expect(isCheckoutOf(other, clone)).toBe(false);
    expect(isCheckoutOf(inside, clone)).toBe(false);
    expect(isCheckoutOf(clone, clone)).toBe(true);
  });

  it("is nowhere for a folder that is in no repository, does not exist, or is not given whole", () => {
    const { clone } = createRemote();
    const plain = createFolder();

    expect(commonDirectory(plain)).toBeUndefined();
    // The tests themselves run inside a repository: a path that is not whole must not be read from here.
    expect(commonDirectory(process.cwd())).toBeDefined();
    expect(commonDirectory(".")).toBeUndefined();
    expect(isCheckoutOf(plain, clone)).toBe(false);
    expect(isCheckoutOf(join(clone, "gone"), clone)).toBe(false);
    expect(isCheckoutOf(".", clone)).toBe(false);
    expect(isCheckoutOf(plain, plain)).toBe(false);
  });

  it("is not the project's when a variable points git at another repository from inside the project", () => {
    const { clone, other } = createRemote();

    // A push from here would go to `other`: git reads the variable, not the folder.
    expect(isCheckoutOf(clone, clone, { ...process.env, GIT_DIR: join(other, ".git") })).toBe(false);
    expect(isCheckoutOf(clone, clone, { ...process.env, GIT_DIR: join(clone, ".git") })).toBe(true);
  });
});

describe("the hook's answer, by what it is allowed to do", () => {
  const push = createCall("git push -u origin worktree-a");

  it("approves an exact shape when it may, and says what it approved", () => {
    expect(judgeCall(push, IN_PROJECT)).toEqual({
      decision: "allow",
      reason: "Approved by tools/agent-workflow: a push of the work branch worktree-a to origin, in the exact form the project pre-approves.",
    });
  });

  it("says nothing about the same command when it may not approve", () => {
    expect(judgeCall(push)).toBeUndefined();
    expect(judgeCall(push, undefined)).toBeUndefined();
  });

  it("refuses a chain whether it may approve or not, even one that starts as an approved shape", () => {
    const chain = createCall("git push -u origin worktree-a && gh pr create --fill");

    expect(judgeCall(chain, IN_PROJECT)?.decision).toBe("deny");
    expect(judgeCall(chain)?.decision).toBe("deny");
  });

  it("refuses a chain from any tool and with any field, where it approves nothing", () => {
    const chain = "git commit -m wip && git push -u origin worktree-a";

    expect(judgeCall({ tool_name: "Shell", tool_input: { command: chain, run_in_background: true } }, IN_PROJECT)?.decision).toBe("deny");
    expect(judgeCall({ tool_input: { command: ["bash", "-lc", chain] }, cwd: "/elsewhere" }, IN_PROJECT)?.decision).toBe("deny");
  });

  it.each([
    ["another tool", { tool_name: "Shell" }],
    ["no tool name", { tool_name: undefined }],
    ["another folder", { cwd: "/elsewhere" }],
    ["no folder", { cwd: undefined }],
    ["the background", { tool_input: { command: "git push -u origin worktree-a", run_in_background: true } }],
    ["the sandbox off", { tool_input: { command: "git push -u origin worktree-a", dangerouslyDisableSandbox: true } }],
    ["a field nobody has decided on", { tool_input: { command: "git push -u origin worktree-a", shell: "/bin/bash" } }],
    ["a list of words", { tool_input: { command: ["git", "push", "-u", "origin", "worktree-a"] } }],
  ])("says nothing about an exact shape that arrives with %s", (_name, change) => {
    expect(judgeCall({ ...push, ...change } as CommandPayload, IN_PROJECT)).toBeUndefined();
  });

  it("says nothing about an outward step that is alone and not one of the shapes", () => {
    expect(judgeCall(createCall("git push origin main"), IN_PROJECT)).toBeUndefined();
    expect(judgeCall(createCall("gh workflow run ci.yml"), IN_PROJECT)).toBeUndefined();
  });
});

// Not a proof, a sweep: every approved command and every near-miss, joined to
// others by every way a shell joins two commands, and wrapped the ways a
// shell wraps one. Whatever the hook approves must be approved as a whole,
// and must be something the refusal has no quarrel with.
describe("the hook, over thousands of commands put together from the tables", () => {
  const pieces = [...APPROVED.map(([command]) => command), ...NEAR_MISSES.map(([, command]) => command)];
  const joins = [" && ", "; ", " || ", " & ", "\n", " | ", " |& ", ";", "&&"];
  const wraps: ((command: string) => string)[] = [
    (command) => `(${command})`,
    (command) => `{ ${command}; }`,
    (command) => `echo "$(${command})"`,
    (command) => `echo \`${command}\``,
    (command) => `bash -c '${command.replaceAll("'", "'\\''")}'`,
    (command) => `cd /elsewhere && ${command}`,
    (command) => `${command} > out.log`,
    (command) => `X=1 ${command}`,
    (command) => ` ${command}`,
    (command) => `${command}\n`,
  ];
  const generated = [
    ...APPROVED.flatMap(([approved]) => pieces.flatMap((piece, index) => (index % 3 === 0 ? joins.flatMap((join) => [`${approved}${join}${piece}`, `${piece}${join}${approved}`]) : []))),
    ...pieces.flatMap((piece) => wraps.map((wrap) => wrap(piece))),
    ...pieces,
  ];
  const allowed = generated.filter((command) => judgeCall(createCall(command), IN_PROJECT)?.decision === "allow");

  it("is asked about more than five thousand", () => {
    expect(generated.length).toBeGreaterThan(5000);
  });

  it("never approves one that is not approved as a whole and clean for the refusal", () => {
    expect(allowed.filter((command) => approvedShape(command) === undefined || judgeCommand(command)?.chained !== false)).toEqual([]);
  });

  it("approves the approved commands, the same with a space in front, and no other", () => {
    const expected = APPROVED.flatMap(([command]) => [command, ` ${command}`]);

    expect([...allowed].sort()).toEqual([...expected].sort());
  });

  it("never approves any of them for a call in another folder, from another tool, or in the background", () => {
    const calls = generated.flatMap((command) => [
      { ...createCall(command), cwd: "/elsewhere" },
      { ...createCall(command), tool_name: "Shell" },
      { ...createCall(command), tool_input: { command, run_in_background: true } },
    ]);

    expect(calls.filter((call) => judgeCall(call, IN_PROJECT)?.decision === "allow")).toEqual([]);
  });

  it("refuses every one that joins an approved command to another", () => {
    const [push] = APPROVED[0] as [string, string];
    const joined = [" && ", "; ", " || ", "\n"].flatMap((join) => APPROVED.map(([other]) => `${push}${join}${other}`));

    expect(joined.filter((command) => judgeCall(createCall(command), IN_PROJECT)?.decision !== "deny")).toEqual([]);
  });
});

describe("whether the hook may approve", () => {
  it("needs the host's argument and the project's setting, both", async () => {
    const on = createConfig("export const approveExactShapes: boolean = true;\n");

    await expect(mayApprove([APPROVING_HOST], on)).resolves.toBe(true);
    await expect(mayApprove([], on)).resolves.toBe(false);
    await expect(mayApprove(["--host=codex"], on)).resolves.toBe(false);
    await expect(mayApprove(["--host=claude-code-2"], on)).resolves.toBe(false);
  });

  it.each([
    ["set to false", "export const approveExactShapes: boolean = false;\n"],
    ["set to a word", 'export const approveExactShapes = "true";\n'],
    ["set to 1", "export const approveExactShapes = 1;\n"],
    ["not set", "export const somethingElse = true;\n"],
    ["a file that throws", 'throw new Error("broken");\n'],
    ["not TypeScript", "export const = ;\n"],
  ])("does not approve when the setting is %s", async (_name, content) => {
    await expect(mayApprove([APPROVING_HOST], createConfig(content))).resolves.toBe(false);
  });

  it("does not approve when there is no setting file", async () => {
    await expect(mayApprove([APPROVING_HOST], pathToFileURL(join(createFolder(), "tools/agent-workflow.config.mts")))).resolves.toBe(false);
  });

  it("is on in the file a project starts with", async () => {
    await expect(mayApprove([APPROVING_HOST], pathToFileURL(join(ADDON, "files", CONFIG_FILE)))).resolves.toBe(true);
    await expect(mayApprove([APPROVING_HOST])).resolves.toBe(true);
  });

  it("is spelled the same where the hook reads it and where the check looks for it", () => {
    expect(HOST_IN_CHECK).toBe(APPROVING_HOST);
  });
});

// The hook as each host starts it: the arguments are taken from the command
// the add-on's manifest registers for that host, not written again here. The
// project is a real repository, and the payload says the call runs in it.
describe("the hook run as a program, the way each host's settings start it", () => {
  const approved = "git push -u origin worktree-a 2>&1 | tail -2";
  const unanswered = "git push origin main";
  const refused = "git commit -m wip && git push -u origin worktree-a";

  it("is started with the approving argument by Claude Code's settings, and without it by Codex's", () => {
    expect(argumentsFor(CLAUDE_SETTINGS)).toEqual([APPROVING_HOST]);
    expect(argumentsFor(CODEX_HOOKS)).toEqual([]);
  });

  it("answers Claude Code: allow for an exact shape, nothing for another lone step, deny for a chain", () => {
    const project = createProject();

    expect(decisionOf(project, CLAUDE_SETTINGS, approved)).toBe("allow");
    expect(decisionOf(project, CLAUDE_SETTINGS, unanswered)).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, refused)).toBe("deny");
  });

  it("never answers Codex with allow: nothing for an exact shape, nothing for another lone step, deny for a chain", () => {
    const project = createProject();

    expect(decisionOf(project, CODEX_HOOKS, approved)).toBe("");
    expect(decisionOf(project, CODEX_HOOKS, unanswered)).toBe("");
    expect(decisionOf(project, CODEX_HOOKS, refused)).toBe("deny");
  });

  it("approves a pull request with a body of several lines", () => {
    const body = "gh pr create --title 'Add the price list' --body '## Summary\n\n- one\n- two'";

    expect(decisionOf(createProject(), CLAUDE_SETTINGS, body)).toBe("allow");
  });

  it("answers nothing for the heredoc whose body bash 3.2 runs", () => {
    const escape = "gh pr create --title \"a\" --body \"$(cat <<'EOF'\nsee (link) and a ) \" ; echo ESCAPED-1 ; \"\nit's `echo ESCAPED-2` $(echo ESCAPED-3)\nEOF\n)\"";
    const run = runHook(createProject(), CLAUDE_SETTINGS, escape);

    expect(run.stdout).toBe("");
    expect(run.status).toBe(0);
  });

  it("approves in a worktree of the project, and in a folder inside it", () => {
    const project = createProject();
    const worktree = join(dirname(project), "a-worktree");

    commit(project, "the project", {});
    git(project, "worktree", "add", "--quiet", "-b", "worktree-a", worktree);

    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { cwd: worktree })).toBe("allow");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { cwd: join(project, "tools") })).toBe("allow");
  });

  it("answers nothing for an exact shape that would run in another repository, or says no folder", () => {
    const project = createProject();
    const { clone } = createRemote();

    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { cwd: clone })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { cwd: dirname(project) })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { cwd: undefined })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, refused, { cwd: clone })).toBe("deny");
  });

  it("answers nothing for an exact shape from another tool, in the background, or with a field it does not know", () => {
    const project = createProject();

    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { tool_name: "Shell" })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { tool_input: { command: approved, run_in_background: true } })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { tool_input: { command: approved, dangerouslyDisableSandbox: true } })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { tool_input: { command: approved, workdir: "/elsewhere" } })).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, approved, { tool_input: { command: approved, description: "Push", timeout: 5000, run_in_background: false } })).toBe("allow");
  });

  it("answers Codex with nothing for every approved command, so it is never sent a decision it does not take", () => {
    const project = createProject();

    for (const [command] of APPROVED) {
      expect(decisionOf(project, CODEX_HOOKS, command), command).toBe("");
    }
  });

  it("approves nothing once the project turns approval off, and still refuses a chain", () => {
    const project = createProject();

    writeFile(project, CONFIG_FILE, "export const approveExactShapes: boolean = false;\n");

    expect(decisionOf(project, CLAUDE_SETTINGS, approved)).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, refused)).toBe("deny");
    expect(decisionOf(project, CODEX_HOOKS, refused)).toBe("deny");
  });

  it("approves nothing when the setting file is gone, and still refuses a chain", () => {
    const project = createProject();

    rmSync(join(project, CONFIG_FILE));

    expect(decisionOf(project, CLAUDE_SETTINGS, approved)).toBe("");
    expect(decisionOf(project, CLAUDE_SETTINGS, refused)).toBe("deny");
  });

  it("prints one line of JSON with the reason when it approves, and exits 0", () => {
    const run = runHook(createProject(), CLAUDE_SETTINGS, approved);
    const reply = JSON.parse(run.stdout) as { hookSpecificOutput: Record<string, string> };

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(Object.keys(reply)).toEqual(["hookSpecificOutput"]);
    expect(reply.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Approved by tools/agent-workflow: a push of the work branch worktree-a to origin, in the exact form the project pre-approves.",
    });
  });
});

/** A plain Bash call for `command`, run in the project. */
function createCall(command: string): CommandPayload {
  return { tool_name: "Bash", tool_input: { command }, cwd: HOME };
}

/** A setting file with `content`, at the place it has in a project. */
function createConfig(content: string): URL {
  return pathToFileURL(join(createFolder({ "tools/agent-workflow.config.mts": content }), "tools/agent-workflow.config.mts"));
}

/** A git repository with the add-on's tools and its setting file where a project has them. */
function createProject(): string {
  const project = join(createFolder(), "project");

  cpSync(join(ADDON, "files/tools"), join(project, "tools"), { recursive: true });
  git(project, "init", "--quiet", "--initial-branch=main");

  return project;
}

/** What follows the script's path in the command the manifest registers for a host. */
function argumentsFor(settings: string): string[] {
  const manifest = readJson<{ hostSettings: Record<string, { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }> }>(ADDON, "addon.json");
  const command = manifest.hostSettings[settings]?.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  const after = command.slice(command.indexOf(HOOK_SCRIPT) + HOOK_SCRIPT.length).replace(/^"/, "");

  expect(command).toContain(HOOK_SCRIPT);

  return after.split(" ").filter(Boolean);
}

/** Runs the hook as the host does. The call is a plain Bash call in the project unless `change` says otherwise. */
function runHook(project: string, settings: string, command: string, change: Record<string, unknown> = {}): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [join(project, HOOK_SCRIPT), ...argumentsFor(settings)], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: project, ...change }),
    encoding: "utf8",
    // The suite may itself run where one of these is set; the hook must see what a host's session would.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  });
}

/** The decision the hook printed, or "" when it printed nothing. */
function decisionOf(project: string, settings: string, command: string, change: Record<string, unknown> = {}): string {
  const { status, stdout } = runHook(project, settings, command, change);

  expect(status).toBe(0);

  return stdout === "" ? "" : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}
