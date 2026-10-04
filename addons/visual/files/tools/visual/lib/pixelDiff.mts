// Counts the pixels that differ between two images the way Playwright's
// `toHaveScreenshot` does, so a noise measurement and the test agree.
//
// The trap this avoids: counting every pixel that differs at all. Playwright
// first drops any pixel whose colour moved less than `threshold`, and any pixel
// that is only anti-aliasing. A soft shadow that shifts by one shade on every
// pixel is "100% different" by a naive count and exactly zero by Playwright's.
// A budget chosen from the naive count is chosen from the wrong number.
//
// The arithmetic is pixelmatch's (ISC licence, Mapbox), which is the comparator
// Playwright ships. It was checked against the copy inside playwright-core
// 1.63.0; if Playwright changes its comparator, this file has to follow.

import type { Image } from "./png.mts";

export interface PixelDifference {
  /** Pixels that count as different: colour moved more than the threshold, and not anti-aliasing. */
  different: number;
  total: number;
  /**
   * The largest colour move of any pixel, written as the `threshold` that would
   * just hide it (0 to 1). A threshold below this lets that pixel be counted.
   */
  largestColourMove: number;
  /** The two images have different dimensions. That is a layout change, never noise. */
  sizeChanged: boolean;
}

/** The largest value the colour-distance formula below can produce. */
const MAX_COLOUR_DISTANCE = 35215;

export function comparePixels(first: Image, second: Image, threshold: number): PixelDifference {
  const total = first.width * first.height;

  if (first.width !== second.width || first.height !== second.height) {
    return { different: total, total, largestColourMove: 1, sizeChanged: true };
  }

  const { width, height } = first;
  const limit = MAX_COLOUR_DISTANCE * threshold * threshold;
  let different = 0;
  let largest = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const distance = Math.abs(colourDistance(first.data, second.data, at, at, false));

      if (distance > largest) {
        largest = distance;
      }

      if (distance > limit && !isAntiAliasing(first, second, x, y) && !isAntiAliasing(second, first, x, y)) {
        different += 1;
      }
    }
  }

  return { different, total, largestColourMove: Math.sqrt(largest / MAX_COLOUR_DISTANCE), sizeChanged: false };
}

/**
 * True when the pixel sits on a smoothed edge: among its eight neighbours there
 * is a darker and a brighter one, and one of those is in a flat area of both
 * images. Such a pixel moves with sub-pixel rendering and says nothing about
 * the page.
 */
function isAntiAliasing(image: Image, other: Image, x1: number, y1: number): boolean {
  const { width, height, data } = image;
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const at = (y1 * width + x1) * 4;
  let equal = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let darkest = 0;
  let brightest = 0;
  let darkestX = 0;
  let darkestY = 0;
  let brightestX = 0;
  let brightestY = 0;

  for (let x = x0; x <= x2; x += 1) {
    for (let y = y0; y <= y2; y += 1) {
      if (x === x1 && y === y1) {
        continue;
      }

      const brightness = colourDistance(data, data, at, (y * width + x) * 4, true);

      if (brightness === 0) {
        equal += 1;

        // More than two equal neighbours: a flat area, not an edge.
        if (equal > 2) {
          return false;
        }
      } else if (brightness < darkest) {
        darkest = brightness;
        darkestX = x;
        darkestY = y;
      } else if (brightness > brightest) {
        brightest = brightness;
        brightestX = x;
        brightestY = y;
      }
    }
  }

  if (darkest === 0 || brightest === 0) {
    return false;
  }

  return (
    (hasEqualNeighbours(image, darkestX, darkestY) && hasEqualNeighbours(other, darkestX, darkestY)) ||
    (hasEqualNeighbours(image, brightestX, brightestY) && hasEqualNeighbours(other, brightestX, brightestY))
  );
}

/** True when at least three of the pixel's neighbours have exactly its colour. */
function hasEqualNeighbours({ width, height, data }: Image, x1: number, y1: number): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const at = (y1 * width + x1) * 4;
  let equal = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

  for (let x = x0; x <= x2; x += 1) {
    for (let y = y0; y <= y2; y += 1) {
      if (x === x1 && y === y1) {
        continue;
      }

      const neighbour = (y * width + x) * 4;

      if (
        data[at] === data[neighbour] &&
        data[at + 1] === data[neighbour + 1] &&
        data[at + 2] === data[neighbour + 2] &&
        data[at + 3] === data[neighbour + 3]
      ) {
        equal += 1;
      }

      if (equal > 2) {
        return true;
      }
    }
  }

  return false;
}

/**
 * How far apart two pixels are to the eye, in YIQ colour space. With
 * `brightnessOnly` it is the signed difference in brightness alone. Otherwise
 * it is the squared distance, negative when the second pixel is darker.
 */
function colourDistance(first: Uint8Array, second: Uint8Array, k: number, m: number, brightnessOnly: boolean): number {
  let r1 = first[k] as number;
  let g1 = first[k + 1] as number;
  let b1 = first[k + 2] as number;
  let a1 = first[k + 3] as number;
  let r2 = second[m] as number;
  let g2 = second[m + 1] as number;
  let b2 = second[m + 2] as number;
  let a2 = second[m + 3] as number;

  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) {
    return 0;
  }

  if (a1 < 255) {
    a1 /= 255;
    r1 = blendWithWhite(r1, a1);
    g1 = blendWithWhite(g1, a1);
    b1 = blendWithWhite(b1, a1);
  }

  if (a2 < 255) {
    a2 /= 255;
    r2 = blendWithWhite(r2, a2);
    g2 = blendWithWhite(g2, a2);
    b2 = blendWithWhite(b2, a2);
  }

  const y1 = r1 * 0.29889531 + g1 * 0.58662247 + b1 * 0.11448223;
  const y2 = r2 * 0.29889531 + g2 * 0.58662247 + b2 * 0.11448223;
  const y = y1 - y2;

  if (brightnessOnly) {
    return y;
  }

  const i = r1 * 0.59597799 - g1 * 0.2741761 - b1 * 0.32180189 - (r2 * 0.59597799 - g2 * 0.2741761 - b2 * 0.32180189);
  const q = r1 * 0.21147017 - g1 * 0.52261711 + b1 * 0.31114694 - (r2 * 0.21147017 - g2 * 0.52261711 + b2 * 0.31114694);
  const distance = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;

  return y1 > y2 ? -distance : distance;
}

function blendWithWhite(channel: number, alpha: number): number {
  return 255 + (channel - 255) * alpha;
}
