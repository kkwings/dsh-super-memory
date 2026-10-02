/**
 * dsh-super-memory — 压缩后总览（目录级，自适应，可为 0）
 *
 * 全部由本地规则从已入库的 L1 摘要块里挑，**0 模型调用**；
 * 上限是天花板不是配额：挑不出值得留的就完全不再注入（0 token）。
 */
import { MARKER, conclusionScore, estimateTokens } from './text.js';

const HEADER = `${MARKER}【本会话此前脉络】以下是本次会话更早（已被压缩）的部分，仅供把握上下文，不需要复述：`;

/** 一行里的"结论"截取长度。 */
const CONCLUSION_CHARS = 64;

/** 取块正文里第一句有信息量的话作为结论摘要。 */
function conclusionOf(record) {
  const text = String(record.text ?? '');
  const title = String(record.title ?? '');
  const lines = text.split('\n').map((line) => line.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim());
  for (const line of lines) {
    if (line === '' || line === title) continue;
    if (line.startsWith('问：')) continue;
    if (line.length < 8) continue;
    if (title.length >= 6 && (line.startsWith(title) || title.startsWith(line))) continue; // 与标题重复
    return line.length <= CONCLUSION_CHARS ? line : `${line.slice(0, CONCLUSION_CHARS)}…`;
  }
  return '';
}

/** 主题行看起来是"半句话碎片"（列表被切断的产物）。 */
function looksLikeFragment(title) {
  if (title.length < 6) return true;
  if (/[,，、;；:：]$/.test(title)) return true;
  if (/(into|and|via|with|to|for|of|the)$/i.test(title)) return true;
  if (/^[)\]）】]/.test(title)) return true;
  if ((title.match(/[（(]/g)?.length ?? 0) !== (title.match(/[）)]/g)?.length ?? 0)) return true;
  return false;
}

/**
 * 生成总览文本。
 * @param {object[]} records - 本会话全部记忆块。
 * @param {object} options - 选项。
 * @param {number} options.maxTokens - 总览 token 上限（0 = 不注入）。
 * @returns {{text:string, tokens:number, lines:number}} 总览。
 */
export function buildRecap(records, options = {}) {
  const maxTokens = Math.max(0, options.maxTokens ?? 300);
  if (maxTokens === 0 || !Array.isArray(records) || records.length === 0) {
    return { text: '', tokens: 0, lines: 0 };
  }
  const summaries = records.filter((record) => record.layer === 'summary');
  const pool = summaries.length > 0 ? summaries : records;

  // 按压缩轮次分组，组内保持原始顺序；组间按时间倒序（新的优先入选）
  const groups = new Map();
  for (const record of pool) {
    const key = String(record.compactionId ?? record.at ?? 'unknown');
    if (!groups.has(key)) groups.set(key, { at: String(record.at ?? ''), records: [] });
    const group = groups.get(key);
    group.records.push(record);
    if (String(record.at ?? '') > group.at) group.at = String(record.at ?? '');
  }
  const ordered = [...groups.values()].sort((a, b) => b.at.localeCompare(a.at));

  // 择优：结论性 + 标题信息量，避免把纯列表/纯问答块顶上来
  // 组序号（0 = 最新一轮）：同一标题只留一条时，靠前的那条更贴近当前状态
  const groupRank = new Map();
  ordered.forEach((group, index) => groupRank.set(group, index));
  const ranked = [];
  for (const group of ordered) {
    const recency = ordered.length <= 1
      ? 0
      : 0.15 * (1 - (groupRank.get(group) ?? 0) / (ordered.length - 1));
    for (const record of group.records) {
      const title = String(record.title ?? '').trim();
      if (title === '' || title.includes('<')) continue;
      if (/^[A-Za-z]:[\\/]/.test(title)) continue; // 路径当标题没有信息量
      if (looksLikeFragment(title)) continue;
      const text = String(record.text ?? '');
      if (text.length < 80) continue;
      const score = conclusionScore(text) * 1.2
        + (record.layer === 'summary' ? 0.6 : 0)
        + Math.min(0.5, title.length / 40)
        + (/^[\d.、]/.test(title) ? -0.2 : 0)
        + recency;
      ranked.push({ record, score, at: String(record.at ?? '') });
    }
  }
  ranked.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));

  const budget = maxTokens - estimateTokens(HEADER);
  if (budget <= 0) return { text: '', tokens: 0, lines: 0 };
  const chosen = [];
  let used = 0;
  const seenTitles = [];
  for (const item of ranked) {
    const title = String(item.record.title ?? '').trim();
    if (seenTitles.some((seen) => seen === title)) continue;
    const conclusion = conclusionOf(item.record);
    const line = conclusion === '' ? `- ${title}` : `- ${title} — ${conclusion}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) continue;
    used += cost;
    seenTitles.push(title);
    chosen.push({ line, at: item.at });
    if (chosen.length >= 12) break;
  }
  if (chosen.length === 0) return { text: '', tokens: 0, lines: 0 };
  chosen.sort((a, b) => a.at.localeCompare(b.at));
  const text = `${HEADER}\n${chosen.map((item) => item.line).join('\n')}`;
  return { text, tokens: estimateTokens(text), lines: chosen.length };
}
