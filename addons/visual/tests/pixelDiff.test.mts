import { describe, expect, it } from "vitest";

import { comparePixels } from "../files/tools/visual/lib/pixelDiff.mts";
import { decodePng, type Image } from "../files/tools/visual/lib/png.mts";
import { BLACK, createPng, type Rgba, WHITE } from "./support/createPng.mts";

describe("comparePixels", () => {
  it("finds nothing between an image and itself", () => {
    const image = createImage(8, 8, () => WHITE);

    expect(comparePixels(image, image, 0.2)).toEqual({ different: 0, total: 64, largestColourMove: 0, sizeChanged: false });
  });

  it("counts the pixels of a block that changed colour", () => {
    const before = createImage(10, 10, () => WHITE);
    const after = createImage(10, 10, (x, y) => (x >= 2 && x < 6 && y >= 2 && y < 5 ? BLACK : WHITE));

    expect(comparePixels(before, after, 0.2).different).toBe(12);
  });

  it("does not count a colour move below the threshold, but reports how large it was", () => {
    const before = createImage(10, 10, () => [200, 200, 200, 255]);
    const after = createImage(10, 10, () => [210, 210, 210, 255]);

    const atDefault = comparePixels(before, after, 0.2);

    expect(atDefault.different).toBe(0);
    // A grey moved by 10 of 255 is hidden by any threshold above about 0.038.
    expect(atDefault.largestColourMove).toBeCloseTo(0.0379, 3);
    expect(comparePixels(before, after, 0.03).different).toBe(100);
    expect(comparePixels(before, after, 0.04).different).toBe(0);
  });

  it("does not count a pixel on a smoothed edge", () => {
    // Black on the left, white on the right, one column of grey between them.
    // Only the shade of that in-between column differs.
    const before = createImage(5, 5, (x) => paintEdge(x, 128));
    const after = createImage(5, 5, (x) => paintEdge(x, 60));

    const difference = comparePixels(before, after, 0.1);

    expect(difference.largestColourMove).toBeGreaterThan(0.1);
    expect(difference.different).toBe(0);
  });

  it("treats a change of size as a change of every pixel, never as noise", () => {
    const difference = comparePixels(createImage(4, 4, () => WHITE), createImage(4, 5, () => WHITE), 0.2);

    expect(difference).toEqual({ different: 16, total: 16, largestColourMove: 1, sizeChanged: true });
  });
});

function createImage(width: number, height: number, paint: (x: number, y: number) => Rgba): Image {
  return decodePng(createPng(width, height, paint));
}

function paintEdge(x: number, between: number): Rgba {
  if (x < 2) {
    return BLACK;
  }

  return x === 2 ? [between, between, between, 255] : WHITE;
}
