/**
 * 量一下真实会话日志里"工具结果"的构成与体积，决定第 1 步（工具结果进 L2）的过滤规则与上限。
 * 用法: node measure-tools.mjs <sessionId>            （在 $DSH_HOME/sessions 下找日志）
 *       node measure-tools.mjs <sessionId> <日志路径>  （直接指定）
 */
import { readSessionEvents } from '../lib/zstd.js';

const sessionId = process.argv[2];
const logPath = process.argv[3];
if (!sessionId) { console.error('用法: node measure-tools.mjs <sessionId> [日志路径]'); process.exit(2); }
const { events, failed } = readSessionEvents(sessionId, logPath ? { path: logPath } : {});
console.log(`帧解码失败 ${failed} / 事件 ${events.length}`);

const kinds = new Map();
for (const e of events) kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
console.log('\n=== 事件类型 ===');
for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(5)}  ${k}`);

/** 从任意事件里尽力取出文本块（含工具结果）。 */
function textsOf(value, out = []) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) textsOf(item, out); return out; }
  if (typeof value.text === 'string' && typeof value.type === 'string') out.push({ type: value.type, text: value.text });
  if (typeof value.content === 'string') out.push({ type: 'content-string', text: value.content });
  for (const key of ['data', 'message', 'content', 'result', 'blocks']) if (value[key] !== undefined) textsOf(value[key], out);
  return out;
}

console.log('\n=== 工具相关事件样本（前 3 条的结构）===');
const toolEvents = events.filter((e) => /tool/i.test(String(e.type)));
console.log(`  工具相关事件数: ${toolEvents.length}`);
for (const e of toolEvents.slice(0, 3)) {
  const json = JSON.stringify(e.data ?? {});
  console.log(`  [${e.type}] seq=${e.seq} 长度=${json.length}`);
  console.log(`    ${json.slice(0, 600)}`);
}

// 工具名在 tool/call 事件里，tool/result 只有 callId → 必须先建索引再统计
const callNames = new Map();
for (const e of events) {
  if (e.type === 'tool/call') {
    const name = typeof e.data?.name === 'string' ? e.data.name : '(未知)';
    callNames.set(e.data?.callId, name);
  }
}

/** 取 tool/result 的文本块与长度。 */
function resultInfo(event) {
  const message = event.data?.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  const name = callNames.get(message.toolCallId ?? message.source?.callId) ?? '(未知)';
  return { name, chars: text.length, isError: message.isError === true, text };
}

/** 读类工具（把文件内容读进上下文的那些）。 */
const READ_CLASS = new Set(['read', 'read_file', 'view', 'cat', 'grep', 'search', 'glob', 'history_read', 'web_fetch']);

const perTool = new Map();
let conversationChars = 0;
let readClassChars = 0;
let readClassCalls = 0;
let errorChars = 0;
for (const e of events) {
  if (e.type === 'tool/result') {
    const info = resultInfo(e);
    if (info.isError) { errorChars += info.chars; continue; }
    const entry = perTool.get(info.name) ?? { chars: 0, calls: 0, max: 0 };
    entry.chars += info.chars; entry.calls += 1; entry.max = Math.max(entry.max, info.chars);
    perTool.set(info.name, entry);
    if (READ_CLASS.has(info.name)) { readClassChars += info.chars; readClassCalls += 1; }
  } else if (e.type === 'user/message' || e.type === 'assistant/message') {
    for (const b of textsOf(e.data ?? {})) if (b.type === 'text') conversationChars += b.text.length;
  }
}

console.log('\n=== 体积对比（全部日志）===');
console.log(`  对话文字（user/assistant 的 text 块）: ${conversationChars} 字符`);
let toolTotal = 0;
for (const [, v] of perTool) toolTotal += v.chars;
console.log(`  工具结果合计（排除出错结果 ${errorChars} 字符）: ${toolTotal} 字符 = 对话文字的 ${(toolTotal / Math.max(1, conversationChars)).toFixed(1)} 倍`);
console.log(`  其中"读类"工具（${[...READ_CLASS].join('/')}）: ${readClassChars} 字符 / ${readClassCalls} 次`);
console.log('\n=== 按工具名 ===');
for (const [name, v] of [...perTool.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  const mark = READ_CLASS.has(name) ? ' ←读类' : '';
  console.log(`  ${name.padEnd(16)} 调用 ${String(v.calls).padStart(4)} 次  ${String(v.chars).padStart(9)} 字符  单条最大 ${String(v.max).padStart(7)}${mark}`);
}

// 只看两个压缩的 shadowedRange 之内 —— 那才是"会被入库"的部分
console.log('\n=== 落在压缩范围（shadowedRange）内的读类结果 ===');
for (const e of events) {
  if (e.type !== 'compaction/summary') continue;
  const range = e.data?.shadowedRange ?? {};
  const start = range.start; const end = range.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { console.log(`  [${e.data?.compactionId}] 无有效范围，跳过`); continue; }
  let chars = 0; let calls = 0; let biggest = 0;
  for (const ev of events) {
    if (ev.type !== 'tool/result') continue;
    const seq = ev.seq ?? 0;
    if (seq < start || seq > end) continue;
    const info = resultInfo(ev);
    if (info.isError || !READ_CLASS.has(info.name)) continue;
    chars += info.chars; calls += 1; biggest = Math.max(biggest, info.chars);
  }
  console.log(`  [${e.data?.compactionId}] seq ${start}..${end}：读类结果 ${calls} 条 / ${chars} 字符（单条最大 ${biggest}）`);
}

