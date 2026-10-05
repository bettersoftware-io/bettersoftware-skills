# Add-on: coverage

Adds a coverage gate to a project created from the starter. Every file of every
package must meet the bar, measured with that package's own tests. It also adds
a ranked list of the gaps, a check that proves a test can fail, and a workflow
that publishes the report.

```bash
node scripts/add-to-project.mts <project> coverage
cd <project> && pnpm install && pnpm coverage
```

A project created from the starter passes it as it stands. See
[What the starter measures](#what-the-starter-measures).

## What it adds

| Part | Where | What it does |
|---|---|---|
| `pnpm coverage` | `tools/coverage/run.mts` | The gate. Runs each package's tests under vitest's v8 coverage, judges every file, names the files under the bar, writes the merged report |
| `pnpm coverage:gaps` | `tools/coverage/gaps.mts` | One list across all packages, the file with the most uncovered lines first. Measures afresh every time |
| `pnpm mutation-check <spec.json>` | `tools/coverage/mutation-check.mts` | Applies each `{name, file, find, replace, test}`, runs that test, expects red, restores the file |
| The bar and what is measured | `tools/coverage/lib/config.mts` | Defaults. A project adds exclusions or changes the bar in a file of its own, `tools/coverage.config.mts` |
| Merged report | `coverage/report/` | Each package's HTML report, an index page that states the commit and date, and `summary.json` with the same facts |
| CI | `.github/workflows/coverage.yml` | The gate on pull requests and on main, a job summary, the report as an artifact, and the report on GitHub Pages after a push to main |
| Pages publisher | `tools/coverage/publish-to-pages.mts` | Replaces `/coverage` on the `gh-pages` branch and keeps everything else there |
| `tools/.gitignore` | | Keeps `tools/coverage/` tracked. The starter ignores every folder called `coverage` |

One dev dependency is added to the root: `@vitest/coverage-v8`.

## The gate

The bar is per file: lines, statements and functions at 95%, branches at 85%.
Per file, because an average hides one weak file. In the project these rules
come from, a package read 99.36% while one of its files sat at 56%.

Nothing in a package is edited. The tool runs `vitest run` in the package's
folder with flags (`--coverage.provider=v8`, `--coverage.include`,
`--coverage.thresholds.perFile` and the four thresholds), so the package's own
vitest config is used as it is. vitest holds the bar through its own
thresholds; the tool reads the per-file numbers vitest wrote and judges them
again, so that it can name the files across all packages. If the two disagree
the package is an `ERROR`, not a pass.

`include` is `src/**/*.{ts,tsx,mts}`: a file with no test at all is measured at
0%, not passed over.

| Verdict | Means |
|---|---|
| `PASS` | Every measured file meets the bar |
| `FAIL` | A test failed, a file is under the bar, or a comment leaves code out without a reason |
| `SKIP` | Nothing to measure: no file matches, or the files hold only types and re-exports. Not a pass |
| `ERROR` | vitest wrote no numbers, or failed for a reason the numbers do not show. Not a pass |

Exit `0` is every measured file at the bar, `1` is a failure, `2` is "could not
run, or measured nothing in any package".

### What is left out, and how a project leaves out more

Test code is left out by default: `*.d.ts`, `*.page.ts(x)`, `__contracts__/`,
`__tests__/`, `__testUtils__/`, `testing/`. Each pattern carries its reason,
and the report page lists them.

Code no test can reach is listed in `tools/coverage.config.mts`, with the
reason. The add-on writes that file once, holding the starter's two entry
points, and then leaves it to the project:

```ts
import type { ProjectCoverageConfig } from "./coverage/lib/config.mts";

const config: ProjectCoverageConfig = {
  exclude: {
    "packages/server/src/index.ts": "the server's entry point: it only reads the port and calls startServer(), which is tested",
    "packages/shared/src/generated/**": "written by the schema generator",
  },
};

export default config;
```

A pattern is written from the project root, or starts with `**/` and applies
in every package. The tool refuses a pattern without a reason, a pattern that
is in no package, an unknown key and a bar that is not a percentage. The
project's `pnpm typecheck` covers the file, since it sits under `tools/`.

A single line is left out with `/* v8 ignore next -- <reason> */`. The gate
fails an ignore comment that gives no reason after ` -- `.

## Which gate it joins

`pnpm coverage` joins `gate:full`. It needs nothing beyond `pnpm install` and
takes about four seconds on the starter, which is what the contract asks of a
`full` gate. Left out of `gate:full`, a change could be green on the command a
person runs and red in this add-on's workflow.

The cost is that `gate:full` runs the tests twice: once through `pnpm test`,
once under coverage. CI runs the gate twice as well, in the starter's `ci.yml`
and in `coverage.yml`. The second run is the one that writes the summary and
the report.

## Proving a test can fail

```bash
pnpm mutation-check mutants.json
```

```json
[
  {
    "name": "a price above the previous one moved up, not down",
    "file": "packages/domain/src/useCases/trackMovement.ts",
    "find": "mid > before",
    "replace": "mid < before",
    "test": "pnpm --filter @app/domain exec vitest run trackMovement"
  }
]
```

`find` is literal text and must occur exactly once. Each row is `KILLED` (the
test went red), `SURVIVED` (it stayed green: a finding about the test) or
`ERROR` (the mutant could not be judged). The tool also:

- runs each test once with no mutant first, and refuses a test that is already
  red, since that test would "kill" anything;
- restores the file in a `finally`, and holds a Ctrl-C or a `SIGTERM` until
  the file is back;
- counts a test that outlives `--timeout` (300 seconds) as an error, not as
  red.

A spec is code: its `test` commands run in a shell.

## CI and GitHub Pages

`coverage.yml` has two jobs.

- **`coverage`** (pull requests and pushes to main, `contents: read`): installs,
  runs `pnpm coverage`, and writes a table to the run's summary page. It
  uploads `coverage/report/` as the `coverage-report` artifact on every run,
  and `coverage/test-results/` (vitest's JSON report per package) when the job
  fails.
- **`publish`** (pushes to main only, `contents: write`): downloads that
  artifact and pushes it to `/coverage` on the `gh-pages` branch. It installs
  no dependency and runs no test, so the write token is never in the same job
  as project code. It runs even when the gate failed.

**Repository setting.** For the report to be served, set Settings → Pages →
Source to "Deploy from a branch", branch `gh-pages`, folder `/`. With Pages
off the gate is unaffected: it is a separate job, and the `publish` job only
pushes a branch that nothing serves.

The index page states the commit and the date it was built from. A published
report keeps showing the last commit that built it; this workflow rebuilds it
on every push to main, and the page says which commit that was.

## How it was tested

**The tools.** 148 tests in `tests/`, run with `pnpm vitest run addons/coverage`
from this repository's root. The gate's tests use a stand-in for vitest; the
mutation-check tests change real files and run real commands; the publisher's
tests push to a bare git repository in a temporary folder.

**Every test can fail.** `tests/mutants.json` holds one mutant per test. The
add-on's own tool ran them:

```bash
node addons/coverage/files/tools/coverage/mutation-check.mts addons/coverage/tests/mutants.json
# 148 of 148 killed.
```

The first run had one survivor. The mutant moved the merged report to
`reports/coverage/`, which the starter's `.gitignore` also covers, so the test
was right to pass. The mutant was replaced with one that writes outside any
ignored folder.

**In a project.** Created with `create-project.mts`, `pnpm gate:full` green,
then `add-to-project.mts <project> coverage` and `pnpm install`:

| Command | Result |
|---|---|
| `pnpm coverage`, on the starter as it was then | exit 1: fourteen files named, five packages `FAIL`, `shared` `PASS` |
| `pnpm coverage:gaps`, the same | exit 0: the same fourteen, ranked |
| `pnpm gate:full`, the same | exit 1, at the `pnpm coverage` step. Gates, lint, typecheck, tests and build before it pass |
| `pnpm coverage` and `pnpm gate:full`, once the starter had the missing tests | exit 0: all six packages `PASS`, 55 tests |
| `pnpm mutation-check` with ten mutants of the starter's new tests | 10 of 10 killed |
| A source change that breaks a test | `FAIL`, the test named, "nothing was measured" |
| `/* v8 ignore next 3 */` with no reason | `FAIL`, file and line named; passes once the reason is added |
| `pnpm mutation-check` with three mutants on the starter | one `KILLED`, one `SURVIVED`, one `ERROR` (an ambiguous `find`); files restored |
| `publish-to-pages.mts` to a local bare repository | `gh-pages` holds `.nojekyll` and `coverage/`; a second run makes no commit |

The project's own typecheck covers the tools: a type error put into
`tools/coverage/lib/main.mts` failed `tsc -p tsconfig.tooling.json`.

### What the starter measures

The first run of this gate on the starter, on 2026-10-04, named fourteen files
under the bar. The bar was not lowered. Twelve of them now have tests in the
starter, each proven with a mutant, and the two entry points
(`client-react/src/main.tsx`, `server/src/index.ts`) are left out with their
reasons in `tools/coverage.config.mts`.

What the gate found that was worth finding:

- The WebSocket connection adapter, with its reconnect, had no test at all.
- Nothing tested that one client's protocol error leaves the server running,
  which the server's own comment claimed.
- The composition roots (`buildPorts`, `startApp`) were never run by a test.
- The view model was only tested through another package's UI test. The gate
  judges a file by its own package's tests, so it asked for one beside it.

A fresh project with this add-on: every package `PASS`, 55 tests, `gate:full`
green.

## Limits

- **A file is judged by its own package's tests.** Coverage from another
  package's tests is not merged in.
- **The CI workflow has run on a push to main only**, in
  [bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo)
  on 2026-10-05: the gate, the artifact, the push to `gh-pages` with
  `GITHUB_TOKEN`, and the report served by Pages
  ([the record](../../docs/github-run-2026-10-05.md)). Its pull-request run,
  and a run where the gate fails, have not been seen.
- **GitHub Pages is switched on by hand.** The workflow creates the `gh-pages`
  branch; the repository setting that serves it (Settings, Pages, deploy from
  the `gh-pages` branch) is not something the workflow can set.
- **The publisher's retry is tested against a rejected push**, not against a
  remote that another producer moved in the meantime.
- **`gh-pages` grows.** Every push to main that changes the report adds a
  commit with the HTML in it.
- **The tool runs `vitest run` and nothing else.** A package whose tests need
  other arguments, or another runner, is not measured correctly.
- **The project's file can add exclusions, not remove a default one.**
- **A package's own `coverage` settings are overridden** by the flags.
- **Workspace patterns with `**` are refused.** `packages/*` and literal
  folders work.
- **`kill -9` during `mutation-check` leaves the mutant in the file.** `git diff`
  shows it.
- **Not run on Windows.** The tool starts `pnpm` without a shell.
- **An exclusion that no longer matches a file is not reported.**
- **Updating the add-on** replaces `tools/coverage/` and leaves
  `tools/coverage.config.mts` alone, which is why the project's settings live
  in that separate file.
