# Testing the review skill, 2026-10-04

`skills/reviewing-architecture` was written after watching reviews without it,
then run against the same code. The code is the
[baseline run](baseline-2026-10-04.md), unchanged.

## Setup

- Headless Claude Code (`claude -p`), Claude Fable 5.1, one fresh session per
  run, started in a copy of the baseline code with no instruction file.
- The same prompt every time, which names no skill and no rule:

  > Review this project's architecture and its tests. Report the problems you
  > find, most important first, each with the file and line and what you would
  > change. Do not modify any files.

- Without the skill: the code only. With the skill: the code, the kit under
  `tools/arch`, a layer declaration, and the skill as a project skill.

## Without the skill (2 runs)

Both runs produced a careful robustness review and nearly the same list: a bad
socket can crash the server, an unknown message freezes the page, no heartbeat,
slow clients lose ticks, the server and the reconnect logic are untested, the
backoff has no jitter.

On architecture, both found two things: wiring at module scope in the root
component, and the unshared stream.

## With the skill (4 runs)

The skill loaded by itself in all four runs. All four reports had the required
shape, pasted the gate output, and answered all seven questions.

| Finding | Without (2 runs) | With (4 runs) |
|---|---|---|
| Wiring at module scope | 2 | 4 |
| Unshared stream | 2 | 4 |
| The contract is declared in an adapter's file | 0 | 4 |
| The contract is the wire message plus socket events | 0 | 4 |
| The simulator fakes transport messages to fit | 0 | 4 |
| Business values computed in components | 0 | 4 |
| No contract test run against both sources | 0 | 4 |
| UI test asserts on markup with a pattern | 0 | 4 |
| Fixture factory with a bare-noun name | 0 | 4 |

The robustness findings were not lost: all four runs reported them under
"Other".

## What the first two runs got wrong, and the fix

Both ran `pnpm -r test` to check the tests. pnpm installed the dependencies as
a side effect, in a review that was told to modify nothing. One run disclosed
it; the other reported the test result without comment.

The skill now says that a review installs nothing, and that without installed
dependencies lint, typecheck and tests are "not run". In the two runs after
that change nothing was installed, and both reported those checks as not run,
with the reason.

## What this does not show

- **No clean case.** All seven questions were findings on this code. The skill
  has not been run against code that follows the rules, so its rate of false
  findings is unknown.
- **Whole project only.** It has not been run on a diff or a pull request.
- **Few competing skills.** It was the only project skill present. The user's
  installed plugins were loaded, but a project with many skills of its own is a
  harder test of whether it loads.
- **One model, one harness.** Not run on Codex or on a smaller model.
- **The hand-off rule is untested.** No run reviewed code written in the same
  conversation.
