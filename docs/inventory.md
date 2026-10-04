# Inventory

What will be extracted from
[ReactiveTraderCloudClone](https://github.com/bettersoftware-io/ReactiveTraderCloudClone)
(RTC below), and what will be left behind.

Sources surveyed on 2026-10-04: the 40 dependency-cruiser rules in
`.dependency-cruiser.cjs`, the 46 numbered grep gates in
`docs/architecture/12-architectural-gates.md` (four retired), the 10 custom
ESLint rules in `eslint-rules/`, the `scripts/check-*` gates, ADR-004 and
ADR-005, and the test-strategy and design-decision documents.

Each row names the rule and where it comes from in RTC. Nothing here has been
generalised yet; that happens when the template or skill is written.

## Keep: structure

For any TypeScript pnpm monorepo.

| What | RTC source |
|---|---|
| Inward-only layering: domain, shared, application core, bindings, clients, server | `domain-stays-pure`, `domain-no-node-builtins`, `shared-no-apps`, `client-core-stays-inner`, `client-core-framework-free`, `react-bindings-no-apps` |
| Siblings never import each other | `client-not-server`, `server-not-client`, `clients-never-import-each-other`, `no-circular` |
| "Leaf stays pure" as a reusable rule shape | `ws-effects-stays-pure`, `motion-core-stays-pure` and similar |
| "Vendor X only in package Y", written as an allowlist, not a blocklist | `dockview-only-in-layout-dockview`, the two SDK-confinement rules |
| Every package wired to every gate | `check-workspace-scripts`, `check-package-wiring`, `check-dist`, manypkg + syncpack, knip |
| Ports declared in the domain; one composition root per app; per-platform code is adapters only | design decisions §10.2, composition §14.1 |
| Naming and reading order | `name-functions-by-effect`, `name-jsx-handlers`, `newspaper-order`, `component-newspaper`, `class-filename-match`, `no-render-functions` |

## Keep: RxJS and streaming UI

| What | RTC source |
|---|---|
| `Observable<T>` at every boundary; closure-in-`defer` for per-subscription state | design decisions §10.1 |
| `@rx-state/core` in the core, `@react-rxjs/core` only in the bindings | design decisions table |
| Machines as `Machine<TState, TIntents>` (`Subjects → merge → scan(reduce) → state()`) | ADR-005 branch 1 |
| One ViewModel seam; no dependency injection in the UI tree | ADR-004 |
| Dumb UI: no `rxjs`, `localStorage`, `fetch`, env or timers in `src/ui` | grep gates 26–29 (30–33 for a React Native client) |
| Where UI logic goes: machine, DOM-frame hook plus pure function, plain hook, or context read | ADR-005 decision tree |
| Use cases own enrichment; simulators are production code behind the same ports | design decisions §10.5 |
| Declarative WebSocket effects for the server and for simulated backends | `@rtc/ws-effects`, to be published as `@better-software/rx-ws-effects` |

## Keep: testing

| What | RTC source |
|---|---|
| Port contract tests parameterised over adapters (simulator and real) | test strategy §9.4, §9.6; gate 23 |
| Page objects with `TESTIDS` / `STRINGS` constants; the driver confined to one layer | gates 1–11, `page-objects-own-their-component`, `no-framework-calls-in-specs` |
| UI contract tier | test strategy §9.8 |
| Fake timers for timer-driven outcomes | test strategy "Waiting on time"; gate 18 |
| Prove a test can fail | `scripts/mutation-check.mjs` |
| Fixture rules | `json-fixtures-in-factories`, `name-fixture-factories`, `no-minified-json-literal` |
| Composition root built in exactly one test helper | gate 17 |

## Keep: coverage and reporting

| What | RTC source |
|---|---|
| Coverage gates in CI (≥95% lines, ≥85% branches where set) | `ci.yml` coverage steps |
| Per-file gap ranking from a fresh local run | `scripts/coverage-gaps.mjs`, `/rtc:backfill-test-coverage` |
| Published multi-tier coverage report, plus a job-summary rendering | `coverage-report.yml`, `scripts/pages/publish-to-pages.mjs` |
| "Visual reach" coverage: which UI no golden scenario ever renders | the vitest-browser coverage-only tier |
| Visual diff report, published and uploaded as an artifact on failure | `visual.yml` report job, `scripts/pages/build-visual-report.mjs` |
| e2e report uploaded as an artifact on failure | `ci.yml` e2e job |
| Tolerance audit: measure real cross-run noise before setting a pixel budget | `visual:jitter`, `/rtc:visual-tolerance-audit` |
| Lessons: dispatch-only reports are stale by default; an aggregate gate hides one weak file; never filter a Playwright summary through `tail` | RTC `CLAUDE.md` |

## Keep, as optional plugins

| What | RTC source |
|---|---|
| Visual goldens: scenario matrix, golden sets, update runbook | test strategy §9.7, `UPDATING-GOLDENS.md` |
| Rendering performance: compositor-only animation rules, motion audit | `docs/performance.md`, `/rtc:perf-audit` |

## Keep the door open, drop the implementation

RTC has a second UI framework (SolidJS) and two alternative application
cores. Those implementations stay behind. The cheap rules that made them
possible come along.

| Door | Rule that keeps it open |
|---|---|
| Second UI framework | The dumb-UI gates, no JSX or framework types through the ViewModel, and specs that talk only to page objects |
| Second application core | A types-only contract package (gate 42, `core-api-stays-inner`) and the stream library confined to a bridge (`bridge-owns-rxjs`) |
| Any other swap | The replaceability matrix as a living document: component, cost to replace, contract, verifying test |

## Drop

Specific to RTC and not carried over:

- The Solid, alternative-core, Effect, devtools and agent-tools rules (about 20
  of the 40 dependency-cruiser rules).
- Grep gates 19–22 and 34–46.
- The contract swap-trio and the seven-suite e2e stack.
- The Dockview and design-prototype tooling.

## Before any skill is written

Run a baseline: three neutral tasks in an empty directory with no skill
loaded, recording which of the rules above the model breaks unprompted.

1. Add a live-updating list fed by a WebSocket.
2. Add a second data source behind the same UI.
3. Add a test for a behaviour that happens after a delay.

Rules the model already follows are cut from the skills. They may still ship
as enforcement templates, since a gate costs no context.
