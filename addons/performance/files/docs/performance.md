# Rendering performance

This guide is for a UI that animates all the time over live data: prices that
tick, rows that flash, a progress bar that drains. In such a UI, work the
browser does on the main thread for one frame is done again for every frame,
for as long as the page is open. A cost that is invisible in a form that
animates once a minute fills a processor core when live data triggers it
several times a second.

The rule in one sentence: **an animation that runs in steady state touches
only `transform` and `opacity`, with literal keyframe values, and there is one
animation per property per element.** Everything else runs on the main thread
on every frame it is active, however small the element.

Read this before you write or review a CSS animation, a transition, or an
`element.animate()` call.

## The two checks

| Command | What it does | When it runs |
|---|---|---|
| `pnpm perf:check` | Reads the source and fails on what the source settles | In `gate:fast`, so on every agent stop and in CI |
| `pnpm perf:motion-audit` | Builds the client, opens it in Chromium on the simulator, and reports every animation that is alive | By hand, and in the `Motion audit` workflow |

The static check is fast and sees every file. It cannot see what the page does
when it runs. The audit sees the running page, but only the views it opens.
[What each one cannot see](#what-the-checks-cannot-see) is listed below.

## Why some properties are cheap

A browser draws a frame in steps: style, layout, paint, composite. The first
three run on the main thread, with your JavaScript. The last one runs on a
separate compositor thread, and all it can do is move, scale, rotate and fade
layers that are already painted.

`transform` and `opacity` are the two properties that need only that last
step. The browser hands such an animation to the compositor once, and the main
thread is not involved again. Any other property sends every frame back
through style, and usually through layout or paint as well.

## The traps

"Main thread" below means that the browser recalculates the element's style,
and often layout and paint, on every frame for as long as the animation is
active.

| # | Trap | Why it costs | Checked by |
|---|---|---|---|
| 1 | A keyframe or a transition on `width`, `height`, `padding`, `margin`, `top`, `left` | Layout property: style and layout on every frame. Layout reaches the elements around it, not only the one that changes | `perf:check`, audit |
| 2 | A keyframe or a transition on `color`, `background-*`, `border-color`, `box-shadow`, `text-shadow` | Paint property: style and paint on every frame. A shadow repaints an area larger than the element | `perf:check`, audit |
| 3 | `transition: all`, or a transition that names no property | It animates whatever changes, layout and paint properties included. It also *manufactures* motion: every style change that live data makes on the element starts a new transition, so a page that looks idle is creating animations all the time | `perf:check` |
| 4 | `var()` inside a `transform` in a keyframe | The main thread has to resolve the variable before the compositor can run the animation, and again each time the variable changes. A variable in a keyframe is usually there to be written per tick, which is trap 10 | `perf:check` |
| 5 | Two animations of the same property on one element | The browser composites neither, even if both use `transform`, and even if they never overlap in time. A comma-separated `animation` list counts | `perf:check` (one `animation` list), audit |
| 6 | An animation on an SVG child element (`circle`, `g`, `path`) | Depends on the browser and on how it is written. See [what was measured](#what-was-measured) | audit |
| 7 | `filter: blur()` or any filter on a large layer | A filter is evaluated when a frame is composited. Every frame the page produces pays for it again, even when the filtered layer itself does not move | `perf:check` (animated), trace by hand (static) |
| 8 | Animating `background-position` | Paint property on the whole element. A full-screen pattern is repainted on every frame | `perf:check`, audit |
| 9 | `element.animate()` with a property that is not `transform` or `opacity` | The rules for script animations are the same as for CSS. One such animation also blocks other animations of the same element from the compositor (trap 5) | `perf:check` (literal keyframes), audit |
| 10 | A style written on every tick that drives a transition (`--pct` set each second on an element with `transition`) | Each write retargets the transition, which starts a new piece of main-thread animation. The result runs without pause | audit (shows it as "started N times") |
| 11 | A flash that is "only on an event", where live data fires the event several times a second | A 0.6 s flash once a minute costs nothing. Four times a second it never stops. Judge by how often it fires, not by what triggers it | audit ("started N times") |
| 12 | An animated overlay that was just inserted, without `will-change` | The browser may not give a new element its own layer in time, and then even an `opacity` animation runs on the main thread | trace by hand |
| 13 | A loop that is paused instead of removed | A paused animation is still an animation the browser keeps. It also hides the next mistake: resume it and the cost is back | audit (shows it as `paused`) |

Two effects make one offender expensive:

- **One main-thread animation wakes the rest.** While it runs, the browser
  recalculates style on every frame, and every other active animation is
  brought into that pass. In a trace, many animations look guilty. Fix the one
  that drives the pass and the others disappear from it.
- **The page never rests while anything animates.** A cost that is paid per
  composited frame (trap 7) is paid for every frame that anything produces.

## Fix patterns

Each of these keeps what the user sees.

### Progress bars

Do not transition `width`, and do not write a percentage on every tick. Give
the fill its full width and one animation with literal keyframes, timed by
custom properties that are written once, when the bar mounts:

```css
.fill {
  width: 100%;
  transform-origin: left;
  animation: drain var(--duration) linear var(--delay) forwards;
}

@keyframes drain {
  from {
    transform: scaleX(1);
  }

  to {
    transform: scaleX(0);
  }
}
```

A negative `--delay` starts the animation part-way, for a bar that mounts when
some of its time has already passed. Variables in the *timing* are read once,
when the animation starts, so they cost nothing afterwards. The text beside
the bar can still be rendered on every tick; the bar itself belongs to CSS.

### Colour, glow and fill

Put the look you want to reach (the shadow, the ring, the fill colour) on an
overlay, where it never changes, and animate the overlay's `opacity`:

```css
.cell {
  position: relative;
  isolation: isolate;
}

.cell::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: gold;
  opacity: 0;
  pointer-events: none;
  will-change: opacity;
}

.cell[data-flash]::after {
  animation: flash 0.6s ease-out;
}

@keyframes flash {
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
}
```

`pointer-events: none` when the overlay covers a control. `z-index: -1` with
`isolation: isolate` on the parent puts it under the text. `will-change`
covers trap 12. One animation may change `opacity` and `transform` together,
for a glow that also grows.

### Text colour

`color` cannot be animated cheaply. Fade a copy instead: the overlay carries
the same text in the other colour, with `content: attr(data-value) / ""`. The
`/ ""` gives the copy an empty accessible name; without it a screen reader
reads the text twice.

### Rotating parts of an SVG

Rotate an HTML element that wraps the SVG part, not the part itself. Stack
several small SVGs if several parts move. A square wrapper turns around the
centre by default.

### Moving patterns

Do not animate `background-position`. Make the layer one pattern tile larger
than what is visible and move the whole layer with `transform: translate3d()`.

### Soft glows and blurs

Do not put `filter: blur()` on a large layer. For a soft blob, use a wider
gradient with a gentler middle stop. For a soft edge, use a `mask-image`
gradient. The layer is then painted once and only moved afterwards.

### One animation per property per element

When an element needs an entry animation and a loop, and both use `transform`,
put one on the element and the other on a wrapper or a pseudo-element. Or
write both into one `@keyframes`. `transform` and `opacity` in one animation is
fine: that is still one animation per property.

### Remove motion nobody can see

A uniform circle that rotates looks the same in every frame and still costs a
frame's work. Check that a movement can be seen before you keep it.

### Turning motion off

For `prefers-reduced-motion`, or for a low-power mode:

- Stop transitions with `transition-property: none`. A near-zero
  `transition-duration` does not stop them: the default property is `all`, so
  every style change from live data still creates a transition, only a very
  short one. This is trap 3 again.
- Shorten animations to a near-zero duration and set `animation-delay: 0s` as
  well. `animation: none` would lose the end state of an animation with
  `forwards`, and would never fire `animationend` for code that waits on it. A
  delay that is left in place keeps an element at its `from` state, which may
  be invisible.
- A flash that is retriggered by data still starts a new, very short animation
  per tick. Remove it at the source for this mode, and remove loops instead of
  pausing them.

## How to profile

The audit tells you what is animating. A trace tells you what it costs.

1. **Steady state, with the view doing its work.** A view with no data in it
   measures clean. Put it in its busiest real state first, then record about
   12 seconds without reloading. In Chrome: DevTools, Performance, Record. The
   audit records the same kind of trace with Playwright's
   `browser.startTracing`.
2. **Read four numbers**: how busy each thread is (renderer main, compositor,
   GPU) as a share of the recording, and the number of style recalculations,
   layouts and paints per second. In a healthy view, style is recalculated at
   the rate the *data* changes: a few times a second. Recalculation at the
   rate of the display (60 or 120 a second) means a main-thread animation is
   alive.
3. **Name the offender.** Look at the `Animation` events (next section).
   `document.getAnimations()` in the console lists every live animation and
   transition with its element.
4. **Prove the cause.** Pause or hide the suspect from the console
   (`animation.pause()`, `display: none`) and record again. Compare numbers.
5. **Verify the fix the same way.** The fix is done when a steady-state trace
   has no `compositeFailed` and style recalculation is back at the data rate.
   "It feels smoother" is not a result.
6. **Compare like with like.** One trace covers every tab of the browser that
   is recorded, so close the others. A development server adds several points
   of main-thread work that a production build does not have. The audit
   measures a production build for this reason.

### Reading a trace

Chromium writes an `Animation` event when an animation starts. If it could not
hand the animation to the compositor, the event carries `compositeFailed`, a
number whose bits are the reasons, and `unsupportedProperties`, the properties
at fault. No `compositeFailed` means the compositor has it.

| `compositeFailed` | Meaning |
|---|---|
| 8192 (often with 32) | It animates a property the compositor cannot animate. `unsupportedProperties` names it |
| 64 | The element has another animation of the same property (trap 5). The list of properties is empty |
| 4096 | A filter that can move pixels, such as a blur |
| 524288 | An SVG element animated with `translate`, `rotate` or `scale` |

The bits are Chromium's `CompositorAnimations::FailureReason`. The audit
prints a bit it does not know by number.

### What was measured

These are results from Chromium 153 (the build Playwright 1.63.0 installs),
taken when this guide was written. They are here so that nobody has to take
the table of traps on trust, and so that it is clear which rules are stricter
than this one browser.

| Animation | Composited? |
|---|---|
| `transform`, `opacity` keyframes; a transition on `transform` | Yes |
| `rotate` as its own property, on an HTML element | Yes |
| `transform` and `opacity` as two animations on one element | Yes |
| Two `transform` animations on one element | No (64) |
| `width`, `color`, `border-color`, `box-shadow`, `background-position` | No (8192) |
| `filter: blur()` | No (4096) |
| `background-color` keyframes on a plain element | Yes |
| `transform: scaleX(var(--x))` in a keyframe | Yes |
| `transform` on an SVG `g`, `path` or `circle` | Yes |
| `rotate` as its own property, on an SVG `circle` | No (524288) |

Three rows disagree with the traps, and the rules stay as they are. That was
decided on purpose (2026-10-04): a rule that holds in every browser is worth
an occasional finding on code this one browser would have run cheaply. An
animation the rule is wrong about for your case is accepted in
`tools/perf/allowed.mts`, with the reason.

- **`background-color`** was composited in a simple case. That is recent, has
  conditions, and not every browser engine does it. Both checks fail it.
- **`var()` in a transform keyframe** was composited when the variable did not
  change. The rule comes from a project where such a bar ran on the main
  thread, and literal keyframes are the form that is known to work everywhere.
  `perf:check` fails it.
- **SVG children** were composited when animated with `transform`. Because
  this depends on the browser and on the exact CSS, the static check does not
  guess. The audit reports what Chromium did.

Traps 12 and 13, and the cost of a static filter in trap 7, come from the
project these rules were taken from. They were not measured again here.

## Exceptions

These rules are about steady state. They do not apply to an animation that
live data cannot trigger: a 150 ms hover transition on a button, a dialog that
fades in when the user opens it. Such an animation runs rarely and briefly.
Do not rewrite it.

The static check cannot tell a hover from a tick, so it fails both. An
exception is accepted in one place only, `tools/perf/allowed.mts`, and each
entry carries its reason:

```ts
import type { Allowed } from "./lib/allowed.mts";

const allowed: Allowed = {
  // Findings of `pnpm perf:check`. Copy file, rule and property from the finding.
  animations: [
    {
      file: "packages/client-react/src/ui/Button.module.css",
      rule: ".button",
      property: "background-color",
      reason: "Hover feedback. Runs on a pointer event, never on live data.",
    },
  ],
  // Findings of `pnpm perf:motion-audit`. Copy the animation's name from the report.
  motion: [],
};

export default allowed;
```

The file starts with both lists empty, and it is the project's own: updating
the add-on never changes it. An entry without a reason stops the check. An
entry that no longer matches a finding is itself a finding, so the list cannot
grow stale.

Before you add an entry, ask how often the trigger fires when the app is
connected to real data. "On an event" is not an answer if the event is a
price update (trap 11).

## What the checks cannot see

`pnpm perf:check` reads source. It does not see:

- Styles written in TypeScript: a `style` prop, a CSS-in-JS library, a class
  toggled by script. It reads `.css` files only, not Sass or Less.
- `element.animate()` keyframes that are held in a variable, built by a
  function, or spread from another object. It lists such a call as "not
  judged". It never counts it as clean.
- Which element a rule matches. So it cannot see an SVG child (trap 6), two
  animations that reach one element from different rules or from CSS and
  script together (trap 5), or a missing `will-change` (trap 12).
- How often anything runs (traps 10 and 11), or how large a filtered layer is
  (trap 7).
- A method called `animate` that is not the Web Animations one. It would be
  judged as if it were; accept it in the allow-list with that reason.

`pnpm perf:motion-audit` watches the running page. It does not see:

- A view behind a click, a hover, or a login. It opens the paths it is given
  (`--path`, default `/`) and does not interact.
- An animation shorter than the 50 ms between two snapshots, unless it is
  alive when a snapshot is taken.
- Cost. It reports what is animating and whether the compositor has it, not
  how much time the main thread spends. That needs a trace.
- Other browsers. It runs Chromium only.

With `prefers-reduced-motion: reduce` the audit *reports* what still moves and
does not fail it. Reduced motion means less motion, not none: a short fade
that tells the user a value changed is a fair thing to keep, and a tool cannot
tell that fade from decoration. A project that promises a fully still mode
runs `pnpm perf:motion-audit --assert-still`, which fails on any live
animation and any animation-frame callback in that pass.

## Checklist before merging an animation

For any CSS or script animation that runs in steady state, or that live data
can make run in steady state:

- [ ] It animates only `transform` and `opacity`.
- [ ] Its keyframe values are literal: no `var()` inside a `transform`.
- [ ] There is one animation per property on the element.
- [ ] Its target is an HTML element, not a part of an SVG.
- [ ] A shadow, a fill or a border colour sits on an overlay and does not change.
- [ ] A newly inserted animated overlay has `will-change`.
- [ ] It starts once, when the element mounts. No style is written per tick to drive it.
- [ ] You know how often live data triggers it: per minute, or per second.
- [ ] `pnpm perf:check` passes, and `pnpm perf:motion-audit` lists the animation with nothing failed.
- [ ] For anything new on a busy view: a steady-state trace has no `compositeFailed`.
