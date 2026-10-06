## End-to-end tests

`packages/e2e` drives the built client in a real browser, with Playwright. It
runs in two modes, and a mode's specs are in the folder of its name:

| Mode | What runs | Specs |
|---|---|---|
| `sim` | The client alone, on its in-browser simulator | `packages/e2e/src/sim` |
| `fullstack` | The client against the real server | `packages/e2e/src/fullstack` |

```bash
pnpm e2e                              # build, serve, run every spec in both modes, stop everything
pnpm e2e --mode sim                   # one mode: only what it needs is built and started
pnpm e2e src/sim/selection.spec.ts    # one spec
pnpm e2e -g "marks the row"           # the tests whose title matches
pnpm e2e --mode sim --headed          # a visible browser; --ui opens Playwright's own runner
pnpm e2e:install                      # once on a machine: downloads the browser
```

`pnpm e2e` is not part of `gate:full`: it needs a browser and a port. Run it
yourself after a change that can reach the screen through more than one layer
(the composition root, an adapter, the server, a build setting). Skip it for a
change one layer's own tests cover, and for docs and tooling. In CI it is the
`End-to-end` workflow.

Exit code 2 means the run could not start, not that the code is wrong. Where a
port cannot be opened (a sandbox), say that the specs were not run where you
are. Where the browser is missing, run `pnpm e2e:install`.

### Is it an end-to-end test?

Most behaviour has a cheaper and sharper home. An end-to-end spec waits in
real time and sees only the screen, so write one only for what nothing else
can show.

| What you want to prove | Where it goes |
|---|---|
| A rule of the application: order, movement, when a row goes stale | A presenter, use case or machine test, on fake timers |
| How a component draws a given state | The component's test, through its page object |
| The client and the server agree on a message | `packages/integration` |
| How it looks | The visual goldens, if the project has them |
| The built app wires the feature at all; a mode picks the right adapter; a journey across screens | An end-to-end spec |

One or two specs for a feature, on its main path. If a spec needs a state that
takes time or luck to reach (a stale row, one symbol among several), the rule
belongs in a test that controls time.

### How a spec is written

Copy `packages/e2e/src/sim/selection.spec.ts`.

- A spec imports `test` and `expect` from `#/testing/test.ts`, takes page
  objects as fixtures, and asserts on what they return. It never holds the
  browser: the lint fails on `page`, a locator or a selector in a spec.
- A page object is `packages/e2e/src/pages/<Name>.page.ts`: an interface in
  the words of a user, and a function that builds it from Playwright's
  `Page`. Add it to the fixtures in `packages/e2e/src/testing/test.ts`.
- A page object finds an element by a test id from
  `packages/client-react/src/ui/testids.ts`, or by its role. Add the id to the
  client first. It reads what it reports in one step, so the page cannot
  change between two reads.
- The package imports nothing else of the application. Use `import type` for
  a type of the wire protocol.

### Waiting

- Wait for a state, never for time. `await expect.poll(priceList.rows)` asks
  again until it holds; `await expect(async () => { … }).toPass()` does the
  same for two things that must agree.
- Read a value to compare with only after waiting for the state it depends on.
- When the state depends on chance, work out the odds and write them beside
  the timeout, as `packages/e2e/src/sim/priceList.spec.ts` does. Better: assert
  something that does not depend on chance.
- Do not add a retry, and do not raise a timeout to make a spec pass. A spec
  that fails now and then waits on the wrong thing.

### A mode, and what it starts

`tools/e2e.config.mts` is the project's. It says how the client is built and
served and what each mode starts. Add a mode there, with a folder of its name
under `packages/e2e/src`. A spec outside every mode's folder stops the run, and
so does a mode with no spec.

- Write a command as the program and its arguments, never `pnpm …`: the
  wrapper can die on the stop signal and leave the server running.
- Write no port. A program prints its address and the `ready` pattern reads it.
- To prove a mode uses the server, compare the screen with what came over the
  wire (`serverFeed`). The simulator makes prices that look the same.

### When a spec fails

1. Read the output in full. Do not pipe it through `tail`, `head` or `grep`.
2. Open the report: `pnpm --dir packages/e2e exec playwright show-report reports/html`.
   Each failure has a trace: every step, the page at that step, the network
   and the console.
3. Decide which it is. **The application is wrong:** fix it, and ask whether a
   cheaper test should have caught it. **The spec waits on time or chance:**
   make it wait on a state. If you cannot tell, stop and ask.

### Traps

- **`playwright test` run by hand fails with "the run is started with
  `pnpm e2e`".** The Playwright config starts no server. Use `pnpm e2e`.
- **Upgrading Playwright.** Change the version in `packages/e2e/package.json`
  and the image tag in `.github/workflows/e2e.yml` together; the
  `playwright-pin` gate fails otherwise. Every package that uses Playwright
  takes the same version.
