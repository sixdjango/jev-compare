import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compareImages, listReports, pruneReports, saveReport } from "../dist/index.mjs";

const ref = new URL("./original_img.png", import.meta.url).pathname;
const cand = new URL("./test_img1.png", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "jev-compare-prune-"));
after(() => rm(root, { recursive: true, force: true }));
const DAY = 86_400_000;

const client = {
  systemOne(request) {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([n, q]) =>
        q.type === "score" ? [n, { type: "score", score: 8, confidence: 1 }]
        : q.type === "noul" ? [n, { type: "noul", noul: 0.1 }]
        : q.type === "choice" ? [n, { type: "choice", choice: n.startsWith("type") ? "moved" : "button", confidence: 1 }]
        : [n, { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 1 }],
      ),
    );
    return Promise.resolve({ model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } });
  },
};
const result = await compareImages(ref, cand, { client });

/** Save reports with the given ages in days (index 0 = newest), with `extra` options per report. */
async function seed(name, ages, extra = () => ({})) {
  const dir = join(root, name);
  for (const [i, age] of ages.entries()) {
    const saved = await saveReport(result, ref, cand, { dir, id: `r${i}`, html: false, ...extra(i) });
    const file = join(saved.dir, "report.json");
    const report = JSON.parse(await readFile(file, "utf8"));
    report.createdAt = new Date(Date.now() - age * DAY).toISOString();
    await writeFile(file, JSON.stringify(report));
  }
  return dir;
}
const ids = async (dir) => (await listReports(dir)).map((r) => r.id);

test("maxCount keeps the newest reports", async () => {
  const dir = await seed("count", [0, 1, 2, 3, 4]);
  const r = await pruneReports(dir, { maxCount: 2 });
  assert.deepEqual(await ids(dir), ["r0", "r1"]);
  assert.deepEqual(r.removed.map((x) => x.id), ["r4", "r3", "r2"], "oldest first");
  assert.ok(r.removed.every((x) => x.reason === "maxCount"));
  assert.equal(r.kept, 2);
  assert.ok(r.freedBytes > 0);
});

test("maxAge deletes reports older than the limit", async () => {
  const dir = await seed("age", [0, 2, 10, 40]);
  const r = await pruneReports(dir, { maxAge: 7 * DAY });
  assert.deepEqual(await ids(dir), ["r0", "r1"]);
  assert.ok(r.removed.every((x) => x.reason === "maxAge"));
});

test("maxBytes keeps the newest reports that fit", async () => {
  const dir = await seed("bytes", [0, 1, 2, 3]);
  const [one] = (await pruneReports(dir, { maxBytes: Infinity, dryRun: true })).removed;
  assert.equal(one, undefined);
  const sizes = (await pruneReports(dir, { maxBytes: 0, dryRun: true })).removed.map((x) => x.bytes);
  const budget = sizes[0] * 2.5; // room for two reports
  await pruneReports(dir, { maxBytes: budget });
  assert.deepEqual(await ids(dir), ["r0", "r1"]);
});

test("limits combine: a report is deleted when it breaks any of them", async () => {
  const dir = await seed("combined", [0, 1, 20, 3, 4]);
  const r = await pruneReports(dir, { maxAge: 7 * DAY, maxCount: 3 });
  assert.deepEqual(await ids(dir), ["r0", "r1", "r3"]);
  assert.deepEqual(Object.fromEntries(r.removed.map((x) => [x.id, x.reason])), { r2: "maxAge", r4: "maxCount" });
});

test("dryRun reports without deleting", async () => {
  const dir = await seed("dry", [0, 1, 2]);
  const r = await pruneReports(dir, { maxCount: 1, dryRun: true });
  assert.equal(r.removed.length, 2);
  assert.equal((await ids(dir)).length, 3);
});

test("keep protects reports, and they don't count toward the limits", async () => {
  const dir = await seed("keep", [0, 1, 2, 3], (i) => ({ meta: { baseline: i === 3 } }));
  await pruneReports(dir, { maxCount: 2, keep: (r) => r.meta.baseline === true });
  assert.deepEqual(await ids(dir), ["r0", "r1", "r3"]);
});

test("protected ids are never deleted but do count toward the limits", async () => {
  const dir = await seed("protect", [5, 0, 1]);
  await pruneReports(dir, { maxCount: 2, maxAge: 2 * DAY, protect: ["r0"] });
  assert.deepEqual(await ids(dir), ["r1", "r0"], "r0 is too old but protected; r2 is dropped by count");
});

test("only real reports and abandoned temp dirs are deleted", async () => {
  const dir = await seed("foreign", [10]);
  await mkdir(join(dir, "notes"));
  await writeFile(join(dir, "notes", "keep.txt"), "mine");
  await writeFile(join(dir, "README.txt"), "mine");
  await mkdir(join(dir, ".tmp-busy"));
  await mkdir(join(dir, ".tmp-dead"));
  const old = new Date(Date.now() - 2 * 3_600_000);
  await utimes(join(dir, ".tmp-dead"), old, old);

  const r = await pruneReports(dir, { maxAge: DAY });
  assert.equal(r.removed.length, 1);
  assert.equal(r.removedTemp, 1);
  assert.deepEqual((await readdir(dir)).sort(), [".tmp-busy", "README.txt", "notes"]);
});

test("saving with retention prunes and never deletes the new report", async () => {
  const dir = await seed("retention", [1, 2, 3]);
  const saved = await saveReport(result, ref, cand, { dir, html: false, retention: { maxCount: 2 } });
  assert.deepEqual(await ids(dir), [saved.id, "r0"]);
  assert.deepEqual(saved.pruned.removed.map((x) => x.id), ["r2", "r1"]);

  // Even a limit of zero keeps the report that was just saved.
  const only = await saveReport(result, ref, cand, { dir, html: false, retention: { maxCount: 0 } });
  assert.deepEqual(await ids(dir), [only.id]);
});

test("compareImages passes report retention through", async () => {
  const dir = await seed("via-compare", [1, 2]);
  const r = await compareImages(ref, cand, { client, report: { dir, html: false, retention: { maxCount: 1 } } });
  assert.deepEqual(await ids(dir), [r.report.id]);
  assert.equal(r.report.pruned.removed.length, 2);
});

test("invalid policies are rejected", async () => {
  await assert.rejects(pruneReports(root, {}), /at least one of/);
  await assert.rejects(pruneReports(root, { maxCount: -1 }), RangeError);
  await assert.rejects(pruneReports(root, { maxAge: Number.NaN }), RangeError);
  assert.deepEqual((await pruneReports(join(root, "missing"), { maxCount: 1 })).removed, []);
});

test("maxBytes never keeps an older report over a newer one", async () => {
  // r0 newest (small), r1 large, r2 oldest (small): r1 doesn't fit, so r2 goes too.
  const dir = await seed("strict-bytes", [0, 1, 2], (i) => ({ images: i === 1 }));
  const sizes = Object.fromEntries((await pruneReports(dir, { maxBytes: 0, dryRun: true })).removed.map((x) => [x.id, x.bytes]));
  const r = await pruneReports(dir, { maxBytes: sizes.r0 + sizes.r2 + 1 });
  assert.deepEqual(await ids(dir), ["r0"]);
  assert.deepEqual(r.removed.map((x) => [x.id, x.reason]), [["r2", "maxBytes"], ["r1", "maxBytes"]]);
});

test("an expired report doesn't use up the size budget", async () => {
  const dir = await seed("aged-bytes", [0, 30, 2], (i) => ({ images: i === 1 }));
  const sizes = Object.fromEntries((await pruneReports(dir, { maxBytes: 0, dryRun: true })).removed.map((x) => [x.id, x.bytes]));
  await pruneReports(dir, { maxAge: 7 * DAY, maxBytes: sizes.r0 + sizes.r2 + 1 });
  assert.deepEqual(await ids(dir), ["r0", "r2"], "r1 is deleted for age, so r2 still fits");
});
