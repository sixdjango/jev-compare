import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import type { LoadedImage } from "./image.ts";

/** Longest side, in pixels, the TypeSafe API accepts; larger images are rejected. */
export const API_MAX_DIMENSION = 1568;

/** How images are downscaled before upload. */
export interface ResizeOptions {
  /** Longest side in pixels, at most 1568 (the API's limit). Default: 1568. */
  maxDimension?: number;
  /** Most pixels (width × height) to send; fewer pixels use fewer tokens. Default: 1,150,000. */
  maxPixels?: number;
  /** JPEG quality, 1–100, when a JPEG is re-encoded. Default: 90. */
  quality?: number;
}

/** Image bytes ready to upload, with the size actually sent. */
export interface PreparedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly resized: boolean;
}

const DEFAULT_MAX_PIXELS = 1_150_000;

/** The size to send an image at, keeping its aspect ratio, or `null` when it already fits. */
export function targetSize(
  width: number,
  height: number,
  options: ResizeOptions = {},
): { width: number; height: number } | null {
  const maxDimension = Math.min(API_MAX_DIMENSION, options.maxDimension ?? API_MAX_DIMENSION);
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const scale = Math.min(1, maxDimension / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  if (scale >= 1) return null;
  // The epsilon keeps float error from flooring an exact fit, such as 3000 × (1568 / 3000), to 1567.
  const fit = (side: number) => Math.max(1, Math.min(maxDimension, Math.floor(side * scale + 1e-9)));
  return { width: fit(width), height: fit(height) };
}

/** Downscale `img` to fit `options`, re-encoding it in its own format; small images pass through. */
export function prepareImage(img: LoadedImage, options: ResizeOptions = {}): PreparedImage {
  const size = targetSize(img.width, img.height, options);
  if (!size) return { bytes: img.bytes, width: img.width, height: img.height, resized: false };

  const rgba = img.format === "png" ? decodePngToRgba(img.bytes) : decodeJpegToRgba(img.bytes);
  const scaled = resizeRgba(rgba, img.width, img.height, size.width, size.height);
  const bytes =
    img.format === "png"
      ? encodePngFromRgba(scaled, size.width, size.height)
      : new Uint8Array(jpeg.encode({ data: scaled, width: size.width, height: size.height }, options.quality ?? 90).data);
  return { bytes, width: size.width, height: size.height, resized: true };
}

/**
 * Area-averaging downscale of RGBA pixels: each output pixel is the coverage-weighted mean of
 * the source pixels under it, which keeps thin lines and text legible. Colors are averaged
 * with premultiplied alpha so transparent pixels don't darken edges.
 */
export function resizeRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const premultiplied = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = src[i * 4 + 3]! / 255;
    premultiplied[i * 4] = src[i * 4]! * a;
    premultiplied[i * 4 + 1] = src[i * 4 + 1]! * a;
    premultiplied[i * 4 + 2] = src[i * 4 + 2]! * a;
    premultiplied[i * 4 + 3] = src[i * 4 + 3]!;
  }

  // Horizontal pass: sw × sh → dw × sh.
  const xWeights = coverage(sw, dw);
  const horizontal = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const out = (y * dw + x) * 4;
      for (const [sx, w] of xWeights[x]!) {
        const inp = (y * sw + sx) * 4;
        for (let c = 0; c < 4; c++) horizontal[out + c]! += premultiplied[inp + c]! * w;
      }
    }
  }

  // Vertical pass: dw × sh → dw × dh, then undo the premultiplication.
  const yWeights = coverage(sh, dh);
  const dst = new Uint8Array(dw * dh * 4);
  const px = new Float32Array(4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      px.fill(0);
      for (const [sy, w] of yWeights[y]!) {
        const inp = (sy * dw + x) * 4;
        for (let c = 0; c < 4; c++) px[c]! += horizontal[inp + c]! * w;
      }
      const out = (y * dw + x) * 4;
      const a = px[3]!;
      const unpremultiply = a > 0 ? 255 / a : 0;
      dst[out] = px[0]! * unpremultiply + 0.5;
      dst[out + 1] = px[1]! * unpremultiply + 0.5;
      dst[out + 2] = px[2]! * unpremultiply + 0.5;
      dst[out + 3] = a + 0.5;
    }
  }
  return dst;
}

/** For each output index, the source indices it covers and their normalized weights. */
function coverage(srcLength: number, dstLength: number): Array<Array<[number, number]>> {
  const scale = srcLength / dstLength;
  const result: Array<Array<[number, number]>> = [];
  for (let d = 0; d < dstLength; d++) {
    const start = d * scale;
    const end = Math.min(srcLength, start + scale);
    const weights: Array<[number, number]> = [];
    for (let s = Math.floor(start); s < end; s++) {
      const w = Math.min(end, s + 1) - Math.max(start, s);
      if (w > 0) weights.push([s, w / scale]);
    }
    result.push(weights);
  }
  return result;
}

function decodeJpegToRgba(bytes: Uint8Array): Uint8Array {
  return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true }).data;
}

/** Decode any PNG (palette, grayscale, 1–16 bit, with or without alpha) to 8-bit RGBA. */
export function decodePngToRgba(bytes: Uint8Array): Uint8Array {
  const png = decodePng(bytes);
  const { width, height } = png;
  let data: ArrayLike<number> = png.data;
  let channels = png.channels;
  let depth: number = png.depth;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    channels = png.palette[0]!.length;
    depth = 8;
  }

  const max = 2 ** depth - 1;
  const rowSamples = width * channels;
  // Bit depths below 8 pack several samples into each byte, with each row padded to a byte.
  const rowBytes = depth < 8 ? Math.ceil((rowSamples * depth) / 8) : rowSamples;
  const sample = (row: number, i: number): number => {
    if (depth >= 8) return data[row * rowSamples + i]!;
    const bit = i * depth;
    const byte = data[row * rowBytes + (bit >> 3)]!;
    return (byte >> (8 - depth - (bit & 7))) & max;
  };

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      const v = (i: number) => Math.round((sample(y, s + i) * 255) / max);
      if (channels >= 3) {
        out[o] = v(0);
        out[o + 1] = v(1);
        out[o + 2] = v(2);
        out[o + 3] = channels === 4 ? v(3) : 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = v(0);
        out[o + 3] = channels === 2 ? v(1) : 255;
      }
    }
  }
  return out;
}

/** Encode RGBA pixels as PNG, dropping the alpha channel when every pixel is opaque. */
function encodePngFromRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (!opaque) return encodePng({ width, height, data: rgba, channels: 4, depth: 8 });
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]!;
    rgb[j + 1] = rgba[i + 1]!;
    rgb[j + 2] = rgba[i + 2]!;
  }
  return encodePng({ width, height, data: rgb, channels: 3, depth: 8 });
}
