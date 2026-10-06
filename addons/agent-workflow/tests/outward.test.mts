import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { commandOf, judgeCall } from "../files/tools/agent-workflow/hooks/split-outward-commands.mts";
import { judgeCommand } from "../files/tools/agent-workflow/lib/outward.mts";
import { parseShell } from "../files/tools/agent-workflow/lib/shell.mts";
import { ADDON } from "./support.mts";

const HOOK = join(ADDON, "files/tools/agent-workflow/hooks/split-outward-commands.mts");

describe("what counts as an outward step", () => {
  it.each([
    "git push",
    "git push -u origin worktree-fix",
    "git push --dry-run",
    "gh pr create --title t --body b",
    "gh pr merge 12 --merge",
    "gh pr edit 12 --title t",
    "gh pr comment 12 --body hi",
    "gh pr close 12",
    "gh pr reopen 12",
    "gh pr ready 12",
    "gh pr review 12 --approve",
    "gh workflow run ci.yml --ref main",
    "gh workflow enable ci.yml",
    "gh run rerun 99",
    "gh run cancel 99",
    "gh run delete 99",
    "gh issue create --title t",
    "gh issue comment 3 --body hi",
    "gh issue close 3",
    "gh release create v1",
    "gh release upload v1 file.zip",
    "gh repo create acme/app",
    "gh repo edit --visibility public",
    "gh api repos/acme/app/git/refs -X POST",
    "gh api repos/acme/app/git/refs --method PATCH",
    "gh api repos/acme/app/git/refs --method=DELETE",
    "gh api repos/acme/app/git/refs -XPUT",
    "gh api repos/acme/app/git/refs -f ref=refs/tags/x",
    "gh api repos/acme/app/issues -F title=x",
    "gh api repos/acme/app/issues --raw-field title=x",
    "gh api repos/acme/app/issues --input body.json",
  ])("%s", (outward) => {
    expect(judgeCommand(`git status && ${outward}`)?.chained).toBe(true);
    expect(judgeCommand(outward)).toEqual({ outward: [outward.split(" ").slice(0, 3).join(" ")], chained: false });
  });

  it.each([
    "git fetch origin main",
    "git commit -m wip",
    "git merge origin/main",
    "git pull",
    "git stash push",
    "gh pr view 12",
    "gh pr list --state merged",
    "gh pr checks 12",
    "gh run list --workflow ci.yml",
    "gh run view 99",
    "gh run watch 99",
    "gh issue list",
    "gh release view v1",
    "gh repo view",
    "gh api repos/acme/app/pulls",
    "gh api repos/acme/app/pulls -X GET -f state=closed",
    "gh api repos/acme/app/pulls --jq .[].number",
    "pnpm test",
    "echo push",
  ])("not %s", (local) => {
    expect(judgeCommand(`git status && ${local} ; ls`)).toEqual({ outward: [], chained: false });
  });

  it("finds the push behind git's own options", () => {
    expect(judgeCommand("git -C ../other push")?.outward).toEqual(["git -C ../other"]);
    expect(judgeCommand("git -c user.name=x -C dir push origin b")?.outward).toHaveLength(1);
    expect(judgeCommand("git --git-dir ../x/.git --no-pager push")?.outward).toHaveLength(1);
    expect(judgeCommand("git -C push status")?.outward).toEqual([]);
  });

  it("finds the group behind gh's own options", () => {
    expect(judgeCommand("gh -R acme/app pr merge 12")?.outward).toHaveLength(1);
    expect(judgeCommand("gh --repo acme/app pr view 12")?.outward).toEqual([]);
  });

  it("looks past a variable set for the command, a path to the program and a word the shell allows in front", () => {
    expect(judgeCommand("GH_TOKEN=abc GIT_TRACE=1 git push")?.outward).toHaveLength(1);
    expect(judgeCommand("/usr/bin/git push")?.outward).toHaveLength(1);
    expect(judgeCommand("time git push")?.outward).toHaveLength(1);
    expect(judgeCommand("env GH_TOKEN=abc gh pr merge 1")?.outward).toHaveLength(1);
  });
});

describe("how the steps are joined", () => {
  it.each([
    ["&&", "git add -A && git commit -m wip && git push"],
    [";", "git commit -m wip; git push"],
    ["||", "git push || echo failed"],
    ["&", "git push & pnpm test"],
    ["a newline", "git commit -m wip\ngit push"],
    ["a newline, with the outward step first", "gh pr create --fill\ngh pr view"],
    ["two outward steps", "git push -u origin worktree-a && gh pr create --fill"],
    ["a subshell", "(cd ../other && git push)"],
    ["a group", "{ git commit -m wip; git push; }"],
    ["a condition", "if pnpm test; then git push; fi"],
    ["a loop", "for b in a b; do git push origin $b; done"],
    ["cd first", "cd packages/domain && git push"],
  ])("refuses %s", (_name, command) => {
    expect(judgeCommand(command)?.chained).toBe(true);
  });

  it.each([
    ["a pipe into a filter", "git push 2>&1 | tail -2"],
    ["a pipe into two filters", "gh pr create --fill 2>&1 | grep https | head -1"],
    ["a pipe with both streams", "git push |& tail -2"],
    ["a redirection", "git push > push.log 2>&1"],
    ["a line continued with a backslash", "gh pr create \\\n  --title t \\\n  --body b"],
    ["a subshell that holds nothing else", "(git push)"],
    ["a trailing semicolon", "git push;"],
    ["a comment after it", "git push # then open the pull request && gh pr create"],
  ])("lets through %s", (_name, command) => {
    expect(judgeCommand(command)).toMatchObject({ chained: false });
    expect(judgeCommand(command)?.outward).toHaveLength(1);
  });

  it("refuses two outward steps joined by a pipe", () => {
    expect(judgeCommand("git push | gh pr create --fill")).toMatchObject({ chained: true });
  });

  it("names every outward step it found", () => {
    expect(judgeCommand("git add -A && git push -u origin worktree-a && gh pr create --fill")?.outward).toEqual([
      "git push -u",
      "gh pr create",
    ]);
  });
});

describe("text that only mentions an outward step", () => {
  it.each([
    ["a commit message in double quotes", 'git commit -m "explain git push && gh pr create"'],
    ["a commit message in single quotes", "git commit -m 'never chain; git push && gh pr merge'"],
    ["an escaped quote inside the message", 'git commit -m "say \\"git push\\" && go"'],
    ["an echo", "echo 'git push' ; echo done"],
    ["a grep for it", 'grep -rn "git push" docs && ls'],
    ["a commit message in a heredoc", createHeredocCommit("git commit -F -")],
    ["a heredoc whose body has a quote that never closes", "git commit -F - <<EOF\ndon't run git push && gh pr merge here\nEOF"],
    ["a heredoc that strips tabs", "git commit -F - <<-EOF\n\tgit push && gh pr merge\n\tEOF"],
    ["a comment", "git status # git push && gh pr create\nls"],
  ])("is not a step: %s", (_name, command) => {
    expect(judgeCommand(command)).toEqual({ outward: [], chained: false });
  });

  it("still sees the push after a heredoc ends", () => {
    expect(judgeCommand(`${createHeredocCommit("git commit -F -")}\ngit push`)).toEqual({ outward: ["git push"], chained: true });
  });

  it("reads a heredoc opened on the same line as the next step", () => {
    expect(judgeCommand("cat <<EOF && git push\ngh pr create --fill\nEOF")).toEqual({ outward: ["git push"], chained: true });
  });
});

describe("a command inside another", () => {
  it("lets a pull request take its body from a heredoc, the usual form", () => {
    const command = "gh pr create --title \"fix: a thing\" --body \"$(cat <<'EOF'\n## Summary\n- don't chain; git push && more\nEOF\n)\"";

    expect(judgeCommand(command)).toEqual({ outward: ["gh pr create"], chained: false });
  });

  it("refuses the same pull request once a push is joined to it", () => {
    const command = "git push && gh pr create --title t --body \"$(cat <<'EOF'\nbody\nEOF\n)\"";

    expect(judgeCommand(command)).toMatchObject({ chained: true, outward: ["git push", "gh pr create"] });
  });

  it("finds an outward step inside a substitution", () => {
    expect(judgeCommand('echo "$(git commit -m wip && git push)"')).toMatchObject({ chained: true });
    expect(judgeCommand("echo `git commit -m wip; git push`")).toMatchObject({ chained: true });
    expect(judgeCommand('ls && echo "$(git push)"')).toMatchObject({ chained: true });
    expect(judgeCommand("diff <(git push 2>&1) expected && ls")).toMatchObject({ chained: true });
  });

  it("counts a lone outward step inside a substitution as one step", () => {
    expect(judgeCommand('echo "$(git push 2>&1)"')).toEqual({ outward: ["git push"], chained: false });
  });

  it("refuses an outward step that takes its argument from another", () => {
    expect(judgeCommand('gh pr comment 1 --body "$(gh pr merge 2)"')).toMatchObject({ chained: true });
  });

  it("reads what a shell is asked to run", () => {
    expect(judgeCommand('bash -c "git commit -m wip && git push"')).toMatchObject({ chained: true });
    expect(judgeCommand("sh -lc 'git push; gh pr create --fill'")).toMatchObject({ chained: true });
    expect(judgeCommand('eval "git add -A && git push"')).toMatchObject({ chained: true });
    expect(judgeCommand('bash -c "git push"')).toEqual({ outward: ["git push"], chained: false });
    expect(judgeCommand('bash -c "pnpm test && pnpm build"')).toEqual({ outward: [], chained: false });
  });
});

describe("a command that cannot be read", () => {
  it.each([
    ["a quote that never closes", 'git commit -m "wip && git push'],
    ["a single quote that never closes", "echo 'git push && ls"],
    ["a substitution that never closes", "echo $(git push && ls"],
    ["a heredoc that never ends", "cat <<EOF && git push\nbody"],
  ])("has no verdict: %s", (_name, command) => {
    expect(judgeCommand(command)).toBeUndefined();
  });
});

describe("the reader", () => {
  it("splits words, drops redirections, and keeps a pipe inside one step", () => {
    expect(parseShell("A=1 git  push 2>&1 >out.log | tail -n 2 && ls 'a b' \"c d\"").steps).toEqual([
      [
        ["A=1", "git", "push"],
        ["tail", "-n", "2"],
      ],
      [["ls", "a b", "c d"]],
    ]);
  });

  it("keeps a hash inside a word, and a here-string out of the words", () => {
    expect(parseShell("echo a#b <<<'git push' c").steps).toEqual([[["echo", "a#b", "c"]]]);
    // A here-string is not a heredoc: the next line is a step, not a body to skip.
    expect(parseShell("cat <<<'text'\ngit push").steps).toEqual([[["cat"]], [["git", "push"]]]);
  });

  it("keeps a parameter expansion whole outside quotes, whatever is inside its braces", () => {
    expect(parseShell("git push origin ${BRANCH:-main}").steps).toEqual([[["git", "push", "origin", "${BRANCH:-main}"]]]);
    expect(parseShell("echo ${MESSAGE:-wip && git push}").steps).toEqual([[["echo", "${MESSAGE:-wip && git push}"]]]);
  });

  it("keeps a parameter and an arithmetic expansion as text", () => {
    // A substitution leaves a mark where it stood: the word is still there.
    expect(parseShell('git push origin "${BRANCH:-main}" $((1 + 2))').steps).toEqual([[["git", "push", "origin", "${BRANCH:-main}", "$(…)"]]]);
  });
});

describe("the hook", () => {
  it("reads the command from a Claude Code payload, and from a list of words", () => {
    expect(commandOf({ tool_name: "Bash", tool_input: { command: "git push" } })).toBe("git push");
    expect(commandOf({ tool_input: { command: ["bash", "-lc", "echo 'it's'"] } })).toBe("'bash' '-lc' 'echo '\\''it'\\''s'\\'''");
    expect(commandOf({ tool_name: "Write", tool_input: {} })).toBeUndefined();
  });

  it("refuses a chain and says which step is outward and what to do", () => {
    const answer = judgeCall({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m wip && git push" } });

    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toContain("Refused");
    expect(answer?.reason).toContain("(git push)");
    expect(answer?.reason).toContain("a tool call of its own");
  });

  it("refuses a chain sent as a list of words", () => {
    const answer = judgeCall({ tool_input: { command: ["bash", "-lc", "git commit -m \"it's done\" && git push"] } });

    expect(answer?.decision).toBe("deny");
    expect(answer?.reason).toContain("git push");
  });

  it("says nothing about a lone outward step, a local chain, or a tool that runs no command", () => {
    expect(judgeCall({ tool_name: "Bash", tool_input: { command: "git push -u origin worktree-a" } })).toBeUndefined();
    expect(judgeCall({ tool_name: "Bash", tool_input: { command: "git add -A && git commit -m wip" } })).toBeUndefined();
    expect(judgeCall({ tool_name: "Write", tool_input: {} })).toBeUndefined();
    expect(judgeCall({})).toBeUndefined();
  });

  it("replies in the shape both hosts read, when run as a command", () => {
    const refused = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m wip && git push" } });
    const reply = JSON.parse(refused.stdout) as { hookSpecificOutput: Record<string, string> };

    expect(refused.status).toBe(0);
    expect(reply.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(reply.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reply.hookSpecificOutput.permissionDecisionReason).toContain("git push");
  });

  it("prints nothing for a command it lets through, when run as a command", () => {
    const allowed = runHook({ tool_name: "Bash", tool_input: { command: "git push 2>&1 | tail -2" } });

    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe("");
    expect(allowed.stderr).toBe("");
  });

  it("lets a call through when it is sent nothing at all", () => {
    const empty = spawnSync(process.execPath, [HOOK], { input: "", encoding: "utf8" });

    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("");
  });
});

function runHook(payload: unknown): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
}

function createHeredocCommit(command: string): string {
  return `${command} <<'EOF'\nfix: split the calls\n\nNever write git push && gh pr create in one call.\nEOF`;
}
