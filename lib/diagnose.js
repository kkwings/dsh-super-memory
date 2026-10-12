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
import { estimateTokens, TIME_INTENTS, tokenSet, tokenize } from './text.js';

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
 * ── 2026-10-12 追加：**顺带**输出"时间意图"（用户要求，决策权交给模型）──────────
 * 用户指出：「我们刚刚说的那个最早提过的设想」这种句子该由**大模型理解意思后决策**，
 * 而不是写成死板的优先级规则。可能是"最早"、可能是"**两头**"（最早一遍 + 刚刚一遍，
 * 现在问的是第三遍）→ 两端高、中间低。自动检索那条路（每次提问、0 成本）**没有模型可用**，
 * 所以那里只能"判不清就不重排"（见 `lib/text.js` 的 `timeReferenceShapeOf`）；
 * 点 ✕ 时有辅助模型，就让它把这件事一并判了。
 *
 * ⚠️ **不新增任何模型调用**：时间意图是**在原来那一次改写调用里顺带输出的一个字段**
 *   （用户硬约束："✕ 的模型调用次数不增加"）。
 * ⚠️ **它只影响"✕ 路径内部的候选重排"，绝不影响"要不要注入"** ——
 *   与"加权只改排序、永不改资格"同一条铁律（见 `lib/retrieval.js` 的 `rankByTimeIntent`）。
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
    /* ── 时间意图（2026-10-12 新增字段；四选一，判不出来就填 none）──────────────
     * 四个取值的**语义写在这里、也只写在这里**（`lib/text.js` 的 `TIME_INTENT_SHAPES`
     * 是它们到形状名的唯一映射）。措辞刻意不用"权重/排序"这类内部术语，让模型只回答
     * "用户问的是哪一段时间"。 */
    + '另外**顺手判断一次这个问题的"时间意图"**，填进 `时间意图` 字段，只能取下面四个值之一：'
    + 'earliest（问的是最初/最早那一次）、recent（问的是刚刚/最近那次）、'
    + 'both_ends（这件事被提过好几遍，最早一次与最近一次都相关、中间次要 —— 也就是"两头"）、'
    + 'none（与时间无关）。判不出来、或这句话里没有时间指向，就填 none。'
    + '只输出严格 JSON 对象，形如 {"点": "最关键的问题点（一句话）", "关键词": ["…"], "时间意图": "both_ends"}；'
    + '不要解释、不要 Markdown 代码块。';
}

/**
 * 解析"集中关键词"的结构化输出；**兼容旧的纯数组**（旧缓存/旧模型行为不许变坏）。
 *
 * 判据顺序：
 *   ① 先按**对象**解析（新口径），只取 `关键词` / `keywords` 字段；
 *   ② 不是对象就按**数组**解析（旧口径，`parseJsonArray` 的口径）；
 *   ③ 两者都不是 → `null`（调用方据此回 `BAD_OUTPUT`，绝不硬凑）。
 *
 * **时间意图（2026-10-12）**：随对象一起解析出 `intent`，取值只认 `lib/text.js` 的
 * `TIME_INTENTS` 那四个词（**大小写不敏感、允许空白**）；其它任何东西（含字段缺失、
 * 纯数组旧输出、`时间意图` 写成了"earliest but sometimes both"）一律 `'none'` ——
 * **不硬凑、不许报错**（旧输出只有数组，不许因此变成 `BAD_OUTPUT`）。
 * @param {string} text - 模型输出。
 * @returns {{point:string, terms:string[], intent:string}|null} 结果。
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
        return { point, terms, intent: intentFromRecord(parsed) };
      }
    }
    return null;
  }
  const list = parseJsonArrayLoose(raw);
  if (list === null || list.length === 0) return null;
  // 旧口径（纯数组）没有时间意图字段 → `'none'`（= 不重排），**不是**错误。
  return { point: '', terms: list, intent: 'none' };
}

/**
 * 规范化一个"时间意图"取值：**只认那四个词**（表外一律 `'none'`）。
 *
 * 大小写不敏感、两端空白忽略；非字符串（`undefined` / 数字 / 对象）一律 `'none'`。
 * **不做模糊匹配** —— "模型多回一个字"不该变成我们替它编一个意图（宁可 `none` = 不重排）。
 * 导出给 `lib/llm.js`（缓存里可能躺着旧版本的任意值，读回来也要过这一道）。
 * @param {unknown} value - 原始取值。
 * @returns {string} 四个合法取值之一（默认 `'none'`）。
 */
export function normalizeTimeIntent(value) {
  if (typeof value !== 'string') return 'none';
  const normalized = value.trim().toLowerCase();
  return TIME_INTENTS.includes(normalized) ? normalized : 'none';
}

/**
 * 从解析出的对象里取"时间意图"。
 *
 * 字段名兼容四种写法（`时间意图` 为主，另收英文/驼峰变体）。认出了字段名、但取值不合法时
 * **立刻**按 `none` 处理（不再尝试后面的字段名：同一个对象里出现两种写法属于异常输出，
 * 取第一个已经出现的字段更可预测）。
 * @param {object} parsed - `parseJsonObjectLoose` 的结果。
 * @returns {string} 四个合法取值之一（默认 `'none'`）。
 */
function intentFromRecord(parsed) {
  const record = parsed !== null && typeof parsed === 'object' ? parsed : {};
  for (const key of ['时间意图', 'time_intent', 'timeIntent', 'intent']) {
    if (typeof record[key] !== 'string') continue;
    return normalizeTimeIntent(record[key]);
  }
  return 'none';
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

/* ── 时间意图**从改写里解耦**（2026-10-12 第二次回归修复，用户 A 项）──────────────
 * 已知盲区（真实日志核实）：本地已强命中时**整段跳过改写**（`rewrite-skipped
 * reason=local-strong-hit best=0.8007`），而"时间意图"原先只挂在改写那一次调用上 ——
 * 于是**恰恰在用户点 ✕ 的主场景**（本地字面撞词最多、但可能不是他要的那条）里，
 * 时间意图一次都没跑过。而"分页判读"（`selectPages` / `pagePickSystem`）**本来就要调用**，
 * 所以让它顺带把意图带回来 —— **不新增任何模型调用**（用户硬约束）。
 *
 * 三个刻意的克制（都是为了让"判读"这件事不被干扰）：
 *   ① **只在第一页问**（页序号 0）：意图是"整条提问"的性质，同一批候选里判一次就够；
 *      每页都问等于把一次判读变成两件事、还白花输入 token。
 *   ② 问题写在**用户消息**里、**不写进 `pagePickSystem`**：那段系统提示词有一条既有断言
 *      （不许出现任何语义词，`scripts/unit.mjs` 逐个 token 核对"系统提示词里不出现
 *      '最早'这类词"），把语义说明塞进去等于换一种方式做词面提示。
 *   ③ 措辞明确"**顺手、可选、不要为它改变你的挑选**"，且**编号仍然是唯一必需的回答**
 *      —— 输出上限 `PAGE_PICK_MAX_TOKENS` 一个字都没加，截断了也只会丢掉那个词，
 *      不会丢掉编号（`parsePagePick` 先取数字，见下）。
 * @returns {string} 固定文本（**不含任何查询词**，供断言单独核对）。
 */
export function pageIntentHint() {
  const meanings = {
    earliest: '最初/最早那一次',
    recent: '刚刚/最近那次',
    both_ends: '最早一次与最近一次都相关、中间次要（"两头"）',
    none: '与时间无关',
  };
  return '另外，**顺手**判断一下这个问题问的是哪一段时间：能判断出来就在编号后面空一格补一个词它只能是'
    + TIME_INTENTS.map((intent) => `${intent}（${meanings[intent] ?? ''}）`).join('、')
    + '；判断不出来、或不想判断，就**只回编号**。'
    + '这只是顺带一问：**不要为它多想，更不要因此改变你挑的那一条**。';
}

/**
 * 一页的用户消息（问题原文 + 本页清单）。
 *
 * @param {string} query - **用户提问原文**（一字不改、一字不加）。
 * @param {object} page - `buildPage` 的结果。
 * @param {object} [options] - `{intent}`：`true` 时在本页末尾追加"顺手判时间意图"一问
 *   （见 `pageIntentHint`；第一页才用，理由写在那里）。
 * @returns {string} 用户消息文本。
 */
export function buildPagePrompt(query, page, options = {}) {
  const items = Array.isArray(page?.items) ? page.items : [];
  const list = formatPage(page);
  return `问题：${String(query ?? '')}\n\n`
    + `本页候选（第 ${Number(page?.page ?? 0) + 1} 页，共 ${items.length} 条，编号是**本页**的）：\n`
    + `${list === '' ? '(本页没有候选)' : list}\n\n`
    + `请只回答本页里最可能直接回答该问题的那一条的编号；`
    + `本页都没有就回答 ${PAGE_NONE}。`
    + (options.intent === true ? `\n${pageIntentHint()}` : '');
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
 * 从分页判读的**同一次回答**里抠出"时间意图"（2026-10-12，用户 A 项）。
 *
 * 模型被要求（见 `pageIntentHint`）在编号后面空一格补一个词 —— 于是这里就是
 * "在回答里找第一个合法的意图词"。三条口径：
 *   · **只认那四个词**（`TIME_INTENTS`，来自 `lib/text.js`）—— 表外一律 `null`
 *     （= 这一次判读没给意图，不是"猜一个"）；与 `normalizeTimeIntent` 的区别：
 *     那个是"取值规范化"（表外 → `'none'`），这个是"有没有判出来"（表外 → `null`）；
 *   · **大小写不敏感、两侧加词边界**：`earliest` 认得，`earliest_first` 不认
 *     （前缀匹配会把模型的解释当成承诺）—— 与 `timeIntentShapeOf` 的"不许模糊匹配"同一条；
 *   · 一句话里出现**多个**合法词（模型在解释）→ 返回 `null`：那是模型在讨论选项，
 *     不是在下判断，替它选一个等于编意图。
 * @param {unknown} text - 模型对这一页的回答（例如 `7 earliest` / `NONE both_ends`）。
 * @returns {string|null} 四个合法意图之一；判不出来返回 `null`。
 */
export function parsePageIntent(text) {
  const raw = String(text ?? '');
  if (raw === '') return null;
  /* ⚠️ 判读协议自己的哨兵 `NONE`（= 本页没有）与意图取值 `none` **同名**，必须先分开，
   * 否则 `NONE both_ends` 会被读成"出现了两个合法词"（`NONE` 恰好也是 `none`）
   * → 判成"模型在解释" → 白白丢掉一个真实意图。两条口径：
   *   ① **大写 `NONE`** 是协议规定的哨兵写法 → 无条件摘掉（`NONE` / `NONE both_ends` 都对）；
   *   ② 摘完之后**仍然**多个词、且其中含 `none` → 那个 `none` 只可能是模型把哨兵写成小写，
   *      继续摘掉它再看（`none both_ends` → `both_ends`）。
   * 剩下的情况一律按"同时出现多个意图词 = 模型在解释"处理 → `null`（不替它编意图）。 */
  const words = raw.replace(/\bNONE\b/g, ' ').toLowerCase().match(/[a-z_]+/g) ?? [];
  const hits = [...new Set(words.filter((word) => TIME_INTENTS.includes(word)))];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && hits.includes('none')) {
    const rest = hits.filter((word) => word !== 'none');
    return rest.length === 1 ? rest[0] : null;
  }
  return null;
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
 * @returns {Promise<{found:boolean, page:number, index:number, record:object|null, asked:number, limitReached:boolean, sawNoneAll:boolean, intent:string|null}>} 结果。
 */
export async function pickAcrossPages(input) {
  const pages = (Array.isArray(input?.pages) ? input.pages : []).filter((page) => page !== null && page !== undefined);
  const limit = Math.max(1, Number(input?.pageLimit) || PAGE_LIMIT);
  const ask = input?.ask;
  const onPage = typeof input?.onPage === 'function' ? input.onPage : () => {};
  const attempted = pages.slice(0, limit);
  let asked = 0;
  /* **顺带**取回的时间意图（2026-10-12，用户 A 项）：只在**第一次真正发出去的那一页**上解析
   * （调用方也只在该页的提示词里加了那一问，见 `pageIntentHint`）。空页不会走到这里
   * （下面 `continue` 在 `asked += 1` 之前），所以"第一次问的那页"就是"加了那一问的那页"。
   * ⚠️ 它只是一条**附加**结果：拿不到（`null`）时调用方按"没有意图"处理，
   * 页挑选本身的行为一个字节都不变。 */
  let intent = null;
  for (let i = 0; i < attempted.length; i += 1) {
    const page = attempted[i];
    if (!Array.isArray(page.items) || page.items.length === 0) continue;
    asked += 1;
    const answer = await ask(page);
    if (asked === 1) intent = parsePageIntent(answer.text);
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
      return { found: false, page: i + 1, index: 0, record: null, asked, limitReached: false, sawNoneAll: false, stopped: answer.code ?? 'ERROR', intent };
    }
    if (picked.kind === 'found') {
      const item = page.items[picked.index - 1] ?? null;
      return { found: item !== null, page: i + 1, index: picked.index, record: item?.record ?? item, asked, limitReached: false, sawNoneAll: false, stopped: '', intent };
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
    // 全页都是 NONE / unclear 也照旧带出意图：它是"提问的性质"，与"本批有没有命中"无关。
    intent,
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
