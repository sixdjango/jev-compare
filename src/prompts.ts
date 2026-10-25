import { box, choice, noul, score } from "@typesafe-ai/sdk";
import type { BoxQuestion, ChoiceQuestion, NoulQuestion, ScoreQuestion } from "@typesafe-ai/sdk";

export type Locale = "zh" | "en";

/** What kind of difference was found. */
export type DifferenceType =
  | "element_missing"
  | "content_missing"
  | "background_missing"
  | "element_extra"
  | "text_changed"
  | "color_changed"
  | "moved"
  | "resized"
  | "font_changed"
  | "icon_changed"
  | "style_changed";

/** What kind of element the difference is on. */
export type ElementType =
  | "text"
  | "button"
  | "container"
  | "icon"
  | "image"
  | "input"
  | "navigation"
  | "other";

// Each type tells "what is still there" apart from "what is gone", which a coarse "missing"
// category can't: a button that lost its label, and a card that lost its background, need
// different fixes from an element that is gone entirely.
export const DIFFERENCE_TYPES: Record<DifferenceType, string> = {
  element_missing: "a whole element (with its content) that is in the REFERENCE is entirely absent in the CANDIDATE",
  content_missing:
    "the element itself is still there (its shape or background remains), but its text, label, icon or content is missing or empty",
  background_missing:
    "the content (text etc.) is still there, but the element's background, card, fill or container is missing or transparent",
  element_extra: "the CANDIDATE has an extra element that is not in the REFERENCE",
  text_changed: "the text is present in both, but its wording is different",
  color_changed: "the element is present in both, but its color or background color is different",
  moved: "the element is present in both, but its position, alignment or spacing is different",
  resized: "the element is present in both, but its size is different",
  font_changed: "the text is present in both, but its font family, size or weight is different",
  icon_changed: "the icon, logo or picture is present in both, but looks different",
  style_changed: "the element is present in both, but its border, corner radius or shadow is different",
};

export const ELEMENT_TYPES: Record<ElementType, string> = {
  text: "a piece of text, label or paragraph",
  button: "a button",
  container: "a card, panel, container or its background",
  icon: "an icon or logo",
  image: "a photo, illustration or picture",
  input: "an input field, select or form control",
  navigation: "a navigation bar, tab bar, header or toolbar",
  other: "some other element",
};

// Anchored on concrete examples: a vaguer rubric ("nearly identical, one or two clear
// differences") put a stray dot and a missing text block on the same 8–9 step, and rated an
// image with every color inverted 6.4 because its layout was unchanged.
const SIMILARITY_RUBRIC = [
  "1 - unrelated images, or the candidate is blank",
  "2 - only a faint resemblance",
  "3 - some shared elements, but most of the image differs",
  "4 - same kind of screen, but the layout or most elements differ",
  "5 - same layout, but the overall look differs (for example most colors are changed) or many elements differ",
  "6 - several large differences across the image",
  "7 - a few clear differences, or one large missing or changed section",
  "8 - one clear difference in a single component (for example a missing label, background or block of text)",
  "9 - a small difference in one place (for example a recolored button, a small icon, or a slight shift)",
  "10 - identical, or differences so tiny they are hard to spot (a few pixels)",
] as const;

/** Buckets for how much of the image differs, from none to most of it. */
const EXTENT_BUCKETS = [
  "none",
  "under 1% (a few pixels)",
  "1–5% (one small element)",
  "5–15% (one component or section)",
  "15–40% (several sections)",
  "over 40% (most of the image)",
] as const;

/**
 * The 1–10 score for each extent bucket. Small, local differences stay in the 9s; once most
 * of the image differs, the score falls steeply.
 */
export const EXTENT_SCORES: readonly number[] = [10, 9.6, 9, 8, 6, 1];

const ORDINALS = ["most significant", "second most significant", "third most significant", "fourth most significant", "fifth most significant", "sixth most significant", "seventh most significant", "eighth most significant"];

/** The largest number of ranked differences one comparison can ask for. */
export const MAX_DIFFERENCES: number = ORDINALS.length;

/** The `state` text that introduces the two images. */
export function stateIntro(context: string | undefined): string {
  return (
    "You are comparing two images. The REFERENCE image is the expected result (for example a design mockup). " +
    "The CANDIDATE image is the actual result to be checked against it." +
    (context ? `\nAdditional context: ${context}` : "")
  );
}

export interface OverviewQuestions {
  [name: string]: ScoreQuestion | NoulQuestion;
  similarity: ScoreQuestion;
  extent: ScoreQuestion;
  identical: NoulQuestion;
}

/** Overall similarity, an identical check, and a yes/no check per difference type. */
export function overviewQuestions(): OverviewQuestions {
  const questions: OverviewQuestions = {
    similarity: score(
      "How closely does the CANDIDATE match the REFERENCE? Judge how much of the image differs and how noticeable the differences are.",
      SIMILARITY_RUBRIC,
    ),
    extent: score("What fraction of the CANDIDATE image differs visually from the REFERENCE?", EXTENT_BUCKETS),
    identical: noul("Is the CANDIDATE image visually identical to the REFERENCE image, with no visible difference at all?"),
  };
  for (const [type, description] of Object.entries(DIFFERENCE_TYPES)) {
    questions[`aspect_${type}`] = noul(
      `Comparing the CANDIDATE image against the REFERENCE image: is there any place where ${description}?`,
    );
  }
  return questions;
}

export interface DifferenceQuestions {
  [name: string]: NoulQuestion | ChoiceQuestion | BoxQuestion;
}

/** Questions for the ranked differences `from` to `to - 1`: existence, kind, element, and boxes. */
export function differenceQuestions(from: number, to: number): DifferenceQuestions {
  const questions: DifferenceQuestions = {};
  for (let i = from; i < to; i++) {
    const subject =
      `the ${ORDINALS[i]} distinct visual difference between the CANDIDATE and the REFERENCE` +
      (i > 0 ? `, located in a different area from the ${ORDINALS.slice(0, i).join(", ")} difference(s)` : "");
    questions[`exists_${i}`] = noul(`Does ${subject} exist?`);
    questions[`type_${i}`] = choice(`What kind of difference is ${subject}?`, DIFFERENCE_TYPES);
    questions[`element_${i}`] = choice(`Which kind of element is affected by ${subject}?`, ELEMENT_TYPES);
    questions[`box_${i}`] = box(`In the CANDIDATE image, the area of ${subject}`);
    questions[`refbox_${i}`] = box(`In the REFERENCE image, the area of ${subject}`);
  }
  return questions;
}

export interface Region {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Questions that look again at one difference, given where the first pass found it: a closer
 * classification, and boxes widened to the whole affected element.
 */
export function refineQuestions(region: Region): DifferenceQuestions {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const where =
    `the difference located around ${pct(region.top)}–${pct(region.bottom)} from the top ` +
    `and ${pct(region.left)}–${pct(region.right)} from the left of the image`;
  const element = `the whole UI element affected by ${where} (for example the entire card, button or field)`;
  return {
    type: choice(`Look closely at ${where}. Which best describes what differs between the REFERENCE and the CANDIDATE there?`, DIFFERENCE_TYPES),
    element: choice(`Which kind of element is affected by ${where}?`, ELEMENT_TYPES),
    box: box(`In the CANDIDATE image, the full extent of ${element}`),
    refbox: box(`In the REFERENCE image, the full extent of ${element}`),
  };
}

// ---------------------------------------------------------------------------
// Human-readable labels and suggestions

const TYPE_LABELS: Record<Locale, Record<DifferenceType, string>> = {
  zh: {
    element_missing: "元素缺失",
    content_missing: "内容缺失",
    background_missing: "背景/容器缺失",
    element_extra: "多余元素",
    text_changed: "文字内容不一致",
    color_changed: "颜色不一致",
    moved: "位置/间距不一致",
    resized: "尺寸不一致",
    font_changed: "字体样式不一致",
    icon_changed: "图标/图片不一致",
    style_changed: "边框/圆角/阴影不一致",
  },
  en: {
    element_missing: "Missing element",
    content_missing: "Missing content",
    background_missing: "Missing background",
    element_extra: "Extra element",
    text_changed: "Text mismatch",
    color_changed: "Color mismatch",
    moved: "Position/spacing mismatch",
    resized: "Size mismatch",
    font_changed: "Typography mismatch",
    icon_changed: "Icon/image mismatch",
    style_changed: "Border/radius/shadow mismatch",
  },
};

const ELEMENT_LABELS: Record<Locale, Record<ElementType, string>> = {
  zh: {
    text: "文字",
    button: "按钮",
    container: "卡片/容器",
    icon: "图标",
    image: "图片",
    input: "输入框/表单控件",
    navigation: "导航栏",
    other: "元素",
  },
  en: {
    text: "text",
    button: "button",
    container: "card/container",
    icon: "icon",
    image: "image",
    input: "input/form control",
    navigation: "navigation bar",
    other: "element",
  },
};

const SUGGESTIONS: Record<Locale, Record<DifferenceType, (element: string) => string>> = {
  zh: {
    element_missing: (e) => `参考图中的${e}在当前图中整个缺失，请补充该${e}。`,
    content_missing: (e) => `${e}还在，但其中的文字、图标等内容缺失，请补全${e}内的内容。`,
    background_missing: (e) => `${e}中的内容还在，但背景/卡片容器缺失，请补上背景色、圆角、阴影等容器样式。`,
    element_extra: (e) => `当前图中多出了参考图中没有的${e}，请确认是否需要移除。`,
    text_changed: (e) => `${e}的文字内容与参考图不一致，请核对文案（错字、漏字或多余文字）。`,
    color_changed: (e) => `${e}的颜色或背景色与参考图不一致，请对照参考图调整颜色值。`,
    moved: (e) => `${e}的位置、对齐或间距与参考图不一致，请调整布局（margin / padding / 对齐方式）。`,
    resized: (e) => `${e}的尺寸或比例与参考图不一致，请调整宽高。`,
    font_changed: (e) => `${e}的字体、字号或字重与参考图不一致，请调整文字样式。`,
    icon_changed: (e) => `${e}中的图标或图片与参考图不一致，请替换为正确的资源。`,
    style_changed: (e) => `${e}的边框、圆角或阴影与参考图不一致，请调整样式。`,
  },
  en: {
    element_missing: (e) => `The ${e} shown in the reference is entirely missing from the candidate; add it back.`,
    content_missing: (e) => `The ${e} is there, but its text, icon or other content is missing; fill it in.`,
    background_missing: (e) =>
      `The ${e} content is there, but its background or container is missing; restore the background color, radius and shadow.`,
    element_extra: (e) => `The candidate has an extra ${e} that is not in the reference; check whether it should be removed.`,
    text_changed: (e) => `The ${e} wording differs from the reference; check for missing, wrong or extra text.`,
    color_changed: (e) => `The ${e} color or background differs from the reference; match the reference color values.`,
    moved: (e) => `The ${e} position, alignment or spacing differs from the reference; adjust margin, padding or alignment.`,
    resized: (e) => `The ${e} size or proportions differ from the reference; adjust its width and height.`,
    font_changed: (e) => `The ${e} font family, size or weight differs from the reference; adjust the text style.`,
    icon_changed: (e) => `The icon or picture in the ${e} differs from the reference; replace it with the correct asset.`,
    style_changed: (e) => `The ${e} border, corner radius or shadow differs from the reference; adjust the styling.`,
  },
};

const ASPECT_SUGGESTIONS: Record<Locale, Record<DifferenceType, string>> = {
  zh: {
    element_missing: "存在参考图中有、但当前图中整个缺失的元素，请逐项检查并补全。",
    content_missing: "存在元素还在、但其中文字或图标等内容缺失的情况，请检查内容是否渲染。",
    background_missing: "存在内容还在、但背景或卡片容器缺失的情况，请检查容器样式。",
    element_extra: "当前图中存在参考图中没有的元素，请确认是否需要移除。",
    text_changed: "存在文字内容不一致，请核对文案。",
    color_changed: "存在颜色或背景色不一致，请对照参考图调整颜色值。",
    moved: "存在位置、对齐或间距不一致，请检查布局。",
    resized: "存在元素尺寸不一致，请检查宽高。",
    font_changed: "存在字体、字号或字重不一致，请检查文字样式。",
    icon_changed: "存在图标或图片不一致，请检查资源是否正确。",
    style_changed: "存在边框、圆角或阴影不一致，请检查样式。",
  },
  en: {
    element_missing: "Some elements in the reference are entirely missing from the candidate; check and restore them.",
    content_missing: "Some elements are there but their text or icons are missing; check that the content renders.",
    background_missing: "Some content is there but its background or container is missing; check the container styles.",
    element_extra: "The candidate has elements that are not in the reference; check whether they should be removed.",
    text_changed: "Some text differs from the reference; check the copy.",
    color_changed: "Some colors or backgrounds differ from the reference; match the reference color values.",
    moved: "Some positions, alignments or spacings differ; check the layout.",
    resized: "Some element sizes differ; check widths and heights.",
    font_changed: "Some font families, sizes or weights differ; check the text styles.",
    icon_changed: "Some icons or pictures differ; check the assets.",
    style_changed: "Some borders, corner radii or shadows differ; check the styling.",
  },
};

export function typeLabel(locale: Locale, type: DifferenceType): string {
  return TYPE_LABELS[locale][type];
}

export function elementLabel(locale: Locale, element: ElementType): string {
  return ELEMENT_LABELS[locale][element];
}

// The generic templates read as if the element holds text or a background, which is
// nonsense when the element is itself text, so those combinations get their own wording.
const TEXT_ELEMENT_SUGGESTIONS: Record<Locale, Partial<Record<DifferenceType, string>>> = {
  zh: {
    content_missing: "参考图中这里的文字在当前图中缺失（所在区域还在），请补全文案并检查文字是否渲染。",
    background_missing: "文字还在，但文字背后的背景/卡片容器缺失，请补上背景色、圆角、阴影等容器样式。",
  },
  en: {
    content_missing: "The text shown here in the reference is missing from the candidate (the area is still there); restore the copy and check that it renders.",
    background_missing: "The text is there, but the background or card behind it is missing; restore the background color, radius and shadow.",
  },
};

export function differenceSuggestion(locale: Locale, type: DifferenceType, element: ElementType): string {
  const special = element === "text" ? TEXT_ELEMENT_SUGGESTIONS[locale][type] : undefined;
  return special ?? SUGGESTIONS[locale][type](ELEMENT_LABELS[locale][element]);
}

export function aspectSuggestion(locale: Locale, type: DifferenceType): string {
  return ASPECT_SUGGESTIONS[locale][type];
}

export function summaryText(locale: Locale, score: number, differenceCount: number): string {
  const levels: Record<Locale, string[]> = {
    zh: ["完全不同", "差异很大", "差异较大", "部分相似", "比较相似", "高度相似", "几乎一致", "完全一致"],
    en: ["completely different", "very different", "quite different", "partly similar", "fairly similar", "highly similar", "nearly identical", "identical"],
  };
  const thresholds = [2, 3.5, 5, 6.5, 7.5, 8.75, 9.75];
  let level = thresholds.findIndex((t) => score < t);
  if (level < 0) level = thresholds.length;
  const label = levels[locale][level]!;
  if (locale === "zh") {
    return differenceCount
      ? `相似度 ${score}/10（${label}），发现 ${differenceCount} 处差异。`
      : `相似度 ${score}/10（${label}），未发现明显差异。`;
  }
  return differenceCount
    ? `Similarity ${score}/10 (${label}); found ${differenceCount} difference${differenceCount > 1 ? "s" : ""}.`
    : `Similarity ${score}/10 (${label}); no notable differences found.`;
}

/** A fix suggestion for a moved element that says which way, and how far, it moved. */
export function shiftSuggestion(locale: Locale, element: ElementType, shift: { x: number; y: number }): string {
  const e = ELEMENT_LABELS[locale][element];
  const parts: string[] = [];
  if (locale === "zh") {
    if (shift.x) parts.push(`偏${shift.x > 0 ? "右" : "左"} ${Math.abs(shift.x)}px`);
    if (shift.y) parts.push(`偏${shift.y > 0 ? "下" : "上"} ${Math.abs(shift.y)}px`);
    return `${e}比参考图中的位置${parts.join("、")}，请调整布局（margin / padding / 对齐方式）。`;
  }
  if (shift.x) parts.push(`${Math.abs(shift.x)}px too far ${shift.x > 0 ? "right" : "left"}`);
  if (shift.y) parts.push(`${Math.abs(shift.y)}px too ${shift.y > 0 ? "low" : "high"}`);
  return `The ${e} is ${parts.join(" and ")} compared with the reference; adjust margin, padding or alignment.`;
}
