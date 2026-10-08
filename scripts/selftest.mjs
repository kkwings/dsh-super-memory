/**
 * 离线自检（**有真断言、会失败**）：用真实会话日志跑通「压缩入库 → 本地检索 → 总览」全链路（不启动 DSH）。
 *
 * 用法：node scripts/selftest.mjs <sessionLogPath> [workdir]
 *
 * 退出口径（与其它四套自检一致）：**断言失败 = 1，缺参数/日志读不到 = 2，全部通过（或合理地 SKIP）= 0**。
 *
 * 为什么从"只打印"改成"有断言"（2026-10-08 只读审查报告 P1-D）：
 *   本脚本原先 145 行、**零断言、零退出码** —— 无论链路坏成什么样都"成功退出"，
 *   被 README 与 `npm test` 当成自检用，等于一条永远绿的空检查。
 *   现在它把关键不变量钉成断言，失败就 `process.exitCode = 1`。
 *
 * 适用范围 / SKIP 口径（**跳过的一定打印 `SKIP + 原因`，不算失败**）：
 *   · 需要一份**至少含一次 `compaction/summary`** 的真实会话日志：没有压缩就没有
 *     "被压掉的历史"，本脚本没有任何东西可查 → 全部段落 SKIP，退出码 0。
 *   · **命中样例只取"确实被压缩过"的历史提问**（seq 落在某个压缩的 `shadowedRange` 内）：
 *     压缩之后才提出的问题**从来没进过库**，要求它必须命中是错的（与 `scripts/harness.mjs`
 *     同一口径）。一条这样的提问都没有 → 命中段 SKIP。
 *   · `workdir` 下会**重新生成自己的记忆库**（跑之前先删 `<workdir>/.dsh-compaction-memory/`），
 *     所以别指向你不想被覆盖的目录；默认落在系统临时目录。
 *   · 只读会话日志，绝不改写它（脚本里只有一次 `fs.readFileSync`）。
 *
 * 能失败的验证（本轮实测）：
 *   · 把 `lib/retrieval.js` 的 `MIN_MATCHED_TERMS` 改成 0（等于关掉命中证据门）
 *     → "不相关提问必须不注入"立刻红（无关问题的相对分会到 1.0 上下）；
 *   · 把 `settings.ingestSummary` 改成 false（改本文件第 62 行的 `settings` 覆盖）
 *     → "L1 摘要块 > 0"立刻红。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decompressFrames } from '../lib/zstd.js';
import { DEFAULTS } from '../lib/config.js';
import { summaryRecords, rawRecords } from '../lib/ingest.js';
import { MemoryIndex, retrieveTwoTier } from '../lib/retrieval.js';
import { buildRecap } from '../lib/recap.js';
import { formatRecall, questionTextOf, selectFreshHits } from '../lib/recall.js';
import { estimateTokens } from '../lib/text.js';
import { appendRecords, fingerprint, readRecords, storeRoot } from '../lib/store.js';

const logPath = process.argv[2];
if (typeof logPath !== 'string' || logPath.trim() === '') {
  console.error('缺少会话日志路径。\n\n用法：node scripts/selftest.mjs <sessionLogPath> [workdir]');
  process.exit(2);
}
if (!fs.existsSync(logPath)) {
  console.error(`读不到这份会话日志：${logPath}\n（路径要指向具体的 session*.jsonl[.zstd] 文件，不是目录。）`);
  process.exit(2);
}

/* ── 断言累加器（与 unit.mjs / host-smoke.mjs 同一口径）──────────────────────── */
let passed = 0;
const failures = [];
function expect(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}${detail === '' ? '' : ` — ${detail}`}`); return; }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
/** 合理地跳过一段：**打印 SKIP + 原因**，不计入失败（也不算通过）。 */
function skip(label, reason) {
  console.log(`  SKIP ${label} — ${reason}`);
}
function finish() {
  console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
  if (failures.length > 0) {
    console.log('失败明细：');
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log('全部通过。');
}

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

const compactions = events.filter((event) => event.type === 'compaction/summary');
if (compactions.length === 0) {
  // 没有压缩 = 库里什么都没有，这个脚本没有任何东西可查（不是失败，是适用范围）
  console.log('\nSKIP 全链路 — 这份日志里没有任何 `compaction/summary` 事件（没有"被压掉的历史"，无从入库/检索）。');
  console.log('通过 0 条，失败 0 条。');
  process.exit(0);
}
/** 被压缩过的 seq 区间（只有落在区间内的内容才真的进过库）。 */
const shadowedRanges = compactions
  .map((event) => [Number(event.data?.shadowedRange?.start), Number(event.data?.shadowedRange?.end)])
  .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end));
const inShadowedRange = (seq) => shadowedRanges.some(([start, end]) => seq >= start && seq <= end);

const root = storeRoot(workdir, '.dsh-compaction-memory');
// **先清空自己的临时库**：本脚本是"把整份日志重新入库一遍"，而 `appendRecords` 只追加，
// 于是重复运行会**累积**（实测 348 → 731 → 1041 条）—— 条数、占用、分数分布都不再可比，
// 看起来还像"插件重复入库"的 bug。只删本脚本自己的记忆目录，绝不动会话日志。
fs.rmSync(root, { recursive: true, force: true });
console.log('store root:', root);

let totalSummary = 0;
let totalRaw = 0;
let rawChars = 0;
for (const event of compactions) {
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

/* ── 断言 ①：入库真的有东西，且两层都在 ─────────────────────────────────────── */
console.log('\n=== 断言① 入库不变量 ===');
const l1 = records.filter((record) => record.layer === 'summary');
const l2 = records.filter((record) => record.layer === 'raw');
expect('入库块数 > 0', records.length > 0, `共 ${records.length} 块`);
expect('L1 摘要块存在且 > 0', l1.length > 0, `L1=${l1.length}`);
expect('L2 原文块存在且 > 0', l2.length > 0, `L2=${l2.length}`);
expect('库文件非空', fs.statSync(file).size > 0, `${fs.statSync(file).size} bytes`);
expect('每条记录都有 text/fp/layer', records.every((record) => typeof record.text === 'string' && record.text !== '' && typeof record.fp === 'string' && record.fp !== '' && record.layer !== ''),
  `异常条数=${records.filter((record) => typeof record.text !== 'string' || record.fp === undefined).length}`);

const index = new MemoryIndex(records);
console.log('\n=== 入库内容抽查（L1 前 3 块 + L2 前 2 块）===');
for (const rec of l1.slice(0, 3)) {
  console.log(`[L1] title=${JSON.stringify(rec.title)} kw=${JSON.stringify(rec.keywords)} chars=${rec.text.length}`);
  console.log(`     ${rec.text.slice(0, 150).replace(/\n/g, ' / ')}`);
}
for (const rec of l2.slice(0, 2)) {
  const hasReasoning = /"type":"reasoning"|工具结果/.test(rec.text);
  console.log(`[L2] title=${JSON.stringify(rec.title)} chars=${rec.text.length} 含思考/工具噪声=${hasReasoning}`);
  console.log(`     ${rec.text.slice(0, 150).replace(/\n/g, ' / ')}`);
}

/* ── 断言 ②：总览在 token 预算内 ─────────────────────────────────────────────── */
// 总览（上限也跟随插件默认值，别在这里写死 —— 写死会让"测试通过"与"插件真实行为"脱节）
const recap = buildRecap(records, { maxTokens: settings.compactionRecapMaxTokens });
console.log(`\n=== 压缩后总览（${recap.lines} 行 / ${recap.tokens} tokens / ${recap.text.length} 字符）===`);
console.log(recap.text);
console.log('\n=== 断言② 总览不变量 ===');
expect('总览有内容（库里有摘要块时必须能给出一份总览）', recap.text.trim() !== '', `${recap.lines} 行`);
expect('总览 token 在配置预算内（compactionRecapMaxTokens）',
  recap.tokens <= settings.compactionRecapMaxTokens,
  `${recap.tokens} / 预算 ${settings.compactionRecapMaxTokens}`);

/* ── 断言 ③④⑤：用被压缩过的真实提问当正样本，无关问题当负样本 ─────────────── */
// 用被压掉内容里的真实问题当查询，检查分数分布（标定 minScore）
const shadowedUserTexts = [];
for (const event of events) {
  if (event.type !== 'user/message') continue;
  // **与插件同一口径**：只认真正的用户提问（`questionTextOf` 会挡掉通知类与
  // 宿主代发的任务提示）。用 kind 直接判会把这些噪声也算成正样本。
  const t = questionTextOf(event.data);
  if (t !== '') shadowedUserTexts.push({ seq: Number(event.seq) || 0, t, covered: inShadowedRange(Number(event.seq) || 0) });
}
const coveredQuestions = shadowedUserTexts.filter((item) => item.covered);
console.log(`\n=== 打分标定：${Math.min(12, shadowedUserTexts.length)} 条历史问题 ===`);
for (const { seq, t, covered } of shadowedUserTexts.slice(0, 12)) {
  const found = retrieveTwoTier(index, t, { minScore: 0, maxItems: 2, preferSummaryChunks: true });
  const sTop = index.search(t, { layers: ['summary'], limit: 1 })[0]?.score ?? 0;
  const rTop = index.search(t, { layers: ['raw'], limit: 1 })[0]?.score ?? 0;
  console.log(`seq=${String(seq).padStart(4)} 已入库=${covered ? '是' : '否'} sTop=${sTop.toFixed(3)} rTop=${rTop.toFixed(3)} tier=${found.tier}  Q=${t.replace(/\s+/g, ' ').slice(0, 50)}`);
}

console.log('\n=== 断言③ 命中样例必须注入（且不超单轮上限）===');
if (coveredQuestions.length === 0) {
  skip('命中样例', '这份日志里没有"落在压缩区间内的人类提问"（所有提问都是压缩之后才问的，从来没进过库）');
} else {
  // 样本取**已入库**提问里分数最高的那条（不挑"刚好能过"的那条：命中数会一起打印出来）
  let best = null;
  for (const { t } of coveredQuestions) {
    const found = retrieveTwoTier(index, t, {
      minScore: settings.minScore, maxItems: settings.maxItems, preferSummaryChunks: settings.preferSummaryChunks,
    });
    if (best === null || found.topScore > best.found.topScore) best = { t, found };
  }
  expect('已入库的历史提问里至少有一条能命中（不是"一条都搜不回来"）',
    best !== null && best.found.hits.length > 0 && best.found.tier !== 'none',
    `已入库提问 ${coveredQuestions.length} 条，最高分 ${best?.found.topScore?.toFixed(4)}（阈值 ${settings.minScore}）`);
  if (best !== null && best.found.hits.length > 0) {
    const ranked = [...best.found.hits]
      .map((hit) => ({ ...hit, fp: String(hit.record?.fp ?? fingerprint(hit.record?.text ?? '')) }))
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    const { fresh, dropped } = selectFreshHits(ranked, {
      dedupe: settings.dedupe, maxCharsPerItem: settings.maxCharsPerItem, injectedFps: new Set(), injectedTexts: [],
    });
    const built = formatRecall(fresh, {
      maxItems: settings.maxItems, maxCharsPerItem: settings.maxCharsPerItem, maxTokensPerTurn: settings.maxTokensPerTurn,
    });
    console.log(`  命中样例 query=「${best.t.replace(/\s+/g, ' ').slice(0, 40)}」`);
    console.log(`  候选 ${ranked.length} 条 → 去重后 ${fresh.length} 条（丢掉 ${dropped.length} 条：${dropped.map((item) => item.reason).join(', ') || '无'}）`);
    console.log(`  chars=${built.text.length} tokens=${built.tokens} items=${built.items}`);
    console.log(built.text);
    expect('命中样例真的注入了内容（不是空串）', built.text !== '' && built.items > 0, `items=${built.items}`);
    expect('注入量不超过单轮上限（maxTokensPerTurn 是承诺给用户的成本红线）',
      built.tokens <= settings.maxTokensPerTurn, `${built.tokens} / 上限 ${settings.maxTokensPerTurn}`);
    const injectedLines = built.lines.filter((line) => line.startsWith('- ['));
    expect('注入行带来源前缀（`- [对话] …`）', injectedLines.length > 0, `lines=${built.lines.length}`);
    // **"带答案而不是只有标题/问句"的可失败证据**：`itemText` 的口径是 `标题 — 正文取样`，
    // 正文取样里优先取结论句。若哪天退回"只注入标题/问句"，下面这条立刻红。
    const withAnswer = injectedLines.find((line) => {
      const tail = line.split(' — ')[1] ?? '';
      return tail.trim().length >= 6;
    });
    expect('注入行带答案正文（`标题 — 正文` 且正文非空，不是只回标题/问句）',
      withAnswer !== undefined, `lines=${JSON.stringify(injectedLines.map((line) => line.slice(0, 60)))}`);
  }
}

console.log('\n=== 断言④ 不相关提问必须 0 token ===');
// 不相关查询（应当低分 → 未命中 = 0 token）
const unrelated = ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句', '量子纠缠的物理机制是什么'];
for (const q of unrelated) {
  const sTop = index.search(q, { layers: ['summary'], limit: 1 })[0]?.score ?? 0;
  const rTop = index.search(q, { layers: ['raw'], limit: 1 })[0]?.score ?? 0;
  const found = retrieveTwoTier(index, q, { minScore: settings.minScore, maxItems: settings.maxItems, preferSummaryChunks: settings.preferSummaryChunks });
  const built = formatRecall(found.hits, {
    maxItems: settings.maxItems, maxCharsPerItem: settings.maxCharsPerItem, maxTokensPerTurn: settings.maxTokensPerTurn,
  });
  console.log(`  sTop=${sTop.toFixed(3)} rTop=${rTop.toFixed(3)} tier=${found.tier} chars=${built.text.length} Q=${q}`);
  expect(`不相关提问必须不注入：${q}`, built.text === '' && built.items === 0, `注入了 ${built.text.length} 字符`);
}

finish();
