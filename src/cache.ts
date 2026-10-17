import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Where API answers are cached. Implement it to use your own storage, such as Redis.
 * Values are plain JSON; `get` returns `undefined` on a miss.
 */
export interface CacheStore {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown): Promise<void> | void;
}

/** Bumped when the cached value format or key derivation changes, so old entries stop matching. */
const CACHE_FORMAT = 1;

/** sha256 hex digest. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The cache key for one API request. It covers everything sent: the model, the prompt text,
 * the images' bytes (as hashes) and the questions, so any change to them is a miss.
 */
export function requestCacheKey(parts: {
  model: string;
  intro: string;
  referenceSha256: string;
  candidateSha256: string;
  questions: unknown;
}): string {
  return sha256(JSON.stringify({ format: CACHE_FORMAT, ...parts }));
}

export interface MemoryCacheOptions {
  /** Most entries kept; the least recently used are evicted first. Default: 500. */
  maxEntries?: number;
  /** Entry lifetime in milliseconds. Default: no expiry. */
  ttl?: number;
}

export interface MemoryCache extends CacheStore {
  readonly size: number;
  clear(): void;
}

/** An in-process LRU cache, shared by every comparison that is given it. */
export function memoryCache(options: MemoryCacheOptions = {}): MemoryCache {
  const maxEntries = options.maxEntries ?? 500;
  const entries = new Map<string, { value: unknown; expires: number }>();
  return {
    get size() {
      return entries.size;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expires <= Date.now()) return undefined;
      entries.set(key, entry); // Move to the most recently used end.
      return structuredClone(entry.value);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), expires: options.ttl === undefined ? Infinity : Date.now() + options.ttl });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
    clear() {
      entries.clear();
    },
  };
}

export interface FileCacheOptions {
  /** Directory that holds the cache files. */
  dir: string;
  /** Entry lifetime in milliseconds, counted from when it was written. Default: no expiry. */
  ttl?: number;
  /** Most entries kept; the least recently used are evicted first. Default: no limit. */
  maxEntries?: number;
  /** Most bytes kept; the least recently used entries are evicted first. Default: no limit. */
  maxBytes?: number;
  /**
   * Prune automatically after writes, at most once per `pruneInterval` across every process
   * that shares the directory. Default: true when `ttl`, `maxEntries` or `maxBytes` is set.
   */
  autoPrune?: boolean;
  /** Minimum time between automatic prunes, in milliseconds. Default: 1 hour. */
  pruneInterval?: number;
}

/** What `prune` deleted and what is left. */
export interface CachePruneResult {
  /** Entries past their `ttl`. */
  expired: number;
  /** Least recently used entries over `maxEntries` or `maxBytes`. */
  evicted: number;
  /** Unreadable entries. */
  invalid: number;
  /** Temp files left by interrupted writes. */
  temp: number;
  /** Bytes freed. */
  freedBytes: number;
  keptEntries: number;
  keptBytes: number;
}

export interface FileCache extends CacheStore {
  readonly dir: string;
  /** Delete every entry. */
  clear(): Promise<void>;
  /** Delete expired, unreadable and over-limit entries now. */
  prune(): Promise<CachePruneResult>;
}

/** Temp files older than this were left by a crashed write. */
const ABANDONED_TEMP_MS = 60_000;
const DEFAULT_PRUNE_INTERVAL = 60 * 60 * 1000;
/** Marks when the directory was last pruned, so short-lived processes don't all prune. */
const PRUNE_MARKER = ".last-prune";
const SHARD = /^[0-9a-f]{2}$/;
const ENTRY_FILE = /^[0-9a-f]{16,}\.json$/;

interface FileEntry {
  createdAt: number;
  value: unknown;
}

/**
 * A cache on disk, one JSON file per entry, that survives restarts and can be shared by
 * processes. Writes are atomic; unreadable or expired entries count as misses.
 *
 * With `maxEntries` or `maxBytes`, reads mark an entry as recently used (by its file time),
 * and pruning evicts the least recently used entries first. Limits are enforced when pruning,
 * so between prunes the cache can briefly grow past them.
 */
export function fileCache(options: FileCacheOptions | string): FileCache {
  const opts: FileCacheOptions = typeof options === "string" ? { dir: options } : options;
  const { ttl, maxEntries, maxBytes } = opts;
  for (const [name, value] of Object.entries({ ttl, maxEntries, maxBytes, pruneInterval: opts.pruneInterval })) {
    if (value !== undefined && !(value >= 0)) throw new RangeError(`${name} must be a non-negative number`);
  }
  const root = resolve(opts.dir);
  const tracksUse = maxEntries !== undefined || maxBytes !== undefined;
  const autoPrune = opts.autoPrune ?? (ttl !== undefined || tracksUse);
  const pruneInterval = opts.pruneInterval ?? DEFAULT_PRUNE_INTERVAL;
  const pathFor = (key: string) => {
    if (!/^[0-9a-f]{16,}$/.test(key)) throw new Error(`Invalid cache key: ${key}`);
    return join(root, key.slice(0, 2), `${key}.json`);
  };
  const expired = (entry: FileEntry, now: number) => ttl !== undefined && entry.createdAt + ttl <= now;

  let pruning: Promise<CachePruneResult> | null = null;

  const prune = async (): Promise<CachePruneResult> => {
    const now = Date.now();
    const result: CachePruneResult = { expired: 0, evicted: 0, invalid: 0, temp: 0, freedBytes: 0, keptEntries: 0, keptBytes: 0 };
    const remove = async (file: string, size: number) => {
      await rm(file, { force: true });
      result.freedBytes += size;
    };
    const live: Array<{ file: string; size: number; usedAt: number }> = [];

    for (const shard of await readdir(root).catch(() => [] as string[])) {
      if (!SHARD.test(shard)) continue; // Not ours.
      const shardDir = join(root, shard);
      for (const name of await readdir(shardDir).catch(() => [] as string[])) {
        const file = join(shardDir, name);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) continue;
        if (name.endsWith(".tmp")) {
          // A younger temp file may still be being written by another process.
          if (info.mtimeMs < now - ABANDONED_TEMP_MS) {
            await remove(file, info.size);
            result.temp++;
          }
          continue;
        }
        if (!ENTRY_FILE.test(name)) continue;
        let entry: FileEntry;
        try {
          entry = JSON.parse(await readFile(file, "utf8")) as FileEntry;
          if (typeof entry.createdAt !== "number") throw new Error("no createdAt");
        } catch {
          await remove(file, info.size);
          result.invalid++;
          continue;
        }
        if (expired(entry, now)) {
          await remove(file, info.size);
          result.expired++;
          continue;
        }
        live.push({ file, size: info.size, usedAt: info.mtimeMs });
      }
    }

    // Most recently used first; once a limit is reached, everything older goes.
    live.sort((a, b) => b.usedAt - a.usedAt);
    let full = false;
    for (const e of live) {
      full ||=
        (maxEntries !== undefined && result.keptEntries + 1 > maxEntries) ||
        (maxBytes !== undefined && result.keptBytes + e.size > maxBytes);
      if (full) {
        await remove(e.file, e.size);
        result.evicted++;
      } else {
        result.keptEntries++;
        result.keptBytes += e.size;
      }
    }

    await mkdir(root, { recursive: true });
    await writeFile(join(root, PRUNE_MARKER), String(now));
    return result;
  };

  /** Prune unless this or another process pruned within `pruneInterval`. */
  const pruneIfDue = async (): Promise<void> => {
    if (pruning) return;
    if (pruneInterval > 0) {
      // File times can read a hair ahead of Date.now(), so an interval of 0 skips the check.
      const marker = await stat(join(root, PRUNE_MARKER)).catch(() => null);
      if (marker && Date.now() - marker.mtimeMs < pruneInterval) return;
    }
    pruning = prune();
    try {
      await pruning;
    } finally {
      pruning = null;
    }
  };

  return {
    dir: root,
    async get(key) {
      const file = pathFor(key);
      let entry: FileEntry;
      try {
        entry = JSON.parse(await readFile(file, "utf8")) as FileEntry;
      } catch {
        return undefined;
      }
      const now = Date.now();
      if (expired(entry, now)) return undefined;
      // Mark it recently used, for eviction order.
      if (tracksUse) await utimes(file, now / 1000, now / 1000).catch(() => undefined);
      return entry.value;
    },
    async set(key, value) {
      const file = pathFor(key);
      await mkdir(join(root, key.slice(0, 2)), { recursive: true });
      const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
      const entry: FileEntry = { createdAt: Date.now(), value };
      await writeFile(temp, JSON.stringify(entry));
      await rename(temp, file);
      // The value is stored; a failed prune shouldn't make the write look failed.
      if (autoPrune) await pruneIfDue().catch(() => undefined);
    },
    async clear() {
      await rm(root, { recursive: true, force: true });
    },
    prune,
  };
}
