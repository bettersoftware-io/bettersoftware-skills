import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { judgeNoise, measureNoise, type Measurement } from "../files/tools/visual/lib/measure.mts";
import { BLACK, createFlatPng, createPng, type Rgba, WHITE } from "./support/createPng.mts";

describe("measureNoise", () => {
  it("finds no noise in captures that are the same", () => {
    const captures = [createCapture({ "a.png": createFlatPng(10, 10, WHITE) }), createCapture({ "a.png": createFlatPng(10, 10, WHITE) })];

    expect(measureNoise(captures, 0.2).images).toEqual([
      { image: "a.png", different: 0, total: 0, largestColourMove: 0, sizeChanged: false, ratio: 0 },
    ]);
  });

  it("keeps the worst difference of any two captures, per image", () => {
    const captures = [
      createCapture({ "a.png": createFlatPng(10, 10, WHITE) }),
      createCapture({ "a.png": createBlockPng(2) }),
      createCapture({ "a.png": createBlockPng(5) }),
    ];

    const [noise] = measureNoise(captures, 0.2).images;

    // White against a 5-row block is the largest of the three pairs.
    expect(noise).toMatchObject({ image: "a.png", different: 50, total: 100, ratio: 0.5 });
  });

  it("counts with the threshold it is given, like the tier does", () => {
    const captures = [
      createCapture({ "a.png": createFlatPng(10, 10, [200, 200, 200, 255]) }),
      createCapture({ "a.png": createFlatPng(10, 10, [210, 210, 210, 255]) }),
    ];

    expect(measureNoise(captures, 0.2).images[0]?.different).toBe(0);
    expect(measureNoise(captures, 0.01).images[0]?.different).toBe(100);
  });

  it("lists an image that is missing from one capture as not compared", () => {
    const captures = [
      createCapture({ "a.png": createFlatPng(4, 4, WHITE), "nested/b.png": createFlatPng(4, 4, WHITE) }),
      createCapture({ "a.png": createFlatPng(4, 4, WHITE) }),
    ];

    const measurement = measureNoise(captures, 0.2);

    expect(measurement.images.map((noise) => noise.image)).toEqual(["a.png"]);
    expect(measurement.incomplete).toEqual(["nested/b.png"]);
  });
});

describe("judgeNoise", () => {
  const strict = { maxDiffPixelRatio: 0, threshold: 0.01 };

  it("passes when no pixel differed", () => {
    const verdict = judgeNoise(createMeasurement({ different: 0, total: 0, largestColourMove: 0 }), strict);

    expect(verdict.exitCode).toBe(0);
    expect(verdict.lines.join("\n")).toContain("PASS: no pixel differed");
  });

  it("passes when the noise is below both knobs, and reports the two floors", () => {
    const verdict = judgeNoise(createMeasurement({ different: 3, total: 1000, largestColourMove: 0.004 }), { maxDiffPixelRatio: 0.01, threshold: 0.01 });

    expect(verdict.exitCode).toBe(0);
    expect(verdict.lines).toContain("Noise floor for maxDiffPixelRatio: 0.003000 (set: 0.01)");
    expect(verdict.lines).toContain("Noise floor for threshold:         0.0040 (set: 0.01)");
  });

  it("fails when the same commit differs from itself by more than the tolerance allows", () => {
    const verdict = judgeNoise(createMeasurement({ different: 3, total: 1000, largestColourMove: 0.3 }), strict);

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines.join("\n")).toContain("the tier can fail with no change to the UI");
  });

  it("fails when an image changed size between captures, whatever the tolerance", () => {
    const verdict = judgeNoise(createMeasurement({ different: 16, total: 16, largestColourMove: 1, sizeChanged: true }), { maxDiffPixelRatio: 1, threshold: 1 });

    expect(verdict.exitCode).toBe(1);
    expect(verdict.lines.join("\n")).toContain("came out at two sizes");
  });

  it("gives no verdict on fewer than two captures, even with an image to show", () => {
    const verdict = judgeNoise({ ...createMeasurement({ different: 0, total: 0, largestColourMove: 0 }), captures: 1 }, strict);

    expect(verdict.exitCode).toBe(2);
    expect(verdict.lines.join("\n")).toContain("at least two are needed");
  });

  it("gives no verdict when the captures share no image", () => {
    const verdict = judgeNoise({ captures: 2, images: [], incomplete: ["a.png"] }, strict);

    expect(verdict.exitCode).toBe(2);
    expect(verdict.lines.join("\n")).toContain("nothing was compared");
  });

  it("gives no verdict when an image is missing from a capture, even if the rest matched", () => {
    const measurement = { ...createMeasurement({ different: 0, total: 0, largestColourMove: 0 }), incomplete: ["b.png"] };
    const verdict = judgeNoise(measurement, strict);

    expect(verdict.exitCode).toBe(2);
    expect(verdict.lines.join("\n")).toContain("b.png is not in every capture");
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A folder of images, as one run of the tier leaves it. */
function createCapture(images: Record<string, Buffer>): string {
  const directory = mkdtempSync(join(tmpdir(), "visual-capture-"));

  scratch.push(directory);

  for (const [name, bytes] of Object.entries(images)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), bytes);
  }

  return directory;
}

/** White, 10 by 10, with the top `rows` rows black. */
function createBlockPng(rows: number): Buffer {
  return createPng(10, 10, (_x, y): Rgba => (y < rows ? BLACK : WHITE));
}

function createMeasurement(noise: { different: number; total: number; largestColourMove: number; sizeChanged?: boolean }): Measurement {
  return {
    captures: 2,
    images: [{ image: "a.png", sizeChanged: false, ...noise, ratio: noise.total === 0 ? 0 : noise.different / noise.total }],
    incomplete: [],
  };
}
