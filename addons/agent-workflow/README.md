# Add-on: agent-workflow

How an agent ships work from a project created from the starter: each push
and pull request step in a tool call of its own, the routine ones
pre-approved, every change started in a fresh worktree, each finished week
tagged, and a changelog whose completeness is checked.

```bash
node scripts/add-to-project.mts <project> agent-workflow
cd <project> && pnpm install && pnpm agent-workflow:check
```

It is not recommended by default: it assumes the project is on GitHub, uses
pull requests, and lets an agent push.

## What it adds

| Part | Where | What it does |
|---|---|---|
| The hook | `tools/agent-workflow/hooks/split-outward-commands.mts` | Before each shell command: refuses one that joins an outward step to anything else |
| Its registration | `.claude/settings.json`, `.codex/hooks.json` | Merged in under `hooks.PreToolUse`, matcher `Bash`, beside the kit's hooks |
| Permission rules | `.claude/settings.json` | Merged in: four `allow` rules for the routine steps, five `ask` rules for a forced push |
| `pnpm worktree <name> [--ready]` | `tools/agent-workflow/new-worktree.mts` | A worktree beside the project on `worktree-<name>`, cut from `origin`'s main by name |
| `pnpm changelog weeks\|prs\|check` | `tools/agent-workflow/changelog.mts` | The weeks with no entry, a week's merged pull requests, and the proof that each is cited |
| Weekly tag | `.github/workflows/weekly-tag.yml`, `tools/agent-workflow/close-week.mts` | Monday 00:05 UTC: tags the finished ISO week, opens "Changelog: write `<week>`" |
| `CHANGELOG.md` | project root | A starting file: the format, no week yet. The project owns it |
| Three commands | `.claude/commands/workflow/*.md` | `/workflow:changelog`, `/workflow:coverage-backfill`, `/workflow:visual-tolerance-audit` |
| The same for Codex | `.agents/skills/workflow-*/SKILL.md` | One small skill per command, which points at the command file |
| `node tools/agent-workflow/requires.mts <add-on>` | same | Exit 0 when the add-on is installed, exit 2 with what to do when not |
| `pnpm agent-workflow:check` | `tools/agent-workflow/check.mts` | The add-on's `verify`: runs the hook on two commands, reads both settings files |

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
that only feeds it (the usual way to give `gh pr create` its body), or with
variables set in front.

Text is not a step. A commit message, an `echo`, a `grep` pattern, a heredoc
body or a comment may say `git push && gh pr create` and nothing is refused.
The hook reads the command with a small scanner of its own
(`lib/shell.mts`): quotes, heredocs (`<<`, `<<-`, quoted delimiters),
redirections, pipes, separators, grouping, substitutions.

**A command it cannot read is let through.** A quote that never closes, a
heredoc that never ends: the hook has no verdict, and the host's permission
rules are the only judge. That was the source's choice too. The hook orders
the work; it is not what stops a push.

Its reply is `hookSpecificOutput.permissionDecision: "deny"` with the reason,
on stdout, exit 0. Both hosts read that shape.

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

### The permission rules

| List | Rule | Meaning |
|---|---|---|
| `allow` | `Bash(git push -u origin worktree-*)`, `Bash(git push origin worktree-*)` | Pushing a work branch, from inside its worktree |
| `allow` | `Bash(gh pr create *)`, `Bash(gh pr merge *)` | Opening and merging a pull request |
| `ask` | `Bash(git push *--force*)` | `--force`, `--force-with-lease`, `--force-if-includes` |
| `ask` | `Bash(git push -f*)`, `Bash(git push * -f*)` | `-f`, first or later |
| `ask` | `Bash(git push * +*)` | A `+refspec` |
| `ask` | `Bash(git push *:*)` | `source:target`, which the source's rules let through as `worktree-a:main` |

`ask` wins over `allow`. A push of any other branch, and `git -C dir push`,
match no rule and get the host's default, which is to ask.

**Limits.** `git push origin worktree-a main` (a second branch after the
first) matches the `allow` rule: a pattern with `*` cannot say "one word".
`gh pr merge *` pre-approves every merge, including `--admin`. A project
that wants a person to approve each merge removes that rule. Codex has no
permission rules in a project file; its own approval settings decide there.

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
| The refusal | `permissionDecision: "deny"` | The same shape. `ask` and `allow` are not supported there; the hook uses neither |
| Permission rules | `permissions.allow` and `.ask` in the project | None in the project. Codex's approval mode and sandbox decide |
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
- `tests/check.test.mts`: the verify command and `requires.mts`.
- `tests/addon.test.mts`: the manifest, the workflow's standards, the
  commands, the permission rules against a model of the host's matching, and
  the add-on installed into a project with the real kit: merged, unchanged
  the second time, nothing of the project's dropped.
- `scripts/host-settings.test.mts`, `scripts/add-to-project.test.mts`: the
  merge and the installer.

Every test was turned red by a mutant of its own and restored: 218 mutants
in `tests/mutants.json`, run with the coverage add-on's `mutation-check.mts`,
all killed. Each of its 203 test commands was first seen green and selecting
at least one test, since a filter that matches no test exits 0 and would
read as a mutant that survived. One more test ("ships TypeScript and nothing
else that runs") was turned red by hand, by adding a `.sh` file.

The first run killed 210. What the other seven were:

- Four tests that could not see the mistake, now fixed. A here-string was
  never followed by a new line, so a reader that took it for a heredoc and
  swallowed the next command passed. `${…}` was only tried inside quotes.
  The worktree test compared a path its own helper had worked out, not the
  one the tool reported. The check's test read only the exit code, which the
  other host's file also turned to 1.
- One piece of code no caller could observe (a week's section also ending at
  the link definitions). It was removed.
- One mutant that changes nothing (a looser pattern for a week's name, behind
  a second check that refuses the same names), replaced by one that does.
- One fault in the spec: a `find` that occurred twice.

## Not verified

- **The hook in a live session of either host.** It was run by hand with
  both hosts' payloads. Codex's side rests on its documentation and on the
  schemas in the 0.160.0 binary (`PreToolUse`, tool name `Bash`,
  `tool_input.command` as text, `permissionDecision: "deny"`).
- **Codex finding the skills** in `.agents/skills`. That is the documented
  place for a repository's skills; no session was run.
- **The permission rules in Claude Code itself.** The tests match them with a
  model of the documented pattern syntax.
- **The workflow on GitHub.** It was linted, and its script was tested with
  a stand-in for `gh`. No tag or issue was created anywhere. The lint ran
  with no token, so zizmor's checks that ask GitHub (an action with a known
  advisory) did not run, and actionlint did not check the shell, since
  shellcheck was not installed. The `CI security` workflow runs both.
