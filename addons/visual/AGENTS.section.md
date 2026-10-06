## Visual goldens

Each scenario in `packages/client-react/tests/visual/scenarios.ts` is rendered
in a fixed state and compared with a committed image (a golden). A difference
fails. Goldens are kept per system in `tests/visual/goldens/<platform>/`,
because systems draw text differently. CI compares the `linux-x64` set.

```bash
pnpm visual          # compare every scenario with this system's goldens
pnpm visual:update   # redraw this system's goldens
pnpm visual:jitter   # measure how much the same commit differs from itself
pnpm visual:check    # in gate:fast: typecheck of the tier
pnpm visual:check:server   # in gate:fast: no Playwright server is started through pnpm
```

`pnpm visual` is not part of `gate:full`: it needs a browser and goldens drawn
on this system. Run it yourself after a change that can reach the screen (the
UI, its CSS, a presenter). Skip it for the server, docs and tooling. In CI it
is the `Visual goldens` workflow.

### Add a scenario

Add an entry to `scenarios.ts`: a name and the state, as data. State goes in
through the app harness; never click to reach it, and never wait for time to
pass. If the state cannot be expressed yet, add a field to `Scenario` and
deliver it in `seeding.ts`, beside `scenarios.ts`. Both files are the
project's. Never edit `host/`: it is the add-on's, an update replaces it, and
an edited file there makes every update refuse. Then run `pnpm visual:update`,
open the new image, and check it shows what the name says. Commit the image
with the scenario.

In `seeding.ts`, state that must be there before the first render goes in
`app` (data a port answers from memory, a machine that starts with a value,
set through its own intent). State that arrives afterwards goes in `deliver`,
and a wait there is `clock.tick(...)`.

### When a comparison fails

1. Read the failure in full. Do not pipe the output through `tail`, `head` or
   `grep`: the cut can hide the failing line and leave a summary that reads as
   a pass.
2. Open `packages/client-react/tests/visual/reports/html/index.html`. Each
   failure shows the golden, the new image and the difference.
3. Decide which it is. **Not meant:** fix the code; leave the goldens alone.
   **Meant:** run `pnpm visual:update`, check that only the scenarios you
   expected changed (`git status`), and commit the images in the same commit as
   the change. Then tell the user the `linux-x64` set also needs a redraw: the
   `Update visual goldens` workflow on the branch, whose summary gives the
   commands. You cannot draw that set on another system.

Never update goldens to make a failure go away before you have looked at the
difference and can say why it is correct. If you cannot say why, stop and ask.

### Traps

- **The goldens did not change after a change you meant.** The page came from a
  stale server, or the change does not reach any scenario. The config refuses
  to use a server it did not start; if the port is taken, find and stop the
  holder (`lsof -iTCP:4319 -sTCP:LISTEN`), do not set `reuseExistingServer`.
- **A scenario fails now and then.** Something on the page still moves. Find it
  and pin it in the host (its clock, an animation, a late font). Do not add a
  wait, a retry or tolerance.
- **A run prints its results and never ends.** A server was started through
  pnpm and outlived it. Never write `pnpm exec`, `pnpm run` or `pnpm --filter`
  in a `webServer.command`; start the program by its path
  (`node_modules/.bin/vite`) with `cwd` set to the package.
  `pnpm visual:check:server` fails on it.
- **Changing `tolerance.ts`.** Only with a measurement: run `pnpm visual:jitter`
  and write what it found beside the numbers. Both knobs matter: a zero pixel
  budget with a loose `threshold` still misses a low-contrast change.
- **Upgrading Playwright.** Change the npm version and the image tag in every
  workflow together (the `playwright-pin` gate fails otherwise), then redraw
  every set: a new browser draws new pixels.
- **A missing golden fails; it is never written by a plain run.** On another
  system than the committed sets, `pnpm visual` fails until that system has a
  set of its own. Say so; do not copy another system's images.
