/**
 * dsh-super-memory — 压缩时入库（0 模型调用）
 *
 * L1 摘要块：直接使用 `compaction/summary` 事件里 DSH 已经生成好的摘要文本，
 *            按 Markdown 标题/段落切块，用本地规则提炼 title / keywords。
 * L2 原文块：按 `shadowedRange` 从会话事件流取出被压掉那段，**只保留对话文字**
 *            （用户消息 + 助手回答正文），丢弃 reasoning、tool-call、tool-result
 *            与系统注入；取不到时自动降级为只做 L1，不报错。
 */
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  extractKeywords, extractTitle, sanitizeForStorage, splitSummarySections,
  stripMarkerSegments, textFromBlocks,
} from './text.js';
import { makeRecord } from './store.js';

/** 单块正文硬上限（字符）。 */
const MAX_BLOCK_CHARS = 1500;
/** L2 合并目标长度（字符）。 */
const RAW_TARGET_CHARS = 900;
/** 工具结果块的首行（检索锚点；`toolBodyOf` 靠它把正文还原出来）。 */
const TOOL_HEADER_RE = /^【工具 [^\n]*的结果 · [^\n]*】\n?/;
/** 截断说明的后缀格式（`clampToolText` 只认自己产出的这一种；末端的 `）` 可能被二次截断吃掉）。 */
const TRUNCATED_SUFFIX_RE = /…（原 \d+ 字符，已截断）?$/;

/**
 * 本插件自己的安装目录（默认值，用于"别索引插件自身源码"这条窄规则）。
 *
 * 取 `import.meta.url` 的实际落盘路径 —— 插件可能是从源码目录 link 进来的
 * （`profiles/<profile>/node_modules/dsh-super-memory` → 真实目录），所以必须用真实路径。
 * 调用方可以通过 `toolRecords`/`rawRecords` 的 `pluginRoot` 入参覆盖它（测试注入用）。
 */
const PLUGIN_ROOT = (() => {
  try { return resolve(fileURLToPath(new URL('..', import.meta.url))); } catch { return ''; }
})();

/**
 * 从摘要 ContentBlock[] 生成 L1 记录。
 * @param {object} input - 输入。
 * @returns {object[]} 记录数组。
 */
export function summaryRecords(input) {
  const raw = textFromBlocks(input.summary).replace(/<\/?compacted-summary>/g, '');
  // 摘要同样是"可能含被引用网页正文"的文本，入库前统一净化（审查报告 5）
  const text = sanitizeForStorage(raw);
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

/**
 * 把一条工具结果的**实际入库正文**夹到 `maxChars` 以内（纯函数，两层收口都用它）。
 *
 * 为什么需要它（2026-10-08 修的真缺陷）：早先 `toolRecords` 只对 `text.slice(0, maxChars)`
 * 做截断，然后才拼上 `【工具 … 的结果 · …】` 首行、并**再**补一句截断说明 —— 于是落盘记录的
 * `text.length` 是 `maxChars + 60~70`（夹具库实测 22/210 条越界，最大 4068，上限设的是 4000；
 * 上限设 200 时落盘 284）。现在"上限"就是**落盘记录 text 的字符数上限**，在拼接之后收口，
 * 由 `toolRecordText`（构造处）与 `clampToolRecord`（入库出口）两层共用同一个函数。
 *
 * 口径（顺序不能反）：先净化（`sanitizeForStorage`，可能删段/换字）→ 再按最终长度切。
 * @param {string} rawText - 原始工具结果文本（未净化）。
 * @param {number} maxChars - 上限（字符）；非法值退化为默认 4000。
 * @returns {{text:string, truncated:boolean, rawChars:number}} 夹好的正文。
 */
export function clampToolText(rawText, maxChars) {
  const raw = typeof rawText === 'string' ? rawText : '';
  const limit = Math.max(1, Math.floor(Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 4000));
  const clean = sanitizeForStorage(raw);
  if (clean.length <= limit) return { text: clean, truncated: false, rawChars: raw.length };
  // 后缀自己也要占额度；留下的正文至少 1 个字符（上限被设得极小时不产出空块）。
  const suffix = `…（原 ${clean.length} 字符，已截断）`;
  const bodyChars = Math.max(1, limit - suffix.length);
  return { text: `${clean.slice(0, bodyChars)}${suffix}`, truncated: true, rawChars: raw.length };
}

/**
 * 把工具结果正文装配成落盘文本（首行锚点 + 正文），并保证总长 ≤ `maxChars`。
 *
 * 额度按 `String.length` 算（与"上限是字符数"的口径一致）：**不要**混用 `Buffer.byteLength`，
 * 那会让中文工具名/路径多扣一倍额度。
 * @param {string} name - 工具名。
 * @param {string} target - 目标（文件名/模式/网址/命令）。
 * @param {string} rawText - 原始工具结果文本。
 * @param {number} maxChars - 单条上限（落盘 text 的字符数）。
 * @returns {{text:string, truncated:boolean, rawChars:number, bodyChars:number}} 装配结果。
 */
export function toolRecordText(name, target, rawText, maxChars) {
  const limit = Math.max(1, Math.floor(Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 4000));
  const header = `【工具 ${String(name ?? '')} 的结果 · ${String(target ?? '')}】\n`;
  // 上限小于首行时保留首行（它才是检索锚点），此时正文只剩截断说明。
  const bodyBudget = Math.max(0, limit - header.length);
  const clamped = clampToolText(rawText, Math.max(1, bodyBudget));
  // 最后再按 `limit` 硬切一次：首行或截断说明自己超长时（例如工具参数里带极长路径）
  // 也保证不超过上限 —— 这条函数的返回值就是落盘文本，它自己必须是"硬上限"。
  return {
    text: `${header}${clamped.text}`.slice(0, limit),
    truncated: clamped.truncated,
    // 截断说明里的"原 N 字符"要报**原始**字符数，而不是上限本身
    rawChars: clamped.rawChars > 0 ? clamped.rawChars : (typeof rawText === 'string' ? rawText.length : 0),
    bodyChars: clamped.text.length,
  };
}

/**
 * 从落盘的工具结果文本里还原正文（去掉首行锚点与截断说明）。
 *
 * 用途：`rawRecords` 的合并出口必须**再收口一次**（那里是唯一不可绕过的入库点），
 * 而它手上只有已经装配好的 text —— 先还原正文、再按同一个纯函数重新装配，
 * 保证"任何一条工具记录的 text 都 ≤ 上限"。
 * @param {string} text - 落盘文本。
 * @returns {string} 正文（不含首行锚点、不含截断说明）。
 */
export function toolBodyOf(text) {
  return String(text ?? '').replace(TOOL_HEADER_RE, '').replace(TRUNCATED_SUFFIX_RE, '');
}

/**
 * 一条工具调用是不是在读**本插件自己的文件**（自指噪声，不入 L2）。
 *
 * 为什么只判"自己的目录"而不是"所有代码文件"：用户真实项目里的 `.ts/.js` 恰恰是最该被记住的
 * 东西，宽判据会误伤。判据来自 `tool/call` 的**参数里的目标路径**（`file_path`/`filePath`/`path`），
 * 相对路径按会话 cwd 解析，最后比对是否落在插件目录内（Windows 下大小写不敏感）。
 * @param {object} args - 工具参数（对象，或 JSON 字符串）。
 * @param {string} cwd - 会话工作区（解析相对路径用）。
 * @param {string} [pluginRoot] - 插件根目录；默认本模块所在目录的父目录。
 * @returns {string} 命中的目标路径（未命中/无法判定时为 ''）。
 */
export function selfSourcePath(args, cwd, pluginRoot = PLUGIN_ROOT) {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ''; }
  }
  if (value === null || typeof value !== 'object') return '';
  let target = '';
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') { target = candidate.trim(); break; }
  }
  if (target === '') return '';
  // ⚠️ 判据只能是"插件根目录是不是一个可用的绝对路径"。**不要**写成
  // `root === resolve('.')`：插件的真实工作目录经常**就是**插件仓库自己
  // （本插件的开发/自检就是这么跑的），那样会把整条自指规则静默关掉 —— 踩过。
  const rawRoot = String(pluginRoot ?? '').trim();
  if (rawRoot === '') return '';
  const root = resolve(rawRoot);
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const absolute = resolve(isAbsolute(target) ? target : resolve(base, target));
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
  return target;
}

/**
 * 白名单解析：逗号/空格分隔的工具名；`*` = 全部。
 * @param {string} raw - 原始白名单字符串。
 * @returns {{names:Set<string>, all:boolean}} 解析结果。
 */
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
 * @param {object} input - 输入（events / sessionId / compactionId / at / settings / cwd / pluginRoot）。
 * @returns {{records:object[], chars:number, kept:number, skipped:number, truncatedItems:number, selfSourceSkipped:number}}
 */
export function toolRecords(input) {
  const settings = input.settings ?? {};
  const events = Array.isArray(input.events) ? input.events : [];
  if (settings.includeToolResults !== true || events.length === 0) {
    return { records: [], chars: 0, kept: 0, skipped: 0, truncatedItems: 0, selfSourceSkipped: 0 };
  }
  const { names, all } = toolNameSet(settings.toolResultNames ?? 'read, grep, glob, web_fetch, history_read');
  const maxChars = Math.max(200, Math.min(20000, Number(settings.toolResultMaxChars) || 4000));
  const budget = Math.max(0, Number(settings.toolResultBudgetChars) || 0);
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : '';
  const pluginRoot = typeof input.pluginRoot === 'string' && input.pluginRoot !== '' ? input.pluginRoot : undefined;

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
  let selfSourceSkipped = 0;
  for (const event of events) {
    if (event?.type !== 'tool/result') continue;
    const message = event.data?.message ?? {};
    if (message.isError === true) { skipped += 1; continue; }
    const call = calls.get(String(message.toolCallId ?? message.source?.callId ?? '')) ?? { name: '', args: '' };
    if (!all && !names.has(call.name)) { skipped += 1; continue; }
    // 自指噪声（2026-10-08 新增的**窄规则**）：读取本插件自己目录内文件的工具结果不入 L2。
    // 为什么：这类块的正文就是插件源码，对"回忆历史决策"没有价值，却因为"什么词都有"
    // 变成通用吸引子（实测它让任何逐字写在自己源码里的探针提问必然命中）。
    // 只排除**本插件目录**，不排除代码文件本身 —— 用户项目里的 .ts/.js 照常入库。
    if (selfSourcePath(call.args, cwd, pluginRoot) !== '') { selfSourceSkipped += 1; continue; }
    const rawText = stripMarkerSegments(textFromBlocks(message.content)).trim();
    if (rawText === '') continue;
    // 唯一的体积收口点：净化 + 截断 + 首行装配都在 `toolRecordText` 里做完，
    // 落盘 text 的长度**保证** ≤ maxChars（早先是先切后拼，实测能到 4068）。
    const target = toolTarget(call.name, call.args);
    const clamped = toolRecordText(call.name, target, rawText, maxChars);
    if (clamped.truncated) truncatedItems += 1;
    const text = clamped.text;
    const cost = text.length; // 预算按**实际落盘字符数**记账（早先 +80 的估算与真实体积不符）
    if (budget > 0 && chars + cost > budget) { skipped += 1; continue; }
    chars += cost;
    kept += 1;
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
      text,
      src: 'tool',
      tool: call.name,
    }));
  }
  return { records, chars, kept, skipped, truncatedItems, selfSourceSkipped };
}

/**
 * 按 shadowedRange 取出被压掉的对话文字，合并、切块成 L2 记录。
 * @param {object} input - 输入（`settings` / `cwd` / 可选 `pluginRoot`）。
 * @returns {{records:object[], chars:number, truncated:boolean, toolChars:number, toolKept:number,
 *   toolSkipped:number, toolTruncatedItems:number, toolSelfSourceSkipped:number}} 结果。
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
    return emptyRawInfo();
  }
  let events = [];
  try {
    events = input.session.snapshotEvents().filter((event) => {
      const seq = Number(event.seq);
      return seq >= start && seq <= end;
    });
  } catch {
    return emptyRawInfo();
  }
  const turns = conversationTurns(events, settings);
  const tools = toolRecords({ ...input, events });
  // 一个字都没取到：照旧返回空（工具字段也补齐，调用方直接读 rawInfo.toolKept 时不会拿到 undefined）
  if (turns.length === 0 && tools.records.length === 0) {
    return {
      records: [], chars: 0, truncated: false, toolChars: 0, toolKept: 0, toolSkipped: 0,
      toolTruncatedItems: 0, toolSelfSourceSkipped: tools.selfSourceSkipped,
    };
  }
  // 只有工具结果、没有对话轮（被压掉的那段全是工具调用/结果）：直接返回工具块。
  // 早先这里会落到下面的 `turns[0].seq` —— turns 为空时抛 TypeError，而调用方
  // 把它 catch 成"这次没有原文可取"，于是**整段 L2 静默丢失**（包括已经取到的工具结果）。
  if (turns.length === 0) {
    return {
      // 这条出口也要过"体积收口 + 入库净化"（见下面 clampToolRecord 的说明：收口不能有漏掉的出口）
      records: tools.records.map((record) => clampToolRecord(record, settings.toolResultMaxChars)),
      chars: tools.chars,
      truncated: false,
      toolChars: tools.chars,
      toolKept: tools.kept,
      toolSkipped: tools.skipped,
      toolTruncatedItems: tools.truncatedItems,
      toolSelfSourceSkipped: tools.selfSourceSkipped,
    };
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
  // 工具结果块与对话块合并后，**每条再过一遍入库净化 + 体积收口**（审查报告 5 + 2026-10-08
  // 的体积缺陷），然后按事件顺序排列。
  // 为什么收口在这里而不是各自构造处：工具记录有**两条出口**（`toolRecords` 的原始返回值，
  // 以及下面这个合并数组），只在其中一条收口会漏掉另一条 —— 净化与上限都必须在"入库"这个
  // 不可绕过的收口点。对话块自己也过一遍净化是刻意的（`sanitizeForStorage` 幂等）；
  // 上限只对 `src === 'tool'` 的记录施加（对话块的上限是 `MAX_BLOCK_CHARS`，另一件事）。
  // 主题行与关键词**不跟着重算**：它们是检索用的锚点，净化后重算属于另一件事。
  const merged = records.concat(tools.records.map((record) => clampToolRecord(record, settings.toolResultMaxChars)))
    .map((record) => ({ ...record, text: record.src === 'tool' ? record.text : sanitizeForStorage(record.text) }))
    .sort((a, b) => (a.seqRange?.[0] ?? 0) - (b.seqRange?.[0] ?? 0));
  return {
    records: merged,
    chars: chars + tools.chars,
    truncated,
    toolChars: tools.chars,
    toolKept: tools.kept,
    toolSkipped: tools.skipped,
    toolTruncatedItems: tools.truncatedItems,
    toolSelfSourceSkipped: tools.selfSourceSkipped,
  };
}

/** `rawRecords` 的空结果（字段恒定，调用方读任何一个都不会拿到 undefined）。 */
function emptyRawInfo() {
  return {
    records: [], chars: 0, truncated: false, toolChars: 0, toolKept: 0, toolSkipped: 0,
    toolTruncatedItems: 0, toolSelfSourceSkipped: 0,
  };
}

/**
 * 一条工具结果记录在**入库出口**的收口：还原正文 → 按同一个纯函数重新装配 → 净化。
 *
 * 为什么要在出口重做一遍（构造处已经夹过一次）：构造处是"我们自己记得调用"，
 * 出口是"绕不过去"。将来有人新增一条生成工具记录的路径（或改了首行格式），
 * 只要经过 `rawRecords` 就仍然 ≤ 上限 —— 这条断言在 `unit.mjs` 里钉成"任何 src=tool
 * 的记录 text.length ≤ toolResultMaxChars"，坏了就红。
 * @param {object} record - 工具结果记录。
 * @param {number} maxChars - 单条上限。
 * @returns {object} 新的记录对象（不改原对象）。
 */
function clampToolRecord(record, maxChars) {
  // 已经在上限内：**原样返回**（幂等，别把"正文 + 后缀"重新装配成"正文"，那会让记录变小）
  const limit = Math.max(1, Math.floor(Number(maxChars) > 0 ? Number(maxChars) : 4000));
  const current = String(record.text ?? '');
  if (current.length <= limit) return { ...record };
  const assembled = toolRecordText(record.tool ?? '', targetFromToolText(current) || targetFromTitle(record.title), toolBodyOf(current), limit);
  // 收口点只负责净化 + 体积：`sanitizeForStorage` 是幂等的，再跑一遍不会改变已夹好的长度
  // （`clampToolText` 内部第一件事就是净化），因此这条出口的产物仍然 ≤ 上限。
  return { ...record, text: assembled.text };
}

/**
 * 从落盘的工具结果文本里回读"目标"（首行 `【工具 <name> 的结果 · <target>】`）。
 *
 * 为什么从文本回读而不是从 title：`title` 被 `.slice(0, 60)` 截断过，长目标会读回半截，
 * 那样重算出来的首行会比真实首行短、额度算多，长度就可能重新越界。文本里的首行是完整的。
 * @param {string} text - 落盘文本。
 * @returns {string} 目标串（读不到时 ''）。
 */
function targetFromToolText(text) {
  const match = /^【工具 [^\n]*?的结果 · ([^\n]*)】/.exec(String(text ?? ''));
  return match === null ? '' : match[1];
}

/**
 * 主题行里的目标（`工具 <name>：<target>`）—— `targetFromToolText` 的兜底。
 * @param {string} title - 记录 title。
 * @returns {string} 目标串。
 */
function targetFromTitle(title) {
  const match = /^工具 [^：]*：(.*)$/.exec(String(title ?? ''));
  return match === null ? '' : match[1];
}
