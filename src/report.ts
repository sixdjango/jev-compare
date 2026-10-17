import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "./cache.ts";
import type { CompareResult } from "./compare.ts";
import { loadImage } from "./image.ts";
import type { ImageInput, LoadedImage } from "./image.ts";
import { renderReportHtml } from "./report-html.ts";

declare const __VERSION__: string;

/** The `report.json` format version; bumped on incompatible changes. */
export const REPORT_SCHEMA_VERSION = 1;

/** A JSON-compatible value, for report metadata. */
export type ReportMetaValue = string | number | boolean | null | ReportMetaValue[] | { [key: string]: ReportMetaValue };

export type ReportFormat = "full" | "json";

export interface SaveReportOptions {
  /** Directory that holds reports; each report gets its own subdirectory. */
  dir: string;
  /** Report ID and subdirectory name. Default: a UTC timestamp plus a random suffix, so IDs sort by time. */
  id?: string;
  /**
   * What to write: `full` writes `report.json`, `report.html` and copies of both images;
   * `json` writes only `report.json`. `images` and `html` override it. Default: `full`.
   */
  format?: ReportFormat;
  /** Copy both images into the report. Default: true for `full`, false for `json`. */
  images?: boolean;
  /** Write a self-contained `report.html`. Default: true for `full`, false for `json`. */
  html?: boolean;
  /** Your own data to keep with the report, such as a page name, build number or commit. */
  meta?: Record<string, ReportMetaValue>;
  /**
   * Delete old reports in `dir` after this one is saved. The new report is never deleted.
   * Default: keep everything.
   */
  retention?: RetentionPolicy;
}

/**
 * Which reports to keep. A report is deleted when it breaks any limit, oldest first.
 * Reports that `keep` protects are never deleted and don't count toward the limits.
 */
export interface RetentionPolicy {
  /** Delete reports older than this many milliseconds. */
  maxAge?: number;
  /** Keep at most this many reports. */
  maxCount?: number;
  /** Keep the newest reports whose total size fits in this many bytes. */
  maxBytes?: number;
  /** Return true to protect a report, such as a baseline, from deletion. */
  keep?: (report: ReportSummary) => boolean;
}

export interface PruneOptions extends RetentionPolicy {
  /** Work out what would be deleted without deleting anything. Default: false. */
  dryRun?: boolean;
  /**
   * IDs that are never deleted but still count toward the limits, such as the report that
   * was just saved. (Reports that `keep` protects don't count.)
   */
  protect?: string[];
}

export interface PruneResult {
  /** Reports deleted (or, with `dryRun`, that would be deleted), oldest first. */
  removed: Array<ReportSummary & { bytes: number; reason: "maxAge" | "maxCount" | "maxBytes" }>;
  /** Reports left in place. */
  kept: number;
  /** Bytes freed by the deleted reports. */
  freedBytes: number;
  /** Leftover temporary directories from interrupted saves that were deleted. */
  removedTemp: number;
  /** Reports that could not be deleted. */
  errors: Array<{ id: string; message: string }>;
}

export interface ReportInput {
  /** The file path the image was read from, or `null` when it was given as bytes. */
  path: string | null;
  sha256: string;
  width: number;
  height: number;
  format: string;
  /** The image's file name inside the report directory, or `null` when images aren't copied. */
  file: string | null;
}

/** The contents of `report.json`. */
export interface StoredReport {
  schemaVersion: number;
  id: string;
  /** ISO 8601 time the report was saved. */
  createdAt: string;
  tool: { name: string; version: string };
  inputs: { reference: ReportInput; candidate: ReportInput };
  meta: Record<string, ReportMetaValue>;
  result: CompareResult;
}

/** Where a report was written. */
export interface SavedReport {
  id: string;
  /** Absolute path of the report directory. */
  dir: string;
  files: { json: string; html: string | null; reference: string | null; candidate: string | null };
  /** What `retention` deleted, when it was given. */
  pruned?: PruneResult;
}

/** One line of `listReports`. */
export interface ReportSummary {
  id: string;
  dir: string;
  createdAt: string;
  score: number;
  differenceCount: number;
  summary: string;
  reference: { path: string | null; sha256: string };
  candidate: { path: string | null; sha256: string };
  meta: Record<string, ReportMetaValue>;
}

/** An image with its original input, so a report can record where it came from. */
export interface ReportImage {
  input: ImageInput;
  loaded: LoadedImage;
}

/**
 * Save a comparison as a report directory with `report.json`, an offline `report.html`, and
 * copies of both images. The directory appears complete or not at all.
 */
export async function saveReport(
  result: CompareResult,
  reference: ImageInput,
  candidate: ImageInput,
  options: SaveReportOptions,
): Promise<SavedReport> {
  const [ref, cand] = await Promise.all([loadImage(reference), loadImage(candidate)]);
  return writeReport(result, { input: reference, loaded: ref }, { input: candidate, loaded: cand }, options);
}

/** Save a report from images that are already loaded. */
export async function writeReport(
  result: CompareResult,
  reference: ReportImage,
  candidate: ReportImage,
  options: SaveReportOptions,
): Promise<SavedReport> {
  const root = resolve(options.dir);
  const refHash = sha256(reference.loaded.bytes);
  const candHash = sha256(candidate.loaded.bytes);
  const createdAt = new Date();
  const id = options.id ?? `${timestamp(createdAt)}-${randomBytes(3).toString("hex")}`;
  if (!/^[\w.-]+$/.test(id) || id.startsWith(".")) {
    throw new Error(`Invalid report id "${id}": use letters, digits, ".", "_" or "-"`);
  }
  const format = options.format ?? "full";
  if (format !== "full" && format !== "json") throw new TypeError(`Unsupported report format: ${String(format)}`);
  const copyImages = options.images ?? format === "full";
  const writeHtml = options.html ?? format === "full";
  const ext = (img: LoadedImage) => (img.format === "png" ? "png" : "jpg");
  const refFile = copyImages ? `reference.${ext(reference.loaded)}` : null;
  const candFile = copyImages ? `candidate.${ext(candidate.loaded)}` : null;

  const report: StoredReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id,
    createdAt: createdAt.toISOString(),
    tool: { name: "jev-compare", version: __VERSION__ },
    inputs: {
      reference: inputRecord(reference, refHash, refFile),
      candidate: inputRecord(candidate, candHash, candFile),
    },
    meta: options.meta ?? {},
    result,
  };

  // Write into a hidden temporary directory, then rename it into place, so `listReports`
  // never sees a half-written report.
  const finalDir = join(root, id);
  const tempDir = join(root, `.tmp-${id}-${randomBytes(4).toString("hex")}`);
  await mkdir(tempDir, { recursive: true });
  try {
    const writes: Array<Promise<void>> = [writeFile(join(tempDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)];
    if (refFile) writes.push(writeFile(join(tempDir, refFile), reference.loaded.bytes));
    if (candFile) writes.push(writeFile(join(tempDir, candFile), candidate.loaded.bytes));
    if (writeHtml) {
      writes.push(writeFile(join(tempDir, "report.html"), renderReportHtml(report, reference.loaded, candidate.loaded)));
    }
    await Promise.all(writes);
    await rename(tempDir, finalDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
        throw new Error(`A report with id "${id}" already exists in ${root}`);
      }
      throw error;
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  const saved: SavedReport = {
    id,
    dir: finalDir,
    files: {
      json: join(finalDir, "report.json"),
      html: writeHtml ? join(finalDir, "report.html") : null,
      reference: refFile && join(finalDir, refFile),
      candidate: candFile && join(finalDir, candFile),
    },
  };
  if (options.retention) {
    saved.pruned = await pruneReports(root, { ...options.retention, protect: [id] });
  }
  return saved;
}

/** Read a saved report from its directory or its `report.json` path. */
export async function loadReport(path: string): Promise<StoredReport> {
  const file = path.endsWith(".json") ? path : join(path, "report.json");
  const report = JSON.parse(await readFile(file, "utf8")) as StoredReport;
  if (typeof report.schemaVersion !== "number" || report.schemaVersion > REPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported report schema version ${String(report.schemaVersion)} in ${file}`);
  }
  return report;
}

/** List the reports in `dir`, newest first. Directories without a readable report are skipped. */
export async function listReports(dir: string, options: { limit?: number } = {}): Promise<ReportSummary[]> {
  const root = resolve(dir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reports = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map(async (e): Promise<ReportSummary | null> => {
        const reportDir = join(root, e.name);
        try {
          const r = await loadReport(reportDir);
          return {
            id: r.id,
            dir: reportDir,
            createdAt: r.createdAt,
            score: r.result.score,
            differenceCount: r.result.differences.length,
            summary: r.result.summary,
            reference: { path: r.inputs.reference.path, sha256: r.inputs.reference.sha256 },
            candidate: { path: r.inputs.candidate.path, sha256: r.inputs.candidate.sha256 },
            meta: r.meta,
          };
        } catch {
          return null;
        }
      }),
  );
  const sorted = reports
    .filter((r): r is ReportSummary => r !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return options.limit === undefined ? sorted : sorted.slice(0, options.limit);
}

/** Temporary directories older than this were left by a save that crashed. */
const ABANDONED_TEMP_MS = 60 * 60 * 1000;

/**
 * Delete old reports from `dir` by age, count and total size, oldest first. Only directories
 * holding a readable `report.json` are touched; anything else in `dir` is left alone.
 */
export async function pruneReports(dir: string, options: PruneOptions): Promise<PruneResult> {
  const { maxAge, maxCount, maxBytes } = options;
  for (const [name, value] of Object.entries({ maxAge, maxCount, maxBytes })) {
    if (value !== undefined && !(value >= 0)) throw new RangeError(`${name} must be a non-negative number`);
  }
  if (maxAge === undefined && maxCount === undefined && maxBytes === undefined) {
    throw new Error("pruneReports needs at least one of maxAge, maxCount or maxBytes");
  }

  const root = resolve(dir);
  const protect = new Set(options.protect ?? []);
  const result: PruneResult = { removed: [], kept: 0, freedBytes: 0, removedTemp: 0, errors: [] };
  const now = Date.now();

  // Newest first, so the limits keep the most recent reports.
  const reports = await listReports(root);
  const sizeOf = (report: ReportSummary) => (maxBytes === undefined ? 0 : directorySize(report.dir));

  // Protected IDs take their share of the limits first, wherever they fall in time.
  let count = 0;
  let bytes = 0;
  const candidates: ReportSummary[] = [];
  for (const report of reports) {
    if (options.keep?.(report)) {
      result.kept++;
    } else if (protect.has(report.id)) {
      count++;
      bytes += await sizeOf(report);
      result.kept++;
    } else {
      candidates.push(report);
    }
  }

  const doomed: PruneResult["removed"] = [];
  // Once a count or size limit is reached, every older report goes too, so a newer report is
  // never deleted while an older, smaller one is kept.
  let full: "maxCount" | "maxBytes" | null = null;
  for (const report of candidates) {
    const size = await sizeOf(report);
    const aged = maxAge !== undefined && now - Date.parse(report.createdAt) > maxAge;
    if (!aged) {
      full ??=
        maxCount !== undefined && count + 1 > maxCount
          ? "maxCount"
          : maxBytes !== undefined && bytes + size > maxBytes
            ? "maxBytes"
            : null;
    }
    const reason = aged ? "maxAge" : full;
    if (reason) {
      doomed.push({ ...report, bytes: size, reason });
    } else {
      count++;
      bytes += size;
      result.kept++;
    }
  }

  for (const report of doomed.reverse()) {
    const size = report.bytes || (await directorySize(report.dir));
    if (!options.dryRun) {
      try {
        await rm(report.dir, { recursive: true, force: true });
      } catch (error) {
        result.errors.push({ id: report.id, message: (error as Error).message });
        result.kept++;
        continue;
      }
    }
    result.removed.push({ ...report, bytes: size });
    result.freedBytes += size;
  }

  // Temp directories young enough may belong to a save that is still running.
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith(".tmp-")) continue;
    const path = join(root, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info || now - info.mtimeMs < ABANDONED_TEMP_MS) continue;
    if (!options.dryRun) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    result.removedTemp++;
  }
  return result;
}

/** Total size in bytes of the files under `dir`, without following symlinks. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else total += (await lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

function inputRecord(img: ReportImage, hash: string, file: string | null): ReportInput {
  const path = typeof img.input === "string" && !img.input.startsWith("data:") ? resolve(img.input) : null;
  return { path, sha256: hash, width: img.loaded.width, height: img.loaded.height, format: img.loaded.format, file };
}

/** `20261017-081530`, in UTC so IDs sort the same on every machine. */
function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}
