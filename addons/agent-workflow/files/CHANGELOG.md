# Changelog

What reached the main branch, week by week, written for a person catching up.
It is not a list of commits. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with two changes:

- **A version is an ISO week** (`2026-W40` is Monday 28 September to Sunday
  4 October). A pull request belongs to the week of its merge time in UTC.
- **A week is grouped by theme, then by kind.** It opens with a short summary,
  then `Added`, `Changed` and `Fixed` for what a user or a developer would
  notice, `Decisions` for the choices worth remembering, and `Under the hood`
  for tests, gates, tooling, docs and dependency updates.

Every merged pull request is cited by its number in square brackets, with a
`#` before the number. Each citation has a link definition at the bottom of
this file, in ascending order.
`pnpm changelog check <week>` proves both. The newest week comes first.

Each finished week is also a git tag of the same name, on the last commit
that reached the main branch before Monday 00:00 UTC. So
`git diff 2026-W39 2026-W40` is exactly the change the W40 section describes.
The `Weekly tag` workflow creates the tag and opens an issue that asks for
the entry.
