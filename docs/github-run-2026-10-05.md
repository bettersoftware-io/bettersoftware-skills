# The add-ons' workflows on GitHub, 2026-10-05

Until this run every workflow an add-on puts in a project had only been
written and read. This is the first time they ran where they are meant to run.

## Setup

- A project created with `scripts/create-project.mts` (scope `@skills-demo`),
  then `add-to-project.mts` for `coverage`, `visual` and `performance`, from
  this repository at `a971f6d`. Nothing edited by hand.
- `pnpm gate:full` passed locally before the first push.
- Pushed to a new public repository,
  [bettersoftware-io/skills-demo](https://github.com/bettersoftware-io/skills-demo).

## First push (`ec53ee8`)

| Workflow | Result |
|---|---|
| `CI` (the starter's own: `pnpm gate:full`) | pass |
| `Coverage` | pass; the publish job created `gh-pages` and pushed the report with `GITHUB_TOKEN` |
| `Motion audit` | pass, as a skip: no animation was alive, the same verdict as locally |
| `Visual goldens` | **fail, as designed**: `No golden for the scenario "empty" on linux-x64`, with the path it expected |

## The Linux goldens and CI's noise

`Update visual goldens` was dispatched five times on that one commit (runs
37276517754, 37276520467, 37276523680, 37276526875, 37276530038). Each uploaded
four images.

- `pnpm visual:jitter` over the five sets: every image identical in every
  capture, noise floor 0 for both knobs.
- By checksum the five copies of each image are the same file.

So the per-pixel threshold went from 0.01 to 0. Checked locally at 0: the
starter's "up" colour moved by 1 of 255 on each channel (`#1a8f4c` to
`#1b904d`) fails with 82 pixels; unchanged, 5 of 5 pass.

The set is now shipped in the add-on, beside the macOS one.

## Second push (`96a52fc`: the Linux set and the threshold)

| Workflow | Result |
|---|---|
| `CI` | pass |
| `Coverage` | pass |
| `Motion audit` | pass (skip) |
| `Visual goldens` | pass |

## The coverage report on Pages

The branch alone serves nothing. Pages was switched on for the repository
(deploy from `gh-pages`, root), by the API:

```bash
gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=gh-pages" -f "source[path]=/"
```

After that <https://bettersoftware-io.github.io/skills-demo/coverage/> answered
200, and its index page named the commit that built it (`96a52fc`).

## Not covered

- A pull-request run of any of the four.
- A `Coverage` run where the gate fails (the report is meant to publish then
  too).
- A motion audit with an animation in the page, so the compositing verdicts of
  Chromium in the CI image.
- More than five captures, or a runner image other than the one GitHub served
  that day.
