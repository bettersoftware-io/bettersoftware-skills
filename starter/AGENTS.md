# Working in this project

A TypeScript monorepo built on ports and adapters, with a streaming UI on RxJS.
The rules below are enforced by checks, not by convention.

## Commands

```bash
pnpm dev          # the React client on the in-browser simulator (no server)
pnpm dev:fs       # the server and the client together
pnpm gate:fast    # architecture gates, React checks, lint, typecheck: seconds, for while you work
pnpm gate:full    # gate:fast, then tests and the build: what CI runs
pnpm gate:full:quiet   # the same commands and verdict, printing only the stage that failed
pnpm test
```

Run `pnpm gate:full` before you say work is finished. A red gate means the
work is not finished, and `gate:fast` alone does not show that it is: it runs
no test. The stop hook runs `gate:full` for you whenever a file has changed
since it last passed.

`pnpm gate:full:quiet` (and `gate:fast:quiet`) runs the same commands in the
same order and exits with the same code. It prints one line for each stage
that passed, any `SKIP` line that stage printed, and the whole output of the
stage that failed. Run the quiet form
when you are the one reading the output: the loud form prints every passing
test and every cached task. Skip it when a person asked to see the full
output; CI runs the loud form.

Some sandboxes do not let a process listen on a port; Codex's default one does
not. There the tests that open a real port (the files named `*.port.test.ts`)
are left out, and the run prints a `SKIP` line that says so. That is the
sandbox, not your change: say in your report that those tests were not run
where you are. The stop hook runs `gate:full` outside the sandbox, and CI
never skips them.

## The layers

Dependencies point inward only. `architecture.config.mts` is the declaration
the gates read; a package that is not listed there fails.

| Package | Role | Holds | May import |
|---|---|---|---|
| `packages/domain` | domain | Entities, use cases, port interfaces, simulators | nothing (runtime: `rxjs` only) |
| `packages/shared` | shared | The wire protocol | domain |
| `packages/client-core` | core | Adapters, presenters, state machines, the composition of the app | domain, shared |
| `packages/react-bindings` | bindings | The view model: the only place RxJS meets React | core, domain |
| `packages/client-react` | client | `src/app` (composition root) and `src/ui` (dumb components) | bindings, core, domain |
| `packages/server` | server | The WebSocket server | domain, shared |
| `packages/integration` | integration | Tests that run a client adapter against the real server. Tests only | every package above; nothing imports it |

## Where a thing goes

- **It needs the outside world** (network, storage, clock): declare a port in
  `packages/domain/src/ports`, in domain words. Write a contract test beside it
  in `__contracts__`. Implement it as a simulator in the domain and as a real
  adapter in `client-core/src/adapters`, and run the contract against both.
- **It is application behaviour** (what data exists, what happens on an intent,
  anything on a timer): a presenter or a state machine in `client-core`.
- **It turns the wire format into domain terms**: the adapter. Nothing past an
  adapter sees a wire message.
- **It reads configuration or picks an adapter**: the composition root,
  `client-react/src/app`. Nowhere else.
- **It checks that the client and the server agree**: a test in
  `packages/integration`, the only package that may import both. Each side's
  own tests stay where they are; this is for what neither can see alone.
- **It is drawn on screen**: a component in `client-react/src/ui`, reading from
  the view model. No RxJS, storage, `fetch`, environment or timers there.
- **It is a new package**: list it in `architecture.config.mts` with its role,
  and give it a `typecheck` and a `test` script. One that holds only types
  also says `typesOnly: true`.

Four rules about imports:

- A presenter or a state machine takes its port as an argument. It never
  imports from an `adapters` folder.
- No Node built-in (`node:fs`, `node:path`) outside `packages/server`, except
  in tests: everything else runs in the browser.
- `react` and `react-dom` are imported only in `react-bindings` and
  `client-react`; `ws` only in `server`.
- What is written for tests (a `testing/` folder, a `*.page.tsx`, a test) is
  imported only by tests.

The price list is a worked example of every one of these. Copy its shape:

| Pattern | File |
|---|---|
| Port | `packages/domain/src/ports/pricePort.ts` |
| Contract test | `packages/domain/src/ports/__contracts__/PricePortContract.ts` |
| Simulator | `packages/domain/src/simulators/priceSimulator.ts` |
| Use case | `packages/domain/src/useCases/trackMovement.ts` |
| Real adapter | `packages/client-core/src/adapters/wsPrice.ts` |
| Presenter (shared state, timers) | `packages/client-core/src/presenters/pricesPresenter.ts` |
| State machine (per-component state) | `packages/client-core/src/machines/selectionMachine.ts` |
| View model | `packages/react-bindings/src/createViewModel.ts` |
| Composition root | `packages/client-react/src/app/startApp.tsx` |
| Client adapter against the real server | `packages/integration/src/priceOverWebSocket.port.test.ts` |
| Dumb component | `packages/client-react/src/ui/PriceList.tsx` |
| Page object and its test | `packages/client-react/src/ui/PriceList.page.tsx`, `PriceList.test.tsx` |

## Tests

- Anything on a timer is tested on fake timers, advanced by the exact interval.
  A test never sleeps.
- A UI test talks to a page object. Only the page object touches the testing
  library.
- A test id is a constant in `packages/client-react/src/ui/testids.ts`, used
  by the component and by the page object. Never a string literal.
- A test that needs the whole application asks `createAppHarness`, in
  `packages/client-core/src/testing/appHarness.ts`. Only that file calls
  `createApp`.
- A port's contract imports the port, the entities and the test runner. Never
  a simulator or an adapter: each one's test passes itself in.
- A test that opens a real port is named `*.port.test.ts`, so it can be left
  out, and said to be left out, where a port cannot be opened.
- A fixture factory is named `create…`.
- Tests come first in a test file; helpers go below them.

## TypeScript only

No JavaScript source files. Scripts and tool configs are `.mts`, which Node runs
directly. A file a tool can only load as JavaScript is listed in
`architecture.config.mts` under `javascriptAllowed`, with the reason.

## Node

The oldest Node this runs on is declared once, as `devEngines.runtime` in the
root `package.json`. Never add `engines.node` to any `package.json`: a host's
build (`vercel build`) reads it and refuses a range above the Node it offers,
so the deploy fails with every check green. The `node-floor` gate holds both.

pnpm is named once, as `packageManager` in the root `package.json`: an exact
version, then `+sha512.` and the hash of that release. Corepack checks the
download against it. To move to another pnpm run
`node tools/arch/ci/pin-package-manager.mts pnpm@<version> --write`, then
`pnpm install`. Never type or copy the hash by hand, and never delete it to
get past the `package-manager` gate.

## How code is written

`pnpm lint` enforces these. `pnpm lint --fix` repairs the ones marked (fix).

- A named function is a `function` declaration, never a `const` holding an
  arrow. Helpers go below the function that uses them.
- An arrow (a callback, a member of an object) has a block body and a
  `return`. (fix)
- A blank line before and after a function and a block that spans lines,
  between two declarations that span lines, and between the members of a
  class. (fix)
- An object type has a name. No `{ … }` type on a parameter, a return type, a
  variable, a class property, a cast or a type argument: declare an
  `interface` and use it.
- One import statement per module, with an inline `type` on each type:
  `import { type Price, read } from "./price.ts"`. A statement that names only
  types stays `import type`. (fix)
- No CommonJS: no `require`, `module.exports`, `__dirname` or `__filename`,
  and no `.cts` file. Use `import` and `import.meta.dirname`.
- One class in a file, and the file has its name.
- In a component, take the hooks out of the view model by name:
  `const { usePrices } = useViewModel()`. Never keep the bundle in a variable
  or call through it.
- A component follows React's rules: a hook is called at the top level, an
  effect lists what it reads, and nothing reads a ref or sets state while
  rendering.
- No `style={{ … }}` in a component: styling goes in a stylesheet, by class.
- `packages/react-bindings` uses no `useMemo`, `useCallback` or `memo`. Logic
  that needs one belongs in the core.
- `packages/client-react` uses none of the three either, for another reason:
  the React Compiler memoizes at build time. Write the plain value, and a
  function declaration for a callback.

## The React Compiler

The client's build runs the React Compiler
(`packages/client-react/vite.config.ts`). It skips a function it cannot
compile and says nothing, so two checks in `gate:fast` hold it:

- `pnpm check:react-policies` fails when `reactCompiler` in
  `architecture.config.mts` and the build disagree, and when a package that
  imports React is not under the lint rules for its role.
- `pnpm check:compiler` compiles each function listed under `compilerTracked`
  in `architecture.config.mts` and fails when one is no longer memoized.

What no check decides:

- **A component that reads the view model is not compiled.** Its hooks come
  out of a value (`const { usePrices } = useViewModel()`), and the compiler
  skips such a function. Keep that component thin: it reads, and hands plain
  props to components that take only props. Those are compiled.
  `packages/client-react/src/ui/PriceList.tsx` shows both.
- **When to add an entry to `compilerTracked`.** When a component depends on
  the compiler to keep something stable or cheap: a costly derived value, a
  callback a child compares. Skip it for a component whose render is cheap
  anyway.
- **When the compiler cannot do it** (an identity a library needs to stay the
  same, in a function the compiler skips): say so and ask. Do not switch the
  lint rule off to add a `useMemo`.

## Imports inside a package

An import of a file in the same package is relative and climbs one folder at
most, as in `../entities/price.ts`. Anything deeper is written from the
package's `src` with the `#/` alias: `#/entities/price.ts`. Every package
declares it (`"imports": { "#/*": "./src/*" }` in its `package.json`), and
Node, Vite, Vitest and `tsc` all read it from there. A new package declares it
too.

Skip it in a `*.config.ts` file that reaches `tools/`: the alias cannot point
outside its package. The gates follow an alias to the file it names, so a
forbidden import is still found. The `format-lint` add-on fails a deeper
relative import; without it this is a convention.

## Reviewing a change

A review in this project does two things first, whoever or whatever does it:

1. Runs `pnpm gate:fast` and shows its output. Not run is not passed.
2. Answers the seven questions in `tools/arch/docs/review.md`, each with its
   evidence as `file:line` and a verdict, including the ones that pass.

Anything else a review finds (robustness, security, performance) comes after
those, never in place of them.

## When a gate fails

Its message says what is wrong and where the code belongs. Fix the code. If you
believe a finding is wrong, or it is outside what you were asked to do, say so;
do not work around the gate or edit the rules to make it pass.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
