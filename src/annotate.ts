import type { CompareResult } from "./compare.ts";
import { loadImage } from "./image.ts";
import type { ImageInput } from "./image.ts";

export interface AnnotateOptions {
  /** Which image the boxes are drawn on. Default: `candidate`. */
  target?: "candidate" | "reference";
  /** Box stroke color. Default: `#ff3b30`. */
  color?: string;
}

/**
 * Render an SVG of the image with each difference outlined and numbered by rank.
 * The image is embedded, so the SVG can be saved and opened on its own.
 */
export async function annotateDifferences(
  img: ImageInput,
  result: CompareResult,
  options: AnnotateOptions = {},
): Promise<string> {
  const target = options.target ?? "candidate";
  const color = options.color ?? "#ff3b30";
  const loaded = await loadImage(img);
  const { width, height } = loaded;
  const href = `data:image/${loaded.format};base64,${Buffer.from(loaded.bytes).toString("base64")}`;
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 200));
  const font = Math.max(12, Math.round(Math.min(width, height) / 30));

  const marks = result.differences.map((d) => {
    const b = target === "candidate" ? d.boxPx : d.referenceBoxPx;
    const labelY = b.y >= font + 4 ? b.y - 4 : b.y + b.height + font;
    return [
      `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="${stroke}"/>`,
      `<text x="${b.x + 2}" y="${labelY}" font-size="${font}" font-family="sans-serif" font-weight="bold" fill="${color}" stroke="#fff" stroke-width="3" paint-order="stroke">${d.rank}. ${escapeXml(d.typeLabel)}</text>`,
    ].join("");
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image href="${href}" width="${width}" height="${height}"/>` +
    marks.join("") +
    `</svg>`
  );
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
