import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decodePng, PngError } from "../files/tools/visual/lib/png.mts";
import { BLACK, createFlatPng, createPng, type Rgba, WHITE } from "./support/createPng.mts";

describe("decodePng", () => {
  it.each([0, 1, 2, 3, 4] as const)("reads back every pixel of a PNG written with row filter %i", (filter) => {
    const image = decodePng(createPng(7, 6, paintNoise, { filter }));

    expect([image.width, image.height]).toEqual([7, 6]);
    expect(readPixels(image.data, 7, 6)).toEqual(paintAll(7, 6));
  });

  it("gives an image without an alpha channel full opacity", () => {
    const image = decodePng(createPng(3, 2, paintNoise, { rgb: true, filter: 4 }));

    expect(image.data).toHaveLength(3 * 2 * 4);
    expect(readPixels(image.data, 3, 2)).toEqual(paintAll(3, 2).map(([red, green, blue]) => [red, green, blue, 255]));
  });

  it("reads a screenshot Playwright wrote", () => {
    const image = decodePng(readFileSync(GOLDEN));

    expect(image.width).toBeGreaterThan(100);
    expect(image.data).toHaveLength(image.width * image.height * 4);
    // The frame's top-left corner is page background.
    expect([...image.data.subarray(0, 4)]).toEqual([...WHITE]);
    // The heading is black text, so the image is not one flat colour.
    expect(new Set(image.data).size).toBeGreaterThan(2);
  });

  it("refuses a file that is not a PNG", () => {
    const refused = (): unknown => decodePng(Buffer.from("<html>not an image</html>"));

    expect(refused).toThrow(PngError);
    expect(refused).toThrow(/not a PNG file/);
  });

  it("refuses a kind of PNG it cannot read, by name", () => {
    expect(() => decodePng(createFlatPng(2, 2, BLACK, { bitDepth: 16 }))).toThrow(/bit depth 16/);
    expect(() => decodePng(createFlatPng(2, 2, BLACK, { interlace: 1 }))).toThrow(/interlace 1/);
  });
});

const GOLDEN = fileURLToPath(
  new URL("../files/packages/client-react/tests/visual/goldens/darwin-arm64/empty.png", import.meta.url),
);

/**
 * Colours with no pattern from one pixel to the next, so each row filter has to
 * use every one of its neighbours (left, up, up-left) somewhere in the image.
 */
function paintNoise(x: number, y: number): Rgba {
  const mix = (seed: number): number => ((x * 73 + y * 151 + seed) * 2654435761) % 256;

  return [mix(1), mix(2), mix(3), mix(4)];
}

function paintAll(width: number, height: number): number[][] {
  return Array.from({ length: width * height }, (_, index) => [...paintNoise(index % width, Math.floor(index / width))]);
}

function readPixels(data: Uint8Array, width: number, height: number): number[][] {
  return Array.from({ length: width * height }, (_, index) => [...data.subarray(index * 4, index * 4 + 4)]);
}
