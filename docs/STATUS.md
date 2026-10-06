# Status: pending work

What is not done yet. Finished work is removed from this page, not archived;
the test records in this folder and the git log say what was done.

**Last updated: 2026-10-06**

## Waiting on something outside this repository

- **The starter's server uses `rx-ws-effects`.** It is a plain imperative
  handler today. The package
  ([bettersoftware-io/rx-ws-effects](https://github.com/bettersoftware-io/rx-ws-effects))
  is not on npm yet, and pnpm refuses a version younger than 24 hours, so this
  starts a day after it is published.

## Seen on GitHub only in part

The add-ons' workflows ran in
[bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo)
on 2026-10-05, on pushes to main and on a pull request
([the record](github-run-2026-10-05.md),
[the feature run](demo-feature-2026-10-05.md)). What that did not cover:

- **`ci-security` has run on GitHub with everything passing only.** In
  skills-demo on 2026-10-06: workflow lint and `pnpm audit` on a pull request
  and on main, Dependency Review on a pull request, Scorecard on main, and
  Dependabot's update runs (four, all green, no pull request opened yet). Not
  seen: a Dependabot pull request, Dependency Review refusing a pull request
  for an advisory or a licence, and what Scorecard's findings look like in the
  repository's code-scanning page.
- **Dependency Review fails until the repository's dependency graph is on.**
  Seen: "Dependency review is not supported on this repository". The add-on's
  README lists the setting; `gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts`
  switches it on.
- **skills-demo is behind this repository.** It has no `strict-lint`, no
  `agent-workflow`, none of the gates and lint rules added since 2026-10-05,
  Node 24 in its workflows and `engines.node` in its package.json.
- **Not run on GitHub yet:** Node 26 through `setup-node`, the pinned Corepack
  script (inside the Playwright container jobs too), the pnpm store cache, and
  the weekly tag workflow of `agent-workflow`.
- **No job creates a project with several add-ons at once.** CI adds each one
  alone. All eight together pass `gate:full` locally.
- **No run where the coverage gate fails has been seen.** The report is meant
  to publish then too.
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

- **Nothing says when a new pattern earns a row in the `AGENTS.md` table.** The
  `agent-docs` gate fails on a row that points at a file that is gone; it
  cannot know that a row is missing. In the REST run the agent built a new
  kind of port with no row to copy and nothing went wrong, so no rule is
  written yet.
- **Coverage is measured per package, by that package's own tests.** A file
  only exercised from another package's test reads 0%, and the tests in an
  integration package credit nothing (it reads `SKIP`: no file to measure).
  Merging across packages would credit them, and is not built.
- **Nothing checks that the core reaches the clock through a port.** In the
  Codex run a presenter read `new Date()` directly. A check for `Date` in the
  domain and the core is decidable from source, and does not exist.

## Not tried

- **A feature that touches more of the app:** sign-in, routing. The hardest
  test so far (users and categories with create, edit and delete, over REST)
  added a second transport and forms, but no navigation and no session.
- **`extending-a-project` in a Codex session.** The other two are checked
  there ([the record](codex-test-2026-10-04.md)).
- **A model between the smallest and the frontier.** Claude Haiku 4.5 has been
  tried ([the record](small-model-2026-10-05.md)); Claude Sonnet has not.
- **The kit in a real existing project.** The script sets up the files and says
  what is left. Declaring each package's role, and deciding what to do with the
  findings on code that was never held to these rules, is judgement nobody has
  watched an agent do.

## Known limits

- **The `agent-workflow` hook has not run in a live session of either host.**
  Its pre-approval of a push, a pull request and a merge ships off. What it
  relies on is taken from the documentation: that Claude Code's `ask` and
  `deny` rules win over a hook's approval, the `Edit(/path)` rule form, the
  permission modes, and that the working directory it is sent follows a `cd`.
  The merge check has not been run against GitHub. Two security reviews found
  real escapes in earlier forms (a heredoc body run by bash 3.2; a push sent
  to `main` by git's own configuration); the add-on's README has the account
  and the limits that remain.
- **The stop hook judges the checkout the session stops in.** A session that
  changed two checkouts is held to one. That `cwd` in the payload follows the
  agent into a worktree is from the documentation.
- **The stop hook's nine-minute limit is tested with short limits only**, on
  the same code path.
- **The quiet gate copies the environment pnpm 12.6 gives a script.** A later
  pnpm may set more; the test that compares the two runs would show it.
- **A kit update tells a project about a changed template once**, and only
  from the first update after the one that brought the template copies. A
  project older than that is not told what changed before.
- **Without `format-lint`, nothing bans an import that climbs two folders.**
  The ban is Biome's; ESLint has no twin of it.
- **`allowBuilds` names esbuild, which nothing in the starter installs** (Vite
  8 builds with rolldown). It is there for the first dependency that brings it.

- **A new project's formatting depends on its scope's length.** The starter is
  written with `@app`; a longer scope pushes some import lines past the
  formatter's width. So `format-lint` asks for its fixer to be run once after
  installing (`firstRun`), and the scripts print it under "Next". Until it is
  run, `biome:check` fails on a project with a long scope.
- **`strict-lint`'s knip settings are held by local runs, not by CI, for
  combinations of add-ons.** One finding appeared only with `visual` and
  without `performance`. CI adds each add-on alone.
- **A file with no export inside a library package is never reported as
  unused** by `strict-lint`: the package's exports map makes every source file
  an entry.

- **Where a port cannot be opened, the tests that need one are skipped, not
  run.** The gate is green there with a `SKIP` line, and the coverage of those
  packages is not judged. The stop hook and CI do run them. A test that opens a
  port and is not named `*.port.test.ts` still fails in such a sandbox, and no
  gate can tell that it should have been named so.

- **In Codex's default sandbox a project is created and not proven.** No
  network, and `.git` and `.codex` are read-only there, so `git init`,
  `pnpm install`, `gate:full` and the Codex hook file are left to the person.
  The script and the skill say so; the README gives the commands.

- **The stop hook does not run the visual tests.** `pnpm visual` is outside
  `gate:full` on purpose, so an agent can still finish with stale goldens. CI's
  `Visual goldens` job is what catches that.
- **The stop hook's memory of a green tree is a file an agent could write,**
  and its hash leaves out what is not a file in the project (an environment
  variable, a tool installed elsewhere). It guards against stopping early; it
  is not a lock. CI is the check that cannot be talked round. A security
  review of the first version found both points; the hash now also covers
  ignored `.env` files and the Node version, and a tree with a nested
  repository is never remembered.
- **The stop hook reads every file git does not ignore, on every stop,** to
  know whether the tree changed. Not measured on a large repository.
- **A stop-hook gate that is cut off at nine minutes may leave its child
  processes running.** The hook stops the command it started, not what that
  command started.
- **"The contract calls the method" is not "the contract tests it".** The gate
  finds a method the contract never calls. A call with no assertion passes.
  A port member typed with a name (`latest: Fetcher`) is not read as a method.
- **The `task-cache` gate reads `turbo.json`; it does not ask turbo.**
  `scripts/check-task-cache.mts`, which does ask, runs only in this
  repository's CI, as the proof that the rule the gate applies is the right
  one.

- **In the starter, the integration example catches nothing its neighbours
  miss.** Eight mutants in the server and the client adapter were each caught
  both by the integration tests and by that side's own tests. It is there as
  the pattern to copy; the case it exists for is a client adapter and server
  routes that are each tested against a fake of the other.
- **The integration example opens a real port**, so an agent cannot run it
  inside Codex's sandbox, like the server's own tests. The stop hook's run of
  them does pass in Codex ([the record](codex-test-2026-10-04.md)).

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
