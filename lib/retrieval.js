/**
 * dsh-super-memory — 本地词法检索（方案 A：纯词法，0 模型调用、0 联网）
 *
 * 打分：带字段权重的 BM25（title / keywords 权重高于正文），
 * 归一化为 0..1 左右的可比较分数，便于 minScore 直接调阈值。
 */
import { conclusionScore, tokenize } from './text.js';

const K1 = 1.2;
const B = 0.62;
const WEIGHT_TITLE = 3;
const WEIGHT_KEYWORDS = 4;
const WEIGHT_TEXT = 1;
/** L2 原文块的折扣：它更长、更容易堆词频，且含原话噪声。 */
const RAW_PENALTY = 0.85;

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
   * @param {string} query - 查询文本。
   * @param {object} [options] - 选项。
   * @param {string[]} [options.layers] - 只检索这些层（'summary' / 'raw'）。
   * @param {number} [options.limit] - 最多返回多少条。
   * @returns {{record:object, score:number, raw:number, matched:number, queryTerms:number}[]} 结果。
   */
  search(query, options = {}) {
    const layers = Array.isArray(options.layers) ? new Set(options.layers) : null;
    const limit = options.limit ?? 8;
    const tokens = tokenize(query);
    if (tokens.length === 0 || this.docs.length === 0) return [];
    const unique = [...new Set(tokens)];
    const idf = new Map();
    let ideal = 0;
    for (const token of unique) {
      const value = this.idf(token);
      idf.set(token, value);
      ideal += value;
    }
    if (ideal <= 0) return [];
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
      let score = raw / ideal;
      // 结论性文本轻微加权（判据/决定句更可能是用户想找的"当年的结论"）
      score *= 1 + 0.06 * conclusionScore(doc.record.text);
      scored.push({ record: doc.record, score, raw, matched, queryTerms: unique.length });
    }
    scored.sort((a, b) => b.score - a.score || String(b.record.at ?? '').localeCompare(String(a.record.at ?? '')));
    return scored.slice(0, limit);
  }
}

/**
 * 两层检索：L1 摘要块（模型已提炼，短而准）优先，L2 原文块兜底。
 * 两层各自打分后比较，L2 乘一个小折扣（它更长、更容易堆词频，且是原始噪声）。
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
