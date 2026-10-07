/**
 * 可读抄本：把 DSH 原生会话记录导出成**给人读的 Markdown**（WorkBuddy 那种形态）。
 *
 * 三条口径（都来自用户实测反馈，2026-10-07）：
 *   1. **一问一答**：一轮 = 用户那段话 + AI 那轮的回答；不要按"每条消息"拆
 *      （否则多步工具轮里的中间碎语会各占一节，出现"只有问题/只有回复"）。
 *   2. **只留人的话**：DSH 的运行注记（`Time sampled…`）、工作区指令
 *      （`<system-reminder>`）、插件注入（运行上下文/记忆参考）一律不是"人说的话"，剔除。
 *   3. **命中处要能定位，不要堆一大坨**：把命中位置**标在对应小节上**，并在文件开头
 *      用一行指出"命中的是第几轮" —— 这样打开就能顺着看到当时的上下文
 *      （用户原话：直接定位到原文处，我还可以顺便看看当时那个问题的上下文）。
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
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '')
    .replace(/<\/?system-reminder>/g, '')
    .trim();
}

/** 这一类"用户消息"其实是系统/插件塞进来的，不是人打的字。 */
function isInjection(message, text) {
  const kind = String(message?.source?.kind ?? '');
  if (kind === 'runtime-context' || kind === 'dsh-super-memory') return true;
  if (kind !== '' && kind !== 'user') return true;   // 真人输入是 'user'
  if (/^Time sampled while preparing turn/.test(text)) return true;
  if (/^<[a-z-]+>/.test(text)) return true;
  return false;
}

/** 用词集重合度找"命中内容"落在哪一轮（纯本地，不调模型）。 */
function locateTurn(texts, highlight) {
  const words = new Set(String(highlight).toLowerCase().match(/[\u4e00-\u9fa5]{2,}|[a-z0-9_]{4,}/g) ?? []);
  if (words.size === 0) return -1;
  let best = -1;
  let bestScore = 0;
  texts.forEach((text, index) => {
    const lowered = text.toLowerCase();
    let score = 0;
    for (const word of words) if (lowered.includes(word)) score += 1;
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return bestScore >= 3 ? best : -1;
}

/**
 * 生成（或刷新）某个会话的可读抄本。
 * @param {string} sessionId - 会话 id。
 * @param {string} root - 记忆库目录（抄本写到其下的 `_readable/`）。
 * @param {string} [highlight] - 本次查找命中的资料（只用来**定位**，不再整段堆在开头）。
 * @returns {{path: string|null, turns: number, compactions: number, hit: number}} 结果与统计。
 */
export function writeTranscript(sessionId, root, highlight = '') {
  const id = String(sessionId ?? '');
  if (id === '' || typeof root !== 'string' || root === '') return { path: null, turns: 0, compactions: 0, hit: -1 };
  let events = [];
  try {
    events = readSessionEvents(id)?.events ?? [];
  } catch { return { path: null, turns: 0, compactions: 0, hit: -1 }; }
  if (events.length === 0) return { path: null, turns: 0, compactions: 0, hit: -1 };

  // ── 一问一答地合并 ──────────────────────────────────────────────────
  const turns = [];
  let compactions = 0;
  for (const event of events) {
    const type = String(event?.type ?? '');
    if (type.includes('compact')) compactions += 1;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    // 事件形状不统一：有的消息挂在 data，有的嵌在 data.message（实测漏掉过 3/4 内容）
    const message = event?.data?.message ?? event?.data ?? {};
    const text = textOf(message);
    if (text === '') continue;
    if (type === 'user/message') {
      if (isInjection(message, text)) continue;
      turns.push({ question: text, questionAt: event?.time ?? null, answers: [] });
    } else {
      const last = turns[turns.length - 1];
      if (last === undefined) continue;     // 开场白（还没有提问）不进抄本
      if (text.length < 12) continue;       // 工具步之间的碎语不要
      last.answers.push(text);
    }
  }
  const usable = turns.filter((turn) => turn.question.trim() !== '');
  const hit = locateTurn(usable.map((turn) => `${turn.question}\n${turn.answers.join('\n')}`), highlight);

  const when = (value) => {
    if (value === null || value === undefined || value === '') return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  };

  const lines = [
    '# 本会话历史记录（可读抄本）',
    '',
    `> 会话：\`${id}\``,
    `> 导出时间：${new Date().toLocaleString()} · 共 ${usable.length} 轮问答 · 压缩事件 ${compactions} 个`,
    '> 说明：**只保留人与 AI 的文字**（已剔除运行注记、工具调用、工具结果与思考过程）。',
  ];
  if (hit >= 0) {
    lines.push(`> 🎯 **本次查找命中的内容在第【${hit + 1}】轮**（见该节标题后的 ⬅ 标记）—— 往下翻几步就能看到当时的上下文。`);
  }
  lines.push('', '---', '');

  usable.forEach((turn, index) => {
    const stamp = when(turn.questionAt);
    lines.push(`## 【${index + 1}】${stamp === '' ? '' : ` ${stamp}`}${index === hit ? '　⬅ 本次命中' : ''}`);
    lines.push('');
    lines.push('**你：**');
    lines.push('');
    lines.push(turn.question);
    lines.push('');
    lines.push('**AI 回复：**');
    lines.push('');
    lines.push(turn.answers.length === 0 ? '（这一轮没有文字回答）' : turn.answers.join('\n\n'));
    lines.push('');
  });

  const dir = path.join(root, '_readable');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.md`);
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { path: target, turns: usable.length, compactions, hit };
}
