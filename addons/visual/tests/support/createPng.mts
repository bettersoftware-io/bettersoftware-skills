// Builds PNG files for the tests, with Node built-ins only. It is written
// separately from the decoder under test, so a mistake in one does not hide in
// the other.

import { crc32, deflateSync } from "node:zlib";

export type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

export interface PngOptions {
  /** PNG row filter 0 to 4, used for every row. Default 0 (none). */
  filter?: 0 | 1 | 2 | 3 | 4;
  /** Write three channels and no alpha. Default false. */
  rgb?: boolean;
  bitDepth?: number;
  interlace?: number;
}

export const WHITE: Rgba = [255, 255, 255, 255];
export const BLACK: Rgba = [0, 0, 0, 255];

export function createPng(width: number, height: number, paint: (x: number, y: number) => Rgba, options: PngOptions = {}): Buffer {
  const { filter = 0, rgb = false, bitDepth = 8, interlace = 0 } = options;
  const channels = rgb ? 3 : 4;
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(paint(x, y).slice(0, channels), y * stride + x * channels);
    }
  }

  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;

    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (pixels[y * stride + index - channels] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + index] as number) : 0;
      const upLeft = index >= channels && y > 0 ? (pixels[(y - 1) * stride + index - channels] as number) : 0;

      raw[y * (stride + 1) + 1 + index] = ((pixels[y * stride + index] as number) - predicted(filter, left, up, upLeft)) & 0xff;
    }
  }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(bitDepth, 8);
  header.writeUInt8(rgb ? 2 : 6, 9);
  header.writeUInt8(interlace, 12);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createChunk("IHDR", header),
    createChunk("IDAT", deflateSync(raw)),
    createChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One flat colour. */
export function createFlatPng(width: number, height: number, colour: Rgba, options?: PngOptions): Buffer {
  return createPng(width, height, () => colour, options);
}

function createChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);

  length.writeUInt32BE(body.length, 0);
  checksum.writeUInt32BE(crc32(typed), 0);

  return Buffer.concat([length, typed, checksum]);
}

function predicted(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 1) {
    return left;
  }

  if (filter === 2) {
    return up;
  }

  if (filter === 3) {
    return Math.floor((left + up) / 2);
  }

  if (filter === 4) {
    const estimate = left + up - upLeft;
    const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
    const nearest = Math.min(...distances);

    return nearest === distances[0] ? left : nearest === distances[1] ? up : upLeft;
  }

  return 0;
}
