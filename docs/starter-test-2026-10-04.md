# Building features in the starter, 2026-10-04

The [baseline run](baseline-2026-10-04.md) showed what an agent builds in an
empty folder. This is the same kind of work in a project created from the
starter, with the hooks on and no implement skill.

## Setup

- A project created with `scripts/create-project.mts` (scope `@desk`), with
  dependencies installed.
- Headless Claude Code (`claude -p`), Claude Fable 5.1, one fresh session per
  task, allowed to edit files and run `pnpm` and `node`.
- The project's own instruction file and hooks were active. No skill from this
  repository was installed. The user's usual plugins were loaded.
- Each prompt described the feature and said nothing about architecture.

### The prompts

1. Add trade history to the app: below the price list, show the five most
   recent trades, newest first, each with its symbol, side (buy or sell),
   quantity, price and time. Trades come from the server over the same
   WebSocket as prices, and the app must also work with no server.
2. Add a flash to the price list: when a symbol's price changes, its row
   flashes for 300 ms in the direction of the move (up or down), then returns
   to normal. A second change during a flash restarts the 300 ms. Implement it
   and add tests.

## Results

| | Trade history | Price flash |
|---|---|---|
| Skills loaded | None | None |
| Times a hook blocked | 0 | 0 |
| Full gate on the result | Pass, 67 tests | Pass, 76 tests |
| Independent review with `reviewing-architecture` | PASS, seven of seven OK | PASS, seven of seven OK |
| Time and cost | 7 min, $2.40 | 2.5 min, $1.16 |

The trade-history run added a port in the domain in domain terms, a contract
test, a simulator and a WebSocket adapter that both run the contract, a use
case, a presenter, a view-model hook, a dumb component and a UI test through a
page object. It also made the two adapters share one socket, with a test.

The flash run put the 300 ms timer in the presenter beside the stale timer,
gave the component only a `data-flash` attribute, tested the boundary at 299 ms
and 300 ms on fake timers, and extended the page object so the test file still
never touches the testing library.

None of the structural mistakes from the baseline run recurred.

## Do the hooks run in headless mode?

Yes. A separate session was asked to write one file with a timer in the UI
folder and to do nothing else. The stop hook reported the red gate. On its
second attempt to stop the session was let through, and it reported that the
gate was red, that the finding was correct, and that fixing it was outside what
it had been asked to do. It did not work around the gate.

In the two feature runs the hooks were active and never needed to block.

## What the reviews found outside the seven questions

- Two clients on the same server saw different prices and trades, because the
  server subscribed each connection to the simulator separately. The price half
  came from the starter and is fixed there: connections now share one feed.
- The trade simulator runs its own random walk, so a trade's price need not
  match the price list.
- The wire parser accepts any number as a timestamp; an out-of-range one would
  crash the trade table.
- The contract tests check less than the port's comment promises.
- A price feed faster than 300 ms would keep a row tinted continuously.

## What this decides

- **No implement skill is written yet.** The method is to write guidance only
  for a failure that was observed, and with the starter, its instruction file
  and the gates in place, none was. A skill will be written when a task goes
  wrong in a way the gates do not catch, for that failure.
- **The review skill passed its clean-code test.** It had only been run on code
  where every question was a finding. On these two features it reported seven
  OKs each, with evidence, and no false finding.
- One wording problem surfaced: question 1 could be read as forbidding an
  adapter from importing a shared transport type. It now names the case it
  means, an adapter taking a port's types from another adapter.

## Limits

- One run per task, one model, small features. An indication, not proof.
- Both tasks had a close example to copy. A feature with no analogue in the
  starter (authentication, persistence, routing) is a harder test.
- Not run on Codex or on a smaller model.
