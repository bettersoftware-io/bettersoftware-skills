# A feature built by a smaller model, 2026-10-05

Every earlier run used a frontier model. This asks what the project's checks
carry when the model is the smallest one: Claude Haiku 4.5.

The result is a draft pull request, kept as a record:
[bettersoftware-io/skills-demo#3](https://github.com/bettersoftware-io/skills-demo/pull/3).

## Setup

- The demo project after [the REST feature](demo-feature-2026-10-05.md), with
  the integration package and the kit's `agent-docs` gate in.
- One fresh headless Claude Code session (`claude -p`,
  `claude-haiku-4-5-20251001`), with the project's `AGENTS.md` and hooks, and
  no skill from this repository.
- The prompt described the feature and said nothing about architecture or
  about which checks to run.

### The prompt

> Add a way to deactivate a user.
>
> Each user is active or inactive. A new user is active. In the user list,
> each row has a button that deactivates an active user or reactivates an
> inactive one. An inactive user's row is shown greyed, with the word
> "Inactive" beside the name.
>
> A checkbox above the list, "Show inactive users", is on to begin with. When
> it is off, inactive users are hidden. It works together with the choice
> that narrows the list to one category.
>
> A category that still has users cannot be deleted, whether they are active
> or not.
>
> Whether a user is active is kept on the server like the rest of the user,
> and the app must still work with no server.
>
> Implement it with tests. Do not commit.

## First session: 7.5 minutes, 122 turns, $2.81

| Check | Result |
|---|---|
| `pnpm gate:fast` (architecture gates, lint, typecheck) | pass |
| Tests | 256 pass |
| `pnpm gate:full` | **fail**: five files under the per-file coverage bar |
| `pnpm visual` | **fail**: the screen changed, no golden was redrawn |
| Independent review with `reviewing-architecture` | **CHANGES NEEDED**: questions 6 (seams) and 7 (tests); 1 to 5 OK |
| Its own report | "All architectural gates pass", "comprehensive test cases" |

What held: every piece of code is in the right layer. The port is in the
domain, the wire format stays in the adapter, the filter is in the presenter,
the component only forwards.

What did not:

- **It stopped at the bar it was given.** It ran `gate:fast` 17 times and
  never `gate:full`. `AGENTS.md` says "Run `pnpm gate:fast` before you say
  work is finished", and the stop hook enforces that script. The frontier
  models ran `gate:full` unasked.
- **The new port method had no contract case**, and the adapter's fake server
  had no route for it, so the simulator and the real adapter were held to
  nothing in common. The `port-contracts` gate passed: it checks that an
  adapter runs its port's contract, not that the contract names each method.
- **Nothing tested the feature through the adapter, the route, the machine or
  the screen.** Only fixtures were updated. The coverage gate sees this, but
  only in `gate:full`.

The review also found design problems no check looks for: the toggle is not
idempotent (two people deactivating one user leave them active), the route's
suffix is written by hand on both sides, and the word "Inactive" sits inside
the row's header cell.

## Second session: told the full bar

A second fresh Haiku session got one instruction: "`pnpm gate:full` and
`pnpm visual` fail on this branch. Make both pass. Do not weaken, skip or
exclude anything from a check to get there."

| | |
|---|---|
| Time and cost | 6.5 minutes, 63 turns, $1.00 |
| `pnpm gate:full`, run again independently | pass |
| `pnpm visual` on darwin-arm64 | pass, after it redrew the seven goldens |
| Checks, configs, tolerances, exclusions edited | none |
| Added | the contract cases, the fake server's route, tests for the route, the machine, the wiring and the screen |
| Nine bugs planted afterwards | eight caught; the survivor is a button label that never changes |

Two of the eight were caught by the integration package, which had been added
the same day: the adapter asking the wrong route, and the server's route gone.

## What this says

- **The architecture checks carry a small model.** No misplaced code in either
  session, and no hook block was needed for layering.
- **A small model does what the project says, and no more.** Told `gate:fast`,
  it stopped at `gate:fast`. Told `gate:full`, it got there honestly, in less
  time than the feature took.
- **So the weak point is the bar, not the model's ability.** That was a
  decision about the stop hook and one line of `AGENTS.md`.
- **One gap was checkable and not checked:** a port method that its contract
  never calls.

Both were built the same day; the next section is the same prompt run again.

## After the changes: the same prompt again

The three decisions were built the same day: the stop hook runs `gate:full`
on any tree that has not already passed it, `port-contracts` requires a
contract to call every method of its port, and a `task-cache` gate reads
`turbo.json`. Then the same prompt was given to a fresh Haiku session on the
same starting point. The result is
[bettersoftware-io/skills-demo#6](https://github.com/bettersoftware-io/skills-demo/pull/6).

| | Before (hook on `gate:fast`) | After (hook on `gate:full`) |
|---|---|---|
| The model said "done" with `gate:full` red | yes | yes |
| What happened then | the session ended, reporting green | **the stop hook refused**, and the model went on fixing |
| How the first session ended | a false report | out of context after 172 turns ("Prompt is too long"), one UI test failing |
| Reaching `gate:full` green | a second session, told the bar in its prompt | a second session, told only "finish it" (3 minutes, $0.43) |
| Which gate the second session ran | `gate:full` | `gate:full` five times, `gate:fast` never |
| Checks or configs edited, either session | none | none |

On the way, the integration tests failed because the model had not yet built
the server route: the first time that package caught a real mistake in work
it was not written for.

What this shows, and what it does not:

- **The false report is gone.** The hook turned "done" into more work, and the
  session that could not finish ended in an error instead of a claim.
- **The smallest model cannot take this feature to the full bar in one
  session.** It needed a second one both times. Its context filled with the
  gate's output: it ran `gate:full` seventeen times.
- **The second session's handoff said what was left** (one failing UI test, no
  goldens redrawn), because the commit message of the first did. So this run
  does not show that the model would have redrawn the goldens unprompted. The
  hook does not run the visual tests.
- One run each way. It is a before and after, not a measurement.

## Found on the way: stale results from the task cache

The second session's last `gate:full` showed the integration tests as
"18 passed". Run directly, they were 20. Turbo had replayed an old result.

Packages in the starter export their TypeScript source, so a package's
typecheck and tests read the packages it imports. Turbo keyed each task on
that package's own files only. Shown in a scratch project: with an export
removed from the domain, which breaks every package that imports it,
`pnpm typecheck` still reported 7 of 7 successful, 6 from cache.

- CI was never wrong: it starts with an empty cache. Every merge in the demo
  was judged there.
- A developer's machine, and the stop hook, could be told "green" for code
  that does not compile.

Fixed in the starter and the demo with Turbo's own remedy (a `transit` task
that `typecheck` and `test` depend on), plus `tsconfig.base.json` as a global
dependency. `scripts/check-task-cache.mts` asks Turbo for each task's cache
key before and after an edit upstream and fails on any key that stays put:
12 task keys and 7 typecheck keys before the fix, none after. This
repository's CI now runs it on a created project.
