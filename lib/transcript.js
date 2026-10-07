/**
 * 可读抄本：把 DSH 原生会话记录导出成**给人读的 Markdown**（WorkBuddy 那种时间线形态）。
 *
 * 为什么需要它：记忆库本体（`<session>.jsonl`）是**给检索用的原料** —— 一行一条 JSON、
 * 正文转义、按字符切块。用户点「打开原文」看到的若是那个文件，就是满屏机器字段
 * （实测反馈："打开都是乱码"）。会话日志里才有完整的一轮一轮，所以抄本从日志生成。
 *
 * 口径（用户明确要求，2026-10-07）：
 *   - **只留文字**：工具调用、工具结果、思考过程一律不进抄本；
 *   - **只要抄本**：不留原文附录（DSH 自己保存全部历史，需要时可再生成）；
 *   - 运行上下文快照等**注入内容**不算"人说的话"，剔除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSessionEvents } from './zstd.js';

/** 从消息里只取正文：跳过 thinking / reasoning / tool_use / tool_result。 */
function textOf(message) {
  const content = message?.content;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== 'text') continue;
      if (typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n')
    // 工作区指令等是注入到用户消息里的，不是人说的话（实测会整段出现在抄本里）
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '')
    .replace(/<\/?system-reminder>/g, '')
    .trim();
}

/** 插件/宿主注入的内容不属于对话。 */
function isInjected(message) {
  const kind = String(message?.source?.kind ?? '');
  return kind === 'runtime-context' || kind === 'dsh-super-memory';
}

/**
 * 生成（或刷新）某个会话的可读抄本。
 * @param {string} sessionId - 会话 id。
 * @param {string} root - 记忆库目录（抄本写到其下的 `_readable/`）。
 * @returns {{path: string|null, turns: number, compactions: number}} 结果与统计。
 */
export function writeTranscript(sessionId, root, highlight = '') {
  const id = String(sessionId ?? '');
  if (id === '' || typeof root !== 'string' || root === '') return { path: null, turns: 0, compactions: 0 };
  let events = [];
  try {
    events = readSessionEvents(id)?.events ?? [];
  } catch { return { path: null, turns: 0, compactions: 0 }; }
  if (events.length === 0) return { path: null, turns: 0, compactions: 0 };

  const turns = [];
  let compactions = 0;
  for (const event of events) {
    const type = String(event?.type ?? '');
    if (type.includes('compact')) compactions += 1;
    // 事件形状不统一：有的消息直接挂在 `data`，有的嵌在 `data.message`。
    // 只读 `data` 会把后者当成"空内容"跳过 —— 实测轮数从 544 掉到 144（静默丢数据）。
    const message = event?.data?.message ?? event?.data ?? {};
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    if (isInjected(message)) continue;
    const text = textOf(message);
    if (text === '') continue;
    turns.push({ role: type === 'user/message' ? '你' : 'AI 回复', text, time: event?.time ?? null });
  }

  const when = (value) => {
    if (value === null || value === undefined || value === '') return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  };

  const lines = [
    '# 本会话历史记录（可读抄本）',
    '',
    `> 会话：\`${id}\``,
    `> 导出时间：${new Date().toLocaleString()} · 共 ${turns.length} 轮发言 · 压缩事件 ${compactions} 个`,
    '> 说明：**只保留文字**（已剔除工具调用、工具结果与思考过程）。DSH 原生日志保存着全部内容，需要时可重新导出。',
    '',
  ];
  // **命中的内容放最前面**：侧栏预览不支持"跳到某行"，那就让相关内容**一打开就在眼前**
  // （用户要求：打开时自动定位到辅助模型认为关联性最强的原文处）。
  if (String(highlight ?? '').trim() !== '') {
    lines.push('---', '', '# ⭐ 本次查找命中的相关内容（辅助模型筛选）', '', String(highlight).trim(), '', '---', '');
  }
  lines.push('---', '');
  turns.forEach((turn, index) => {
    const stamp = when(turn.time);
    lines.push(`## 【${index + 1}】${stamp === '' ? '' : ` ${stamp}`}　${turn.role}`);
    lines.push('');
    lines.push(turn.text);
    lines.push('');
  });

  const dir = path.join(root, '_readable');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.md`);
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { path: target, turns: turns.length, compactions };
}
