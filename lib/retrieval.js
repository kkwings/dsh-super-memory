/**
 * dsh-super-memory — 本地词法检索（方案 A：纯词法，0 模型调用、0 联网）
 *
 * 打分：带字段权重的 BM25（title / keywords 权重高于正文），
 * 归一化为 0..1 左右的可比较分数，便于 minScore 直接调阈值。
 */
import { conclusionScore, surfaceTermsOf, tokenize } from './text.js';

const K1 = 1.2;
const B = 0.62;
const WEIGHT_TITLE = 3;
const WEIGHT_KEYWORDS = 4;
const WEIGHT_TEXT = 1;
/** L2 原文块的折扣：它更长、更容易堆词频，且含原话噪声。 */
const RAW_PENALTY = 0.85;

/**
 * **命中证据门**：一条候选至少要命中多少个**不同的**查询 token 才算候选。
 *
 * 为什么需要它（2026-10-08 实测标定，见 README 的成本/检索节）：
 * 中文按字符 bigram 分词后，一个词只值 1–2 个 token，而"今天 / 比较 / 邮件"这类
 * 日常词在一个**窄领域小库**里 IDF 并不低（库里全是一个插件的开发记录，日常词反而
 * "稀有"）—— 于是 1–2 个巧合 bigram 就能拿到很高的相对分。实测两个真实库上的分布：
 *   · 26 条与本库无关的日常问题 → 命中 token 数 **≤ 2**（1 个 token 的占多数）
 *   · 长相关提问（含历史真实命中）→ 命中 token 数 **≥ 4**（中位 12）
 * 所以"命中多少个不同的 token"是这两个库上**唯一**能把两类分开的特征；IDF 质量
 * （`matchedIdf`）与各类归一化都分不开（同一次标定的完整表格见报告与 README）。
 *
 * 口径：`minMatched = Math.min(MIN_MATCHED_TERMS, 查询去重 token 数)` ——
 * 短查询（≤4 个 token）必须**全部**命中，长查询只需命中 4 个不同 token。
 * 4 而不是 3：harness 那个 350 条的大库里有一条无关问题（"帮我写一封请假邮件"）
 * 恰好命中 3 个通用 bigram（`工具 read：scripts/harness.mjs` 这块 4 万字符的工具结果
 * 几乎含所有常见 bigram）；3 会把它放进来。
 */
export const MIN_MATCHED_TERMS = 4;

/**
 * 一条查询的命中证据门（`min(MIN_MATCHED_TERMS, 查询去重 token 数)`）。
 *
 * 导出给"要让候选和召回同一口径"的调用点用；`MemoryIndex.search` 默认就用它，
 * 需要"只看排序、不看闸门"的地方（排序回归测试）显式传 `minMatchedTerms: 0`。
 *
 * 注意（2026-10-09 起）**数的是"表面词"（`surfaceTermsOf`）而不是 `tokenize` 的结果**：
 * 分词现在会把一个标识符展开成多个 token（`stickyRecall` -> `stickyrecall`/`sticky`/`recall`），
 * 若门还按展开后的去重 token 数取 `min(4, n)`，则"用户只打了一个词"也会变成 3 个词的门 ——
 * 门会在标识符查询上**悄悄升高**，`MIN_MATCHED_TERMS` 的既有标定（26 条无关 <=2 命中、
 * 长相关 >=4）随之失效。表面词口径让门的含义保持标定时的一致：用户打了几个词、门就有多高；
 * "命中几个"仍按真的进了索引的 token 计（`matched`）。
 * @param {string} query - 查询文本。
 * @returns {number} 需要命中的最少不同 token 数。
 */
export function matchedTermsFloor(query) {
  const unique = new Set(surfaceTermsOf(query)).size;
  return unique === 0 ? 0 : Math.min(MIN_MATCHED_TERMS, unique);
}

/** 单条记录的可检索字段权重词频。 */
function docTerms(record) {
  const tf = new Map();
  const add = (text, weight) => {
    if (typeof text !== 'string' || text === '') return;
    for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + weight);
  };
  add(record.title, WEIGHT_TITLE);
  add(Array.isArray(record.keywords) ? record.keywords.join(' ') : '', WEIGHT_KEYWORDS);
  add(record.text, WEIGHT_TEXT);
  return tf;
}

/**
 * 内存倒排/打分索引。构造成本与本会话记忆库大小成正比（进程内缓存）。
 */
export class MemoryIndex {
  /**
   * @param {object[]} records - 记忆块记录。
   */
  constructor(records) {
    const source = Array.isArray(records) ? records : [];
    // 防御性去重：同 fp 的记录只索引一次（库里历史遗留的重复行不该被重复注入）
    const seen = new Set();
    this.records = [];
    for (const record of source) {
      const fp = String(record?.fp ?? '');
      const key = fp === '' ? `${record?.layer}\u0000${record?.title}\u0000${String(record?.text ?? '').length}` : fp;
      if (seen.has(key)) continue;
      seen.add(key);
      this.records.push(record);
    }
    this.docs = [];
    this.df = new Map();
    this.totalLen = 0;
    for (const record of this.records) {
      const tf = docTerms(record);
      let len = 0;
      for (const value of tf.values()) len += value;
      this.docs.push({ record, tf, len, terms: tf.size });
      this.totalLen += len;
      for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
    }
    this.avgdl = this.docs.length === 0 ? 0 : this.totalLen / this.docs.length;
  }

  /** 块数量。 */
  get size() {
    return this.docs.length;
  }

  /** 某个 token 的逆文档频率。 */
  idf(token) {
    const df = this.df.get(token) ?? 0;
    const n = this.docs.length;
    if (n === 0) return 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * 检索：返回按分数降序排列的结果。
   *
   * **分数口径（2026-10-08 改）**：`score = raw / 可匹配 IDF 质量`。
   * 分母只累加**在这个库里出现过（df>0）**的查询 token 的 IDF —— 早先是 query 的**全部**
   * token（`ideal`），于是"库里根本没有对应的词"也会进分母：长提问里那些库内不存在的
   * 词天然带最高 IDF（df=0 时 idf≈log(1+2n)），等于**系统性惩罚长提问**。
   * 实测（harness 库，同一条相关问题后面粘一段无关长尾）：
   *   现状口径 15 字符 → 1.479；+1 段无关长尾(67 字符) → 0.210（掉到阈值以下，漏检）
   *   新口径   15 字符 → 1.572；+1 段无关长尾        → 1.572（**完全不动**）
   * 分数因此不再随"提问里有多少库里没见过的词"漂移，只反映"库能提供的那部分被覆盖了多少"。
   * @param {string} query - 查询文本。
   * @param {object} [options] - 选项。
   * @param {string[]} [options.layers] - 只检索这些层（'summary' / 'raw'）。
   * @param {number} [options.limit] - 最多返回多少条。
   * @param {number} [options.minMatchedTerms] - 命中证据门（默认 = `matchedTermsFloor(query)`；
   *   显式传 0 = 只看排序、不设闸门）。
   * @returns {{record:object, score:number, raw:number, matched:number, queryTerms:number, matchableTerms:number}[]} 结果。
   */
  search(query, options = {}) {
    const layers = Array.isArray(options.layers) ? new Set(options.layers) : null;
    const limit = options.limit ?? 8;
    const minMatchedTerms = options.minMatchedTerms === undefined
      ? matchedTermsFloor(query)
      : Math.max(0, Number(options.minMatchedTerms) || 0);
    const tokens = tokenize(query);
    if (tokens.length === 0 || this.docs.length === 0) return [];
    const unique = [...new Set(tokens)];
    const idf = new Map();
    let matchable = 0;
    let matchableTerms = 0;
    for (const token of unique) {
      const value = this.idf(token);
      idf.set(token, value);
      if ((this.df.get(token) ?? 0) > 0) {
        matchable += value;
        matchableTerms += 1;
      }
    }
    // 查询里一个词都没在本库出现过 → 没有任何可匹配的质量，直接不召回。
    if (matchable <= 0) return [];
    const scored = [];
    for (const doc of this.docs) {
      if (layers !== null && !layers.has(doc.record.layer)) continue;
      let raw = 0;
      let matched = 0;
      for (const token of unique) {
        const tf = doc.tf.get(token);
        if (tf === undefined || tf === 0) continue;
        matched += 1;
        const denom = tf + K1 * (1 - B + (B * doc.len) / (this.avgdl || 1));
        raw += idf.get(token) * ((tf * (K1 + 1)) / denom);
      }
      if (matched === 0) continue;
      if (matched < minMatchedTerms) continue;
      let score = raw / matchable;
      // 结论性文本轻微加权（判据/决定句更可能是用户想找的"当年的结论"）
      score *= 1 + 0.06 * conclusionScore(doc.record.text);
      scored.push({ record: doc.record, score, raw, matched, queryTerms: unique.length, matchableTerms });
    }
    scored.sort((a, b) => b.score - a.score || String(b.record.at ?? '').localeCompare(String(a.record.at ?? '')));
    return scored.slice(0, limit);
  }
}

/**
 * 两层检索：L1 摘要块（模型已提炼，短而准）优先，L2 原文块兜底。
 * 两层各自打分后比较，L2 乘一个小折扣（它更长、更容易堆词频，且是原始噪声）。
 *
 * **命中证据门**（2026-10-08 新增，见 `MIN_MATCHED_TERMS`）：两层都只保留命中
 * ≥ `min(4, 查询去重 token 数)` 个不同 token 的候选（`index.search` 的默认口径）。
 * 这是"不相关的问题不得注入"的唯一有效判据 —— 实测把阈值降到 0.01 也挡不住 1–2 个巧合
 * bigram 的候选（它们的相对分可以到 1.0+），而这条门在真实库上对它 26/26 全挡、
 * 对 16 条相关提问 0 误伤。
 * @param {MemoryIndex} index - 索引。
 * @param {string} query - 查询文本。
 * @param {object} options - 选项。
 * @param {number} options.minScore - 命中阈值。
 * @param {number} options.maxItems - 最多条数。
 * @param {boolean} [options.preferSummaryChunks] - 是否优先 L1。
 * @returns {{hits:object[], tier:'summary'|'raw'|'none', topScore:number, secondScore:number, summaryTop:number, rawTop:number}} 检索结果。
 */
export function retrieveTwoTier(index, query, options) {
  const minScore = options.minScore;
  const maxItems = Math.max(0, options.maxItems ?? 2);
  const preferSummary = options.preferSummaryChunks !== false;
  const summaryHits = preferSummary ? index.search(query, { layers: ['summary'], limit: 6 }) : [];
  const rawHits = index.search(query, { layers: ['raw'], limit: 6 });
  const summaryTop = summaryHits[0]?.score ?? 0;
  const summarySecond = summaryHits[1]?.score ?? 0;
  const rawTop = (rawHits[0]?.score ?? 0) * RAW_PENALTY;
  const rawSecond = (rawHits[1]?.score ?? 0) * RAW_PENALTY;

  if (summaryTop >= minScore && summaryTop >= rawTop) {
    return { hits: pick(summaryHits, minScore, maxItems), tier: 'summary', topScore: summaryTop, secondScore: summarySecond, summaryTop, rawTop };
  }
  if (rawTop >= minScore) {
    // L2 是原话，噪声更大：只取 1 条（最多 2 条），且第二条必须非常接近
    return {
      hits: pick(rawHits, minScore / RAW_PENALTY, Math.min(maxItems, 2)),
      tier: 'raw',
      topScore: rawTop,
      secondScore: rawSecond,
      summaryTop,
      rawTop,
    };
  }
  return { hits: [], tier: 'none', topScore: Math.max(summaryTop, rawTop), secondScore: Math.max(summarySecond, rawSecond), summaryTop, rawTop };
}

/** 取前 N 条：第二条必须与第一条分数接近，否则宁少勿多。 */
function pick(hits, minScore, maxItems) {
  if (maxItems <= 0 || hits.length === 0) return [];
  const out = [hits[0]];
  if (maxItems >= 2 && hits.length >= 2) {
    const [first, second] = hits;
    if (second.score >= minScore && second.score >= first.score * 0.72) out.push(second);
  }
  return out;
}

/**
 * 一批候选里最高的分数（0 = 没有候选）。
 *
 * 用途：点 ✕ 时判断"本地是不是已经强命中"（`lib/routes.js` 的 `strongHitScore`）。
 * 只看候选（诊断结果里的 `score`）而不是重新检索 —— 那些分数正是本地检索给出的，
 * 分数在 `MemoryIndex.search` 里已经排好序，但这里仍然取最大值，不依赖排序。
 * @param {object[]} candidates - 诊断候选（含 `score`）。
 * @returns {number} 最高分。
 */
export function localTopScore(candidates) {
  let best = 0;
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const score = Number(item?.score ?? 0);
    if (Number.isFinite(score) && score > best) best = score;
  }
  return best;
}
