# Status: pending work

What is not done yet. Finished work is removed from this page, not archived;
the test records in this folder and the git log say what was done.

**Last updated: 2026-10-05**

## Waiting on something outside this repository

- **The starter's server uses `rx-ws-effects`.** It is a plain imperative
  handler today. The package
  ([bettersoftware-io/rx-ws-effects](https://github.com/bettersoftware-io/rx-ws-effects))
  is not on npm yet, and pnpm refuses a version younger than 24 hours, so this
  starts a day after it is published.

## Seen on GitHub only in part

The add-ons' workflows ran in
[bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo)
on 2026-10-05 ([the record](github-run-2026-10-05.md)). What that did not
cover:

- **Every run was a push to main.** No pull-request run, and no run where the
  coverage gate fails, has been seen.
- **The motion audit had nothing to judge.** The starter has no animation, so
  the audit skipped, on GitHub as locally. Whether Chromium in the CI image
  gives the same compositing verdicts as on macOS is still unknown.

## Dated

- **From 19 October 2026 `ubuntu-latest` means Ubuntu 26.** GitHub's notice:
  [actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748).
  Every workflow here uses that label: this repository's `ci.yml`, the
  starter's `ci.yml`, and the add-ons' `coverage.yml`, `visual.yml`,
  `update-visual-goldens.yml` and `perf.yml`. Decide whether to pin a version
  (`ubuntu-24.04`) or to move with the label. Either way, re-run this
  repository's CI once the change lands. The visual tests are the least
  exposed, since they run inside a pinned Playwright container.

## Open decisions

- **Coverage is measured per package, by that package's own tests.** A file
  only exercised from another package's test reads 0%. Merging across packages
  would credit it, and is not built.
- **Nothing checks that the core reaches the clock through a port.** In the
  Codex run a presenter read `new Date()` directly. A check for `Date` in the
  domain and the core is decidable from source, and does not exist.

## Not tried

- **A feature that touches more of the app:** sign-in, routing. The harder test
  so far (a persistent watchlist) needed one new kind of adapter.
- **The plugin's skills in a Codex session.** Installing is checked, and the
  project's `AGENTS.md` and hooks are checked in Codex. A session that loads a
  skill from the plugin is not.
- **A smaller model.** Every run used a frontier model.
- **The kit in a real existing project.** The script sets up the files and says
  what is left. Declaring each package's role, and deciding what to do with the
  findings on code that was never held to these rules, is judgement nobody has
  watched an agent do.

## Known limits

- **The `typescript-only` gate does not look inside `tools/coverage/`.** The
  kit's file walker skips every folder called `coverage`, since that is where
  reports go. The project's typecheck does cover the folder.
- **`ui-never-imports-adapters` sees a direct import only**, not an adapter
  re-exported through a package index. Closing it by reachability would forbid
  the UI every value import from an index that re-exports an adapter, which is
  a layout the source project relies on.
- **Two links in `tools/arch/README.md` are dead inside a project**: they point
  at files that are not copied.
- **The visual add-on has no theme matrix, no "which UI does no scenario
  render" measure, and no published diff site.** The Playwright report, as an
  artifact, is what shows a failure.
- **No skill exists for placing logic, adding a port, streaming state or
  testing.** On purpose: one is written when a task fails in a way the gates do
  not catch, and across four feature runs none has.
