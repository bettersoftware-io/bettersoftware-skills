# Add-on: agent-workflow

How an agent ships work from a project created from the starter: each push
and pull request step in a tool call of its own, every change started in a
fresh worktree, each finished week tagged, and a changelog whose
completeness is checked. The hook refuses and never says yes: every push and
pull request step still asks a person.

```bash
node scripts/add-to-project.mts <project> agent-workflow
cd <project> && pnpm install && pnpm agent-workflow:check
```

It is not recommended by default: it assumes the project is on GitHub, uses
pull requests, and lets an agent push.

## What it adds

| Part | Where | What it does |
|---|---|---|
| The hook | `tools/agent-workflow/hooks/split-outward-commands.mts` | Before each shell command: refuses one that joins an outward step to anything else. It says nothing about any other command |
| Its registration | `.claude/settings.json`, `.codex/hooks.json` | Merged in under `hooks.PreToolUse`, matcher `Bash`, beside the kit's hooks |
| Permission rules | `.claude/settings.json` | Merged in: thirteen `ask` rules for a forced or destructive push and an `--admin` merge, and one for an edit of the hook. No `allow` rule |
| `pnpm worktree <name> [--ready]` | `tools/agent-workflow/new-worktree.mts` | A worktree beside the project on `worktree-<name>`, cut from `origin`'s main by name |
| `pnpm changelog weeks\|prs\|check` | `tools/agent-workflow/changelog.mts` | The weeks with no entry, a week's merged pull requests, and the proof that each is cited |
| Weekly tag | `.github/workflows/weekly-tag.yml`, `tools/agent-workflow/close-week.mts` | Monday 00:05 UTC: tags the finished ISO week, opens "Changelog: write `<week>`" |
| `CHANGELOG.md` | project root | A starting file: the format, no week yet. The project owns it |
| Three commands | `.claude/commands/workflow/*.md` | `/workflow:changelog`, `/workflow:coverage-backfill`, `/workflow:visual-tolerance-audit` |
| The same for Codex | `.agents/skills/workflow-*/SKILL.md` | One small skill per command, which points at the command file |
| `node tools/agent-workflow/requires.mts <add-on>` | same | Exit 0 when the add-on is installed, exit 2 with what to do when not |
| `pnpm agent-workflow:check` | `tools/agent-workflow/check.mts` | The add-on's `verify`: runs the hook on three commands as each host starts it, and reads both settings files |

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
that only feeds it, or with variables set in front. Let through means only
that it is not refused: the host asks about it as it always does.

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

Its reply is `hookSpecificOutput.permissionDecision: "deny"` with the reason,
on stdout, exit 0. Both hosts read it. For anything else it prints nothing.
Those are its only two outputs: the type of its answer has no other decision.
It reads standard input and nothing else, and it ignores any argument it is
started with.

**The refusal is not a lock.** Each host gives the hook five seconds. When a
`PreToolUse` hook runs out of time, or ends with an error that is not a
refusal, both hosts record that and let the call go ahead to their own
permission rules: a hook that fails does not block. So the hook is built not
to fail (above), and it is quick: a command of a million characters, the
longest it reads, is answered in about a tenth of a second here, and a test
holds it under half the time limit. What stops a push is still the host's
prompt and the remote's branch protection.

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
- A hook counts as there when its command is in a group whose matcher still
  covers `Bash`: the same matcher, none, `*`, or a list that names it. A
  longer timeout or a wider matcher changes nothing, and it is not added a
  second time. Under any other matcher (`Edit`, `Nothing`) the command does
  not run before a shell command, so the add-on's own group is added, and
  the check fails until it is.
- Nothing is removed. One command line is rewritten: that of a hook this
  add-on registered under an older form. See
  [below](#updating-a-project-that-had-it) and `retiredHookCommands` in
  [the contract](../README.md).
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

## Why the hook does not approve anything

Earlier versions let a routine push, pull request and merge run unasked:
first by `allow` rules, then by the hook answering `allow` for an exact form.
Three security reviews each found a way round it:

- an `allow` pattern ending in `*` also matched `worktree-a main` and `--mirror`;
- a heredoc body was read as text, and bash 3.2 runs what such a body holds;
- git configuration sent a push that named a work branch to `main`.

A hook reads words and cannot vouch for effects, so the feature was removed.
A project that wants a step unasked writes its own `permissions.allow` rule
in its settings, knowing that a pattern ending in `*` cannot say "one word",
and keeps branch protection on. The hook has still not been run in a live
session of either host.

### Updating a project that had it

- `tools/agent-workflow.config.json`, or the older `.mts`, is no longer
  read. The update and the check say so until the file is deleted.
- `.claude/settings.json` may start the hook with `--host=claude-code` and a
  timeout of 30. The update takes the argument off that command line where
  it stands and changes nothing else: the entry's timeout, its group, the
  matcher and the hooks beside it stay, and no group is taken out. Only when
  that leaves the same line twice in one group does the later one go. A
  command line that is not the old one letter for letter is left alone and
  named. Until the update runs, the old line still works: the hook ignores
  its arguments.
- The ask rule `Edit(/tools/agent-workflow.config.json)` stays, since a merge
  removes no rule. It does no harm.

The setting file and that rule can be deleted by hand.

### The ask rules

Thirteen `ask` rules for commands are merged into `.claude/settings.json`.
For the add-on alone they change nothing: without an `allow` rule those
commands ask anyway. They are a backstop for a project that adds an `allow`
rule of its own: `ask` wins over `allow`.

| Rule | Catches |
|---|---|
| `Bash(git push *--force*)` | `--force`, `--force-with-lease`, `--force-if-includes` |
| `Bash(git push -f*)`, `Bash(git push * -f*)` | `-f`, first or later |
| `Bash(git push * +*)` | a `+refspec` |
| `Bash(git push *:*)` | `source:target` |
| `Bash(git push *--delete*)`, `Bash(git push -d*)`, `Bash(git push * -d*)` | deleting a branch on the remote |
| `Bash(git push *--mirror*)`, `*--all*`, `*--tags*`, `*--prune*` | pushing or pruning more than one branch |
| `Bash(gh pr merge *--admin*)` | merging past the branch's protections |

One more `ask` rule is merged in: `Edit(/tools/agent-workflow/**)`. The hook
is what refuses a chain, so an editing tool asks before it changes the hook
or the files beside it. It covers the editing tools and not a shell command:
`sed -i`, a redirection or `git checkout` writes the same files and no rule
here sees it. The installer writes those files itself, so an update does not
ask. `pnpm agent-workflow:check` notes it when the project took the rule out.

`pnpm agent-workflow:check` notes any `allow` rule with a `*` for
`git push`, `gh pr create` or `gh pr merge`, and fails when such a rule is
there and one of these is not.

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
- `tests/never-allows.test.mts`, with its tables in `tests/shapes.mts`: the
  30 commands an earlier version let run unasked, each piped to the hook as
  each host starts it and as an old registration starts it, in a real
  repository that still holds the old setting with everything on. Then the
  same 30 and 222 commands one step away from them, joined by nine
  separators in both orders and wrapped ten ways: over forty thousand
  commands, in three shapes of payload. The answer is nothing or `deny` for
  every one. The type of the answer is tested too: it has no other decision.
  The same file holds the bounds: a command too deep or too long to read,
  and a payload that is not JSON.
- `tests/check.test.mts`: the verify command and `requires.mts`.
- `tests/new-worktree.test.mts` also holds the base that ran a command,
  and sixteen other words that are not a branch name.
- `tests/addon.test.mts`: the manifest, the workflow's standards, the
  commands, the ask rules against a model of the host's matching, and
  the add-on installed into a project with the real kit: merged, unchanged
  the second time, nothing of the project's dropped. Also the update of a
  project that had the old setting files and the old registration: one hook
  after it, started as it is now, the rest of its entry kept, each leftover
  named.
- `scripts/host-settings.test.mts`, `scripts/add-to-project.test.mts`: the
  merge and the installer.

Every test was turned red by a mutant of its own and restored: 394 mutants
in `tests/mutants.json`, run with the coverage add-on's `mutation-check.mts`,
all killed. Two of them are judged by the type checker, not by a test run. Each of its test commands was first seen green and selecting at
least one test, since a filter that matches no test exits 0 and would read
as a mutant that survived.

Three tests judge a table and not code, and were turned red by hand: no
`.sh` file is shipped; no near-miss is given twice; the sweep is over five
thousand commands.

## Not verified

- **The hook in a live session of either host.** It was run by hand with
  both hosts' payloads. Codex's side rests on its documentation and on the
  schemas in the 0.160.0 binary (`PreToolUse`, tool name `Bash`,
  `tool_input.command` as text, `permissionDecision: "deny"`).
- **Codex finding the skills** in `.agents/skills`. That is the documented
  place for a repository's skills; no session was run.
- **What a host does with a hook that times out or crashes.** That the call
  then goes ahead is from each host's documentation; no session was run to
  see it. The same holds for the `Edit(/path)` rule form.
- **The ask rules in Claude Code itself.** That an `ask` rule wins over an
  `allow` rule is from its documentation; no session was run to see it. The
  rules are matched in tests with a model of the documented pattern syntax.
- **The workflow on GitHub.** It was linted, and its script was tested with
  a stand-in for `gh`. No tag or issue was created anywhere. The lint ran
  with no token, so zizmor's checks that ask GitHub (an action with a known
  advisory) did not run, and actionlint did not check the shell, since
  shellcheck was not installed. The `CI security` workflow runs both.
