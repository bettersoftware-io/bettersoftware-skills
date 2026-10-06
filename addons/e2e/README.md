# Add-on: end-to-end tests

Adds a Playwright tier to a project created from the starter. It builds the
client for production, serves the build, and drives it in a real browser: once
alone, on its in-browser simulator, and once against the real server.

```bash
node scripts/add-to-project.mts <project> e2e
cd <project> && pnpm install && pnpm e2e:install && pnpm e2e
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| Tests package | `packages/e2e` | A workspace package with the role `e2e`: specs, page objects and a fixtures file. The installer declares it in `architecture.config.mts` |
| Specs | `packages/e2e/src/sim`, `src/fullstack` | One folder for each mode. Five tests to start with |
| Page objects | `src/pages/PriceList.page.ts`, `ServerFeed.page.ts` | The price list as a user reads it; and what the page was sent, read off the WebSocket |
| Fixtures | `src/testing/test.ts` | The `test` every spec imports. It hands out the page objects, and fails a test whose page threw |
| Playwright config | `packages/e2e/playwright.config.ts` | One project for each mode that was started. No `webServer`: the runner owns the servers |
| Modes | `tools/e2e.config.mts` | How the client is built and served, and what each mode starts. The project's file |
| `pnpm e2e` | `tools/e2e/run.mts` | For each mode: start its server, build the client, serve the build. Run the specs. Stop everything |
| `pnpm e2e:install` | root script | Downloads the browser, once on a machine |
| CI | `.github/workflows/e2e.yml` | The same run on pull requests and on main, in the Playwright container, with the report uploaded when it fails |

Dev dependencies of `packages/e2e`: `@playwright/test` (exactly `1.63.0`, the
version the `visual` add-on uses), `@types/node`, and the client and the wire
protocol as workspace packages. Nothing is added at the root.

## The layering, and what holds it

A spec says what happens. A page object knows how the screen is driven. The
selectors come from the client's test ids. None of that is a convention: each
line is a check in the kit, so it holds in `gate:fast` and in the editor hook.

| Rule | Held by |
|---|---|
| A spec imports `test` and `expect` from the fixtures file, never the driver | lint `arch/no-browser-driver-in-specs` |
| A spec takes no `page`, `context`, `browser` or `request` | the same rule |
| No `locator`, `getBy…`, `evaluate` or `waitForSelector` in a spec | the same rule |
| No `waitForTimeout` and no timer sleep, in a spec, a page object or the fixtures | lint `arch/no-real-sleeps-in-tests`, on the whole package |
| A test id is the client's constant, never a string | gate `test-ids` |
| The package imports none of the application but the test ids; a type is free | gate `dependencies`, rule `e2e-imports-test-ids-only` |
| Nothing imports the package | gate `dependencies` |
| Every file is a spec, a page object or in `testing/` | gate `structure` |
| No `test` script, so `pnpm test` never starts a browser | gate `package-scripts` |
| One exact Playwright version, in every package and every workflow image | gate `playwright-pin` |
| A server is never started through `pnpm` | the runner refuses the config |
| A spec is in a mode's folder, and every mode has a spec | the runner refuses to start |

The role, the lint rule and the pin gate are in the kit
([`kit/README.md`](../../kit/README.md), "The e2e role"). The add-on names the
gate it needs (`requiresGates`), so a project with an older kit is told to
update the kit first.

## Which gate it joins

The add-on's manifest joins neither gate. The checks above run inside the
gates the project already has: `pnpm gates`, `pnpm lint` and `pnpm typecheck`
read the new package like any other.

The browser run stays out of `gate:full`, for three reasons:

- **It needs a browser that `pnpm install` does not bring.** The full gate
  would fail on a fresh clone and in the starter's `ci.yml`.
- **It needs a port.** A sandbox that does not let a process listen cannot
  run it at all, and the stop hook runs `gate:full` for every agent.
- **A verdict that depends on the machine is not a gate.** The contract keeps
  such checks in a workflow of their own, as it does for the visual goldens.

So an agent is told when to run it (`AGENTS.md`), and the `End-to-end` workflow
runs it on every pull request.

## How a run is put together

`pnpm e2e` is `node tools/e2e/run.mts`. For each mode, in order:

1. **The mode's server is started**, if it has one, and its address is read
   from the line it prints when it is ready. The starter's server is given
   `PORT=0`, so the system picks the port.
2. **The client is built** with the mode's variables. A client reads the
   server's address at build time, which is why the server comes first.
   `sim` is built with `VITE_SERVER_URL` set to nothing, so a variable left in
   the shell cannot turn it into the other mode.
3. **The build is served** by `vite preview`, which takes the next free port
   and prints it.

Then `playwright test` runs in `packages/e2e` with the addresses in
`E2E_MODES`, and the Playwright config makes one project of each mode.

### One server, more than one protocol

A server prints one address. One that answers a second protocol on the same
port (a WebSocket feed and a REST API, as in the demo project) needs two
variables in the client's build, and the page objects need to know whose
frames and whose responses they are looking at. So a mode's server gives its
host and port as well as the address it printed:

| Where | The address as printed | The host and port |
|---|---|---|
| A mode's `env` in `tools/e2e.config.mts` | `SERVER_URL` | `SERVER_HOST` |
| A fixture option in `src/testing/test.ts` | `serverUrl` | `serverHost` |

```ts
env: {
  VITE_SERVER_URL: SERVER_URL,               // ws://localhost:51234/ws, as printed
  VITE_API_URL: `http://${SERVER_HOST}/api`, // written around localhost:51234
},
```

The `ready` pattern's group may capture a whole address or a host and a port
alone; the runner reads the host and port out of either, and stops (exit 2)
on a capture that is neither. The shipped `ServerFeed.page.ts` counts a
socket's frames when the socket was opened to the server's host and port. It
compared whole addresses before, which a second protocol broke: the demo had
to take the address apart by hand and rewrite the page object.

The Playwright config hands every test both values, typed by an interface of
its own. It is the add-on's file, and a project whose fixtures read one of
the two still typechecks. So a project from before this (its fixtures
declare `serverUrl`) needs no change.

- **A production build, not the dev server.** It is what ships, and a page
  loads as a few files. The source project moved its Playwright suites from
  the dev server to a build and measured 310 s against 197 s for 97 tests.
- **No port is written down.** Every address comes from the program that owns
  it. Two runs on one machine cannot collide, and none can adopt a server
  another run left behind.
- **No package manager between the runner and a server.** Since pnpm 12.6 a
  `pnpm exec` wrapper can die on the stop signal while the server lives on.
  The config's commands call `node_modules/.bin/vite` and `node` directly, and
  the runner refuses one that starts with `pnpm`, `npm`, `npx` or `yarn`.
- **Each program leads a process group of its own**, and is stopped by
  signalling the group: SIGTERM, then SIGKILL to what is left after five
  seconds. That holds after a pass, a failure, an error and a signal.
- **A signal is passed on.** Playwright closes its browsers and prints what
  was interrupted; the run then exits 130 (or 143). A second signal stops
  waiting.
- **Nothing to judge is not a pass.** The run exits 2 for a mode with no spec,
  a spec in no mode's folder, a build that fails, a server that never says it
  is ready, and an environment that cannot open a port.

### Specs that wait on state

- `fullyParallel`, no retries. Each test opens a page of its own.
- A page object reads all rows in one step in the page, so the list cannot
  change between two reads.
- Every wait is `expect.poll` or `toPass` on something a page object reports.
- One wait is on chance: the simulator moves one of three symbols at random,
  so "this row's mid changes" succeeds about one tick in three. The spec gives
  it sixty ticks and says why. The usual wait is under two seconds.
- The full-stack spec proves the prices are the server's by comparing the
  screen with the frames Playwright saw on the WebSocket. A client that fell
  back to its simulator opens no socket and matches nothing.

## What was taken from the source project, and what was left

Taken:

- The build as what the specs drive, with the dev server's cost measured.
- The runner that starts its own servers, in process groups, and stops them
  in a `finally` (`tests/scripts/with-server.ts`, `clientServer.ts`), in
  place of Playwright's `webServer`.
- The package's own binary in place of a `pnpm` wrapper, and the gate that
  keeps the wrapper out (grep gate 46).
- The server's real address read from what it prints, not probed for.
- Specs that never hold the driver (grep gates 9 to 11), as an AST rule.
- Test ids from one file (grep gates 1 and 4), through the kit's own gate.
- No fixed sleep: the flake post-mortem found a `waitForTimeout(1500)` racing
  a delay the application drew at random.
- A fixture that fails a test whose page threw.
- The full-stack smoke: the real server behind the real client, as one spec.
- Trace and screenshot kept for a failure only, and no retry.

Left out, on purpose:

- **Gherkin.** The source project ran the same scenarios through Cucumber as
  a second binding, and parked it: native Playwright became the gating suite,
  and the feature files a weekly job. One binding is the pattern to copy. A
  project that needs living documentation adds that layer itself.
- **A scenarios layer** between specs and page objects. It existed so that two
  bindings could share step bodies. With one binding a spec calls the page
  object and asserts on what it returns.
- **Driver-free page-object contracts.** They let a second driver be swapped
  in. Nothing here has a second driver.
- **A dev-server mode** (`RTC_E2E_SERVE=dev`). The build is what is tested.
- **A parallel orchestrator** for seven suites. Two modes run as two projects
  of one Playwright run.
- **Seeded sessions and login.** The starter has no login.
- **Copy-as-selector strings** (grep gate 7). A page object may use a role or
  a text; only test ids are held to the constants.

## How it was tested

In projects created with `create-project.mts --scope
@ci-organisation-with-a-long-name`, on macOS arm64, Node 26.10, pnpm 12.6,
Chromium build 1243 headless (2026-10-06):

| Check | Result |
|---|---|
| `--with e2e`: `pnpm gate:full` | passes |
| `--with e2e`: `pnpm e2e` | 5 of 5 pass |
| All nine add-ons: `pnpm biome:fix`, then `pnpm gate:full` | passes; `biome:fix` changes none of the add-on's files; coverage reports `SKIP packages/e2e` by name; knip reports nothing |
| All nine add-ons: `pnpm e2e`, five times in a row | 5 of 5 pass each time; 3.7 s to 5.3 s for the whole command |
| All nine add-ons: `pnpm lint:workflows` | actionlint and zizmor pass on `e2e.yml` |
| All nine add-ons: `pnpm visual` | 5 of 5 pass; one Playwright version in both packages |
| `visual` alone, `performance` alone: `pnpm gate:full` | pass; `PASS playwright-pin` in each |
| A failing run, left to end | exit 1; none of its 10 processes is left; its three ports are free |
| SIGINT to pnpm's process group, mid-run | exit 130; Playwright reports the interrupted test; nothing left; ports free |
| SIGINT to the pnpm process alone, mid-run | the same |
| `playwright test` run by hand | fails with one test that says to run `pnpm e2e` |
| Fourteen breaks of the rules above, one at a time | each named by its check, with the file and what to do |

**The specs can fail.** Fourteen mutants of the starter's own application,
each run through `pnpm e2e` in a created project with the coverage add-on's
mutation check ([`tests/app-mutants.json`](tests/app-mutants.json)):
14 of 14 killed. Among them: a newer price never replaces the first, the
selection is not cleared, the client silently runs on its simulator in
full-stack mode, the composition root ignores the configured server, the
adapter changes a price on its way in, the server sends nothing.

Run again on 2026-10-06 in a project created under `@zeta`, after the page
object moved to comparing the host and port: 14 of 14 killed.

Two more mutants are left to other tests on purpose
([`tests/app-mutants-left-to-other-tests.json`](tests/app-mutants-left-to-other-tests.json)):
a row that never goes stale, and a movement marked the wrong way. The
end-to-end specs let both through, and the presenter's and the use case's own
tests catch them. That is the table in the add-on's `AGENTS.md` section, shown
with a run.

`pnpm e2e` counts its tests for the mutation check: when
`MUTATION_CHECK_REPORT` is set it writes the numbers from Playwright's
results. Without that the check would refuse the command as one that may have
run nothing.

**The rules and the tools can fail.** The add-on's scripts have 91 tests in
`tests/` (`pnpm vitest run addons/e2e` from this repository's root). The
runner is tested against real processes: fake programs that listen on real
ports and start children of their own. [`tests/mutants.json`](tests/mutants.json)
holds 162 mutants, of the tools, the manifest, the workflow and the shipped
package, and of what the kit, the installer and this repository's lists of
add-ons gained with it: 162 of 162 killed. Two survived a first run and
showed two tests that could not fail; both tests were rewritten. The host
and port (2026-10-06) added 13 mutants and rewrote 5 whose text had moved:
those 18 were run, 18 of 18 killed, and the file now holds 175.

## Limits

- **Not run on GitHub.** The workflow passes actionlint and zizmor, and this
  repository's CI runs the specs in a created project with a browser it
  installs. Neither has run yet. The Playwright container was not run here
  either.
- **Chromium only.** One browser, one viewport.
- **One client package.** `tools/e2e.config.mts` names `packages/client-react`
  and `packages/server`; a project with other names edits it.
- **The runner killed with SIGKILL leaves its servers running.** They lead
  groups of their own, so nothing else stops them. Every other end is covered.
- **pnpm starts the script in a process group of its own.** Ctrl-C reaches
  the runner because pnpm passes the signal on. Measured with pnpm 12.6.
- **A server that dies mid-run is not noticed by the runner.** The specs fail
  on what they wait for.
- **Not on Windows.** A program is stopped through its process group.
- **The lint rule matches names.** A page object with a method called
  `locator`, or a fixture named `page` that is not the driver, is reported.
- **A type import reaches anything.** The dependency rule sees values.
- **Updating the visual add-on in a project that has it needs `--force`
  once.** Its `visual:check` script lost the pin check to the kit, and the
  installer does not replace a script that differs without being told to.

Not built:

- No job summary on the workflow's page: failures are annotations and the
  uploaded report.
- No dev-server mode, no headed-by-default debugging script.
- No second browser, no mobile viewport.
- No authentication fixture.
