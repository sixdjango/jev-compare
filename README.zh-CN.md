# jev-compare

[English](https://github.com/sixdjango/jev-compare/blob/main/README.md) | **简体中文**

[![npm](https://img.shields.io/npm/v/jev-compare)](https://www.npmjs.com/package/jev-compare)
[![downloads](https://img.shields.io/npm/dm/jev-compare)](https://www.npmjs.com/package/jev-compare)
[![CI](https://github.com/sixdjango/jev-compare/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sixdjango/jev-compare/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/jev-compare)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/jev-compare)](https://github.com/sixdjango/jev-compare/blob/main/LICENSE)

基于 [TypeSafe AI](https://docs.typesafe.ai/sdk/javascript)（Jev 模型）的图片相似度对比库：

- **1–10 分**相似度打分（10 = 完全一致）
- 定位具体**不一致区域**，同时给出候选图和参考图中的 box（比例坐标 + 像素坐标）
- 对每处差异给出**类型、元素和修改建议**（中文 / 英文）
- 可选输出带标注框的 SVG
- 大图自动压缩后再上传（API 不接受长边超过 1568px 的图片），框坐标仍按原图像素返回
- 报告持久化：保存 JSON + 可离线查看的 HTML 报告，可列出历史报告，按时间 / 数量 / 大小自动清理旧报告
- 缓存：相同输入不重复调用 API（内存 / 磁盘 / 自定义存储），磁盘缓存按过期时间 / 条目数 / 大小自动清理

适合「设计稿 vs 实现截图」的 UI 走查、视觉回归测试等场景。

## 安装

```sh
npm install jev-compare
```

需要 Node.js 22+。API Key 从 `JEV_KEY`（或 `TYPESAFE_API_KEY`）环境变量读取，也可以通过 `apiKey` 传入。开发本仓库时，把 `.env.example` 复制为 `.env` 并填入 Key。

## 使用

```ts
import { compareImages, annotateDifferences } from "jev-compare";
import { writeFile } from "node:fs/promises";

const result = await compareImages("design.png", "screenshot.png", {
  locale: "zh",        // "zh" | "en"
  maxDifferences: 4,   // 最多定位几处差异（0–8）
  threshold: 0.5,      // 概率阈值
  context: "移动端 App 页面，忽略状态栏",
});

console.log(result.score);   // 8.2
console.log(result.summary); // 相似度 8.2/10（高度相似），发现 2 处差异。
for (const d of result.differences) {
  console.log(d.rank, d.typeLabel, d.elementLabel, d.boxPx, d.suggestion);
}

// 在候选图上画出差异框
await writeFile("diff.svg", await annotateDifferences("screenshot.png", result));
```

图片可以是文件路径、`data:` URL、`{ base64 }`、`Uint8Array` / `Buffer` / `ArrayBuffer` 或 `Blob`，只支持 PNG 和 JPEG。

### 返回结果

```jsonc
{
  "score": 8.2,                    // 1–10
  "scoreConfidence": 0.9,
  "scoreBreakdown": { "holistic": 7.75, "extent": 8.65, "identicalProbability": 0.01 },
  "identicalProbability": 0.01,
  "identical": false,
  "summary": "相似度 8.2/10（高度相似），发现 2 处差异。",
  "differences": [
    {
      "rank": 1,
      "type": "content_missing",   // 见下方「差异类型」
      "typeLabel": "内容缺失",
      "element": "button",         // text | button | container | icon | image | input | navigation | other
      "elementLabel": "按钮",
      "suggestion": "按钮还在，但其中的文字、图标等内容缺失，请补全按钮内的内容。",
      "probability": 0.9,          // 该差异存在的概率
      "typeConfidence": 0.97,
      "box": { "top": 0.89, "bottom": 0.96, "left": 0.07, "right": 0.94 },  // 候选图，比例坐标
      "boxPx": { "x": 26, "y": 723, "width": 327, "height": 57 },          // 候选图，像素坐标
      "boxConfidence": 0.74,
      "referenceBox": { /* 参考图中的对应区域 */ },
      "referenceBoxPx": { /* ... */ }
    }
  ],
  "issues": [                      // 全图层面检测到的差异类型（无位置）
    { "type": "content_missing", "label": "内容缺失", "probability": 0.96, "suggestion": "..." }
  ],
  "images": {
    // width/height 是原图尺寸（boxPx 基于它），sentWidth/sentHeight 是压缩后实际上传的尺寸
    "reference": { "width": 375, "height": 812, "format": "png", "sentWidth": 375, "sentHeight": 812, "resized": false },
    "candidate": { /* ... */ }
  },
  "model": "jev-1.14.0",
  "usage": { "inputTokens": 13000, "outputTokens": 1300 },
  "locale": "zh",
  "requests": { "total": 4, "cached": 0 },   // 本次需要的 API 请求数，以及其中命中缓存的数量
  "report": { "id": "20261017-081530-a1b2c3", "dir": "/abs/reports/20261017-081530-a1b2c3", "files": { /* ... */ } }  // 仅在传了 report 选项时
}
```

### 差异类型

| type | 含义 |
| --- | --- |
| `element_missing` | 整个元素缺失 |
| `content_missing` | 元素还在，但里面的文字 / 图标等内容缺失 |
| `background_missing` | 内容还在，但背景 / 卡片容器缺失 |
| `element_extra` | 多出了参考图中没有的元素 |
| `text_changed` | 文字内容不一致 |
| `color_changed` | 颜色不一致 |
| `moved` | 位置 / 对齐 / 间距不一致 |
| `resized` | 尺寸不一致 |
| `font_changed` | 字体 / 字号 / 字重不一致 |
| `icon_changed` | 图标 / 图片不一致 |
| `style_changed` | 边框 / 圆角 / 阴影不一致 |

### 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | `JEV_KEY` / `TYPESAFE_API_KEY` | TypeSafe API Key |
| `model` | `jev-preview` | 定位 box 需要 `jev-preview` |
| `locale` | `zh` | 标签、建议和摘要的语言 |
| `maxDifferences` | `4` | 最多定位几处差异（0–8），每 4 处多发一个并行请求 |
| `threshold` | `0.5` | 差异 / issue 的最低概率 |
| `refine` | `true` | 对每处差异再看一次：更精确地分类，并把框扩到整个受影响的元素。每处差异多 1 个并行请求 |
| `resize` | `{ maxDimension: 1568, maxPixels: 1150000 }` | 上传前的压缩设置，见下文「图片压缩」；`false` 表示发送原图 |
| `cache` | – | 缓存 API 响应：目录字符串（磁盘缓存），或 `memoryCache()` / `fileCache()` / 自定义 `CacheStore`，见下文「缓存」 |
| `report` | – | 对比后保存报告：目录字符串，或 `{ dir, format?, id?, images?, html?, meta?, retention? }`，见下文「报告持久化」 |
| `context` | – | 给模型的额外说明 |
| `client` | – | 复用已有的 `TypeSafeClient`（需带图片 opt-in header，推荐用 `createClient()` 创建） |
| `clientOptions` | – | 传给 `TypeSafeClient` 的配置，如 `baseURL`、`timeout`、自定义 `fetch` |
| `signal` | – | `AbortSignal`，用于取消 |

## 命令行

```sh
JEV_KEY=xxx npx jev-compare design.png screenshot.png --svg diff.svg
npx jev-compare design.png screenshot.png --json --locale en --max 6
npx jev-compare design.png screenshot.png --no-refine   # 更快，但分类和框更粗
npx jev-compare design@3x.png shot@3x.png --max-pixels 300000   # 大图压得更小，省 token
npx jev-compare design.png screenshot.png --report reports --meta page=login --meta build=42
npx jev-compare --list reports            # 列出历史报告（加 --json 输出 JSON）
npx jev-compare a.png b.png --report reports --report-format json  # 只输出 report.json
npx jev-compare a.png b.png --report reports --keep-count 100    # 保存后只保留最新 100 份
npx jev-compare --prune reports --keep-days 30 --keep-mb 500 --dry-run   # 预览清理结果
npx jev-compare design.png screenshot.png --cache .jev-cache   # 相同输入第二次直接读缓存
npx jev-compare a.png b.png --cache .jev-cache --cache-days 30 --cache-mb 200  # 带自动清理的缓存
npx jev-compare --prune-cache .jev-cache --cache-entries 1000                # 立即清理缓存
```

## 缓存

```ts
import { compareImages, fileCache, memoryCache } from "jev-compare";

await compareImages(a, b, { cache: ".jev-cache" });                       // 磁盘缓存
await compareImages(a, b, { cache: fileCache({ dir: ".jev-cache", ttl: 7 * 864e5 }) }); // 7 天过期
const cache = memoryCache({ maxEntries: 500 });                           // 进程内 LRU
await compareImages(a, b, { cache });

// 自定义存储（如 Redis）：实现 get / set 即可，值是普通 JSON
await compareImages(a, b, {
  cache: {
    get: async (key) => JSON.parse((await redis.get(`jev:${key}`)) ?? "null") ?? undefined,
    set: async (key, value) => void (await redis.set(`jev:${key}`, JSON.stringify(value), { EX: 86400 })),
  },
});
```

缓存的是**每一次 API 请求**的响应，而不是整个对比结果。缓存键是请求实际发送内容的 sha256：模型、提示词、两张图（压缩后）的字节、问题列表。因此：

| 改动 | 缓存命中 |
| --- | --- |
| 完全相同的输入 | 全部命中，0 token，约 50ms |
| 只改 `locale` | 全部命中（语言只影响本地生成的文字） |
| 改 `threshold` | 总览和定位请求命中；新超过阈值的差异只需补发精修请求 |
| 改 `maxDifferences` | 定位请求重发；找到的差异不变时，精修请求仍命中 |
| 改 `context` / `model` / `resize`、换图片、库升级改了提示词 | 不命中 |

不需要手工维护「哪些选项影响结果」，也就不会因此返回过期结果。失败的请求不缓存；缓存读写出错（如 Redis 宕机）时自动退化为不缓存，不影响对比。

`fileCache` 每个条目一个 JSON 文件，原子写入，多进程可共享；`clear()` 清空。

### 缓存自动清理

```ts
const cache = fileCache({
  dir: ".jev-cache",
  ttl: 30 * 864e5,          // 写入 30 天后过期
  maxEntries: 5000,         // 最多 5000 条
  maxBytes: 200 * 1024 ** 2, // 最多 200 MB
  // autoPrune: true,        // 设置了任一上限时默认开启
  // pruneInterval: 36e5,    // 两次自动清理至少间隔 1 小时
});
const stats = await cache.prune(); // 也可以手动立即清理
// { expired, evicted, invalid, temp, freedBytes, keptEntries, keptBytes }
```

- **过期**：按写入时间计算，过期条目读取时视为未命中，清理时删除。
- **超出条目数 / 大小**：按**最近最少使用**淘汰。命中缓存时会更新文件时间，所以经常用到的条目会被保留；达到上限后，比它更久没用过的条目全部淘汰。
- **自动清理**：在写入后触发，并通过目录里的 `.last-prune` 标记节流：同一个缓存目录无论有多少进程在用，每个 `pruneInterval` 内最多清理一次。这对每次都是新进程的 CLI 调用很重要，否则每跑一次就要扫描一遍缓存目录。清理失败不影响写入。
- 上限是在清理时执行的，所以两次清理之间缓存可能暂时超出上限；需要严格上限时把 `pruneInterval` 设为 `0`（每次写入都清理，缓存很大时会变慢）。
- 只处理缓存自己的文件（`xx/<sha256>.json`），目录里的其他文件不会被删；损坏的条目和崩溃遗留的临时文件会一并清理。
- `memoryCache` 本身就有 `maxEntries`（LRU）和 `ttl`，不需要额外清理。

> 模型输出本身有一定随机性，开启缓存后同一输入总是返回第一次的结果。想重新判定时换一个缓存目录或调用 `clear()`。

## 报告持久化

```ts
import { compareImages, listReports, loadReport, saveReport } from "jev-compare";

// 对比时直接保存
const result = await compareImages("design.png", "screenshot.png", {
  report: { dir: "reports", meta: { page: "login", commit: "a1b2c3d" } },
});
console.log(result.report.files.html);

// 或者事后保存已有结果
await saveReport(result, "design.png", "screenshot.png", { dir: "reports" });

// 读取和列出
const reports = await listReports("reports", { limit: 20 }); // 最新的在前
const stored = await loadReport(reports[0].dir);              // 目录或 report.json 路径都可以
stored.result.differences;
```

每个报告是一个独立目录：

```
reports/
  20261017-081530-a1b2c3/
    report.json     # schemaVersion、id、createdAt、工具版本、两张图的路径/sha256/尺寸、meta、完整结果
    report.html     # 单文件，图片内嵌，可离线打开或直接发给别人
    reference.png   # 原图副本（images: false 可关闭）
    candidate.png
```

- **只输出 JSON**：`format: "json"`（CLI：`--report-format json`）只写 `report.json`，不生成 HTML、不复制图片，适合 CI 或交给其他程序处理。图片路径、sha256 和完整结果照常记录，`listReports` / 自动清理同样适用。默认 `format: "full"`；单独传 `html` / `images` 会覆盖 `format` 的默认值。
- **ID**：默认是 UTC 时间戳 + 随机后缀，按名字排序就是按时间排序；也可以用 `id` 自己指定（只允许字母、数字、`.`、`_`、`-`），ID 已存在时会报错而不是覆盖。
- **原子写入**：先写到隐藏的临时目录，写完再整体重命名，`listReports` 不会读到写了一半的报告；写入失败会清理临时目录。没有额外的索引文件，并发保存不会互相覆盖。
- **HTML 报告**：左右并排显示参考图和候选图并标出差异框，悬停差异条目会同时高亮两张图里对应的框，支持深色模式和手机宽度。所有文本（包括 `meta`）都会转义。
- **兼容性**：`report.json` 带 `schemaVersion`，`loadReport` 遇到更新版本的格式会报错，而不是返回读错的数据。

### 自动清理旧报告

```ts
// 保存时自动清理：保留 30 天内、最多 100 份、总共不超过 500 MB；基准报告永不删除
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

// 或者单独清理（比如放在定时任务里）
const { removed, freedBytes, kept } = await pruneReports("reports", { maxAge: 30 * 864e5, dryRun: true });
```

- 三条规则可以组合，报告违反**任意一条**就会被删除，从最旧的开始删；返回结果里的 `reason` 说明是因为哪条规则（`maxAge` / `maxCount` / `maxBytes`）。
- 刚保存的报告**一定不会被删**，但会计入数量和大小上限（即使 `maxCount: 0` 也会保留它）。
- `keep` 返回 `true` 的报告不会被删，也**不计入**上限，适合保护基准报告。
- 只删除能正确读出 `report.json` 的报告目录，目录里的其他文件和文件夹不会动。保存中途崩溃留下的临时目录超过 1 小时也会一并清掉。
- `dryRun: true` 只计算将要删除的报告，不实际删除。

## 图片压缩

TypeSafe API 会拒绝长边超过 **1568px** 的图片（`400 Invalid image dimensions`），而且 token 用量大致和像素数成正比。所以上传前会按以下规则缩小图片：

- 长边 ≤ `maxDimension`（默认 1568，也是上限）
- 总像素 ≤ `maxPixels`（默认 1,150,000）
- 保持宽高比；PNG 仍输出 PNG（不透明时去掉 alpha 通道），JPEG 仍输出 JPEG（`quality` 默认 90）
- 已经满足条件的小图原样发送，不重新编码

缩放使用面积平均法，并对 alpha 预乘，细线和文字在缩小后依然清晰，透明边缘也不会发黑。差异框是比例坐标，`boxPx` 会换算回**原图**像素，所以调用方不用关心图片有没有被缩放。

实测（两张同尺寸截图，2 处差异）：

| 原图 | 上传尺寸 | 输入 token | 结果 |
| --- | --- | --- | --- |
| 375×812 | 原样 | ~13k | 正确 |
| 1500×3248 / 2250×4872 | 724×1568（默认） | ~30k | 正确 |
| 2250×4872，`maxPixels: 300000` | 372×805 | ~13k | 正确 |
| 750×1624，`resize: false` | 原样 | – | API 拒绝 |

UI 截图这类大块元素的差异，用较小的 `maxPixels` 通常就够了；要检查字重、1px 边框这类细节，再用默认值。

解码和编码用的是纯 JS 实现（[fast-png](https://github.com/image-js/fast-png)、[jpeg-js](https://github.com/jpeg-js/jpeg-js)），已打包进 dist，不依赖 sharp 之类的原生模块，许可见 `THIRD_PARTY_LICENSES`。2250×4872 的 PNG 缩放约需 0.6 秒。

## 代理

TypeSafe 在部分地区不可用（HTTP 451）。Node.js 自带的 `fetch` 默认不走 `HTTPS_PROXY`，在 Node.js 24+ 上设置 `NODE_USE_ENV_PROXY=1` 即可：

```sh
NODE_USE_ENV_PROXY=1 node app.js
```

如果用 `node --env-file=.env` 加载配置，`NODE_USE_ENV_PROXY` 写在 env 文件里不会生效（读取时机太早），改用 `NODE_OPTIONS`：

```sh
# .env
HTTPS_PROXY=http://127.0.0.1:7890
NODE_OPTIONS=--use-env-proxy
```

或者通过 `clientOptions.fetch` 传入一个支持代理的 `fetch`。

## 原理

TypeSafe API 只回答结构化的问题（是/否、选择、打分、定位框），不生成自由文本，所以修改建议由「差异类型 × 元素类型」的模板生成。一次对比分两轮：

1. **第一轮**（并行）
   - **总览**：给出相似度（见下文「评分」）；另外每种差异类型各问一道 `noul` 题，结果放在 `issues` 里。
   - **定位**：依次询问「第 1 / 第 2 / … 显著的差异（且与前面的位置不同）」，每处差异问：是否存在、差异类型、元素类型，以及在两张图中的位置。每 4 处差异一个请求；超出 token 上限时自动对半拆分重试。
2. **精修**（`refine`，每处差异一个请求，并行）：把第一轮找到的位置写进问题里，让模型盯着那块区域重新分类，并框出整个受影响的元素。第一轮常把「按钮文字没了」判成「按钮缺失」、只框到卡片里的一行字，精修后能区分 `content_missing` / `background_missing` 并框住整张卡片。扩大后的框如果不再覆盖原位置、吞掉了别的差异，或面积过大（> 25%），就退回第一轮的框。

框高度重叠（IoU ≥ 0.6）的差异会去重。

### 评分

`score` 由两个独立的模型判断合成，明细在 `scoreBreakdown` 里：

- **整体（holistic）**：10 档 rubric，每档都带具体例子（如「8 - 单个组件里有一处明显差异，比如缺了标签、背景或一段文字」「9 - 某处有小差异，比如按钮换色、小图标、轻微偏移」）。
- **差异面积（extent）**：模型估计差异占画面的比例（无 / <1% / 1–5% / 5–15% / 15–40% / >40%），映射为 10 / 9.6 / 9 / 8 / 6 / 1 分，中间按比例插值。

`score = 两者平均`，再按「完全一致」的概率向 10 分拉近（所以相同的图稳定得 10 分）。两者互补：整体判断能区分「布局相同但颜色全变」和「完全无关」，面积判断让局部小差异不会被扣得和大面积差异一样多。

实测（每张跑 2 次，波动 ≤ 0.1）：

| 候选图（与原图对比） | 旧算法 | 新算法 |
| --- | --- | --- |
| 完全相同 / 像素相同但重新编码 | 10 | 10 |
| 整体下移 2px | 9.1 | 9.5 |
| 按钮换色 | 8.5 | 9.0 |
| 一个 4×4px 的小点 | 8.5 | 8.9 |
| 卡片背景缺失（test_img2） | 8.7 | 8.9 |
| 按钮文字 + 卡片背景缺失（test_img1） | 7.9 | 8.2 |
| 一整段文字缺失（test_img3） | 7.8 | 7.9 |
| 颜色全部反转 | 6.4 | 3.5 |
| 纯灰色图 | 1.1 | 1.3 |

## 开发

```sh
pnpm install
pnpm build       # Rolldown 打包 ESM + CJS + d.ts
pnpm test        # 单元测试（不访问网络）
pnpm test:e2e    # 用 test/ 里的图片调用真实 API（读取 .env 中的 JEV_KEY）
```

## 发布（维护者）

推送版本 tag 会通过 GitHub Actions 自动发布到 npm（`.github/workflows/release.yml`），使用 npm trusted publishing，不需要保存任何 npm token，并自动附带 provenance 证明：

```sh
npm version patch          # 或 minor / major；预发布用 npm version prerelease --preid beta
git push --follow-tags     # 推送 v* tag 触发发布
```

- tag 必须和 `package.json` 的版本一致，否则发布失败。
- 带 `-` 的预发布版本（如 `v0.2.0-beta.1`）发布到 `next` 标签，不影响 `latest`。
- 发布前会跑类型检查和单元测试；仓库设置了 `JEV_KEY` secret 时还会跑调用真实 API 的端到端测试（没设置时该步骤显示为 skipped）。
- 发布成功后自动创建 GitHub Release。

每次推送到 `main` 和每个 PR 都会跑 CI（`.github/workflows/ci.yml`）：Node 22 / 24 下的类型检查、单元测试，以及 publint、arethetypeswrong 包检查。推送到 `main` 或在 Actions 页面手动运行时，还会用 `JEV_KEY` secret 跑调用真实 API 的端到端测试（PR 不跑，因为 fork 的 PR 拿不到 secret）。

## License

MIT
