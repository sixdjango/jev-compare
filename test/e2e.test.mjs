// Calls the real TypeSafe API. Needs JEV_KEY (read from .env by `npm run test:e2e`).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { decode, encode } from "fast-png";
import { compareImages } from "../dist/index.mjs";

const file = (name) => new URL(`./${name}`, import.meta.url).pathname;
const skip = !process.env.JEV_KEY && !process.env.TYPESAFE_API_KEY && "no API key";
const overlaps = (box, top, bottom) => box.top < bottom && box.bottom > top;

test("identical images", { skip }, async () => {
  const r = await compareImages(file("original_img.png"), file("original_img.png"));
  assert.ok(r.score >= 9.5, `score ${r.score}`);
  assert.equal(r.differences.length, 0);
});

test("test_img1: missing button text and description card", { skip }, async () => {
  const r = await compareImages(file("original_img.png"), file("test_img1.png"));
  assert.ok(r.score < 9.5 && r.score > 5, `score ${r.score}`);
  const button = r.differences.find((d) => overlaps(d.box, 0.88, 0.97));
  assert.ok(button, "finds the bottom button");
  assert.equal(button.type, "content_missing", "the button is there but its label is gone");
  assert.ok(r.differences.some((d) => overlaps(d.box, 0.31, 0.49)), "finds the description card");
});

test("test_img2: missing description card background", { skip }, async () => {
  const r = await compareImages(file("original_img.png"), file("test_img2.png"));
  assert.ok(r.score < 9.5 && r.score > 5, `score ${r.score}`);
  assert.ok(overlaps(r.differences[0].box, 0.31, 0.49), "locates the description card");
  assert.equal(r.differences[0].type, "background_missing");
});

test("test_img3: missing description text", { skip }, async () => {
  const r = await compareImages(file("original_img.png"), file("test_img3.png"));
  assert.ok(r.score < 9.5 && r.score > 5, `score ${r.score}`);
  assert.ok(overlaps(r.differences[0].box, 0.31, 0.49), "locates the description");
  assert.ok(["content_missing", "element_missing"].includes(r.differences[0].type), r.differences[0].type);
});

/** Nearest-neighbor upscale of a test PNG, to make an image over the API's size limit. */
async function upscaled(name, factor) {
  const png = decode(await readFile(file(name)));
  const { width, height, channels } = png;
  const data = new Uint8Array(width * factor * height * factor * channels);
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < width * factor; x++) {
      const from = (Math.floor(y / factor) * width + Math.floor(x / factor)) * channels;
      data.set(png.data.subarray(from, from + channels), (y * width * factor + x) * channels);
    }
  }
  return encode({ width: width * factor, height: height * factor, data, channels, depth: 8 });
}

test("images over the API size limit are downscaled before upload", { skip }, async () => {
  const [ref, cand] = await Promise.all([upscaled("original_img.png", 2), upscaled("test_img1.png", 2)]);
  // 750 × 1624: the API rejects this size ("Invalid image dimensions") unless it is downscaled.
  await assert.rejects(compareImages(ref, cand, { resize: false, maxDifferences: 0 }), /Invalid image dimensions/);
  const r = await compareImages(ref, cand);
  assert.equal(r.images.candidate.resized, true);
  assert.equal(r.images.candidate.height, 1624);
  const button = r.differences.find((d) => overlaps(d.box, 0.88, 0.97));
  assert.ok(button, "finds the bottom button");
  assert.ok(button.boxPx.y > 1400, `pixel box is in original coordinates: ${JSON.stringify(button.boxPx)}`);
});

test("a button moved 30px left is reported as moved", { skip }, async () => {
  const png = decode(await readFile(file("original_img.png")));
  const { width, channels } = png;
  const data = new Uint8Array(png.data);
  const at = (x, y) => (y * width + x) * channels;
  const white = png.data.slice(at(220, 625), at(220, 625) + channels);
  for (let y = 607; y < 645; y++) for (let x = 230; x < 340; x++) data.set(white, at(x, y));
  for (let y = 607; y < 645; y++) for (let x = 230; x < 340; x++) data.set(png.data.subarray(at(x, y), at(x, y) + channels), at(x - 30, y));
  const r = await compareImages(file("original_img.png"), encode({ width, height: png.height, data, channels, depth: 8 }));
  const moved = r.differences.find((d) => d.type === "moved");
  assert.ok(moved, JSON.stringify(r.differences.map((d) => d.type)));
  assert.deepEqual(moved.shift, { x: -30, y: 0 });
});

test("a repeated comparison is served from the cache", { skip }, async () => {
  const { memoryCache } = await import("../dist/index.mjs");
  const cache = memoryCache();
  const first = await compareImages(file("original_img.png"), file("test_img2.png"), { cache });
  const second = await compareImages(file("original_img.png"), file("test_img2.png"), { cache, locale: "en" });
  assert.equal(second.requests.cached, second.requests.total);
  assert.equal(second.usage.inputTokens, 0);
  assert.equal(second.score, first.score);
  assert.deepEqual(second.differences.map((d) => d.box), first.differences.map((d) => d.box));
});
