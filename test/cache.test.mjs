import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compareImages, fileCache, memoryCache } from "../dist/index.mjs";

const ref = new URL("./original_img.png", import.meta.url).pathname;
const cand = new URL("./test_img1.png", import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), "jev-compare-cache-"));
after(() => rm(root, { recursive: true, force: true }));
const KEY = "ab".repeat(32);

/** A fake client that counts the requests that reach it. */
function countingClient() {
  const client = {
    calls: 0,
    systemOne(request) {
      client.calls++;
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([n, q]) =>
          q.type === "score" ? [n, { type: "score", score: 6.5, confidence: 0.5 }]
          : q.type === "noul" ? [n, { type: "noul", noul: n === "exists_0" || n === "exists_1" ? 0.9 : 0.1 }]
          : q.type === "choice" ? [n, { type: "choice", choice: n.startsWith("type") ? "content_missing" : "button", confidence: 0.9 }]
          : [n, { type: "box", box: n.endsWith("_1") ? { top: 0.3, bottom: 0.4, left: 0.1, right: 0.9 } : { top: 0.89, bottom: 0.96, left: 0.07, right: 0.94 }, confidence: 0.8 }],
        ),
      );
      return Promise.resolve({ model: "fake", answers, usage: { input_tokens: 100, output_tokens: 10 } });
    },
  };
  return client;
}

test("memoryCache evicts the least recently used entry and copies values", () => {
  const cache = memoryCache({ maxEntries: 2 });
  cache.set("a", { n: 1 });
  cache.set("b", { n: 2 });
  cache.get("a"); // a is now more recent than b
  cache.set("c", { n: 3 });
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("a"), { n: 1 });
  const value = cache.get("c");
  value.n = 99;
  assert.deepEqual(cache.get("c"), { n: 3 }, "callers can't mutate cached values");
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("memoryCache expires entries", async () => {
  const cache = memoryCache({ ttl: 10 });
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get("a"), undefined);
});

test("fileCache round-trips, expires, and treats corrupt files as misses", async () => {
  const dir = join(root, "file");
  const cache = fileCache({ dir, ttl: 50 });
  assert.equal(await cache.get(KEY), undefined);
  await cache.set(KEY, { answers: { x: 1 } });
  assert.deepEqual(await cache.get(KEY), { answers: { x: 1 } });
  assert.deepEqual(await fileCache(dir).get(KEY), { answers: { x: 1 } }, "another instance sees it");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await cache.get(KEY), undefined, "expired");

  await writeFile(join(dir, KEY.slice(0, 2), `${KEY}.json`), "{broken");
  assert.equal(await cache.get(KEY), undefined, "corrupt");
  await assert.rejects(cache.set("../../etc", 1), /Invalid cache key/);
});

const key = (n) => n.toString(16).padStart(64, "0");
const entryFile = (dir, k) => join(dir, k.slice(0, 2), `${k}.json`);
const ago = (ms) => new Date(Date.now() - ms);
/** Write an entry as if it had been created `age` ms ago. */
async function writeAged(dir, k, age, value = 1) {
  await mkdir(join(dir, k.slice(0, 2)), { recursive: true });
  await writeFile(entryFile(dir, k), JSON.stringify({ createdAt: Date.now() - age, value }));
}

test("fileCache.prune removes expired, corrupt and abandoned temp files only", async () => {
  const dir = join(root, "prune");
  const cache = fileCache({ dir, ttl: 1000, autoPrune: false });
  const fresh = "cd".repeat(32), old = "ef".repeat(32);
  await cache.set(fresh, 1);
  await writeAged(dir, old, 5000);
  const shard = join(dir, "ef");
  await writeFile(join(shard, `${"e".repeat(64)}.json`), "{");
  await writeFile(join(shard, "busy.tmp"), "");
  await writeFile(join(shard, "dead.tmp"), "");
  await utimes(join(shard, "dead.tmp"), ago(120_000), ago(120_000));
  await writeFile(join(shard, "notes.txt"), "not ours");
  await mkdir(join(dir, "other"));
  await writeFile(join(dir, "other", "x.json"), "{");

  const r = await cache.prune();
  assert.deepEqual({ ...r, freedBytes: undefined, keptBytes: undefined }, {
    expired: 1, evicted: 0, invalid: 1, temp: 1, freedBytes: undefined, keptEntries: 1, keptBytes: undefined,
  });
  assert.deepEqual((await readdir(shard)).sort(), ["busy.tmp", "notes.txt"], "unknown files are left alone");
  assert.deepEqual(await readdir(join(dir, "other")), ["x.json"]);
  assert.equal(await cache.get(fresh), 1);
  await cache.clear();
  assert.equal(await cache.get(fresh), undefined);
  assert.equal((await cache.prune()).keptEntries, 0, "prune on a missing dir is a no-op");
});

test("fileCache evicts least recently used entries over maxEntries", async () => {
  const dir = join(root, "lru-count");
  const cache = fileCache({ dir, maxEntries: 2, autoPrune: false });
  for (const [i, age] of [[1, 3000], [2, 2000], [3, 1000]]) {
    await cache.set(key(i), i);
    await utimes(entryFile(dir, key(i)), ago(age), ago(age));
  }
  assert.equal(await cache.get(key(1)), 1); // the oldest write is now the most recently used
  const r = await cache.prune();
  assert.equal(r.evicted, 1);
  assert.equal(await cache.get(key(2)), undefined, "least recently used is evicted");
  assert.equal(await cache.get(key(1)), 1);
  assert.equal(await cache.get(key(3)), 3);
});

test("fileCache evicts by maxBytes, never keeping an older entry over a newer one", async () => {
  const dir = join(root, "lru-bytes");
  const cache = fileCache({ dir, maxBytes: 1000, autoPrune: false });
  await cache.set(key(1), "x".repeat(100)); // oldest, small
  await utimes(entryFile(dir, key(1)), ago(3000), ago(3000));
  await cache.set(key(2), "x".repeat(900)); // middle, large: doesn't fit beside the newest
  await utimes(entryFile(dir, key(2)), ago(2000), ago(2000));
  await cache.set(key(3), "x".repeat(300)); // newest
  const r = await cache.prune();
  assert.equal(r.evicted, 2);
  assert.ok(r.keptBytes <= 1000);
  assert.equal(await cache.get(key(3)), "x".repeat(300));
  assert.equal(await cache.get(key(1)), undefined, "the older small entry goes too");
});

test("fileCache prunes automatically after writes, throttled across instances", async () => {
  const dir = join(root, "auto");
  await writeAged(dir, key(1), 10_000);
  const cache = fileCache({ dir, ttl: 1000 }); // autoPrune defaults to on when a limit is set
  await cache.set(key(2), 2);
  assert.deepEqual(await readdir(join(dir, "00")), [`${key(2)}.json`], "the expired entry was pruned");

  // Another instance (as in another process) sees the marker and skips pruning.
  await writeAged(dir, key(3), 10_000);
  await fileCache({ dir, ttl: 1000 }).set(key(4), 4);
  assert.ok((await readdir(join(dir, "00"))).includes(`${key(3)}.json`), "throttled");

  // Once the interval has passed, the next write prunes again.
  await utimes(join(dir, ".last-prune"), ago(2 * 3_600_000), ago(2 * 3_600_000));
  await fileCache({ dir, ttl: 1000 }).set(key(5), 5);
  assert.ok(!(await readdir(join(dir, "00"))).includes(`${key(3)}.json`));
});

test("fileCache auto-prune is off without limits, and can be turned off", async () => {
  const dir = join(root, "no-auto");
  await fileCache(dir).set(key(1), 1);
  await fileCache({ dir, ttl: 1000, autoPrune: false }).set(key(2), 2);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith(".")), [], "never pruned, no marker");
  assert.throws(() => fileCache({ dir, maxBytes: -1 }), RangeError);
});

test("fileCache with a pruneInterval of 0 enforces limits on every write", async () => {
  const dir = join(root, "every-write");
  const cache = fileCache({ dir, maxEntries: 3, pruneInterval: 0 });
  for (let i = 1; i <= 6; i++) {
    await cache.set(key(i), i);
    await utimes(entryFile(dir, key(i)), ago(10_000 - i * 1000), ago(10_000 - i * 1000));
  }
  const left = (await readdir(join(dir, "00"))).filter((n) => n.endsWith(".json"));
  assert.equal(left.length, 3, `${left.length} entries`);
  assert.deepEqual(left.sort(), [key(4), key(5), key(6)].map((k) => `${k}.json`));
});

test("a repeated comparison is answered entirely from the cache", async () => {
  const cache = memoryCache();
  const client = countingClient();
  const first = await compareImages(ref, cand, { client, cache });
  assert.deepEqual(first.requests, { total: 4, cached: 0 }, "overview + differences + 2 refines");
  assert.equal(client.calls, 4);

  const second = await compareImages(ref, cand, { client, cache });
  assert.equal(client.calls, 4, "no new API calls");
  assert.deepEqual(second.requests, { total: 4, cached: 4 });
  assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0 }, "usage counts only tokens spent now");
  const strip = (r) => ({ ...r, requests: undefined, usage: undefined });
  assert.deepEqual(strip(second), strip(first));
});

test("changing locale reuses everything; changing other inputs reuses what still applies", async () => {
  const cache = memoryCache();
  const client = countingClient();
  await compareImages(ref, cand, { client, cache });

  const en = await compareImages(ref, cand, { client, cache, locale: "en" });
  assert.deepEqual(en.requests, { total: 4, cached: 4 });
  assert.equal(en.differences[0].typeLabel, "Missing content");

  // The difference request changes, but it finds the same two differences, so their
  // refine requests are the same and still hit.
  const fewer = await compareImages(ref, cand, { client, cache, maxDifferences: 2 });
  assert.deepEqual(fewer.requests, { total: 4, cached: 3 });

  const context = await compareImages(ref, cand, { client, cache, context: "mobile" });
  assert.equal(context.requests.cached, 0, "the prompt changed");

  const other = await compareImages(ref, ref, { client, cache });
  assert.equal(other.requests.cached, 0, "different image");

  const resized = await compareImages(ref, cand, { client, cache, resize: { maxPixels: 100_000 } });
  assert.equal(resized.requests.cached, 0, "different bytes are sent");
});

test("a string cache option is an on-disk cache shared across calls", async () => {
  const dir = join(root, "disk");
  const client = countingClient();
  await compareImages(ref, cand, { client, cache: dir });
  const again = await compareImages(ref, cand, { client, cache: dir });
  assert.equal(again.requests.cached, 4);
  assert.ok((await readdir(dir)).length > 0);
});

test("a broken cache store never fails the comparison", async () => {
  const client = countingClient();
  const throwing = { get: () => { throw new Error("down"); }, set: () => { throw new Error("down"); } };
  const rejecting = { get: () => Promise.reject(new Error("down")), set: () => Promise.reject(new Error("down")) };
  assert.equal((await compareImages(ref, cand, { client, cache: rejecting })).differences.length, 2);
  const result = await compareImages(ref, cand, { client, cache: throwing });
  assert.equal(result.requests.cached, 0);
  assert.equal(result.differences.length, 2);
});

test("cached values that don't answer the questions are ignored", async () => {
  const client = countingClient();
  const junk = { get: () => ({ model: "x", answers: { similarity: { type: "noul" } } }), set: () => {} };
  const result = await compareImages(ref, cand, { client, cache: junk });
  assert.equal(result.requests.cached, 0);
  assert.equal(client.calls, 4);
});

test("failed requests are not cached", async () => {
  const cache = memoryCache();
  let fail = true;
  const inner = countingClient();
  const client = { systemOne: (r) => (fail ? Promise.reject(new Error("boom")) : inner.systemOne(r)) };
  await assert.rejects(compareImages(ref, cand, { client, cache }), /boom/);
  assert.equal(cache.size, 0);
  fail = false;
  assert.equal((await compareImages(ref, cand, { client, cache })).requests.cached, 0);
});
