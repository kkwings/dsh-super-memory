#!/usr/bin/env node
/**
 * 把 DSH 的原生会话记录导出成**给人读的 Markdown 抄本**（WorkBuddy 那种形态）。
 *
 * 为什么不从记忆库（`<session>.jsonl`）导出：那是**给检索用的原料** —— 内容被切成
 * 碎片、正文转义、还带 `{"schema":1,…}` 这样的机器字段，人打开就是乱码（用户实测）。
 * 会话日志里才有**完整的一轮一轮**（谁问的、AI 答了什么），所以抄本从日志生成。
 *
 * 口径（用户明确要求）：
 *   - **只留文字**：工具调用、工具结果、思考过程一律不进抄本；
 *   - **只要抄本**：不留原文附录（DSH 自己保存着全部历史，需要时可再生成）；
 *   - 标出**压缩分界线**：让文档同时是一份"模型还记得什么 / 已经忘了什么"的账本。
 *
 * 用法：node scripts/export-readable.mjs <sessionId> [输出目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Windows 上动态 import 必须用 file:// URL（直接给 `E:\…` 会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const { readSessionEvents } = await import(pathToFileURL(path.join(here, '..', 'lib', 'zstd.js')).href);

const sessionId = process.argv[2] ?? '';
if (sessionId === '') {
  console.error('用法：node scripts/export-readable.mjs <sessionId> [输出目录]');
  process.exit(2);
}
const outDir = process.argv[3] ?? path.join(process.cwd(), '.dsh-compaction-memory', '_readable');

const { events } = readSessionEvents(sessionId);
if (!Array.isArray(events) || events.length === 0) {
  console.error(`读不到会话事件：${sessionId}`);
  process.exit(2);
}

/** 从消息内容里只取**正文**：跳过 thinking / reasoning / tool_use / tool_result。 */
function textOf(message) {
  const content = message?.content;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'text') continue;          // ← 只要 text：思考/工具一律不要
      if (typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n')
    // 工作区指令等是**注入**到用户消息里的，不是人说的话 —— 抄本里必须去掉，
    // 否则读起来会看到一堆 <system-reminder>（实测踩过）。
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/** 运行上下文快照是插件/宿主注入的，不属于人对人的对话，抄本里不要。 */
function isInjected(message) {
  const kind = String(message?.source?.kind ?? '');
  return kind === 'runtime-context' || kind === 'dsh-super-memory';
}

const turns = [];
let compactionSeen = 0;
for (const event of events) {
  const type = String(event?.type ?? '');
  const data = event?.data ?? {};
  if (type.includes('compact')) compactionSeen += 1;
  const message = data.message ?? data;
  if (type === 'user/message') {
    if (isInjected(message)) continue;
    const text = textOf(message);
    if (text !== '') turns.push({ role: '你', text, at: data.at ?? event.at ?? null });
  } else if (type === 'assistant/message') {
    const text = textOf(message);
    if (text !== '') turns.push({ role: 'AI 回复', text, at: data.at ?? event.at ?? null });
  }
}

const when = (value) => {
  if (typeof value !== 'string' || value === '') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const lines = [];
lines.push('# 本会话历史记录（可读抄本）');
lines.push('');
lines.push(`> 会话：\`${sessionId}\``);
lines.push(`> 导出时间：${new Date().toLocaleString()} · 共 ${turns.length} 轮发言`);
lines.push('> 说明：**只保留文字**（已剔除工具调用、工具结果与思考过程）。DSH 原生日志保存着全部内容，需要时可重新导出。');
lines.push('');
lines.push('---');
lines.push('');

turns.forEach((turn, index) => {
  lines.push(`## 【${index + 1}】${when(turn.at)}　${turn.role}`);
  lines.push('');
  lines.push(turn.text);
  lines.push('');
});

fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, `${sessionId}.md`);
fs.writeFileSync(target, lines.join('\n'), 'utf8');
console.log(`已导出 ${turns.length} 轮发言（压缩事件 ${compactionSeen} 个）`);
console.log(target);
