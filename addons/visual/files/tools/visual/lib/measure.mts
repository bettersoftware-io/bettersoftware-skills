// The noise measurement: the same commit captured several times, every capture
// compared with every other, and the worst difference per image kept. That
// worst case is what the tier's tolerance has to sit above.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { comparePixels, type PixelDifference } from "./pixelDiff.mts";
import { decodePng } from "./png.mts";

/** The two knobs of the tier's tolerance, as `tolerance.ts` declares them. */
export interface Tolerance {
  maxDiffPixelRatio: number;
  threshold: number;
}

export interface ImageNoise extends PixelDifference {
  /** The image's path inside each capture, e.g. `row-stale.png`. */
  image: string;
  /** Share of the image's pixels that count as different, 0 to 1. */
  ratio: number;
}

export interface Measurement {
  captures: number;
  /** One entry per image found in every capture, with its worst pairwise difference. */
  images: ImageNoise[];
  /** Images found in some captures but not all. They could not be compared. */
  incomplete: string[];
}

export interface Verdict {
  /** 0: measured, and the tolerance sits above the noise. 1: it does not. 2: nothing could be measured. */
  exitCode: 0 | 1 | 2;
  lines: string[];
}

/** Every PNG under `directory`, keyed by its path from there. A missing folder holds none. */
export function listPngs(directory: string): Map<string, string> {
  const found = new Map<string, string>();

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".png")) {
        found.set(relative(directory, path).split(sep).join("/"), path);
      }
    }
  }

  if (existsSync(directory)) {
    walk(directory);
  }

  return found;
}

export function measureNoise(directories: string[], threshold: number): Measurement {
  const captures = directories.map(listPngs);
  const everyImage = [...new Set(captures.flatMap((capture) => [...capture.keys()]))].sort();
  const shared = everyImage.filter((image) => captures.every((capture) => capture.has(image)));

  return {
    captures: directories.length,
    images: shared.map((image) => worstDifference(image, captures, threshold)),
    incomplete: everyImage.filter((image) => !shared.includes(image)),
  };
}

function worstDifference(image: string, captures: Map<string, string>[], threshold: number): ImageNoise {
  const files = captures.map((capture) => readFileSync(capture.get(image) as string));
  let worst: PixelDifference = { different: 0, total: 0, largestColourMove: 0, sizeChanged: false };

  for (let first = 0; first < files.length; first += 1) {
    for (let second = first + 1; second < files.length; second += 1) {
      const one = files[first] as Buffer;
      const other = files[second] as Buffer;

      // Most captures of one commit are the same bytes, and need no decoding.
      if (one.equals(other)) {
        continue;
      }

      const difference = comparePixels(decodePng(one), decodePng(other), threshold);

      worst = {
        different: Math.max(worst.different, difference.different),
        total: Math.max(worst.total, difference.total),
        largestColourMove: Math.max(worst.largestColourMove, difference.largestColourMove),
        sizeChanged: worst.sizeChanged || difference.sizeChanged,
      };
    }
  }

  return { image, ...worst, ratio: worst.total === 0 ? 0 : worst.different / worst.total };
}

/**
 * Says whether the tolerance stands on the measurement. A measurement of
 * nothing is exit 2, never a pass.
 */
export function judgeNoise(measurement: Measurement, tolerance: Tolerance): Verdict {
  if (measurement.captures < 2) {
    return { exitCode: 2, lines: ["No measurement: noise is a difference between captures, so at least two are needed."] };
  }

  if (measurement.images.length === 0) {
    return { exitCode: 2, lines: ["No measurement: the captures have no image in common, so nothing was compared."] };
  }

  const lines = [
    `${measurement.captures} captures, ${measurement.images.length} image(s) compared at threshold ${tolerance.threshold}.`,
    "",
    ...measurement.images.map(describeImage),
    "",
  ];

  if (measurement.incomplete.length > 0) {
    return {
      exitCode: 2,
      lines: [
        ...lines,
        `No verdict: ${measurement.incomplete.join(", ")} is not in every capture, so it was not compared. A capture run failed part-way, or the captures are of different commits.`,
      ],
    };
  }

  const resized = measurement.images.filter((image) => image.sizeChanged);
  const worstRatio = Math.max(...measurement.images.map((image) => image.ratio));
  const largestMove = Math.max(...measurement.images.map((image) => image.largestColourMove));

  lines.push(
    `Noise floor for maxDiffPixelRatio: ${formatRatio(worstRatio)} (set: ${tolerance.maxDiffPixelRatio})`,
    `Noise floor for threshold:         ${formatThreshold(largestMove)} (set: ${tolerance.threshold})`,
    "",
  );

  if (resized.length > 0) {
    return {
      exitCode: 1,
      lines: [
        ...lines,
        `FAIL: ${resized.map((image) => image.image).join(", ")} came out at two sizes from one commit. That is not noise: the scenario is not deterministic. Pin what moves (a timer, an animation, a font that loads late) before trusting any tolerance.`,
      ],
    };
  }

  if (worstRatio > tolerance.maxDiffPixelRatio) {
    return {
      exitCode: 1,
      lines: [
        ...lines,
        "FAIL: the same commit differs from itself by more than the tolerance allows, so the tier can fail with no change to the UI.",
        "Look at the images that differ first. If one scenario moves, pin its frame; a tolerance cannot make it trustworthy.",
        "Only if the difference is rendering noise on every image, raise tolerance.ts to just above these floors and write this measurement beside it.",
      ],
    };
  }

  return {
    exitCode: 0,
    lines: [
      ...lines,
      worstRatio === 0 && largestMove === 0
        ? "PASS: no pixel differed between captures. The tolerance is not hiding any noise here; anything above zero is headroom for machines this run did not see."
        : "PASS: the tolerance sits above the measured noise.",
      "This is the floor on this machine only. CI's floor is measured from several runs of the update workflow on one commit.",
    ],
  };
}

function describeImage(noise: ImageNoise): string {
  if (noise.sizeChanged) {
    return `  ${noise.image}: size changed between captures`;
  }

  if (noise.largestColourMove === 0) {
    return `  ${noise.image}: identical in every capture`;
  }

  return `  ${noise.image}: ${noise.different} of ${noise.total} pixels differ (ratio ${formatRatio(noise.ratio)}); largest colour move ${formatThreshold(noise.largestColourMove)}`;
}

function formatRatio(ratio: number): string {
  return ratio === 0 ? "0" : ratio.toFixed(6);
}

function formatThreshold(move: number): string {
  return move === 0 ? "0" : move.toFixed(4);
}
