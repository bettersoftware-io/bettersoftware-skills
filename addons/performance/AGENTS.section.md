## Rendering performance

This UI animates over live data, so main-thread work in one frame is repeated
in every frame. `pnpm perf:check` (part of `gate:fast`) fails what the source
settles. The rest is judgement, and it is yours.

**Before you write or review a CSS animation, a transition or an
`element.animate()` call, read `docs/performance.md`.**

Choosing a fix (each is a section of the guide, with code):

- It changes a size or a position: scale or translate with `transform`, timed
  once at mount ("Progress bars").
- It changes a colour, a shadow or a fill: put the final look on an overlay
  and fade the overlay's `opacity` ("Colour, glow and fill").
- It needs an entry animation and a loop: one per element, the second on a
  wrapper or a pseudo-element ("One animation per property per element").
- It moves part of an SVG, a pattern, or a blurred layer: see the pattern for
  that case. Do not invent a fourth way.

Run `pnpm perf:motion-audit` when:

- you added or changed an animation that live data can trigger;
- `perf:check` printed "Not judged" for your code;
- you changed how often something ticks, flashes or re-renders.

Read its report, not only its exit code: "started N times" on a flash, or a
transition you did not write, is motion that looks idle and is not. It needs
Chromium (`pnpm exec playwright install chromium`) and opens only the paths it
is given, so a view behind a click is yours to check by hand.

When these rules do not apply: an animation that live data cannot trigger. A
hover transition on a button, or a dialog that fades in when the user opens
it, runs rarely and briefly. Do not rewrite it. Accept it in
`tools/perf/allowed.mts` with the reason. Ask first how often its trigger
fires on real data: "on an event" is not a reason if the event is a tick.

Do not add an allow-list entry to get past a finding on steady-state motion,
and do not weaken a check. If a finding looks wrong, say so.
