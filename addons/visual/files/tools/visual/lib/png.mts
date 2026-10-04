// Reads a PNG into RGBA pixels with Node built-ins only, so the jitter
// measurement needs no image library installed.
//
// It reads what a browser screenshot is: 8 bits per channel, RGB or RGBA, not
// interlaced. Anything else is refused by name, never guessed at.

import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** Four bytes per pixel: red, green, blue, alpha. */
  data: Uint8Array;
}

export class PngError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOUR_TYPE_RGB = 2;
const COLOUR_TYPE_RGBA = 6;

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

export function decodePng(bytes: Buffer): Image {
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new PngError("not a PNG file (the first eight bytes are not the PNG signature)");
  }

  const { header, compressed } = readChunks(bytes);

  if (header.bitDepth !== 8 || header.interlace !== 0) {
    throw new PngError(
      `only 8-bit, non-interlaced PNGs are read (this one: bit depth ${header.bitDepth}, interlace ${header.interlace})`,
    );
  }

  if (header.colourType !== COLOUR_TYPE_RGB && header.colourType !== COLOUR_TYPE_RGBA) {
    throw new PngError(`only RGB and RGBA PNGs are read (this one has colour type ${header.colourType})`);
  }

  const channels = header.colourType === COLOUR_TYPE_RGBA ? 4 : 3;
  const scanlines = undoFilters(inflateSync(compressed), header.width, header.height, channels);

  return { width: header.width, height: header.height, data: toRgba(scanlines, header.width * header.height, channels) };
}

function readChunks(bytes: Buffer): { header: Header; compressed: Buffer } {
  let header: Header | undefined;
  const data: Buffer[] = [];

  for (let offset = SIGNATURE.length; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body.readUInt8(8),
        colourType: body.readUInt8(9),
        interlace: body.readUInt8(12),
      };
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }

    // Length, type and checksum are four bytes each.
    offset += 12 + length;
  }

  if (header === undefined || data.length === 0) {
    throw new PngError("the PNG has no header or no image data");
  }

  return { header, compressed: Buffer.concat(data) };
}

/** Each row is stored as a filter byte and the row's bytes as differences. This undoes that. */
function undoFilters(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;

  if (raw.length !== height * (stride + 1)) {
    throw new PngError(`the image data is ${raw.length} bytes, expected ${height * (stride + 1)} for ${width}x${height}`);
  }

  const pixels = new Uint8Array(height * stride);

  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] as number;
    const source = row * (stride + 1) + 1;
    const target = row * stride;

    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? (pixels[target + index - channels] as number) : 0;
      const up = row > 0 ? (pixels[target - stride + index] as number) : 0;
      const upLeft = index >= channels && row > 0 ? (pixels[target - stride + index - channels] as number) : 0;

      pixels[target + index] = ((raw[source + index] as number) + predict(filter, left, up, upLeft)) & 0xff;
    }
  }

  return pixels;
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new PngError(`unknown row filter ${filter}`);
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);

  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }

  return toUp <= toUpLeft ? up : upLeft;
}

function toRgba(pixels: Uint8Array, count: number, channels: number): Uint8Array {
  if (channels === 4) {
    return pixels;
  }

  const rgba = new Uint8Array(count * 4);

  for (let pixel = 0; pixel < count; pixel += 1) {
    rgba[pixel * 4] = pixels[pixel * 3] as number;
    rgba[pixel * 4 + 1] = pixels[pixel * 3 + 1] as number;
    rgba[pixel * 4 + 2] = pixels[pixel * 3 + 2] as number;
    rgba[pixel * 4 + 3] = 255;
  }

  return rgba;
}
