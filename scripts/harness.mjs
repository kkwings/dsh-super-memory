/**
 * 宿主半边联调自检：不启动 DSH，用假的 cordis ctx + 真实会话日志跑一遍
 * 「压缩入库 → 压缩后总览 → 提问命中注入 → 未命中 0 token → 设置开关即时生效 → 面板 API → history_read」。
 *
 * 用法：node scripts/harness.mjs <sessionLogPath> [workdir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logPath = process.argv[2];
const workdir = process.argv[3] ?? path.join(os.tmpdir(), 'dsm-harness-workspace');
const home = path.join(os.tmpdir(), `dsm-harness-home-${process.pid}`);
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workdir, { recursive: true });
process.env.DSH_HOME = home;

const { apply } = await import('../lib/host.js');
const { decompressFrames } = await import('../lib/zstd.js');
const { mergeKeywords, parseJsonArray, parseJsonObject } = await import('../lib/llm.js');
const { diagnoseMiss } = await import('../lib/diagnose.js');
const { toolRecords } = await import('../lib/ingest.js');

/**
 * 假模型服务：由测试用例在 `apply()` **之前**设置，用来跑失败矩阵。
 * 始终存在（DSH 里 llm 一定在），靠 `behavior.mode` 切换返回内容；
 * "完全没有 llm 服务"那种机器由 `UNAVAILABLE` 闸门覆盖（见 unit.mjs）。
 */
const behavior = { mode: 'off', calls: 0 };
const fakeLlm = {
  async listProviders() { return [{ provider: 'fake-provider', model: 'fake-model' }]; },
  async *stream() {
    behavior.calls += 1;
    if (behavior.mode === 'hang') { await new Promise((resolve) => setTimeout(resolve, 3000)); return; }
    if (behavior.mode === 'no-adapter') {
      yield { type: 'finish', kind: 'error', failure: { code: 'NO_ADAPTER', message: '提供方未注册' } };
      return;
    }
    if (behavior.mode === 'garbage') {
      yield { type: 'text-delta', index: 0, text: '抱歉，我不能返回 JSON。' };
      yield { type: 'finish', kind: 'done' };
      return;
    }
    yield { type: 'text-delta', index: 0, text: '{"0": ["跨压缩记忆怎么装", "记忆兜底"], "1": ["注入成本上限"]}' };
    yield { type: 'finish', kind: 'done' };
  },
};

/* ── 假的 cordis 上下文 ─────────────────────────────────────────────────── */
function makeCtx() {
  const handlers = new Map();
  const contexts = new Map();
  const tools = new Map();
  const routes = [];
  return {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context(entry) { contexts.set(entry.name, entry); return () => {}; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    /**
     * 可选服务注入：DSH 用 `ctx.inject(['llm'], cb)` 让插件"有就用、没有就降级"。
     * 这里把它实现成"有假 llm 才回调"，从而能在同一个进程里测出
     * "模型不可用 / 返回垃圾 / 超时"时插件是否仍与旧版本表现一致。
     */
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('llm') && fakeLlm !== null) {
        try { callback({ llm: fakeLlm, inject: () => () => {} }); } catch { /* 忽略 */ }
      }
      return () => {};
    },
    _handlers: handlers,
    _contexts: contexts,
    _tools: tools,
    _routes: routes,
  };
}

const ctx = makeCtx();
apply(ctx);
console.log('已挂载：context=%o tools=%o routes=%d',
  [...ctx._contexts.keys()], [...ctx._tools.keys()], ctx._routes.length);

/* ── 载入真实会话日志 ───────────────────────────────────────────────────── */
const buf = fs.readFileSync(logPath);
const { text, frames } = decompressFrames(buf);
const events = text.split('\n').filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sessionId = events[0].id;
console.log(`日志：${frames} 帧 / ${events.length} 事件 / 会话 ${sessionId}`);

/** 造一个"用户刚问了 X"的会话：把历史 user 消息 + 一条新的用户消息拼进去。 */
function sessionWithQuestion(question, suffixSeq, idOverride) {
  const base = events.filter((e) => e.type !== 'user/message' || e.data?.source?.kind !== 'user' || e.seq < 3000);
  const userEvent = {
    type: 'user/message', seq: suffixSeq, time: Date.now(),
    data: { content: [{ type: 'text', text: question }], source: { kind: 'user' }, role: 'user', id: `q-${suffixSeq}` },
  };
  const visible = [...base, userEvent];
  const id = idOverride ?? sessionId;
  return {
    id,
    header: { cwd: workdir },
    snapshotEvents: () => visible,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
}

const emit = (session, event) => {
  for (const fn of ctx._handlers.get('session/event') ?? []) fn(session, event);
};
const provider = ctx._contexts.get('plugin:dsh-super-memory').text;
const injected = (session) => provider({ agent: { session } });

/**
 * 复制一份记忆库到另一个会话 id：清掉会话级状态（去重 / 冷却 / 粘住的参考块），
 * 模拟"另一个会话也有自己的库"。要验"阈值"这类行为必须用干净的会话状态，
 * 否则上一步命中后粘住的参考块会让断言看起来像是"不相关问题也注入了"。
 */
let cloneCount = 0;
function cloneSession(question, suffixSeq) {
  const id = `session-clone-${++cloneCount}`;
  fs.copyFileSync(path.join(workdir, '.dsh-compaction-memory', `${sessionId}.jsonl`),
    path.join(workdir, '.dsh-compaction-memory', `${id}.jsonl`));
  return sessionWithQuestion(question, suffixSeq, id);
}

/* ── ① 压缩时入库 ───────────────────────────────────────────────────────── */
const compactions = events.filter((e) => e.type === 'compaction/summary');
console.log(`\n=== ① 压缩时入库（共 ${compactions.length} 次压缩）===`);
const session = { id: sessionId, header: { cwd: workdir }, snapshotEvents: () => events, requestContext: () => ({ contextWindow: 1000000 }) };
for (const event of compactions) {
  emit(session, event);
  emit(session, { type: 'compaction/end', seq: event.seq + 2, time: event.time + 1, data: { compactionId: event.data.compactionId, turn: event.data.turn } });
}
const root = path.join(workdir, '.dsh-compaction-memory');
const file = path.join(root, `${sessionId}.jsonl`);
console.log('库文件存在:', fs.existsSync(file), '大小:', fs.existsSync(file) ? fs.statSync(file).size : 0, 'bytes');
if (fs.existsSync(file)) {
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`条目 ${records.length}（摘要 L1 ${records.filter((r) => r.layer === 'summary').length} / 原文 L2 ${records.filter((r) => r.layer === 'raw').length}）`);
  const noise = records.filter((r) => r.text.includes('"type":"reasoning"') || r.text.includes('\u27e6mem-hist\u27e7'));
  console.log('含思考痕迹/自身注入标记的条目数（应为 0）:', noise.length);
}

/* 幂等：重复投递同一压缩事件不应新增 */
const sizeBefore = fs.statSync(file).size;
emit(session, compactions[0]);
console.log('重复投递后库大小变化（应为 0）:', fs.statSync(file).size - sizeBefore);

/* ── ② 压缩后总览 ───────────────────────────────────────────────────────── */
console.log('\n=== ② 压缩后总览 ===');
const first = injected(session);
console.log(`第一次注入：${first.length} 字符`);
console.log(first.split('\n').slice(0, 4).join('\n'));
const second = injected(session);
console.log('第二次注入文本是否完全相同（应当相同 → 不追加快照）:', first === second);

/* ── ③ 提问命中注入 / 未命中 0 token ────────────────────────────────────── */
console.log('\n=== ③ 提问命中 / 未命中 ===');
const relevantQuestions = [];
for (const event of events) {
  if (event.type === 'user/message' && event.data?.source?.kind === 'user' && Number(event.seq) < 2000) {
    const t = (event.data.content ?? []).map((b) => b.text ?? '').join(' ').trim();
    if (t.length > 10) relevantQuestions.push(t);
  }
}
let seqCursor = 900000;
for (const question of [relevantQuestions[2], relevantQuestions[9]]) {
  if (question === undefined) continue;
  const s = sessionWithQuestion(question, seqCursor++);
  const out = injected(s);
  const hasRecall = out.includes('【本次会话更早（已被压缩）的参考】');
  const recallPart = hasRecall ? out.split('【本次会话更早（已被压缩）的参考】')[1] : '';
  console.log(`\nQ: ${question.replace(/\s+/g, ' ').slice(0, 40)}`);
  console.log(`   总注入 ${out.length} 字符；含召回块: ${hasRecall}`);
  const lines = (recallPart ?? '').split('\n').filter((l) => l.startsWith('- '));
  console.log(`   召回条数 ${lines.length}；每条最长 ${Math.max(0, ...lines.map((l) => l.length - 2))} 字符（上限 300，已减去"- "项目符号）`);
}

console.log('\n不相关问题（用干净会话状态：召回块应当为空 → 0 额外 token）：');
for (const question of ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句']) {
  const s = cloneSession(question, seqCursor++);
  const out = injected(s);
  const hasRecall = out.includes('【本次会话更早（已被压缩）的参考】');
  console.log(`   Q: ${question} → 总注入 ${out.length} 字符，召回块 ${hasRecall ? '✗ 竟然注入了' : '✓ 空'}`);
}

/* 同一轮重复调用（工具循环多步）不应产生新文本 */
const repeatSession = sessionWithQuestion(relevantQuestions[2], seqCursor++);
const a = injected(repeatSession);
const b = injected(repeatSession);
console.log('同一步内重复调用文本一致（应为 true）:', a === b);

/* 打分日志 */
console.log('\n=== 打分日志（诊断文件）===');
const diagFile = path.join(home, 'dsh-super-memory.diag.jsonl');
if (fs.existsSync(diagFile)) {
  for (const line of fs.readFileSync(diagFile, 'utf8').split('\n').filter(Boolean).slice(-10)) {
    const entry = JSON.parse(line);
    if (entry.event === 'recall') {
      console.log(`  hit=${entry.hit} reason=${entry.reason} top=${entry.topScore} second=${entry.secondScore} chars=${entry.injectedChars} est=${entry.injectedTokensEst} Q=${entry.queryHead.slice(0, 30)}`);
    } else {
      console.log(`  [${entry.event}]`, JSON.stringify(entry).slice(0, 140));
    }
  }
} else {
  console.log('  （没有诊断文件）');
}

/* ── ③b 回归：inbox 事件一到就召回（DSH 求值上下文比 user/message 落库早 3.4 秒）── */
console.log('\n=== ③b 回归：inbox 即召回 + 一轮内文本稳定 + 未命中不回退 ===');
{
  // 用一份干净的会话状态 + 复制来的记忆库，排除冷却/去重干扰
  const lagId = `session-lag-${process.pid}`;
  fs.copyFileSync(path.join(root, `${sessionId}.jsonl`), path.join(root, `${lagId}.jsonl`));
  // 模拟"刚压缩完"的投影：快照里一条真实用户消息都没有（历史已被压掉，提问还没落库）
  const lagBase = events.filter((e) => e.type !== 'user/message');
  const lagSession = {
    id: lagId,
    header: { cwd: workdir },
    snapshotEvents: () => lagBase,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const inboxEvent = (seq, text) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: Date.now(),
    data: {
      target: 'next-turn',
      start: 0,
      inserted: [{
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: 'harness' },
        role: 'user',
        id: `inbox-${seq}`,
      }],
    },
  });
  const userEvent = (seq, text) => ({
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: `q-${seq}`,
    },
  });
  const lagQuestion = relevantQuestions[2];

  const before = injected(lagSession);
  console.log('投影里没有任何用户消息 → 含召回块（应为 false）:', before.includes('已被压缩）的参考'));
  console.log('此时仍有压缩后总览（应为 true）:', before.includes('本会话此前脉络'));

  const inboxSeq = seqCursor++;
  emit(lagSession, inboxEvent(inboxSeq, lagQuestion));
  const afterInbox = injected(lagSession);
  console.log('inbox 事件刚到、提问尚未落库 → 含召回块（应为 true）:', afterInbox.includes('已被压缩）的参考'));
  console.log(`注入文本增量 ${afterInbox.length - before.length} 字符（召回块本身）`);

  emit(lagSession, userEvent(inboxSeq + 2, lagQuestion));
  const afterCommit = injected(lagSession);
  console.log('同一条提问随后落库 → 文本逐字不变（应为 true，否则要白重发一份快照）:', afterCommit === afterInbox);

  for (const q of ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句']) {
    emit(lagSession, userEvent(seqCursor++, q));
  }
  const afterMiss = injected(lagSession);
  console.log('随后连问两个不相关问题 → 参考块仍挂着（stickyRecall 默认开，应为 true）:', afterMiss.includes('已被压缩）的参考'));
  console.log('且文本仍逐字不变（未命中没有追加任何快照，应为 true）:', afterMiss === afterInbox);
}

/* ── 面板 API（设置走 route，与真实面板同一条路径） ─────────────────────── */
const route = ctx._routes[0];
async function call(method, url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = {
    method,
    url,
    // 与真实面板一致：写操作必须带这个自定义头（宿主用它挡跨站伪造请求）
    headers: { 'content-type': 'application/json', 'x-dsh-super-memory': '1', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  return new Promise((resolve) => {
    const res = {
      status: 0, body: '',
      writeHead(status) { this.status = status; },
      end(text) { this.body = text; resolve({ status: this.status, body: JSON.parse(text) }); },
    };
    route.handler(req, res);
  });
}
const put = (patch) => call('PUT', '/api/dsh-super-memory/settings', patch);

console.log('\n=== ④b 写操作来源校验（防跨站伪造）===');
const noHeader = await call('POST', '/api/dsh-super-memory/trash/purge', { confirm: true }, { 'x-dsh-super-memory': '' });
console.log(`  不带来源标记的 POST → HTTP ${noHeader.status} ${noHeader.body?.error?.code ?? ''}（应为 403 forbidden）`);
const wrongType = await call('POST', '/api/dsh-super-memory/trash/purge', { confirm: true }, { 'content-type': 'text/plain' });
console.log(`  非 JSON content-type 的 POST → HTTP ${wrongType.status} ${wrongType.body?.error?.code ?? ''}（应为 403 forbidden）`);
const withHeader = await call('GET', '/api/dsh-super-memory/settings');
console.log(`  带头部的 GET 正常 → HTTP ${withHeader.status}（应为 200）`);

console.log('\n=== ④ 设置开关即时生效（经面板 API，每次用一份干净的会话状态）===');
const askSession = () => cloneSession(relevantQuestions[2], seqCursor++);
const probe = async (label) => {
  const value = injected(askSession());
  console.log(`   ${label}: ${value.length} 字符  ${value.includes('【本次会话更早（已被压缩）的参考】') ? '(含召回)' : '(无召回)'}`);
};
await probe('默认（两个注入开关都开）');
await put({ injectRecall: false });
await probe('关掉「提问时注入记忆」');
await put({ injectRecap: false });
await probe('两个都关（应为 0）');
await put({ injectRecap: true, injectRecall: true });
await probe('重新打开');
await put({ compactionRecapMaxTokens: 0 });
await probe('总览上限调 0');
await put({ compactionRecapMaxTokens: 300, maxTokensPerTurn: 0 });
await probe('单轮上限调 0');
await put({ maxTokensPerTurn: 500, sessionBudgetRatio: 0 });
await probe('会话累计上限调 0（应为 0）');
await put({ sessionBudgetRatio: 0.02 });

console.log('\n=== 成本上限在注入文本上的实际效果（走 /search）===');
const capProbe = async (label, patch) => {
  if (patch) await put(patch);
  const result = await call('GET', `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workdir)}&session=${sessionId}&query=${encodeURIComponent(relevantQuestions[2])}`);
  const built = result.body.value.wouldInject;
  console.log(`   ${label}: ${built.text.length} 字符 / ${built.tokens} token / ${built.items} 条`);
};
await capProbe('默认（2 条 / 300 字符 / 500 token）');
await capProbe('每条 80 字符', { maxCharsPerItem: 80 });
await capProbe('单轮 120 token', { maxTokensPerTurn: 120 });
await put({ maxCharsPerItem: 300, maxItems: 2, maxTokensPerTurn: 500 });

console.log('\n=== 面板 API ===');
const settingsGet = await call('GET', '/api/dsh-super-memory/settings');
console.log('GET /settings →', settingsGet.status, settingsGet.body.ok, '默认 minScore =', settingsGet.body.value.settings.minScore);
const overview = await call('GET', '/api/dsh-super-memory/overview');
const workspace = overview.body.value.workspaces[0];
console.log('GET /overview →', overview.status, `工作区 ${overview.body.value.workspaces.length} 个；首个 ${workspace?.workspace}`);
console.log('   会话:', (workspace?.sessions ?? []).slice(0, 3).map((s) => `${s.sessionId.slice(0, 18)}(${s.blocks}条/${s.bytes}B/保护=${s.protected})`).join(', '), `…共 ${workspace?.sessions?.length ?? 0} 个`);
console.log('   库占用', workspace?.libraryBytes, 'B；回收站', workspace?.trashBytes, 'B');
const search = await call('GET', `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workdir)}&session=${sessionId}&query=${encodeURIComponent(relevantQuestions[2] ?? '测试')}`);
console.log('GET /search →', search.status, 'tier=', search.body.value.tier, 'top=', search.body.value.topScore?.toFixed(3), 'recap行数=', search.body.value.recap.lines);
const blockList = await call('GET', `/api/dsh-super-memory/session?workspace=${encodeURIComponent(workdir)}&session=${sessionId}`);
console.log('GET /session →', blockList.status, blockList.body.value.blocks.length, '条；首条:', JSON.stringify(blockList.body.value.blocks[0]?.title));
const del1 = await call('POST', '/api/dsh-super-memory/delete', { workspace: workdir, session: sessionId, confirm: true });
console.log('POST /delete（今天更新过，保护期 7 天）→', del1.status, del1.body.error?.code ?? '', del1.body.error?.message ?? '');
const noConfirm = await call('POST', '/api/dsh-super-memory/delete', { workspace: workdir, session: sessionId });
console.log('POST /delete（不带 confirm）→', noConfirm.status, noConfirm.body.error?.code ?? '');
const delSingle = await call('POST', '/api/dsh-super-memory/delete', { workspace: workdir, session: sessionId, fps: [blockList.body.value.blocks[0].fp], confirm: true });
console.log('POST /delete（删单条）→', delSingle.status, JSON.stringify(delSingle.body.value ?? delSingle.body.error));
await call('POST', '/api/dsh-super-memory/trash/restore', { workspace: workdir, id: delSingle.body.value?.trashId });
const afterSingle = await call('GET', `/api/dsh-super-memory/session?workspace=${encodeURIComponent(workdir)}&session=${sessionId}`);
console.log('单条还原后条数:', afterSingle.body.value.blocks.length);
await put({ protectRecentDays: 0 });
const del2 = await call('POST', '/api/dsh-super-memory/delete', { workspace: workdir, session: sessionId, confirm: true });
console.log('POST /delete（保护期 0）→', del2.status, JSON.stringify(del2.body.value ?? del2.body.error));
const trash = await call('GET', `/api/dsh-super-memory/trash?workspace=${encodeURIComponent(workdir)}`);
console.log('GET /trash →', trash.status, trash.body.value.entries.length, '项', trash.body.value.entries[0] && `${trash.body.value.entries[0].blocks} 条 / ${trash.body.value.entries[0].bytes}B`);
const trashId = trash.body.value.entries[0]?.id;
if (trashId) {
  const restore = await call('POST', '/api/dsh-super-memory/trash/restore', { workspace: workdir, id: trashId });
  console.log('POST /trash/restore →', restore.status, JSON.stringify(restore.body.value));
  const after = await call('GET', '/api/dsh-super-memory/overview');
  console.log('还原后库占用:', after.body.value.workspaces[0]?.libraryBytes, 'B；块数:', after.body.value.workspaces[0]?.sessions?.find((s) => s.sessionId === sessionId)?.blocks);
}
const purge = await call('POST', '/api/dsh-super-memory/trash/purge', { workspace: workdir, confirm: true });
console.log('POST /trash/purge →', purge.status, JSON.stringify(purge.body.value));
const noConfirmPurge = await call('POST', '/api/dsh-super-memory/trash/purge', { workspace: workdir });
console.log('POST /trash/purge（不带 confirm）→', noConfirmPurge.status, noConfirmPurge.body.error?.code ?? '');
const audit = await call('GET', `/api/dsh-super-memory/audit?workspace=${encodeURIComponent(workdir)}`);
console.log('GET /audit →', audit.status, audit.body.value.entries.map((e) => e.action).join(', '));
const outside = await call('POST', '/api/dsh-super-memory/delete', { workspace: 'C:\\Windows', session: 'x', confirm: true });
console.log('越界工作区 delete →', outside.status, outside.body.error?.code ?? '');

console.log('\n=== ⑤ history_read（只在用户明确要求查原文时用）===');
const tool = ctx._tools.get('history_read');
const toolSession = sessionWithQuestion('（占位）', seqCursor++);
const readStore = await tool.execute({ sessionId, query: relevantQuestions[2], limit: 2, source: 'store' }, { agent: { session: toolSession } });
console.log('store 模式 →', readStore.found, readStore.chars, '字符');
console.log('   ' + readStore.text.split('\n').slice(0, 4).join('\n   ').slice(0, 240));
console.log('   含思考/工具噪声:', /"type":"reasoning"|tool-call/.test(readStore.text));
const readLog = await tool.execute({ sessionId, query: relevantQuestions[2], limit: 2, source: 'log' }, { agent: { session: toolSession } });
console.log('log 模式（本测试的 DSH_HOME 是临时目录，预期查不到）→', readLog.found, readLog.chars, '字符');

console.log('\n原始会话日志是否被动过（只做 stat，不会写）:', fs.existsSync(logPath) ? `仍在，${fs.statSync(logPath).size} bytes` : '不见了');
console.log('DSH_HOME（测试用）:', home);

/* ── ⑥ 验收补充：入库开关 / 工作区隔离 / 回收站自动清理 ─────────────────── */
const { readRecords } = await import('../lib/store.js');
console.log('\n=== ⑥ 验收补充（对应交接报告 §6 的 18 / 16 / 21）===');

// 18) 关掉 L2 入库 → 投递压缩事件不新增 layer:"raw"；重新打开 → 新增（用**空库**，
//     否则指纹去重会把"开关生效"和"内容已存在"混在一起）
{
  const probeId = `session-ingest-probe-${process.pid}`;
  const probe = {
    id: probeId,
    header: { cwd: workdir },
    snapshotEvents: () => events,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const rawCount = () => readRecords(root, probeId).filter((r) => r.layer === 'raw').length;
  const summaryCount = () => readRecords(root, probeId).filter((r) => r.layer === 'summary').length;
  const source = compactions[0];
  await put({ ingestRawText: false });
  emit(probe, { ...source, data: { ...source.data, compactionId: 'probe-ingest-no-l2' } });
  console.log(`关掉「全文入库 L2」后投递压缩事件 → raw 条目（应为 0）: ${rawCount()}；summary 条目（应 > 0，证明 L1 照旧）: ${summaryCount()}`);
  await put({ ingestRawText: true });
  emit(probe, { ...source, data: { ...source.data, compactionId: 'probe-ingest-yes-l2' } });
  console.log(`重新打开 L2 后再投递 → 新增 raw 条目（应 > 0）: ${rawCount()}`);
}

// 16) 工作区隔离：库文件与派生状态都按工作区分开
//     注意：同一个会话 id 出现在另一个工作区时，插件会按设计把**本会话已有的压缩**
//     回填到那个工作区的库里（backfillOnStart），所以"B 工作区也有内容"是正确行为；
//     要验的是"库是两个文件、状态是两份、无关会话读不到别人的内容"。
{
  const otherWorkdir = path.join(os.tmpdir(), `dsm-harness-other-${process.pid}`);
  fs.mkdirSync(otherWorkdir, { recursive: true });
  const otherRoot = path.join(otherWorkdir, '.dsh-compaction-memory');
  const foreign = {
    id: sessionId, // 故意用同一个会话 id
    header: { cwd: otherWorkdir },
    snapshotEvents: () => events,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  injected(foreign);
  const fileA = path.join(root, `${sessionId}.jsonl`);
  const fileB = path.join(otherRoot, `${sessionId}.jsonl`);
  console.log('A / B 两个工作区各有自己的库文件（应为 true）:', fs.existsSync(fileA) && fs.existsSync(fileB) && fileA !== fileB);

  const diag = await call('GET', '/api/dsh-super-memory/diagnostics');
  const mine = (diag.body.value.runtime ?? []).filter((row) => row.sessionId === sessionId);
  console.log(`同一会话 id 在两个工作区 → 诊断里有 ${mine.length} 条独立状态（应为 2），root 互不相同:`, new Set(mine.map((r) => r.root)).size === mine.length);

  const clean = {
    id: `session-clean-${process.pid}`,
    header: { cwd: otherWorkdir },
    snapshotEvents: () => [],
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const out = injected(clean);
  console.log('B 工作区里一个全新会话 → 无召回也无总览（应为 true）:', out === '' || (!out.includes('已被压缩）的参考') && !out.includes('本会话此前脉络')));
}

// 21) 回收站按天数自动清理：把条目的 deletedAt 改老，再把保留天数设成 1（改设置会触发一次清理）
{
  const probeId = `session-trash-probe-${process.pid}`;
  fs.copyFileSync(path.join(root, `${sessionId}.jsonl`), path.join(root, `${probeId}.jsonl`));
  await put({ protectRecentDays: 0 });
  const removed = await call('POST', '/api/dsh-super-memory/delete', { workspace: workdir, session: probeId, confirm: true });
  const trashDir = path.join(root, '_trash');
  const entry = fs.readdirSync(trashDir).find((name) => name.endsWith(probeId));
  const manifestPath = path.join(trashDir, entry, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.deletedAt = new Date(Date.now() - 3 * 86400000).toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`删除进回收站 → ${removed.status}；把该条目时间改成 3 天前`);
  await put({ trashAutoPurgeDays: 1 }); // 触发一次 sweepTrash
  const afterPurge = await call('GET', `/api/dsh-super-memory/trash?workspace=${encodeURIComponent(workdir)}`);
  const stillThere = afterPurge.body.value.entries.some((item) => item.id === entry);
  console.log(`保留 1 天后自动清理 → 该条目还在吗（应为 false）: ${stillThere}`);
  await put({ trashAutoPurgeDays: 7 });
}

/* ── 22) 模型辅助失败矩阵（方案 §10）：四种情形下插件都必须照常工作 ────────
 * 已核实的官方实现细节：`session/event` 监听器是**观测者**，DSH 不 await 返回值
 * （只挂 .catch 记日志），所以入库里 await 模型调用不会阻塞宿主。 */
{
  const modelSessionId = `session-llm-${process.pid}`;
  const source = compactions[0];
  const modelSession = {
    id: modelSessionId,
    header: { cwd: workdir },
    snapshotEvents: () => events,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const countBlocks = () => readRecords(root, modelSessionId).length;
  const keywordsOf = () => readRecords(root, modelSessionId).flatMap((r) => r.keywords ?? []);
  const emitFor = (id) => emit(modelSession, { ...source, data: { ...source.data, compactionId: id } });
  const settle = () => new Promise((r) => setTimeout(r, 80));

  await put({
    llmAssistEnabled: true, llmIngestExpand: true,
    llmIngestProvider: 'fake-provider', llmIngestModel: 'fake-model',
    llmIngestTimeoutMs: 3000, llmIngestBatchBlocks: 5, llmDailyCallCap: 50,
  });

  behavior.mode = 'ok';
  const before = countBlocks();
  emitFor('llm-ok');
  await settle();
  await settle();
  const afterOk = countBlocks();
  const words = keywordsOf().map(String);
  console.log(`模型正常 → 新增块 ${afterOk - before} 条（应 > 0）；关键词出现模型生成的词（应为 true）: ${words.some((k) => k.includes('跨压缩记忆') || k.includes('注入成本'))}`);

  behavior.mode = 'garbage';
  emitFor('llm-garbage');
  await settle();
  console.log(`模型返回垃圾 → 库里有块（应为 true）: ${countBlocks() > 0}；未写入坏词（应为 true）: ${!keywordsOf().map(String).some((k) => k.includes('抱歉'))}`);

  behavior.mode = 'no-adapter';
  emitFor('llm-no-adapter');
  await settle();
  console.log(`提供方未注册（NO_ADAPTER）→ 库里有块、插件不崩（应为 true）: ${countBlocks() > 0}`);

  behavior.mode = 'hang';
  await put({ llmIngestTimeoutMs: 1 });
  emitFor('llm-timeout');
  await new Promise((r) => setTimeout(r, 200));
  console.log(`模型不回应 + 超时 1ms → 插件照常工作（应为 true）: ${countBlocks() > 0}`);

  await put({ llmAssistEnabled: false, llmIngestTimeoutMs: 3000 });
  const callsBefore = behavior.calls;
  emitFor('llm-off');
  await settle();
  console.log(`总开关关掉 → 模型调用次数增量（应为 0）: ${behavior.calls - callsBefore}`);

  // 面板接口：诊断（含改写）与配对记账
  const diag = await call('POST', '/api/dsh-super-memory/diagnose', { workspace: workdir, session: modelSessionId, query: '跨压缩记忆怎么装', limit: 5 });
  const diagValue = diag.body?.value ?? {};
  console.log(`/diagnose → ${diag.status}；判定=${diagValue.verdict}；候选 ${(diagValue.candidates ?? []).length} 条（应 > 0）；含改写字段=${diagValue.assist !== undefined}`);
  const pair = await call('POST', '/api/dsh-super-memory/pair', { workspace: workdir, session: modelSessionId, query: '跨压缩记忆怎么装', fp: (diagValue.candidates ?? [])[0]?.fp ?? '', verdict: 'hit', score: 0.9, title: 't' });
  const pairsFile = path.join(root, '_pairs.jsonl');
  console.log(`/pair → ${pair.status}；_pairs.jsonl 已写入（应为 true）: ${fs.existsSync(pairsFile) && fs.readFileSync(pairsFile, 'utf8').includes('"verdict":"hit"')}`);
  const searchAfter = await call('POST', '/api/dsh-super-memory/diagnose', { workspace: workdir, session: modelSessionId, query: '注入成本上限', limit: 3 });
  console.log(`配对记录不参与检索（应 true，_pairs 不是记忆块）: ${(searchAfter.body?.value?.candidates ?? []).every((c) => c.fp !== '_pairs')}`);
}
