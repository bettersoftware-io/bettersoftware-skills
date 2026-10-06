# Add-on: agent-workflow

How an agent ships work from a project created from the starter: each push
and pull request step in a tool call of its own, every change started in a
fresh worktree, each finished week tagged, and a changelog whose
completeness is checked. A project may also let the hook approve the routine
steps by their exact shape. That is off until the project turns it on.

```bash
node scripts/add-to-project.mts <project> agent-workflow
cd <project> && pnpm install && pnpm agent-workflow:check
```

It is not recommended by default: it assumes the project is on GitHub, uses
pull requests, and lets an agent push.

## What it adds

| Part | Where | What it does |
|---|---|---|
| The hook | `tools/agent-workflow/hooks/split-outward-commands.mts` | Before each shell command: refuses one that joins an outward step to anything else. When the project turns it on, in Claude Code it also approves a routine one written in its exact form |
| The setting | `tools/agent-workflow.config.json` | A starting file, read as data: `approvePushAndCreate` and `approveMerge`, both `false` as shipped |
| Its registration | `.claude/settings.json`, `.codex/hooks.json` | Merged in under `hooks.PreToolUse`, matcher `Bash`, beside the kit's hooks |
| Permission rules | `.claude/settings.json` | Merged in: thirteen `ask` rules for a forced or destructive push and an `--admin` merge, and two for an edit of the hook or its setting. No `allow` rule |
| `pnpm worktree <name> [--ready]` | `tools/agent-workflow/new-worktree.mts` | A worktree beside the project on `worktree-<name>`, cut from `origin`'s main by name |
| `pnpm changelog weeks\|prs\|check` | `tools/agent-workflow/changelog.mts` | The weeks with no entry, a week's merged pull requests, and the proof that each is cited |
| Weekly tag | `.github/workflows/weekly-tag.yml`, `tools/agent-workflow/close-week.mts` | Monday 00:05 UTC: tags the finished ISO week, opens "Changelog: write `<week>`" |
| `CHANGELOG.md` | project root | A starting file: the format, no week yet. The project owns it |
| Three commands | `.claude/commands/workflow/*.md` | `/workflow:changelog`, `/workflow:coverage-backfill`, `/workflow:visual-tolerance-audit` |
| The same for Codex | `.agents/skills/workflow-*/SKILL.md` | One small skill per command, which points at the command file |
| `node tools/agent-workflow/requires.mts <add-on>` | same | Exit 0 when the add-on is installed, exit 2 with what to do when not |
| `pnpm agent-workflow:check` | `tools/agent-workflow/check.mts` | The add-on's `verify`: runs the hook on three commands as each host starts it, reads both settings files, says which approval is on and what that means |

Nothing joins `gate:fast` or `gate:full`. A host's settings file is the
project's to change: a gate that failed when someone removed a permission
rule would fight the owner of the file. The check is run by hand.

## The hook

An outward step sends something off the machine or changes shared state.

| Outward | Not outward |
|---|---|
| `git push`, also `--dry-run`, also behind `git -C dir` or `-c key=value` | `git add`, `commit`, `fetch`, `merge`, `pull` |
| `gh pr create`, `merge`, `edit`, `comment`, `close`, `reopen`, `ready`, `review` | `gh pr view`, `list`, `checks`, `diff` |
| `gh workflow run`, `enable`, `disable`; `gh run rerun`, `cancel`, `delete` | `gh run list`, `view`, `watch` |
| `gh api` with `-X`/`--method` POST, PATCH, PUT or DELETE, or with a field (`-f`, `-F`, `--field`, `--raw-field`, `--input`) and no method | `gh api` reads, also `-X GET -f …` |
| `gh issue create`, `comment`, `edit`, `close`, `reopen`; `gh release create`, `delete`, `edit`, `upload`; `gh repo create`, `delete`, `edit`, `fork` | every other `gh issue`, `release`, `repo` call |

A command is refused when it holds an outward step and anything else beside
it: joined by `&&`, `;`, `||`, `&` or a new line, in a subshell or a `{ }`
group, in an `if` or a loop, inside `$(…)` or backticks with other steps, or
as the text given to `bash -c` or `eval`. Two outward steps in one command
are refused however they are joined.

It is let through when the outward step is alone: with a pipe into a filter
(`git push 2>&1 | tail -2`), with redirections, with a `$(cat <<'EOF' … EOF)`
that only feeds it, or with variables set in front. Let through is not
approved: such a command is not refused, and the host asks about it.

Text is not a step. A commit message, an `echo`, a `grep` pattern, a heredoc
body or a comment may say `git push && gh pr create` and nothing is refused.
The hook reads the command with a small scanner of its own
(`lib/shell.mts`): quotes, heredocs (`<<`, `<<-`, quoted delimiters),
redirections, pipes, separators, grouping, substitutions.

**A command it cannot read is let through.** A quote that never closes, a
heredoc that never ends: the hook has no verdict, and the host's permission
rules are the only judge. That was the source's choice too. The hook orders
the work; it is not what stops a push.

**A command it will not read is refused when it names an outward step.** The
scanner calls itself for each `$(…)`, and `eval eval eval …` is read level by
level. A command nested twenty thousand deep once ended the hook with a stack
overflow: exit 1, nothing printed, and the chain went through unrefused. Now
nesting stops at forty levels and a command at a million characters. Past
either, a command that holds the word `push` or `gh` is refused with the
reason, and any other is left to the host. The same answer is given if the
scanner fails in a way nobody foresaw. The hook never exits without the
answer it meant: a payload that is not JSON gets no answer and exit 0.

Its reply is `hookSpecificOutput.permissionDecision` with the reason, on
stdout, exit 0: `"deny"` for a joined command, which both hosts read; and,
only for Claude Code and only with approval on, `"allow"` for an approved
shape or `"ask"` with the reason for one whose checkout is not plain
([below](#what-runs-without-a-prompt)). For anything else it prints nothing.

### Not covered

- Aliases and functions: `gp` for `git push`, a shell function that pushes.
- A script that pushes (`./release.sh`, `pnpm release`).
- `xargs`, `find -exec`, `ssh host 'git push'`, `sudo`.
- Other programs that write to a remote: `glab`, `hub`, `curl` to an API,
  `npm publish`.
- `gh api graphql -f query=…` counts as a write even when the query reads,
  as in the source. It only has to be a call of its own.

## The settings merge

`.claude/settings.json` and `.codex/hooks.json` are written once by the kit's
setup, and then belong to the project. An add-on could not touch them before.
This add-on needed to, so the installer gained one feature, `hostSettings` in
`addon.json` ([the contract](../README.md)): entries to merge into a host's
settings file.

- A key the project has keeps the project's value.
- A list gains the entries it lacks, after the ones it has.
- A hook counts as there when its command is, whatever the project did to
  the group around it (a longer timeout, a wider matcher). It is not added a
  second time.
- Nothing is removed, ever.
- When nothing is missing the file is not written at all, so its layout and
  its bytes stay as the project left them.
- A file that is not JSON is left alone, and the note says what to add by
  hand. A file the host keeps read-only (Codex's sandbox does that for
  `.codex` and `.agents`) is left, and the note says to run the script again
  outside it.

**Limit: a removed entry comes back.** The merge cannot tell a rule the
project took out from a rule that was never there. Adding the add-on again
(an update) puts back a rule or the hook that was removed by hand. To keep
one out, remove it again after an update.

## What runs without a prompt

**Nothing, as shipped.** `tools/agent-workflow.config.json` starts as:

```json
{
  "approvePushAndCreate": false,
  "approveMerge": false
}
```

With both `false` the hook approves nothing, and every push and pull request
step asks a person, as it would without the add-on. The refusal of a joined
command does not depend on the setting.

### Turning an approval on, and what that means

Each switch is a decision for the project's owner. Only a literal `true`
turns one on; a missing file, a file that is not JSON, `"true"` and `1` all
mean off.

**`approvePushAndCreate: true`** means: in Claude Code, an agent in this
project can push any commits it has made to a `worktree-…` branch on
`origin`, and open a pull request for that branch, with nobody asked. What
the agent does is steered by what it reads: a web page, an issue, a file in
a dependency. An instruction injected there can therefore put commits on the
remote and open a pull request with any title and body. A push also starts
whatever workflows the repository runs for a pushed branch.

**`approveMerge: true`** means: the agent can also merge a pull request with
nobody asked, when that pull request is this checkout's own work branch
(below). **Turn both on, and nothing on this machine stands between an
injected instruction and the default branch**: push, open, merge is a path
with no prompt on it. What is left is on the remote: branch protection,
required reviews, required checks. Turn `approveMerge` on only in a
repository whose default branch requires a review or a check that the agent
cannot satisfy by itself. In a repository with no protection, leave it off.

`pnpm agent-workflow:check` says which is on, in those words.

The add-on ships no `allow` rule. A first version did, and they were
escapable: a pattern that ends in `*` cannot say "one word".
`Bash(git push origin worktree-*)` also matched
`git push origin worktree-a main`, `worktree-a --delete main`, `--mirror`
and `--tags`; `Bash(gh pr merge *)` matched `--admin`; and
`Bash(gh pr create *)` matched a body of `"$(any command)"`. Naming the bad
spellings in `ask` is a blocklist, and a blocklist misses one.

So the hook approves, in three steps. Each is an allowlist: what it does not
recognise is not approved.

1. **The call** is a plain one (`lib/call.mts`).
2. **The words** are exactly one of three shapes (`lib/approve.mts`).
3. **The checkout** is one where those words do what they say
   (`lib/push.mts`, and for a merge `lib/pull-request.mts`).

When steps 1 and 2 hold and step 3 does not, the hook answers `ask` and
gives the reason, for example "remote.origin.push is set in the repository's
own configuration". The person is asked, as they would have been, and is
told what is unusual. An `ask` from a hook also wins over an `allow` rule the
project may have.

### The words

The hook reads the command with a second, strict reader that has a token for
only what the shapes need. Whatever it has no token for is not approved.

**The reader may only take text that every shell a host may use reads the
same way**, and that is tested by running the shells, not argued. It was
argued once. The reader took `"$(cat <<'EOF' … EOF )"` for literal text,
because a heredoc with a quoted delimiter is literal. bash 3.2, which is
`/bin/bash` and `/bin/sh` on every Mac, finds the end of `$(…)` by counting
brackets and does not know the body is literal: a `)` in the body closes
the substitution, and what follows runs. zsh, dash and bash 5 print the same
body as text. So the reader has no token for a substitution of any kind,
and `tests/shells.test.mts` runs every approved command and a set of
hostile strings through each shell on the machine.

| Token | What it is |
|---|---|
| bare | letters, digits and `_ . / -` |
| `'single'` | any text up to the next single quote |
| `"double"` | text with no `$`, backtick, backslash or `!` |
| mark | `2>&1` and `\|`, only after the step |

A quoted token may hold a new line and a tab, and no other control
character. A token ends at a space, a tab or the end, so `a"b"` is not one.
A command longer than 20,000 characters is not read. There is no token for
a variable, a glob, a brace list, `~`, `=word`, a backtick, a substitution,
a heredoc, a redirection to a file, `;`, `&`, a comment, or a new line
outside quotes. `!` is kept out of double quotes because an interactive
shell may expand it there; in single quotes none does.

**A body of several lines** is one quoted token with the lines in it:
`--body '## Summary

- one
- two'`. Single quotes when the text has no `'`
in it, double quotes when it has no `$`, backtick, backslash or `!`. Text
with both kinds of character is not approved, and asks.

| Shape | Setting | Exactly |
|---|---|---|
| Push a work branch | `approvePushAndCreate` | `git push [-u \| --set-upstream] origin worktree-<name>`, all bare. `<name>` is letters and digits joined by single `.`, `_` or `-`; the branch is at most 100 characters |
| Open a pull request | `approvePushAndCreate` | `gh pr create`, with `--head`/`-H` work branch, and any of `--title`/`-t` text, `--body`/`-b` text, `--base`/`-B` branch, `--draft`/`-d`, `--fill`/`-f`, each at most once |
| Merge a pull request | `approveMerge` | `gh pr merge <number>`, with `--match-head-commit <forty hexadecimal digits>`, and any of one way to merge (`--merge`/`-m`, `--squash`/`-s`, `--rebase`/`-r`), `--subject`/`-t` text, `--body`/`-b` text, each at most once |
| After any of them | | nothing, `2>&1`, `\| tail -<n>` or `\| head -<n>` (also `-n <n>`), or `2>&1` and then the pipe |

Decisions on the flags:

- **`--head` is required on `gh pr create`.** Without it `gh` works out the
  branch itself, and pushes it when it is not on GitHub yet: a second push,
  to a remote of `gh`'s choosing, that no check here would have seen.
- **`--match-head-commit` is required on `gh pr merge`.** GitHub then merges
  that commit or nothing. So what the hook checked is what is merged,
  whatever is pushed to the branch between the check and the merge.
- **`--delete-branch` is not approved.** It also changes the checkout: `gh`
  switches branch and pulls, which runs the repository's own hooks and
  filters. Let the repository delete merged branches, or let it ask.
- **`--squash` and `--rebase` are approved** beside `--merge`. Which one a
  project uses is its convention; none of them gets past anything the
  others do not.
- **`--auto` is not.** It moves the merge to a later time, when nobody is
  looking at what was pushed to the branch since.
- **`--admin` and `--repo` are not**, on either command: one merges past the
  branch's protections, the other aims the call at another repository.
- **`--body-file` and `--template` are not.** They post the content of any
  file the machine can read, which is what `"$(cat file)"` does.
- `--reviewer`, `--assignee`, `--label`, `--milestone`, `--project`,
  `--web`, `--editor`, `--fill-first`, `--dry-run`: not approved. They ask.

The refusal comes first: a joined command is refused even when it starts as
an approved shape.

### The call, not only the command

The host runs a tool call, and the command is one field of it. Before the
text is read, the call itself must be plain (`lib/call.mts`). Each rule is
an allowlist.

| The call | Approved only when |
|---|---|
| `tool_name` | it is exactly `Bash` |
| `tool_input.command` | it is text. A list of words is not approved |
| `description`, `timeout` | any value: one is shown to the person, the other changes when the command stops |
| `run_in_background` | absent or `false`. In the background nobody reads the result before the next step |
| `dangerouslyDisableSandbox` | absent or `false` |
| any other field | never. A field added to the tool later approves nothing until someone decides |
| `permission_mode` | it is `default` or `acceptEdits` |
| `cwd` | it is a checkout or a worktree of the repository the hook file sits in. No `cwd` is not approved |

**The permission mode.** Claude Code's documentation lists six values:
`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`. The
hook once ignored the field and approved in `plan`, where nothing is meant
to run. It approves in the two modes where a person is asked before a
command, so that an approval takes away a question and nothing more. Not in
`plan`. Not in `dontAsk`, where a command with no rule of its own is refused
and an approval would run it. Not in `auto`, where a classifier judges each
command and an approval would take its place. Not in `bypassPermissions`,
where nothing asks. A value the hook does not know, and no value, is "no".

"The same repository" means git names the same common directory for the
payload's `cwd` and for the hook's own folder (`lib/repository.mts`), so
another clone of the same remote, a repository inside the project and a
folder in no repository are all "no".

Claude Code's documentation says of `cwd`: it "is the worktree root after
Claude enters a worktree, and the new directory after Claude runs `cd`". So
a session that changed folder earlier is judged by where it is now.

The refusal of a joined command reads less strictly, on purpose: any call
that carries a command, from any tool, with any field. Being refused more
often is safe; being approved more often is not. A sweep in the tests joins
and wraps every approved command and every near-miss, over forty thousand
commands, and the hook approves none that is not approved as a whole.

### The checkout: what the push would really do

`git push origin worktree-x` names a remote and a branch. Where the commits
go is decided by more than those words. Each of these was run against a real
repository, with approval on, and each was approved by the hook as it was:

| What an agent can set without being asked | What the approved push then did |
|---|---|
| `push.default upstream`, on a branch that tracks `main` | `worktree-x -> main` |
| `remote.origin.push +refs/heads/worktree-x:refs/heads/main` | a forced update of `main`, with no `+`, `:` or `--force` in the command |
| a tag `worktree-x` and no such branch | `[new tag]` |
| `git symbolic-ref refs/heads/worktree-x refs/heads/main` | `worktree-x -> main` (found while fixing the three above) |
| `remote.origin.pushurl`, a second `remote.origin.url`, `url.<x>.insteadOf` | the commits went to another repository |
| a `pre-push` hook, `core.hooksPath`, `remote.origin.receivepack`, `hook.<name>.command` | a program of the project's ran, with the person's credentials at hand |

**Why not a dry run.** `git push --dry-run --porcelain` would answer the
question directly. It was tried: it contacts the remote, and it runs the
`pre-push` hook. Asking it would itself be the push's side effects, before
any decision. So the hook reads the configuration and judges it.

**How the configuration is read.** `git config --list --show-scope -z`, run
in the call's `cwd`, with the session's environment. That one listing holds
every scope: system, global, the repository's own file, a worktree's, the
command line (`GIT_CONFIG_COUNT`), and every file any of them includes
(`include.path`, `includeIf`). It needs git 2.26; with an older git the
listing fails and nothing is approved.

**The rule.** A push is approved only when all of this holds
(`lib/push.mts`):

- No `GIT_…` variable is in the session's environment, apart from a short
  list that has nothing to do with where a push goes (`GIT_EDITOR`,
  `GIT_PAGER`, `GIT_TERMINAL_PROMPT`, the author and committer variables).
  The others name the configuration files, the repository, or a program.
- `remote.origin.url` is set exactly once, in the repository's own
  configuration, to `https://…`, `ssh://…`, `file://…`, a whole path or
  `user@host:path`. Not `ext::…`, which runs a command; not a scheme git has
  no transport for, which runs `git-remote-<scheme>` from the `PATH`; not
  `http://` or `git://`.
- Every other key of `remote.origin` is one that only says how to fetch
  (`fetch`, `prune`, `tagopt` and six more). `pushurl`, `push`, `mirror`,
  `receivepack`, `uploadpack`, `proxy`, `vcs` and any key nobody has decided
  on: not approved.
- `remote.pushDefault`, `branch.<branch>.remote` and
  `branch.<branch>.pushRemote` are `origin` or unset.
- `branch.<branch>.merge` is `refs/heads/<branch>` or unset: the branch
  tracks its own name, which is what `push -u` leaves, or nothing, which is
  what `pnpm worktree` leaves. **A branch that tracks `main` is not
  approved**, whatever `push.default` is: `git switch -c worktree-x
  origin/main` makes one. It asks, and the reason says so.
- Every `push.*` key is one known to be harmless, with a harmless value:
  `followTags` and `gpgSign` off, `recurseSubmodules` off or `check`,
  `pushOption` unset. `submodule.recurse` off. A `push.*` key nobody has
  decided on: not approved.
- No `hook.*` key, in any scope.
- `url.*`, `credential.*`, `http.*`, `protocol.*`, `ssh.*`,
  `core.sshCommand`, `core.gitProxy`, `core.askPass`: unset, or set in the
  system or the global configuration (next paragraph).
- `refs/heads/<branch>` exists and is not a symbolic ref, and
  `refs/tags/<branch>` does not exist.
- There is no `pre-push` and no `reference-transaction` hook in the hooks
  folder git would use (`git rev-parse --git-path hooks`, which honours
  `core.hooksPath`). Git runs both during a push.

**The line between the person's machine and the project.** A credential
helper, an ssh command, a proxy and a URL rewrite are how a developer's
machine reaches a remote at all, and they live in `~/.gitconfig` or the
system file. Those scopes are the person's own, as their shell and their
`PATH` are: approved. The same setting in the repository's configuration, a
worktree's, an included file of either, or the command line is one an agent
can write with `git config` and no prompt: not approved. Settings that
change which branch is updated or how much is pushed (`push.followTags`,
`remote.origin.push`) are judged the same in every scope.

**It is an allowlist by section, and that has an edge.** Git has no closed
list of settings. In the sections that exist to steer a push (`remote`,
`branch.<branch>`, `push`, `url`, `credential`, `http`, `protocol`, `ssh`,
`hook`) a key the hook does not name is "not approved". In `core` and
`submodule` only the keys named above are read. A setting git gains later in
another section, that redirects a push or names a program for it, is not
seen.

**A project with a `pre-push` hook gets a question on every push**: husky,
lefthook, git-lfs. That is the intent. The hook file is the project's, an
agent can rewrite it, and a push would run it.

### The checkout: which repository `gh` works on

`gh` chooses its repository from more than `origin`: a remote named
`upstream` or `github`, a remote marked `gh-resolved`, `GH_REPO`, `GH_HOST`.
So `gh pr create` and `gh pr merge` are approved only when:

- `origin` is the only remote, and no `remote.*.gh-resolved` key is set;
- no `GH_…` variable is in the session's environment apart from a token and
  a few that only change what is printed. `GH_REPO`, `GH_HOST`,
  `GH_CONFIG_DIR` and any nobody has decided on: not approved;
- the settings a push is held to hold here too, except the ones about the
  branch and the hooks, since these calls push nothing.

### The checkout: whose pull request it is

`gh pr merge 12` says nothing about pull request 12. It may be a stranger's,
from a fork, and text in it may be what told the agent to merge it. With
`approveMerge` on, the hook asks GitHub first, with two reads
(`lib/pull-request.mts`):

```
gh pr view 12 --json number,state,isCrossRepository,headRefName,headRefOid,baseRefName,url
gh repo view --json defaultBranchRef,url
```

It approves only when the pull request is open; `isCrossRepository` is a
literal `false`; its address is `<the repository's address>/pull/12`; its
head is a `worktree-…` branch; its base is the repository's default branch;
and its head commit, the commit in the command (`--match-head-commit`) and
the commit `refs/heads/<head>` is at in this checkout are one and the same.

- **How `gh` is found.** By name, on the `PATH` of the hook's own process,
  which is Claude Code's. The merge is run by a shell the host starts, and
  that shell may find another `gh`: a `PATH` set in a profile, an alias, a
  function. Then the program that was asked is not the program that merges.
  The hook cannot see that. If no `gh` is on the hook's `PATH`, or it fails,
  or it takes more than ten seconds, the merge is not approved.
- **The time limit.** The add-on registers the hook in Claude Code with a
  limit of 30 seconds. A project that took the add-on earlier has 5, and the
  merge keeps the project's value. A hook that runs out of time is stopped
  and answers nothing, so the merge asks. `pnpm agent-workflow:check` notes
  a limit under 30 when `approveMerge` is on.
- **What it does not check**: who opened the pull request, whether its
  checks are green, whether it was reviewed. That is the repository's branch
  protection, and nothing here.

### How it meets the host's rules

Claude Code checks its `deny` and `ask` rules whatever a hook answers. Its
documentation: "PreToolUse hook decisions don't bypass permission rules.
Claude Code evaluates deny and ask rules regardless of what a PreToolUse
hook returns: a matching deny rule blocks the call, and a matching ask rule
still prompts even when the hook returned `"allow"` or `"ask"`." So an
approval from the hook can
only take away a prompt that no rule asked for.

Codex does not take an approval from a hook. Its 0.160.0 binary holds the
message "PreToolUse hook returned unsupported permissionDecision:allow", and
its documentation says that after an answer it does not support it marks
the hook run as failed and lets the call go on. So the hook approves, and
asks, only when it is started with `--host=claude-code`, and only Claude
Code's settings start it so. Under Codex it answers nothing or `deny`, both
of which Codex reads.

### The setting is data, and the hook is a file

The setting was `tools/agent-workflow.config.mts`, which the hook imported
on every shell command. Whatever that file held ran inside the hook, before
any decision. Now it is JSON, read with `JSON.parse`.

**A project that has the old file.** An update writes the new one, with both
approvals off, leaves the old one where it is, and says so under "Still to
do by hand" on every update until the old file is deleted.
`pnpm agent-workflow:check` notes it too. Nothing reads the old file.

Two `ask` rules are merged into `.claude/settings.json`:
`Edit(/tools/agent-workflow/**)` and
`Edit(/tools/agent-workflow.config.json)`. Claude Code's documentation:
"`Edit` rules apply to all built-in tools that edit files", and a leading
`/` is the project's root; a rule written for `Write` or `MultiEdit` is
never consulted. So an editing tool asks before it changes the hook or its
setting. `pnpm agent-workflow:check` fails when an approval is on and
either rule is missing.

**That is all it covers.** A shell command writes the same files with no
editing tool: `sed -i`, `node -e`, `git checkout`, a redirection. No rule
here sees those. The hook does not compare its own files with the
installer's record (`tools/installed.json`) either: the record is a file in
the same folder, and whatever can rewrite the hook can rewrite the record
and the comparison. That would be a check that reads well and stops nothing,
so it was not built.

### The ask rules

Thirteen `ask` rules for commands are merged into `.claude/settings.json`.
The hook never approves what they match, so for the add-on alone they change
nothing. They are a backstop for a project that adds an `allow` rule of its
own: `ask` wins over `allow`.

| Rule | Catches |
|---|---|
| `Bash(git push *--force*)` | `--force`, `--force-with-lease`, `--force-if-includes` |
| `Bash(git push -f*)`, `Bash(git push * -f*)` | `-f`, first or later |
| `Bash(git push * +*)` | a `+refspec` |
| `Bash(git push *:*)` | `source:target` |
| `Bash(git push *--delete*)`, `Bash(git push -d*)`, `Bash(git push * -d*)` | deleting a branch on the remote |
| `Bash(git push *--mirror*)`, `*--all*`, `*--tags*`, `*--prune*` | pushing or pruning more than one branch |
| `Bash(gh pr merge *--admin*)` | merging past the branch's protections |

`pnpm agent-workflow:check` notes any `allow` rule with a `*` for
`git push`, `gh pr create` or `gh pr merge`, and fails when such a rule is
there and one of these is not.

### Limits

Read these before turning an approval on.

- **An approval is words plus the checks listed above, never effects.** The
  hook reads a command, a payload, git's configuration and two answers from
  `gh`. It does not watch what the command then does. Everything below is a
  way for the two to differ.
- **Between the check and the command, things can change.** The hook reads
  the configuration; a moment later git reads it again. Another process, or
  a command the agent left running in the background, can change it in
  between. `--match-head-commit` closes that gap for the commit that is
  merged. Nothing closes it for a push.
- **`origin` is whatever the repository's configuration says.** The hook
  checks the form of the address, not that it is the project's real remote:
  it has no record of what that is. An agent that ran
  `git remote set-url origin https://github.com/someone/else` first pushes
  there, approved. A `git remote` command is local and asks or not by the
  host's rules.
- **The hook and its setting can be rewritten.** The two `Edit` rules ask
  before an editing tool does it. A shell command that writes those files
  is not covered by any rule. An agent that can run shell commands without
  a prompt can turn approval on, or replace the hook. So can anything that
  edits `.claude/settings.json` or `.claude/settings.local.json`.
- **The person's own machine is trusted**: the system and global git
  configuration, the `PATH`, the shell's profile, aliases and functions, the
  `gh` configuration (its aliases and extensions; whether an alias can take
  the place of `pr` was not checked). An agent that can write `~/.gitconfig`
  can redirect an approved push.
- **The environment the command runs in is not seen.** The hook judges its
  own environment, which is the session's. A variable the host sets for the
  command and not for the hook (`GIT_DIR`, `GH_REPO`, a changed `PATH`) is
  invisible to it.
- **The `gh` that is asked may not be the `gh` that merges**, when the
  hook's `PATH` and the shell's differ.
- **Programs on the other end are not seen.** A push to a `file://` or path
  remote runs that repository's `pre-receive` and `post-receive` hooks. A
  push to GitHub starts whatever workflows the repository runs for a pushed
  branch, including one the branch itself changed, where the repository
  lets it.
- **A merge is approved for a pull request, not for its content.** The hook
  checks that it is this checkout's own branch at this commit. It does not
  check the pull request's checks or reviews. With `approveMerge` on, an
  agent that was told by injected text to push bad commits and merge them is
  stopped only by branch protection.
- **The `git` settings list has an edge**, described above: outside the
  sections that steer a push, only named keys are read.
- **Hooks git may run during a push are named, not derived**: `pre-push`
  and `reference-transaction`. A hook a later git runs during a push is not
  on the list.
- **Text in the title and the body is not read.** It cannot run anything,
  but it is posted as written.
- **A person's own shell settings are trusted.** The shell tests run each
  shell with an empty home. An alias or a function named `git`, `gh`,
  `tail` or `head`, a zsh global alias for a word such as `origin`, or an
  option that changes how quotes are read (`RC_QUOTES`) is not seen by the
  hook. Only shells run with `-c` were tried, not interactive ones.
- **Shells not on the machine were not tried.** Here: bash 3.2 as
  `/bin/bash` and as `/bin/sh`, zsh 5.9, dash, bash 5.3. Not fish, ksh,
  busybox, or any shell on Windows. The tests name each shell they skip.
- **That `cwd` follows an earlier `cd`** is from Claude Code's
  documentation; no session was run to see it. If it did not, a session that
  had changed into another clone would be judged by the folder it started
  in.
- **Stricter than needed in places**, on purpose: a quoted branch
  (`"worktree-a"`), `--title=x`, the number after a flag
  (`gh pr merge --merge 12`), joined short flags (`-md`), a branch that
  tracks `main` under a `push.default` that would not follow it, a project
  with a `pre-push` hook, a second remote that `gh` would not have chosen.
  Each asks.
- **Codex gets no approval**, and has no rules in a project file. Its own
  approval settings decide there.
- **Other hooks and other settings can still say otherwise.** A second hook
  that denies wins, and a managed policy wins over the project.

## The worktree script

`pnpm worktree <name>` fetches `origin`'s main and runs
`git worktree add --no-track -b worktree-<name> <path> origin/<main>`. The
start is named; HEAD and the local branches are never read. If the fetch
fails it makes nothing, since `origin/<main>` would then be whatever it was
at the last fetch.

Differences from the source:

- The worktree goes in `<project>-worktrees/<name>`, a folder beside the
  project. The source put it inside the project, under a folder its
  `.gitignore` named; an add-on does not edit `.gitignore`, and a worktree
  inside the project is read by every tool that walks the tree.
- The main branch is the one `origin/HEAD` points at, `main` when the clone
  records none, or `--base <branch>`.
- `--no-track`: the new branch does not track main, so a bare `git push`
  can never go there.
- The name and `--base` are each one plain word: letters, digits and
  `. _ -` (and `/` in a base), starting with a letter or a digit. Both
  are handed to git, and a word that starts with `-` is an option to it:
  `--base "--upload-pack=touch x;git-upload-pack"` once ran that command.
  What `origin/HEAD` names is checked the same way. The fetch also says
  `--end-of-options`, which git has had since 2.24 (2019). An older git
  fails on that word: the script then stops at "could not fetch" and makes
  nothing.
- `--ready` proves the worktree with `pnpm gate:fast`, not with a build: the
  starter compiles nothing. With no `gate:fast` script it says `INSTALLED,
  NOT PROVEN` and exits 1.

## The weekly tag and the changelog

The workflow's shell became `close-week.mts`, so its dates and its order of
steps are tested. It is plain Node with nothing installed: no package's code
runs where the token that can write is. It passes actionlint and zizmor as
the `ci-security` add-on runs them on a laptop (offline), and zizmor's
`auditor` and `pedantic` levels with no finding.

Differences from the source:

- It checks out the default branch, whatever its name.
- It ends the week one second before Monday 00:00 UTC. `git rev-list
  --before` includes the instant it is given, so the source's bound took a
  commit made at 00:00:00 exactly into the week before.
- "No such tag" is told from "could not ask". The source read any failure of
  the lookup as "no tag" and went on to create one.
- A `concurrency` group, so two runs cannot both create the tag.

The command's checkable half is `pnpm changelog check <week>`. It is
stricter than the source's two `grep`s: a merged pull request must be cited
in its own week's section, a definition must point at that number, and the
definitions must be in ascending order. It asks `gh` for the week's merged
pull requests and keeps those merged inside the week to the second.

## Commands, and the two that need another add-on

All three commands are always installed. The two that need another add-on
start with step 0, `node tools/agent-workflow/requires.mts coverage` (or
`visual`), and tell the agent to stop if it does not exit 0. The script
reads `tools/installed.json`, the installer's own record.

Why not install them only when that add-on is present: the order of adding
would then matter. A project that took `agent-workflow` first and `coverage`
a month later would never get the command, with nothing to say why.
`pnpm agent-workflow:check` prints which commands are usable now.

Nothing was added to the other two add-ons. `coverage` already ranks gaps
per file from a fresh run (`pnpm coverage:gaps`), and `visual` already
measures the noise floor with the tier's own comparison and judges both
knobs (`pnpm visual:jitter`). The two commands are the judgement around
those scripts, with the source project's own numbers and file names left out.

No command has a block that runs before the command is read (`` !`…` ``).
In a project-scoped command such a block is parsed and matched against
`allowed-tools` first, and one the host will not analyse yields an error in
place of data while the command carries on. The steps name each command for
the agent to run. That also lets Codex use the same file.

## Claude Code and Codex

| | Claude Code | Codex |
|---|---|---|
| The hook | `PreToolUse`, matcher `Bash`, in `.claude/settings.json` | `PreToolUse`, matcher `Bash`, in `.codex/hooks.json` |
| The refusal | `permissionDecision: "deny"` | The same shape |
| The approval | `permissionDecision: "allow"`, started with `--host=claude-code`; `deny` and `ask` rules still win | Never sent: Codex does not take one from a hook |
| Permission rules | `permissions.ask` in the project | None in the project. Codex's approval mode and sandbox decide |
| Commands | `/workflow:changelog` and the two others | No project slash commands. The skills `$workflow-changelog` and the two others point at the same files |
| `$ARGUMENTS` | Filled in | Not filled in; each command says to take the arguments from the request |
| `allowed-tools` | Read | Ignored |
| Inside the host's sandbox | — | `.codex` and `.agents` are read-only, so the installer leaves the hook registration and the three skills, and its notes say so |

## How it was tested

`pnpm vitest run addons/agent-workflow scripts`. Git behaviour is tested
against real repositories made in a temporary folder, with another folder as
`origin`. GitHub is a function that answers; no test reaches a network.

- `tests/outward.test.mts`: what is outward, how steps are joined, text that
  only mentions a push, commands inside commands, commands that cannot be
  read, and the hook run as a program.
- `tests/new-worktree.test.mts`: a local main behind `origin`, a local main
  ahead of it, HEAD on another branch, a failed fetch, `--ready`.
- `tests/week.test.mts`, `tests/changelog.test.mts`,
  `tests/close-week.test.mts`: week arithmetic across years, the three
  checks, the tag on the right commit (first parent, the second before
  Monday), each refusal by GitHub.
- `tests/approve.test.mts`, with its tables in `tests/shapes.mts`: 30
  commands approved in their exact form, 222 near-misses not approved (each
  tried against the shapes and against the hook), the strict reader, each
  condition on the call and each permission mode, the repository check
  against real repositories and worktrees, the setting read as data, a
  command too deep or too long to read, and the hook run as a program with
  the arguments each host's registration gives it: `allow` only for Claude
  Code, never for Codex, nothing as shipped, nothing from another clone.
- The sweep, in the same file: every approved command and every near-miss
  joined to others by nine separators in both orders and wrapped ten ways,
  over forty thousand commands. The hook approves exactly the 30 approved
  commands (and the same with a space in front), and none of them for a
  call from another folder, another tool, the background or plan mode.
- `tests/push.test.mts`: what a push would really do. Each test makes a
  project and its `origin` in a temporary folder, changes one thing an
  agent can change without being asked, and reads the hook's answer. For
  the changes that send a push elsewhere or run a program, the push is then
  run, so the test is known to hold the redirect it is named for: the
  branch that tracks `main`, the push refspec, the tag, the symbolic ref,
  the push URL, two URLs, `insteadOf`, the three hooks, `receivepack`.
  Then the second sweep: all 30 approved commands in each of 45 checkouts
  that are not plain. None is approved, and each is asked about with a
  reason.
- `tests/pull-request.test.mts`: the check before a merge, with a stand-in
  for `gh` first on the `PATH` of the hook under test and of nothing
  else. Each field that makes a pull request not this checkout's own, a
  `gh` that fails or prints something else, no `gh` at all, and that
  only the two reads are ever made.
- `tests/shells.test.mts`: the 30 approved commands and 31 hostile strings
  the reader takes, run through each shell on the machine with a program
  that prints its arguments in place of `git` or `gh`. Each shell must pass
  on exactly the words the reader read, print nothing else, and leave no
  file behind. Here that was bash 3.2 as `/bin/bash` and as `/bin/sh`,
  zsh 5.9, dash and bash 5.3: all agreed on all of them. 19 more strings
  are shown to be refused. The same file runs the old heredoc form through
  each shell and requires bash 3.2 to run its body and the others not to,
  so the test is known to see the difference it is there for. A shell that
  is absent is skipped by name.
- `tests/check.test.mts`: the verify command and `requires.mts`.
- `tests/new-worktree.test.mts` also holds the base that ran a command,
  and sixteen other words that are not a branch name.
- `tests/addon.test.mts`: the manifest, the workflow's standards, the
  commands, the ask rules against a model of the host's matching, and
  the add-on installed into a project with the real kit: merged, unchanged
  the second time, nothing of the project's dropped.
- `scripts/host-settings.test.mts`, `scripts/add-to-project.test.mts`: the
  merge and the installer.

Every test was turned red by a mutant of its own and restored: 661 mutants
in `tests/mutants.json`, run with the coverage add-on's `mutation-check.mts`,
all killed. Each of its test commands was first seen green and selecting at
least one test, since a filter that matches no test exits 0 and would read
as a mutant that survived.

Six tests judge a table or a shell and not code, and were turned red by
hand: no `.sh` file is shipped; no near-miss is given twice; the sweep is
over five thousand commands; at least one shell is found; the heredoc form
is refused; bash 3.2 runs the heredoc's body. Three tests are there because
of the heredoc that was removed (it is not approved, the hook says nothing
about it, the reader refuses it). No single change to the code as it is now
brings the heredoc back, so no mutant turns those three red. The same holds
for the two tests that a setting written as code is never run: no single
change makes `JSON.parse` run a file.

For the approval, a mutant removes or loosens one restriction at a time:
each character the reader has no token for, each control character kept out
of quotes, each word and count of the push, each flag kept out of the two
tables, each rule about what may follow, each condition on the call, each
part of the repository check, each permission mode, each setting that
redirects a push or names a program for it, each field of the pull request,
each bound on what is read. Every one turns a test red. One row removes
two guards at once, because the sweep's main property has two: a joined
command is refused before it is read for approval, and it is then read
whole. Taking out either alone approves nothing wrong.

What the first runs found, before all were killed:

- **After the security review**, the first run of the new rows left twelve
  alive, and each was a test that could not see the mistake. A near-miss
  for the number of a merge had the commit flag where the number goes, so
  it was refused for that and never reached the number's check. Five
  near-misses for `gh pr create` without `--head` were never added: the
  script that wrote them found nowhere to put them and said nothing. An
  address `--upload-pack=touch ran` held a space, which the address pattern
  refuses for the space. Three checks of the pull request compared two
  missing values, and two missing values are equal. A stand-in `gh` that
  failed also printed nothing, so "exit code ignored" looked the same. The
  bound on nesting was hidden behind the catch that turns a stack overflow
  into a refusal: both give the same answer, so the bound is now tested on
  the reader itself. And `gh issue create` was refused for having no
  `--head`, whatever the reader made of `issue`.

- **Tests that could not see the mistake**, fixed. A here-string was never
  followed by a new line. `${…}` was only tried inside quotes. The worktree
  test compared a path its own helper had worked out. The check's test read
  only the exit code. A near-miss with `--author-email` held an `@`, which
  the reader refuses anyway, so it never reached the flag table. The test of
  the three shapes read its own table and not the code.
- **The heredoc escape was not found by any of this.** The mutants showed
  every rule of the heredoc form to be load-bearing, and the form itself was
  wrong: a mutant asks whether a test notices a rule going missing, not
  whether the rules are the right ones. It was found by running the text
  through an old shell, which is now a test.
- **Near-misses that were missing**: `2>&1 2>&1 tail -2`, which hands `tail`
  to git as a branch; a quoted `'|'`; a heredoc that closes with two other
  characters; a heredoc with no opening quote.
- **Checks no input could reach**, removed or folded into the check that
  made them unreachable: a week's section also ending at the link
  definitions; a second test for a list of words in the hook; a separate
  search for the heredoc's end beside the search for its first delimiter
  line; two spellings of "a gap is a space or a tab".
- **Mutants that change nothing**, dropped or replaced: a looser pattern for
  a week's name behind a check that refuses the same names; a `>` mark,
  which the rule for what may follow refuses; "too few words" in a push,
  which the branch pattern refuses.

## Not verified

- **The hook in a live session of either host.** It was run by hand with
  both hosts' payloads. Codex's side rests on its documentation and on the
  schemas in the 0.160.0 binary (`PreToolUse`, tool name `Bash`,
  `tool_input.command` as text, `permissionDecision: "deny"`).
- **Codex finding the skills** in `.agents/skills`. That is the documented
  place for a repository's skills; no session was run.
- **Shells and settings beyond those run here.** Five shells, each with an
  empty home and started with `-c`. Not an interactive shell, not a
  person's aliases or options, not fish, ksh or busybox, not Windows.
- **That `cwd` in the payload follows an earlier `cd`.** From Claude Code's
  documentation; no session was run.
- **The approval in Claude Code itself.** That an `ask` or `deny` rule wins
  over a hook's `allow` is from its documentation, quoted above; no session
  was run to see it. The ask rules are matched in tests with a model of the
  documented pattern syntax.
- **The `ask` answer, the two `Edit` rules and `permission_mode` in Claude
  Code itself.** That a hook may answer `ask`, that an `Edit(/path)` rule is
  read for every editing tool with `/` as the project's root, and the six
  values of `permission_mode` are from its documentation. No session was run
  to see a prompt appear, or the field arrive.
- **The merge check against GitHub.** It was run against a stand-in for
  `gh` that prints what the test gives it. The field names are the ones
  `gh pr view --json` and `gh repo view --json` list (gh 2.102.0, read from
  the program with no network). What GitHub answers for a real pull request,
  from a fork or not, was not seen; nor was `--match-head-commit` refusing a
  merge.
- **git older or newer than 2.56.0.** The redirects were run with that
  version. `--show-scope` needs 2.26 and `--end-of-options` 2.24; with an
  older git nothing is approved and the worktree script makes nothing, which
  was reasoned and not run. Hooks named in the configuration (`hook.*`) run
  in 2.56.0; an older git ignores those keys, and the hook refuses them all
  the same.
- **A project with husky, lefthook or git-lfs.** That each leaves a
  `pre-push` file where the hook looks was reasoned from how they install;
  none was installed here.
- **What Codex does with `allow`** was read from its binary and its
  documentation, which differ on it. The hook sends Codex none, so the
  difference does not matter here.
- **The workflow on GitHub.** It was linted, and its script was tested with
  a stand-in for `gh`. No tag or issue was created anywhere. The lint ran
  with no token, so zizmor's checks that ask GitHub (an action with a known
  advisory) did not run, and actionlint did not check the shell, since
  shellcheck was not installed. The `CI security` workflow runs both.
