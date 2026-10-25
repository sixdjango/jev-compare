import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { BadRequestError } from "@typesafe-ai/sdk";
import { decode, encode } from "fast-png";
import { annotateDifferences, combineScore, compareImages, extentScore, ImageFormatError, iou, readImageInfo, toPixels } from "../dist/index.mjs";

const ref = new URL("./original_img.png", import.meta.url).pathname;
const cand = new URL("./test_img1.png", import.meta.url).pathname;

/** A stand-in client that answers every question from `answer(name, question)`. */
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    systemOne(request) {
      calls.push(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([n, q]) => [n, answer(n, q)]));
      return Promise.resolve({ model: "fake", answers, usage: { input_tokens: 10, output_tokens: 2 } });
    },
  };
}

function defaultAnswer(name, q) {
  if (name === "extent") return { type: "score", score: 2, confidence: 0.6 }; // "1–5%"
  if (q.type === "score") return { type: "score", score: 6.5, confidence: 0.4 };
  if (q.type === "noul") {
    if (name === "identical") return { type: "noul", noul: 0.02 };
    if (name === "exists_0" || name === "exists_1") return { type: "noul", noul: 0.9 };
    if (name === "exists_2") return { type: "noul", noul: 0.85 }; // duplicate of #0, dropped
    if (name === "aspect_element_missing") return { type: "noul", noul: 0.95 };
    return { type: "noul", noul: 0.1 };
  }
  if (q.type === "choice") {
    const label = name.startsWith("type") ? "element_missing" : "button";
    return { type: "choice", choice: label, confidence: 0.7 };
  }
  const i = Number(name.split("_")[1]);
  const box = i === 1 ? { top: 0.3, bottom: 0.4, left: 0.1, right: 0.9 } : { top: 0.9, bottom: 0.96, left: 0.07, right: 0.94 };
  return { type: "box", box, confidence: 0.6 };
}

test("readImageInfo reads PNG size", async () => {
  assert.deepEqual(readImageInfo(await readFile(ref)), { format: "png", width: 375, height: 812 });
});

test("readImageInfo reads JPEG size", () => {
  // SOI, APP0 (length 4), SOF0 with height 0x0102 and width 0x0304.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x03, 0x04, 0x03, 0, 0, 0]);
  assert.deepEqual(readImageInfo(jpeg), { format: "jpeg", width: 0x0304, height: 0x0102 });
});

test("readImageInfo rejects other formats", () => {
  assert.throws(() => readImageInfo(new TextEncoder().encode("GIF89a.........")), ImageFormatError);
});

test("box helpers", () => {
  const a = { top: 0, bottom: 0.5, left: 0, right: 0.5 };
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, { top: 0.5, bottom: 1, left: 0.5, right: 1 }), 0);
  assert.deepEqual(toPixels({ top: 0.1, bottom: 0.2, left: 0.25, right: 0.75 }, { width: 400, height: 1000 }), {
    x: 100,
    y: 100,
    width: 200,
    height: 100,
  });
});

test("compareImages maps answers to a result", async () => {
  const client = fakeClient(defaultAnswer);
  const result = await compareImages(ref, cand, { client, refine: false });

  assert.equal(client.calls.length, 2, "overview + one chunk of 4 differences");
  assert.equal(client.calls[0].model, "jev-preview");
  // holistic 6.5 + 1 = 7.5, extent bucket 2 = 9.0; mean 8.25, then * 0.98 + 10 * 0.02.
  assert.equal(result.score, 8.3);
  assert.deepEqual(result.scoreBreakdown, { holistic: 7.5, extent: 9, identicalProbability: 0.02 });
  assert.equal(result.identical, false);
  assert.equal(result.differences.length, 2, "the overlapping third difference is dropped");
  const [first, second] = result.differences;
  assert.equal(first.rank, 1);
  assert.equal(first.type, "element_missing");
  assert.equal(first.typeLabel, "元素缺失");
  assert.match(first.suggestion, /按钮/);
  assert.deepEqual(first.boxPx, { x: 26, y: 731, width: 327, height: 49 });
  assert.equal(second.rank, 2);
  assert.deepEqual(result.issues.map((i) => i.type), ["element_missing"]);
  assert.deepEqual(result.images.candidate, { width: 375, height: 812, format: "png", sentWidth: 375, sentHeight: 812, resized: false });
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
  assert.match(result.summary, /2 处差异/);
});

test("compareImages splits many differences across requests and supports English", async () => {
  const client = fakeClient(defaultAnswer);
  const result = await compareImages(ref, cand, { client, maxDifferences: 6, locale: "en", refine: false });
  assert.equal(client.calls.length, 3);
  assert.ok(Object.keys(client.calls[2].questions).includes("exists_5"));
  assert.equal(result.differences[0].typeLabel, "Missing element");
  assert.match(result.summary, /^Similarity/);
});

test("identical images score 10", async () => {
  const client = fakeClient((name, q) =>
    q.type === "noul" && name === "identical" ? { type: "noul", noul: 1 } : q.type === "noul" ? { type: "noul", noul: 0.05 } : defaultAnswer(name, q),
  );
  const result = await compareImages(ref, ref, { client });
  assert.equal(result.score, 10);
  assert.equal(result.identical, true);
  assert.equal(result.differences.length, 0);
});

test("annotateDifferences draws numbered boxes", async () => {
  const result = await compareImages(ref, cand, { client: fakeClient(defaultAnswer), refine: false });
  const svg = await annotateDifferences(cand, result);
  assert.match(svg, /^<svg[^>]+width="375" height="812"/);
  assert.equal(svg.match(/<rect /g).length, 2);
  assert.match(svg, /data:image\/png;base64,/);
});

const isRefine = (request) => "refbox" in request.questions;

test("refine reclassifies each difference and widens its boxes", async () => {
  const client = fakeClient((name, q) => {
    if (name === "type") return { type: "choice", choice: "content_missing", confidence: 0.95 };
    if (name === "element") return { type: "choice", choice: "container", confidence: 0.8 };
    if (name === "box" || name === "refbox") return { type: "box", box: { top: 0.28, bottom: 0.45, left: 0.05, right: 0.95 }, confidence: 0.7 };
    return defaultAnswer(name, q);
  });
  const result = await compareImages(ref, cand, { client });
  assert.equal(client.calls.filter(isRefine).length, 2, "one refine request per difference");
  const [first, second] = result.differences;
  assert.equal(second.type, "content_missing");
  assert.equal(second.elementLabel, "卡片/容器");
  assert.match(second.suggestion, /^卡片\/容器还在，但其中的文字、图标等内容缺失/);
  assert.deepEqual(second.box, { top: 0.28, bottom: 0.45, left: 0.05, right: 0.95 });
  // The first difference sits at 0.9–0.96; the widened box doesn't cover it, so it keeps its own box.
  assert.deepEqual(first.box, { top: 0.9, bottom: 0.96, left: 0.07, right: 0.94 });
});

test("refine rejects a widened box that swallows another difference", async () => {
  const client = fakeClient((name, q) => {
    if (name === "box" || name === "refbox") return { type: "box", box: { top: 0.3, bottom: 0.97, left: 0.05, right: 0.95 }, confidence: 0.5 };
    return defaultAnswer(name, q);
  });
  const result = await compareImages(ref, cand, { client });
  assert.deepEqual(result.differences[1].box, { top: 0.3, bottom: 0.4, left: 0.1, right: 0.9 }, "falls back to the first-pass box");
});

test("a request over the token limit is split in half and retried", async () => {
  const inner = fakeClient(defaultAnswer);
  const client = {
    systemOne(request) {
      const count = Object.keys(request.questions).filter((n) => n.startsWith("exists_")).length;
      if (count > 2) return Promise.reject(new BadRequestError(400, { detail: { error_type: "max_tokens_exceeded" } }, new Headers()));
      return inner.systemOne(request);
    },
  };
  const result = await compareImages(ref, cand, { client, refine: false });
  const asked = inner.calls.map((c) => Object.keys(c.questions).filter((n) => n.startsWith("exists_")).length);
  assert.deepEqual(asked.sort(), [0, 2, 2]);
  assert.equal(result.differences.length, 2);
});

/** `original_img.png` with the "Change Logo" button moved 30px left, its old place filled with the card's white. */
async function movedButton() {
  const png = decode(await readFile(ref));
  const { width, channels } = png;
  const data = new Uint8Array(png.data);
  const at = (x, y) => (y * width + x) * channels;
  const white = png.data.slice(at(220, 625), at(220, 625) + channels);
  for (let y = 607; y < 645; y++) for (let x = 230; x < 340; x++) data.set(white, at(x, y));
  for (let y = 607; y < 645; y++) for (let x = 230; x < 340; x++) data.set(png.data.subarray(at(x, y), at(x, y) + channels), at(x - 30, y));
  return encode({ width, height: png.height, data, channels, depth: 8 });
}

test("a moved element is recognized by matching pixels, with how far it moved", async () => {
  // The model sees the gap and calls it a color change, with boxes on the button's new place.
  const client = fakeClient((name, q) => {
    if (q.type === "choice") return { type: "choice", choice: name.startsWith("type") ? "color_changed" : "button", confidence: 0.3 };
    if (name === "exists_0") return { type: "noul", noul: 0.8 };
    if (name.startsWith("exists_")) return { type: "noul", noul: 0.1 };
    if (q.type === "box") return { type: "box", box: { top: 0.74, bottom: 0.795, left: 0.52, right: 0.92 }, confidence: 0.6 };
    return defaultAnswer(name, q);
  });
  const result = await compareImages(ref, await movedButton(), { client, locale: "en" });
  assert.equal(result.differences.length, 1);
  const [d] = result.differences;
  assert.equal(d.type, "moved");
  assert.deepEqual(d.shift, { x: -30, y: 0 });
  assert.equal(d.referenceBoxPx.x - d.boxPx.x, 30, "the reference box is where the button was");
  assert.match(d.suggestion, /30px too far left/);
});

test("missing content is not mistaken for a moved element", async () => {
  // test_img1 lost the description text and the button label; nothing in it moved.
  const client = fakeClient(defaultAnswer);
  const result = await compareImages(ref, cand, { client, refine: false });
  assert.ok(result.differences.every((d) => d.type !== "moved" && d.shift === null));
});

test("invalid options are rejected", async () => {
  const client = fakeClient(defaultAnswer);
  await assert.rejects(compareImages(ref, cand, { client, threshold: 2 }), RangeError);
  await assert.rejects(compareImages(ref, cand, { client, maxDifferences: 20 }), RangeError);
  await assert.rejects(compareImages(ref, cand, { client, locale: "fr" }), TypeError);
});

test("suggestions read naturally when the element is itself text", async () => {
  const client = fakeClient((name, q) =>
    q.type === "choice" ? { type: "choice", choice: name.startsWith("type") ? "content_missing" : "text", confidence: 0.9 } : defaultAnswer(name, q),
  );
  const zh = await compareImages(ref, cand, { client, refine: false });
  assert.match(zh.differences[0].suggestion, /^参考图中这里的文字在当前图中缺失/);
  assert.doesNotMatch(zh.differences[0].suggestion, /文字内的内容/);
  const en = await compareImages(ref, cand, { client, refine: false, locale: "en" });
  assert.match(en.differences[0].suggestion, /^The text shown here in the reference is missing/);
});

test("extentScore interpolates between the bucket scores", () => {
  assert.equal(extentScore(0), 10);
  assert.equal(extentScore(1), 9.6);
  assert.equal(extentScore(2), 9);
  assert.equal(extentScore(2.5), 8.5);
  assert.equal(extentScore(5), 1);
  assert.equal(extentScore(-1), 10, "clamped");
  assert.equal(extentScore(9), 1, "clamped");
});

test("combineScore averages the judgments and honors 'identical'", () => {
  assert.equal(combineScore({ holistic: 8, extent: 9, identicalProbability: 0 }), 8.5);
  assert.equal(combineScore({ holistic: 9.8, extent: 9.9, identicalProbability: 0.85 }), 10);
  assert.equal(combineScore({ holistic: 1, extent: 1, identicalProbability: 0 }), 1);
  // Same layout but every color changed: the holistic rubric alone would stay mid-range.
  assert.ok(combineScore({ holistic: 5.1, extent: 1.8, identicalProbability: 0.01 }) < 4);
});
