# Add-on: visual goldens

Adds a screenshot tier to a project created from the starter. Each scenario
renders the real UI in a fixed state, takes a picture, and compares it with a
committed image (a golden). A difference fails.

```bash
node scripts/add-to-project.mts <project> visual
cd <project> && pnpm install && pnpm visual
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| Scenario list | `packages/client-react/tests/visual/scenarios.ts` | A name and the seeded state, as typed data. Four to start: `empty`, `rows-up-and-down`, `row-selected`, `row-stale` |
| Seeding | `tests/visual/seeding.ts` | How a scenario's data becomes app state: `seedScenario(scenario, clock)` builds the app harness and returns the application and the deliveries. The project's file, like the scenario list |
| Visual host | `tests/visual/host/` | A second Vite root. It renders `App` from `src/ui` on the application the seeding returns, with the app's own `index.css`. It imports both through the client's `#/` alias, so the client's `package.json` must declare `"imports": { "#/*": "./src/*" }`, as the starter's does. It knows no field of a scenario; time is a clock the page owns |
| Spec | `tests/visual/visual.pw.ts` | One Playwright test per scenario, plus one that fails on a golden no scenario owns |
| Goldens | `tests/visual/goldens/<platform>/` | One PNG per scenario, per system (`darwin-arm64`, `linux-x64`) |
| Tolerance | `tests/visual/tolerance.ts` | Both knobs, in one place, with what was measured |
| `pnpm visual` | root script | Compare. Never writes a golden |
| `pnpm visual:update` | root script | Redraw this system's goldens |
| `pnpm visual:jitter` | `tools/visual/jitter.mts` | Capture the same commit N times and report the largest difference: the noise floor |
| `pnpm visual:check` | typecheck of `tests/visual/` | Joins `gate:fast` |
| `pnpm visual:check:server` | `tools/visual/check-server.mts` | Fails a Playwright config that starts its server through pnpm. Joins `gate:fast` |
| CI | `.github/workflows/visual.yml`, `update-visual-goldens.yml` | Compare on pull requests and on main; redraw the Linux set by hand |
| Job summary | `tools/visual/summary.mts` | Names the scenarios that failed and what to do |

Dev dependencies added to `packages/client-react`: `@playwright/test` (exactly
`1.63.0`), `@sinonjs/fake-timers` (the host's clock) and `@types/node`.

## Which gate it joins

The comparison joins neither gate. It needs a browser and goldens drawn on the
system that runs it, and the contract keeps such checks out of `gate:fast` and
`gate:full`. It runs as `pnpm visual` and in its own workflow.

`pnpm visual:check` joins `gate:fast`. It takes about a second and needs only
`pnpm install`. It typechecks `tests/visual/`: the package's own
`tsconfig.json` covers `src` only, and an add-on may not edit it.

The Playwright version is held by the kit's `playwright-pin` gate, which runs
with the other gates in `gate:fast`. It fails when the `@playwright/test`
version is a range, when two packages name two versions, and when a workflow's
image tag is another version: CI would draw with another browser build. The
check was this add-on's own (`tools/visual/check-pin.mts`) until the `e2e`
add-on needed the same one; a project that has both has one check. The add-on
is refused by a project whose kit does not have the gate yet.

`pnpm visual:check:server` joins `gate:fast` too. It reads every
`playwright*.config.ts` in the project and fails one whose
`webServer.command` starts with pnpm (`pnpm exec vite …`, `pnpm run dev`,
`pnpm --filter …`, also behind `corepack`, a path, `NAME=value` or `&&`).

Playwright stops the process it started. Through pnpm that process is the
wrapper, and since pnpm 12.6 the server it started lives on with no parent:
every test passes, and the run never ends. Measured here on 2026-10-06, pnpm
12.6.0, in a project with every add-on: with `pnpm exec vite` as the command
the five tests passed in three seconds and the run was still there 45
seconds later, with vite's parent process 1; it finished the moment that
vite was stopped by hand. In CI such a run holds the job until its time
limit. The config this add-on ships already starts
`node_modules/.bin/vite` from the package's folder, and the check keeps it
that way: the two root scripts `visual` and `visual:update` still go through
`pnpm exec playwright`, which is not a server and ends by itself.

It is a script of its own, and not part of `visual:check`, because an add-on
may not change a script a project already has. It says `SKIP` when no config
starts a server, and exits 2 when a command is not a string it can read.

## Who owns what

A feature adds scenarios, and a scenario may need state the starter's four do
not have. Until 2026-10-06 that meant editing `host/main.tsx`, which is the
add-on's file: the demo project added sixty lines there, and every update of
the add-on after that refused, needed `--force`, and the lines were put back
by hand.

| File | Whose | Holds |
|---|---|---|
| `scenarios.ts` | the project's | `Scenario` and the list |
| `seeding.ts` | the project's | `seedScenario(scenario, clock)`: the harness, the application as it starts, and what is delivered once the UI is on screen |
| `host/` | the add-on's | The clock, the render, when `deliver` is called, the ready signal |

The host calls `seedScenario` once, after its clock is installed, renders the
UI on `app`, and calls `deliver` from the frame's effect, when the UI below
has subscribed. So how state is delivered and when the picture is taken stay
in the add-on, and what the state is stays in the project.

**A project that edited the host** is told where the lines go. A plain update
refuses, as for any edited file, and says under the file's name that its
edits now go in `seeding.ts` and what `--force` will do. With `--force` the
host is replaced, the project's version is kept as
`tools/templates/visual.replaced.packages__client-react__tests__visual__host__main.tsx.txt`,
and `seeding.ts` is written as shipped. The person moves their lines from the
copy into `seeding.ts`, deletes the copy, and runs `pnpm visual`. While the
copy is there, every update says so. The manifest field is `movedToProject`
([the contract](../README.md)).

Tried on a copy of the demo (2026-10-06): the three wrappers it had added to
the host moved to `seeding.ts` unchanged, `pnpm visual` passed 8 of 8 against
its committed `darwin-arm64` goldens with both knobs at 0, and a second update
wrote nothing.

## How the frame is pinned

- **State comes from the harness.** The seeding delivers prices through
  `createAppHarness().deliverPrice`, and seeds a selection through the
  selection machine's own intent. Nothing is clicked.
- **Time does not run.** The host replaces `setTimeout`, `setInterval` and
  `Date` with a clock it owns. The stale row is made by moving that clock past
  `STALE_AFTER_MS` between deliveries. No timer fires by itself, so a slow
  machine takes the same picture.
- **One ready signal.** The frame sets `data-visual-ready="true"` after the
  seed and after the fonts have loaded. The spec waits for that and nothing
  else.
- **Animations are off** (`animations: "disabled"`, reduced motion), and the
  colour scheme, locale, time zone and scale are fixed in the config.
- **No network.** The spec fails if the page asks for anything outside the
  host's own server, or throws.
- **No reused server.** `reuseExistingServer` is `false`, so a stale server on
  the port is an error, not a silent source of old pixels. Hot reload is off.

## The tolerance

Set in `tolerance.ts`: `maxDiffPixelRatio: 0`, `threshold: 0`.

Measured twice, the same way: one commit captured 5 times, all pairs compared,
4 scenarios.

| Where | Result |
|---|---|
| darwin-arm64, one Mac, Chromium build 1243 headless (2026-10-04) | every image byte-identical |
| linux-x64, five runs of the update workflow on GitHub's runners, in the pinned container (2026-10-05) | every image byte-identical |

The noise floor is 0 for both knobs in both places, so both knobs are 0.

The per-pixel `threshold` is the knob that is easy to miss. Playwright's
default is 0.2. With the default, changing the starter's "up" colour from green
`#1a8f4c` to blue `#1a4c8f` counts 0 different pixels, and the tier would pass
with a zero pixel budget. At 0 it counts 83, and a move of 1 of 255 on each
channel counts 82.

`pnpm visual:jitter` reports a floor for each knob, using the comparison
Playwright uses (pixelmatch: colour distance against the threshold, with
anti-aliased pixels left out). It is written with Node built-ins only, PNG
reading included, so it needs nothing installed. Its count was checked against
Playwright's own on a real failure: both said 83.

## The update workflow: an artifact, not a commit

RTC's workflow commits the new goldens to the branch it was run on, with the
workflow's token. This add-on uploads them as an artifact instead, and the job
summary gives the two commands that bring them into the branch.

- The job stays `contents: read`. A job that can push runs `pnpm install` and a
  dev server with that token within reach.
- A push made with the workflow's token starts no workflow. The branch would
  end on a commit that neither CI nor the visual job has checked.
- A person sees the images before they become the reference.

The cost is one `gh run download`. An auto-commit can be added later as a
second job that only downloads the artifact and pushes.

## How it was tested

In a project created with `create-project.mts --scope @demo`, on macOS arm64,
with the add-on installed by `add-to-project.mts`:

| Check | Result |
|---|---|
| `pnpm gate:full` before the add-on | passes |
| `pnpm visual` with the shipped `darwin-arm64` goldens | 5 of 5 pass (4 scenarios, 1 orphan check) |
| `pnpm gate:full` with the add-on in | passes; the gates report `PASS playwright-pin` |
| One colour changed clearly (`#1a8f4c` to `#1a4c8f`) | fails: 3 scenarios, 83 pixels each |
| Low contrast, +1 on each channel (`#1b904d`) | fails: 82 pixels |
| One golden deleted | fails with the how-to message; no file is written |
| A golden with no scenario | fails, names the file |
| The port already taken | Playwright refuses to start |
| The host throws | fails, with the error |
| The host asks for another address | fails, names the address |
| `pnpm visual:jitter --runs 5` | 0 differing pixels, exit 0 |
| Scope rewrite | the installer rewrites `@app/` in the add-on's files; they ran as `@demo/` |
| `webServer.command` changed to `pnpm exec vite …` (2026-10-06, pnpm 12.6.0) | the five tests pass, then the run does not end: still there after 45 s, vite's parent is process 1. `pnpm visual:check:server` exits 1 and names the file and line |
| The shipped command (2026-10-06) | `pnpm visual` ends by itself: 5 passed. `PASS web-server` |

On GitHub, in [bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo)
(2026-10-05, [the record](../../docs/github-run-2026-10-05.md)):

| Check | Result |
|---|---|
| `Visual goldens` with no Linux set committed | fails, with the missing-golden message |
| `Update visual goldens`, five runs on one commit | five artifacts, byte-identical |
| `Visual goldens` with that set committed | passes |

`tests/addon.test.mts` (8 tests, six mutants in `tests/mutants.json`, all
killed) holds who owns what: the seeding is a starting file, the host names
no field of a scenario and builds no harness, and the host takes the
application and the deliveries from the seeding after its clock is installed.
The installer's side (`movedToProject`) has eight tests in
`scripts/add-to-project.test.mts` and eleven mutants in
`scripts/mutants/moved-to-project.json`, all killed.

The add-on's other scripts have 65 tests in `tests/`
(`pnpm vitest run addons/visual` from this repository's root). Each of the
first 39 was shown able to fail, by one mutant each. The seven tests of the
pin check moved to the kit with it (`kit/gates/playwright-pin.test.mts`).
The 26 of `check-server.test.mts` have `tests/mutants.json`: 26 of 26
killed. Its first run had one survivor, a row that passed for a reason other
than the one it named; writing a mutant for it showed that pnpm called by a
path (`node_modules/.bin/pnpm exec vite`) was not caught, and it now is.

## Limits

- **The server check reads the config as text.** It finds `command:` and the
  string after it. A command built in a variable is "could not run" (exit
  2), not a pass. It judges pnpm only: the fault was measured with pnpm, and
  a project made from the starter uses nothing else. A server started
  through another wrapper (`npx`, a shell script that calls pnpm) is not
  caught.

- **A machine nobody measured may draw a pixel differently.** With both knobs
  at 0 that fails a test with nothing changed. `tolerance.ts` says what to do:
  measure, then set the number just above the floor.
- **The shipped `linux-x64` goldens** were drawn on GitHub's runners in the
  pinned container, for the starter's UI as shipped. Five runs agreed; a
  different runner image or processor is not covered by that.
- **`linux-x64` means the container.** A Linux desktop outside it uses the same
  folder name and may draw different pixels.
- **One client package.** Paths assume `packages/client-react`.
- **The shipped `darwin-arm64` goldens** were drawn on one Mac. Another macOS
  version may draw the system font differently; then `pnpm visual:update`.

Not built:

- No theme matrix: one colour scheme (light), one viewport.
- No "visual reach" coverage: nothing reports which UI files no scenario renders.
- No published diff site: the HTML report is a CI artifact and a local folder.
- No run of the tier inside the container from a developer's machine.
- No per-scenario tolerance.
