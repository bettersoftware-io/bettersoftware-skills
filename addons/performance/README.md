# Add-on: rendering performance

For a project whose UI animates all the time over live data. In such a UI,
main-thread work in one frame is repeated in every frame, so an animation on
the wrong property costs for as long as the page is open. The add-on fails
what a machine can decide about an animation, and reports what only the
running page shows.

```bash
node scripts/add-to-project.mts <project> performance
cd <project> && pnpm install && pnpm perf:check && pnpm perf:motion-audit
```

## What it adds

| Part | Where | What it does |
|---|---|---|
| Guide | `docs/performance.md` | Why it matters, thirteen traps with the reason for each, the fix patterns with code, how to profile and read a trace, a checklist |
| `pnpm perf:check` | `tools/perf/check-animations.mts` | Static check. Reads every `.css` file and every literal `element.animate()` call. Joins `gate:fast` |
| `pnpm perf:motion-audit` | `tools/perf/motion-audit.mts` | Runtime audit. Builds the client for the simulator, serves it, opens it in Chromium, lists every live animation, fails one the compositor cannot run |
| Allow-list | `tools/perf/allowed.mts` | The only way to accept an exception. A starting file: written once with empty lists, then the project's own |
| CI | `.github/workflows/perf.yml` | Runs the audit on pull requests and on main, in the Playwright image |
| AGENTS section | `AGENTS.md` | When to read the guide, how to choose a fix, when to run the audit, when the rules do not apply |

One dev dependency, in the root `package.json`: `playwright`, exactly `1.63.0`.
Its Chromium build is 1243 (Chromium 153). The CSS scanner has no dependency.

## The static check

It fails, with the file, the line, what is wrong and what to write instead:

- a `transition` or a `@keyframes` on a property other than `transform`,
  `opacity`, `translate`, `rotate`, `scale`;
- `transition: all`, written out or implied by naming no property;
- `var()` inside a transform value in a keyframe;
- one `animation` list that puts two animations of the same property on an
  element;
- the same, for `element.animate()` keyframes written as a literal.

```
FAIL animations (2)
  packages/client-react/src/index.css:47
    @keyframes flash-up animates `background-color`. It is a paint property: style is recalculated and the element repainted on every frame. Put the target look on an overlay (`::after`, `inset: 0`) and animate the overlay's `opacity` (docs/performance.md, "Colour, glow and fill").
    rule "@keyframes flash-up", property "background-color"
```

`PASS` says how much was judged. With no transition, no `@keyframes` and no
`.animate(` call it prints `SKIP` and the reason. Code it cannot settle (a
transition whose property is a variable, keyframes held in a variable, an
animation whose `@keyframes` it cannot find) is listed as "Not judged" and is
never counted as clean. Exit 0, 1, 2 as in the kit.

An exception needs an entry in `tools/perf/allowed.mts` with `file`, `rule`,
`property` and a `reason`. An entry with no reason stops the check (exit 2).
An entry that matches no finding is a finding.

It is a scanner, not a CSS parser: it follows braces, semicolons, comments and
strings. That is enough for these rules and for nested CSS, and it kept the
add-on to one dependency. It does not read Sass or Less.

## The runtime audit

It starts its own server every time: it builds the client into a temporary
folder with `VITE_SERVER_URL` empty (the simulator), serves that build with
`vite preview` on a free port with `--strictPort`, waits for Vite to announce
that address, and stops the server and removes the folder when it is done. It
never uses a server that is already running, and it does not write to the
project's `dist`.

For each path (`--path`, default `/`) it takes two passes, 80 snapshots of
`document.getAnimations()` over 4 seconds each, after 2 seconds to settle:

1. **Motion allowed.** Every live animation is listed with its element, its
   properties, its state and how many times it was started. It fails when:
   - a property is not compositor-only (the rule that holds in every engine);
   - Chromium's own trace says it did not composite the animation
     (`compositeFailed`). This catches what a property list cannot: two
     animations of one property on an element, a filter that moves pixels.
2. **`prefers-reduced-motion: reduce`.** The same list, as a report of what
   still moves. The two failures above still apply. That something moves is
   not a failure, unless `--assert-still` is given.

Why a report and not a failure: the audit this one comes from asserts only the
mode that *promises* no motion at all, and lists the others. Reduced motion
promises less motion, not none. A short fade that tells the user a value
changed is a fair thing to keep, and a tool cannot tell it from decoration. A
project that does promise a still mode asserts it with `--assert-still`.

Exit 2, never 0, when it could not run: Chromium is not installed, the client
did not build, the server did not start, the page threw an error. `SKIP` when
no animation was alive in any window.

## How it was tested

Unit tests, run from this repository: `pnpm vitest run addons/performance`,
45 tests in two files. `tests/check-animations.test.mts` runs the static check
against five fixture projects (`clean`, `broken`, `none`, `unjudged`,
`allowed`) and runs the command for its exit codes.
`tests/motion-judge.test.mts` covers the audit's verdict and its reading of a
trace, as pure functions over data. Each of the 45 tests was turned red by a
mutant of its own and restored.

End to end, in a project made by `scripts/create-project.mts` and given the
add-on by `scripts/add-to-project.mts`:

| Case | `pnpm perf:check` | `pnpm perf:motion-audit` |
|---|---|---|
| The untouched starter (no animation) | `SKIP`, exit 0 | `SKIP`, exit 0 |
| A `background-color` keyframe flash on the price cells | `FAIL (2)`, exit 1 | `FAIL (4)`, exit 1, "started 3 times" |
| The same flash on `opacity` and `transform` | `PASS`, exit 0 | `PASS`, exit 0 |
| Two `transform` animations on one element | `FAIL (1)`, exit 1 | `FAIL (4)`, exit 1, from Chromium's trace |
| That finding accepted in `allowed.mts` | `PASS`, "Accepted (1)" | `PASS`, "4 finding(s) accepted" |
| `--assert-still` with the `opacity` flash | | `FAIL (2)`, exit 1 |
| `PLAYWRIGHT_BROWSERS_PATH` set to an empty folder | | "could not run", exit 2 |

`pnpm gate:full` passes in the project with the add-on in it, and goes red at
`gate:fast` with the `background-color` flash in place. A type error planted
in `tools/perf` was caught by the project's tooling typecheck (the second half
of `pnpm typecheck`). After every run
no server process and no temporary folder was left.

Not tested: the workflow. It cannot be run locally, and Docker was not
available to run the audit inside the image. Its steps, action pins and image
tag are the ones the source project's CI uses with the same Playwright
version. What is unknown is whether Chromium in that image gives the same
`compositeFailed` verdicts as on macOS; the property rule does not depend on
it. If a browser reports that it composites nothing at all, the audit says so
and judges by property only.

## What was measured, and where it differs from the rules

Measured on Chromium 153 with a page of test animations, by tracing:

- Not composited: `width`, `color`, `border-color`, `box-shadow`,
  `background-position`, `filter: blur()`, two `transform` animations on one
  element, the `rotate` property on an SVG child.
- Composited: `transform`, `opacity`, the two as separate animations on one
  element, `rotate` on an HTML element.
- Composited, **against the rules as received**: a plain `background-color`
  keyframe; `scaleX(var(--x))` in a keyframe; `transform` on an SVG `g`,
  `path` and `circle`.

So two inherited rules are stricter than this browser: `var()` in a transform
keyframe (the static check fails it, as specified) and SVG children (the
static check does not judge them; the audit reports Chromium's verdict). The
guide says this in its own words, under "What was measured". Three more
inherited claims were not measured again: the cost of a static filter on a
large layer, a new overlay without `will-change`, and a loop that is paused.

## Limits

The static check does not see:

- styles set from TypeScript (a `style` prop, CSS-in-JS, a class toggled by
  script), or anything but plain `.css`;
- `.animate()` keyframes that are not a literal in the call (listed as "Not
  judged");
- which element a rule matches: so not an SVG child, not two animations that
  reach one element from different rules or from CSS and script together, not
  a missing `will-change`;
- how often an animation runs, or how large a filtered layer is;
- whether a method named `animate` is the Web Animations one.

The audit does not see:

- a view behind a click, a hover or a login: it opens paths and does not
  interact;
- an animation shorter than the 50 ms between snapshots, unless a snapshot
  lands on it;
- cost: it says what animates and whether the compositor has it, not how busy
  the main thread is. That needs a trace, and the guide has the recipe;
- any browser but Chromium.

It picks the simulator by building with `VITE_SERVER_URL` empty. A project
that chooses its data source another way has to change that line in
`tools/perf/lib/server.mts`.

`tools/perf/lib/motion-probe.mts` declares the few browser types it uses by
hand. The project's tooling is typechecked without the DOM library, and adding
it would have meant editing `tsconfig.tooling.json`.

This repository's own `pnpm typecheck` leaves out `motion-audit.mts`, because
`playwright` is not installed here. It is typechecked in a project that has
the add-on.

The `playwright` version and the image tag in `perf.yml` must stay equal. If
they drift, the audit in CI exits 2 ("Chromium could not be started"), which
is loud, so there is no separate check for it. The `visual` add-on pins
`@playwright/test` to the same version; a project with both should move them
together.
