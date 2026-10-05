# Add-on: ci-security

Adds supply-chain and workflow checks to a project created from the starter
and hosted on GitHub: a lint of the workflows themselves, a review of every
dependency change, an audit of the production dependencies, a Dependabot
config and an OpenSSF Scorecard.

```bash
node scripts/add-to-project.mts <project> ci-security
cd <project> && pnpm install && pnpm lint:workflows
```

Every check here needs the network, so none joins `gate:fast` or `gate:full`.
A gate needs nothing beyond `pnpm install`, and an agent runs the gates in a
sandbox that may have no network. The checks run in workflows of their own,
and the workflow lint also runs by hand before a push.

## What it adds

| Part | Where | What it does |
|---|---|---|
| `pnpm lint:workflows [actionlint\|zizmor]` | `tools/ci-security/lint-workflows.mts` | Downloads each linter as a pinned release, checks its sha256, runs it on `.github/`. `PASS`, `FAIL` or `SKIP` per linter |
| The pins | `tools/ci-security/lib/pins.mts` | Version, URL and sha256 of each linter for macOS and Linux, x64 and arm64 |
| Workflow lint and audit | `.github/workflows/ci-security.yml` | On pull requests, on main and weekly: actionlint, zizmor, `pnpm audit --prod` |
| Dependency Review | `.github/workflows/dependency-review.yml` | On pull requests: fails one that brings in a known advisory or a strong-copyleft licence |
| Scorecard | `.github/workflows/scorecard.yml` | Weekly and when `.github/` or branch protection changes: findings to code scanning. Gates nothing |
| Dependabot | `.github/dependabot.yml` | Weekly version updates for npm and for actions, never a release younger than seven days. Written once, then the project's own |

One script is added to the root `package.json`. No package is installed.

## Why each tool

Each one watches something the others do not. The reasoning is from the
decision record of the project these checks come from.

| Tool | The gap it closes |
|---|---|
| **actionlint** | Is each workflow valid: syntax, expressions, runner labels, the inputs of a `run:` step |
| **zizmor** | Is each workflow safe: injection through `${{ }}`, a token left in the git config, permissions wider than needed, an action not pinned by commit. actionlint has no opinion on these |
| **Dependency Review** | What a pull request changes in the dependencies, development ones included, before it merges. Also the only check that reads licences |
| **`pnpm audit --prod`** | The whole production tree against known advisories, including the day an advisory is published and nothing was pushed (the weekly run) |
| **Dependabot** | Keeps versions and action commits moving, a week behind their release. A malicious release is usually removed within days |
| **Scorecard** | The repository's settings, which no file shows: branch protection, token defaults, and the day one of them is loosened |

**Renovate is the alternative to Dependabot's version updates.** It needs the
Mend Renovate app installed on the repository; Dependabot needs nothing, which
is why it is the one shipped. Do not run both for version updates: they open
the same pull requests twice. If you move to Renovate, set
`open-pull-requests-limit: 0` in `dependabot.yml` (security updates still
flow), give Renovate `minimumReleaseAge` and `helpers:pinGitHubActionDigests`,
and turn off its `vulnerabilityAlerts`.

Not included, and why: **CodeQL** is a repository setting (default setup), not
a file, so it is in the list below. **Snyk, SonarCloud** and other vendor
scanners need an account and a token, and repeat what these layers do.

## Settings a person must switch on

The add-on writes files. These are repository settings, and it cannot set
them. All are under Settings.

| Setting | Where | Without it |
|---|---|---|
| Dependency graph | Advanced Security | Dependency Review fails every pull request, saying the graph is off. On by default for a public repository |
| Dependabot alerts and Dependabot security updates | Advanced Security | No pull request is opened when an advisory hits a version already on main |
| Dependabot version updates | Advanced Security | Usually on once `dependabot.yml` exists; check it |
| CodeQL default setup, with the `actions` language | Advanced Security → Code scanning | No static analysis of the project's own code. It is also where Scorecard's findings are shown |
| Private vulnerability reporting | Advanced Security | Nobody can report a flaw in private. Add a `SECURITY.md` too: Scorecard looks for it |
| A ruleset on `main` that requires a pull request and these status checks: `workflow lint (actionlint · zizmor)`, `pnpm audit (production dependencies)`, `dependency review (advisories · licences)`, and the starter's `gates · lint · typecheck · test · build` | Rules → Rulesets | The checks run and anyone can merge past a red one |
| Workflow permissions: read repository contents | Actions → General | A workflow with no `permissions:` block gets a write token |

Do not make `scorecard analysis` a required check: it does not run on pull
requests.

In a private repository, Dependency Review and code scanning need GitHub
Advanced Security. Without it, delete `dependency-review.yml` and
`scorecard.yml`; the rest works.

## The local lint

```
PASS actionlint 1.7.12: every workflow is valid
PASS zizmor 1.30.1: no security finding (not checked here: what must be asked of GitHub, such as an action with a known advisory, because GH_TOKEN is not set; CI checks it)
```

| Exit | Means |
|---|---|
| `0` | Every linter ran and found nothing |
| `1` | A linter found a problem. Its own output, above the `FAIL` line, names the file and line |
| `2` | A linter could not run, or there was no workflow to lint. A `SKIP` line gives the reason. Not a pass |

The download is never trusted:

- Each build is one release asset, named by its exact URL and sha256. Nothing
  is taken from a "latest" link.
- The sha256 is checked before the bytes are written to disk. A wrong one is
  thrown away, nothing is run, and the result is `SKIP` with both checksums.
- The archive is kept in `node_modules/.cache/ci-security/`, which the
  starter's `.gitignore` covers, so later runs need no network. It is checked
  again on every run, and the binary is taken out of it afresh every time: a
  binary left by an earlier run is deleted first and never run.
- A platform with no pinned build (Windows) is a `SKIP` that names the
  platforms that have one.

A `PASS` line says what was not checked on this machine. Without `shellcheck`
installed, actionlint does not read the shell inside `run:` steps. Without a
GitHub token in `GH_TOKEN`, zizmor skips the checks that ask GitHub about an
action. CI has both, so CI is the complete run.

`pnpm audit --prod` has no local script: it is one command, and you can type
it. With no network it fails with a connection error; it does not pass.

## The workflows

- **Every action is pinned by its full commit hash**, with the version in a
  comment. Dependabot's `github-actions` entry moves both together.
- **`permissions: contents: read`** on every workflow. The one write is
  `security-events: write` on the Scorecard job, to upload its findings.
- **`persist-credentials: false`** on every checkout. No job pushes.
- **No job installs a dependency.** The lint tool is plain Node with no
  package; `pnpm audit` reads the lockfile; Dependency Review has no checkout.
  So no package's code runs in these workflows, and the token is never in a
  job with project code. The token is given to one step, the zizmor run.
- **No `pull_request_target`, no secret, no expression in a `run:` line.**
- A newer run cancels the one in flight.

## How it was tested

**The tools.** 98 tests in `tests/`, run with
`pnpm vitest run addons/ci-security` from this repository's root. No test
touches the network: a download is a function that returns bytes, the archive
extraction and the linter run are stand-ins. `system.test.mts` runs the real
`tar` on an archive it makes, and the real tool in a folder with no workflow
(it stops before any download).

**Every test can fail.** One mutant per test, run with the coverage add-on's
tool: 96 of 96 killed. The two remaining tests list files, which a
find-and-replace cannot break, so each was made red by hand: a `.js` file put
in `files/`, and a fourth workflow.

The first run had twelve survivors, all in `pins.test.mts`, and they were a
fault in the spec: the `-t` filter matched no test, vitest ran nothing and
exited 0, so every mutant "survived". The filters were fixed, and each of the
96 was then checked to select exactly one test. One real gap was found while
writing the mutants: a single test covered two deletions of a stale binary, so
neither could be seen alone. It is now two tests.

**In a project**, on macOS arm64, 2026-10-05. Created with
`create-project.mts`, then `add-to-project.mts <project> ci-security`,
`git init`, `pnpm install`:

| Command | Result |
|---|---|
| `pnpm lint:workflows` | exit 0. Both linters downloaded, verified, `PASS` on the starter's `ci.yml` and this add-on's three workflows and `dependabot.yml` |
| `pnpm gate:full` | exit 0, all seven architecture gates `PASS` |
| The same lint with `GH_TOKEN` set | exit 0, zizmor's online checks included |
| `zizmor --persona=auditor` on the add-on's workflows | no finding. The one it reports is in the starter's `ci.yml` (no `concurrency`) |
| A workflow with a misspelt key (`shel:`) | exit 1. actionlint `FAIL`, names file, line and key. zizmor `PASS`: it does not judge syntax |
| A workflow with `actions/checkout@v7` | exit 1. zizmor `FAIL`, `unpinned-uses`, names file and line. actionlint `PASS`: it does not judge safety |
| A workflow with `pull_request_target`, a checkout of the pull request's head and its title in a `run:` line | exit 1. zizmor names `dangerous-triggers`, `template-injection`, `unpinned-uses`, `excessive-permissions`; actionlint also fails the title in `run:` |
| The lint with the network denied (`sandbox-exec`, `deny network*`) and no kept archive | exit 2, two `SKIP` lines with `ENOTFOUND github.com`. Nothing written |
| The same with the archives kept from an earlier run | exit 0 |
| One sha256 in the project's `pins.mts` changed to zeros | exit 2, `SKIP`, both checksums printed, nothing written, nothing run |
| `pnpm audit --prod`, before `pnpm install` | exit 0, "No known vulnerabilities found" |
| `pnpm audit --prod` against a registry that refuses the connection | exit 1 with the connection error |
| `add-to-project.mts <project> ci-security` a second time | "0 file(s) written, 8 already up to date"; a hash of every file in the project is the same before and after |

## Limits

- **None of the four workflows has run on GitHub.** GitHub Actions was down on
  the day this was written. actionlint and zizmor pass on the files, which
  checks their form, not their behaviour. Not seen: Dependency Review reading
  a real pull request, the Scorecard upload being accepted, the audit job
  running `pnpm` through Corepack, the linux-x64 linter builds running (their
  checksums are the release's own, but only the darwin-arm64 builds were
  downloaded and run).
- **Scorecard is included on the strength of its documentation**: with
  `publish_results: false` it needs no secret in a public repository. Its
  `Branch-Protection` check may read less than a person can see, because the
  default token cannot read every setting. If it does not work in your
  repository, delete `scorecard.yml`; nothing else depends on it.
- **The first run of the local lint needs the network.** In a sandbox without
  it the answer is `SKIP`, exit 2. That is correct and it is not a pass.
- **No Windows build is pinned.** Run the lint under WSL, or leave it to CI.
- **Dependabot does not manage the two linter pins.** A person changes the
  version, four URLs and four checksums together. `pins.mts` belongs to the
  add-on, so a project that edits it must pass `--force` on the next update
  of the add-on.
- **zizmor runs with its default persona.** Its `pedantic` and `auditor`
  findings (a missing `concurrency`, a permission without a comment) are not
  shown. The add-on's own workflows have none.
- **The licence list refuses; it does not allow.** A licence the action cannot
  read only warns.
- **`pnpm audit` and Dependency Review overlap on production dependencies.**
  That is meant: one reads the whole tree every week, the other reads the
  change before it merges.
- **The weekly runs stop** when a repository has had no activity for 60 days;
  GitHub disables scheduled workflows then.
- **`dependabot.yml` is not updated** when the add-on is. It is the project's
  file from the first install.
- **The lint tool's cache is under `node_modules/`**, so removing
  `node_modules` means one more download.
