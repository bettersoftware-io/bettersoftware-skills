# The project in Codex, 2026-10-04

Everything before this was run in Claude Code. This is the same project in
Codex, to see whether the instruction file and the hooks work there.

## Setup

- A project created with `scripts/create-project.mts` (scope `@desk`), with
  dependencies installed and the untouched project committed.
- Codex CLI 0.160.0, `codex exec`, its default model, sandbox
  `workspace-write`.
- Hooks were run with `--dangerously-bypass-hook-trust`. In an interactive
  session a person trusts the project's hooks once with `/hooks`; a
  non-interactive run has nobody to ask.
- No plugin or skill from this repository was installed. Codex had the
  project's `AGENTS.md` and `.codex/hooks.json`, nothing else.

## Run 1: a feature, with nothing said about architecture

> Add a clock to the app: above the price list, show the current time as
> HH:MM:SS, updating every second. Implement it and add tests.

| | Result |
|---|---|
| Where the timer went | A presenter in the core (`clockPresenter.ts`), exposed through the view model. Its own words: "The app already centralizes timed behavior in client-core presenters" |
| Tests | Fake timers for the tick, a page-object assertion for the display |
| Ran the gate itself | Yes, `pnpm gate:fast`, as `AGENTS.md` asks |
| Times a hook blocked | 0: it broke no rule |
| `pnpm gate:full` afterwards, outside the sandbox | Pass, 41 tests |

One thing a review would raise: the presenter reads `new Date()` directly. A
clock is something from the outside world, so it should arrive through a port.
No gate checks that.

## Run 2: told to break a rule

The first run never tripped a hook, so the second was told to.

> In packages/client-react/src/ui/PriceList.tsx, inside the PriceList
> component, add a useEffect that starts a setInterval logging 'tick' to the
> console every second and clears it on unmount. Put it exactly there, in that
> file. Then tell me what happened, including anything a hook or check said.

1. Codex made the edit. The after-edit hook fired on it, and Codex quoted the
   gate's message: "A timer in the UI. Anything that happens after a delay is
   application behaviour: put it in a state machine or presenter in the core,
   where it can be tested on fake timers."
2. It reported, as asked, that the change was in the file and the finding was
   unresolved, and tried to finish.
3. The stop hook refused, because `gate:fast` was red. Codex went on: "The
   finding is valid under this project's rules: a UI component cannot own a
   timer." It moved the interval into the core presenter and ran
   `pnpm gate:fast`, which passed.

So both hooks work in Codex as they do in Claude Code: the first teaches at
the moment of the edit, the second does not let a red gate be the end.

## Found on the way

- **The server's tests cannot run inside Codex's sandbox.** They listen on a
  port, and `workspace-write` forbids it (`listen EPERM`). Codex ran the other
  packages' tests and said which it could not run. `pnpm gate:full` has to be
  run outside the sandbox, or in CI.

## Not checked

- **The plugin's skills in a Codex session.** Installing the plugin in Codex is
  checked ([how](plugin-test-2026-10-04.md)); a session that loads one of its
  skills is not. That needs the plugin installed in a real Codex setup.
- **Trusting the hooks interactively** with `/hooks`.
- One model, one run of each.
