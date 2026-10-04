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
// What was measured (2026-10-04, darwin-arm64, Chromium 1243 headless): the
// same commit captured 5 times, every capture compared with every other, 4
// scenarios. Every image was byte-identical: the noise floor is 0 for both
// knobs on that machine.
//
//   maxDiffPixelRatio 0   No pixel may count. The floor is 0, so anything
//                         above 0 would only hide real changes.
//   threshold 0.01        Above the floor of 0 by the smallest useful step. It
//                         ignores a colour moving by 1 or 2 of 255 on every
//                         channel, which a different processor's rounding can
//                         produce, and counts a move of 3. Checked: #1a8f4c to
//                         #1d924f (+3) fails, #1c914e (+2) passes.
//
// NOT measured: linux-x64 in CI. Once that set exists, run the update workflow
// a few times on one commit, download the artifacts and run
// `pnpm visual:jitter <dirA> <dirB> ...`. If CI's floor is above these
// numbers, raise them to just above it and write the measurement here.
//
// Before changing either number, run `pnpm visual:jitter`. Do not raise a
// number to make one failing test pass: look at the difference first.
export const TOLERANCE = {
  maxDiffPixelRatio: 0,
  threshold: 0.01,
} as const;
