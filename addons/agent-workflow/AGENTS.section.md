## Agent workflow

How a change leaves this machine. A hook refuses a shell command that joins
an outward step to anything else; this section is what the hook cannot
decide: when the outward steps run.

```bash
pnpm worktree <name> [--ready]     # a worktree beside the project, on worktree-<name>, cut from origin's main
pnpm changelog weeks               # the weeks CHANGELOG.md has no entry for
pnpm changelog prs <week>          # what was merged in a week (reads GitHub)
pnpm changelog check <week>        # every merged pull request cited, every citation defined
pnpm agent-workflow:check          # the hook works and is registered; whether approval is on
```

### An outward step is a call of its own

An outward step sends something off this machine or changes shared state:
`git push`, `gh pr create`, `merge`, `edit`, `comment` or `close`,
`gh workflow run`, `gh run rerun` or `cancel`, a `gh api` call that writes,
and `gh issue`, `gh release` and `gh repo` writes. Everything else is local:
`git add`, `git commit`, `git fetch`, tests, `gh pr view`, `gh run list`.

Run each outward step as its own tool call. A pipe into a filter
(`git push 2>&1 | tail -2`) is still one step. Joining it to anything with
`&&`, `;`, `||` or a new line is refused. When the hook refuses a command,
split it. Do not reword it to get past the hook: the point is the order of
the work, not the shape of the command.

### Put the outward steps at the two ends

Plan a piece of work in three parts:

1. **Start:** anything outward the work depends on, such as a workflow run
   whose result you need later. Often nothing.
2. **Local work:** the worktree, edits, tests, gates, commits. Nothing here
   asks for permission. For several pull requests, do the local work of all
   of them here.
3. **End:** push, open the pull request, watch its checks, merge, clean up.
   One call each, one after the other.

A person may be away while you work, and each permission prompt stops the
session until they return. Prompts at the two ends cost two waits; prompts
spread through the work cost one wait each.

- Waiting for checks is not a reason to start local work that will need a
  second push. Use the wait to read and to write the report.
- A decision the user must make (whether to merge, whether to delete) goes at
  the same end, not in the middle.
- If you pushed and then found one more edit, fold it into the next closing
  batch. Do not push after every edit.

Skip this ordering for a task with no outward step, and when the user asks
for a push now.

### What runs without a prompt

In Claude Code the hook approves a command that is exactly one of these and
nothing more. Write the closing steps in these forms:

- `git push -u origin worktree-<name>` (or without `-u`), run from inside
  the worktree.
- `gh pr create` with `--title`, `--body`, `--base`, `--head`, `--draft`,
  `--fill` or their short forms. Give text in single quotes, or in double
  quotes with no `$`, backtick or backslash in it. For a long body use
  `--body "$(cat <<'EOF'`, the lines, `EOF`, `)"`, with the delimiter in
  single quotes.
- `gh pr merge <number>` with one of `--merge`, `--squash`, `--rebase`, and
  `--delete-branch`, `--subject`, `--body`.

Each may end in `2>&1`, in `| tail -<n>` or `| head -<n>`, or in both.

Anything else asks: another flag, a second branch, a variable, a file to
read the body from, another remote, `git -C <dir> push`, a push of a branch
not named `worktree-…`. Do not try another spelling to avoid the question:
it is there for a person to answer. Never use `--admin`, `--force` or
`--delete` unless the user asked for exactly that.

Whether the hook approves at all is the project's choice:
`approveExactShapes` in `tools/agent-workflow.config.mts`. Do not change
that file unless the user asks. With it off every push and pull request
step asks, and the hook still refuses a joined command.

Codex is not told to approve anything. Its own approval settings decide.

### Start every change in a worktree

Run `pnpm worktree <name> --ready` before the first edit. It fetches and cuts
the branch from `origin`'s main by name, so the work does not start from a
stale local branch. `--ready` installs and runs `pnpm gate:fast` there; hand
a worktree to another agent only when the last line says `READY`. Skip the
worktree for a question that changes no file.

### The changelog

`CHANGELOG.md` has one entry per ISO week. The `Weekly tag` workflow tags
each finished week and opens an issue that asks for its entry. To write one,
follow `.claude/commands/workflow/changelog.md` (`/workflow:changelog` in
Claude Code, the `workflow-changelog` skill in Codex). What the entry says is
your judgement; that it cites every merged pull request is checked by
`pnpm changelog check <week>`. Never create or move a week's tag by hand.

Two more runbooks sit beside it, and each stops at its first step when the
add-on it needs is not in the project:
`.claude/commands/workflow/coverage-backfill.md` (needs `coverage`) and
`.claude/commands/workflow/visual-tolerance-audit.md` (needs `visual`).
