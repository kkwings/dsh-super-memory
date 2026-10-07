/**
 * 单元测试（纯函数，不需要会话日志、不需要启动 DSH）。失败会**退出码 1**，可用于 CI。
 *
 * 用法：node scripts/unit.mjs
 *
 * 这里刻意收录了历次真实 bug 的回归检查 —— 每条都注明"它坏了会怎样"：
 *   · sessionLogBytes 必须返回数字（曾经返回对象，导致体积闸门永远不触发）
 *   · normalizeSettings 必须保留 knownWorkspaces（曾经改一次设置就丢工作区名单）
 *   · 回收站删除必须拒绝 `..` 之类的越界 id（曾经一条请求能删光整个记忆库）
 *   · rawRecords 缺 shadowedRange 时必须不入库（曾经会把整个会话当原文灌进 L2）
 *   · conversationTurns 只在"上一轮还没回答"时去重（曾经把用户真的问第二遍也吞掉）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, normalizeSettings, validatePatch, resolveDataHome, dataHomeInfo } from '../lib/config.js';
import {
  MARKER, estimateTokens, extractTitle, stripMarkerSegments, textFromBlocks, tokenSet, jaccard,
} from '../lib/text.js';
import { conversationTurns, rawRecords, summaryRecords } from '../lib/ingest.js';
import { MemoryIndex, retrieveTwoTier } from '../lib/retrieval.js';
import { buildRecap } from '../lib/recap.js';
import { formatRecall, questionTextOf, queryTextOf } from '../lib/recall.js';
import {
  makeRecord, moveToTrash, readRecords, removeTrashEntry, storeRoot,
} from '../lib/store.js';
import { sessionLogBytes } from '../lib/zstd.js';

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
const eq = (label, actual, expected) => check(label, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);

console.log('=== 1. 回归：曾经真实出过的 bug ===');

// ① sessionLogBytes 的契约必须是数字（否则 `bytes > LIMIT` 永远为 false）
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-unit-bytes-'));
  process.env.DSH_HOME = temp;
  const value = sessionLogBytes('session-does-not-exist');
  eq('不存在的会话 → null（而不是对象/undefined）', value, null);
  check('返回值不是对象（对象会让体积比较永远为 false）', typeof value !== 'object' || value === null, `实际类型=${typeof value}`);
  delete process.env.DSH_HOME;
  fs.rmSync(temp, { recursive: true, force: true });
}

// ② knownWorkspaces 必须被保留
{
  const merged = normalizeSettings({ knownWorkspaces: ['E:\\a', 'E:\\b'], minScore: 0.5 }, DEFAULTS);
  eq('normalizeSettings 保留已知工作区', merged.knownWorkspaces, ['E:\\a', 'E:\\b']);
  eq('normalizeSettings 同时接受合法改动', merged.minScore, 0.5);
  const kept = normalizeSettings({ knownWorkspaces: ['E:\\a', 'E:\\b'] }, DEFAULTS);
  eq('不传其他字段时也保留', kept.knownWorkspaces, ['E:\\a', 'E:\\b']);
  const junk = normalizeSettings({ knownWorkspaces: ['E:\\a', '', 42] }, DEFAULTS);
  eq('非字符串条目被过滤', junk.knownWorkspaces, ['E:\\a']);
}

// ③ storeDir 不能含 ..
{
  eq('storeDir 含 .. 被拒', typeof validatePatch({ storeDir: '../outside' }, DEFAULTS), 'string');
  eq('storeDir 正常值通过', validatePatch({ storeDir: 'my-memory' }, DEFAULTS), undefined);
  const abs = normalizeSettings({ storeDir: 'D:\\dsh-memory' }, DEFAULTS);
  eq('storeDir 允许绝对路径', abs.storeDir, 'D:\\dsh-memory');
}

// ④ 路径穿越：回收站删除不能碰到记忆库根目录
{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-unit-trav-'));
  const root = storeRoot(workspace, '.dsh-compaction-memory');
  fs.mkdirSync(root, { recursive: true });
  const sessionId = 'session-unit-0001';
  fs.writeFileSync(path.join(root, `${sessionId}.jsonl`), `${JSON.stringify(makeRecord({ layer: 'summary', title: 't', text: 'x'.repeat(120), compactionId: 'c1' }))}\n`);
  let threw = 0;
  for (const id of ['..', '../..', 'a/../../..', path.resolve(workspace)]) {
    try { removeTrashEntry(root, id); } catch { threw += 1; }
  }
  eq('四种越界 id 全部抛错', threw, 4);
  check('记忆库仍在（没被删光）', fs.existsSync(path.join(root, `${sessionId}.jsonl`)));
  eq('正常回收站条目仍可删除', (() => {
    const id = moveToTrash(root, sessionId, readRecords(root, sessionId));
    return removeTrashEntry(root, id) === true;
  })(), true);
  fs.rmSync(workspace, { recursive: true, force: true });
}

// ⑤ rawRecords 必须有合法的 shadowedRange，否则不入库
{
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '回答一' }] } } },
  ];
  const session = { snapshotEvents: () => events };
  const missing = rawRecords({ session, sessionId: 's', compactionId: 'c', range: {}, settings: {} });
  eq('缺 shadowedRange → 不入库', missing.records.length, 0);
  const bad = rawRecords({ session, sessionId: 's', compactionId: 'c', range: { start: 'x', end: 'y' }, settings: {} });
  eq('范围不是数字 → 不入库', bad.records.length, 0);
  const ok = rawRecords({ session, sessionId: 's', compactionId: 'c', range: { start: 1, end: 2 }, settings: {} });
  check('合法范围 → 正常入库', ok.records.length > 0, `实际=${ok.records.length}`);
}

// ⑥ 重试去重只针对"上一轮还没回答"的情况
{
  const repeat = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '同一个问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '第一次回答' }] } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '同一个问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '第二次回答' }] } } },
  ];
  eq('答过之后又问一遍 → 两轮都保留', conversationTurns(repeat, {}).length, 2);
  const retry = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '重试的问题' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '重试的问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '回答' }] } } },
  ];
  eq('还没回答就重发 → 只留一轮（去重生效）', conversationTurns(retry, {}).length, 1);
  const injected = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真实提问' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '运行上下文快照' }], source: { kind: 'runtime-context' } } },
  ];
  eq('系统注入不算用户提问', conversationTurns(injected, {}).length, 1);
}

console.log('\n=== 2. 入库文本口径 ===');
{
  const blocks = [
    { type: 'text', text: '正文' },
    { type: 'reasoning', text: '深度思考不该入库' },
    { type: 'tool-call', name: 'bash', arguments: '{}' },
  ];
  eq('只取 text 块', textFromBlocks(blocks), '正文');
  eq('带标记的段落被剥离', stripMarkerSegments(`前面\n\n${MARKER}【注入块】内容\n\n后面`).includes(MARKER), false);
  const summary = summaryRecords({
    sessionId: 's', compactionId: 'c1', at: new Date().toISOString(),
    summary: [{ type: 'text', text: `# 标题一\n${'内容'.repeat(300)}\n# 标题二\n${'别的'.repeat(300)}` }],
    settings: {},
  });
  check('摘要按标题切块', summary.length >= 2, `实际=${summary.length}`);
  check('块带 title/keywords/fp', summary.every((r) => r.title && Array.isArray(r.keywords) && r.fp), '');
  eq('摘要里不含自身注入标记', summary.some((r) => r.text.includes(MARKER)), false);
}

console.log('\n=== 3. 检索与注入上限 ===');
{
  // 注意：这是**小语料**，不适合断言绝对分数（BM25 的 idf 会让"全库都不存在的查询词"
  // 撑大分母，分数天然偏低；真实语料上的绝对标定由 scripts/selftest.mjs 负责）。
  // 这里断言的是排序与闸门这两条稳健性质。
  const records = [
    makeRecord({ layer: 'summary', title: '压缩策略', text: '结论：命中阈值定为 0.28，因为相关与不相关分数分得很开，实测能分开。', compactionId: 'c1' }),
    makeRecord({ layer: 'raw', title: '天气闲聊', text: '今天天气不错，适合出门散步，顺便买点水果回来。', compactionId: 'c1' }),
    makeRecord({ layer: 'raw', title: '晚饭菜单', text: '晚上做番茄炒蛋和青椒肉丝，米饭多煮一点。', compactionId: 'c1' }),
    makeRecord({ layer: 'raw', title: '交通路线', text: '从家到公司走环线更快，早高峰避开市中心那段。', compactionId: 'c1' }),
    makeRecord({ layer: 'raw', title: '电影清单', text: '周末想看的两部片子已经加到清单里了，都是老片。', compactionId: 'c1' }),
  ];
  const index = new MemoryIndex(records);
  const ranked = index.search('命中阈值是怎么定的', { limit: 3 });
  eq('相关块排在第一位', ranked[0]?.record?.title, '压缩策略');
  const gated = retrieveTwoTier(index, '命中阈值是怎么定的', { minScore: 0.05, maxItems: 2 });
  check('阈值放低后能命中', gated.tier !== 'none', `tier=${gated.tier} top=${gated.topScore}`);
  const strict = retrieveTwoTier(index, '明天北京天气预报怎么样', { minScore: 0.28, maxItems: 2 });
  eq('不相关问题在默认阈值下不命中', strict.tier, 'none');
  const built = formatRecall(gated.hits.length > 0 ? gated.hits : ranked, { maxItems: 1, maxCharsPerItem: 60, maxTokensPerTurn: 500 });
  check('注入条数受 maxItems 约束', built.items <= 1, `实际=${built.items}`);
  const line = built.text.split('\n').find((l) => l.startsWith('- ')) ?? '';
  check('每条正文受 maxCharsPerItem 约束', line.length - 2 <= 60, `实际=${line.length - 2}`);
  check('总注入受 maxTokensPerTurn 约束', built.tokens <= 500, `实际=${built.tokens}`);
  eq('无可注入内容 → 空串（0 token）', formatRecall([], { maxItems: 2, maxCharsPerItem: 300, maxTokensPerTurn: 500 }).text, '');
  // 单条下限 50（2026-10-07 用户决定：20 字符装不下一句结论，纯浪费 token）。
  // 三条口径必须一致：recall.js 的 Math.max、config.js INTEGER_FIELDS 的 minimum、面板 NumberRow 的 min。
  const floored = formatRecall(
    [{ record: makeRecord({ layer: 'summary', title: '下限探针', text: '结'.repeat(200), compactionId: 'c1' }) }],
    { maxItems: 1, maxCharsPerItem: 20, maxTokensPerTurn: 500 },
  );
  const flooredLine = floored.text.split('\n').find((l) => l.startsWith('- ')) ?? '';
  eq('maxCharsPerItem 传 20 也被抬到 50（不再有 20 字符的注入）', flooredLine.length - 2, 50);
  eq('validatePatch 拒绝 40（与下限一致，避免"能改但不生效"）', typeof validatePatch({ maxCharsPerItem: 40 }, DEFAULTS), 'string');
  eq('validatePatch 接受 50', validatePatch({ maxCharsPerItem: 50 }, DEFAULTS), undefined);
  eq('normalizeSettings 把设置文件里的 40 夹到 50', normalizeSettings({ maxCharsPerItem: 40 }, DEFAULTS).maxCharsPerItem, 50);
  eq('默认值仍是 300', DEFAULTS.maxCharsPerItem, 300);
}

console.log('\n=== 4. 总览（可为 0）===');
{
  eq('空库 → 不注入总览', buildRecap([], { maxTokens: 300 }).text, '');
  eq('上限 0 → 不注入总览', buildRecap([makeRecord({ layer: 'summary', title: 'x', text: 'y'.repeat(200), compactionId: 'c1' })], { maxTokens: 0 }).text, '');
  const many = [];
  for (let i = 0; i < 30; i += 1) {
    many.push(makeRecord({ layer: 'summary', title: `标题${i % 7}`, text: `结论：第 ${i} 轮的要点说明，需要足够长才能通过长度门槛。`.repeat(4), compactionId: `c${Math.floor(i / 7)}` }));
  }
  const recap = buildRecap(many, { maxTokens: 300 });
  check('总览不超过上限', recap.tokens <= 300, `实际=${recap.tokens}`);
  const titles = recap.text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' — ')[0]);
  eq('同一标题只出现一次（目录语义）', titles.length, new Set(titles).size);
}

console.log('\n=== 5. 文本工具 ===');
{
  check('中文 token 估算量级合理', estimateTokens('中文'.repeat(50)) > 50, '');
  eq('拉丁文与中文都能量到 token', estimateTokens('hello world') > 0, true);
  check('标题不会被截成半句话', extractTitle('# 完整标题\n' + '正文'.repeat(200), 40).length > 0, '');
  const tokens = tokenSet('跨压缩记忆插件');
  check('中文 bigram 切词', tokens.size >= 3, `实际=${tokens.size}`);
  eq('完全相同 → 相似度 1', jaccard(tokens, tokenSet('跨压缩记忆插件')), 1);
}

console.log('\n=== 6. 提问事件解析（含 inbox 早到的那条路径）===');
{
  const message = { content: [{ type: 'text', text: '这是提问' }], source: { kind: 'user' } };
  eq('UserMessage 形状 → 取到提问', questionTextOf(message), '这是提问');
  eq('系统注入 → 空', questionTextOf({ content: [{ type: 'text', text: 'x' }], source: { kind: 'runtime-context' } }), '');
  eq('user/message 事件 → 取到提问', queryTextOf({ type: 'user/message', data: message }), '这是提问');
  eq('非用户事件 → 空', queryTextOf({ type: 'assistant/message', data: message }), '');
}

console.log('\n=== 7. 全局数据目录 ===');
{
  delete process.env.DSH_SUPER_MEMORY_HOME;
  const before = dataHomeInfo();
  eq('未设环境变量 → 来源是 dsh-home', before.source, 'dsh-home');
  process.env.DSH_SUPER_MEMORY_HOME = path.join(os.tmpdir(), 'dsm-unit-home');
  const after = dataHomeInfo();
  eq('设了环境变量 → 来源是 env', after.source, 'env');
  eq('解析到环境变量指定的目录', resolveDataHome(), process.env.DSH_SUPER_MEMORY_HOME);
  delete process.env.DSH_SUPER_MEMORY_HOME;
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log('全部通过。');
