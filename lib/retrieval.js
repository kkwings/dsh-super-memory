/**
 * dsh-super-memory — 本地词法检索（方案 A：纯词法，0 模型调用、0 联网）
 *
 * 打分：带字段权重的 BM25（title / keywords 权重高于正文），
 * 归一化为 0..1 左右的可比较分数，便于 minScore 直接调阈值。
 */
import { conclusionScore, hasTimeReference, splitQuerySegments, surfaceTermsOf, timeReferenceWindows, tokenize } from './text.js';

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
 * 用户第 5 条的后半句：这类问题的意图是"去翻更早的记录"。**做，但只做同分这一层**，理由：
 *   · 只改**平手**时谁在前。分数不同时一个字都不动 → 不可能把"最新优先"的既有行为弄坏
 *     （库里绝大多数块的分数都不相同，实测 13 条真实查询里 0 条受影响）。
 *   · 早/晚的判据用 `record.at`（入库时写的 ISO 时间），解析不出来就**回落到现有的
 *     "新者优先"** —— 不猜、不拿 `seq` 之类可能缺失的字段硬排。
 *   · 不做"整体按时间加权"：那会让"想找当年的结论"变成"想找最早的一条"，
 *     与 `conclusionScore` 的既有取向直接冲突（未做，见报告"未做"节）。
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
 * 时间指代词那一路的**乘法加成**。
 *
 * 选择理由（用户第 5 条要求）：指代词出现 → "这些词附近的**其他词**权重提高"。
 * 三个可选项里选了**"把指代词邻近窗口单独当一路查询、并给它一个加成系数"**：
 *   · vs「给整条消息加权」：整条消息 1,000 字时第 5 字与第 900 字一起抬，正是用户要避免的
 *     "散落关键词"；窗口（`timeReferenceWindows`，默认 ±60 字符）把它集中起来。
 *   · vs「改 `search` 内部的 `raw` 累加」：那要动 BM25 的分子，会让"命中几个词"的口径跟着变
 *     （证据门是拿 `matched` 判的）—— 这一路只改**它自己**的成绩，`matched`/门都不受影响。
 *   · 它是**加法路径**：不含指代词的消息连这段代码都不会走到（行为逐位不变，有断言钉住）。
 * 1.35 的取值：窗口这一路本身通常只有 4–8 个词，`matched` 容易刚到门（floor=4），
 * 因此需要足够把"刚好过门但没到阈值"的目标块推进阈值之上；同时不能大到让不相关窗口也越过 0.28。
 * 1.2 / 1.35 / 1.5 三档在"含指代词"用例上都能把目标块推进 top-2；保守取中间值，留两端余量。
 *
 * ⚠️ **2026-10-10 收敛（缺陷 B）**：这一路现在**只能给"已经有候选的块"加成，绝不单独把新块拉进来**
 * （实现见 `retrieveSegmented` 里的窗口合并）。理由是实测出来的：
 *   · 指代词是**集中器**，不是**发现器** —— 它的任务是"把注意力收回到指代词附近"，而不是
 *     "凭指代词附近那 60 个字，断定某个块相关"。窗口只有 ±60 字符，里面的词大多是水词，
 *     单独成一路时 `matched` 常常刚好到门，于是**只因为"旁边有'最早'二字"就被拉进候选**。
 *   · 实测（真实库 223 块）：窗口这一路单独引入的候选出现在 **20/59** 条含指代词的真实提问里，
 *     引入的块里有明确不相关的（聊天记录里"顺便说点别的"那类）。收敛后"没被任何一段命中的块
 *     永远不会因为窗口而进入候选"，这正是缺陷 B 要求的性质。
 *   · 代价（照实写）：如果某个目标块**只有窗口**能过门，收敛后它会丢。本机真实日志上
 *     `harness.mjs` / `selftest.mjs` 的"已入库提问必须注入"断言逐条复核过（见报告），
 *     没有因此变红 —— 也就是说真正靠窗口才能救回来的块，在实测样本里没有出现。
 */
export const TIME_REFERENCE_BOOST = 1.35;

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
 * 为什么合并时用"各段自己的归一化分数"直接比大小：要求里写的就是"各自算 `raw/matchable`"。
 * 这一点是有代价的（短片段的分母天然小、比值天然高），所以 `splitQuerySegments` 先把
 * 过短片段并进邻居；合并后**仍然要过 `minScore`**，短片段想靠"分母小"混进来还得先过阈值。
 * @param {MemoryIndex} index - 索引。
 * @param {string} query - 当前查询（用户那条消息，或它的"当前 + 前几轮"形态）。
 * @param {object} options - 与 `retrieveTwoTier` 相同，另加 `{timeBoost:false}` 关闭指代词那一路。
 * @returns {object} 与 `retrieveTwoTier` 同形状，另带 `segments`（实际检索的段数）。
 */
export function retrieveSegmented(index, query, options = {}) {
  const minScore = options.minScore;
  const maxItems = Math.max(0, options.maxItems ?? 2);
  const preferSummary = options.preferSummaryChunks !== false;
  // 「这一轮问了时间指代词 → 同分优先较早」必须在**两条路径上都生效**（见 `orderHits`）。
  // 只按 `hasTimeReference` 判：没有指代词时这个开关连开都不会开，行为逐位不变。
  const preferEarlier = options.preferEarlier === true
    || (options.timeBoost !== false && hasTimeReference(query));
  const segments = splitQuerySegments(query);
  if (segments.length <= 1) {
    const single = retrieveTwoTier(index, query, { ...options, preferEarlier });
    return { ...single, segments: segments.length };
  }

  // 指代词：扫**整条消息的所有出现位置**（`timeReferenceWindows` 内部就是全扫），
  // 取邻近窗口当**证据**（不是独立的另一路）。位置与"在句首/句末"无关 —— 这是要求里的硬约束。
  const windows = options.timeBoost === false ? [] : timeReferenceWindows(query)
    .map((window) => ({ start: window.start, end: window.end, text: query.slice(window.start, window.end).trim() }))
    .filter((window) => window.text !== '' && window.text !== query.trim());

  // 每一路各取两层候选，按契约把同类候选合并（同 fp 取最高分）。
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
    if (preferSummary) merge(summaryMerged, index.search(path, { layers: ['summary'], limit: 6 }));
    merge(rawMerged, index.search(path, { layers: ['raw'], limit: 6 }));
  }
  /* ── 窗口那一路：**只作为附加证据**，不允许单独把新块拉进候选（2026-10-10 缺陷 B）──────
   * 规则：把窗口当查询取候选，但**只对"已经在段候选里"的块生效** —— 命中就把那个块
   * 在**同一层**的分数替换为 `窗口分 × TIME_REFERENCE_BOOST`（只在更高时才替换），
   * 窗口候选里那些"段里没有的块"直接丢弃。
   *
   * 为什么选这条规则（而不是"窗口那条路同样过证据门"）：
   *   · 窗口只有 ±60 字符，里面的词大多是水词；"同样过证据门"挡不住**长窗口**
   *     （实测 233 字符的窗口里 matched 能到 7–23），所以它挡不住"仅因窗口而进入候选"；
   *   · 而"只加成已有候选"是**结构性**的保证：候选集合完全由各段决定，窗口一个块都加不进来 —
   *     "含『最早』但无关的块"因此在结构上不可能进入候选；
   *   · 它同时保住了加权的**目的**（指代词附近的词权重更高）：窗口命中说明"这个词和指代词
   *     挨着"，那就把那个块的成绩抬上去 —— 抬分需要它本来就进过候选，等于**要求它先有证据**。
   * 代价照实写：只有窗口能过门、任何一段都过不了门的块，收敛后会丢（见 TIME_REFERENCE_BOOST 注释）。 */
  const boostExisting = (map, hits) => {
    for (const hit of hits) {
      const key = keyOf(hit);
      const existing = map.get(key);
      if (existing === undefined) continue;
      const boosted = hit.score * TIME_REFERENCE_BOOST;
      if (boosted > existing.score) map.set(key, { ...hit, score: boosted });
    }
  };
  for (const window of windows) {
    if (preferSummary) boostExisting(summaryMerged, index.search(window.text, { layers: ['summary'], limit: 6 }));
    boostExisting(rawMerged, index.search(window.text, { layers: ['raw'], limit: 6 }));
  }
  const byScore = (a, b) => b.score - a.score || String(b.record?.at ?? '').localeCompare(String(a.record?.at ?? ''));
  const summaryHits = [...summaryMerged.values()].sort(byScore);
  const rawHits = [...rawMerged.values()].sort(byScore);
  // 同一块可能同时从"某一段"和"指代词窗口"进来：合并时按 fp 去重，**只算一次**。
  return { ...decideTier(summaryHits, rawHits, { minScore, maxItems, preferEarlier }), segments: segments.length };
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
