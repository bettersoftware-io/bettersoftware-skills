// The one place the visual tier's tolerance is set. The Playwright config and
// `pnpm visual:jitter` both read it from here.
//
// There are two knobs, and they hide different things:
//
//   threshold           how far ONE pixel's colour may move before that pixel
//                       counts as different (0 = any move counts, 1 = nothing
//                       ever does). It is applied first.
//   maxDiffPixelRatio   what share of the image's pixels may count as
//                       different before the test fails.
//
// A zero pixel budget is not strict by itself. Playwright's default threshold
// is 0.2, and at 0.2 a pixel can change a great deal and not count. Measured on
// the starter's price list: the "up" colour changed from green (#1a8f4c) to
// blue (#1a4c8f) counts 0 pixels at 0.2 and 83 at 0.01. Set both on purpose.
//
// What was measured: the same commit captured 5 times, every capture compared
// with every other, 4 scenarios.
//
//   2026-10-04  darwin-arm64, Chromium 1243 headless, one Mac
//   2026-10-05  linux-x64, five runs of the update workflow on GitHub's
//               runners, in the pinned Playwright container
//
// Every image was byte-identical in both. The noise floor is 0 for both knobs,
// so both are 0: anything above the floor would only hide real changes.
//
//   maxDiffPixelRatio 0   No pixel may count.
//   threshold 0           Any colour move counts. Checked: the "up" colour
//                         moved by 1 of 255 on each channel (#1a8f4c to
//                         #1b904d) fails with 82 pixels.
//
// If a machine nobody measured draws a pixel differently, a test will fail
// with nothing changed. Do not raise a number to make it pass. Measure first:
// capture one commit several times (`pnpm visual:jitter --runs 5` on your
// machine; for CI, several runs of the update workflow, then
// `pnpm visual:jitter <dirA> <dirB> ...`), set each number just above the
// floor it reports, and write the measurement here.
export const TOLERANCE = {
  maxDiffPixelRatio: 0,
  threshold: 0,
} as const;
