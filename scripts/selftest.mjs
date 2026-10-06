/**
 * 离线自检：用真实会话日志跑通「压缩入库 → 本地检索 → 总览」全链路（不启动 DSH）。
 * 用法：node selftest.mjs <sessionLogPath> [workdir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decompressFrames } from '../lib/zstd.js';
import { DEFAULTS } from '../lib/config.js';
import { summaryRecords, rawRecords } from '../lib/ingest.js';
import { MemoryIndex, retrieveTwoTier } from '../lib/retrieval.js';
import { buildRecap } from '../lib/recap.js';
import { formatRecall } from '../lib/recall.js';
import { estimateTokens } from '../lib/text.js';
import { appendRecords, readRecords, storeRoot } from '../lib/store.js';

const logPath = process.argv[2];
// 默认写到系统临时目录（而不是当前工作目录），免得在别人 clone 下来的仓库里留下数据
const workdir = process.argv[3] ?? path.join(os.tmpdir(), 'dsh-super-memory-selftest');
const buf = fs.readFileSync(logPath);
const { text, frames, failed } = decompressFrames(buf);
const events = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(`frames=${frames} failed=${failed} events=${events.length}`);

const header = events[0];
const sessionId = header.id ?? 'test-session';
const session = { id: sessionId, header: { cwd: workdir }, snapshotEvents: () => events };

// 跟随插件**真实默认值**（只覆盖与本脚本无关的项）：写死默认值会让"测试通过"
// 与"插件真实行为"脱节——工具结果入库就是这么被漏掉的。
const settings = { ...DEFAULTS };

const root = storeRoot(workdir, '.dsh-compaction-memory');
console.log('store root:', root);

let totalSummary = 0;
let totalRaw = 0;
let rawChars = 0;
for (const event of events) {
  if (event.type !== 'compaction/summary') continue;
  const at = new Date(event.time).toISOString();
  const s = summaryRecords({
    sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
    seqRange: [event.data.shadowedRange.start, event.data.shadowedRange.end],
    shadowedTokenCount: event.data.shadowedTokenCount, summary: event.data.summary,
  });
  const r = rawRecords({
    session, sessionId, compactionId: event.data.compactionId, at, turn: event.data.turn ?? null,
    range: event.data.shadowedRange, shadowedTokenCount: event.data.shadowedTokenCount, settings,
  });
  appendRecords(root, sessionId, [...s, ...r.records]);
  totalSummary += s.length;
  totalRaw += r.records.length;
  rawChars += r.chars;
  console.log(`compaction ${event.data.compactionId.slice(0, 8)} seq=${event.data.shadowedRange.start}..${event.data.shadowedRange.end} shadowedTokens=${event.data.shadowedTokenCount} -> summaryBlocks=${s.length} rawBlocks=${r.records.length} rawChars=${r.chars} truncated=${r.truncated}`);
}
console.log(`\n入库合计：L1 ${totalSummary} 块 / L2 ${totalRaw} 块（${rawChars} 字符）`);

const records = readRecords(root, sessionId);
const file = path.join(root, `${sessionId}.jsonl`);
console.log('库文件:', file, fs.statSync(file).size, 'bytes');

const index = new MemoryIndex(records);
console.log('\n=== 入库内容抽查（L1 前 3 块 + L2 前 2 块）===');
for (const rec of records.filter((r) => r.layer === 'summary').slice(0, 3)) {
  console.log(`[L1] title=${JSON.stringify(rec.title)} kw=${JSON.stringify(rec.keywords)} chars=${rec.text.length}`);
  console.log(`     ${rec.text.slice(0, 150).replace(/\n/g, ' / ')}`);
}
for (const rec of records.filter((r) => r.layer === 'raw').slice(0, 2)) {
  const hasReasoning = /"type":"reasoning"|工具结果/.test(rec.text);
  console.log(`[L2] title=${JSON.stringify(rec.title)} chars=${rec.text.length} 含思考/工具噪声=${hasReasoning}`);
  console.log(`     ${rec.text.slice(0, 150).replace(/\n/g, ' / ')}`);
}

// 用被压掉内容里的真实问题当查询，检查分数分布（标定 minScore）
const shadowedUserTexts = [];
for (const event of events) {
  if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
    const t = (event.data.content ?? []).map((b) => b.text ?? '').join(' ').trim();
    if (t.length > 8) shadowedUserTexts.push({ seq: event.seq, t });
  }
}
console.log(`\n=== 打分标定：${Math.min(12, shadowedUserTexts.length)} 条历史问题 ===`);
const sample = shadowedUserTexts.slice(0, 12);
for (const { seq, t } of sample) {
  const found = retrieveTwoTier(index, t, { minScore: 0, maxItems: 2, preferSummaryChunks: true });
  const sTop = index.search(t, { layers: ['summary'], limit: 1 })[0]?.score ?? 0;
  const rTop = index.search(t, { layers: ['raw'], limit: 1 })[0]?.score ?? 0;
  console.log(`seq=${String(seq).padStart(4)} sTop=${sTop.toFixed(3)} rTop=${rTop.toFixed(3)} tier=${found.tier}  Q=${t.replace(/\s+/g, ' ').slice(0, 50)}`);
}

// 不相关查询（应当低分 → 未命中 = 0 token）
console.log('\n=== 不相关查询（应当低于阈值）===');
for (const q of ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句', '量子纠缠的物理机制是什么']) {
  const sTop = index.search(q, { layers: ['summary'], limit: 1 })[0]?.score ?? 0;
  const rTop = index.search(q, { layers: ['raw'], limit: 1 })[0]?.score ?? 0;
  const found = retrieveTwoTier(index, q, { minScore: 0.3, maxItems: 2, preferSummaryChunks: true });
  console.log(`sTop=${sTop.toFixed(3)} rTop=${rTop.toFixed(3)} tier=${found.tier} Q=${q}`);
}

// 总览
const recap = buildRecap(records, { maxTokens: 300 });
console.log(`\n=== 压缩后总览（${recap.lines} 行 / ${recap.tokens} tokens / ${recap.text.length} 字符）===`);
console.log(recap.text);

// 命中注入样例
const hitQuery = shadowedUserTexts[2]?.t ?? '';
const found = retrieveTwoTier(index, hitQuery, { minScore: 0.3, maxItems: 2, preferSummaryChunks: true });
console.log(`\n=== 命中候选明细 ===`);
for (const hit of found.hits) {
  console.log(`score=${hit.score.toFixed(3)} layer=${hit.record.layer} fp=${hit.record.fp} len=${hit.record.text.length}`);
  console.log(`   head=${JSON.stringify(hit.record.text.slice(0, 90))}`);
}
const built = formatRecall(found.hits, { maxItems: 2, maxCharsPerItem: 300, maxTokensPerTurn: 500 });
console.log(`\n=== 命中注入样例（query=「${hitQuery.slice(0, 40)}」）===`);
console.log(`chars=${built.text.length} tokens=${estimateTokens(built.text)} items=${built.items}`);
console.log(built.text);
