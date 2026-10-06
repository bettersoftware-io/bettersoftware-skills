# Add-on: agent-workflow

How an agent ships work from a project created from the starter: each push
and pull request step in a tool call of its own, the routine ones approved
by their exact shape, every change started in a fresh worktree, each finished week
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
| The hook | `tools/agent-workflow/hooks/split-outward-commands.mts` | Before each shell command: refuses one that joins an outward step to anything else, and in Claude Code approves a routine one written in its exact form |
| The setting | `tools/agent-workflow.config.mts` | A starting file: `approveExactShapes`, the one place approval is turned off |
| Its registration | `.claude/settings.json`, `.codex/hooks.json` | Merged in under `hooks.PreToolUse`, matcher `Bash`, beside the kit's hooks |
| Permission rules | `.claude/settings.json` | Merged in: thirteen `ask` rules for a forced or destructive push and an `--admin` merge. No `allow` rule |
| `pnpm worktree <name> [--ready]` | `tools/agent-workflow/new-worktree.mts` | A worktree beside the project on `worktree-<name>`, cut from `origin`'s main by name |
| `pnpm changelog weeks\|prs\|check` | `tools/agent-workflow/changelog.mts` | The weeks with no entry, a week's merged pull requests, and the proof that each is cited |
| Weekly tag | `.github/workflows/weekly-tag.yml`, `tools/agent-workflow/close-week.mts` | Monday 00:05 UTC: tags the finished ISO week, opens "Changelog: write `<week>`" |
| `CHANGELOG.md` | project root | A starting file: the format, no week yet. The project owns it |
| Three commands | `.claude/commands/workflow/*.md` | `/workflow:changelog`, `/workflow:coverage-backfill`, `/workflow:visual-tolerance-audit` |
| The same for Codex | `.agents/skills/workflow-*/SKILL.md` | One small skill per command, which points at the command file |
| `node tools/agent-workflow/requires.mts <add-on>` | same | Exit 0 when the add-on is installed, exit 2 with what to do when not |
| `pnpm agent-workflow:check` | `tools/agent-workflow/check.mts` | The add-on's `verify`: runs the hook on three commands as each host starts it, reads both settings files, says whether approval is on |

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

Its reply is `hookSpecificOutput.permissionDecision` with the reason, on
stdout, exit 0: `"deny"` for a joined command, which both hosts read, and
`"allow"` for an approved shape, which only Claude Code is sent
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

The add-on ships no `allow` rule. A first version did, and they were
escapable: a pattern that ends in `*` cannot say "one word".
`Bash(git push origin worktree-*)` also matched
`git push origin worktree-a main`, `worktree-a --delete main`, `--mirror`
and `--tags`; `Bash(gh pr merge *)` matched `--admin`; and
`Bash(gh pr create *)` matched a body of `"$(any command)"`. Naming the bad
spellings in `ask` is a blocklist, and a blocklist misses one.

So the hook approves, from an allowlist of shapes (`lib/approve.mts`). It
reads the command with a second, strict reader that has a token for only
what the shapes need. Whatever it has no token for is not approved.

| Token | What it is |
|---|---|
| bare | letters, digits and `_ . / -` |
| `'single'` | any text up to the next single quote; the shell changes none of it |
| `"double"` | text with no `$`, backtick or backslash, so nothing in it is expanded |
| heredoc | exactly `"$(cat <<'DELIM'`, lines, `DELIM`, `)"`, the delimiter in single quotes |
| mark | `2>&1` and `\|`, only after the step |

A token ends at a space or at the end, so `a"b"` is not one. There is no
token for a variable, a glob, a brace list, `~`, a backtick, any other
substitution, a redirection to a file, `;`, `&`, a comment, or a new line
outside quotes.

| Shape | Exactly |
|---|---|
| Push a work branch | `git push [-u \| --set-upstream] origin worktree-<name>`, all bare. `<name>` is letters and digits joined by single `.`, `_` or `-`; the branch is at most 100 characters |
| Open a pull request | `gh pr create`, then any of `--title`/`-t` text, `--body`/`-b` text or heredoc, `--base`/`-B` branch, `--head`/`-H` work branch, `--draft`/`-d`, `--fill`/`-f`, each at most once |
| Merge a pull request | `gh pr merge <number>`, then any of one way to merge (`--merge`/`-m`, `--squash`/`-s`, `--rebase`/`-r`), `--delete-branch`/`-d`, `--subject`/`-t` text, `--body`/`-b` text or heredoc, each at most once |
| After any of them | nothing, `2>&1`, `\| tail -<n>` or `\| head -<n>` (also `-n <n>`), or `2>&1` and then the pipe |

Decisions on the flags:

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
the hook run as failed and lets the call go on. So the hook approves only when it is started with
`--host=claude-code`, and only Claude Code's settings start it so. Under
Codex it answers nothing or `deny`, both of which Codex reads.

### Turning it off

One place: `tools/agent-workflow.config.mts`, a file the project owns.

```ts
export const approveExactShapes: boolean = false;
```

With that, the hook approves nothing and every push and pull request step
asks. The refusal of a joined command does not depend on it. A file that is
missing, cannot be loaded, or sets anything but `true` also means off.

The default is on. Without it the add-on would pre-approve nothing, and the
closing steps of every piece of work would each wait for a person, which is
the cost the add-on exists to remove. What is approved is narrow enough to
state in one table, and a project that disagrees changes one word.

### The ask rules

Thirteen `ask` rules are still merged into `.claude/settings.json`. The
hook never approves what they match, so for the add-on alone they change
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

- **The hook approves words, not what they do.** `origin` is whatever the
  clone's `origin` points at, and the hook does not look. An agent that
  first ran `git remote set-url origin …` pushes somewhere else, approved.
  That earlier command is a local one, and asks or not by the host's rules.
- **It does not check which checkout the push runs in**, or that the branch
  pushed is the one checked out.
- **A push starts whatever the branch's workflows start.** A work branch
  that changes a workflow file runs that workflow, where the repository
  lets it.
- **`gh pr merge <number>` merges whatever that number is**, with its checks
  red if the branch's protections allow that. The hook does not ask GitHub.
- **`gh pr create` may push** the current branch when it has not been
  pushed, and may prompt; `--head` avoids both.
- **Text in the title and the body is not read.** It cannot run anything,
  but it is posted as written.
- **git and gh settings are trusted**: a `pushurl`, a push refspec in the
  config, a `gh` alias or extension. Whether `gh` lets an alias take the
  place of `pr` was not checked.
- **Stricter than needed in places**, on purpose: a quoted branch
  (`"worktree-a"`), `--title=x`, the number after a flag
  (`gh pr merge --merge 12`), `gh pr merge` with no number, joined short
  flags (`-md`). Each asks.
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
- `tests/approve.test.mts`: 29 commands approved in their exact form, 191
  near-misses not approved (each tried against the shapes and against the
  hook), the strict reader, the setting, and the hook run as a program with
  the arguments each host's registration gives it: `allow` only for Claude
  Code, never for Codex, nothing with approval off.
- `tests/check.test.mts`: the verify command and `requires.mts`.
- `tests/addon.test.mts`: the manifest, the workflow's standards, the
  commands, the ask rules against a model of the host's matching, and
  the add-on installed into a project with the real kit: merged, unchanged
  the second time, nothing of the project's dropped.
- `scripts/host-settings.test.mts`, `scripts/add-to-project.test.mts`: the
  merge and the installer.

Every test was turned red by a mutant of its own and restored: 367 mutants
in `tests/mutants.json`, run with the coverage add-on's `mutation-check.mts`,
all killed. Each of its 345 test commands was first seen green and selecting
at least one test, since a filter that matches no test exits 0 and would
read as a mutant that survived. Two tests judge a table and not code, and
were turned red by hand: "ships TypeScript and nothing else that runs" by
adding a `.sh` file, and "no two the same" by giving a near-miss twice.

For the approval, a mutant removes or loosens one restriction at a time:
each character the reader has no token for, each rule of the heredoc form,
each word and count of the push, each flag kept out of the two tables, each
rule about what may follow. Every one turns a test red.

What the first runs found, before all were killed:

- **Tests that could not see the mistake**, fixed. A here-string was never
  followed by a new line. `${…}` was only tried inside quotes. The worktree
  test compared a path its own helper had worked out. The check's test read
  only the exit code. A near-miss with `--author-email` held an `@`, which
  the reader refuses anyway, so it never reached the flag table. The test of
  the three shapes read its own table and not the code.
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
- **The approval in Claude Code itself.** That an `ask` or `deny` rule wins
  over a hook's `allow` is from its documentation, quoted above; no session
  was run to see it. The ask rules are matched in tests with a model of the
  documented pattern syntax.
- **What Codex does with `allow`** was read from its binary and its
  documentation, which differ on it. The hook sends Codex none, so the
  difference does not matter here.
- **The workflow on GitHub.** It was linted, and its script was tested with
  a stand-in for `gh`. No tag or issue was created anywhere. The lint ran
  with no token, so zizmor's checks that ask GitHub (an action with a known
  advisory) did not run, and actionlint did not check the shell, since
  shellcheck was not installed. The `CI security` workflow runs both.
