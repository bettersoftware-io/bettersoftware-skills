import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Approval, APPROVING_HOST, approvalSettings, type CommandPayload, judgeCall, replyTo } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { approvedShape, readExact, readShape } from "../files/tools/agent-workflow/lib/approve.mts";
import { approvableCommand } from "../files/tools/agent-workflow/lib/call.mts";
import { APPROVING_HOST as HOST_IN_CHECK, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, CONFIG_FILE, HOOK_SCRIPT } from "../files/tools/agent-workflow/lib/host.mts";
import { judgeCommand, mentionsOutward } from "../files/tools/agent-workflow/lib/outward.mts";
import { commonDirectory, isCheckoutOf } from "../files/tools/agent-workflow/lib/repository.mts";
import { NOTHING_APPROVED, readSettings } from "../files/tools/agent-workflow/lib/settings.mts";
import { DEEPEST_NESTING, LimitError, LONGEST_SCRIPT, parseShell } from "../files/tools/agent-workflow/lib/shell.mts";
import { APPROVED, NEAR_MISSES, SHA } from "./shapes.mts";
import { ADDON, createFolder, createProject, createRemote, git, readJson, runHook, writeFile } from "./support.mts";

/** A folder that stands for a checkout of the project in tests that never ask git. */
const HOME = "/project";
const BOTH_ON = { approvePushAndCreate: true, approveMerge: true };
/** An approval that takes `HOME` for the project's checkout, and nothing else, with both settings on and a checkout nothing is unusual about. */
const IN_PROJECT: Approval = { settings: BOTH_ON, isOwnCheckout: (cwd) => cwd === HOME, obstacle: () => undefined };

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

  it("may be approved when the tool is Bash, its fields are known and plain, the session asks before a command, and it runs in the project", () => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: "default" }, isOwn)).toBe(command);
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: "acceptEdits" }, isOwn)).toBe(command);
    expect(
      approvableCommand(
        { tool_name: "Bash", tool_input: { command, description: "Push the branch", timeout: 120_000, run_in_background: false, dangerouslyDisableSandbox: false }, cwd: HOME, permission_mode: "default" },
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
    expect(approvableCommand({ tool_name: tool, tool_input: { command }, cwd: HOME, permission_mode: "default" }, isOwn)).toBeUndefined();
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
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command, ...extra }, cwd: HOME, permission_mode: "default" }, isOwn)).toBeUndefined();
  });

  it.each([
    ["a list of words", ["git", "push", "-u", "origin", "worktree-a"]],
    ["missing", undefined],
    ["a number", 1],
  ])("may not be approved when its command is %s", (_name, value) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command: value }, cwd: HOME, permission_mode: "default" }, isOwn)).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["a list", [command]],
    ["text", command],
    ["nothing", null],
  ])("may not be approved when its input is %s", (_name, input) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: input, cwd: HOME, permission_mode: "default" }, isOwn)).toBeUndefined();
  });

  it.each([
    ["not said", undefined],
    ["empty", ""],
    ["not text", 3],
    ["another folder", "/elsewhere"],
    ["a folder that only starts the same", `${HOME}-other`],
  ])("may not be approved when where it runs is %s", (_name, cwd) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd, permission_mode: "default" }, isOwn)).toBeUndefined();
  });

  it.each([
    ["plan", "plan"],
    ["auto", "auto"],
    ["dontAsk", "dontAsk"],
    ["bypassPermissions", "bypassPermissions"],
    ["a mode nobody has decided on", "someLaterMode"],
    ["the right mode in another case", "Default"],
    ["no mode", undefined],
    ["a mode that is not text", ["default"]],
  ])("may not be approved when the session's permission mode is %s", (_name, mode) => {
    expect(approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: mode }, isOwn)).toBeUndefined();
  });

  it("does not ask where the call runs before the rest of it is known to be plain", () => {
    const asked: string[] = [];
    const record = (cwd: string): boolean => {
      asked.push(cwd);

      return true;
    };

    approvableCommand({ tool_name: "Write", tool_input: { command }, cwd: HOME, permission_mode: "default" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command, run_in_background: true }, cwd: HOME, permission_mode: "default" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: "", permission_mode: "default" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: undefined, permission_mode: "default" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command: ["git", "push"] }, cwd: HOME, permission_mode: "default" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: "plan" }, record);
    approvableCommand({ tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: "default" }, record);

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
    ["plan mode", { permission_mode: "plan" }],
    ["no permission mode", { permission_mode: undefined }],
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

  it("never approves any of them for a call in another folder, from another tool, in the background, or in plan mode", () => {
    const calls = generated.flatMap((command) => [
      { ...createCall(command), cwd: "/elsewhere" },
      { ...createCall(command), tool_name: "Shell" },
      { ...createCall(command), tool_input: { command, run_in_background: true } },
      { ...createCall(command), permission_mode: "plan" },
    ]);

    expect(calls.filter((call) => judgeCall(call, IN_PROJECT)?.decision === "allow")).toEqual([]);
  });

  it("refuses every one that joins an approved command to another", () => {
    const [push] = APPROVED[0] as [string, string];
    const joined = [" && ", "; ", " || ", "\n"].flatMap((join) => APPROVED.map(([other]) => `${push}${join}${other}`));

    expect(joined.filter((command) => judgeCall(createCall(command), IN_PROJECT)?.decision !== "deny")).toEqual([]);
  });
});

describe("what the project's setting turns on", () => {
  const push = createCall("git push -u origin worktree-a");
  const create = createCall("gh pr create --head worktree-a --fill");
  const merge = createCall(`gh pr merge 12 --match-head-commit ${SHA} --squash`);
  const withSettings = (settings: Approval["settings"]): Approval => ({ ...IN_PROJECT, settings });

  it("is nothing, in the file a project starts with", () => {
    expect(readSettings(join(ADDON, "files", CONFIG_FILE))).toEqual({ approvePushAndCreate: false, approveMerge: false });
    expect(readJson(join(ADDON, "files"), CONFIG_FILE)).toEqual({ approvePushAndCreate: false, approveMerge: false });
    expect(approvalSettings([APPROVING_HOST])).toBeUndefined();
  });

  it("is a push and a pull request opened, and no merge, with approvePushAndCreate alone", () => {
    const approval = withSettings({ approvePushAndCreate: true, approveMerge: false });

    expect(judgeCall(push, approval)?.decision).toBe("allow");
    expect(judgeCall(create, approval)?.decision).toBe("allow");
    expect(judgeCall(merge, approval)).toBeUndefined();
  });

  it("is a merge, and no push and no pull request opened, with approveMerge alone", () => {
    const approval = withSettings({ approvePushAndCreate: false, approveMerge: true });

    expect(judgeCall(merge, approval)?.decision).toBe("allow");
    expect(judgeCall(push, approval)).toBeUndefined();
    expect(judgeCall(create, approval)).toBeUndefined();
  });

  it("is read as data: each approval is on only for a literal true", () => {
    expect(readSettings(createConfig('{ "approvePushAndCreate": true, "approveMerge": true }'))).toEqual(BOTH_ON);
    expect(readSettings(createConfig('{ "approvePushAndCreate": true }'))).toEqual({ approvePushAndCreate: true, approveMerge: false });
    expect(readSettings(createConfig('{ "approveMerge": true, "approvePushAndCreate": false }'))).toEqual({ approvePushAndCreate: false, approveMerge: true });
  });

  it.each([
    ["the word true", '{ "approvePushAndCreate": "true", "approveMerge": "true" }'],
    ["1", '{ "approvePushAndCreate": 1, "approveMerge": 1 }'],
    ["a list that holds true", '{ "approvePushAndCreate": [true], "approveMerge": [true] }'],
    ["an object", '{ "approvePushAndCreate": {}, "approveMerge": {} }'],
    ["nothing", '{ "approvePushAndCreate": null, "approveMerge": null }'],
    ["not there", "{}"],
    ["under another name", '{ "approveExactShapes": true }'],
    ["in a list, not an object", "[true, true]"],
    ["in a file that is true and nothing else", "true"],
    ["in a file that is not JSON", '{ "approvePushAndCreate": true, }'],
    ["in a file that is TypeScript", "export const approvePushAndCreate = true;\nexport const approveMerge = true;\n"],
    ["in an empty file", ""],
  ])("turns nothing on when the value is %s", (_name, content) => {
    expect(readSettings(createConfig(content))).toEqual(NOTHING_APPROVED);
    expect(approvalSettings([APPROVING_HOST], createConfig(content))).toBeUndefined();
  });

  it("turns nothing on when there is no setting file", () => {
    expect(readSettings(join(createFolder(), CONFIG_FILE))).toEqual(NOTHING_APPROVED);
  });

  it("never runs the setting file: one that would write a file if it were run as code writes none", () => {
    const folder = createFolder();
    const marker = join(folder, "ran");
    const code = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const approvePushAndCreate = true;\n`;

    writeFile(folder, CONFIG_FILE, code);
    // Where the setting was before it became data. Nothing reads it now.
    writeFile(folder, "tools/agent-workflow.config.mts", code);

    expect(readSettings(join(folder, CONFIG_FILE))).toEqual(NOTHING_APPROVED);
    expect(existsSync(marker)).toBe(false);
  });

  it("needs the host's argument as well", () => {
    const on = createConfig('{ "approvePushAndCreate": true, "approveMerge": true }');

    expect(approvalSettings([APPROVING_HOST], on)).toEqual(BOTH_ON);
    expect(approvalSettings([], on)).toBeUndefined();
    expect(approvalSettings(["--host=codex"], on)).toBeUndefined();
    expect(approvalSettings(["--host=claude-code-2"], on)).toBeUndefined();
  });

  it("is spelled the same where the hook reads it and where the check looks for it", () => {
    expect(HOST_IN_CHECK).toBe(APPROVING_HOST);
  });
});

describe("an exact shape in a checkout that is not plain", () => {
  const push = createCall("git push -u origin worktree-a");

  it("is asked about, with the reason, and not approved", () => {
    const asked: [string, unknown][] = [];
    const answer = judgeCall(push, {
      ...IN_PROJECT,
      obstacle: (cwd, shape) => {
        asked.push([cwd, shape]);

        return "remote.origin.push is set";
      },
    });

    expect(answer).toEqual({
      decision: "ask",
      reason:
        "Not approved by tools/agent-workflow, though it is a push of the work branch worktree-a to origin in the exact form: remote.origin.push is set. Check that before you say yes.",
    });
    expect(asked).toEqual([[HOME, { step: "push", branch: "worktree-a", says: "a push of the work branch worktree-a to origin" }]]);
  });

  it("is not looked at when the setting is off, the call is not plain, or the command is not a shape", () => {
    let asked = 0;
    const count = (): undefined => {
      asked += 1;

      return undefined;
    };

    judgeCall(push, { ...IN_PROJECT, settings: NOTHING_APPROVED, obstacle: count });
    judgeCall({ ...push, cwd: "/elsewhere" }, { ...IN_PROJECT, obstacle: count });
    judgeCall({ ...push, permission_mode: "plan" }, { ...IN_PROJECT, obstacle: count });
    judgeCall(createCall("git push origin main"), { ...IN_PROJECT, obstacle: count });

    expect(asked).toBe(0);
  });

  it("is not approved when asking about the checkout fails", () => {
    const answer = judgeCall(push, {
      ...IN_PROJECT,
      obstacle: () => {
        throw new Error("git is gone");
      },
    });

    expect(answer).toBeUndefined();
  });

  it("names the parts of each step that are checked against the repository", () => {
    expect(readShape("git push origin worktree-a")).toMatchObject({ step: "push", branch: "worktree-a" });
    expect(readShape("gh pr create --fill -H worktree-b")).toMatchObject({ step: "create", head: "worktree-b" });
    expect(readShape(`gh pr merge 12 --squash --match-head-commit ${SHA}`)).toMatchObject({ step: "merge", number: "12", commit: SHA });
  });
});

describe("a command the hook does not read", () => {
  const deep = (levels: number, inner: string): string => `${"echo $(".repeat(levels)}${inner}${")".repeat(levels)}`;

  it("is refused when it is nested too deep and names an outward step, and is not a crash", () => {
    const answer = judgeCall(createCall(deep(20_000, "git push origin main")), IN_PROJECT);

    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toContain("too long or too deeply nested");
  });

  it("is left to the host when it is nested too deep and names none", () => {
    expect(judgeCall(createCall(deep(20_000, "ls")), IN_PROJECT)).toBeUndefined();
  });

  it("is read, and judged as any other, at the deepest nesting it takes", () => {
    expect(judgeCall(createCall(deep(40, "ls && git push origin main")), IN_PROJECT)?.reason).toContain("joins an outward step");
    expect(judgeCall(createCall(deep(41, "ls && git push origin main")), IN_PROJECT)?.reason).toContain("too long or too deeply nested");
  });

  it("is refused when it is too long and names an outward step, and left to the host when it names none", () => {
    const filler = `echo ${"x".repeat(1_000_000)}`;

    expect(judgeCall(createCall(`${filler} && git push origin worktree-a`), IN_PROJECT)?.reason).toContain("too long or too deeply nested");
    expect(judgeCall(createCall(filler), IN_PROJECT)).toBeUndefined();
    expect(() => parseShell(filler)).toThrow(LimitError);
    expect(parseShell(filler.slice(0, LONGEST_SCRIPT)).steps).toHaveLength(1);
  });

  it("stops reading at the bound, and does not leave that to the stack: forty levels are read, forty-one are not", () => {
    expect(parseShell(deep(DEEPEST_NESTING, "ls")).nested).toHaveLength(1);
    expect(() => parseShell(deep(DEEPEST_NESTING + 1, "ls"))).toThrow(LimitError);
    expect(() => parseShell(deep(20_000, "ls"))).toThrow(LimitError);
    expect(() => parseShell(deep(20_000, "ls"))).not.toThrow(RangeError);
  });

  it("counts how deep, not how many: a hundred substitutions side by side are read", () => {
    const beside = `echo ${"$(ls) ".repeat(100)}&& git push origin main`;

    expect(parseShell(beside).nested).toHaveLength(100);
    expect(judgeCall(createCall(beside), IN_PROJECT)?.reason).toContain("joins an outward step");
  });

  it("is refused when evals are nested inside one another too deep, which needs no quoting at all", () => {
    expect(judgeCall(createCall(`${"eval ".repeat(40)}ls && git push origin main`), IN_PROJECT)?.reason).toContain("joins an outward step");
    expect(judgeCall(createCall(`${"eval ".repeat(20_000)}git push origin main`), IN_PROJECT)?.reason).toContain("too long or too deeply nested");
    expect(judgeCall(createCall(`${"eval ".repeat(20_000)}ls`), IN_PROJECT)).toBeUndefined();
  });

  it.each([
    ["push", "git push"],
    ["gh", "gh pr merge 1"],
    ["gh at the very start", "gh"],
    ["push inside quotes", "echo 'push'"],
  ])("counts %s as naming an outward step", (_name, text) => {
    expect(mentionsOutward(text)).toBe(true);
  });

  it.each([
    ["nothing outward", "ls -la && pnpm test"],
    ["a word that only holds push", "pushd /tmp && popd"],
    ["a word that only holds gh", "echo high && ghost"],
    ["a word joined to push by a dash", "pnpm run pre-push-check"],
  ])("does not count %s", (_name, text) => {
    expect(mentionsOutward(text)).toBe(false);
  });

  it("answers nothing, and exits 0, for a payload that is not JSON", () => {
    expect(replyTo("{ not json", [APPROVING_HOST], HOME)).toBe("");

    const run = spawnSync(process.execPath, [join(ADDON, "files", HOOK_SCRIPT), APPROVING_HOST], { input: "{ not json", encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("refuses the deep chain when run as a program, where it once died of a stack overflow with nothing said", () => {
    const run = spawnSync(process.execPath, [join(ADDON, "files", HOOK_SCRIPT)], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `${deep(20_000, "true")} && git push origin main` } }),
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// The hook as each host starts it: the arguments are taken from the command
// the add-on's manifest registers for that host, not written again here. The
// project is a real repository with a real `origin` beside it, both approvals
// are on, and the payload says the call runs in it.
describe("the hook run as a program, the way each host's settings start it", () => {
  const approved = "git push -u origin worktree-a 2>&1 | tail -2";
  const unanswered = "git push origin main";
  const refused = "git commit -m wip && git push -u origin worktree-a";
  const asClaude = { args: argumentsFor(CLAUDE_SETTINGS) };
  const asCodex = { args: argumentsFor(CODEX_HOOKS) };

  it("is started with the approving argument by Claude Code's settings, and without it by Codex's", () => {
    expect(asClaude.args).toEqual([APPROVING_HOST]);
    expect(asCodex.args).toEqual([]);
  });

  it("answers Claude Code: allow for an exact shape, nothing for another lone step, deny for a chain", () => {
    const project = createProject();

    expect(runHook(project, approved, asClaude).decision).toBe("allow");
    expect(runHook(project, unanswered, asClaude).decision).toBe("");
    expect(runHook(project, refused, asClaude).decision).toBe("deny");
  });

  it("never answers Codex with allow: nothing for an exact shape, nothing for another lone step, deny for a chain", () => {
    const project = createProject();

    expect(runHook(project, approved, asCodex).decision).toBe("");
    expect(runHook(project, unanswered, asCodex).decision).toBe("");
    expect(runHook(project, refused, asCodex).decision).toBe("deny");
  });

  it("approves nothing in the project as the add-on ships it, and still refuses a chain", () => {
    const project = createProject();

    cpSync(join(ADDON, "files", CONFIG_FILE), join(project.project, CONFIG_FILE));

    expect(runHook(project, approved, asClaude)).toMatchObject({ status: 0, stdout: "" });
    expect(runHook(project, "gh pr create --head worktree-a --fill", asClaude)).toMatchObject({ status: 0, stdout: "" });
    expect(runHook(project, `gh pr merge 12 --match-head-commit ${SHA}`, asClaude)).toMatchObject({ status: 0, stdout: "" });
    expect(runHook(project, refused, asClaude).decision).toBe("deny");
  });

  it("approves a pull request with a body of several lines", () => {
    const body = "gh pr create --head worktree-a --title 'Add the price list' --body '## Summary\n\n- one\n- two'";

    expect(runHook(createProject(), body, asClaude).decision).toBe("allow");
  });

  it("answers nothing for the heredoc whose body bash 3.2 runs", () => {
    const escape = "gh pr create --head worktree-a --title \"a\" --body \"$(cat <<'EOF'\nsee (link) and a ) \" ; echo ESCAPED-1 ; \"\nit's `echo ESCAPED-2` $(echo ESCAPED-3)\nEOF\n)\"";

    expect(runHook(createProject(), escape, asClaude)).toMatchObject({ status: 0, stdout: "" });
  });

  it("approves in a worktree of the project, and in a folder inside it", () => {
    const project = createProject();
    const worktree = join(dirname(project.project), "a-worktree");

    git(project.project, "worktree", "add", "--quiet", worktree, "worktree-a");

    expect(runHook(project, approved, { ...asClaude, change: { cwd: worktree } }).decision).toBe("allow");
    expect(runHook(project, approved, { ...asClaude, change: { cwd: join(project.project, "tools") } }).decision).toBe("allow");
  });

  it("answers nothing for an exact shape that would run in another repository, or says no folder", () => {
    const project = createProject();
    const { clone } = createRemote();

    expect(runHook(project, approved, { ...asClaude, change: { cwd: clone } }).decision).toBe("");
    expect(runHook(project, approved, { ...asClaude, change: { cwd: dirname(project.project) } }).decision).toBe("");
    expect(runHook(project, approved, { ...asClaude, change: { cwd: undefined } }).decision).toBe("");
    expect(runHook(project, refused, { ...asClaude, change: { cwd: clone } }).decision).toBe("deny");
  });

  it("answers nothing for an exact shape from another tool, in the background, or with a field it does not know", () => {
    const project = createProject();
    const withInput = (input: Record<string, unknown>) => ({ ...asClaude, change: { tool_input: { command: approved, ...input } } });

    expect(runHook(project, approved, { ...asClaude, change: { tool_name: "Shell" } }).decision).toBe("");
    expect(runHook(project, approved, withInput({ run_in_background: true })).decision).toBe("");
    expect(runHook(project, approved, withInput({ dangerouslyDisableSandbox: true })).decision).toBe("");
    expect(runHook(project, approved, withInput({ workdir: "/elsewhere" })).decision).toBe("");
    expect(runHook(project, approved, withInput({ description: "Push", timeout: 5000, run_in_background: false })).decision).toBe("allow");
  });

  it.each(["plan", "auto", "dontAsk", "bypassPermissions", undefined])("answers nothing for an exact shape when the session's permission mode is %s", (mode) => {
    const project = createProject();

    expect(runHook(project, approved, { ...asClaude, change: { permission_mode: mode } })).toMatchObject({ status: 0, stdout: "" });
    expect(runHook(project, refused, { ...asClaude, change: { permission_mode: mode } }).decision).toBe("deny");
  });

  it("approves in the two modes that ask before a command", () => {
    const project = createProject();

    expect(runHook(project, approved, { ...asClaude, change: { permission_mode: "default" } }).decision).toBe("allow");
    expect(runHook(project, approved, { ...asClaude, change: { permission_mode: "acceptEdits" } }).decision).toBe("allow");
  });

  it("answers Codex with nothing for every approved command, so it is never sent a decision it does not take", () => {
    const project = createProject();

    for (const [command] of APPROVED) {
      expect(runHook(project, command, asCodex).stdout, command).toBe("");
    }
    // Thirty runs of the program: seconds on a busy machine.
  }, 60_000);

  it("approves nothing once the project turns approval off, and still refuses a chain", () => {
    const project = createProject({ approvePushAndCreate: false, approveMerge: false });

    expect(runHook(project, approved, asClaude).decision).toBe("");
    expect(runHook(project, refused, asClaude).decision).toBe("deny");
    expect(runHook(project, refused, asCodex).decision).toBe("deny");
  });

  it("approves nothing when the setting file is gone, and still refuses a chain", () => {
    const project = createProject();

    rmSync(join(project.project, CONFIG_FILE));

    expect(runHook(project, approved, asClaude).decision).toBe("");
    expect(runHook(project, refused, asClaude).decision).toBe("deny");
  });

  it("does not run a setting written as code, where the hook once imported it on every command", () => {
    const project = createProject();
    const marker = join(project.home, "ran");
    const code = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const approveExactShapes = true;\n`;

    writeFile(project.project, CONFIG_FILE, code);
    writeFile(project.project, "tools/agent-workflow.config.mts", code);

    expect(runHook(project, approved, asClaude)).toMatchObject({ status: 0, stdout: "" });
    expect(existsSync(marker)).toBe(false);
  });

  it("prints one line of JSON with the reason when it approves, and exits 0", () => {
    const run = runHook(createProject(), approved, asClaude);
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
  return { tool_name: "Bash", tool_input: { command }, cwd: HOME, permission_mode: "default" };
}

/** A setting file with `content`, at the place it has in a project. */
function createConfig(content: string): string {
  return join(createFolder({ [CONFIG_FILE]: content }), CONFIG_FILE);
}

/** What follows the script's path in the command the manifest registers for a host. */
function argumentsFor(settings: string): string[] {
  const manifest = readJson<{ hostSettings: Record<string, { hooks: { PreToolUse: { hooks: { command: string }[] }[] } }> }>(ADDON, "addon.json");
  const command = manifest.hostSettings[settings]?.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  const after = command.slice(command.indexOf(HOOK_SCRIPT) + HOOK_SCRIPT.length).replace(/^"/, "");

  expect(command).toContain(HOOK_SCRIPT);

  return after.split(" ").filter(Boolean);
}
