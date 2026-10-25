import { proxyFetch, resolveProxy } from "./proxy.ts";
import { BadRequestError, image, TypeSafeClient, withAssets } from "@typesafe-ai/sdk";
import type {
  BoxResponse,
  ChoiceResponse,
  NoulResponse,
  Questions,
  ScoreResponse,
  SystemOneResult,
  TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import { shiftFinder } from "./displacement.ts";
import { loadImage } from "./image.ts";
import type { ImageInput, LoadedImage } from "./image.ts";
import { fileCache, requestCacheKey, sha256 } from "./cache.ts";
import type { CacheStore } from "./cache.ts";
import { writeReport } from "./report.ts";
import type { SavedReport, SaveReportOptions } from "./report.ts";
import { prepareImage } from "./resize.ts";
import type { PreparedImage, ResizeOptions } from "./resize.ts";
import {
  aspectSuggestion,
  DIFFERENCE_TYPES,
  differenceQuestions,
  differenceSuggestion,
  elementLabel,
  EXTENT_SCORES,
  shiftSuggestion,
  MAX_DIFFERENCES,
  overviewQuestions,
  refineQuestions,
  stateIntro,
  summaryText,
  typeLabel,
} from "./prompts.ts";
import type { DifferenceType, ElementType, Locale } from "./prompts.ts";
import type { Shift } from "./displacement.ts";

/** A box as fractions (0–1) of the image's width and height. */
export interface NormalizedBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A box in pixels of the image it refers to. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One located difference between the reference and the candidate. */
export interface Difference {
  /** Rank, starting at 1 for the most significant difference. */
  rank: number;
  type: DifferenceType;
  /** Localized label for `type`. */
  typeLabel: string;
  element: ElementType;
  /** Localized label for `element`. */
  elementLabel: string;
  /** Localized fix suggestion. */
  suggestion: string;
  /** Probability, 0–1, that this difference exists. */
  probability: number;
  /** Confidence, 0–1, in the classified `type`. */
  typeConfidence: number;
  /** Where the difference is in the candidate image. */
  box: NormalizedBox;
  boxPx: PixelBox;
  /** Confidence, 0–1, in `box`, or `null` when not reported. */
  boxConfidence: number | null;
  /** Where the difference is in the reference image. */
  referenceBox: NormalizedBox;
  referenceBoxPx: PixelBox;
  /**
   * For a `moved` difference confirmed by matching pixels, how far the element sits in the
   * candidate from its reference position, in candidate pixels (positive is right and down).
   * `null` otherwise.
   */
  shift: { x: number; y: number } | null;
}

/** A kind of difference detected somewhere in the image, with no location. */
export interface Issue {
  type: DifferenceType;
  label: string;
  /** Probability, 0–1, that this kind of difference is present. */
  probability: number;
  suggestion: string;
}

export interface CompareResult {
  /** Similarity score from 1 (completely different) to 10 (identical), one decimal place. */
  score: number;
  /** The model's confidence, 0–1, in the holistic score. */
  scoreConfidence: number;
  /** The judgments `score` is combined from; see `combineScore`. */
  scoreBreakdown: ScoreBreakdown;
  /** Probability, 0–1, that the images are visually identical. */
  identicalProbability: number;
  /** `true` when `identicalProbability` reaches the threshold and no differences were located. */
  identical: boolean;
  /** One-line localized summary. */
  summary: string;
  /** Located differences, most significant first. */
  differences: Difference[];
  /** Kinds of difference detected over the whole image, most likely first. */
  issues: Issue[];
  /** Original sizes, which pixel boxes refer to, and the sizes sent after downscaling. */
  images: {
    reference: ImageSummary;
    candidate: ImageSummary;
  };
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Language of the labels, suggestions and summary. */
  locale: Locale;
  /** API requests this comparison needed, and how many were answered from the cache. */
  requests: { total: number; cached: number };
  /** Where the report was saved, when the `report` option was given. */
  report?: SavedReport;
}

export interface ScoreBreakdown {
  /** How closely the images match overall, 1–10, on a rubric anchored with examples. */
  holistic: number;
  /** How little of the image differs, 1–10, mapped from the estimated fraction that differs. */
  extent: number;
  /** Probability, 0–1, that the images are visually identical. */
  identicalProbability: number;
}

/**
 * Combine the two judgments into the 1–10 score. Each covers the other's blind spot: the
 * holistic rubric tells "same layout, different colors" apart from "unrelated", while extent
 * keeps a small local difference from dragging the score down as far as a large one. The
 * mean is then pulled toward 10 by how likely the images are identical, since neither scale
 * fully commits to its top step.
 */
export function combineScore(b: ScoreBreakdown): number {
  const mean = (b.holistic + b.extent) / 2;
  return round1(clamp(mean * (1 - b.identicalProbability) + 10 * b.identicalProbability, 1, 10));
}

/** Map the expected extent bucket (0 = none … 5 = most of the image) to 1–10, interpolating. */
export function extentScore(bucket: number): number {
  const i = clamp(bucket, 0, EXTENT_SCORES.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, EXTENT_SCORES.length - 1);
  return EXTENT_SCORES[lo]! + (EXTENT_SCORES[hi]! - EXTENT_SCORES[lo]!) * (i - lo);
}

export interface ImageSummary {
  width: number;
  height: number;
  format: string;
  /** Size sent to the API; smaller than `width` × `height` when the image was downscaled. */
  sentWidth: number;
  sentHeight: number;
  resized: boolean;
}

export interface CompareOptions {
  /** TypeSafe API key. Default: `JEV_KEY`, then `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Model name. `box` questions need `jev-preview`. Default: `jev-preview`. */
  model?: string;
  /** Language of labels, suggestions and summary. Default: `zh`. */
  locale?: Locale;
  /** How many ranked differences to look for, 0–8. Default: 4. */
  maxDifferences?: number;
  /** Minimum probability, 0–1, for a difference or issue to be reported. Default: 0.5. */
  threshold?: number;
  /**
   * Look again at each difference found: classify it more precisely and widen its boxes to the
   * whole affected element. Costs one extra request per difference, sent in parallel. Default: true.
   */
  refine?: boolean;
  /** Extra context for the model, such as "a mobile app screen; ignore the status bar". */
  context?: string;
  /**
   * How images are downscaled before upload. The API rejects images whose longest side is over
   * 1568 px, and tokens grow with pixel count. Boxes are returned in the original images' pixels
   * either way. `false` sends the original bytes. Default: longest side 1568, at most 1.15 MP.
   */
  resize?: ResizeOptions | false;
  /** An existing client to use instead of creating one. It must send the image opt-in header. */
  client?: TypeSafeClient;
  /** Options for the created client, such as `baseURL`, `timeout` or a custom `fetch`. */
  clientOptions?: TypeSafeClientConfig;
  /**
   * HTTP proxy for API requests, such as `http://127.0.0.1:7890`, or `false` for none.
   * Default: `HTTPS_PROXY`, then `HTTP_PROXY`; `NO_PROXY` is honored. Ignored when
   * `client` or `clientOptions.fetch` is given.
   */
  proxy?: string | false;
  /**
   * Cache API answers: a directory for an on-disk cache, or any `CacheStore`, such as
   * `memoryCache()` or `fileCache({ dir, ttl })`. Requests are keyed by everything they send
   * (images, model, prompt and questions), so changing `locale` reuses every answer, and
   * changing other options reuses the ones that still apply. Default: no cache.
   */
  cache?: CacheStore | string | false;
  /**
   * Save a report after comparing: a directory to save into, or report options.
   * The result's `report` says where it was written.
   */
  report?: string | SaveReportOptions;
  /** Cancels the comparison. */
  signal?: AbortSignal;
}

const IMAGE_HEADER = { "TypeSafe-Danger-Zone-Images": "true" };
/** Differences per request; requests that still exceed the API's token limit are split further. */
const DIFFERENCES_PER_REQUEST = 4;
/** Differences whose candidate boxes overlap this much are treated as the same one. */
const DUPLICATE_IOU = 0.6;

/** Create a client configured for image comparison. */
export function createClient(options: Pick<CompareOptions, "apiKey" | "clientOptions" | "proxy"> = {}): TypeSafeClient {
  const apiKey = options.apiKey ?? options.clientOptions?.apiKey ?? env("JEV_KEY") ?? env("TYPESAFE_API_KEY");
  const proxy = resolveProxy(options.proxy);
  return new TypeSafeClient({
    timeout: 60_000,
    ...(proxy ? { fetch: proxyFetch(proxy) } : {}),
    ...options.clientOptions,
    apiKey,
    defaultHeaders: { ...IMAGE_HEADER, ...options.clientOptions?.defaultHeaders },
  });
}

/** One difference as the model answered it, before it is turned into a `Difference`. */
interface Finding {
  probability: number;
  type: ChoiceResponse<Record<DifferenceType, string>>;
  element: ChoiceResponse<Record<ElementType, string>>;
  box: BoxResponse;
  refbox: BoxResponse;
  /** Set when matching pixels shows the region is the same content at another position. */
  shift?: Shift;
}

/**
 * Compare a candidate image against a reference image.
 *
 * Returns a 1–10 similarity score, the located differences with boxes in both images,
 * and a fix suggestion for each.
 */
export async function compareImages(
  reference: ImageInput,
  candidate: ImageInput,
  options: CompareOptions = {},
): Promise<CompareResult> {
  const locale = options.locale ?? "zh";
  if (locale !== "zh" && locale !== "en") throw new TypeError(`Unsupported locale: ${String(locale)}`);
  const threshold = options.threshold ?? 0.5;
  if (!(threshold >= 0 && threshold <= 1)) throw new RangeError("threshold must be between 0 and 1");
  const maxDifferences = Math.floor(options.maxDifferences ?? 4);
  if (!(maxDifferences >= 0 && maxDifferences <= MAX_DIFFERENCES)) {
    throw new RangeError(`maxDifferences must be between 0 and ${MAX_DIFFERENCES}`);
  }
  const model = options.model ?? "jev-preview";
  const client = options.client ?? createClient(options);

  const [ref, cand] = await Promise.all([loadImage(reference), loadImage(candidate)]);
  const resize = options.resize ?? {};
  const prepare = (img: LoadedImage): PreparedImage =>
    resize === false ? { bytes: img.bytes, width: img.width, height: img.height, resized: false } : prepareImage(img, resize);
  const refSent = prepare(ref);
  const candSent = prepare(cand);
  const refAsset = image(refSent.bytes);
  const candAsset = image(candSent.bytes);
  const state = withAssets`${stateIntro(options.context)}\nREFERENCE image: ${refAsset}\nCANDIDATE image: ${candAsset}`;

  const usage = { inputTokens: 0, outputTokens: 0 };
  const requests = { total: 0, cached: 0 };
  const cache = typeof options.cache === "string" ? fileCache(options.cache) : options.cache || undefined;
  const intro = stateIntro(options.context);
  const imageHashes = cache ? { referenceSha256: sha256(refSent.bytes), candidateSha256: sha256(candSent.bytes) } : null;

  const ask = async <Q extends Questions>(questions: Q): Promise<SystemOneResult<Q>> => {
    requests.total++;
    const key = imageHashes && requestCacheKey({ model, intro, ...imageHashes, questions });
    if (cache && key) {
      const hit = await safely(() => cache.get(key));
      if (isCachedResult(hit, questions)) {
        requests.cached++;
        return hit as SystemOneResult<Q>;
      }
    }
    const result = await client.systemOne({ state, questions, model }, { signal: options.signal, headers: IMAGE_HEADER });
    usage.inputTokens += result.usage.input_tokens ?? 0;
    usage.outputTokens += result.usage.output_tokens ?? 0;
    if (cache && key) {
      // A failing cache only costs the saving; the comparison still succeeds.
      const value = { model: result.model, answers: result.answers, usage: result.usage };
      await safely(() => cache.set(key, JSON.parse(JSON.stringify(value))));
    }
    return result;
  };

  // Ask for ranked differences `from` to `to - 1`, halving the batch if it is too big for one request.
  const askDifferences = async (from: number, to: number): Promise<Record<string, unknown>> => {
    try {
      return (await ask(differenceQuestions(from, to))).answers;
    } catch (error) {
      if (to - from < 2 || !isTokenLimitError(error)) throw error;
      const mid = from + Math.ceil((to - from) / 2);
      const halves = await Promise.all([askDifferences(from, mid), askDifferences(mid, to)]);
      return Object.assign({}, ...halves);
    }
  };

  const chunks: Array<[number, number]> = [];
  for (let i = 0; i < maxDifferences; i += DIFFERENCES_PER_REQUEST) {
    chunks.push([i, Math.min(maxDifferences, i + DIFFERENCES_PER_REQUEST)]);
  }
  const [overview, ...chunkAnswers] = await Promise.all([
    ask(overviewQuestions()),
    ...chunks.map(([from, to]) => askDifferences(from, to)),
  ]);

  const similarity = overview.answers.similarity as ScoreResponse;
  const identicalProbability = (overview.answers.identical as NoulResponse).noul;
  const breakdown = {
    holistic: round2(similarity.score + 1), // The rubric is 0-indexed.
    extent: round2(extentScore((overview.answers.extent as ScoreResponse).score)),
    identicalProbability,
  };
  const score = combineScore(breakdown);

  const issues: Issue[] = (Object.keys(DIFFERENCE_TYPES) as DifferenceType[])
    .map((type) => ({
      type,
      label: typeLabel(locale, type),
      probability: (overview.answers[`aspect_${type}`] as NoulResponse).noul,
      suggestion: aspectSuggestion(locale, type),
    }))
    .filter((issue) => issue.probability >= threshold)
    .sort((a, b) => b.probability - a.probability);

  const answers: Record<string, unknown> = Object.assign({}, ...chunkAnswers);
  let findings: Finding[] = [];
  for (let i = 0; i < maxDifferences; i++) {
    const probability = (answers[`exists_${i}`] as NoulResponse).noul;
    if (probability < threshold) continue;
    findings.push({
      probability,
      type: answers[`type_${i}`] as Finding["type"],
      element: answers[`element_${i}`] as Finding["element"],
      box: answers[`box_${i}`] as BoxResponse,
      refbox: answers[`refbox_${i}`] as BoxResponse,
    });
  }
  findings = dedupe(findings);

  if (options.refine ?? true) {
    const refined = await Promise.all(
      findings.map(async (finding, i) => {
        const r = (await ask(refineQuestions(normalize(finding.box.box)))).answers as unknown as Omit<Finding, "probability">;
        const others = findings.filter((_, j) => j !== i);
        return {
          ...finding,
          type: r.type,
          element: r.element,
          box: plausibleWidening(finding.box, r.box, others.map((o) => o.box)),
          refbox: plausibleWidening(finding.refbox, r.refbox, others.map((o) => o.refbox)),
        };
      }),
    );
    // Widened boxes can turn two nearby findings into the same element.
    findings = dedupe(refined);
  }

  // The model sees a shifted element as a gap plus an overlap and calls it missing or changed
  // content; matching pixels tells whether the region is the same content somewhere else.
  if (findings.length) {
    const findShift = shiftFinder(ref, cand);
    findings = findings.map((f) => {
      const shift = findShift(normalize(f.box.box), normalize(f.refbox.box));
      if (!shift) return f;
      return {
        ...f,
        type: { ...f.type, choice: "moved", confidence: shift.confidence },
        box: { ...f.box, box: shift.box },
        refbox: { ...f.refbox, box: shift.referenceBox },
        shift,
      };
    });
  }

  const differences: Difference[] = findings.map((f, i) => {
    const box = normalize(f.box.box);
    const referenceBox = normalize(f.refbox.box);
    const shift = f.shift ? { x: Math.round(f.shift.x * cand.width), y: Math.round(f.shift.y * cand.height) } : null;
    return {
      rank: i + 1,
      type: f.type.choice,
      typeLabel: typeLabel(locale, f.type.choice),
      element: f.element.choice,
      elementLabel: elementLabel(locale, f.element.choice),
      suggestion: shift
        ? shiftSuggestion(locale, f.element.choice, shift)
        : differenceSuggestion(locale, f.type.choice, f.element.choice),
      probability: f.probability,
      typeConfidence: f.type.confidence,
      box,
      boxPx: toPixels(box, cand),
      boxConfidence: f.box.confidence,
      referenceBox,
      referenceBoxPx: toPixels(referenceBox, ref),
      shift,
    };
  });

  const result: CompareResult = {
    score,
    scoreConfidence: similarity.confidence,
    scoreBreakdown: breakdown,
    identicalProbability,
    identical: identicalProbability >= threshold && differences.length === 0,
    summary: summaryText(locale, score, differences.length),
    differences,
    issues,
    images: { reference: summarize(ref, refSent), candidate: summarize(cand, candSent) },
    model: overview.model,
    usage,
    locale,
    requests,
  };

  if (options.report) {
    const reportOptions = typeof options.report === "string" ? { dir: options.report } : options.report;
    result.report = await writeReport(
      result,
      { input: reference, loaded: ref },
      { input: candidate, loaded: cand },
      reportOptions,
    );
  }
  return result;
}

/** Run a cache call, turning both sync throws and rejections into `undefined`. */
async function safely<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** Whether a cached value is a usable answer to exactly these questions. */
function isCachedResult(value: unknown, questions: Questions): boolean {
  if (!value || typeof value !== "object") return false;
  const { model, answers } = value as { model?: unknown; answers?: Record<string, { type?: unknown }> };
  if (typeof model !== "string" || !answers || typeof answers !== "object") return false;
  return Object.entries(questions).every(([name, q]) => answers[name]?.type === q.type);
}

/** Drop findings whose candidate box mostly overlaps a higher-ranked one. */
function dedupe(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const box = normalize(f.box.box);
    if (!kept.some((k) => iou(normalize(k.box.box), box) >= DUPLICATE_IOU)) kept.push(f);
  }
  return kept;
}

/** Largest area, as a fraction of the image, a widened box may cover unless the original did. */
const MAX_WIDENED_AREA = 0.25;

/**
 * Keep a widened box only when it still covers the original finding, doesn't swallow another
 * finding, and isn't implausibly large; the model sometimes widens a box to half the page.
 */
function plausibleWidening(original: BoxResponse, widened: BoxResponse, others: BoxResponse[]): BoxResponse {
  const from = normalize(original.box);
  const to = normalize(widened.box);
  const ok =
    contains(to, center(from)) &&
    !others.some((o) => contains(to, center(normalize(o.box)))) &&
    area(to) <= Math.max(MAX_WIDENED_AREA, area(from));
  return ok ? widened : original;
}

function center(b: NormalizedBox): { x: number; y: number } {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

function contains(b: NormalizedBox, p: { x: number; y: number }): boolean {
  return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
}

function area(b: NormalizedBox): number {
  return (b.right - b.left) * (b.bottom - b.top);
}

function isTokenLimitError(error: unknown): boolean {
  return error instanceof BadRequestError && JSON.stringify(error.body ?? "").includes("max_tokens_exceeded");
}

function env(name: string): string | undefined {
  const value = typeof process !== "undefined" ? process.env[name]?.trim() : undefined;
  return value || undefined;
}

function summarize(img: LoadedImage, sent: PreparedImage): ImageSummary {
  return {
    width: img.width,
    height: img.height,
    format: img.format,
    sentWidth: sent.width,
    sentHeight: sent.height,
    resized: sent.resized,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalize(box: NormalizedBox): NormalizedBox {
  const top = clamp(Math.min(box.top, box.bottom), 0, 1);
  const bottom = clamp(Math.max(box.top, box.bottom), 0, 1);
  const left = clamp(Math.min(box.left, box.right), 0, 1);
  const right = clamp(Math.max(box.left, box.right), 0, 1);
  return { top, bottom, left, right };
}

/** Convert a fractional box to pixels of `img`. */
export function toPixels(box: NormalizedBox, img: { width: number; height: number }): PixelBox {
  const x = Math.round(box.left * img.width);
  const y = Math.round(box.top * img.height);
  return {
    x,
    y,
    width: Math.round(box.right * img.width) - x,
    height: Math.round(box.bottom * img.height) - y,
  };
}

/** Intersection over union of two fractional boxes. */
export function iou(a: NormalizedBox, b: NormalizedBox): number {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = w * h;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}
