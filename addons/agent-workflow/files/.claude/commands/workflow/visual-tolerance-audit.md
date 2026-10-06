---
description: Measure how much the visual tier's screenshots differ when nothing changed, and judge the tolerance against that number
argument-hint: [number of captures, default 5] [--ci]
allowed-tools: Bash(pnpm:*), Bash(node:*), Bash(gh:*), Bash(git:*), Read
---

Measure the visual tier's noise floor and judge its tolerance. Arguments:
`$ARGUMENTS`. If that is empty, or still reads as a placeholder because this
host does not fill it in, take them from the request, and with none given
use 5 captures on this machine.

Run each step yourself. This file runs nothing by itself, and it changes no
file: it ends in a report.

## 0. This needs the visual add-on

```bash
node tools/agent-workflow/requires.mts visual
```

If it does not exit 0, report the line it printed and stop.

## What is measured, and why

The visual tier compares each screenshot with a committed golden and lets
some difference pass. That allowance is a budget for noise. It is right only
when it is above the real noise and below a real change, and a number chosen
by feel can be wrong both ways at once: too loose to see a layout that was
rebuilt, and sized for noise that is not there. A mostly empty screen makes
this worse, since even a large rearrangement repaints few pixels. So the
tolerance is set from a measurement, never from an estimate.

## 1. Find every tolerance before measuring anything

```bash
git grep -n -E "maxDiffPixelRatio|maxDiffPixels|threshold" -- "packages/*/tests/visual"
```

The add-on sets both knobs in one place,
`packages/client-react/tests/visual/tolerance.ts`. Anything else this finds
(a number in one scenario, a second config) is a tolerance too, and the
loosest one is the real gate. List each one with the reason written beside
it. A tolerance with no measurement beside it is a finding.

## 2. Measure on this machine

```bash
pnpm visual:jitter --runs 5
```

It captures the same commit several times and compares every capture with
every other, with the comparison the tier itself uses. Do not replace it with
a count of pixels that differ at all: a soft gradient differs everywhere by
an amount nobody can see, and reads as a large failure that is not one.

Exit 0: the tolerance sits above the noise. Exit 1: it does not. Exit 2:
nothing was measured; report that, and do not call it a pass.

## 3. Measure CI, when asked (`--ci`)

CI draws on other machines, so its noise is its own. This starts workflow
runs, so each command is a call of its own, and you say what you are about to
start before you start it.

```bash
gh workflow run "Update visual goldens" --ref <branch>
```

Run it once per capture, on one commit. That workflow commits nothing; each
run uploads its images. When every run has finished, download each into a
folder of its own, by absolute path:

```bash
gh run download <run id> --name visual-goldens-linux-x64 --dir /abs/path/run-1
pnpm visual:jitter /abs/path/run-1 /abs/path/run-2 /abs/path/run-3
```

Comparing the committed `linux-x64` goldens with one fresh capture is the
other use: it answers whether the goldens still show what the app draws.

## 4. Read the result

- **Every image identical.** The tier is deterministic. Both knobs can be 0,
  and anything above 0 only hides real changes.
- **A few small differences.** Real anti-aliasing at glyph edges. Set each
  knob just above the largest value measured.
- **One scenario far above the rest.** Suspect the scenario, not the
  tolerance. Open the images. If the pixels really differ, something on the
  page still moves: pin it in the host. No tolerance makes that scenario
  trustworthy.
- **Different sizes.** Never noise. That is a change in layout.

## 5. Report, and change nothing

Give the floor per knob, the current tolerance, and for the largest golden
how many pixels the current ratio lets through (ratio times width times
height): a ratio is loosest on the largest screen. Recommend, in this order:

1. Fix a scenario that is unstable.
2. Give one scenario its own tolerance, with its measurement beside it.
3. Lower the shared tolerance to just above the floor.
4. Add an assertion on structure for a layout that pixels cannot see.

Changing `tolerance.ts` is the user's decision. When they make it, the
measurement goes in the comment beside the numbers.

State the limits of what you measured: the number of captures is a sample,
not a proof; a zero on one machine says nothing about another; and which
machines CI used cannot be told apart beyond the runner's name.
