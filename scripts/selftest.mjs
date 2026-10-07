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
import { formatRecall, selectFreshHits } from '../lib/recall.js';
import { estimateTokens } from '../lib/text.js';
import { appendRecords, fingerprint, readRecords, storeRoot } from '../lib/store.js';

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
// **先清空自己的临时库**：本脚本是"把整份日志重新入库一遍"，而 `appendRecords` 只追加，
// 于是重复运行会**累积**（实测 348 → 731 → 1041 条）—— 条数、占用、分数分布都不再可比，
// 看起来还像"插件重复入库"的 bug。只删本脚本自己的记忆目录，绝不动会话日志。
fs.rmSync(root, { recursive: true, force: true });
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

// 总览（上限也跟随插件默认值，别在这里写死 —— 写死会让"测试通过"与"插件真实行为"脱节）
const recap = buildRecap(records, { maxTokens: settings.compactionRecapMaxTokens });
console.log(`\n=== 压缩后总览（${recap.lines} 行 / ${recap.tokens} tokens / ${recap.text.length} 字符）===`);
console.log(recap.text);

// 命中注入样例。检索参数也**跟随插件默认值**（早先写死 0.3 = 比线上的 0.28 更严，
// 于是样例可能比线上"少"看到候选 —— 两个方向的不一致都会让人误判）。
const hitQuery = shadowedUserTexts[2]?.t ?? '';
const found = retrieveTwoTier(index, hitQuery, {
  minScore: settings.minScore,
  maxItems: settings.maxItems,
  preferSummaryChunks: settings.preferSummaryChunks,
});
console.log(`\n=== 命中候选明细（**未经去重**的粗筛候选）===`);
for (const hit of found.hits) {
  console.log(`score=${hit.score.toFixed(3)} layer=${hit.record.layer} fp=${hit.record.fp} len=${hit.record.text.length}`);
  console.log(`   head=${JSON.stringify(hit.record.text.slice(0, 90))}`);
}
// **必须走宿主同一套筛选**（`lib/recall.js` 的 `selectFreshHits`）。
// 这里曾经直接 `formatRecall(found.hits)`，绕过了宿主的三道去重闸门，于是样例里会打印两条
// 一模一样的行（`items=2`）—— 看着像"插件重复投喂"，而线上真正注入的只有 1 条：
// 样例比线上多、且**不可复现**线上行为，等于把"验收凭据"变成了误导。
// 排序口径也要一致：宿主显式按分数降序排一次（`selectFreshHits` 保留"先出现的那条"）。
const ranked = [...found.hits]
  .map((hit) => ({ ...hit, fp: String(hit.record?.fp ?? fingerprint(hit.record?.text ?? '')) }))
  .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
const { fresh, dropped } = selectFreshHits(ranked, {
  dedupe: settings.dedupe,
  maxCharsPerItem: settings.maxCharsPerItem,
  injectedFps: new Set(),
  injectedTexts: [],
});
const built = formatRecall(fresh, {
  maxItems: settings.maxItems,
  maxCharsPerItem: settings.maxCharsPerItem,
  maxTokensPerTurn: settings.maxTokensPerTurn,
});
console.log(`\n=== 命中注入样例（query=「${hitQuery.slice(0, 40)}」）===`);
console.log(`候选 ${ranked.length} 条 → 去重后 ${fresh.length} 条（丢掉 ${dropped.length} 条：${dropped.map((item) => item.reason).join(', ') || '无'}）`);
console.log(`chars=${built.text.length} tokens=${estimateTokens(built.text)} items=${built.items}`);
console.log(built.text);
