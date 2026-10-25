import type { LoadedImage } from "./image.ts";
import { decodeRgba, resizeRgba } from "./resize.ts";

/** A box as fractions (0–1) of the image's width and height. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far an element sits in the candidate from where it is in the reference, as fractions of
 * the image's width and height. Positive is right and down.
 */
export interface Shift {
  x: number;
  y: number;
  /** How much better the shifted match is than the unshifted one, 0–1. */
  confidence: number;
  /** The matched region in the candidate, and where the same content is in the reference. */
  box: Box;
  referenceBox: Box;
}

interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** Longest side of the grid the whole search window is scanned on. */
const COARSE_SIZE = 256;
/** Longest side of the grid the coarse result is refined on. */
const FINE_SIZE = 1024;
/** How far, as a fraction of each side, an element is looked for from where it was. */
const SEARCH_RANGE = 0.25;
/** Most patch pixels compared per offset on the coarse grid. */
const COARSE_SAMPLES = 3000;
/** A pixel differs when its gray level is off by more than this. */
const PIXEL_TOLERANCE = 24;
/** At least this fraction of the patch must differ in place for a shift to be worth explaining. */
const MIN_CHANGED = 0.02;
/** At most this fraction of the patch may still differ once shifted. */
const MAX_CHANGED_SHIFTED = 0.03;
/** The shifted mean difference must be at most this fraction of the unshifted one. */
const MAX_RESIDUAL = 0.25;
/** Patches flatter than this (gray standard deviation) match anywhere, so they prove nothing. */
const MIN_TEXTURE = 8;

/**
 * Find shifted elements by matching pixels, which the model can't do reliably: a moved element
 * leaves a gap and an overlap that it tends to read as missing or changed content. Returns a
 * function that, for one difference's boxes, says how far that region moved, or `null` when it
 * isn't the same content at another position.
 */
export function shiftFinder(reference: LoadedImage, candidate: LoadedImage): (box: Box, referenceBox: Box) => Shift | null {
  // Both images go on the same grid, so a shift is measured in the fractions both share.
  const grid = (longest: number) => {
    const scale = Math.min(1, longest / Math.max(candidate.width, candidate.height));
    return { width: Math.max(1, Math.round(candidate.width * scale)), height: Math.max(1, Math.round(candidate.height * scale)) };
  };
  const refRgba = decodeRgba(reference);
  const candRgba = decodeRgba(candidate);
  const coarse = grid(COARSE_SIZE);
  const fine = grid(FINE_SIZE);
  const ref = { coarse: grayscale(refRgba, reference, coarse), fine: grayscale(refRgba, reference, fine) };
  const cand = { coarse: grayscale(candRgba, candidate, coarse), fine: grayscale(candRgba, candidate, fine) };

  return (box, referenceBox) => {
    // The element at `box` in the candidate came from somewhere in the reference, or the one
    // at `referenceBox` in the reference went somewhere in the candidate.
    const forward = findMatch(cand, ref, box);
    const backward = findMatch(ref, cand, referenceBox);
    if (forward && (!backward || forward.confidence >= backward.confidence)) {
      return { x: -forward.x, y: -forward.y, confidence: forward.confidence, box, referenceBox: offset(box, forward) };
    }
    if (backward) return { ...backward, box: offset(referenceBox, backward), referenceBox };
    return null;
  };
}

/** Where the content of `box` in `from` best matches in `to`, if only at an offset. */
function findMatch(from: { coarse: Gray; fine: Gray }, to: { coarse: Gray; fine: Gray }, box: Box): Match | null {
  const patch = rect(box, from.fine);
  if (patch.width < 4 || patch.height < 4 || texture(from.fine, patch) < MIN_TEXTURE) return null;
  const still = compare(from.fine, to.fine, patch, 0, 0, 1);
  if (still.changed < MIN_CHANGED) return null;

  const c = coarseMatch(from.coarse, to.coarse, rect(box, from.coarse));
  if (!c) return null;

  // Refine around the coarse offset, scaled up to the fine grid.
  const sx = from.fine.width / from.coarse.width;
  const sy = from.fine.height / from.coarse.height;
  const rx = Math.ceil(sx) + 1;
  const ry = Math.ceil(sy) + 1;
  let best: { dx: number; dy: number; mean: number; changed: number } | null = null;
  for (let dy = Math.round(c.dy * sy) - ry; dy <= Math.round(c.dy * sy) + ry; dy++) {
    for (let dx = Math.round(c.dx * sx) - rx; dx <= Math.round(c.dx * sx) + rx; dx++) {
      if (dx === 0 && dy === 0) continue;
      const m = compare(from.fine, to.fine, patch, dx, dy, 1);
      if (m.mean < (best?.mean ?? Infinity)) best = { dx, dy, ...m };
    }
  }
  if (!best || best.changed > MAX_CHANGED_SHIFTED || best.mean > still.mean * MAX_RESIDUAL) return null;
  return { x: best.dx / from.fine.width, y: best.dy / from.fine.height, confidence: 1 - best.mean / still.mean };
}

/** An offset, as fractions of the image size, at which a region matches. */
interface Match {
  x: number;
  y: number;
  confidence: number;
}

function offset(b: Box, m: Match): Box {
  return { top: b.top + m.y, bottom: b.bottom + m.y, left: b.left + m.x, right: b.right + m.x };
}

/** The offset within the search window where `patch` matches best, scanned on the coarse grid. */
function coarseMatch(from: Gray, to: Gray, patch: Rect): { dx: number; dy: number } | null {
  if (patch.width < 2 || patch.height < 2) return null;
  const step = Math.max(1, Math.floor(Math.sqrt((patch.width * patch.height) / COARSE_SAMPLES)));
  const rx = Math.round(from.width * SEARCH_RANGE);
  const ry = Math.round(from.height * SEARCH_RANGE);
  let best: { dx: number; dy: number; mean: number } | null = null;
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -rx; dx <= rx; dx++) {
      if (dx === 0 && dy === 0) continue;
      const { mean } = compare(from, to, patch, dx, dy, step, best?.mean);
      if (mean < (best?.mean ?? Infinity)) best = { dx, dy, mean };
    }
  }
  return best;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rect(box: Box, g: Gray): Rect {
  const x = Math.max(0, Math.floor(box.left * g.width));
  const y = Math.max(0, Math.floor(box.top * g.height));
  return {
    x,
    y,
    width: Math.min(g.width, Math.ceil(box.right * g.width)) - x,
    height: Math.min(g.height, Math.ceil(box.bottom * g.height)) - y,
  };
}

/**
 * Mean gray difference between `patch` in `a` and the same patch offset by (dx, dy) in `b`, and
 * the fraction of pixels that differ. Offsets that push much of the patch off `b` don't count.
 * Stops early, returning a mean over `bound`, once it can't beat `bound`.
 */
function compare(a: Gray, b: Gray, patch: Rect, dx: number, dy: number, step: number, bound = Infinity): { mean: number; changed: number } {
  const x0 = Math.max(patch.x, -dx);
  const x1 = Math.min(patch.x + patch.width, b.width - dx);
  const y0 = Math.max(patch.y, -dy);
  const y1 = Math.min(patch.y + patch.height, b.height - dy);
  if ((x1 - x0) * (y1 - y0) < 0.8 * patch.width * patch.height) return { mean: Infinity, changed: 1 };
  const total = Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step);
  const limit = bound * total;
  let sum = 0;
  let changed = 0;
  for (let y = y0; y < y1; y += step) {
    const ra = y * a.width;
    const rb = (y + dy) * b.width + dx;
    for (let x = x0; x < x1; x += step) {
      const d = Math.abs(a.data[ra + x]! - b.data[rb + x]!);
      sum += d;
      if (d > PIXEL_TOLERANCE) changed++;
    }
    if (sum > limit) return { mean: Infinity, changed: 1 };
  }
  return { mean: sum / total, changed: changed / total };
}

/** Standard deviation of the gray levels in `patch`. */
function texture(g: Gray, patch: Rect): number {
  let sum = 0;
  let sq = 0;
  for (let y = patch.y; y < patch.y + patch.height; y++) {
    for (let x = patch.x; x < patch.x + patch.width; x++) {
      const v = g.data[y * g.width + x]!;
      sum += v;
      sq += v * v;
    }
  }
  const n = patch.width * patch.height;
  return Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
}

/** Luminance of `rgba`, composited over white and resampled to `size`. */
function grayscale(rgba: Uint8Array, img: { width: number; height: number }, size: { width: number; height: number }): Gray {
  const scaled = size.width === img.width && size.height === img.height ? rgba : resizeRgba(rgba, img.width, img.height, size.width, size.height);
  const data = new Float32Array(size.width * size.height);
  for (let i = 0; i < data.length; i++) {
    const a = scaled[i * 4 + 3]! / 255;
    const lum = 0.299 * scaled[i * 4]! + 0.587 * scaled[i * 4 + 1]! + 0.114 * scaled[i * 4 + 2]!;
    data[i] = lum * a + 255 * (1 - a);
  }
  return { data, width: size.width, height: size.height };
}
