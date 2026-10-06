---
description: Rank the files with the most untested code from a fresh run, propose a shortlist, then write the tests you approve
argument-hint: [package folders, e.g. packages/domain]
allowed-tools: Bash(pnpm:*), Bash(node:*), Bash(git:*), Bash(gh:*), Read, Write, Edit
---

Find and close per-file gaps in test coverage. Packages asked for:
`$ARGUMENTS`. If that is empty, or still reads as a placeholder because this
host does not fill it in, take them from the request, and with none given
measure every package.

Run each step yourself. This file runs nothing by itself.

## 0. This needs the coverage add-on

```bash
node tools/agent-workflow/requires.mts coverage
```

If it does not exit 0, report the line it printed and stop. Do not measure
coverage some other way.

## 1. See whether someone is already doing this

```bash
git worktree list
```

Two sessions that work from the same ranking pick the same file. If another
worktree is plainly closing coverage gaps, say so and ask before you go on.

## 2. Rank the gaps

```bash
pnpm coverage:gaps --limit 30
```

It measures afresh, so the list is never an old one. Exit 2 means a package
could not be measured and the list is incomplete: say which, and do not treat
the rest as the whole picture. Do not use a published coverage report in its
place. A report shows the commit that built it, not this one.

## 3. Propose, then stop

Show the shortlist you mean to work on and wait for approval. For each file
say what is not covered: a branch, an error path, a whole module. A file at
92% because one `catch` cannot be reached in a test is a different
proposition from one at 92% because a feature has no test.

Put first the code whose failure nobody would notice: the choice of adapter
in a composition root, a guard that is only wrong in production.

## 4. Write the tests

Start a worktree (`pnpm worktree coverage-<topic> --ready`). Then follow
"Closing a gap" in the Coverage section of `AGENTS.md`: write each test
through the public interface, prove it can fail with `pnpm mutation-check`,
and run `pnpm coverage` again to see the number move. Finish with
`pnpm gate:full`, then one pull request, each outward step in a call of its
own.

## Reading coverage honestly

- **The gate passing does not mean there are no gaps.** The ranking exists
  because a file just above the bar still has lines nothing runs.
- **A file with nothing to run is not a gap.** Types and re-exports are left
  out already.
- **Test scaffolding** is often better left out of the measurement than
  tested. If a "gap" is a harness, say so; do not write a test for it.
- **Coverage is a floor, not a goal.** Do not write an assertion whose only
  purpose is to run a line. If a gap is not behaviour worth pinning, propose
  an exclusion with its reason, and move on.
