import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { annotateDifferences, compareImages, fileCache, listReports, pruneReports } from "./index.ts";
import type { CachePruneResult, FileCacheOptions, Locale, PruneResult, ReportFormat, RetentionPolicy } from "./index.ts";

const USAGE = `Usage: jev-compare <reference> <candidate> [options]
       jev-compare --list <dir>
       jev-compare --prune <dir> [--keep-days <n>] [--keep-count <n>] [--keep-mb <n>] [--dry-run]
       jev-compare --prune-cache <dir> [--cache-days <n>] [--cache-entries <n>] [--cache-mb <n>]

Options:
  --json                 Print the full result as JSON
  --svg <file>           Write the candidate with differences outlined to an SVG file
  --cache <dir>          Cache API answers on disk; repeated comparisons are free
  --cache-days <n>       Cache limit: entries expire after n days
  --cache-entries <n>    Cache limit: keep at most n entries (least recently used go first)
  --cache-mb <n>         Cache limit: keep at most n MB (least recently used go first)
                         (with any cache limit, the cache prunes itself at most hourly)
  --prune-cache <dir>    Prune the cache under <dir> now by the --cache-* limits
  --report <dir>         Save a report (report.json, report.html, images) under <dir>
  --report-format <f>    full: report.json + report.html + images (default); json: report.json only
  --meta <key=value>     Metadata to keep with the report; repeatable
  --list <dir>           List the reports saved under <dir>, newest first
  --prune <dir>          Delete old reports under <dir> by the --keep-* limits
  --keep-days <n>        Retention: delete reports older than n days
  --keep-count <n>       Retention: keep at most n reports
  --keep-mb <n>          Retention: keep the newest reports that fit in n MB
  --dry-run              With --prune, show what would be deleted without deleting
                         (--keep-* also apply after --report saves a report)
  --locale <zh|en>       Language of the report (default: zh)
  --max <n>              Maximum differences to locate, 0-8 (default: 4)
  --threshold <0-1>      Minimum probability to report a difference (default: 0.5)
  --no-refine            Skip the second look at each difference (faster, coarser)
  --max-size <px>        Downscale so the longest side is at most this, up to 1568 (default: 1568)
  --max-pixels <n>       Downscale to at most this many pixels; lower uses fewer tokens (default: 1150000)
  --no-resize            Send the original images (the API rejects sides over 1568 px)
  --context <text>       Extra context for the model
  --model <name>         Model name (default: jev-preview)
  --proxy <url|none>     HTTP proxy (default: HTTPS_PROXY / HTTP_PROXY; "none" disables)
  -h, --help             Show this help

The API key is read from JEV_KEY or TYPESAFE_API_KEY.
HTTPS_PROXY / HTTP_PROXY are used automatically, honoring NO_PROXY.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      svg: { type: "string" },
      report: { type: "string" },
      cache: { type: "string" },
      "cache-days": { type: "string" },
      "cache-entries": { type: "string" },
      "cache-mb": { type: "string" },
      "prune-cache": { type: "string" },
      meta: { type: "string", multiple: true },
      "report-format": { type: "string" },
      list: { type: "string" },
      prune: { type: "string" },
      "keep-days": { type: "string" },
      "keep-count": { type: "string" },
      "keep-mb": { type: "string" },
      "dry-run": { type: "boolean" },
      locale: { type: "string" },
      max: { type: "string" },
      threshold: { type: "string" },
      context: { type: "string" },
      "no-refine": { type: "boolean" },
      "max-size": { type: "string" },
      "max-pixels": { type: "string" },
      "no-resize": { type: "boolean" },
      model: { type: "string" },
      proxy: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.list !== undefined) {
    const reports = await listReports(values.list);
    if (values.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
    }
    if (!reports.length) console.log(`No reports in ${values.list}`);
    for (const r of reports) {
      console.log(`${r.id}  ${String(r.score).padStart(4)}/10  ${r.differenceCount} diff  ${r.candidate.path ?? r.candidate.sha256.slice(0, 12)}`);
    }
    return;
  }
  const cacheLimits = cacheLimitsFrom(values);
  if (values["prune-cache"] !== undefined) {
    const result = await fileCache({ dir: values["prune-cache"], ...cacheLimits, autoPrune: false }).prune();
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printCachePrune(result);
    return;
  }
  const retention = retentionFrom(values);
  if (values.prune !== undefined) {
    if (!retention) throw new Error("--prune needs at least one of --keep-days, --keep-count or --keep-mb");
    const result = await pruneReports(values.prune, { ...retention, dryRun: values["dry-run"] });
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else printPrune(result, values["dry-run"] ?? false);
    return;
  }
  if (values.help || positionals.length !== 2) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (values["report-format"] !== undefined && values.report === undefined) {
    throw new Error("--report-format needs --report <dir>");
  }
  const [reference, candidate] = positionals as [string, string];
  const result = await compareImages(reference, candidate, {
    locale: (values.locale as Locale | undefined) ?? "zh",
    maxDifferences: values.max === undefined ? undefined : Number(values.max),
    threshold: values.threshold === undefined ? undefined : Number(values.threshold),
    refine: !values["no-refine"],
    resize: values["no-resize"]
      ? false
      : {
          maxDimension: values["max-size"] === undefined ? undefined : Number(values["max-size"]),
          maxPixels: values["max-pixels"] === undefined ? undefined : Number(values["max-pixels"]),
        },
    context: values.context,
    model: values.model,
    proxy: values.proxy === undefined ? undefined : values.proxy === "none" ? false : values.proxy,
    cache: values.cache === undefined ? undefined : fileCache({ dir: values.cache, ...cacheLimits }),
    report:
      values.report === undefined
        ? undefined
        : {
            dir: values.report,
            format: reportFormat(values["report-format"]),
            meta: parseMeta(values.meta ?? []),
            retention,
          },
  });

  if (values.svg) {
    await writeFile(values.svg, await annotateDifferences(candidate, result));
  }
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.summary);
  if (result.requests.cached) console.log(`(${result.requests.cached}/${result.requests.total} API requests served from cache)`);
  for (const d of result.differences) {
    const b = d.boxPx;
    console.log(
      `\n${d.rank}. [${d.typeLabel}] ${d.elementLabel}  p=${d.probability.toFixed(2)}` +
        `\n   box: x=${b.x} y=${b.y} w=${b.width} h=${b.height}` +
        `\n   ${d.suggestion}`,
    );
  }
  if (result.issues.length) {
    console.log("");
    for (const issue of result.issues) console.log(`- ${issue.label} (${issue.probability.toFixed(2)}): ${issue.suggestion}`);
  }
  if (values.svg) console.log(`\nSVG: ${values.svg}`);
  if (result.report) console.log(`\nReport: ${result.report.files.html ?? result.report.files.json}`);
  if (result.report?.pruned?.removed.length) {
    console.log(`Deleted ${result.report.pruned.removed.length} old report(s), freed ${formatBytes(result.report.pruned.freedBytes)}`);
  }
}

function numberFlag(values: Record<string, unknown>, name: string): number | undefined {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} expects a non-negative number, got "${String(raw)}"`);
  return n;
}

function cacheLimitsFrom(values: Record<string, unknown>): Pick<FileCacheOptions, "ttl" | "maxEntries" | "maxBytes"> {
  const days = numberFlag(values, "cache-days");
  const entries = numberFlag(values, "cache-entries");
  const mb = numberFlag(values, "cache-mb");
  return {
    ttl: days === undefined ? undefined : days * 86_400_000,
    maxEntries: entries === undefined ? undefined : Math.floor(entries),
    maxBytes: mb === undefined ? undefined : mb * 1024 * 1024,
  };
}

function printCachePrune(r: CachePruneResult): void {
  console.log(
    `Removed ${r.expired} expired, ${r.evicted} evicted, ${r.invalid} invalid, ${r.temp} temp file(s); ` +
      `freed ${formatBytes(r.freedBytes)}. Kept ${r.keptEntries} entries (${formatBytes(r.keptBytes)}).`,
  );
}

function retentionFrom(values: Record<string, unknown>): RetentionPolicy | undefined {
  const num = (name: string) => numberFlag(values, name);
  const days = num("keep-days");
  const count = num("keep-count");
  const mb = num("keep-mb");
  if (days === undefined && count === undefined && mb === undefined) return undefined;
  return {
    maxAge: days === undefined ? undefined : days * 86_400_000,
    maxCount: count === undefined ? undefined : Math.floor(count),
    maxBytes: mb === undefined ? undefined : mb * 1024 * 1024,
  };
}

function printPrune(result: PruneResult, dryRun: boolean): void {
  const verb = dryRun ? "Would delete" : "Deleted";
  for (const r of result.removed) console.log(`${verb} ${r.id}  (${r.reason}, ${formatBytes(r.bytes)})`);
  console.log(
    `${verb} ${result.removed.length} report(s), ${dryRun ? "would free" : "freed"} ${formatBytes(result.freedBytes)}; kept ${result.kept}` +
      (result.removedTemp ? `; ${result.removedTemp} leftover temp dir(s)` : ""),
  );
  for (const e of result.errors) console.error(`Could not delete ${e.id}: ${e.message}`);
  if (result.errors.length) process.exitCode = 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reportFormat(raw: string | undefined): ReportFormat | undefined {
  if (raw === undefined || raw === "full" || raw === "json") return raw;
  throw new Error(`--report-format expects "full" or "json", got "${raw}"`);
}

function parseMeta(pairs: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--meta expects key=value, got "${pair}"`);
    meta[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return meta;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
