/**
 * dsh-super-memory — 提问时检索与注入文本（命中才注入，未命中 0 token）
 *
 * 查询构造：当前用户消息 + 最近 2–3 条用户消息拼接 —— 这样"那这个呢"这类
 * 指代型短问句也能带上前面几轮的话题词。
 */
import { MARKER, estimateTokens, stripMarkerSegments, textFromBlocks } from './text.js';

const HEADER = `${MARKER}【本次会话更早（已被压缩）的参考】以下内容来自本会话早前（已被压缩）的部分，仅供参照；若当前结论与它不同，请说明"此前是 X，这次因为 Y 改为 Z"，不要静默改口。`;

/**
 * 从一条"用户消息形状"的对象里取出提问文本。
 * 只认 `source.kind === 'user'`；运行时上下文快照、检查点、指令注入、
 * 只含本插件标记的段落一律返回 ''（这些不是用户在问问题）。
 * @param {object} message - UserMessage 形状的对象（`{content, source}`）。
 * @returns {string} 提问文本，没有则 ''。
 */
export function questionTextOf(message) {
  const data = message ?? {};
  if (data.source?.kind !== 'user') return '';
  const text = stripMarkerSegments(textFromBlocks(data.content)).trim();
  if (text === '' || text.includes(MARKER)) return '';
  return text;
}

/**
 * 从一条 `user/message` 会话事件里取出提问文本。
 * @param {object} event - 会话事件。
 * @returns {string} 提问文本，没有则 ''。
 */
export function queryTextOf(event) {
  if (event?.type !== 'user/message') return '';
  return questionTextOf(event.data);
}

/**
 * 收集最近若干条真实用户消息作为查询。
 * 返回两个形态：`latest` 只有当前这条提问（干净、精确），`text` 是它与前几轮的拼接
 * （给"那这个呢"这类指代型短问句兜底）。检索时先用 latest，不够再用 text。
 * @param {object} session - DSH Session。
 * @param {number} turns - 取多少条（含当前这条）。
 * @returns {{text:string, latest:string, seq:number}} 查询文本与最新用户消息的 seq。
 */
export function collectQuery(session, turns) {
  const n = Math.max(1, turns ?? 3);
  const messages = [];
  let latestSeq = -1;
  let events = [];
  try {
    events = session.snapshotEvents();
  } catch {
    return { text: '', latest: '', seq: -1 };
  }
  for (let i = events.length - 1; i >= 0 && messages.length < n; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    const text = queryTextOf(event);
    if (text === '') continue;
    if (latestSeq < 0) latestSeq = Number(event.seq) || 0;
    messages.push(text);
  }
  messages.reverse();
  const latest = messages.length > 0 ? messages[messages.length - 1] : '';
  return { text: messages.join('\n'), latest, seq: latestSeq };
}

/** 把一条记忆块压成"话题 — 结论"一行。 */
function itemText(record, maxChars) {
  const title = String(record.title ?? '').trim();
  const body = String(record.text ?? '')
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line !== '' && line !== title);
  const preferred = body.filter((line) => !line.startsWith('问：') && !line.startsWith('答：'));
  const source = preferred.length > 0 ? preferred : body;
  const conclusion = source.join(' ').replace(/\s+/g, ' ').trim();
  let line = title === '' ? conclusion : (conclusion === '' ? title : `${title} — ${conclusion}`);
  line = line.replace(/\s+/g, ' ').trim();
  if (line.length > maxChars) line = `${line.slice(0, Math.max(1, maxChars - 1))}…`;
  return line;
}

/**
 * 按硬上限拼装注入文本：条数、每条字符数、单轮 token 数三重夹紧。
 * @param {object[]} hits - 检索结果（含 record）。
 * @param {object} limits - 上限。
 * @returns {{text:string, tokens:number, items:number}} 注入文本。
 */
export function formatRecall(hits, limits) {
  const maxItems = Math.max(0, limits.maxItems ?? 2);
  const maxChars = Math.max(20, limits.maxCharsPerItem ?? 300);
  const maxTokens = Math.max(0, limits.maxTokensPerTurn ?? 500);
  if (maxItems === 0 || maxTokens === 0 || !Array.isArray(hits) || hits.length === 0) {
    return { text: '', tokens: 0, items: 0 };
  }
  const lines = [];
  for (const hit of hits.slice(0, maxItems)) {
    const line = itemText(hit.record, maxChars);
    if (line.trim() === '') continue;
    lines.push(`- ${line}`);
  }
  if (lines.length === 0) return { text: '', tokens: 0, items: 0 };
  let text = `${HEADER}\n${lines.join('\n')}`;
  while (lines.length > 1 && estimateTokens(text) > maxTokens) {
    lines.pop();
    text = `${HEADER}\n${lines.join('\n')}`;
  }
  if (estimateTokens(text) > maxTokens) {
    // 单条也超预算：按**实际估算**迭代收缩，而不是用固定的字符/token 比反推
    // —— 拉丁文正文的字符/token 比跟中文差三倍，一次反推往往仍然超预算。
    let keep = lines[0].length;
    while (keep > 40) {
      const trial = `${HEADER}\n${[`${lines[0].slice(0, keep)}…`, ...lines.slice(1)].join('\n')}`;
      if (estimateTokens(trial) <= maxTokens) break;
      keep = Math.floor(keep * 0.9);
    }
    lines[0] = lines[0].length > keep ? `${lines[0].slice(0, keep)}…` : lines[0];
    text = `${HEADER}\n${lines.join('\n')}`;
    // 收缩到底仍然超预算（HEADER 自己就占掉大半、或上限被设得极小）：
    // **宁可不注入，也不能越过单轮硬上限** —— maxTokensPerTurn 是承诺给用户的成本红线。
    if (estimateTokens(text) > maxTokens) return { text: '', tokens: 0, items: 0 };
  }
  return { text, tokens: estimateTokens(text), items: lines.length };
}
