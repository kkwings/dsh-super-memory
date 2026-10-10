/**
 * dsh-super-memory — 未命中诊断（纯本地，0 模型调用、0 token）
 *
 * 为什么需要它：本地词法检索"没命中"时，用户唯一的感受是"这插件不灵"，
 * 而原因可能是完全不同的三种情况，修法也完全不同：
 *
 *   ① `not-ingested` —— 关键词在**库里从未出现**：内容根本没进库
 *      （压缩开关关了、工具结果没收、或者这段内容还没被压缩过）
 *   ② `scattered` —— 关键词出现过、但分散在多个块里，没有一块单独越过阈值：
 *      切块或打分问题
 *   ③ `below-threshold` —— 分数接近但没过线：阈值偏高
 *
 * 额外产出：把候选（含未过阈值的）连同用户的判定记到 `_pairs.jsonl`，
 * 这是"改造到底有没有用"的唯一客观依据。
 */
import { estimateTokens, tokenSet, tokenize } from './text.js';

/** 一行摘要的长度上限（面板展示用）。 */
const PREVIEW_CHARS = 120;

/** 把块正文压成一行预览。 */
function previewOf(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= PREVIEW_CHARS ? line : `${line.slice(0, PREVIEW_CHARS)}…`;
}

/**
 * 全库扫描：查询词在库里出现了多少、出现在哪。
 * @param {object[]} records - 库里的全部记录。
 * @param {string} query - 用户提问。
 * @returns {{total:number, present:number, absent:string[], byRecord:Map<string, number>}} 统计。
 */
export function scanLibrary(records, query) {
  const queryTokens = [...tokenSet(query)];
  const byRecord = new Map();
  const present = new Set();
  for (const record of records) {
    const haystack = `${record.title ?? ''}\n${(record.keywords ?? []).join(' ')}\n${record.text ?? ''}`;
    const tokens = tokenSet(haystack);
    let hits = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) { hits += 1; present.add(token); }
    }
    if (hits > 0) byRecord.set(record.fp, hits);
  }
  return {
    total: queryTokens.length,
    present: present.size,
    absent: queryTokens.filter((token) => !present.has(token)),
    byRecord,
  };
}

/**
 * 诊断一次"未命中"。
 *
 * @param {object} input - 输入。
 * @param {object[]} input.records - 库里全部记录（建议限定在某个工作区）。
 * @param {Function} input.search - `(query, options) => hits[]`，用库的检索器（不过阈值）。
 * @param {string} input.query - 用户提问。
 * @param {number} input.minScore - 当前阈值。
 * @param {number} [input.limit] - 候选条数（§7.4：给 8–10 条）。
 * @param {object[]} [input.shadowedTexts] - 被压掉但**没入库**的原文片段（用于判断"入库时机"）。
 * @returns {object} 诊断结果。
 */
export function diagnoseMiss(input) {
  const records = Array.isArray(input.records) ? input.records : [];
  const query = String(input.query ?? '');
  const limit = Math.max(1, Math.min(20, Number(input.limit) || 10));
  const minScore = typeof input.minScore === 'number' ? input.minScore : 0;
  const scan = scanLibrary(records, query);

  let hits = [];
  try { hits = input.search(query, { limit: Math.max(limit, 10) }) ?? []; } catch { hits = []; }
  const candidates = hits.slice(0, limit).map((hit) => ({
    fp: hit.record?.fp ?? '',
    title: hit.record?.title ?? '',
    layer: hit.record?.layer ?? '',
    src: hit.record?.src ?? '',
    tool: hit.record?.tool ?? '',
    at: hit.record?.at ?? '',
    score: Math.round((hit.score ?? 0) * 10000) / 10000,
    chars: String(hit.record?.text ?? '').length,
    preview: previewOf(hit.record?.text),
  }));
  const best = candidates.length > 0 ? candidates[0].score : 0;

  // 三种原因：库里没有 / 有但没排上来 / 就在被压掉的原文里（说明是入库时机问题）
  let verdict = 'absent';
  let advice = '';
  if (scan.present === 0) {
    const inShadowed = Array.isArray(input.shadowedTexts) && input.shadowedTexts.some((text) => {
      const tokens = tokenSet(text);
      return scan.absent.some((token) => tokens.has(token));
    });
    if (inShadowed) {
      verdict = 'not-ingested';
      advice = '这些词在"被压缩掉的原文"里出现过，但库里没有 —— 属于入库环节（压缩开关 / 工具结果开关 / 是否已被压缩）。';
    } else {
      verdict = 'absent';
      advice = '库里完全没有这些词：这段内容可能还没被压缩过（记忆只覆盖已压缩的部分），或者根本没进过上下文。';
    }
  } else if (best < minScore) {
    verdict = 'scattered';
    advice = `有 ${scan.present}/${scan.total} 个查询词在库里出现过，但最高的块只有 ${best}（阈值 ${minScore}）——属于切块或打分问题：内容在库里，只是没被排上来。`;
  } else {
    verdict = 'above-threshold';
    advice = `最高的块 ${best} 已经越过阈值 ${minScore}：这次应当命中；如果实际没注入，请看诊断日志里的 reason。`;
  }

  return {
    query,
    verdict,
    advice,
    queryTokens: { total: scan.total, present: scan.present, absent: scan.absent.slice(0, 20) },
    scanned: { records: records.length, sessions: new Set(records.map((r) => r.session)).size },
    candidates,
    tokensEst: estimateTokens(query),
  };
}

/* ── ✕ 通道的**分页挑选**（2026-10-08）────────────────────────────────────────
 * 为什么要有这一节（用户实测的失效案例）：
 *   用户问"我最早对设置面板要求的原话是什么？"——他要找的是**本会话第一条消息**
 *   （里面有"必须带设置面板：注入开关 / 入库开关 / 可自调成本上限 / 本地记忆管理…"）。
 *   旧实现只把**本地词面分数最高的 3 条、每条 100 字**喂给辅助模型，而正确的那条
 *   字面上没有"最早"二字（"最早"是**意思**，不是词）→ 词面分数更低 → **根本没被送进
 *   候选** → 模型只能在错的里挑，还回一句"找到相关内容"。
 *   修法：候选按页喂，**每页 30 条**、每条带"序号 + 时间 + 标题 + 首句"，
 *   模型只做一件事：从**本页**挑出最可能直接回答的那一条（回序号），或回 `NONE`（本页没有）。
 *   `NONE` → 翻下一页；扫完全部页仍无 → 如实报"未搜索到强相关内容"（绝不硬凑）。
 *
 * 这里全是**纯函数**（不碰磁盘、不调模型），所以能被 `scripts/unit.mjs` 直接钉住；
 * 真正的调用循环在 `lib/llm.js` 的 `selectPages`（那是唯一花钱的地方）。
 */

/** 每页候选条数（用户定的口径：30 条/页）。 */
export const PAGE_SIZE = 30;
/** 每页最多翻几页（页数上限；设置里可调）。 */
export const PAGE_LIMIT = 4;
/** 页内"首句"截断长度（字符）。 */
export const PAGE_SNIPPET_CHARS = 60;
/** 页内标题截断长度（字符）。 */
export const PAGE_TITLE_CHARS = 40;
/** 单页字符数上限：超过就**少放几条**（宁可这页少看几条，也不让一页把成本顶翻）。 */
export const PAGE_MAX_CHARS = 4000;
/** 模型"本页没有"的回答（大小写不敏感）。 */
export const PAGE_NONE = 'NONE';
/**
 * 模型"只回一个序号"的硬约束（输出上限，token）。
 * 与 `llmRewriteMaxTokens` 同口径：额度给多了模型会拿它写解释，反而被当成格式错丢掉。
 */
export const PAGE_PICK_MAX_TOKENS = 8;

/** 把块正文压成"首句"：折行成一行、截断到 `chars`（超长补省略号）。 */
export function snippetOf(text, chars = PAGE_SNIPPET_CHARS) {
  const limit = Math.max(8, Number(chars) || PAGE_SNIPPET_CHARS);
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/**
 * 来源时间的**短形式**（`YYYY-MM-DD HH:mm`，本地时区）。
 *
 * 为什么不直接给 ISO：时间在这里只用来帮模型判断"哪条更早/更晚"（"最早"这类意思是
 * 靠**时间**落地，不靠词），秒与毫秒是纯噪声、还占 token。
 * @param {unknown} at - 记录里的 `at`（ISO 字符串）。
 * @returns {string} 短时间；解析不出来返回 ''（那一行就不带时间，不造假）。
 */
export function timeLabelOf(at) {
  const ms = Date.parse(String(at ?? ''));
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 构造一页（每页 ≤ `pageSize` 条，字符数 ≤ `PAGE_MAX_CHARS`）。
 *
 * 每条给：**页内序号 + 来源时间 + 标题 + 首句**。序号是页内序号（1 起），
 * 所以"模型回 7"永远指**本页第 7 条**，不需要跨页推断。
 * 记录里没有正文/标题的条目直接跳过（喂空行只会浪费 token）。
 * @param {object[]} records - 候选记录（调用方已按本地分数降序排好）。
 * @param {number} offset - 本页从第几条开始（`page * pageSize`）。
 * @param {object} [options] - `{pageSize, snippetChars, titleChars, maxChars}`。
 * @returns {{page:number, offset:number, items:{fp:string,title:string,snippet:string,time:string,chars:number}[], chars:number, skipped:number, more:boolean}} 一页。
 */
export function buildPage(records, offset, options = {}) {
  const pageSize = Math.max(1, Number(options.pageSize) || PAGE_SIZE);
  const snippetChars = Math.max(8, Number(options.snippetChars) || PAGE_SNIPPET_CHARS);
  const titleChars = Math.max(4, Number(options.titleChars) || PAGE_TITLE_CHARS);
  const maxChars = Math.max(200, Number(options.maxChars) || PAGE_MAX_CHARS);
  const list = Array.isArray(records) ? records : [];
  const start = Math.max(0, Number(offset) || 0);
  const items = [];
  let chars = 0;
  let index = start;
  while (index < list.length && items.length < pageSize) {
    const record = list[index] ?? {};
    index += 1;
    const text = String(record.text ?? '').trim();
    if (text === '') continue;              // 空块喂给模型只会浪费额度
    const title = snippetOf(record.title ?? '', titleChars);
    const snippet = snippetOf(text, snippetChars);
    const time = timeLabelOf(record.at);
    // 这一行真正会占多少字符（与 formatPage 的拼法一致，含序号/换行）
    const cost = title.length + snippet.length + time.length + 12;
    if (items.length > 0 && chars + cost > maxChars) break;
    // 条目上挂**记录本体**：模型只看到上面那行短文本，选中后调用方直接取完整正文
    // （注入/摘抄都靠它）。挂在这里而不是"按偏移重算索引"：上面有 `continue`（空块被跳过），
    // `offset + index` 会指错记录 —— 那等于把 A 的正文配到 B 的编号上。
    items.push({ fp: String(record.fp ?? ''), title, snippet, time, chars: cost, record });
    chars += cost;
  }
  return {
    page: Math.floor(start / pageSize),
    offset: start,
    items,
    chars,
    skipped: index - start - items.length,
    // 还有没被装进本页的候选（调用方据此决定要不要继续翻）
    more: index < list.length,
  };
}

/**
 * 一页的**正文**（喂给模型的候选清单；`buildPagePrompt` 用它拼提示词）。
 *
 * 形如：
 * ```
 * [1] 2026-10-08 09:12 · 必须带设置面板：注入开关 / 入库开关 …
 * [2] 2026-10-08 10:03 · 控制面板的 UI 做成三个板块 …
 * ```
 * @param {object} page - `buildPage` 的结果。
 * @returns {string} 清单文本。
 */
export function formatPage(page) {
  const items = Array.isArray(page?.items) ? page.items : [];
  return items
    .map((item, index) => `[${index + 1}]${item.time === '' ? '' : ` ${item.time} ·`} ${item.title}：${item.snippet}`)
    .join('\n');
}

/**
 * 挑选页的系统提示词（**只做一件事**：从本页挑一条，或回 `NONE`）。
 *
 * ⚠️ 里面**不许出现任何查询词**：这段是固定文本，查询只经 `buildPagePrompt` 的用户消息
 * 传进来（用户明确否决"主模型/插件编词"——`scripts/unit.mjs` 有一条断言逐个核对
 * 这段提示词里不含查询里的任何 token，改坏了就红）。
 * @returns {string} 系统提示词。
 */
export function pagePickSystem() {
  return '下面会给你用户的问题，以及一批**历史片段**（每行一条，行首是编号）。'
    + '你只做一件事：从本页里挑出**最可能直接回答这个问题**的那一条（包括"用户当初是怎么要求/怎么说的"这类回忆性问题）。'
    + '判断依据是**意思**，不是字面重合：片段里没有出现问题里的词，也完全可能是正确的答案；'
    + '凡是比字面更具体、更确定地回答了问题的，就选它。'
    + `如果本页确实没有能回答问题的片段，回答 ${PAGE_NONE}。`
    + `只输出一个编号（例如 7）或 ${PAGE_NONE}，不要解释、不要输出其它任何字符。`;
}

/* ── ✕ 通道的**关键词集中**（2026-10-10，用户第 4 条）──────────────────────────
 * 问题：长问题（1,000+ 字、含多个散落话题）经过查询改写后，模型会把散落各处的词
 *   都拉进来当关键词 —— 等于"第 5 字与第 900 字一起当关键词"，而它们关联性低。
 * 修法：让辅助模型**先指出"这个问题最关键的问题点在哪"**，再**只在该处附近提炼关键词**，
 *   并**输出结构化**（`{"点": "…", "关键词": [...]}`），解析时**只取 `关键词` 字段**。
 *
 * ⚠️ 与"只许加不许替换"的既有约束的关系（`scripts/unit.mjs` 有断言钉着）：
 *   这里改的是 `rewriteQuery`（**追加**关键词的那条路），它**不替换**原文那一路 ——
 *   原文查询照旧检索，改写的词只是**额外**多跑一遍并合并候选（`lib/routes.js` 里
 *   `report.candidates.push` 用的是"没见过的才加"）。所以"集中"不会丢信息。
 *
 * ⚠️ 提示词里**不许出现任何查询词**（既有断言逐个 token 核对）：这段是固定文本。
 * @returns {string} 系统提示词。
 */
export function focusedRewriteSystem() {
  return '把用户的问题改写成 5–10 个关键词或短语，用来做本地关键词检索。'
    + '**先在心里确定"这个问题最关键的问题点在哪"**（问题里可能只有一两处是真正要问的，'
    + '其余是背景、寒暄或另一个话题），然后**只在该处附近**提炼关键词 —— '
    + '不要把问题里散落各处、彼此无关的词都收进来。'
    + '要求：关键词必须来自问题原文（不要自己编新词）；包含同义词与口语说法；'
    + '可以用一个问题里最集中的那 1–2 处作为来源。'
    + '只输出严格 JSON 对象，形如 {"点": "最关键的问题点（一句话）", "关键词": ["…"]}；'
    + '不要解释、不要 Markdown 代码块。';
}

/**
 * 解析"集中关键词"的结构化输出；**兼容旧的纯数组**（旧缓存/旧模型行为不许变坏）。
 *
 * 判据顺序：
 *   ① 先按**对象**解析（新口径），只取 `关键词` / `keywords` 字段；
 *   ② 不是对象就按**数组**解析（旧口径，`parseJsonArray` 的口径）；
 *   ③ 两者都不是 → `null`（调用方据此回 `BAD_OUTPUT`，绝不硬凑）。
 * @param {string} text - 模型输出。
 * @returns {{point:string, terms:string[]}|null} 结果。
 */
export function parseFocusedRewrite(text) {
  const raw = String(text ?? '');
  const parsed = parseJsonObjectLoose(raw);
  if (parsed !== null) {
    for (const key of ['关键词', 'keywords', 'terms']) {
      const value = parsed[key];
      if (!Array.isArray(value)) continue;
      const terms = value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().slice(0, 24))
        .filter((item) => item !== '')
        .slice(0, 12);
      if (terms.length > 0) {
        const point = typeof parsed['点'] === 'string' ? parsed['点'].trim().slice(0, 120) : '';
        return { point, terms };
      }
    }
    return null;
  }
  const list = parseJsonArrayLoose(raw);
  if (list === null || list.length === 0) return null;
  return { point: '', terms: list };
}

/** 从输出里抠第一个 JSON 对象（与 `lib/llm.js` 的 `parseJsonObject` 同口径的**局部副本**：
 *  这里不能反向 import `llm.js` —— 它会 import 本文件，形成环）。 */
export function parseJsonObjectLoose(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** 从输出里抠第一个 JSON 数组（**局部副本**，理由同上）。 */
export function parseJsonArrayLoose(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().slice(0, 24))
      .filter((item) => item !== '')
      .slice(0, 12);
  } catch { return null; }
}

/**
 * **关键词集中度**指标（前后对比用；纯函数、可单测）。
 *
 * 定义：把 `terms` 里每个词在**问题原文**里第一次出现的位置收集起来，
 * ```json
 * { hits: 3, span: 820, first: 5, last: 825, spanRatio: 0.82, clusters: 2 }
 * ```
 *   · `hits`  = 能在原文里定位到的词数（定位不到的**不计入**跨度，但计入 `missing`）；
 *   · `span`  = 最后一次出现 − 第一次出现（字符）；
 *   · `spanRatio` = `span / 原文字符数`（**0 附近 = 关键词集中在一处**，接近 1 = 散落全篇）；
 *   · `clusters` = 按 `gap`（默认 200 字符）聚类出的簇数 —— 用户要的"1–2 处"就是这个数。
 *
 * 为什么用"首尾距离 / 原文字符数"这个归一化指标：用户明确要求给出"关键词跨度 / 首尾距离"
 * 的前后对比。除以原文字符数是为了让 1,000 字与 2,000 字的问题可比。
 * @param {string} query - 问题原文。
 * @param {string[]} terms - 关键词。
 * @param {object} [options] - `{gap}`，聚类间隙（字符），默认 200。
 * @returns {{hits:number, missing:number, first:number, last:number, span:number, spanRatio:number, clusters:number}} 指标。
 */
export function keywordConcentration(query, terms, options = {}) {
  const text = String(query ?? '');
  const gap = Math.max(1, Number(options.gap) || 200);
  const positions = [];
  let missing = 0;
  for (const term of Array.isArray(terms) ? terms : []) {
    const needle = String(term ?? '').trim();
    if (needle === '') continue;
    const at = text.indexOf(needle);
    if (at < 0) { missing += 1; continue; }
    positions.push(at);
  }
  if (positions.length === 0) {
    return { hits: 0, missing, first: -1, last: -1, span: 0, spanRatio: 0, clusters: 0 };
  }
  positions.sort((a, b) => a - b);
  const first = positions[0];
  const last = positions[positions.length - 1];
  const span = last - first;
  let clusters = 1;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] - positions[i - 1] > gap) clusters += 1;
  }
  return {
    hits: positions.length,
    missing,
    first,
    last,
    span,
    spanRatio: text.length === 0 ? 0 : Number((span / text.length).toFixed(4)),
    clusters,
  };
}

/**
 * 一页的用户消息（问题原文 + 本页清单）。
 *
 * @param {string} query - **用户提问原文**（一字不改、一字不加）。
 * @param {object} page - `buildPage` 的结果。
 * @returns {string} 用户消息文本。
 */
export function buildPagePrompt(query, page) {
  const items = Array.isArray(page?.items) ? page.items : [];
  const list = formatPage(page);
  return `问题：${String(query ?? '')}\n\n`
    + `本页候选（第 ${Number(page?.page ?? 0) + 1} 页，共 ${items.length} 条，编号是**本页**的）：\n`
    + `${list === '' ? '(本页没有候选)' : list}\n\n`
    + `请只回答本页里最可能直接回答该问题的那一条的编号；`
    + `本页都没有就回答 ${PAGE_NONE}。`;
}

/**
 * 解析模型对一页的回答。
 *
 * 判据（三个方向都必须能被区分，调用方据此写不同诊断）：
 *   · 抽出数字且落在 `1..count` → `found`（`index` 是**页内序号**）；
 *   · 显式写了 `NONE`（大小写不敏感，容忍"是 NONE。"这类噪声）→ `none`；
 *   · 其它任何东西（"第7条"里只有一个 7 也算数字，但"7 和 8"这种多数字**不算**）→ `unclear`。
 * 多数字判成 `unclear` 而不是"取第一个"：那是模型在解释，硬取一个等于替它编答案。
 * @param {unknown} text - 模型输出。
 * @param {number} count - 本页条数。
 * @returns {{kind:'found'|'none'|'unclear'|'empty', index:number, raw:string}} 解析结果。
 */
export function parsePagePick(text, count) {
  const raw = String(text ?? '').trim();
  const total = Math.max(0, Number(count) || 0);
  if (raw === '') return { kind: 'empty', index: 0, raw };
  if (/\bNONE\b/i.test(raw)) return { kind: 'none', index: 0, raw };
  const numbers = raw.match(/\d+/g) ?? [];
  if (numbers.length !== 1) return { kind: 'unclear', index: 0, raw };
  const index = Number.parseInt(numbers[0], 10);
  if (!Number.isSafeInteger(index) || index < 1 || index > total) return { kind: 'unclear', index: 0, raw };
  return { kind: 'found', index, raw };
}

/**
 * 分页挑选的**纯循环部分**：逐页问模型，`NONE` 就翻下一页，扫完就如实返回"没找到"。
 *
 * 抽出这个函数是为了让"翻页上限 / NONE 语义 / 未找到返回空"能被单测直接钉住，
 * 而真正的 `ctx.llm` 调用在调用方（`lib/llm.js` 的 `selectPages`）。
 * @param {object} input - 输入。
 * @param {object[]} input.pages - 已构造好的页（`buildPage` 的结果，按顺序）。
 * @param {number} [input.pageLimit] - 页数上限。
 * @param {Function} input.ask - `async (page) => string`，返回模型对**这一页**的回答。
 * @param {Function} [input.onPage] - `(info) => void`，每翻完一页回调一次（写诊断/进度）。
 * @returns {Promise<{found:boolean, page:number, index:number, record:object|null, asked:number, limitReached:boolean, sawNoneAll:boolean}>} 结果。
 */
export async function pickAcrossPages(input) {
  const pages = (Array.isArray(input?.pages) ? input.pages : []).filter((page) => page !== null && page !== undefined);
  const limit = Math.max(1, Number(input?.pageLimit) || PAGE_LIMIT);
  const ask = input?.ask;
  const onPage = typeof input?.onPage === 'function' ? input.onPage : () => {};
  const attempted = pages.slice(0, limit);
  let asked = 0;
  for (let i = 0; i < attempted.length; i += 1) {
    const page = attempted[i];
    if (!Array.isArray(page.items) || page.items.length === 0) continue;
    asked += 1;
    const answer = await ask(page);
    const picked = parsePagePick(answer.text, page.items.length);
    onPage({
      page: i + 1,
      items: page.items.length,
      kind: answer.ok === false ? 'error' : picked.kind,
      code: answer.code ?? null,
      index: picked.index,
      ms: Number(answer.ms) || 0,
      raw: picked.raw.slice(0, 40),
    });
    if (answer.ok === false) {
      // 调用失败（超时/限流/未配提供方…）：**立刻停**，不再翻页花钱；
      // 返回"未找到"，由调用方如实告诉用户（并保留本地粗筛结果，绝不硬凑）。
      return { found: false, page: i + 1, index: 0, record: null, asked, limitReached: false, sawNoneAll: false, stopped: answer.code ?? 'ERROR' };
    }
    if (picked.kind === 'found') {
      const item = page.items[picked.index - 1] ?? null;
      return { found: item !== null, page: i + 1, index: picked.index, record: item?.record ?? item, asked, limitReached: false, sawNoneAll: false, stopped: '' };
    }
    // 'none' / 'unclear' / 'empty' 都算"这页没有" → 继续翻（unclear 已经写进诊断，能查出来）
  }
  const scanned = attempted.filter((page) => Array.isArray(page.items) && page.items.length > 0).length;
  return {
    found: false,
    page: asked,
    index: 0,
    record: null,
    asked,
    // 还有候选没看（被页数上限截住）→ 调用方要如实说明"只翻了 N 页"
    limitReached: scanned >= limit && pages.length > limit,
    sawNoneAll: asked > 0,
    stopped: '',
  };
}

/**
 * 全库扫描的补充信息：某些查询词"在库里出现过、但分散在很多块里"时，给出分布，
 * 便于判断该不该调整切块粒度。
 * @param {object[]} records - 全部记录。
 * @param {string} query - 提问。
 * @returns {{token:string, records:number}[]} 每个查询词命中的块数（降序）。
 */
export function tokenSpread(records, query) {
  const rows = new Map();
  for (const token of tokenize(query)) {
    if (rows.has(token)) continue;
    let count = 0;
    for (const record of records) {
      const haystack = `${record.title ?? ''}\n${(record.keywords ?? []).join(' ')}\n${record.text ?? ''}`;
      if (haystack.includes(token)) count += 1;
    }
    rows.set(token, count);
  }
  return [...rows.entries()]
    .map(([token, count]) => ({ token, records: count }))
    .filter((row) => row.token.length > 1)
    .sort((a, b) => b.records - a.records)
    .slice(0, 12);
}
