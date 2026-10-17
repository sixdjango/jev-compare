import type { NormalizedBox } from "./compare.ts";
import type { LoadedImage } from "./image.ts";
import type { Locale } from "./prompts.ts";
import type { StoredReport } from "./report.ts";

const TEXT: Record<Locale, Record<string, string>> = {
  zh: {
    title: "图片对比报告",
    reference: "参考图",
    candidate: "候选图",
    differences: "差异",
    issues: "整体问题",
    none: "未发现明显差异。",
    similarity: "相似度",
    probability: "概率",
    box: "位置",
    details: "详情",
    model: "模型",
    tokens: "Token",
    createdAt: "生成时间",
    size: "尺寸",
    sent: "上传尺寸",
    meta: "元数据",
    breakdown: "评分构成",
    holistic: "整体",
    extent: "差异面积",
    identical: "一致概率",
  },
  en: {
    title: "Image comparison report",
    reference: "Reference",
    candidate: "Candidate",
    differences: "Differences",
    issues: "Overall issues",
    none: "No notable differences found.",
    similarity: "Similarity",
    probability: "Probability",
    box: "Box",
    details: "Details",
    model: "Model",
    tokens: "Tokens",
    createdAt: "Created",
    size: "Size",
    sent: "Sent as",
    meta: "Metadata",
    breakdown: "Score breakdown",
    holistic: "holistic",
    extent: "extent",
    identical: "identical",
  },
};

/** Render a report as one self-contained HTML page, with both images embedded. */
export function renderReportHtml(report: StoredReport, reference: LoadedImage, candidate: LoadedImage): string {
  const r = report.result;
  const t = TEXT[r.locale] ?? TEXT.zh;
  const tone = r.score >= 9 ? "good" : r.score >= 6 ? "warn" : "bad";

  const figure = (label: string, img: LoadedImage, pick: (d: (typeof r.differences)[number]) => NormalizedBox) => `
    <figure>
      <figcaption>${esc(label)} <span class="dim">${img.width}×${img.height}</span></figcaption>
      <div class="canvas">
        <img src="${dataUrl(img)}" alt="${esc(label)}">
        ${r.differences.map((d) => overlay(d.rank, pick(d), d.typeLabel)).join("")}
      </div>
    </figure>`;

  const differences = r.differences.length
    ? `<ol class="diffs">${r.differences
        .map(
          (d) => `
        <li class="diff" data-rank="${d.rank}" tabindex="0" id="diff-${d.rank}">
          <span class="badge">${d.rank}</span>
          <div>
            <div class="diff-title">${esc(d.typeLabel)} <span class="dim">· ${esc(d.elementLabel)}</span></div>
            <p>${esc(d.suggestion)}</p>
            <div class="dim small">${t.probability} ${pct(d.probability)} · ${t.box} x=${d.boxPx.x} y=${d.boxPx.y} w=${d.boxPx.width} h=${d.boxPx.height}</div>
          </div>
        </li>`,
        )
        .join("")}</ol>`
    : `<p class="dim">${t.none}</p>`;

  const issues = r.issues.length
    ? `<section><h2>${t.issues}</h2><ul class="issues">${r.issues
        .map(
          (i) => `
        <li><div class="issue-head"><span>${esc(i.label)}</span><span class="dim">${pct(i.probability)}</span></div>
        <div class="bar"><span style="width:${pct(i.probability)}"></span></div>
        <div class="dim small">${esc(i.suggestion)}</div></li>`,
        )
        .join("")}</ul></section>`
    : "";

  const metaRows = Object.entries(report.meta)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(typeof v === "string" ? v : JSON.stringify(v))}</td></tr>`)
    .join("");
  const img = r.images;
  const sent = (s: typeof img.reference) => (s.resized ? `${s.sentWidth}×${s.sentHeight}` : "—");

  return `<!doctype html>
<html lang="${r.locale === "en" ? "en" : "zh-CN"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.title} · ${esc(report.id)}</title>
<style>
:root {
  --bg: #f6f7f9; --surface: #ffffff; --text: #1d2129; --dim: #6b7280; --line: #e5e7eb;
  --mark: #ff3b30; --mark-fill: rgba(255, 59, 48, .12); --active: #2563eb; --active-fill: rgba(37, 99, 235, .18);
  --good: #15803d; --warn: #b45309; --bad: #b91c1c;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111318; --surface: #1a1d24; --text: #e6e8eb; --dim: #9aa1ab; --line: #2b2f38;
    --mark: #ff6b61; --mark-fill: rgba(255, 107, 97, .14); --active: #60a5fa; --active-fill: rgba(96, 165, 250, .22);
    --good: #4ade80; --warn: #fbbf24; --bad: #f87171;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; gap: 20px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.dim { color: var(--dim); }
.small { font-size: 12px; }
.score { text-align: center; padding: 10px 18px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); }
.score b { display: block; font-size: 32px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.score.good b { color: var(--good); } .score.warn b { color: var(--warn); } .score.bad b { color: var(--bad); }
.layout { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px; align-items: start; }
.figures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
section, figure { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 0; }
section + section { margin-top: 16px; }
figcaption { font-weight: 600; margin-bottom: 8px; }
.canvas { position: relative; line-height: 0; }
.canvas img { width: 100%; height: auto; border-radius: 6px; }
.box { position: absolute; border: 2px solid var(--mark); background: var(--mark-fill); border-radius: 3px; cursor: pointer; transition: background .15s, border-color .15s; }
.box span { position: absolute; top: -10px; left: -10px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--mark); color: #fff; font: 600 12px/20px sans-serif; text-align: center; }
.box.active { border-color: var(--active); background: var(--active-fill); z-index: 1; }
.box.active span { background: var(--active); }
.diffs { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.diff { display: flex; gap: 10px; padding: 10px; border-radius: 8px; border: 1px solid var(--line); outline: none; }
.diff.active, .diff:focus-visible { border-color: var(--active); background: var(--active-fill); }
.diff p { margin: 2px 0 4px; }
.diff-title { font-weight: 600; }
.badge { flex: none; width: 22px; height: 22px; border-radius: 11px; background: var(--mark); color: #fff; font: 600 12px/22px sans-serif; text-align: center; }
.issues { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.issue-head { display: flex; justify-content: space-between; }
.bar { height: 4px; border-radius: 2px; background: var(--line); margin: 4px 0; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--warn); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; word-break: break-all; }
th { color: var(--dim); font-weight: 500; width: 35%; padding-right: 8px; }
@media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 520px) { .figures { grid-template-columns: minmax(0, 1fr); } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${t.title}</h1>
      <div>${esc(r.summary)}</div>
      <div class="dim small">${esc(report.id)} · ${esc(report.createdAt)}</div>
    </div>
    <div class="score ${tone}"><b>${r.score}</b><span class="dim small">${t.similarity} / 10</span></div>
  </header>
  <div class="layout">
    <div class="figures">
      ${figure(t.reference, reference, (d) => d.referenceBox)}
      ${figure(t.candidate, candidate, (d) => d.box)}
    </div>
    <div>
      <section><h2>${t.differences} (${r.differences.length})</h2>${differences}</section>
      ${issues}
      <section>
        <h2>${t.details}</h2>
        <table>
          <tr><th>${t.breakdown}</th><td>${t.holistic} ${r.scoreBreakdown.holistic} · ${t.extent} ${r.scoreBreakdown.extent} · ${t.identical} ${pct(r.scoreBreakdown.identicalProbability)}</td></tr>
          <tr><th>${t.model}</th><td>${esc(r.model)}</td></tr>
          <tr><th>${t.tokens}</th><td>${r.usage.inputTokens} / ${r.usage.outputTokens}</td></tr>
          <tr><th>${t.reference} ${t.size}</th><td>${img.reference.width}×${img.reference.height} ${esc(img.reference.format)} · ${t.sent} ${sent(img.reference)}</td></tr>
          <tr><th>${t.candidate} ${t.size}</th><td>${img.candidate.width}×${img.candidate.height} ${esc(img.candidate.format)} · ${t.sent} ${sent(img.candidate)}</td></tr>
          ${report.inputs.reference.path ? `<tr><th>${t.reference}</th><td>${esc(report.inputs.reference.path)}</td></tr>` : ""}
          ${report.inputs.candidate.path ? `<tr><th>${t.candidate}</th><td>${esc(report.inputs.candidate.path)}</td></tr>` : ""}
          <tr><th>${t.createdAt}</th><td>${esc(report.createdAt)}</td></tr>
          <tr><th>jev-compare</th><td>${esc(report.tool.version)}</td></tr>
        </table>
        ${metaRows ? `<h2 style="margin-top:12px">${t.meta}</h2><table>${metaRows}</table>` : ""}
      </section>
    </div>
  </div>
</main>
<script>
(() => {
  const all = (rank) => document.querySelectorAll('[data-rank="' + rank + '"]');
  const set = (rank, on) => all(rank).forEach((el) => el.classList.toggle("active", on));
  document.querySelectorAll("[data-rank]").forEach((el) => {
    const rank = el.dataset.rank;
    el.addEventListener("mouseenter", () => set(rank, true));
    el.addEventListener("mouseleave", () => set(rank, false));
    el.addEventListener("focus", () => set(rank, true));
    el.addEventListener("blur", () => set(rank, false));
    if (el.classList.contains("box")) {
      el.addEventListener("click", () => document.getElementById("diff-" + rank)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
  });
})();
</script>
</body>
</html>
`;
}

function overlay(rank: number, b: NormalizedBox, label: string): string {
  const style = `left:${pct(b.left)};top:${pct(b.top)};width:${pct(b.right - b.left)};height:${pct(b.bottom - b.top)}`;
  return `<div class="box" data-rank="${rank}" style="${style}" title="${rank}. ${esc(label)}"><span>${rank}</span></div>`;
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function dataUrl(img: LoadedImage): string {
  return `data:image/${img.format};base64,${Buffer.from(img.bytes).toString("base64")}`;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
