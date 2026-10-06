/**
 * dsh-super-memory — 压缩时入库（0 模型调用）
 *
 * L1 摘要块：直接使用 `compaction/summary` 事件里 DSH 已经生成好的摘要文本，
 *            按 Markdown 标题/段落切块，用本地规则提炼 title / keywords。
 * L2 原文块：按 `shadowedRange` 从会话事件流取出被压掉那段，**只保留对话文字**
 *            （用户消息 + 助手回答正文），丢弃 reasoning、tool-call、tool-result
 *            与系统注入；取不到时自动降级为只做 L1，不报错。
 */
import {
  extractKeywords, extractTitle, splitSummarySections,
  stripMarkerSegments, textFromBlocks,
} from './text.js';
import { makeRecord } from './store.js';

/** 单块正文硬上限（字符）。 */
const MAX_BLOCK_CHARS = 1500;
/** L2 合并目标长度（字符）。 */
const RAW_TARGET_CHARS = 900;

/**
 * 从摘要 ContentBlock[] 生成 L1 记录。
 * @param {object} input - 输入。
 * @returns {object[]} 记录数组。
 */
export function summaryRecords(input) {
  const raw = textFromBlocks(input.summary).replace(/<\/?compacted-summary>/g, '');
  const text = stripMarkerSegments(raw);
  if (text.trim() === '') return [];
  const blocks = splitSummarySections(text, { target: 500, maxChars: 900 });
  const records = [];
  for (const block of blocks) {
    const title = extractTitle(block, 40);
    records.push(makeRecord({
      layer: 'summary',
      session: input.sessionId,
      compactionId: input.compactionId,
      at: input.at,
      turn: input.turn,
      seqRange: input.seqRange,
      shadowedTokenCount: input.shadowedTokenCount,
      title,
      keywords: extractKeywords(block, { title, max: 8 }),
      text: block,
    }));
  }
  return records;
}

/**
 * 把会话事件折成"用户问 / 助手答"的轮次。
 * @param {object[]} events - 按 seq 升序的会话事件。
 * @param {object} settings - 设置（includeToolResults 等）。
 * @returns {{seq:number, user:string, assistant:string}[]} 轮次数组。
 */
export function conversationTurns(events, settings = {}) {
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'user/message') {
      const data = event.data ?? {};
      if (data.source?.kind !== 'user') continue; // 排除 runtime-context 等系统注入
      const text = stripMarkerSegments(textFromBlocks(data.content));
      if (text.trim() === '') continue;
      // 重试/重新生成会把同一条用户消息再追加一次：只在**上一轮还没产生回答**时才算重复。
      // （用户隔了几轮又原样问一遍，那是真的第二次提问，必须各留一轮，否则 history_read 查不到。）
      if (current !== null && current.user === text && current.assistant === '') continue;
      if (current !== null) turns.push(current);
      current = { seq: Number(event.seq) || 0, user: text, assistant: '' };
      continue;
    }
    if (event.type === 'assistant/message') {
      if (current === null) continue;
      const text = stripMarkerSegments(textFromBlocks(event.data?.message?.content));
      if (text.trim() === '') continue;
      current.assistant = current.assistant === '' ? text : `${current.assistant}\n${text}`;
      continue;
    }
  }
  if (current !== null) turns.push(current);
  return turns;
}

/** 白名单解析：逗号/空格分隔的工具名；`*` = 全部。 */
export function toolNameSet(raw) {
  const names = new Set();
  let all = false;
  for (const item of String(raw ?? '').split(/[,，\s]+/)) {
    const name = item.trim();
    if (name === '') continue;
    if (name === '*') { all = true; continue; }
    names.add(name);
  }
  return { names, all };
}

/** 从工具参数里挑一个"目标"当标题：文件名/模式/网址/命令，让检索能按标题命中。 */
function toolTarget(name, argsText) {
  let args = null;
  try { args = JSON.parse(String(argsText ?? '')); } catch { args = null; }
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');
  if (args !== null && typeof args === 'object') {
    for (const key of ['file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'command', 'description', 'name']) {
      const value = pick(args[key]);
      if (value !== '') return value.replace(/\\/g, '/').split('/').slice(-2).join('/');
    }
  }
  return name;
}

/**
 * 被压掉的"读类工具结果"原文，独立成 L2 记录。
 *
 * 为什么单独做：模型读过的设定文件、章节正文、检索结果**从来没进过记忆库**——
 * 而它们往往才是这个项目真正的知识。收进来时按工具名白名单 + 单条/单次上限，
 * 避免把 shell 输出这类噪声（实测占工具结果的 42%）一起灌进去。
 *
 * @param {object} input - 输入（events / sessionId / compactionId / at / settings）。
 * @returns {{records:object[], chars:number, kept:number, skipped:number, truncatedItems:number}}
 */
export function toolRecords(input) {
  const settings = input.settings ?? {};
  const events = Array.isArray(input.events) ? input.events : [];
  if (settings.includeToolResults !== true || events.length === 0) {
    return { records: [], chars: 0, kept: 0, skipped: 0, truncatedItems: 0 };
  }
  const { names, all } = toolNameSet(settings.toolResultNames ?? 'read, grep, glob, web_fetch, history_read');
  const maxChars = Math.max(200, Math.min(20000, Number(settings.toolResultMaxChars) || 4000));
  const budget = Math.max(0, Number(settings.toolResultBudgetChars) || 0);

  // 工具名在 tool/call 里，结果只有 callId —— 先建索引再配对
  const calls = new Map();
  for (const event of events) {
    if (event?.type !== 'tool/call') continue;
    calls.set(String(event.data?.callId ?? ''), {
      name: String(event.data?.name ?? ''),
      args: event.data?.arguments,
    });
  }

  const records = [];
  let chars = 0;
  let kept = 0;
  let skipped = 0;
  let truncatedItems = 0;
  for (const event of events) {
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message ?? {};
    if (message.isError === true) { skipped += 1; continue; }
    const call = calls.get(String(message.toolCallId ?? message.source?.callId ?? '')) ?? { name: '', args: '' };
    if (!all && !names.has(call.name)) { skipped += 1; continue; }
    let text = stripMarkerSegments(textFromBlocks(message.content)).trim();
    if (text === '') continue;
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}…（原 ${text.length} 字符，已截断）`;
      truncatedItems += 1;
    }
    const cost = text.length + 80; // 标题与字段的粗略开销
    if (budget > 0 && chars + cost > budget) { skipped += 1; continue; }
    chars += cost;
    kept += 1;
    const target = toolTarget(call.name, call.args);
    const title = `工具 ${call.name}：${target}`.slice(0, 60);
    records.push(makeRecord({
      layer: 'raw',
      session: input.sessionId,
      compactionId: input.compactionId,
      at: input.at,
      turn: input.turn,
      seqRange: [Number(event.seq) || 0, Number(event.seq) || 0],
      shadowedTokenCount: input.shadowedTokenCount,
      title,
      keywords: extractKeywords(`${target}\n${call.name}\n${text}`, { title, max: 10 }),
      text: `【工具 ${call.name} 的结果 · ${target}】\n${text}`,
      src: 'tool',
      tool: call.name,
    }));
  }
  return { records, chars, kept, skipped, truncatedItems };
}

/**
 * 按 shadowedRange 取出被压掉的对话文字，合并、切块成 L2 记录。
 * @param {object} input - 输入。
 * @returns {{records:object[], chars:number, truncated:boolean}} 结果。
 */
export function rawRecords(input) {
  const settings = input.settings ?? {};
  const range = input.range ?? {};
  const start = Number(range.start);
  const end = Number(range.end);
  // 必须带合法的 shadowedRange：缺了就当"这次没有原文可取"，绝不退化成
  // start=0/end=MAX 把整个会话事件流当原文入库（DSH 改字段名或换压缩插件时
  // 那会静默把全部历史灌进 L2，体积与检索噪声都会失控）。
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return { records: [], chars: 0, truncated: false };
  }
  let events = [];
  try {
    events = input.session.snapshotEvents().filter((event) => {
      const seq = Number(event.seq);
      return seq >= start && seq <= end;
    });
  } catch {
    return { records: [], chars: 0, truncated: false };
  }
  const turns = conversationTurns(events, settings);
  const tools = toolRecords({ ...input, events });
  if (turns.length === 0 && tools.records.length === 0) {
    return { records: [], chars: 0, truncated: false, toolChars: 0, toolKept: 0, toolSkipped: 0 };
  }

  // 合并成目标长度的块（保留轮次边界）
  const chunks = [];
  let buffer = '';
  let firstSeq = turns[0].seq;
  let firstQuestion = turns[0].user;
  for (const turn of turns) {
    const piece = turn.assistant === ''
      ? `问：${turn.user}`
      : `问：${turn.user}\n答：${turn.assistant}`;
    if (buffer === '') {
      buffer = piece;
      firstSeq = turn.seq;
      firstQuestion = turn.user;
      continue;
    }
    if (buffer.length + piece.length + 2 <= RAW_TARGET_CHARS) {
      buffer = `${buffer}\n\n${piece}`;
      continue;
    }
    chunks.push({ text: buffer, seq: firstSeq, question: firstQuestion });
    buffer = piece;
    firstSeq = turn.seq;
    firstQuestion = turn.user;
  }
  if (buffer !== '') chunks.push({ text: buffer, seq: firstSeq, question: firstQuestion });

  // 超长块二次切分
  const flat = [];
  for (const chunk of chunks) {
    let text = chunk.text;
    let question = chunk.question;
    while (text.length > MAX_BLOCK_CHARS) {
      flat.push({ text: text.slice(0, MAX_BLOCK_CHARS), seq: chunk.seq, question });
      text = text.slice(MAX_BLOCK_CHARS);
      question = '';
    }
    if (text !== '') flat.push({ text, seq: chunk.seq, question });
  }

  // 总量上限：超出时均匀抽样保留（保持时间覆盖），并记录截断
  const cap = Math.max(0, settings.maxRawCharsPerCompaction ?? 400000);
  let selected = flat;
  let truncated = false;
  if (cap > 0) {
    let total = 0;
    for (const chunk of flat) total += chunk.text.length;
    if (total > cap) {
      truncated = true;
      const keep = Math.max(1, Math.floor((flat.length * cap) / total));
      const stride = flat.length / keep;
      const sampled = [];
      for (let i = 0; i < keep; i += 1) {
        const index = Math.min(flat.length - 1, Math.floor(i * stride));
        if (sampled[sampled.length - 1] !== flat[index]) sampled.push(flat[index]);
      }
      selected = sampled;
    }
  }

  const records = [];
  for (const chunk of selected) {
    // L2 的主题行取"这一段是从哪个问题开始的"，而不是块内随便一个 Markdown 标题
    const title = chunk.question !== ''
      ? extractTitle(chunk.question, 40, { preferHeading: false })
      : extractTitle(chunk.text.replace(/^问：/, ''), 40, { preferHeading: false });
    records.push(makeRecord({
      layer: 'raw',
      session: input.sessionId,
      compactionId: input.compactionId,
      at: input.at,
      turn: input.turn,
      seqRange: [start, end],
      shadowedTokenCount: input.shadowedTokenCount,
      title,
      keywords: extractKeywords(chunk.text, { title, max: 10 }),
      text: chunk.text,
    }));
  }
  const chars = records.reduce((sum, record) => sum + record.text.length, 0);
  // 工具结果块与对话块合并后按事件顺序排列（检索与面板展示都更符合阅读直觉）
  const merged = records.concat(tools.records)
    .sort((a, b) => (a.seqRange?.[0] ?? 0) - (b.seqRange?.[0] ?? 0));
  return {
    records: merged,
    chars: chars + tools.chars,
    truncated,
    toolChars: tools.chars,
    toolKept: tools.kept,
    toolSkipped: tools.skipped,
    toolTruncatedItems: tools.truncatedItems,
  };
}
