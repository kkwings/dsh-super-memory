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
