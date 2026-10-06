---
description: Write the week's entry in CHANGELOG.md from the pull requests merged that week, then ship it as a pull request
argument-hint: [ISO week, e.g. 2026-W41. Default: every week not yet in the file]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(node:*), Read, Write, Edit
---

Bring `CHANGELOG.md` up to date. Requested week: `$ARGUMENTS`. If that is
empty, or still reads as a placeholder because this host does not fill it in,
take the week from the request, and with none given write every week step 1
lists.

Run each step yourself, one command per call. This file runs nothing by
itself.

## 1. Find the weeks to write

```bash
pnpm changelog weeks
```

It prints each week with no entry yet, with its first and last day. A week
runs Monday to Sunday, and a pull request belongs to the week of its merge
time in UTC. If the only week listed is the current one and the file already
has its heading, that entry is partial: extend it in place, do not add a
second heading.

Read the top of `CHANGELOG.md` before writing. Its introduction states the
format, and the weeks already there show the tone.

## 2. List what was merged

```bash
pnpm changelog prs 2026-W41
```

Exit 2 means the list could not be fetched (no `gh`, no network). Stop and
say so. Do not write an entry from memory or from `git log`.

A title usually says what changed and why. Where it does not, or where the
pull request records a decision, read its body (`gh pr view <n> --json body`)
before you summarise it.

## 3. Start a worktree

```bash
pnpm worktree changelog-2026-w41 --ready
```

Skip this only when you are already in a worktree made for this entry.

## 4. Write the week

- Heading `## 2026-W41 — 5 Oct – 11 Oct`, newest week first.
- Two to four lines on what the week was about.
- `### Added`, `### Changed`, `### Fixed`: what a user of the app or a
  developer of the project would notice. Put related pull requests in one
  bullet with a bold lead. Do not write one bullet per pull request.
- `### Decisions`: choices worth remembering, each pointing at the document
  that holds the reasoning. A revert, an experiment that was dropped and a
  "we chose not to" all belong here.
- `### Under the hood`: tests, gates, tooling, docs, dependency updates.
  Automated dependency updates go on one line.
- Cite pull requests as `[#123]`. Use plain words a reader six months from now
  can follow.

Leave out a section that would be empty.

## 5. Add the link definitions

Each cited pull request needs a definition at the bottom of the file, in
ascending order. Take the address from `gh repo view --json url --jq .url`:

```
[#123]: https://github.com/<owner>/<name>/pull/123
```

## 6. Prove it is complete

```bash
pnpm changelog check 2026-W41
```

It must end in `PASS` with exit 0. `FAIL` names the pull requests that are
not cited and the citations with no definition: fix the file and run it
again. `SKIP` (exit 2) means nothing was judged; report it as not checked,
never as a pass. Then run `pnpm gate:fast`.

## 7. Ship

Commit, then one outward step per call: push the branch, open one pull
request titled `docs(changelog): 2026-W41`, merge it once its checks pass.

The `Weekly tag` workflow opens an issue titled `Changelog: write 2026-W41`
when it tags a finished week. If one is open
(`gh issue list --search "in:title Changelog: write 2026-W41"`), put
`Closes #<n>` in the pull request's body.

Do not create or move a week's tag. The workflow owns the tags, and it tags
the last commit before Monday 00:00 UTC, which is on purpose earlier than the
pull request that writes the week up.
