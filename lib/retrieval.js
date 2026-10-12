/**
 * dsh-super-memory — 本地词法检索（方案 A：纯词法，0 模型调用、0 联网）
 *
 * 打分：带字段权重的 BM25（title / keywords 权重高于正文），
 * 归一化为 0..1 左右的可比较分数，便于 minScore 直接调阈值。
 */
import { conclusionScore, splitQuerySegments, surfaceTermsOf, timeReferenceShapeOf, timeReferenceWindows, tokenize } from './text.js';
import { DEFAULTS } from './config.js';

const K1 = 1.2;
const B = 0.62;
const WEIGHT_TITLE = 3;
const WEIGHT_KEYWORDS = 4;
const WEIGHT_TEXT = 1;
/** L2 原文块的折扣：它更长、更容易堆词频，且含原话噪声。 */
const RAW_PENALTY = 0.85;

/**
 * **分母封顶**：归一化时只累加 IDF 最高的这么多个「库内出现过」的词。
 *
 * 为什么必须封顶（2026-10-10 实测，真实线上日志 + 142 块离线库）：
 *   `score = raw / matchable`，而 `matchable` 早先**无条件累加所有 `df>0` 的查询 token 的 IDF**。
 *   于是"用户那条自然语言长消息"（97 字 / 60 token）里，**库内存在的水词**（"你/我/这个/现在/
 *   一下"这类日常 bigram，在一个只记插件开发记录的窄领域小库里 IDF 并不低）把分母撑到
 *   **×5.118**，而真正命中的那几个词只让分子涨 **×1.362** → 净 **×0.266**。
 *   逐位复现：`1.0843 × 0.266 × 0.85 = 0.24531`（线上日志 `topScore=0.2453`，miss）。
 *   同一个问题的人工裸问句（15 字 / 9 token）分母只有它的 1/5 → **0.9216**（hit）。
 *   **长句摊薄**就是这么来的：不是分子小，是分母被"库内水词"灌大了。
 *
 * 为什么是「IDF 最高的 K 个」而不是别的规则（同一批数据上的扫描，K=∞ 即现状）：
 *
 * | 规则 | 离线相关 t1/t3 | 16 短无关误报 | 16 长无关误报 | 13 条真实 miss 翻转 | 那条 0.2453 |
 * |---|---|---|---|---|---|
 * | 现状（全部） | 5/16 · 7/16 | 0/16 | 4/16 | 0/13 | 0.2411 |
 * | K=6 | 6/16 · 10/16 | 0/16 | 5/16 | 13/13 | 0.7+（**过冲，见下**） |
 * | K=8 | 6/16 · 10/16 | 0/16 | **5/16 ↑** | 13/13 | 0.7324 |
 * | **K=12** | 5/16 · **8/16** | 0/16 | **4/16（不涨）** | **13/13** | **0.5122** |
 * | K=16 | 5/16 · 7/16 | 0/16 | 4/16 | 12/13 | 0.4037 |
 * | K=20 | 5/16 · 7/16 | 0/16 | 4/16 | 11/13 | 0.3402 |
 *
 * · **K 太小会过冲**：K=6/8 把分数抬到 0.7 上下，同时**长无关文本的误报从 4/16 涨到 5/16**
 *   （长无关文本里也有一堆库内水词，分母封得越狠，它们被抬得越高）。那不是"修好长句"，
 *   是把阈值这层防线一起冲掉。
 * · K=12 是**同时满足三条硬要求的最小 K**：① 目标那条 0.2453 → **0.5122 ≈ 0.5+**；
 *   ② 13 条真实 miss **13/13** 全部翻转（"只取末问句"是 7/13，同量级以上）；
 *   ③ 16 条短无关**仍是 0/16**、16 条长无关**仍是 4/16（一分不涨）**。
 * · 顺带：相关组 top-3 从 7/16 升到 **8/16**（top-1 不动）。
 * · **排序不变**：`matchable` 是一条查询的**同一个数**，同一次 `search` 内所有块同除它 →
 *   块与块的相对次序逐位不变（只有"跨查询的绝对分"和"summary vs raw 的比较"会变，那正是目的）。
 *
 * 为什么用"top-K"而不是"按 IDF 分布截断"（`idf ≥ ratio×maxIdf`）：分布法在扫过的每个比例上
 * 都**远差于** top-K —— r=0.5 只翻转 2/13，r=0.7 才 10/13 且长无关误报涨到 6/16（最高分 0.881）。
 * 原因是**命中词不一定是最稀有的词**：封顶要保住的是"分母里那批水词"，而分布法按绝对 IDF
 * 砍，会把"恰好是低 IDF 但确实命中"的词一起砍掉（分子也掉）。top-K 直接按"贡献排序"取前 K，
 * 对两个方向都稳。
 */
export const MATCHABLE_TOP_K = 12;

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
   * **分数口径（2026-10-08 改，2026-10-10 加封顶）**：`score = raw / 可匹配 IDF 质量`。
   * 分母只累加**在这个库里出现过（df>0）**的查询 token 的 IDF —— 早先是 query 的**全部**
   * token（`ideal`），于是"库里根本没有对应的词"也会进分母：长提问里那些库内不存在的
   * 词天然带最高 IDF（df=0 时 idf≈log(1+2n)），等于**系统性惩罚长提问**。
   * 实测（harness 库，同一条相关问题后面粘一段无关长尾）：
   *   现状口径 15 字符 → 1.479；+1 段无关长尾(67 字符) → 0.210（掉到阈值以下，漏检）
   *   新口径   15 字符 → 1.572；+1 段无关长尾        → 1.572（**完全不动**）
   * 分数因此不再随"提问里有多少库里没见过的词"漂移，只反映"库能提供的那部分被覆盖了多少"。
   *
   * **但这还不够**（2026-10-10 实测）：`df>0` 只挡得住"库里根本没有的词"，**挡不住
   * "库内存在的水词"** —— 而自然语言长句里水词才是大头（那条 97 字消息多出的 52 个 token 里
   * **31 个在库内**）。现在分母再取 **IDF 最高的 `MATCHABLE_TOP_K` 个**，理由与标定表见
   * 那个常量的注释。`options.matchableTopK` 可覆盖（0 = 不封顶，等价旧口径，供对照测试）。
   * @param {string} query - 查询文本。
   * @param {object} [options] - 选项。
   * @param {string[]} [options.layers] - 只检索这些层（'summary' / 'raw'）。
   * @param {number} [options.limit] - 最多返回多少条。
   * @param {number} [options.minMatchedTerms] - 命中证据门（默认 = `matchedTermsFloor(query)`；
   *   显式传 0 = 只看排序、不设闸门）。
   * @param {number} [options.matchableTopK] - 分母封顶的 K（默认 `MATCHABLE_TOP_K`；0 = 不封顶）。
   * @param {number} [options.boost] - 该路查询的**整体乘法加成**（时间指代词那一句用，默认 1）。
   * @returns {{record:object, score:number, raw:number, matched:number, queryTerms:number, matchableTerms:number}[]} 结果。
   */
  search(query, options = {}) {
    const layers = Array.isArray(options.layers) ? new Set(options.layers) : null;
    const limit = options.limit ?? 8;
    const minMatchedTerms = options.minMatchedTerms === undefined
      ? matchedTermsFloor(query)
      : Math.max(0, Number(options.minMatchedTerms) || 0);
    const boost = Number.isFinite(options.boost) && options.boost > 0 ? options.boost : 1;
    const topK = options.matchableTopK === undefined
      ? MATCHABLE_TOP_K
      : Math.max(0, Number(options.matchableTopK) || 0);
    const tokens = tokenize(query);
    if (tokens.length === 0 || this.docs.length === 0) return [];
    const unique = [...new Set(tokens)];
    const idf = new Map();
    const matchableIdfs = [];
    for (const token of unique) {
      const value = this.idf(token);
      idf.set(token, value);
      if ((this.df.get(token) ?? 0) > 0) matchableIdfs.push(value);
    }
    // 分母：库里出现过的词的 IDF 之和，**只取最高的 topK 个**（见 `MATCHABLE_TOP_K`）。
    // 排序只用于选"哪些进分母"，不改变"命中哪些块"。
    const capped = topK > 0 && matchableIdfs.length > topK
      ? [...matchableIdfs].sort((a, b) => b - a).slice(0, topK)
      : matchableIdfs;
    let matchable = 0;
    for (const value of capped) matchable += value;
    const matchableTerms = matchableIdfs.length;
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
      let score = (raw / matchable) * boost;
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
 *
 * ⚠️ **本函数不做任何时间重排**（2026-10-12）。它是"纯词法 + 证据门 + 阈值"的那条路径，
 * 调用它的地方（✕ 诊断的 `retrieveTwoTier`、分段退化路径）要求的是"同一次判定"，
 * 时间系数会改变 `pick` 取谁 —— 那属于排序层，只在 `retrieveSegmented` 里做。
 * 想开时间重排就调用 `retrieveSegmented`（那里是唯一的入口）。
 * @param {MemoryIndex} index - 索引。
 * @param {string} query - 查询文本。
 * @param {object} options - 选项。
 * @param {number} options.minScore - 命中阈值。
 * @param {number} options.maxItems - 最多条数。
 * @param {boolean} [options.preferSummaryChunks] - 是否优先 L1。
 * @param {number} [options.matchableTopK] - 分母封顶的 K（透传给 `index.search`；见 `MATCHABLE_TOP_K`）。
 * @param {boolean} [options.preferEarlier] - 同分时优先较早的块（见 `orderHits`）。
 * @returns {{hits:object[], tier:'summary'|'raw'|'none', topScore:number, secondScore:number, summaryTop:number, rawTop:number}} 检索结果。
 */
export function retrieveTwoTier(index, query, options) {
  const minScore = options.minScore;
  const maxItems = Math.max(0, options.maxItems ?? 2);
  const preferSummary = options.preferSummaryChunks !== false;
  const topK = options.matchableTopK === undefined ? {} : { matchableTopK: options.matchableTopK };
  const summaryHits = preferSummary ? index.search(query, { layers: ['summary'], limit: 6, ...topK }) : [];
  const rawHits = index.search(query, { layers: ['raw'], limit: 6, ...topK });
  return decideTier(summaryHits, rawHits, { minScore, maxItems, preferEarlier: options.preferEarlier === true });
}

/**
 * 两层打分后的**选层与取条**（从 `retrieveTwoTier` 里抽出来，供"分段合并"复用）。
 *
 * 抽出来是必须的：分段检索要先把**各段**的两层候选合并去重，再做**同一次**选层判定 ——
 * 如果让每段各自选层再拼结果，"summary 还是 raw"会被一个 2 个 token 的短片段左右。
 *
 * ⚠️ **`topScore` / `secondScore` 的语义（2026-10-12 随"加权不改资格"收紧）**：
 *   · 选层（`summaryTop >= rawTop`）与 `minScore` 判定，用的都是传入候选自带的 `score`；
 *   · 调用方（`retrieveSegmented`）传进来的候选**已经乘过时间系数**，所以这两个字段反映的是
 *     "重排之后的样子"——它们要被写进诊断/日志，必须和最终注入的那批一致。
 *   · **但"资格"不是在这里定的**：`minScore` 只在这个函数里被读一次（`pick` 只用它比第二条），
 *     第一条的资格已经在调用方按纯词法分判完了（见那里的注释）。所以时间系数永远改不了资格。
 * @param {object[]} summaryHits - L1 候选（已按分数降序）。
 * @param {object[]} rawHits - L2 候选（已按分数降序，**未乘** `RAW_PENALTY`）。
 * @param {object} options - `{minScore, maxItems, preferEarlier}`。
 * @returns {{hits:object[], tier:'summary'|'raw'|'none', topScore:number, secondScore:number, summaryTop:number, rawTop:number}} 同 `retrieveTwoTier`。
 */
export function decideTier(summaryHits, rawHits, options) {
  const minScore = Number(options?.minScore) || 0;
  const maxItems = Math.max(0, options?.maxItems ?? 2);
  const preferEarlier = options?.preferEarlier === true;
  const summaryTop = summaryHits[0]?.score ?? 0;
  const summarySecond = summaryHits[1]?.score ?? 0;
  const rawTop = (rawHits[0]?.score ?? 0) * RAW_PENALTY;
  const rawSecond = (rawHits[1]?.score ?? 0) * RAW_PENALTY;

  if (summaryTop >= minScore && summaryTop >= rawTop) {
    return { hits: pick(orderHits(summaryHits, preferEarlier), minScore, maxItems), tier: 'summary', topScore: summaryTop, secondScore: summarySecond, summaryTop, rawTop };
  }
  if (rawTop >= minScore) {
    // L2 是原话，噪声更大：只取 1 条（最多 2 条），且第二条必须非常接近
    return {
      hits: pick(orderHits(rawHits, preferEarlier), minScore / RAW_PENALTY, Math.min(maxItems, 2)),
      tier: 'raw',
      topScore: rawTop,
      secondScore: rawSecond,
      summaryTop,
      rawTop,
    };
  }
  return { hits: [], tier: 'none', topScore: Math.max(summaryTop, rawTop), secondScore: Math.max(summarySecond, rawSecond), summaryTop, rawTop };
}

/**
 * **同分时优先较早的块**（只在"问了时间指代词"的那一轮生效）。
 *
 * ⚠️ 2026-10-12 起它只是**时间重排之后**的最后一道平手规则（见 `rankQualifiedByTime`）：
 * 分数仍然不同时**一个字都不动**（`rankQualifiedByTime` 里的比较就是"先分数、后时间"）。
 * 所以这一段的历史依据（"分数不同时不弄坏既有的新者优先"）依然成立。
 * @param {object[]} hits - 候选（已按分数降序）。
 * @param {boolean} preferEarlier - 是否启用。
 * @returns {object[]} 排好序的候选。
 */
function orderHits(hits, preferEarlier) {
  if (preferEarlier !== true) return hits;
  return [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const atA = Date.parse(String(a.record?.at ?? ''));
    const atB = Date.parse(String(b.record?.at ?? ''));
    if (Number.isFinite(atA) && Number.isFinite(atB) && atA !== atB) return atA - atB;
    return String(b.record?.at ?? '').localeCompare(String(a.record?.at ?? ''));
  });
}

/**
 * 时间指代词那一路的**乘法加成**（★ 保留常量名与量级，但语义变了）。
 *
 * ⚠️ **2026-10-12 起它不再是一个"一路乘到底的系数"，也不再是"乘在词法分上的加权"**：
 *   · 用处只剩一个 —— `TIME_REFERENCE_BOOST_RANGE` 的**默认上界**（用户要求"幅度必须有上限"）。
 *   · 时间系数现在由 `timeCoefficient` 按三类形状（单调新 / 单调旧 / 钟形偏新）**逐块**算出，
 *     区间是 `[0.7, 1.35]`（默认），**绝不再把窗口分整个替换掉词法分**。
 *
 * ⚠️ 旧实现的病（用户 2026-10-12 明确指出的根因，**不要再走回去**）：
 *   `boostExisting` 把"窗口这一路的分 × 1.35"**替换**掉候选在段里的分数，再拿这个分数去
 *   过 `minScore` —— 等于**把门槛整体降低 1/1.35**。凡是"字面分本来不够、但窗口分够"的块
 *   因此被放进注入。"多路并集 / 分级加权"前几轮变成负收益，根因就是这一步。
 * 现在的分工是**结构性**的：
 *   · 候选集合 与 "谁过门/过阈值" —— 只看**纯词法分**（`search` 的 BM25 分 + 证据门）；
 *   · 时间系数 —— 只重排**已经过门的那批**（`rankQualifiedByTime`），永远不会把
 *     没资格的块送进注入，也永远不会把有资格的块踢出注入。
 */
export const TIME_REFERENCE_BOOST = 1.35;

/**
 * 时间系数的**有界区间**（默认，可被设置覆盖）。下界 < 1 < 上界。
 *
 * 为什么必须有界（用户明确要求"幅度必须有上限"）：时间系数是乘在词法分上的微调，
 * 一个"字面完全不沾"的块不可能因为"时间对"而冒出来 —— 因为它在**重量之前**就已经
 * 被证据门/阈值拦掉了。有界还保证"时间对"最多把排名往前挪一点点，不会盖过词法的判断。
 * 0.7 / 1.35 的取值：与旧的 1.35 同量级（那张标定表还能对得上），下界取对称的宽松值 ——
 * **下界不能太小**，否则"最早"类里那些词法本来就弱的块会被一路压到队列末尾，
 * 而它恰恰可能是用户要的那条。
 */
export const TIME_REFERENCE_BOOST_RANGE = Object.freeze({ min: 0.7, max: TIME_REFERENCE_BOOST });

/**
 * 从设置对象里取时间重排参数（**带默认值与夹紧**，见 `DEFAULTS` 里的
 * `timeNearPeakShare` / `timeFarPeakShare` / `timeBellPeakShare` / `timeBellWidth` /
 * `timeBoostMin` / `timeBoostMax`）。
 *
 * 夹紧在这里再做一次（不依赖 `normalizeSettings`）：`unit.mjs` 会构造**假的**
 * `retrievalOptions`（不是设置对象），那些路径也必须拿到合法值 —— 否则一个 NaN 宽度
 * 会静默把整条钟形曲线压成 0。顺序：先各自夹到合法域，再保证 `min < max`
 * （区间写反时**交换**，而不是"夹到相等"—— 相等会让系数恒为 1，看起来像"功能没生效"）。
 * @param {object} [settings] - 设置对象（缺省用 `DEFAULTS`）。
 * @returns {{nearPeak:number, farPeak:number, bellPeak:number, bellWidth:number, min:number, max:number}} 夹紧后的参数。
 */
export function timeRankParams(settings) {
  const source = settings ?? {};
  const num = (key, fallback, low, high) => {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(high, Math.max(low, value));
  };
  const min = num('timeBoostMin', TIME_REFERENCE_BOOST_RANGE.min, 0.1, 1);
  const max = num('timeBoostMax', TIME_REFERENCE_BOOST_RANGE.max, 1, 3);
  /* ⚠️ 这里**不需要**任何"min > max 就把它们换过来"的补丁：上面两条夹紧的区间分别是
   * `[0.1, 1]` 与 `[1, 3]`，于是**结构上**恒有 `min ≤ 1 ≤ max`（写反了也走不到这里）。
   * 早先那版写过一个"写反就交换"的分支 —— 它是**不可达的死代码**，这一版删掉。
   * `min === max` 是**合法**取值：表示"时间系数恒等于这个值"（= 幅度为零），
   * 用户明确关掉时间调整的一种写法，必须原样保留（`config.js` 同口径）。 */
  return {
    // 三个"波峰位置比例"都在 [0,1]：0 = 最早那块，1 = 最新那块。
    nearPeak: num('timeNearPeakShare', DEFAULTS.timeNearPeakShare, 0.5, 1),
    farPeak: num('timeFarPeakShare', DEFAULTS.timeFarPeakShare, 0, 0.5),
    bellPeak: num('timeBellPeakShare', DEFAULTS.timeBellPeakShare, 0.5, 1),
    bellWidth: num('timeBellWidth', DEFAULTS.timeBellWidth, 0.05, 2),
    // `both_ends` 的"中间凹陷深度"（[0,1] 的形状值尺度；见 `DEFAULTS.timeBothEndsDip`）。
    bothEndsDip: num('timeBothEndsDip', DEFAULTS.timeBothEndsDip, 0, 1),
    min,
    max,
  };
}

/**
 * 一批块在"**全库**时间轴"上的**相对位置**（0 = 最早，1 = 最新）。
 *
 * 判据（三级，逐级回退）：
 *   ① `record.at`（入库时写的 ISO 时间）；
 *   ② `record.seqRange[1]`（被压掉的会话区间终点，单调，能区分**跨压缩事件**的先后）；
 *   ③ **它在库文件里的序号**（`pool` 下标）。
 *
 * ⚠️ **为什么必须有第 ③ 级（2026-10-12 实测发现的硬事实）**：本插件的库是**按压缩事件
 * 分片**的，而同一次压缩入库的所有块 `(at, seqRange)` **完全相同** ——
 * 真实库（223 块 / 5 次压缩）实测：`distinct at = 5`、`distinct (at, seqRange) = 5`，
 * 且 `turn` 字段全是 `null`。也就是说**索引里没有"同一次压缩内部谁先谁后"的信息**。
 * 只按 ①② 排位，同一次压缩里的几十块会挤在同一个位置（真实库上是 10-08 那次压缩的
 * #122..#222，共 101 块）——钟形曲线在那里**完全失效**（所有块拿到同一个系数）。
 * 第 ③ 级用文件序号把它们铺开：对 L2（原文块）而言，`rawRecords` 是**按会话事件顺序**
 * 依次写块的，所以文件序号在 L2 内部就**近似内容时间顺序**（工具结果块排在对话块之后，
 * 见 `lib/ingest.js` 的合并顺序）——这是索引里唯一可用的序，也是"不重建历史库"前提下
 * 唯一能得到的序（用户硬约束：不需要重建历史库）。
 * 代价照实说：同一次压缩内部的时间先后是**近似**的（L1 摘要块之间更是文件顺序而非时间顺序，
 * 但 L1 极少胜出，见 `decideTier` 的选层）；跨压缩事件之间是**精确**的。
 *
 * 为什么用**位次**而不是"时间差"：同一 `(at, seq)` 里的块时间上是连续的，用时间差会把它们
 * 压成一个点。位次（`严格更小的个数 / (n-1)`）把"跨事件的先后"与"事件内的先后"都表达出来，
 * 且**与本次问了什么无关**（用户要求"在全库的相对位置"）——相对"这一批候选"算的话，
 * 同一个块的位置会随别的问题的候选集合变化，不可解释也不可复现。
 * 完全同键（连下标都相同）只可能出现在 pool 里同一对象出现两次，此时同值。
 * @param {object[]} targets - 要算位置的块（记录对象）。
 * @param {object[]} pool - 全库记录（位置的分母）；为空时退化为 `targets` 自身。
 * @returns {(number|null)[]} 与 `targets` 等长；元素为 0..1 或 `null`（时间全不可知）。
 */
function libraryTimePositions(targets, pool) {
  const source = Array.isArray(pool) && pool.length > 0 ? pool : targets;
  if (source.length <= 1) return targets.map(() => null);
  const keys = source.map((record, ordinal) => timeKeyOf(record, ordinal));
  const known = keys.filter((key) => key.ok);
  if (known.length <= 1) return targets.map(() => null);
  const sorted = known.slice().sort(compareTimeKeys);
  const denominator = known.length - 1;
  const positionOfKey = (key) => {
    if (!key.ok) return null;
    let below = 0;
    for (const other of sorted) {
      if (compareTimeKeys(other, key) < 0) below += 1;
      else break;
    }
    return below / denominator;
  };
  const ordinalOf = new Map();
  source.forEach((record, ordinal) => { if (!ordinalOf.has(record)) ordinalOf.set(record, ordinal); });
  return targets.map((record) => {
    const ordinal = ordinalOf.get(record);
    if (ordinal === undefined) return null;
    return positionOfKey(keys[ordinal]);
  });
}

/** 记录的时间键（`{at, seq, ordinal, ok}`；`at` 为毫秒时间戳或 `null`）。 */
function timeKeyOf(record, ordinal) {
  const at = Date.parse(String(record?.at ?? ''));
  const seq = seqEndOf(record);
  if (Number.isFinite(at)) return { at, seq, ordinal, ok: true };
  if (Number.isFinite(seq)) return { at: null, seq, ordinal, ok: true };
  return { at: null, seq: null, ordinal, ok: false };
}

/** 记录的时间键里的 `seqRange` 终点（拿不到时为 `null`）。 */
function seqEndOf(record) {
  const range = record?.seqRange;
  const end = Array.isArray(range) ? Number(range[1]) : Number.NaN;
  return Number.isFinite(end) ? end : null;
}

/** 比较两个时间键：`at` → `seq` → `ordinal`（库文件序号，唯一，兜底把同一次压缩内部铺开）。 */
function compareTimeKeys(a, b) {
  if (a.at !== null && b.at !== null && a.at !== b.at) return a.at - b.at;
  if (a.at !== null && b.at === null) return 1;
  if (a.at === null && b.at !== null) return -1;
  const sa = a.seq ?? Number.NEGATIVE_INFINITY;
  const sb = b.seq ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) return sa - sb;
  return (a.ordinal ?? 0) - (b.ordinal ?? 0);
}

/**
 * **时间系数**（乘在块自己的词法分上；`1` = 不动）。
 *
 * 四种形状：
 *   · `'new'`（刚刚/刚才 → 单调偏新）：**线性**从最早处的最低值升到最新处的最高值。
 *     线性而不是指数，因为用户要的是"**不设硬界限**、越新越高"，指数会把它变成
 *     "只有最近几个才有意义"（那是硬界限的另一种写法）。线性、平滑、处处可导。
 *   · `'old'`（最早/最初 → 单调偏旧）：与 `'new'` 镜像 —— 线性从最新处的最低值升到最早处的最高值。
 *   · `'bell'`（之前/上次/原来 → **钟形，波峰偏新、无硬界**）：高斯型
 *     `exp(-((pos - peak) / width)²)`，在 `pos == peak` 处为最高值，往两端**平滑**衰减；
 *     因为 `width` 有限、且用了 `exp` 而不是"窗口外归零"，所以两端只是**更低**，不是被切掉
 *     （用户强调"最近和最早的权重都不如中间高"，并不是说两端为 0）。
 *   · `'both_ends'`（2026-10-12 新增 → **两端高、中间低**）：`1 - dip × 4p(1-p)`，
 *     其中 `4p(1-p)` 在 `p = 0.5` 处等于 1、两端等于 0，所以两端拿满、中间按 `dip` 压低
 *     （抛物线、处处平滑、**两端严格相等**）。它**只由「✕」路径的模型时间意图
 *     `both_ends` 驱动**（`lib/text.js` 的 `TIME_INTENT_SHAPES`）——
 *     自动检索那条路判不出"两头"，只会给出 `null`（见 `timeReferenceShapeOf`）。
 *     为什么是这个形状（用户原话的落地）："这件事被提过好几遍，最早一次与最近一次都相关、
 *     中间次要" —— 两端**一样高**（不分谁更重）、中间**低但不为零**（"次要"不等于"不要"）。
 *
 * 返回值都落在 `[params.min, params.max]`（有界微调），且**与词法分无关** ——
 * 它只看这个块在库里的位置，所以"一个字面完全不沾的块"不可能靠它冒出来。
 * @param {'new'|'bell'|'old'|'both_ends'|null} shape - 时间形状（`null` = 不重排）。
 * @param {number|null} position - 块在库里的相对位置（0..1，`null` = 时间未知）。
 * @param {object} params - `timeRankParams()` 的结果。
 * @returns {number} 系数（`1` = 原样）。
 */
export function timeCoefficient(shape, position, params) {
  if (shape === null || position === null || !Number.isFinite(position)) return 1;
  const p = Math.min(1, Math.max(0, position));
  const { nearPeak, farPeak, bellPeak, bellWidth, bothEndsDip, min, max } = params;
  // 形状值统一到 [0,1]：0 = 最不该抬、1 = 最该抬。
  let shaped;
  if (shape === 'new') {
    shaped = nearPeak <= 0 ? 1 : Math.min(1, p / nearPeak);
  } else if (shape === 'old') {
    shaped = farPeak >= 1 ? 1 : Math.min(1, (1 - p) / (1 - farPeak));
  } else if (shape === 'bell') {
    const z = (p - bellPeak) / bellWidth;
    shaped = Math.exp(-(z * z));
  } else if (shape === 'both_ends') {
    /* 两端高、中间低：`4p(1-p)` 在 p=0/1 处为 0、在 p=0.5 处为 1。
     * `dip = 0` → 恒为 1（各位置一样高，形状等于不存在，**合法**：用户关掉凹陷的一种写法）；
     * `dip = 1` → 中间压到形状值 0（贴着下界），两端仍拿满。
     * 参数缺失/非法时按 `DEFAULTS` 的默认深度兜底（`timeRankParams` 已经夹过，这里再防一次
     * NaN —— 假 `params`（unit 里手造的）也必须拿到合法曲线）。 */
    const dip = Number.isFinite(bothEndsDip) ? Math.min(1, Math.max(0, bothEndsDip)) : 0;
    shaped = 1 - dip * (4 * p * (1 - p));
  } else {
    return 1;
  }
  if (!Number.isFinite(shaped)) return 1;
  return min + (max - min) * Math.min(1, Math.max(0, shaped));
}

/**
 * 给一批**已经过门**的候选乘上时间系数（**只改排序，永不改资格**）。
 *
 * 这是"加权不改资格"的**唯一入口**。为什么做成一个独立函数而不是塞回 `search`：
 * "谁过门"是 `search` 在**一层之内**用 `minMatchedTerms` 判的（那时分数必须还是纯词法分），
 * 而"谁排前面"必须等两层合并、过了 `minScore` **之后**才算。所以顺序是：
 *   ① `search`（纯词法分 + 证据门）→ ② 合并去重 → ③ 时间系数重排 → ④ 排序 → ⑤ `pick`
 * 第 ③ 步在第 ⑤ 步之前，`pick` 看到的已经是重排后的顺序，但 `pick` **自己不再过阈值** ——
 * 于是时间系数既改得了"谁被取走"，又改不了"谁有资格"。
 * @param {object[]} hits - 某层的候选（已过证据门，按纯词法分降序）。
 * @param {object} options - `{shape, params, pool}`；`shape === null` 时**原样返回**（逐位不变）。
 * @returns {object[]} 新数组（`score` 已乘系数，另带 `timeCoefficient` 便于诊断）。
 */
export function rankQualifiedByTime(hits, options = {}) {
  const shape = options.shape ?? null;
  if (shape === null) return hits;
  const params = options.params ?? timeRankParams();
  const positions = libraryTimePositions(hits.map((hit) => hit.record), options.pool ?? []);
  return hits.map((hit, i) => {
    const coefficient = timeCoefficient(shape, positions[i], params);
    // `lexicalScore` 保留**乘系数之前**的纯词法分：`pick` 的第二条闸门必须继续拿它去比
    // `minScore`（那是"资格"），否则"时间系数很小"的块会在**取条**这一步被悄悄踢掉。
    return { ...hit, score: hit.score * coefficient, lexicalScore: hit.score, timeCoefficient: coefficient };
  });
}

/**
 * 「✕」路径的**候选重排**：按辅助模型给出的**时间意图**（`lib/text.js` 的
 * `TIME_INTENT_SHAPES`）把候选重新排序；**只重排，不改资格**。
 *
 * 为什么要有它、以及它为什么**不是**自动检索那条路：
 *   · 用户那句「我们刚刚说的那个**最早**提过的设想」需要的是**两端高**（最早一遍 + 刚刚一遍，
 *     现在问的是第三遍）。这件事**只有理解意思的模型能判**，而自动检索那条路（每次提问、
 *     0 成本）没有模型可用 —— 所以那里的口径是"判不清就不重排"（`timeReferenceShapeOf`
 *     多类冲突 → `null`）。
 *   · 点 ✕ 时有辅助模型，它已经在**原有那一次**改写调用里顺带输出了 `时间意图`
 *     （`lib/diagnose.js` 的 `focusedRewriteSystem` / `parseFocusedRewrite`，**不新增调用**）。
 *     这个意图唯一的作用就是**给本函数的 `shape`**。
 *
 * ⚠️ **铁律（与 `rankQualifiedByTime` 同一条）**：这里**只动顺序与分数**：
 *   · 入参 `candidates` 是**已经过证据门**的那批（调用方从 `index.search` 拿到的候选）；
 *   · 返回值的**元素集合与入参逐位相同**（不删、不增、不合并），只是顺序/分数不同；
 *   · `score` 是"词法分 × 时间系数"，`lexicalScore` 保留乘系数之前的纯词法分；
 *   · `shape === null`（`none` / 未知意图 / 没配模型）→ **原样返回**，逐位不变。
 * 也就是说：时间意图**永远不可能**把"字面分不够"的块变成候选，也**永远不可能**让任何块
 * 获得或失去"被注入"的资格（资格只由 `lib/retrieval.js` 的 `retrieveSegmented` 第一段判）。
 * @param {{record:object, score:number, lexicalScore?:number}[]} candidates - 已过门的候选。
 * @param {object} options - `{shape, params, pool}`。
 * @returns {{shape:string|null, ranked:object[], moved:number}} 重排结果；
 *   `moved` = 位置发生了变化的条数（诊断/断言用：证明"真的重排了"而不是空转）。
 */
export function rankByTimeIntent(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const shape = options.shape ?? null;
  // `shape === null`（意图是 `none` / 表外取值 / 没配模型）→ **原样返回**：逐位不变。
  if (shape === null || list.length === 0) return { shape, ranked: list.slice(), moved: 0 };
  const params = options.params ?? timeRankParams(options.settings);
  const positions = libraryTimePositions(list.map((item) => item?.record), options.pool ?? []);
  // 给每条挂上"它在入参里的位置"，排序后据此算 `moved`（证明真的重排了，不是空转）。
  const ranked = list.map((item, i) => {
    const coefficient = timeCoefficient(shape, positions[i], params);
    const lexical = Number(item?.lexicalScore ?? item?.score ?? 0);
    return { ...item, lexicalScore: lexical, score: lexical * coefficient, timeCoefficient: coefficient, __from: i };
  });
  ranked.sort((a, b) => b.score - a.score || String(b.record?.at ?? '').localeCompare(String(a.record?.at ?? '')));
  let moved = 0;
  ranked.forEach((item, i) => {
    if (item.__from !== i) moved += 1;
    delete item.__from;
  });
  return { shape, ranked, moved };
}

/**
 * **分段检索 + 合并**（治"长句摊薄"，且不丢多话题）。
 *
 * 动机（用户 2026-10-10 第 1、3 条）：
 *   · 现状把**整条消息**当一个查询、一个分数、一个分母。自然语言长消息里水词占大头，
 *     真正的问句被摊薄（那条 0.2453 的实测根因，见 `MATCHABLE_TOP_K`）。
 *   · 更糟的是**多话题会被丢掉**：一段话里 A、B 两个话题都与历史相关时，整条查询的 top-1
 *     只可能是"某一个"话题的块，另一个话题的块连候选都进不来。
 *
 * 口径（逐条对应要求）：
 *   ① 把当前查询切成句子/片段（`splitQuerySegments`，复用 `splitSentences`），**每段各自检索**
 *      （各自算 `raw/matchable`，各自过证据门）；
 *   ② **多段各取候选后合并**，同块去重（按 fp，取最高分），按分数排序 ——
 *      **绝不"只取最高分那一句"**（那等于把多话题丢掉，正是要修的）；
 *   ③ 合并后仍走**同一次** `decideTier`：`maxItems` / `minScore` 的语义一点没变，
 *      所以"≤2 条"的成本红线不受影响；
 *   ④ **兜底**：只有一段（无句读的整段、或本来就是一句话）时**直接委托 `retrieveTwoTier`**
 *      —— 逐位等价于改动前，不许比现在更差。
 *
 * ── ★ 2026-10-12：候选与"资格"只由词法分 + 证据门决定；时间系数**只重排** ★ ──────────
 * 这是"加权不改资格"的落点（用户明确指出的根本性错误，见 `TIME_REFERENCE_BOOST` 注释）。
 * 执行顺序被**结构性**地固定成两段，中间不许交叉：
 *
 *   **第一段（资格）**：各段 → `index.search`（纯词法 BM25 + 证据门）→ 按 fp 合并去重
 *                      → `decideTier(…, minScore)` → `qualified`。它同时定下
 *                      「选哪一层」（`tier`）与「这一层的候选集合」。
 *   **第二段（排序）**：只对 `qualified` 选中的那一层候选乘时间系数
 *                      （`rankQualifiedByTime`，按 `timeReferenceShapeOf(query)` 的形状
 *                      与块在全库的相对位置）→ `orderHits` → `pick`。
 *
 * 三条**不能动**的性质（各有断言钉住，见 `scripts/unit.mjs` 第 35 节）：
 *   ① 一个字面分不够的块，**时间系数再大也进不了注入** —— 它压根不在第一段的输出里；
 *   ② 一个字面分够的块，**时间系数再小也仍会被注入** —— `pick` 的第一条不设分数闸门，
 *      第二条的闸门拿 `lexicalScore`（乘系数之前）去比 `minScore`；
 *   ③ 时间系数**不改变选层**：`tier` 与"候选集合"都来自第一段，第二段只在那一层内部重排。
 *      （为什么不许改选层：选层要比较"L1 的打折分"与"L2 的打折分"，那是一次**资格**比较；
 *        让它受时间系数影响，就等于"时间对了就能从 L2 跳到 L1"，又把资格交给了加权。）
 *
 * **指代词窗口（`timeReferenceWindows`）在这一版里不再参与打分** —— 原因照实写：
 *   · 它原先的用途是"当独立的一路查询"（会把仅窗口命中的块拉进候选，缺陷 B，已否掉）；
 *   · 收敛成"只给已有候选加倍"后，它做的是**替换分数**，而那正是"把门槛降 1/1.35"
 *     （问题 2 的根因，已否掉）；
 *   · 新的时间重排只看"块的库内位置"，不需要窗口提供分数。窗口现在的用途是
 *     **确定时间形状的作用域**（形状取自含指代词的那一句，见下面的 `scope`）与**诊断**。
 * 这样它既没有被删（用户要求句级化，且它仍被调用、有断言），也不会再碰资格。
 * @param {MemoryIndex} index - 索引。
 * @param {string} query - 当前查询（用户那条消息，或它的"当前 + 前几轮"形态）。
 * @param {object} options - 与 `retrieveTwoTier` 相同，另加：
 *   `{timeBoost:false}` 关闭时间重排；`{timeParams}` 覆盖形状参数；`{pool}` 覆盖"全库"口径。
 * @returns {object} 与 `retrieveTwoTier` 同形状，另带 `segments`（实际检索的段数）与
 *   `timeShape` / `timeWindows`（诊断：本轮的形状与窗口）。
 */
export function retrieveSegmented(index, query, options = {}) {
  const minScore = options.minScore;
  const maxItems = Math.max(0, options.maxItems ?? 2);
  const preferSummary = options.preferSummaryChunks !== false;
  const timeBoost = options.timeBoost !== false;
  const windows = timeBoost ? timeReferenceWindows(query) : [];
  /* 时间形状：**在整条消息上判**（不是只看第一句）。
   *
   * ⚠️ 2026-10-12 改口径（多类冲突 → 不重排）之后，这里**必须**用整条消息：
   * 用户的判据是"**一条消息里**命中 ≥2 个不同类 → 分不清 → 本次不做任何时间重排"。
   * 早先这里取"含指代词的第一句"（`windows[0]`）当作用域 —— 那只覆盖了第一句，
   * 于是"第 1 句说『刚刚』、第 5 句说『最早』"这种消息仍会被判成单一类（`'new'`），
   * 等于**换了个地方继续做那条被否决的固定优先级**（固定取"第一句的那一类"）。
   * 整条消息判就对了：只有一个类时才重排，≥2 个类一律 `null`（= 与"不含指代词"同一条路径）。
   *
   * `windows` 仍然算、仍然回传（`timeWindows`，诊断/断言用），只是**不再充当形状的作用域**。 */
  const shape = timeBoost ? timeReferenceShapeOf(query) : null;
  const params = options.timeParams ?? timeRankParams(options.settings);
  const pool = Array.isArray(options.pool) ? options.pool : (Array.isArray(index?.records) ? index.records : []);
  // 「这一轮问了时间指代词 → 同分优先较早」必须在**两条路径上都生效**（见 `orderHits`）。
  // 只按形状判（= 认得出指代词）：没有指代词时这个开关连开都不会开，行为逐位不变。
  const preferEarlier = options.preferEarlier === true || shape !== null;
  const segments = splitQuerySegments(query);
  const topK = options.matchableTopK === undefined ? {} : { matchableTopK: options.matchableTopK };

  // ── 第一段（资格）：各段纯词法候选合并 ────────────────────────────────────────
  /* ⚠️ 单段（本来就一句话、或整段没有句读）**也走这条路**，不再"直接委托 `retrieveTwoTier`"。
   * 原因：时间重排只对"过了门的候选"生效，如果单段路径跳过它，那么**恰恰是最常见的短问句**
   * （`我最早对设置面板要求的原话是什么？`、`刚刚那个问题是测试…`）永远拿不到时间重排 ——
   * 实测真实库 65 条含指代词提问里 52 条是单段，功能会在 80% 的样本上"看起来没接上"。
   * 单段与整条查询在本函数里**逐位等价**（一个段 → 一次 `index.search`、limit 6、
   * 同一套 `matchableTopK` / 证据门 / `minScore`），所以"没有指代词时行为不变"依然成立 ——
   * 那由 `rankQualifiedByTime` 在 `shape === null` 时**原样返回**保证（有断言钉住）。 */
  const summaryMerged = new Map();
  const rawMerged = new Map();
  const keyOf = (hit) => String(hit.record?.fp ?? '') || `${hit.record?.layer}\u0000${hit.record?.title}`;
  const merge = (map, hits) => {
    for (const hit of hits) {
      const key = keyOf(hit);
      const existing = map.get(key);
      if (existing === undefined || hit.score > existing.score) map.set(key, hit);
    }
  };
  for (const path of segments) {
    if (preferSummary) merge(summaryMerged, index.search(path, { layers: ['summary'], limit: 6, ...topK }));
    merge(rawMerged, index.search(path, { layers: ['raw'], limit: 6, ...topK }));
  }
  const byScore = (a, b) => b.score - a.score || String(b.record?.at ?? '').localeCompare(String(a.record?.at ?? ''));
  const summaryHits = [...summaryMerged.values()].sort(byScore);
  const rawHits = [...rawMerged.values()].sort(byScore);

  /* ⚠️ 这里就是"资格判定"，而且**必须只发生在这一句**：`minScore` 与"选哪一层"都在
   * `decideTier` 里，输入是**纯词法分**（`index.search` 的输出，没有被任何加权碰过）。
   * 下面再有 `decideTier` 之前，绝对不许往这批分数上乘任何东西 ——
   * 那就是"把门槛整体降低 1/BOOST"的旧病（见 `TIME_REFERENCE_BOOST` 注释）。 */
  const qualified = decideTier(summaryHits, rawHits, { minScore, maxItems, preferEarlier: false });
  /* `candidates` = **第一段的输出**（过了证据门 与 `minScore` 的那一层候选，按纯词法分排序，
   * 含每条的 `lexicalScore`）。它是"资格"的**可观测快照**，也是本轮唯一的资格口径：
   *   · 它**完全不受时间系数影响**（在 `rankQualifiedByTime` 之前就固定下来）——
   *     `harness.mjs` 的 e2e 回归拿"开/关时间重排的 `candidates` 必须逐位相同"当
   *     "加权不改资格"的守卫；
   *   · 注意它与 `hits` **不是一回事**：`hits` 是"从这批候选里按重排后的顺序取 ≤maxItems 条"。
   *     排序变了，`hits` 当然可能变（那正是排序该起的作用），但 `candidates` 不许变。
   *   · `tier === 'none'` 时为空数组（没有任何块有资格）。 */
  const candidatePool = qualified.tier === 'none' ? [] : (qualified.tier === 'summary' ? summaryHits : rawHits)
    .map((hit) => ({ record: hit.record, lexicalScore: hit.score, matched: hit.matched }));
  if (qualified.tier === 'none') {
    return { ...qualified, candidates: candidatePool, segments: segments.length, timeShape: shape, timeWindows: windows };
  }

  // ── 第二段（排序）：只在"已经过门的那一层"内部乘时间系数重排 ──────────────────
  const layerHits = qualified.tier === 'summary' ? summaryHits : rawHits;
  const penalty = qualified.tier === 'raw' ? RAW_PENALTY : 1;
  const ranked = rankQualifiedByTime(layerHits, { shape, params, pool });
  const ordered = orderHits([...ranked].sort(byScore), preferEarlier);
  const hits = pick(ordered, qualified.tier === 'raw' ? minScore / RAW_PENALTY : minScore, qualified.tier === 'raw' ? Math.min(maxItems, 2) : maxItems);
  const summaryRankedTop = qualified.tier === 'summary' ? (ordered[0]?.score ?? 0) : 0;
  const rawRankedTop = qualified.tier === 'raw' ? (ordered[0]?.score ?? 0) * RAW_PENALTY : 0;
  return {
    hits,
    tier: qualified.tier,
    /* **资格快照**（第一段的输出，见上面 `candidatePool` 的说明）。
     * ⚠️ 这里返回的是 `candidates`（按纯词法分排序、**不带**时间系数），不是"最终注入的那批" ——
     * 后者是 `hits`（≤ `maxItems` 条，顺序已被时间重排）。两件事都能观测，含义不要混。 */
    candidates: candidatePool,
    // `topScore` / `secondScore` 报告**重排之后**的值（它们要进诊断与日志，必须和最终注入一致）。
    // `lexicalTopScore` 同时给出"重排之前"的纯词法分，便于把两件事分开看。
    topScore: ordered.length > 0 ? ordered[0].score * penalty : qualified.topScore,
    secondScore: ordered.length > 1 ? ordered[1].score * penalty : 0,
    summaryTop: qualified.tier === 'summary' ? summaryRankedTop : (qualified.summaryTop ?? 0),
    rawTop: qualified.tier === 'raw' ? rawRankedTop : (qualified.rawTop ?? 0),
    lexicalTopScore: qualified.topScore,
    segments: segments.length,
    timeShape: shape,
    timeWindows: windows,
  };
}

/**
 * 取前 N 条：第二条必须与第一条分数接近，否则宁少勿多。
 *
 * ⚠️ **第一条不设分数闸门**（那是"资格"的事，已经在 `decideTier` / `retrieveSegmented`
 * 的第一段判完）—— 所以时间系数把第一条压到多低，它**依然被注入**。
 * 第二条的 `minScore` 闸门拿 `lexicalScore`（乘系数**之前**的纯词法分）去比：
 * 如果不这么做，"时间系数很小"的块会在**取条**这一步被静默踢掉，等于加权又能改资格了。
 * 至于"第二条与第一条够不够接近"（0.72），那是**排序**层的事，因此看的是重排之后的分 ——
 * 时间重排本来就可能把两条拉近或拉远，这正是它该起的作用。
 */
function pick(hits, minScore, maxItems) {
  if (maxItems <= 0 || hits.length === 0) return [];
  const out = [hits[0]];
  if (maxItems >= 2 && hits.length >= 2) {
    const [first, second] = hits;
    const secondLexical = Number(second.lexicalScore ?? second.score);
    if (secondLexical >= minScore && second.score >= first.score * 0.72) out.push(second);
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
