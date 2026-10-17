import assert from "node:assert/strict";
import { test } from "node:test";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { compareImages, loadImage, prepareImage, readImageInfo, targetSize } from "../dist/index.mjs";

const solidRgba = (w, h, [r, g, b, a]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return data;
};


test("targetSize keeps small images and fits large ones", () => {
  assert.equal(targetSize(375, 812), null);
  assert.deepEqual(targetSize(1568, 100), null);
  assert.deepEqual(targetSize(3000, 100), { width: 1568, height: 52 });
  // Tall screenshot: the 1.15 MP budget binds before the 1568 px side limit does.
  const tall = targetSize(1500, 3248);
  assert.ok(tall.height <= 1568 && tall.width * tall.height <= 1_150_000, JSON.stringify(tall));
  assert.ok(Math.abs(tall.width / tall.height - 1500 / 3248) < 0.01);
  // maxDimension can't exceed the API limit.
  assert.deepEqual(targetSize(4000, 10, { maxDimension: 3000 }), { width: 1568, height: 3 });
  assert.deepEqual(targetSize(1000, 1000, { maxPixels: 250_000 }), { width: 500, height: 500 });
});

test("PNG is downscaled and stays PNG with the same colors", async () => {
  const png = encodePng({ width: 2000, height: 40, data: solidRgba(2000, 40, [10, 200, 30, 255]), channels: 4, depth: 8 });
  const out = prepareImage(await loadImage(png));
  assert.equal(out.resized, true);
  assert.deepEqual(readImageInfo(out.bytes), { format: "png", width: 1568, height: 31 });
  const { decode } = await import("fast-png");
  const decoded = decode(out.bytes);
  assert.equal(decoded.channels, 3, "opaque images drop the alpha channel");
  assert.deepEqual([...decoded.data.slice(0, 3)], [10, 200, 30]);
});

test("transparent PNG keeps alpha without darkening colors", async () => {
  // Alternate opaque red and fully transparent black columns.
  const w = 2000, h = 4, data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(i % 2 ? [0, 0, 0, 0] : [255, 0, 0, 255], i * 4);
  const out = prepareImage(await loadImage(encodePng({ width: w, height: h, data, channels: 4, depth: 8 })), { maxDimension: 1000 });
  const { decode } = await import("fast-png");
  const px = decode(out.bytes).data.slice(0, 4);
  assert.deepEqual([...px], [255, 0, 0, 128], "premultiplied averaging keeps pure red at half alpha");
});

test("grayscale and 16-bit PNGs are decoded", async () => {
  const gray = encodePng({ width: 2000, height: 2, data: new Uint8Array(4000).fill(100), channels: 1, depth: 8 });
  const deep = encodePng({ width: 2000, height: 2, data: new Uint16Array(2000 * 2 * 3).fill(65535), channels: 3, depth: 16 });
  const { decode } = await import("fast-png");
  assert.deepEqual([...decode(prepareImage(await loadImage(gray)).bytes).data.slice(0, 3)], [100, 100, 100]);
  assert.deepEqual([...decode(prepareImage(await loadImage(deep)).bytes).data.slice(0, 3)], [255, 255, 255]);
});

test("JPEG is downscaled and stays JPEG", async () => {
  const jpg = jpeg.encode({ width: 2400, height: 60, data: solidRgba(2400, 60, [200, 100, 50, 255]) }, 95).data;
  const out = prepareImage(await loadImage(jpg));
  assert.deepEqual(readImageInfo(out.bytes), { format: "jpeg", width: 1568, height: 39 });
  const px = jpeg.decode(out.bytes, { useTArray: true }).data.slice(0, 3);
  for (const [got, want] of [...px].map((v, i) => [v, [200, 100, 50][i]])) assert.ok(Math.abs(got - want) <= 4, `${got} vs ${want}`);
});

test("compareImages sends downscaled images but reports boxes in original pixels", async () => {
  const big = encodePng({ width: 3000, height: 2000, data: solidRgba(3000, 2000, [255, 255, 255, 255]), channels: 4, depth: 8 });
  const sent = [];
  const client = {
    systemOne(request) {
      sent.push(...request.state.assets.map((a) => readImageInfo(a.data)));
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([n, q]) =>
          q.type === "score" ? [n, { type: "score", score: 5, confidence: 1 }]
          : q.type === "noul" ? [n, { type: "noul", noul: n === "exists_0" ? 0.9 : 0.1 }]
          : q.type === "choice" ? [n, { type: "choice", choice: n.startsWith("type") ? "moved" : "button", confidence: 1 }]
          : [n, { type: "box", box: { top: 0.5, bottom: 1, left: 0.5, right: 1 }, confidence: 1 }],
        ),
      );
      return Promise.resolve({ model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } });
    },
  };
  const r = await compareImages(big, big, { client, refine: false });
  assert.ok(sent.every((s) => Math.max(s.width, s.height) <= 1568 && s.width * s.height <= 1_150_000), JSON.stringify(sent[0]));
  assert.equal(r.images.candidate.resized, true);
  assert.equal(r.images.candidate.width, 3000);
  assert.ok(r.images.candidate.sentWidth < 3000);
  assert.deepEqual(r.differences[0].boxPx, { x: 1500, y: 1000, width: 1500, height: 1000 });

  sent.length = 0;
  const raw = await compareImages(big, big, { client, refine: false, resize: false });
  assert.equal(raw.images.candidate.resized, false);
  assert.ok(sent.every((s) => s.width === 3000), "resize: false sends the original");
});
