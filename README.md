# jev-compare

**English** | [简体中文](https://github.com/sixdjango/jev-compare/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/jev-compare)](https://www.npmjs.com/package/jev-compare)
[![downloads](https://img.shields.io/npm/dm/jev-compare)](https://www.npmjs.com/package/jev-compare)
[![CI](https://github.com/sixdjango/jev-compare/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sixdjango/jev-compare/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/jev-compare)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/jev-compare)](https://github.com/sixdjango/jev-compare/blob/main/LICENSE)

AI image comparison built on [TypeSafe AI](https://docs.typesafe.ai/sdk/javascript) (the Jev model):

- A **1–10 similarity score** (10 = identical)
- The **differing regions**, as boxes in both the candidate and the reference image (fractional and pixel coordinates)
- For each difference, its **type, the affected element, and a fix suggestion** (English or Chinese)
- An optional SVG with the differences outlined
- Large images are downscaled before upload (the API rejects images over 1568px on a side); boxes still come back in the original image's pixels
- Saved reports: JSON plus an offline HTML report, with listing and automatic cleanup by age, count or size
- Caching: identical requests don't call the API again (in memory, on disk, or your own store), with automatic cleanup of the disk cache

Built for UI review of design mockups against implementation screenshots, visual regression tests, and similar checks.

## Install

```sh
npm install jev-compare
```

Requires Node.js 22+. The API key is read from the `JEV_KEY` (or `TYPESAFE_API_KEY`) environment variable, or passed as `apiKey`. To work on this repository, copy `.env.example` to `.env` and fill in the key.

## Usage

```ts
import { compareImages, annotateDifferences } from "jev-compare";
import { writeFile } from "node:fs/promises";

const result = await compareImages("design.png", "screenshot.png", {
  locale: "en",        // "en" | "zh"; the default is "zh"
  maxDifferences: 4,   // how many differences to locate (0–8)
  threshold: 0.5,      // minimum probability to report
  context: "A mobile app screen; ignore the status bar",
});

console.log(result.score);   // 8.3
console.log(result.summary); // Similarity 8.3/10 (highly similar); found 2 differences.
for (const d of result.differences) {
  console.log(d.rank, d.typeLabel, d.elementLabel, d.boxPx, d.suggestion);
}

// Outline the differences on the candidate image
await writeFile("diff.svg", await annotateDifferences("screenshot.png", result));
```

An image can be a file path, a `data:` URL, `{ base64 }`, a `Uint8Array` / `Buffer` / `ArrayBuffer`, or a `Blob`. Only PNG and JPEG are supported.

### Result

```jsonc
{
  "score": 8.3,                    // 1–10
  "scoreConfidence": 0.9,
  "scoreBreakdown": { "holistic": 7.78, "extent": 8.74, "identicalProbability": 0.01 },
  "identicalProbability": 0.01,
  "identical": false,
  "summary": "Similarity 8.3/10 (highly similar); found 2 differences.",
  "differences": [
    {
      "rank": 1,
      "type": "content_missing",   // see "Difference types" below
      "typeLabel": "Missing content",
      "element": "button",         // text | button | container | icon | image | input | navigation | other
      "elementLabel": "button",
      "suggestion": "The button is there, but its text, icon or other content is missing; fill it in.",
      "probability": 0.9,          // probability that this difference exists
      "typeConfidence": 0.97,
      "box": { "top": 0.89, "bottom": 0.96, "left": 0.07, "right": 0.94 },  // candidate, fractions
      "boxPx": { "x": 26, "y": 723, "width": 323, "height": 57 },          // candidate, pixels
      "boxConfidence": 0.74,
      "referenceBox": { /* the same region in the reference */ },
      "referenceBoxPx": { /* ... */ },
      "shift": null                // for `moved`: how far the element moved, in candidate pixels, e.g. { "x": -30, "y": 0 }
    }
  ],
  "issues": [                      // kinds of difference found anywhere in the image (no location)
    { "type": "content_missing", "label": "Missing content", "probability": 0.98, "suggestion": "..." }
  ],
  "images": {
    // width/height are the original size (boxPx refers to it); sentWidth/sentHeight are what was uploaded
    "reference": { "width": 375, "height": 812, "format": "png", "sentWidth": 375, "sentHeight": 812, "resized": false },
    "candidate": { /* ... */ }
  },
  "model": "jev-1.14.0",
  "usage": { "inputTokens": 13000, "outputTokens": 1300 },
  "locale": "en",
  "requests": { "total": 4, "cached": 0 },   // API requests this comparison needed, and how many came from the cache
  "report": { "id": "20261017-081530-a1b2c3", "dir": "/abs/reports/20261017-081530-a1b2c3", "files": { /* ... */ } }  // only with the report option
}
```

### Difference types

| type | Meaning |
| --- | --- |
| `element_missing` | A whole element is missing |
| `content_missing` | The element is there, but its text, icon or other content is missing |
| `background_missing` | The content is there, but its background or card container is missing |
| `element_extra` | An element that isn't in the reference |
| `text_changed` | The text differs |
| `color_changed` | A color differs |
| `moved` | Position, alignment or spacing differs. Each located difference is checked by matching pixels: when the region is the same content at another position, it is reported as `moved`, with `shift` set and `referenceBox` on the element's original place |
| `resized` | Size differs |
| `font_changed` | Font family, size or weight differs |
| `icon_changed` | An icon or picture differs |
| `style_changed` | Border, corner radius or shadow differs |

### Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `JEV_KEY` / `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-preview` | Locating boxes needs `jev-preview` |
| `locale` | `zh` | Language of labels, suggestions and the summary: `en` or `zh` |
| `maxDifferences` | `4` | How many differences to locate (0–8); each 4 add one parallel request |
| `threshold` | `0.5` | Minimum probability for a difference or issue |
| `refine` | `true` | Look again at each difference to classify it precisely and widen its box to the whole affected element; one extra parallel request per difference |
| `resize` | `{ maxDimension: 1568, maxPixels: 1150000 }` | How images are downscaled before upload, see [Image downscaling](#image-downscaling); `false` sends the originals |
| `cache` | – | Cache API answers: a directory (disk cache), or `memoryCache()` / `fileCache()` / your own `CacheStore`, see [Caching](#caching) |
| `report` | – | Save a report: a directory, or `{ dir, format?, id?, images?, html?, meta?, retention? }`, see [Reports](#reports) |
| `context` | – | Extra context for the model |
| `client` | – | An existing `TypeSafeClient` to reuse (it must send the image opt-in header; create it with `createClient()`) |
| `clientOptions` | – | Options for the created `TypeSafeClient`, such as `baseURL`, `timeout` or a custom `fetch` |
| `proxy` | `HTTPS_PROXY` / `HTTP_PROXY` | HTTP proxy URL, or `false` for none; honors `NO_PROXY`. See [Proxies](#proxies) |
| `signal` | – | An `AbortSignal` to cancel |

## Command line

```sh
JEV_KEY=xxx npx jev-compare design.png screenshot.png --svg diff.svg
npx jev-compare design.png screenshot.png --json --locale en --max 6
npx jev-compare design.png screenshot.png --no-refine   # faster, coarser types and boxes
npx jev-compare design@3x.png shot@3x.png --max-pixels 300000   # downscale large images further to save tokens
npx jev-compare design.png screenshot.png --report reports --meta page=login --meta build=42
npx jev-compare --list reports            # list saved reports (add --json for JSON)
npx jev-compare a.png b.png --report reports --report-format json  # write only report.json
npx jev-compare a.png b.png --report reports --keep-count 100    # keep only the newest 100 reports
npx jev-compare --prune reports --keep-days 30 --keep-mb 500 --dry-run   # preview a cleanup
npx jev-compare design.png screenshot.png --cache .jev-cache   # repeat runs are served from the cache
npx jev-compare a.png b.png --cache .jev-cache --cache-days 30 --cache-mb 200  # a cache that cleans itself up
npx jev-compare --prune-cache .jev-cache --cache-entries 1000                # clean up the cache now
```

## Caching

```ts
import { compareImages, fileCache, memoryCache } from "jev-compare";

await compareImages(a, b, { cache: ".jev-cache" });                       // disk cache
await compareImages(a, b, { cache: fileCache({ dir: ".jev-cache", ttl: 7 * 864e5 }) }); // expires after 7 days
const cache = memoryCache({ maxEntries: 500 });                           // in-process LRU
await compareImages(a, b, { cache });

// Your own store (such as Redis): implement get and set; values are plain JSON
await compareImages(a, b, {
  cache: {
    get: async (key) => JSON.parse((await redis.get(`jev:${key}`)) ?? "null") ?? undefined,
    set: async (key, value) => void (await redis.set(`jev:${key}`, JSON.stringify(value), { EX: 86400 })),
  },
});
```

The cache holds the answer to **each API request**, not the whole comparison. A request's key is the sha256 of everything it sends: the model, the prompt, both images' bytes (after downscaling), and the questions. So:

| Change | Cache hits |
| --- | --- |
| Identical input | Every request; 0 tokens, about 50ms |
| Only `locale` | Every request (the language only affects text generated locally) |
| `threshold` | The overview and locating requests; only newly reported differences need a refine request |
| `maxDifferences` | The locating request is re-sent; refine requests still hit when the same differences are found |
| `context` / `model` / `resize`, a different image, or a library upgrade that changes the prompt | None |

There's no hand-maintained list of options that affect the result, so the cache can't serve a stale answer because one was missed. Failed requests aren't cached, and if the cache itself fails (say Redis is down), the comparison carries on without it.

`fileCache` writes one JSON file per entry, atomically, and can be shared by several processes; `clear()` empties it.

### Cache cleanup

```ts
const cache = fileCache({
  dir: ".jev-cache",
  ttl: 30 * 864e5,           // expire 30 days after writing
  maxEntries: 5000,          // at most 5000 entries
  maxBytes: 200 * 1024 ** 2, // at most 200 MB
  // autoPrune: true,        // on by default when any limit is set
  // pruneInterval: 36e5,    // at least an hour between automatic cleanups
});
const stats = await cache.prune(); // or clean up now
// { expired, evicted, invalid, temp, freedBytes, keptEntries, keptBytes }
```

- **Expiry** counts from when an entry was written. Expired entries are misses when read and are deleted when pruning.
- **Over the entry or size limit**, the **least recently used** entries are evicted. A cache hit refreshes the entry's file time, so entries in regular use are kept; once a limit is reached, every entry used less recently goes too.
- **Automatic cleanup** runs after writes and is throttled by a `.last-prune` marker in the directory: however many processes share the cache, it runs at most once per `pruneInterval`. That matters for the CLI, where every run is a new process and would otherwise scan the cache each time. A failed cleanup doesn't fail the write.
- Limits are enforced when pruning, so the cache can briefly exceed them between cleanups. For a strict limit, set `pruneInterval` to `0` (prunes on every write, which is slower for large caches).
- Only the cache's own files (`xx/<sha256>.json`) are touched; anything else in the directory is left alone. Corrupt entries and temp files left by crashes are cleaned up too.
- `memoryCache` already has `maxEntries` (LRU) and `ttl` and needs no cleanup.

> Model output varies a little between runs; with a cache, the same input always gets the first answer. To have the model judge again, use another cache directory or call `clear()`.

## Reports

```ts
import { compareImages, listReports, loadReport, saveReport } from "jev-compare";

// Save while comparing
const result = await compareImages("design.png", "screenshot.png", {
  report: { dir: "reports", meta: { page: "login", commit: "a1b2c3d" } },
});
console.log(result.report.files.html);

// Or save an existing result later
await saveReport(result, "design.png", "screenshot.png", { dir: "reports" });

// Read and list
const reports = await listReports("reports", { limit: 20 }); // newest first
const stored = await loadReport(reports[0].dir);              // a report directory or its report.json
stored.result.differences;
```

Each report is its own directory:

```
reports/
  20261017-081530-a1b2c3/
    report.json     # schemaVersion, id, createdAt, tool version, both images' paths/sha256/sizes, meta, full result
    report.html     # one file with the images embedded; open it offline or send it to someone
    reference.png   # copies of the images (turn off with images: false)
    candidate.png
```

- **JSON only**: `format: "json"` (CLI: `--report-format json`) writes only `report.json`, with no HTML and no image copies, for CI or other programs. The image paths, hashes and full result are still recorded, and `listReports` and cleanup work the same. The default is `format: "full"`; passing `html` or `images` overrides the format's default.
- **IDs** default to a UTC timestamp plus a random suffix, so sorting by name sorts by time. Pass `id` to choose one (letters, digits, `.`, `_` and `-` only); an existing ID is an error, never overwritten.
- **Atomic writes**: a report is written to a hidden temporary directory and renamed into place, so `listReports` never sees a half-written report, and a failed write cleans up after itself. There's no index file, so concurrent saves can't overwrite each other.
- **The HTML report** shows the reference and candidate side by side with the differences outlined; hovering a difference highlights its box in both images. It supports dark mode and phone widths, and all text (including `meta`) is escaped.
- **Compatibility**: `report.json` carries a `schemaVersion`, and `loadReport` rejects a newer format instead of misreading it.

### Cleaning up old reports

```ts
// Clean up on save: keep reports from the last 30 days, at most 100, at most 500 MB in total;
// never delete baseline reports
await compareImages(a, b, {
  report: {
    dir: "reports",
    meta: { baseline: isBaseline },
    retention: {
      maxAge: 30 * 864e5,
      maxCount: 100,
      maxBytes: 500 * 1024 * 1024,
      keep: (r) => r.meta.baseline === true,
    },
  },
});

// Or clean up separately, for example from a scheduled job
const { removed, freedBytes, kept } = await pruneReports("reports", { maxAge: 30 * 864e5, dryRun: true });
```

- The limits combine: a report that breaks **any** of them is deleted, oldest first. Each removed report's `reason` says which limit applied (`maxAge` / `maxCount` / `maxBytes`).
- The report just saved is **never** deleted, but it counts toward the count and size limits (even `maxCount: 0` keeps it).
- Reports that `keep` returns `true` for are never deleted and **don't** count toward the limits, which suits baseline reports.
- Only directories holding a readable `report.json` are deleted; other files and folders are left alone. Temporary directories left by a crashed save are removed once they're over an hour old.
- `dryRun: true` works out what would be deleted without deleting anything.

## Image downscaling

The TypeSafe API rejects images with a side over **1568px** (`400 Invalid image dimensions`), and token use grows with pixel count. So images are downscaled before upload:

- Longest side ≤ `maxDimension` (default and maximum 1568)
- Total pixels ≤ `maxPixels` (default 1,150,000)
- The aspect ratio is kept; a PNG stays a PNG (dropping alpha when opaque) and a JPEG stays a JPEG (`quality` defaults to 90)
- Images that already fit are sent as they are, without re-encoding

Downscaling averages over area with premultiplied alpha, so thin lines and text stay legible and transparent edges don't darken. Boxes are fractions, and `boxPx` is converted back to the **original** image's pixels, so callers needn't care whether an image was downscaled.

Measured with two same-size screenshots and two differences:

| Original | Uploaded as | Input tokens | Result |
| --- | --- | --- | --- |
| 375×812 | As is | ~13k | Correct |
| 1500×3248 / 2250×4872 | 724×1568 (default) | ~30k | Correct |
| 2250×4872, `maxPixels: 300000` | 372×805 | ~13k | Correct |
| 750×1624, `resize: false` | As is | – | Rejected by the API |

For differences in large UI elements, a smaller `maxPixels` is usually enough; keep the default for details like font weight or 1px borders.

Decoding and encoding are pure JavaScript ([fast-png](https://github.com/image-js/fast-png), [jpeg-js](https://github.com/jpeg-js/jpeg-js)), bundled into `dist` with no native modules such as sharp; see `THIRD_PARTY_LICENSES`. Downscaling a 2250×4872 PNG takes about 0.6 seconds.

## Proxies

TypeSafe isn't available in some regions (HTTP 451). jev-compare reads `HTTPS_PROXY` / `HTTP_PROXY` (either case) itself and honors `NO_PROXY`; `NODE_USE_ENV_PROXY` and `--use-env-proxy` aren't needed:

```sh
# .env
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

Or set it in code, or turn it off with `false`:

```js
await compareImages(a, b, { proxy: "http://127.0.0.1:7890" });
await compareImages(a, b, { proxy: false });
```

On the command line, use `--proxy <url>`, or `--proxy none` to turn it off. The option is ignored when `client` or `clientOptions.fetch` is given.

## How it works

The TypeSafe API only answers structured questions (yes/no, choice, score, box) and doesn't generate free text, so fix suggestions come from templates for each difference type and element type. A comparison runs in two rounds:

1. **First round** (in parallel)
   - **Overview**: the similarity score (see [Scoring](#scoring)), plus a yes/no question for each difference type, reported as `issues`.
   - **Locating**: asks in turn for the most significant difference, the second most significant (somewhere else), and so on; for each, whether it exists, its type, the element type, and where it is in both images. Each 4 differences make one request, and a request over the token limit is split in half and retried.
2. **Refine** (`refine`, one request per difference, in parallel): the region found in the first round is written into the questions so the model looks closely at it, reclassifies it, and boxes the whole affected element. The first round often reads "the button lost its label" as "the button is missing", or boxes one line of text in a card; refining tells `content_missing` from `background_missing` and boxes the whole card. A widened box that no longer covers the original region, swallows another difference, or covers over 25% of the image falls back to the first round's box.

Differences whose boxes mostly overlap (IoU ≥ 0.6) are merged.

### Scoring

`score` combines two independent judgments by the model; `scoreBreakdown` has both:

- **Holistic**: a 10-step rubric with a concrete example at each step (for example "8 - one clear difference in a single component, such as a missing label, background or block of text" and "9 - a small difference in one place, such as a recolored button, a small icon or a slight shift").
- **Extent**: the model's estimate of how much of the image differs (none / <1% / 1–5% / 5–15% / 15–40% / >40%), mapped to 10 / 9.6 / 9 / 8 / 6 / 1 and interpolated between.

`score` is their mean, pulled toward 10 by the probability that the images are identical (so identical images reliably score 10). Each covers the other's blind spot: the holistic judgment tells "same layout, every color changed" apart from "unrelated", and extent keeps a small local difference from costing as much as a large one.

Measured (each image run twice; scores varied by ≤ 0.1):

| Candidate, compared with the original | Previous algorithm | Current |
| --- | --- | --- |
| Identical / same pixels, re-encoded | 10 | 10 |
| Shifted down 2px | 9.1 | 9.5 |
| One button recolored | 8.5 | 9.0 |
| One 4×4px dot | 8.5 | 8.9 |
| Card background missing (test_img2) | 8.7 | 8.9 |
| Button label and card background missing (test_img1) | 7.9 | 8.2 |
| A whole paragraph missing (test_img3) | 7.8 | 7.9 |
| All colors inverted | 6.4 | 3.5 |
| Solid gray | 1.1 | 1.3 |

## Development

```sh
pnpm install
pnpm build       # bundle ESM + CJS + d.ts with Rolldown
pnpm test        # unit tests (no network)
pnpm test:e2e    # call the real API with the images in test/ (reads JEV_KEY from .env)
```

## Releasing (maintainers)

Pushing a version tag publishes to npm through GitHub Actions (`.github/workflows/release.yml`), using npm trusted publishing: no npm token is stored, and a provenance attestation is attached automatically.

```sh
npm version patch          # or minor / major; for a prerelease: npm version prerelease --preid beta
git push --follow-tags     # pushing the v* tag starts the release
```

- The tag must match the version in `package.json`, or the release fails.
- Prereleases (versions with a `-`, such as `v0.2.0-beta.1`) are published under the `next` dist-tag and leave `latest` alone.
- The type check and unit tests run before publishing; with the `JEV_KEY` repository secret set, the real-API end-to-end tests run too (the step shows as skipped without it).
- A GitHub release is created after a successful publish.

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request: the type check and unit tests on Node 22 and 24, and the publint and arethetypeswrong package checks. Pushes to `main` and manual runs from the Actions page also run the real-API end-to-end tests with the `JEV_KEY` secret (pull requests don't, since pull requests from forks don't get secrets).

## License

MIT
