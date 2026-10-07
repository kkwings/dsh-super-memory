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
    // DSH 会把运行注记**追加在同一条用户消息的末尾**（可能和正文同一行），所以不能
    // 只按"行首"过滤 —— 从注记出现处直接截断到行尾（实测残留 3 处就是这么来的）。
    .replace(/Time sampled while preparing turn[\s\S]*$/m, '')
    .split('\n')
    .filter((line) => !line.includes('<system-reminder') && !line.includes('</system-reminder>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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

  // ── 一问一答：靠**结构**配对，不靠"哪条更长"这种猜测 ──────────────
  // 日志事实（实测）：每个 `assistant/message` 都带 `turn` 与 `step`，并配 `turn/start`
  // / `turn/end`。一轮里有很多条 assistant 文本（每一步一条"过程旁白"），**只有 step 最大
  // 的那条是该轮的正式回答**。按长度取会把英文旁白当成回答（用户实测踩过）。
  const turns = [];
  const answerOfTurn = new Map();     // turn → { step, text }
  let compactions = 0;
  for (const event of events) {
    const type = String(event?.type ?? '');
    if (type.includes('compact')) compactions += 1;
    if (type === 'user/message') {
      const message = event?.data?.message ?? event?.data ?? {};
      const text = textOf(message);
      if (text === '' || isInjection(message, text)) continue;
      turns.push({ question: text, questionAt: event?.time ?? null, turn: event?.data?.turn ?? null, answers: [] });
      continue;
    }
    if (type === 'assistant/message') {
      const data = event?.data ?? {};
      const text = textOf(data.message ?? data);
      if (text === '') continue;
      const turn = data.turn ?? null;
      const step = Number(data.step ?? 0);
      const previous = turn === null ? undefined : answerOfTurn.get(turn);
      if (previous === undefined || step >= previous.step) answerOfTurn.set(turn, { step, text });
    }
  }
  for (const turn of turns) {
    if (turn.turn !== null && answerOfTurn.has(turn.turn)) turn.answers = [answerOfTurn.get(turn.turn).text];
  }
  // 兜底：结构缺失时（日志片段不完整），取"该提问的 turn 之后、下一个提问之前"的最后一条回答
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].answers.length > 0) continue;
    const next = turns[index + 1];
    if (next === undefined || next.turn === null || turns[index].turn === null) continue;
    for (let probe = Number(next.turn) - 1; probe > Number(turns[index].turn); probe -= 1) {
      const found = answerOfTurn.get(probe);
      if (found !== undefined) { turns[index].answers = [found.text]; break; }
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
    // 标题里带上**问题摘要** —— 这样侧栏的目录索引（WorkBuddy 那种）才是有用的
    // 导航，而不是一排 "【1】【2】" 看不出内容。
    const title = turn.question.replace(/\s+/g, ' ').replace(/^#+\s*/, '').slice(0, 32);
    lines.push(`## 【${index + 1}】${stamp === '' ? '' : ` ${stamp}`}　${title}${index === hit ? '　⬅ 本次命中' : ''}`);
    lines.push('');
    lines.push('**你：**');
    lines.push('');
    lines.push(turn.question);
    lines.push('');
    lines.push('**AI 回复：**');
    lines.push('');
    lines.push(turn.answers.length === 0 ? '（这一轮没有文字回答，只有工具操作）' : turn.answers.join('\n\n'));
    lines.push('');
  });

  const dir = path.join(root, '_readable');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.md`);
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return { path: target, turns: usable.length, compactions, hit };
}
