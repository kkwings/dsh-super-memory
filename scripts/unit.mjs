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

import { DEFAULTS, SettingsStore, normalizeSettings, validatePatch, resolveDataHome, dataHomeInfo } from '../lib/config.js';
import {
  MARKER, containment, estimateTokens, extractTitle, stripMarkerSegments, textFromBlocks, tokenSet, jaccard,
} from '../lib/text.js';
import { conversationTurns, rawRecords, summaryRecords } from '../lib/ingest.js';
import { MemoryIndex, localTopScore, retrieveTwoTier } from '../lib/retrieval.js';
import { buildRecap } from '../lib/recap.js';
import {
  NEAR_DUPLICATE_SIMILARITY, formatRecall, itemText, questionTextOf, queryTextOf, selectFreshHits,
} from '../lib/recall.js';
import { mergeUsage } from '../lib/llm.js';
import { STRONG_HIT_RATIO, strongHitScore } from '../lib/routes.js';
import { shouldExpand } from '../lib/host.js';
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

console.log('\n=== 8. 今日用量记账（token 与调用次数）===');
{
  // 跨日重置与旧文件兼容都在这条纯函数里；它坏了的表现是"日上限或账目悄悄不对"
  const day = '2026-10-07';
  const fresh = mergeUsage({}, day, 1, 1234, 56);
  eq('第一次调用写下日期', fresh.date, day);
  eq('第一次调用记为 1 次', fresh.calls, 1);
  eq('输入 token 估算被记下', fresh.inTokensEst, 1234);
  eq('输出 token 估算被记下', fresh.outTokensEst, 56);
  const grown = mergeUsage(fresh, day, 1, 100, 10);
  eq('同日累加调用次数', grown.calls, 2);
  eq('同日累加输入 token', grown.inTokensEst, 1334);
  eq('同日累加输出 token', grown.outTokensEst, 66);
  const nextDay = mergeUsage(grown, '2026-10-08', 1, 5, 5);
  eq('跨日重置调用次数（与 date 的重置口径一致）', nextDay.calls, 1);
  eq('跨日重置输入 token', nextDay.inTokensEst, 5);
  eq('跨日重置输出 token', nextDay.outTokensEst, 5);
  // 旧版本写的用量文件只有 {date, calls}：不能变成 NaN 写回磁盘
  const legacy = mergeUsage({ date: day, calls: 7 }, day, 1, 11, 3);
  eq('旧文件（只有 calls）也能续写次数', legacy.calls, 8);
  eq('旧文件缺失的 token 字段从 0 起算', legacy.inTokensEst, 11);
  check('不会写出 NaN/Infinity', Number.isFinite(legacy.inTokensEst) && Number.isFinite(legacy.outTokensEst));
  const damaged = mergeUsage({ date: day, calls: 'x', inTokensEst: null }, day, 1, Number.NaN, -5);
  eq('损坏的记录按 0 处理', damaged.calls, 1);
  eq('负值/NaN 不写进账本', damaged.inTokensEst + damaged.outTokensEst, 0);
}

console.log('\n=== 9. 扩写候选的筛选（A 项：工具结果块不花钱扩写）===');
{
  // 这条判据坏了的后果：**钱又花回工具结果上**（实测占扩写输入的 61%）。
  const long = 'x'.repeat(200);
  check('非工具块、够长 → 送去扩写', shouldExpand({ text: long }) === true);
  check('工具结果块 → 不送去扩写（哪怕很长）', shouldExpand({ text: long, src: 'tool' }) === false);
  check('工具结果块即使很短也不送', shouldExpand({ text: '短', src: 'tool' }) === false);
  check('对话块太短（标题类）→ 不送', shouldExpand({ text: 'x'.repeat(119) }) === false);
  check('正好 120 字符 → 送（边界与实现一致）', shouldExpand({ text: 'x'.repeat(120) }) === true);
  check('没有 text 字段也不抛错', shouldExpand({}) === false && shouldExpand(null) === false);
  // 入库行为**不受影响**：工具结果照样生成记录（这里用最小的假 record 验字段口径）
  const fakeTool = makeRecord({ layer: 'raw', title: '工具 read：host.js', text: long, src: 'tool', tool: 'read', compactionId: 'c1' });
  check('工具结果照旧是 L2 记录（入库不动）', fakeTool.layer === 'raw' && fakeTool.src === 'tool');
  check('工具结果记录仍然被"不扩写"判定挡住', shouldExpand(fakeTool) === false, '');
}

console.log('\n=== 10. 成本默认值（B/C 项：不许悄悄回到改前）===');
{
  // 这几条是 2026-10-07 用户决定"再砍一刀"的具体数字：谁把它们改回去，
  // 面板提示（"15 块 ≈ 2 次调用"、"8 秒是上限"）会先跟代码对不上，测试也直接红。
  eq('每批块数默认 8（原 5）', DEFAULTS.llmIngestBatchBlocks, 8);
  eq('扩写输出上限默认 240（原 300）', DEFAULTS.llmIngestMaxTokens, 240);
  eq('✕ 路径检索超时默认 8000（原 4000）', DEFAULTS.llmRecallTimeoutMs, 8000);
  eq('每块送多少字符仍是 600（上一刀，保持不变）', DEFAULTS.llmIngestBlockChars, 600);
  // 范围与夹紧不变：越界仍然被拒/被夹
  eq('每批块数上限仍是 50', typeof validatePatch({ llmIngestBatchBlocks: 51 }, DEFAULTS), 'string');
  eq('扩写输出上限 8001 仍被拒', typeof validatePatch({ llmIngestMaxTokens: 8001 }, DEFAULTS), 'string');
  eq('检索超时 300001 仍被拒', typeof validatePatch({ llmRecallTimeoutMs: 300001 }, DEFAULTS), 'string');
  eq('normalizeSettings 把 0 夹到下限 1', normalizeSettings({ llmIngestBatchBlocks: 0 }, DEFAULTS).llmIngestBatchBlocks, 1);
}

console.log('\n=== 11. 「强命中跳过改写」的门槛 ===');
{
  // 这条判据坏了的后果：要么"本来找得到也要花钱改写"（浪费），
  // 要么"本地已经很确定还去改写/或干脆不查了"（降智）。
  check('默认 minScore=0.28 → 分数线是 1.5×（浮点误差内）', Math.abs(strongHitScore(0.28) - 0.42) < 1e-9, `实际=${strongHitScore(0.28)}`);
  eq('倍数是 1.5（与注释、报告里的标定一致）', STRONG_HIT_RATIO, 1.5);
  eq('阈值被设成 0 时有下限（0 → 0，不会"任何候选都算强命中"）', strongHitScore(0), 0);
  eq('负数阈值也不产生负分数线', strongHitScore(-1), 0);
  check('非数字阈值退化为 0（而不是 NaN 让所有比较都为假）', strongHitScore(undefined) === 0 && Number.isFinite(strongHitScore('x')));
  // 本地最高分：诊断候选里的最大值（不是"第一条"，虽然检索已经排好序）
  eq('取候选里的最高分', localTopScore([{ score: 0.1 }, { score: 0.9 }, { score: 0.3 }]), 0.9);
  eq('空候选 → 0', localTopScore([]), 0);
  eq('字段缺失/非数字一律忽略', localTopScore([{}, { score: 'x' }, { score: Number.NaN }]), 0);
  eq('非数组输入不抛错', localTopScore(null), 0);
  // 端到端口径：真实语料上"本地已命中"的查询，其最高分必然 ≥ 分数线
  const records = [
    makeRecord({ layer: 'summary', title: '命中阈值是怎么定的', text: '结论：命中阈值定为 0.28，因为相关与不相关分数分得很开，实测能分开。', compactionId: 'c1' }),
    makeRecord({ layer: 'raw', title: '天气闲聊', text: '今天天气不错，适合出门散步，顺便买点水果回来。', compactionId: 'c1' }),
  ];
  const index = new MemoryIndex(records);
  const best = localTopScore(index.search('命中阈值是怎么定的', { limit: 5 }).map((hit) => ({ score: hit.score })));
  check('相关查询的最高分 ≥ 默认分数线（该跳过改写）', best >= strongHitScore(0.28), `实际最高分=${best.toFixed(3)}`);
  const miss = localTopScore(index.search('明天北京天气预报怎么样', { limit: 5 }).map((hit) => ({ score: hit.score })));
  check('不相关查询的最高分 < 分数线（不该跳过改写）', miss < strongHitScore(0.28), `实际最高分=${miss.toFixed(3)}`);
}

console.log('\n=== 12. 同一轮里不注入近重复的块（真实浪费：约 195 token/轮）===');
{
  // 真实场景（2026-10-07 实测）：库里同名标题「Primary Request and Intent」有 7 块，
  // 两两 full Jaccard 0.628~0.996 —— 远超 0.6 的阈值。原有去重只比对"本进程已经注入过的
  // 完整正文"，于是**库里本就近重复的多块在同一轮被一起选中**时没人管（约 195 token/轮）。
  // 这一节就是那个场景的最小复现，`selectFreshHits` 是宿主 `runRecall` 真正调用的那个函数。
  const base = '结论：跨压缩记忆插件必须在同一会话被压缩多次之后，仍能检索到早先定过的结论并作为参考注入，'
    + '未命中时一分 token 都不花，命中时单轮注入不超过 500 token，每条不超过 300 字符。';
  /** 造一批"彼此近重复"的块。 */
  const make = (title, text, compactionId) => makeRecord({ layer: 'summary', title, text, compactionId });
  /** 一段**互不重复**的中文填充（字都不重样 → bigram 也都不重样，用来精确控制相似度）。 */
  const filler = (start, count) => Array.from({ length: count }, (_, i) => String.fromCharCode(start + i)).join('');
  /** 走一遍真实管线：检索 → 同轮筛选 → 拼装（两处的 maxCharsPerItem 必须同口径）。 */
  const recall = (records, query, options = {}) => {
    const maxChars = options.maxCharsPerItem ?? 300;
    const pairs = new MemoryIndex(records).search(query, { limit: 6 });
    const ranked = pairs.map((hit) => ({ ...hit, fp: String(hit.record.fp ?? '') }))
      .sort((a, b) => b.score - a.score);
    const selected = selectFreshHits(ranked, {
      dedupe: options.dedupe !== false,
      maxCharsPerItem: maxChars,
      injectedFps: options.injectedFps ?? new Set(),
      injectedTexts: options.injectedTexts ?? [],
    });
    return { built: formatRecall(selected.fresh, { maxItems: 2, maxCharsPerItem: maxChars, maxTokensPerTurn: 500 }), selected, ranked };
  };

  // ① 三块近似（标题不同、正文几乎一样）→ 只注入 1 条（改前：分数接近就会注入 2 条）
  const sameBody = [
    make('压缩策略与成本', `${base}（第 1 次压缩留下的副本）`, 'c1'),
    make('注入预算与阈值', `${base}（第 2 次压缩留下的副本）`, 'c2'),
    make('检索与注入口径', `${base}（第 3 次压缩留下的副本）`, 'c3'),
  ];
  const round1 = recall(sameBody, '跨压缩记忆插件要做到什么');
  check('三块近似都被检索到（前提成立）', round1.ranked.length >= 2, `实际候选=${round1.ranked.length}`);
  eq('同一轮里只注入 1 条（近重复被互相去重）', round1.built.items, 1);
  eq('保留的是分数最高的那条', round1.selected.fresh[0].fp, round1.ranked[0].fp);
  check('被丢掉的以 near-duplicate 记因', round1.selected.dropped.every((item) => item.reason === 'near-duplicate'),
    JSON.stringify(round1.selected.dropped));
  const before1 = formatRecall(round1.ranked, { maxItems: 2, maxCharsPerItem: 300, maxTokensPerTurn: 500 });
  check('（对照）不做同轮去重时确实是 2 条 —— 证明这条断言不是白写的', before1.items === 2, `实际=${before1.items}`);

  // ② 指纹不同、正文相似度不到 0.6，但**截断后的那一行几乎一样** → 也只注入 1 条。
  //    这正是 scripts/selftest.mjs 的注入样例里"两条一模一样的行"的来历（那两条逐字相同，
  //    却因为指纹不同、完整正文不同而谁都挡不住，白白多喂约 100 token）。
  //    每条截到 160 字符：两条加起来仍在 500 token 的单轮预算内，否则预算本身就会先砍掉第二条。
  const lineCap = 160;
  const head = ('问：你前面帮我做的测试页面有点几年前的小米的视觉风格，你可以参考一下我这几张截图 — 先重写页面：'
    + '页面已重写为手机 App / 小程序风格。我尝试再用无头浏览器生成效果图（上次被环境拦截，这次换 --no-sandbox）：'
    + '仍在环境层被拦截（码 13），无头渲染子进程无法在受限沙箱内启动，这是环境限制，我放弃自动出图。').repeat(2).slice(0, 280);
  const linePair = [
    make('页面重做', `${head}${filler(0x4e00, 300)}`, 'c1'),
    make('视觉风格', `${head}${filler(0x5e00, 300)}`, 'c2'),
  ];
  const lineA = linePair[0];
  const lineB = linePair[1];
  const lineSim = jaccard(tokenSet(itemText(lineA, lineCap)), tokenSet(itemText(lineB, lineCap)));
  const bodySim = jaccard(tokenSet(lineA.text), tokenSet(lineB.text));
  check('两块正文相似度 < 0.6（标题规则与正文规则都挡不住）', bodySim < 0.6, `正文相似=${bodySim.toFixed(3)}`);
  check('两块"会被注入的那一行"≥ 0.6（只有行口径能挡）', lineSim >= 0.6, `行相似=${lineSim.toFixed(3)}`);
  const round2 = recall(linePair, '测试页面视觉风格', { maxCharsPerItem: lineCap });
  check('两块都被检索到（前提成立）', round2.ranked.length >= 2, `实际候选=${round2.ranked.length}`);
  eq('截断后几乎一样的两条只注入 1 条', round2.built.items, 1);
  const before2 = formatRecall(round2.ranked, { maxItems: 2, maxCharsPerItem: lineCap, maxTokensPerTurn: 500 });
  check('（对照）不做同轮去重时是 2 条、白花一大截 token',
    before2.items === 2 && before2.tokens > round2.built.tokens,
    `改前 ${before2.items} 条 ≈${before2.tokens} token / 改后 ${round2.built.items} 条 ≈${round2.built.tokens} token`);

  // ③ 真的是"不同的块"时必须照旧注入 2 条（不能把去重写成"每轮只留一条"）
  const distinct = [
    make('命中阈值标定', '结论：命中阈值定为 0.28，因为相关与不相关的分数分得很开，实测能分开。', 'c1'),
    make('入库口径', '结论：思考过程永不入库，工具结果只收只读类工具的结果原文，带白名单与两级上限。', 'c2'),
  ];
  const round3 = recall(distinct, '命中阈值和入库口径分别是怎么定的');
  eq('内容不同的两块照旧各注入一条', round3.built.items, 2);

  // ④ injectedTexts 必须存**真正注入的那一行**（截断后），不是完整正文
  const longBody = `${base}${filler(0x4e00, 3000)}`;
  const longRound = recall([make('长块', longBody, 'c1')], '跨压缩记忆插件要做到什么', { maxCharsPerItem: 300 });
  const stored = longRound.selected.fresh[0].tokens;
  const fullBody = tokenSet(longBody);
  check('入队的是那一行（≤ 300 字符量级）', stored.size <= 320, `行 token=${stored.size}`);
  check('不再是完整正文（6000 字符的块：正文 token 数量级大得多）', fullBody.size >= 2500, `正文 token=${fullBody.size}`);
  check('两者口径确实不同（这就是"存正文、注入截断文本"的 bug）',
    jaccard(stored, fullBody) < 0.6, `相似度=${jaccard(stored, fullBody).toFixed(3)}`);
  check('宿主登记的是 built.lines（逐条真正注入的文本）',
    Array.isArray(longRound.built.lines) && longRound.built.lines.length === longRound.built.items
    && String(longRound.built.lines[0]).startsWith('- ') && String(longRound.built.text).includes(longRound.built.lines[0]),
    `lines=${JSON.stringify(longRound.built.lines)}`);
  eq('fps 与 lines 一一对应', longRound.built.fps.length, longRound.built.lines.length);
}

console.log('\n=== 13. ⑦ 模型档位：off 时旧字段非空，改选「调用指定模型」不许清空 ===');
{
  // 真实场景（2026-10-08 用户实测）：设置文件里 `llmMode:'off'`，但旧字段
  // （`llmIngestProvider/llmIngestModel`）还留着上次配好的型号。改前的两个坑：
  //   ① 面板在 off 下不显示型号下拉 → 用户完全看不到这套配置还在；
  //   ② 一改选「调用指定模型」，`applyLlmMode` 从**空的** `llmProvider/llmModel` 派生
  //      → 把旧字段静默清空（下拉里刚出现就变空）。
  // 这一节钉死"回落 + off 不清空"，两条都是能红的（删掉修复即失败）。
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-unit-llm-'));
  const file = path.join(temp, 'dsh-super-memory.settings.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, llmMode: 'off', llmIngestProvider: 'zhipu-glm', llmIngestModel: 'glm-5.3-flash',
  }), 'utf8');
  const store = new SettingsStore({ path: file });
  const loaded = store.get().settings;
  eq('① 读回来的 llmMode 仍是 off', loaded.llmMode, 'off');
  eq('① 旧字段原样保留（面板据此提示"设置里还记着 …"）',
    `${loaded.llmIngestProvider} / ${loaded.llmIngestModel}`, 'zhipu-glm / glm-5.3-flash');

  const custom = store.update({ llmMode: 'custom' }).settings;
  eq('② 切成 custom：provider 回落到旧字段（不是从空的 llmProvider 派生）', custom.llmIngestProvider, 'zhipu-glm');
  eq('② 切成 custom：model 同理', custom.llmIngestModel, 'glm-5.3-flash');
  eq('② 检索那一对一起派生', `${custom.llmRecallProvider}/${custom.llmRecallModel}`, 'zhipu-glm/glm-5.3-flash');
  eq('② 回落**不回写**新字段（llmProvider 仍为空 —— 用户没做过这个选择）', custom.llmProvider, '');
  eq('② 模式真的生效：辅助开关打开', custom.llmAssistEnabled, true);

  const off = store.update({ llmMode: 'off' }).settings;
  eq('③ off 不再清空旧字段（清掉就再也找不回来）',
    `${off.llmIngestProvider}/${off.llmIngestModel}`, 'zhipu-glm/glm-5.3-flash');
  eq('③ off 仍然真的不调用模型（三个开关压回 false）', off.llmAssistEnabled, false);
  const again = store.update({ llmMode: 'custom' }).settings;
  eq('③ 再切回 custom 仍保留 zhipu-glm / glm-5.3-flash',
    `${again.llmIngestProvider} / ${again.llmIngestModel}`, 'zhipu-glm / glm-5.3-flash');
  eq('③ 落盘后仍是它（重启后也记得）',
    `${JSON.parse(fs.readFileSync(file, 'utf8')).llmIngestProvider}`, 'zhipu-glm');

  // 对照两条：回落不会无中生有；main 仍然必须清空（否则"跟随主模型"会错调自定义模型）
  const bare = normalizeSettings({ llmMode: 'custom' }, DEFAULTS, { deriveMode: true });
  eq('（对照）从没配过型号时 custom 仍是空串 —— 回落不会无中生有',
    `${bare.llmIngestProvider}/${bare.llmIngestModel}`, '/');
  const main = normalizeSettings(
    { llmMode: 'main', llmIngestProvider: 'zhipu-glm', llmIngestModel: 'glm-5.3-flash' },
    DEFAULTS, { deriveMode: true },
  );
  eq('（对照）main 仍清空 provider/model（空的语义是"跟随当前会话主模型"）',
    `${main.llmIngestProvider}/${main.llmIngestModel}`, '/');
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('\n=== 14. 「≤2 条」必须真的放得下（单轮上限 500 → 700）===');
{
  // 中文下"2 条 × 每条 300 字符" ≈ 510 token，再加 HEADER 就超过旧的 500：
  // `formatRecall` 的预算循环会先 `pop()` 掉第二条 —— 于是"≤2 条"从来没生效过
  // （实测症状：命中时无论多相关都只看到一条）。这一节用**两条满额中文块**钉死它。
  const filler = (start, count) => Array.from({ length: count }, (_, i) => String.fromCharCode(start + i)).join('');
  const records = [
    makeRecord({
      layer: 'summary', title: 'A 单轮预算', compactionId: 'c1',
      text: `结论：单轮注入上限必须放得下两条满额的中文块。${filler(0x4e00, 280)}`,
    }),
    makeRecord({
      layer: 'summary', title: 'B 两条上限', compactionId: 'c2',
      text: `结论：每条的字符上限与单轮 token 上限要同时满足。${filler(0x5e00, 280)}`,
    }),
  ];
  const ranked = new MemoryIndex(records).search('单轮注入上限与两条上限', { limit: 6 })
    .map((hit) => ({ ...hit, fp: String(hit.record.fp ?? '') }))
    .sort((a, b) => b.score - a.score);
  check('两块都被检索到（前提成立）', ranked.length >= 2, `实际候选=${ranked.length}`);
  const selected = selectFreshHits(ranked, {
    dedupe: true, maxCharsPerItem: DEFAULTS.maxCharsPerItem, injectedFps: new Set(), injectedTexts: [],
  });
  eq('两块内容不同 → 都被留下（前提成立，不是去重砍掉的）', selected.fresh.length, 2);
  const limits = {
    maxItems: DEFAULTS.maxItems,
    maxCharsPerItem: DEFAULTS.maxCharsPerItem,
    maxTokensPerTurn: DEFAULTS.maxTokensPerTurn,
  };
  const two = formatRecall(selected.fresh, limits);
  eq('默认上限下真的注入 2 条（改前恒为 1 条）', two.items, 2);
  check('两条都是满额 300 字符（否则这条断言不成立）',
    two.lines.every((line) => line.length - 2 === 300), `实际=${two.lines.map((line) => line.length - 2).join(',')}`);
  check('总注入不超过默认单轮上限', two.tokens <= DEFAULTS.maxTokensPerTurn, `实际=${two.tokens} token`);
  eq('默认单轮上限就是 700（改回 500 会让上面两条立刻变红）', DEFAULTS.maxTokensPerTurn, 700);
  // **能失败的验证**：把上限改回 500 → 第二条 100% 被预算砍掉。
  const oldCap = formatRecall(selected.fresh, { ...limits, maxTokensPerTurn: 500 });
  eq('（能失败的验证）上限改回 500 → 只剩 1 条', oldCap.items, 1);
  // 把预算提到足够大，量一次"两条满额块 + HEADER"的真实总量：它必须落在 (500, 700]
  // 区间里 —— 这正是"500 装不下、700 才放得下"的量化依据。
  const full = formatRecall(selected.fresh, { ...limits, maxTokensPerTurn: 4000 });
  check('（能失败的验证）两条满额块 + HEADER 的总量在 500 与 700 之间',
    full.tokens > 500 && full.tokens <= 700, `合计≈${full.tokens} token`);
  console.log(`  量化：两条满额块 + HEADER ≈ ${full.tokens} token（旧上限 500 下只剩 ${oldCap.items} 条 / 新上限 700 下 ${two.items} 条）`);
}

console.log('\n=== 15. 「✕」的 boost 与同轮召回不许重复投喂同一段历史 ===');
{
  // 真机形状：boost = 固定说明段 + `（原始记忆文件：…）` + 资料（每段 `【对话】标题\n正文前 600 字符`）。
  // 召回那边的候选是**同一批块**（✕ 刚按这句话找过），于是同一段历史会被投喂两遍。
  // 修法：召回筛选把 boost 文本当成"已经注入过的文本"，重叠的块丢掉；boost 本身**一个字不动**。
  const filler = (start, count) => Array.from({ length: count }, (_, i) => String.fromCharCode(start + i)).join('');
  const boostedText = `结论：单轮注入上限从 500 提到 700，因为两条满额中文块装不进 500。${filler(0x4e00, 280)}`;
  /** boost 里的一段资料：与宿主 `routes.js` 的构造逐字同形（标题一行 + 正文前 600 字符）。 */
  const para = (title, body) => `【对话】${title}\n${body.replace(/\s+/g, ' ').trim().slice(0, 600)}`;
  // 真机的 boost 是 **1250–1925 字符**（说明段 + 最多 3 段资料 × 600 字符）：这里照同样体量造，
  // 否则"用 Jaccard 还是包含度"这条口径断言会因为 boost 太小而失真。
  const material = [
    para('单轮注入上限', boostedText),
    para('成本红线', `结论：整场会话的插件开销约 6 万 token，占比约 0.01%。${filler(0x6000, 280)}`),
    para('入库口径', `结论：思考过程永不入库，工具结果只收只读类工具的原文。${filler(0x7000, 280)}`),
  ].join('\n\n');
  const boostText = '⟦mem-hist⟧【本次会话更早（已被压缩）的参考 · 用户点了「✕」后由辅助模型找到】\n'
    + '请在回答正文里**明确告诉用户**：你从本会话"已压缩的历史"里找到了哪些相关内容，'
    + '并引用其中 1–3 句关键原文，再结合用户新增的条件回答。\n'
    + `（原始记忆文件：E:\\x\\session-1.jsonl）\n\n${material}`;
  const records = [
    makeRecord({ layer: 'summary', title: '单轮注入上限', text: boostedText, compactionId: 'c1' }),
    makeRecord({
      layer: 'summary', title: '晚饭菜单', compactionId: 'c2',
      text: `结论：晚上做番茄炒蛋与青椒肉丝，米饭多煮一点，别放太多盐。${filler(0x5e00, 60)}`,
    }),
  ];
  const ranked = new MemoryIndex(records).search('单轮注入上限与晚饭菜单', { limit: 6 })
    .map((hit) => ({ ...hit, fp: String(hit.record.fp ?? '') }))
    .sort((a, b) => b.score - a.score);
  check('两块都被检索到（前提成立）', ranked.length >= 2, `实际候选=${ranked.length}`);
  const common = { dedupe: true, maxCharsPerItem: DEFAULTS.maxCharsPerItem, injectedFps: new Set(), injectedTexts: [] };

  const withBoost = selectFreshHits(ranked, { ...common, boostText });
  check('与 boost 重叠的那条被丢掉（reason=boost-overlap）',
    withBoost.dropped.some((item) => item.reason === 'boost-overlap'), JSON.stringify(withBoost.dropped));
  eq('不相关的那块照旧注入', withBoost.fresh.length, 1);
  eq('留下的确实是不相关的那块', withBoost.fresh[0].title, '晚饭菜单');
  const built = formatRecall(withBoost.fresh, {
    maxItems: DEFAULTS.maxItems, maxCharsPerItem: DEFAULTS.maxCharsPerItem, maxTokensPerTurn: DEFAULTS.maxTokensPerTurn,
  });
  check('注入文本里没有再出现 boost 那段的正文（不重复投喂）',
    !built.text.includes('单轮注入上限从 500 提到 700'), `注入=${built.text.slice(0, 120)}`);
  check('boost 文本一个字都没被动过（用户点 ✕ 得到的那段必须完整保留）',
    boostText.includes('（原始记忆文件：') && boostText.endsWith(material) && boostText.includes(boostedText.slice(0, 600)),
    `boost 长度=${boostText.length}`);

  // 对照：没有 boost 时两块都注入 —— 证明上面那条不是恒真
  const withoutBoost = selectFreshHits(ranked, common);
  eq('（对照）不传 boostText → 两块都在', withoutBoost.fresh.length, 2);

  // 判据本身：Jaccard 在"尺寸差一个数量级"时够不到阈值，只有包含度能挡住（这就是实现口径）
  const line = itemText(records[0], DEFAULTS.maxCharsPerItem);
  const sim = jaccard(tokenSet(line), tokenSet(boostText));
  const cover = containment(tokenSet(line), tokenSet(boostText));
  check('（口径）Jaccard 远低于阈值、包含度高于阈值 —— 用 Jaccard 等于没做',
    sim < NEAR_DUPLICATE_SIMILARITY && cover >= NEAR_DUPLICATE_SIMILARITY,
    `jaccard=${sim.toFixed(3)} containment=${cover.toFixed(3)} 阈值=${NEAR_DUPLICATE_SIMILARITY}`);
  console.log(`  口径：boost ${boostText.length} 字符 / 候选行 300 字符 → Jaccard=${sim.toFixed(3)}（够不到 ${NEAR_DUPLICATE_SIMILARITY}）、包含度=${cover.toFixed(3)}`);
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);

if (failures.length > 0) {
  console.log('失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log('全部通过。');
