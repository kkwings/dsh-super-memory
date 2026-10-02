/**
 * 诊断：列出某个会话的全部压缩事件，以及"当前投影里还剩哪些用户消息"。
 * 只读。用来解释 ingest 的 L1/L2 数量与查询窗口。
 *
 * 用法：node scripts/compactions.mjs <sessionId>
 */
const sessionId = process.argv[2];
if (!sessionId) {
  console.log('用法: node scripts/compactions.mjs <sessionId>');
  process.exit(1);
}

const { readSessionEvents, sessionLogBytes } = await import('../lib/zstd.js');
const { estimateTokens } = await import('../lib/text.js');

const { events, path, frames, failed } = readSessionEvents(sessionId);
console.log(`会话: ${sessionId}`);
console.log(`日志: ${path}`);
console.log(`帧 ${frames} / 坏帧 ${failed} / 事件 ${events.length} / ${sessionLogBytes(sessionId)} B`);

const head = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
/** 事件时间戳字段名不统一，逐个试。 */
const stamp = (e) => {
  for (const key of ['at', 'time', 'ts', 'timestamp', 'createdAt']) {
    const v = e?.[key];
    if (typeof v === 'number' && v > 1e11) return new Date(v).toISOString();
    if (typeof v === 'string' && v !== '') return v;
  }
  return '—';
};
const textOf = (data) =>
  (Array.isArray(data?.content) ? data.content : [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');

console.log('\n=== 压缩事件 ===');
const compactions = events.filter((e) => String(e.type).startsWith('compaction/'));
if (compactions.length === 0) console.log('  （无）');
for (const e of compactions) {
  const d = e.data ?? {};
  const parts = [`seq=${e.seq}`, `type=${e.type}`, `at=${e.at ?? e.time ?? '—'}`];
  if (d.compactionId) parts.push(`id=${d.compactionId}`);
  if (d.shadowedRange) parts.push(`shadowedRange=${d.shadowedRange.start}..${d.shadowedRange.end}`);
  if (d.shadowedSeqs) parts.push(`shadowedSeqs=${Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs.length : '?'}`);
  if (typeof d.shadowedTokenCount === 'number') parts.push(`shadowedTokens=${d.shadowedTokenCount}`);
  if (Array.isArray(d.summary)) parts.push(`summaryBlocks=${d.summary.length}/chars=${textOf(d).length}`);
  if (typeof d.kind === 'string') parts.push(`kind=${d.kind}`);
  console.log(`  ${parts.join('  ')}`);
}

const last = compactions.filter((e) => e.type === 'compaction/summary').pop();
const cut = last?.data?.shadowedRange?.end ?? -1;
console.log(`\n=== 现存投影（seq > ${cut}）里的用户消息 ===`);
const users = events.filter(
  (e) => e.type === 'user/message' && Number(e.seq) > cut && e.data?.source?.kind === 'user'
);
if (users.length === 0) console.log('  （无）');
for (const e of users) {
  console.log(`  seq=${e.seq} at=${e.at ?? '—'} chars=${textOf(e.data).length}  ${head(textOf(e.data))}`);
}
console.log(`  —— 共 ${users.length} 条；插件按 observationTurns 只取最后几条`);

console.log('\n=== 投影里的运行时上下文快照（source.kind=runtime-context，不计入查询）===');
const ctxs = events.filter(
  (e) => e.type === 'user/message' && Number(e.seq) > cut && e.data?.source?.kind === 'runtime-context'
);
console.log(`  共 ${ctxs.length} 条`);
for (const e of ctxs.slice(-6)) {
  const body = textOf(e.data);
  console.log(`  seq=${e.seq} at=${stamp(e)} chars=${body.length} ≈${estimateTokens(body)} token 命中回忆=${body.includes('已被压缩）的参考') ? '是' : '否'} 含总览=${body.includes('本会话此前脉络') ? '是' : '否'}`);
}

// 原始事件模式：node scripts/compactions.mjs <sessionId> --raw <seq>
if (process.argv[3] === '--raw') {
  const want = Number(process.argv[4]);
  const target = events.find((e) => Number(e.seq) === want);
  console.log(`\n=== seq ${want} 原始事件 ===`);
  console.log(target === undefined ? '（无）' : JSON.stringify(target, null, 2).slice(0, 2000));
}

// 快照全文模式：node scripts/compactions.mjs <sessionId> --snap [序号，默认最后一份]
if (process.argv[3] === '--snap') {
  const pick = process.argv[4] === undefined ? ctxs.length - 1 : Number(process.argv[4]);
  const target = ctxs[pick];
  console.log(`\n=== 运行上下文快照第 ${pick} 份（共 ${ctxs.length} 份）完整正文 ===`);
  console.log(target === undefined ? '（无）' : textOf(target.data));
}

// 追加模式：node scripts/compactions.mjs <sessionId> <fromSeq> <toSeq>
const from = Number(process.argv[3]);
const to = Number(process.argv[4]);
if (Number.isFinite(from) && Number.isFinite(to)) {
  console.log(`\n=== 事件明细 seq ${from}..${to} ===`);
  for (const e of events) {
    const seq = Number(e.seq);
    if (!(seq >= from && seq <= to)) continue;
    const body = textOf(e.data);
    const kind = e.data?.source?.kind ?? '';
    console.log(`  seq=${seq} ${String(e.type).padEnd(18)} at=${stamp(e)} kind=${kind} chars=${body.length} ${head(body, 60)}`);
  }
}
