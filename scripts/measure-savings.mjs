/**
 * 省钱实测 + 阈值标定（离线，不联网、不启动 DSH）：用**真实会话日志**算清楚
 * "入库关键词扩写"这一刀砍掉了多少，以及「强命中跳过改写」的门槛定在哪。
 *
 * 用法：node scripts/measure-savings.mjs <sessionLogPath> [--json]
 *
 * 两段输出：
 *   ① A/B：把整份日志的每次压缩都过一遍入库管线，模拟两种口径下的扩写调用
 *      （改前：所有 ≥120 字符的块，含工具结果；改后：只扩非工具块），
 *      对比"参与扩写的块数 / 调用次数 / 输入字符 / 估算输入 token"，并给 5 次压缩的总量。
 *   ② 标定：拿历史提问当查询跑本地检索，看粗筛 top-1 分数（✕ 路径用的就是这个数）
 *      落在 minScore 的各个倍数之上的比例 —— 用来判断"强命中"门槛该定多高。
 *
 * 口径与生产代码一致：块由 `lib/ingest.js` 生成，输入文本按 `lib/llm.js`
 * 的 `expandKeywords` 拼（每块前 `llmIngestBlockChars` 字符），
 * token 用 `lib/text.js` 的 `estimateTokens`。
 */
import fs from 'node:fs';
import { DEFAULTS } from '../lib/config.js';
import { rawRecords, summaryRecords } from '../lib/ingest.js';
import { estimateTokens } from '../lib/text.js';
import { MemoryIndex, retrieveTwoTier } from '../lib/retrieval.js';
import { decompressFrames } from '../lib/zstd.js';

const logPath = process.argv[2];
const asJson = process.argv.includes('--json');
if (typeof logPath !== 'string' || logPath === '') {
  console.log('用法：node scripts/measure-savings.mjs <sessionLogPath> [--json]');
  process.exit(2);
}

const settings = { ...DEFAULTS };
const buf = fs.readFileSync(logPath);
const { text, frames } = decompressFrames(buf);
const events = text.split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sessionId = events[0]?.id ?? 'unknown';
console.log(`日志：${frames} 帧 / ${events.length} 事件 / 会话 ${sessionId}`);
console.log(`默认值：每批 ${settings.llmIngestBatchBlocks} 块 · 每块 ${settings.llmIngestBlockChars} 字符 · minScore ${settings.minScore}`);

/** 与 `lib/llm.js` 的 expandKeywords 完全一样的输入拼法。 */
function expandInput(blocks) {
  const blockChars = Math.max(100, Math.min(4000, Number(settings.llmIngestBlockChars) || 600));
  return blocks.map((block, index) => `[${index}] ${String(block.text ?? '').slice(0, blockChars)}`).join('\n\n');
}

/** 模拟一种口径：filter(record) → 是否送去扩写；batchSize → 每批几块。 */
function simulate(mode) {
  const keep = mode === 'before'
    ? (record) => String(record.text ?? '').length >= 120
    : (record) => record.src !== 'tool' && String(record.text ?? '').length >= 120;
  const batchSize = mode === 'before' ? 5 : settings.llmIngestBatchBlocks;
  const totals = { compactions: 0, blocks: 0, toolBlocks: 0, targets: 0, calls: 0, inChars: 0, inTokens: 0, outTokens: 0 };
  const perCompaction = [];
  for (const event of events) {
    if (event?.type !== 'compaction/summary') continue;
    const at = new Date(event.time).toISOString();
    const summary = summaryRecords({
      sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
      seqRange: [event.data.shadowedRange.start, event.data.shadowedRange.end],
      shadowedTokenCount: event.data.shadowedTokenCount, summary: event.data.summary,
    });
    const raw = rawRecords({
      session: { id: sessionId, header: { cwd: process.cwd() }, snapshotEvents: () => events },
      sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
      range: event.data.shadowedRange, shadowedTokenCount: event.data.shadowedTokenCount, settings,
    });
    const fresh = [...summary, ...raw.records];
    const targets = fresh.filter(keep);
    let calls = 0;
    let inChars = 0;
    let inTokens = 0;
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      const batch = targets.slice(offset, offset + batchSize);
      const input = expandInput(batch);
      calls += 1;
      inChars += input.length;
      inTokens += estimateTokens(input);
    }
    // 输出侧按"每块一行 3–6 个 ≤24 字词"的量级估：每块约 8 个词 × 5 字 + JSON 语法开销
    const outTokens = targets.length * 12 + 20;
    totals.compactions += 1;
    totals.blocks += fresh.length;
    totals.toolBlocks += fresh.filter((record) => record.src === 'tool').length;
    totals.targets += targets.length;
    totals.calls += calls;
    totals.inChars += inChars;
    totals.inTokens += inTokens;
    totals.outTokens += outTokens;
    perCompaction.push({
      compactionId: String(event.data.compactionId ?? '').slice(0, 8),
      blocks: fresh.length,
      tool: fresh.filter((record) => record.src === 'tool').length,
      targets: targets.length,
      calls,
      inChars,
      inTokens,
    });
  }
  return { totals, perCompaction };
}

const before = simulate('before');
const after = simulate('after');
const pct = (a, b) => (a === 0 ? '—' : `${(((a - b) / a) * 100).toFixed(1)}%↓`);
const row = (label, a, b) => console.log(`  ${label.padEnd(20, ' ')} 改前 ${String(a).padStart(8)} → 改后 ${String(b).padStart(8)}   ${pct(a, b)}`);

const toolBlocksTotal = before.perCompaction.reduce((n, c) => n + c.tool, 0);

console.log(`\n=== ① 关键词扩写：整份日志（${before.totals.compactions} 次压缩）===`);
row('参与扩写的块数', before.totals.targets, after.totals.targets);
row('调用次数', before.totals.calls, after.totals.calls);
row('输入字符', before.totals.inChars, after.totals.inChars);
row('估算输入 token', before.totals.inTokens, after.totals.inTokens);
console.log(`  （入库块总数不变：${before.totals.blocks} 块，其中工具结果 ${toolBlocksTotal} 块 —— 入库行为不动）`);

console.log('\n  每次压缩明细（改前 → 改后）：');
for (let i = 0; i < before.perCompaction.length; i += 1) {
  const a = before.perCompaction[i];
  const b = after.perCompaction[i];
  console.log(`    ${a.compactionId}  块 ${a.blocks}（工具 ${a.tool}）  扩写 ${a.targets}→${b.targets} 块`
    + `  调用 ${a.calls}→${b.calls}  输入 ${a.inChars}→${b.inChars} 字符  ≈${a.inTokens}→${b.inTokens} token`);
}

console.log('\n=== ② 5 次压缩的总量对比（同一会话的稳态）===');
const perCompactionAvg = {
  before: before.totals.calls / Math.max(1, before.totals.compactions),
  after: after.totals.calls / Math.max(1, before.totals.compactions),
  beforeChars: before.totals.inChars / Math.max(1, before.totals.compactions),
  afterChars: after.totals.inChars / Math.max(1, before.totals.compactions),
  beforeTokens: before.totals.inTokens / Math.max(1, before.totals.compactions),
  afterTokens: after.totals.inTokens / Math.max(1, before.totals.compactions),
};
row('5 次压缩：调用次数', Math.round(perCompactionAvg.before * 5), Math.round(perCompactionAvg.after * 5));
row('5 次压缩：输入字符', Math.round(perCompactionAvg.beforeChars * 5), Math.round(perCompactionAvg.afterChars * 5));
row('5 次压缩：估算输入token', Math.round(perCompactionAvg.beforeTokens * 5), Math.round(perCompactionAvg.afterTokens * 5));

/* ── ③ 强命中门槛标定：✕ 路径的粗筛 top-1 到底有多高 ─────────────────────── */
console.log('\n=== ③ 「强命中跳过改写」门槛标定（minScore=' + settings.minScore + '）===');
const allRecords = [];
for (const event of events) {
  if (event?.type !== 'compaction/summary') continue;
  const at = new Date(event.time).toISOString();
  allRecords.push(...summaryRecords({
    sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
    seqRange: [event.data.shadowedRange.start, event.data.shadowedRange.end],
    shadowedTokenCount: event.data.shadowedTokenCount, summary: event.data.summary,
  }));
  allRecords.push(...rawRecords({
    session: { id: sessionId, header: { cwd: process.cwd() }, snapshotEvents: () => events },
    sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
    range: event.data.shadowedRange, shadowedTokenCount: event.data.shadowedTokenCount, settings,
  }).records);
}
const index = new MemoryIndex(allRecords);
const questions = [];
for (const event of events) {
  if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
    const value = (event.data.content ?? []).map((block) => block.text ?? '').join(' ').trim();
    if (value.length > 8) questions.push(value);
  }
}
const ratios = [1.5, 2, 3];
const tally = { total: 0, aboveMin: 0, strictHit: 0, skip: {} };
for (const ratio of ratios) tally.skip[ratio] = 0;
const bands = { zero: 0, below: 0, to1_5: 0, to2: 0, to3: 0, over3: 0 };
for (const question of questions) {
  const best = index.search(question, { limit: 1 })[0]?.score ?? 0;
  // ✕ 路径的强相关判定用的是 retrieveTwoTier（L2 乘 0.85 折扣）
  const tier = retrieveTwoTier(index, question, { minScore: settings.minScore, maxItems: 3, preferSummaryChunks: true });
  // 「能注入」= 本地检索已经命中（命中才注入）→ 这是"跳过改写不会让本来找得到的东西找不到"的判据
  const injectable = tier.tier !== 'none';
  tally.total += 1;
  if (best >= settings.minScore) tally.aboveMin += 1;
  if (injectable) tally.strictHit += 1;
  for (const ratio of ratios) if (best >= settings.minScore * ratio) tally.skip[ratio] += 1;
  if (best === 0) bands.zero += 1;
  else if (best < settings.minScore) bands.below += 1;
  else if (best < settings.minScore * 1.5) bands.to1_5 += 1;
  else if (best < settings.minScore * 2) bands.to2 += 1;
  else if (best < settings.minScore * 3) bands.to3 += 1;
  else bands.over3 += 1;
}
console.log(`  历史提问 ${tally.total} 条；本地检索已命中（可注入）${tally.strictHit} 条；粗筛 top-1 ≥ minScore 的 ${tally.aboveMin} 条`);
// **关键安全性质**：被跳过的那些查询，绝大多数本来就是"本地已命中"的 ——
// 官方口径的命中判定（retrieveTwoTier）比这里的粗筛 top-1 更严，所以它一定 ≤ 跳过数。
for (const ratio of ratios) {
  console.log(`  粗筛 top-1 ≥ ${ratio}× minScore（${(settings.minScore * ratio).toFixed(3)}）→ ${tally.skip[ratio]}/${tally.total} 条会跳过改写`
    + `（本地已命中的共 ${tally.strictHit} 条：极端情况下最多 ${Math.max(0, tally.strictHit - tally.skip[ratio])} 条"能注入但不再改写"）`);
}
console.log(`  分数分布：0 分 ${bands.zero} 条 / <minScore ${bands.below} 条 / `
  + `minScore–1.5× ${bands.to1_5} 条 / 1.5–2× ${bands.to2} 条 / 2–3× ${bands.to3} 条 / ≥3× ${bands.over3} 条`);

if (asJson) {
  console.log(`\n${JSON.stringify({ before: before.totals, after: after.totals, tally, bands }, null, 2)}`);
}
