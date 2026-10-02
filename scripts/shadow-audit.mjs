/**
 * 审核 L2 抽取完整度：拿原始日志里被压掉的那一段，跑插件自己的 conversationTurns，
 * 对比"日志里真实存在的用户提问/助手回答文字"和"插件实际入库的字符数"。
 * 只读。用来验证 L2 有没有静默漏掉大段对话。
 *
 * 用法：node scripts/shadow-audit.mjs <sessionId> <fromSeq> <toSeq> [插件记账的rawChars]
 */
const [sessionId, fromArg, toArg, actualArg] = process.argv.slice(2);
if (!sessionId || fromArg === undefined || toArg === undefined) {
  console.log('用法: node scripts/shadow-audit.mjs <sessionId> <fromSeq> <toSeq> [rawChars]');
  process.exit(1);
}
const from = Number(fromArg);
const to = Number(toArg);
const actual = actualArg === undefined ? null : Number(actualArg);

const { readSessionEvents } = await import('../lib/zstd.js');
const { conversationTurns } = await import('../lib/ingest.js');
const { textFromBlocks, stripMarkerSegments } = await import('../lib/text.js');

const { events } = readSessionEvents(sessionId);
const ranged = events.filter((e) => Number(e.seq) >= from && Number(e.seq) <= to);
console.log(`会话 ${sessionId}  区间 seq ${from}..${to}  事件 ${ranged.length}`);

// 这段区间里"按设计应当收进来"的文字总量（用户提问 + 助手回答文字）
let userChars = 0;
let assistantChars = 0;
let userCount = 0;
let assistantCount = 0;
let toolResultChars = 0;
const perUser = [];
for (const e of ranged) {
  if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
    const t = stripMarkerSegments(textFromBlocks(e.data.content));
    if (t.trim() !== '') { userChars += t.length; userCount += 1; perUser.push({ seq: e.seq, chars: t.length, head: t.replace(/\s+/g, ' ').slice(0, 50) }); }
  } else if (e.type === 'assistant/message') {
    const t = stripMarkerSegments(textFromBlocks(e.data?.message?.content));
    if (t.trim() !== '') { assistantChars += t.length; assistantCount += 1; }
  } else if (e.type === 'tool/result') {
    toolResultChars += textFromBlocks(e.data?.message?.content).length;
  }
}

const turns = conversationTurns(ranged, {});
const turnChars = turns.reduce((sum, t) => sum + `问：${t.user}\n答：${t.assistant}`.length, 0);

console.log(`\n=== 区间内真实文字量（设计应当收进 L2 的部分）===`);
console.log(`  用户消息 kind=user : ${userCount} 条 / ${userChars} 字符`);
console.log(`  助手消息(文字块)   : ${assistantCount} 条 / ${assistantChars} 字符`);
console.log(`  小计               : ${userChars + assistantChars} 字符`);
console.log(`\n=== 插件 conversationTurns 折出的轮次 ===`);
console.log(`  轮次 ${turns.length} 个 / 组装后 ${turnChars} 字符`);
if (actual !== null) {
  console.log(`  插件实际记账 rawChars = ${actual}`);
  const gap = turnChars - actual;
  console.log(`  差值 = ${gap} 字符 ${gap > 0 ? `（缺口 ${(gap / turnChars * 100).toFixed(1)}%）` : '（记账 ≥ 折算值，正常，因为记账含"问：/答："前缀统计口径不同）'}`);
}
console.log(`\n=== 被有意丢弃的（不进 L2，省 token）===`);
console.log(`  工具结果文字: ${toolResultChars} 字符（includeToolResults=false 时丢弃）`);
console.log(`  思考过程/tool_call 参数: 未统计（体积大，按设计丢弃）`);

console.log(`\n=== 轮次明细（前 12 条）===`);
for (const t of turns.slice(0, 12)) {
  console.log(`  seq=${t.seq} 问${t.user.length}字/答${t.assistant.length}字  ${t.user.replace(/\s+/g, ' ').slice(0, 46)}`);
}
if (turns.length > 12) console.log(`  …… 其余 ${turns.length - 12} 轮`);
