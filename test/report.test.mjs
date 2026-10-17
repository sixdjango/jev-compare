import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compareImages, listReports, loadReport, REPORT_SCHEMA_VERSION, saveReport } from "../dist/index.mjs";

const ref = new URL("./original_img.png", import.meta.url).pathname;
const cand = new URL("./test_img1.png", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "jev-compare-report-"));
after(() => rm(root, { recursive: true, force: true }));

const client = {
  systemOne(request) {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([n, q]) =>
        q.type === "score" ? [n, { type: "score", score: 6.5, confidence: 0.5 }]
        : q.type === "noul" ? [n, { type: "noul", noul: n === "exists_0" ? 0.9 : 0.1 }]
        : q.type === "choice" ? [n, { type: "choice", choice: n.startsWith("type") ? "content_missing" : "button", confidence: 0.9 }]
        : [n, { type: "box", box: { top: 0.89, bottom: 0.96, left: 0.07, right: 0.94 }, confidence: 0.8 }],
      ),
    );
    return Promise.resolve({ model: "fake", answers, usage: { input_tokens: 5, output_tokens: 1 } });
  },
};
const compare = (options = {}) => compareImages(ref, cand, { client, refine: false, ...options });

test("compareImages saves a complete report when asked", async () => {
  const dir = join(root, "auto");
  const result = await compare({ report: { dir, meta: { page: "add-project", build: 42 } } });
  assert.ok(result.report, "result says where the report went");
  assert.deepEqual((await readdir(result.report.dir)).sort(), ["candidate.png", "reference.png", "report.html", "report.json"]);
  assert.deepEqual(await readFile(result.report.files.candidate), await readFile(cand), "images are copied byte for byte");

  const stored = await loadReport(result.report.dir);
  assert.equal(stored.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(stored.id, result.report.id);
  assert.match(stored.id, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.equal(stored.tool.name, "jev-compare");
  assert.match(stored.tool.version, /^\d+\.\d+\.\d+/);
  assert.equal(stored.inputs.candidate.path, cand);
  assert.match(stored.inputs.candidate.sha256, /^[0-9a-f]{64}$/);
  assert.equal(stored.inputs.candidate.file, "candidate.png");
  assert.deepEqual(stored.meta, { page: "add-project", build: 42 });
  assert.equal(stored.result.score, result.score);
  assert.equal(stored.result.differences[0].type, "content_missing");
  assert.equal(stored.result.report, undefined, "the stored result doesn't point at itself");

  const html = await readFile(result.report.files.html, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /按钮还在/);
  assert.equal(html.match(/class="box"/g).length, 2, "one box per difference in each image");
});

test("a string report option is the directory", async () => {
  const result = await compare({ report: join(root, "string") });
  assert.ok(result.report.dir.startsWith(join(root, "string")));
});

test("saveReport can skip images and HTML", async () => {
  const result = await compare();
  const saved = await saveReport(result, ref, cand, { dir: join(root, "lean"), images: false, html: false, id: "lean-1" });
  assert.deepEqual(await readdir(saved.dir), ["report.json"]);
  assert.equal(saved.files.html, null);
  assert.equal((await loadReport(join(saved.dir, "report.json"))).inputs.reference.file, null);
});

test("listReports returns newest first and skips broken or partial reports", async () => {
  const dir = join(root, "list");
  const result = await compare();
  const first = await saveReport(result, ref, cand, { dir, id: "a-first" });
  await new Promise((r) => setTimeout(r, 5));
  const second = await saveReport(result, ref, ref, { dir, id: "b-second", meta: { n: 2 } });
  // Noise: a directory without a report, an unreadable report, and a temp dir.
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(dir, "empty"));
  await mkdir(join(dir, "broken"));
  await writeFile(join(dir, "broken", "report.json"), "{not json");
  await mkdir(join(dir, ".tmp-x"));

  const list = await listReports(dir);
  assert.deepEqual(list.map((r) => r.id), [second.id, first.id]);
  assert.equal(list[0].differenceCount, 1);
  assert.equal(list[0].candidate.path, ref);
  assert.deepEqual(list[0].meta, { n: 2 });
  assert.deepEqual((await listReports(dir, { limit: 1 })).map((r) => r.id), [second.id]);
  assert.deepEqual(await listReports(join(root, "missing")), []);
});

test("saving never leaves partial reports behind", async () => {
  const dir = join(root, "dup");
  const result = await compare();
  await saveReport(result, ref, cand, { dir, id: "same" });
  await assert.rejects(saveReport(result, ref, cand, { dir, id: "same" }), /already exists/);
  assert.deepEqual(await readdir(dir), ["same"], "the failed save cleaned up its temp dir");
  await assert.rejects(saveReport(result, ref, cand, { dir, id: "../escape" }), /Invalid report id/);
});

test("concurrent saves get distinct ids", async () => {
  const dir = join(root, "concurrent");
  const result = await compare();
  const saved = await Promise.all(Array.from({ length: 5 }, () => saveReport(result, ref, cand, { dir, html: false })));
  assert.equal(new Set(saved.map((s) => s.id)).size, 5);
  assert.equal((await listReports(dir)).length, 5);
});

test("report HTML escapes user-controlled text", async () => {
  const result = await compare();
  const saved = await saveReport(result, ref, cand, { dir: join(root, "xss"), meta: { "<b>k</b>": "<script>alert(1)</script>" } });
  const html = await readFile(saved.files.html, "utf8");
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<b>k</b>"));
  assert.match(html, /&#60;script&#62;alert\(1\)/);
});

test("loadReport rejects reports from a newer schema", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const dir = join(root, "future");
  await mkdir(dir);
  await writeFile(join(dir, "report.json"), JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION + 1 }));
  await assert.rejects(loadReport(dir), /Unsupported report schema version/);
});

test("format: json writes only report.json", async () => {
  const result = await compare({ report: { dir: join(root, "json-only"), format: "json" } });
  assert.deepEqual(await readdir(result.report.dir), ["report.json"]);
  assert.deepEqual(result.report.files, { json: join(result.report.dir, "report.json"), html: null, reference: null, candidate: null });
  const stored = await loadReport(result.report.dir);
  assert.equal(stored.inputs.candidate.file, null);
  assert.equal(stored.inputs.candidate.path, cand, "the source path and hash are still recorded");
  assert.deepEqual(stored.result.differences[0].boxPx, result.differences[0].boxPx);
  assert.equal((await listReports(join(root, "json-only"))).length, 1, "json-only reports are listed like any other");
});

test("explicit html/images override the format", async () => {
  const result = await compare({ report: { dir: join(root, "override"), format: "json", images: true } });
  assert.deepEqual((await readdir(result.report.dir)).sort(), ["candidate.png", "reference.png", "report.json"]);
  await assert.rejects(compare({ report: { dir: join(root, "bad"), format: "pdf" } }), /Unsupported report format/);
});
