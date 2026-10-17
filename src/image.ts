import { readFile } from "node:fs/promises";

/**
 * An image to compare: a file path, a `data:` URL, `{ base64 }`, raw bytes, or a `Blob`.
 * Only PNG and JPEG are supported.
 */
export type ImageInput = string | Uint8Array | ArrayBuffer | Blob | { base64: string };

export type ImageFormat = "png" | "jpeg";

/** Image bytes with their detected format and pixel size. */
export interface LoadedImage {
  readonly bytes: Uint8Array;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

export class ImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFormatError";
  }
}

/** Read an `ImageInput` into bytes and detect its format and dimensions. */
export async function loadImage(input: ImageInput): Promise<LoadedImage> {
  const bytes = await toBytes(input);
  return { bytes, ...readImageInfo(bytes) };
}

async function toBytes(input: ImageInput): Promise<Uint8Array> {
  if (typeof input === "string") {
    if (input.startsWith("data:")) {
      const comma = input.indexOf(",");
      if (comma < 0 || !input.slice(0, comma).endsWith(";base64")) {
        throw new ImageFormatError("Only base64 data URLs are supported");
      }
      return Buffer.from(input.slice(comma + 1), "base64");
    }
    return new Uint8Array(await readFile(input));
  }
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input && typeof (input as { base64?: unknown }).base64 === "string") {
    return Buffer.from((input as { base64: string }).base64, "base64");
  }
  throw new ImageFormatError("Unsupported image input");
}

/** Detect PNG/JPEG and read the pixel size from the file header. */
export function readImageInfo(bytes: Uint8Array): {
  format: ImageFormat;
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 8-byte signature, then the IHDR chunk holds width and height.
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: walk the segments until a start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1]!;
      // Fill bytes and standalone markers carry no length.
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { format: "jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
    throw new ImageFormatError("Could not read JPEG dimensions");
  }

  throw new ImageFormatError("Unsupported image format: only PNG and JPEG are supported");
}
