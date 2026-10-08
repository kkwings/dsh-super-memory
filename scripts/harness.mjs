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
const { RECALL_HEAD_PREFIX } = await import('../lib/recall.js');

/**
 * 假模型服务：由测试用例在 `apply()` **之前**设置，用来跑失败矩阵。
 * 始终存在（DSH 里 llm 一定在），靠 `behavior.mode` 切换返回内容；
 * "完全没有 llm 服务"那种机器由 `UNAVAILABLE` 闸门覆盖（见 unit.mjs）。
 */
const behavior = { mode: 'off', calls: 0, rewriteCalls: 0 };

/**
 * 「投影里有没有召回块」的判据串（来自 `lib/recall.js` 的 `RECALL_HEAD_PREFIX`）。
 *
 * 2026-10-08：召回头部**删掉了** `【本次会话更早（已被压缩）的参考】` 这半句
 * （作用已被"以下内容来自本会话早前（已被压缩）的部分"覆盖，省 ≈22 字符/轮），
 * 所以探针改用召回块首行的前 12 个字符。
 * ⚠️ 别换成头部里那句安全声明：boost 头也带同一句，探针会把 boost 误判成召回
 * （实测踩过：两条"不相关问题"探针因此报"✗ 竟然注入了"）。
 */
const RECALL_HEAD_MARK = RECALL_HEAD_PREFIX;

const fakeLlm = {
  async listProviders() { return [{ provider: 'fake-provider', model: 'fake-model' }]; },
  async *stream(input) {
    behavior.calls += 1;
    behavior.lastInput = input;
    // 查询改写走的是同一条 stream 通道，但**期望的输出形状不同**（JSON 数组 vs JSON 对象）：
    // 按系统提示词区分开，才能分别测"改写被调用/被跳过"（见 ㉓）。
    const isRewrite = typeof input.system === 'string' && input.system.includes('改写成');
    if (isRewrite) behavior.rewriteCalls += 1;
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
    if (isRewrite) {
      // 改写要求严格 JSON 数组；给几个与库内容无关的词，便于观察"改写路径确实跑了"
      yield { type: 'text-delta', index: 0, text: '["跨压缩记忆", "注入成本", "改写"]' };
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
  const hasRecall = out.includes(RECALL_HEAD_MARK);
  const recallPart = hasRecall ? out.split(RECALL_HEAD_MARK)[1] : '';
  console.log(`\nQ: ${question.replace(/\s+/g, ' ').slice(0, 40)}`);
  console.log(`   总注入 ${out.length} 字符；含召回块: ${hasRecall}`);
  const lines = (recallPart ?? '').split('\n').filter((l) => l.startsWith('- '));
  console.log(`   召回条数 ${lines.length}；每条最长 ${Math.max(0, ...lines.map((l) => l.length - 2))} 字符（上限 300，已减去"- "项目符号）`);
}

console.log('\n不相关问题（用干净会话状态：召回块应当为空 → 0 额外 token）：');
for (const question of ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句']) {
  const s = cloneSession(question, seqCursor++);
  const out = injected(s);
  const hasRecall = out.includes(RECALL_HEAD_MARK);
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
  console.log('投影里没有任何用户消息 → 含召回块（应为 false）:', before.includes(RECALL_HEAD_MARK));
  console.log('此时仍有压缩后总览（应为 true）:', before.includes('本会话此前脉络'));

  const inboxSeq = seqCursor++;
  emit(lagSession, inboxEvent(inboxSeq, lagQuestion));
  const afterInbox = injected(lagSession);
  console.log('inbox 事件刚到、提问尚未落库 → 含召回块（应为 true）:', afterInbox.includes(RECALL_HEAD_MARK));
  console.log(`注入文本增量 ${afterInbox.length - before.length} 字符（召回块本身）`);

  emit(lagSession, userEvent(inboxSeq + 2, lagQuestion));
  const afterCommit = injected(lagSession);
  console.log('同一条提问随后落库 → 文本逐字不变（应为 true，否则要白重发一份快照）:', afterCommit === afterInbox);

  for (const q of ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句']) {
    emit(lagSession, userEvent(seqCursor++, q));
  }
  const afterMiss = injected(lagSession);
  console.log('随后连问两个不相关问题 → 参考块仍挂着（stickyRecall 默认开，应为 true）:', afterMiss.includes(RECALL_HEAD_MARK));
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
  console.log(`   ${label}: ${value.length} 字符  ${value.includes(RECALL_HEAD_MARK) ? '(含召回)' : '(无召回)'}`);
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
// 恢复成**当前默认值**（700，2026-10-08 从 500 提上来：中文下"2 条 × 300 字符 + HEADER"
// 装不进 500，预算循环会先 pop() 掉第二条 → "≤2 条"从来没生效过）。
await put({ maxTokensPerTurn: 700 });
// 「会话累计上限」(sessionBudgetRatio) 已按用户决定删除：不再有"累计用尽就停止注入"
// 这条路，注入量只受**单次**口径约束（上面三条探针就是全部闸门）。

console.log('\n=== 成本上限在注入文本上的实际效果（走 /search）===');
const capProbe = async (label, patch) => {
  if (patch) await put(patch);
  const result = await call('GET', `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workdir)}&session=${sessionId}&query=${encodeURIComponent(relevantQuestions[2])}`);
  const built = result.body.value.wouldInject;
  console.log(`   ${label}: ${built.text.length} 字符 / ${built.tokens} token / ${built.items} 条`);
};
await capProbe('默认（2 条 / 300 字符 / 700 token）');
await capProbe('每条 80 字符', { maxCharsPerItem: 80 });
await capProbe('单轮 120 token', { maxTokensPerTurn: 120 });
await put({ maxCharsPerItem: 300, maxItems: 2, maxTokensPerTurn: 700 });

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

/* ── ④c 工作区自动识别：插件刚重启、body.workspace 为空时从**会话日志**读 cwd ──
 *
 * 用户实测场景：重启 DSH 后点 ✕ 报"未知工作区（先随便发一条消息）" —— 因为进程内
 * 还没有任何会话状态，面板拿不到工作区。修法是宿主自己从会话日志读 cwd 并登记为已知工作区。
 * 这里造两份真实布局的日志：
 *   A) 首行是 v4 会话头、带顶层 cwd   → 必须解析成功（不再 403）
 *   B) 首行没有 cwd（旧格式/缺字段） → 必须仍然 403，且提示要说清"日志里读不到 cwd"
 * 另外钉死安全边界：兜底值**只能**来自会话日志，请求体里的任意路径绝不能被采信。 */
{
  let smokePassed = 0;
  let smokeFailed = 0;
  const expect = (label, condition, detail = '') => {
    if (condition) { smokePassed += 1; console.log(`  ✓ ${label}`); return; }
    smokeFailed += 1; process.exitCode = 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  };
  console.log('\n=== ④c 工作区自动识别（重启后点 ✕ 不再因"未知工作区"失败）===');

  const sessionsRoot = path.join(home, 'sessions');
  // **必须用一个本次进程从没见过的目录当 cwd**：否则 workdir 早就在 knownWorkspaces 里，
  // "解析成功"什么都证明不了（实测踩过：最初用 workdir 当 cwd，把"不登记 cwd"的旧行为
  // 注入回去之后这些断言照样全绿 —— 等于白测）。
  const probeWorkspace = path.join(os.tmpdir(), `dsm-probe-workspace-${process.pid}-${Date.now()}`);
  const makeLog = (id, header) => {
    const dir = path.join(sessionsRoot, '--probe--', id);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify(header),
      JSON.stringify({
        type: 'user/message', seq: 1, time: Date.now(),
        data: { content: [{ type: 'text', text: '跨压缩记忆怎么装' }], source: { kind: 'user' } },
      }),
    ];
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines.join('\n')}\n`, 'utf8');
    return id;
  };
  const withCwd = makeLog(`session-restart-probe-${process.pid}`, {
    type: 'session', version: 4, id: `session-restart-probe-${process.pid}`, createdAt: Date.now(), cwd: probeWorkspace,
  });
  const withoutCwd = makeLog(`session-no-cwd-probe-${process.pid}`, {
    type: 'session', version: 3, id: `session-no-cwd-probe-${process.pid}`, createdAt: Date.now(),
  });
  console.log(`  造了两份日志：${withCwd}（cwd=${probeWorkspace}）/ ${withoutCwd}（无 cwd）`);

  // ⓪ 基线：这个 cwd 现在**确实未知** —— 不先证明这一点，后面"解析成功"就是空测
  const baseline = await call('GET', `/api/dsh-super-memory/trash?workspace=${encodeURIComponent(probeWorkspace)}`);
  expect('基线：该 cwd 在本次进程里确实是未知工作区', baseline.status === 403, `实际 HTTP ${baseline.status}`);

  // ① 带 cwd + workspace 为空 → 必须成功
  const diagnose = await call('POST', '/api/dsh-super-memory/diagnose', { workspace: '', session: withCwd, query: '跨压缩记忆怎么装', limit: 3 });
  expect('workspace 为空但日志里有 cwd → /diagnose 不再 403', diagnose.status === 200, `实际 HTTP ${diagnose.status} ${diagnose.body?.error?.message ?? ''}`);

  // ② 记忆目录必须落在**正确的工作区**下（不是别的目录、更不是请求体里的路径）
  const trashRoute = await call('GET', `/api/dsh-super-memory/trash?session=${encodeURIComponent(withCwd)}`);
  const expectedRoot = path.join(probeWorkspace, '.dsh-compaction-memory');
  expect('兜底解析出的工作区 = 会话日志里的 cwd', trashRoute.body?.value?.workspace === probeWorkspace, `实际=${trashRoute.body?.value?.workspace}`);
  expect('记忆目录落在该工作区下', trashRoute.body?.value?.root === expectedRoot, `实际=${trashRoute.body?.value?.root}`);

  // ③ 一致性：同一条兜底口径对其它需要 workspace 的路由也生效
  const sessionRoute = await call('GET', `/api/dsh-super-memory/session?session=${encodeURIComponent(withCwd)}`);
  expect('同一条兜底口径对 /session 也生效', sessionRoute.status === 200 && sessionRoute.body?.value?.workspace === probeWorkspace, `实际 HTTP ${sessionRoute.status}`);

  // ④ 安全边界：请求体里塞一个未知路径，解析结果必须仍是**会话日志里的 cwd**
  const spoofed = await call('GET', `/api/dsh-super-memory/trash?workspace=${encodeURIComponent('C:\\Windows')}&session=${encodeURIComponent(withCwd)}`);
  expect('请求体里的任意路径不被采信（仍解析到会话 cwd）', spoofed.status === 200 && spoofed.body?.value?.workspace === probeWorkspace, `实际 HTTP ${spoofed.status} / ${spoofed.body?.value?.workspace}`);

  // ⑤ 日志里也读不到 cwd → 仍然 403，且提示要明确
  const noCwd = await call('POST', '/api/dsh-super-memory/diagnose', { workspace: '', session: withoutCwd, query: '跨压缩记忆怎么装', limit: 3 });
  expect('日志里读不到 cwd → 仍然 403', noCwd.status === 403, `实际 HTTP ${noCwd.status}`);
  expect('403 的提示说清了原因（读不到 cwd）', String(noCwd.body?.error?.message ?? '').includes('cwd'), `实际=${noCwd.body?.error?.message ?? ''}`);
  const noSession = await call('POST', '/api/dsh-super-memory/diagnose', { workspace: '', query: '跨压缩记忆怎么装', limit: 3 });
  expect('连 session 都没有 → 仍然 403（不猜工作区）', noSession.status === 403, `实际 HTTP ${noSession.status}`);

  // ⑥ 登记范围与既有机制一致：登记过的 cwd 立刻出现在 /overview 的工作区清单里
  const overviewAfter = await call('GET', '/api/dsh-super-memory/overview');
  expect('/overview 的工作区清单里出现了这个 cwd（与会话内登记同一条路）',
    (overviewAfter.body?.value?.workspaces ?? []).some((item) => item.workspace === probeWorkspace),
    `实际=${(overviewAfter.body?.value?.workspaces ?? []).map((item) => item.workspace).join(' | ')}`);

  console.log(`  工作区自动识别：通过 ${smokePassed} 条，失败 ${smokeFailed} 条。`);
  const workspaceChecks = smokePassed;

  /* ── ④d 思考强度：插件不指定、也不继承 ─────────────────────────────────
   * 用户决定（2026-10-07）：插件不再有"思考强度"这个概念，设置键 `llmReasoningEffort` 已删除，
   * 要调就去 DSH 官方「设置 → 模型」页调。而主对话的 `request/header.config.reasoningEffort`
   * 就明晃晃躺在会话事件里（实测本机每份日志都是 `"reasoningEffort":"max"`），
   * 历史上正是这里误继承过 → 辅助调用又慢又贵。所以下面**必须**用"路线来自会话事件"的
   * 那条路径来验（不显式配 provider/model），否则测不到继承。 */
  console.log('\n=== ④d 思考强度：插件不指定、也不继承 ===');
  const inheritProbe = makeLog(`session-reasoning-probe-${process.pid}`, {
    type: 'session', version: 4, id: `session-reasoning-probe-${process.pid}`, createdAt: Date.now(), cwd: workdir,
  });
  // 往这份日志里补一条真实的 request/header（带主对话的 reasoningEffort: max）
  fs.appendFileSync(path.join(sessionsRoot, '--probe--', inheritProbe, 'session.jsonl'), `${JSON.stringify({
    type: 'request/header', seq: 2, time: Date.now(),
    data: { header: { config: { provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'max', maxTokens: 256000 } } },
  })}\n`, 'utf8');

  await put({ llmAssistEnabled: true, llmIngestProvider: '', llmIngestModel: '', llmIngestTimeoutMs: 3000 });
  behavior.mode = 'ok';
  behavior.lastInput = null;
  const inherited = await call('POST', '/api/dsh-super-memory/llm/test', { session: inheritProbe });
  expect('路线跟随会话事件时，测试连接仍走通', inherited.status === 200 && inherited.body?.value?.ok === true, `实际 HTTP ${inherited.status} ${JSON.stringify(inherited.body?.value ?? inherited.body?.error)}`);
  expect('主对话的 reasoningEffort=max 没有被继承', behavior.lastInput !== null && !('reasoningEffort' in behavior.lastInput), `实际键=${behavior.lastInput === null ? '(没调用)' : Object.keys(behavior.lastInput).join(',')}`);
  expect('整个调用参数里搜不到 reasoningEffort', behavior.lastInput !== null && !JSON.stringify(behavior.lastInput).includes('reasoningEffort'));
  expect('解析出的路线里也不带 reasoningEffort（连留痕都不留这个字段）', !JSON.stringify(inherited.body?.value?.route ?? {}).includes('reasoningEffort'), `实际 route=${JSON.stringify(inherited.body?.value?.route ?? null)}`);

  behavior.lastInput = null;
  await put({ llmIngestProvider: 'fake-provider', llmIngestModel: 'fake-model' });
  const explicit = await call('POST', '/api/dsh-super-memory/llm/test', { provider: 'fake-provider', model: 'fake-model', session: inheritProbe });
  expect('显式配了提供方/型号时也不传 reasoningEffort', explicit.status === 200 && behavior.lastInput !== null && !('reasoningEffort' in behavior.lastInput));
  await put({ llmAssistEnabled: false, llmIngestProvider: '', llmIngestModel: '' });
  console.log(`  ④ 段累计：通过 ${smokePassed} 条，失败 ${smokeFailed} 条（其中工作区自动识别 ${workspaceChecks} 条、思考强度 ${smokePassed - workspaceChecks} 条）。`);
}

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
  console.log('B 工作区里一个全新会话 → 无召回也无总览（应为 true）:', out === '' || (!out.includes(RECALL_HEAD_MARK) && !out.includes('本会话此前脉络')));
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

/* ── 23) 本地已强命中 → 跳过查询改写（D 项，2026-10-07）─────────────────────
 * 判据是"**改写调用的次数**"：宿主里那个门槛只要没生效，这个数就不可能是 0。
 * 反向用例（本地没有强命中）必须仍然调用一次 —— 否则就是"为省 token 降智"。
 * 事件 `rewrite-skipped` 的存在与否也一并验：用户要能在诊断日志里看到原因。
 * 这里的断言会**真的让进程退出码变 1**（不是只打印一行）——否则"能失败"就是空话。 */
{
  let d23Passed = 0;
  let d23Failed = 0;
  const expect = (label, condition, detail = '') => {
    if (condition) { d23Passed += 1; console.log(`  ✓ ${label}`); return; }
    d23Failed += 1; process.exitCode = 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  };
  console.log('\n=== ㉓ 本地已强命中 → 跳过查询改写 ===');
  const strongSessionId = `session-strong-${process.pid}`;
  const source = compactions[0];
  const strongSession = {
    id: strongSessionId,
    header: { cwd: workdir },
    snapshotEvents: () => events,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const strongDiagFile = path.join(home, 'dsh-super-memory.diag.jsonl');
  const readDiag = () => (fs.existsSync(strongDiagFile) ? fs.readFileSync(strongDiagFile, 'utf8').split('\n') : []).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  // 清掉今日用量：上一段（㉒）用 `llmDailyCallCap: 50` 打过一轮入库，额度已经用光，
  // 不清的话这里所有调用都会被 DAILY_CAP 挡掉（表现为"改写没被调用"的假红）。
  fs.rmSync(path.join(home, 'dsh-super-memory.llm-usage.json'), { force: true });

  await put({
    // ⚠️ 必须走 `llmMode`（面板的唯一入口）：只塞 llmAssistEnabled/llmIngestExpand
    // 会被 `applyLlmMode` 在 mode='off' 时重新压回 false —— 实测踩过，表现为
    // "扩写一次都没发生"，而不会报任何错。
    llmMode: 'custom', llmProvider: 'fake-provider', llmModel: 'fake-model',
    llmIngestExpand: false,
  });
  behavior.mode = 'ok';
  behavior.rewriteCalls = 0;
  emit(strongSession, { ...source, data: { ...source.data, compactionId: 'strong-hit' } });
  await new Promise((r) => setTimeout(r, 120));
  const blockCount = readRecords(root, strongSessionId).length;
  expect('这一批块已入库', blockCount > 0, `实际 ${blockCount} 块`);

  // 查询用的是这一批块自己的关键词（本地必然强命中）
  const beforeDiag = readDiag().length;
  behavior.rewriteCalls = 0;
  const strong = await call('POST', '/api/dsh-super-memory/diagnose', {
    workspace: workdir, session: strongSessionId, query: '跨压缩记忆怎么装', limit: 8, rewrite: true, boost: true,
  });
  const strongValue = strong.body?.value ?? {};
  const strongEvents = readDiag().slice(beforeDiag);
  const skippedEvent = strongEvents.find((entry) => entry.event === 'rewrite-skipped') ?? null;
  expect('本地强命中 → **一次改写调用都没有**', behavior.rewriteCalls === 0, `实际调用了 ${behavior.rewriteCalls} 次`);
  expect('回执里带 rewriteSkipped（面板要如实说"跳过了改写"）', strongValue.rewriteSkipped === true, `实际=${JSON.stringify(strongValue.rewriteSkipped)}`);
  expect('强命中路径仍然找到了内容', strongValue.found === true, `found=${JSON.stringify(strongValue.found)}`);
  expect('诊断日志写了 rewrite-skipped（用户能查到原因）', skippedEvent !== null, '没找到该事件');
  expect('rewrite-skipped 里带 reason=local-strong-hit', skippedEvent?.reason === 'local-strong-hit', `实际=${JSON.stringify(skippedEvent?.reason)}`);
  console.log(`    best=${skippedEvent?.best?.toFixed?.(3)} 分数线=${skippedEvent?.strong?.toFixed?.(3)} 候选=${skippedEvent?.candidates}`);

  // 反向：库里完全没有的查询 → 不该跳过（该花钱改写）
  behavior.mode = 'terms';
  behavior.rewriteCalls = 0;
  const beforeWeak = readDiag().length;
  const weak = await call('POST', '/api/dsh-super-memory/diagnose', {
    workspace: workdir, session: strongSessionId, query: '请用一首七言绝句描述量子纠缠与薛定谔方程', limit: 8, rewrite: true,
  });
  const weakEvents = readDiag().slice(beforeWeak);
  expect('本地无强命中 → 仍然调用一次改写（不降智）', behavior.rewriteCalls >= 1, `实际 ${behavior.rewriteCalls} 次`);
  expect('本地无强命中 → 不写 rewrite-skipped', !weakEvents.some((entry) => entry.event === 'rewrite-skipped'));
  expect('改写结果可用（严格 JSON 数组）', weak.body?.value?.assist?.rewrite?.ok === true, `实际=${JSON.stringify(weak.body?.value?.assist?.rewrite ?? null)}`);
  await put({ llmAssistEnabled: false, llmIngestExpand: false });
  console.log(`  ㉓ 段累计：通过 ${d23Passed} 条，失败 ${d23Failed} 条。`);
}

/* ── 25) 「✕」的 boost 与同轮召回去重（2026-10-08）──────────────────────────
 * ㉓ 最后那次 `/diagnose` 带了 `boost:true` —— 它已经把资料排进 strongSessionId 的
 * **下一轮**（`state.nextTurnBoost`，诊断里能看到 `boost-queued`）。本节就检查那一轮：
 *   · boost 要**逐字完整**注入（长度 = `boost-queued.injectedChars`，一个字都不能少）；
 *   · 同一轮召回里，凡是内容已经被 boost 覆盖的块必须丢掉（诊断字段 `boostDedupDropped`），
 *     绝不允许同一段历史被投喂两遍；**绝不反过来砍 boost**。
 * 能失败：把 `runRecall` 里传的 `boostText` 去掉 → `boostDedupDropped` 恒为 0、这段立刻红。 */
{
  let d25Passed = 0;
  let d25Failed = 0;
  const expect = (label, condition, detail = '') => {
    if (condition) { d25Passed += 1; console.log(`  ✓ ${label}`); return; }
    d25Failed += 1; process.exitCode = 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  };
  console.log('\n=== ㉕ ✕ 的 boost 与同轮召回不重复投喂 ===');
  const diagFile25 = path.join(home, 'dsh-super-memory.diag.jsonl');
  const readDiag25 = () => (fs.existsSync(diagFile25) ? fs.readFileSync(diagFile25, 'utf8').split('\n') : []).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const queued = [...readDiag25()].reverse().find((entry) => entry.event === 'boost-queued') ?? null;
  expect('㉓ 的 ✕ 确实排了 boost（前提）', queued !== null && queued.session === `session-strong-${process.pid}`,
    JSON.stringify(queued));

  const before25 = readDiag25().length;
  // 用与 ✕ 同一句话提问、并复用同一个会话 id（状态按"工作区 + 会话 id"取）：
  // 召回到的就是刚被 boost 找到的那批块（真实场景正是如此）。
  const boostedOut = injected(sessionWithQuestion('跨压缩记忆怎么装', seqCursor++, `session-strong-${process.pid}`));
  const events25 = readDiag25().slice(before25);
  const recallEvent = events25.find((entry) => entry.event === 'recall') ?? null;

  expect('注入文本里带上了 boost（用户点 ✕ 得到的那段）',
    boostedOut.includes('用户点了「✕」后由辅助模型找到'), `注入 ${boostedOut.length} 字符`);
  // boost 完整性：注入文本里 boost 那一段的字符数必须**逐字**等于排队时记下的长度
  // （含 `⟦mem-hist⟧` 标记 —— 它是 boost 文本的第一个字符序列）
  // 2026-10-08：boost 头与召回同步删掉了 `【本次会话更早（已被压缩）的参考 · …】` 那半句，
  // 只留来源说明（`lib/host.js` 的 `boostFor` 是唯一构造处，这里必须与它同形）。
  const boostHead = '⟦mem-hist⟧用户点了「✕」后由辅助模型找到';
  const boostBody = boostedOut.split(boostHead)[1] ?? '';
  expect('boost 逐字完整（字符数和 boost-queued 记下的完全一致）',
    queued !== null && boostBody !== '' && boostBody.length + boostHead.length === queued.injectedChars,
    `实际 ${boostBody === '' ? 0 : boostBody.length + boostHead.length} / 排队时 ${queued?.injectedChars}`);
  expect('召回诊断写出了 boostDedupDropped（本轮可观测字段）',
    recallEvent !== null && Number.isSafeInteger(recallEvent.boostDedupDropped), JSON.stringify(recallEvent));
  expect('与 boost 重叠的召回块被丢掉（boostDedupDropped ≥ 1）',
    recallEvent !== null && recallEvent.boostDedupDropped >= 1, `实际=${recallEvent?.boostDedupDropped}`);
  // 不重复投喂：boost 资料正文的那一段不该在召回里再出现一次
  const materialBody = (boostBody.split('\n\n')[1] ?? '').split('\n')[1] ?? '';
  const phrase = materialBody.slice(10, 60);
  const occurrences = phrase === '' ? 0 : boostedOut.split(phrase).length - 1;
  expect('boost 的正文没有被召回再投喂一遍（该片段只出现 1 次）', occurrences === 1,
    `出现 ${occurrences} 次；片段=${JSON.stringify(phrase.slice(0, 24))}…`);
  console.log(`   boost ${queued?.injectedChars} 字符（资料 ${queued?.chars}）· boostDedupDropped=${recallEvent?.boostDedupDropped} · reason=${recallEvent?.reason} · 召回注入 ${recallEvent?.injectedChars} 字符`);
  console.log(`  ㉕ 段累计：通过 ${d25Passed} 条，失败 ${d25Failed} 条。`);
}

/* ── 24) 工具结果块不参与关键词扩写（A 项，2026-10-07 的"最大的一刀"）──────
 * 端到端判据有两条，缺一不可：
 *   ① 模型生成的词**绝不出现在任何工具块**的 keywords 里；
 *   ② 同一次压缩里，对话/摘要块**照旧拿到**模型生成的词（不是"整个扩写都坏了"）。
 * 工具块的 keywords 来自 `extractKeywords(正文)`，不可能凭空出现行内没有的
 * "跨压缩记忆"这种词 —— 所以 ① 真的能红。 */
{
  let d24Passed = 0;
  let d24Failed = 0;
  const expect = (label, condition, detail = '') => {
    if (condition) { d24Passed += 1; console.log(`  ✓ ${label}`); return; }
    d24Failed += 1; process.exitCode = 1;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  };
  console.log('\n=== ㉔ 工具结果块不扩写（钱不花在工具结果上）===');
  const mixId = `session-mix-${process.pid}`;
  const toolText = `host.js 的完整源码片段：${'导出函数 apply(ctx) { 注册工具与上下文 }；'.repeat(40)}`;
  const mixNow = Date.now();
  // 事件形状照抄真实日志（tool/call 的 arguments 是 **JSON 字符串**，tool/result 的
  // 工具名要靠 callId 回到 tool/call 里找）—— 写错形状会让工具块根本不入库，
  // 那样"工具块里没有模型词"就变成一条永远为真的假绿。
  const toolEvents = [
    {
      type: 'user/message', seq: 41, time: mixNow,
      // 提问超过 120 字符（扩写候选的阈值）——短提问不会进候选名单，
      // 那样这条用例就测不到"非工具块照旧拿到模型词"。
      data: {
        content: [{ type: 'text', text: '读一下 host.js 里的扩写筛选逻辑，然后总结给我：我想确认工具结果块到底还会不会被送去扩写关键词，以及这一刀省下来的调用次数与输入字符数大概是多少。' }],
        source: { kind: 'user' }, role: 'user', id: 'q-mix-1',
      },
    },
    {
      type: 'assistant/message', seq: 42, time: mixNow,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，我先读文件。' }] } },
    },
    {
      type: 'tool/call', seq: 43, time: mixNow,
      data: { callId: 'c-tool-1', name: 'read', arguments: JSON.stringify({ file_path: 'E:\\w\\host.js' }) },
    },
    {
      type: 'tool/result', seq: 44, time: mixNow,
      data: { message: { role: 'tool', toolCallId: 'c-tool-1', source: { kind: 'tool', callId: 'c-tool-1' }, content: [{ type: 'text', text: toolText }] } },
    },
  ];
  const mixSession = {
    id: mixId,
    header: { cwd: workdir },
    snapshotEvents: () => toolEvents,
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const mixDiagFile = path.join(home, 'dsh-super-memory.diag.jsonl');
  const readMixDiag = () => (fs.existsSync(mixDiagFile) ? fs.readFileSync(mixDiagFile, 'utf8').split('\n') : []).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  // 同上：清掉今日用量，避免被上一段用光的额度挡住（DAILY_CAP 会让扩写一次都不发生）
  fs.rmSync(path.join(home, 'dsh-super-memory.llm-usage.json'), { force: true });

  await put({
    // 同上：走 llmMode，模式一开就是"入库扩写 + ✕ 改写"两个时机同时可用
    llmMode: 'custom', llmProvider: 'fake-provider', llmModel: 'fake-model',
    ingestSummary: true, ingestRawText: true,
    llmIngestBatchBlocks: 8, llmDailyCallCap: 0,
  });
  behavior.mode = 'ok';
  const beforeMixDiag = readMixDiag().length;
  const summaryText = '# 结论\n跨压缩记忆插件的关键词扩写只对对话块生效，工具结果块一律跳过。'
    + '这一段要足够长才会进入扩写候选名单（阈值 120 字符），所以这里再补几句说明：'
    + '工具结果靠文件名与标题就能检索到，给它生成"用户可能怎么问"纯属噪声，而且它的体量是对话正文的三倍多。';
  emit(mixSession, {
    type: 'compaction/summary',
    seq: 50,
    time: Date.now(),
    data: {
      compactionId: 'mix-expand',
      turn: 1,
      shadowedRange: { start: 41, end: 44 },
      shadowedTokenCount: 1234,
      summary: [{ type: 'text', text: summaryText }],
    },
  });
  await new Promise((r) => setTimeout(r, 150));
  const mixRecords = readRecords(root, mixId);
  const toolBlocks = mixRecords.filter((record) => record.src === 'tool');
  const nonToolBlocks = mixRecords.filter((record) => record.src !== 'tool');
  const modelWords = (record) => (record.keywords ?? []).map(String).filter((word) => word.includes('跨压缩记忆'));
  const expandEvents = readMixDiag().slice(beforeMixDiag).filter((entry) => entry.event === 'llm-expand');
  const lastExpand = expandEvents[expandEvents.length - 1] ?? null;
  // 每次压缩的**真实候选口径**（宿主自己算的）：非工具 且 ≥120 字符。
  // 这个数必须等于"非工具块里够长的那些"——把工具块算进去它就会变大（回归可测）。
  const expectedTargets = nonToolBlocks.filter((record) => record.text.length >= 120).length;

  expect('工具结果确实入库了（入库行为不变）', toolBlocks.length > 0, `实际 ${toolBlocks.length} 块`);
  expect('工具块里没有模型生成的词', toolBlocks.every((record) => modelWords(record).length === 0),
    `命中 ${toolBlocks.flatMap(modelWords).join(',')}`);
  expect('同一次压缩里的对话/摘要块拿到了模型生成的词（扩写整体没坏）',
    nonToolBlocks.some((record) => modelWords(record).length > 0),
    `非工具块 ${nonToolBlocks.length} 块，都没拿到`);
  expect('llm-expand 的候选数=非工具且够长的块数（工具块不在里面）',
    lastExpand !== null && lastExpand.candidates === expectedTargets,
    `candidates=${lastExpand?.candidates} 期望=${expectedTargets}（工具块 ${toolBlocks.length} 块）`);
  expect('llm-expand 诊断记下了被跳过的工具块数', lastExpand !== null && lastExpand.skippedTool === toolBlocks.length,
    `实际 skippedTool=${JSON.stringify(lastExpand?.skippedTool)}，工具块 ${toolBlocks.length}`);
  // **最关键的一条**：调用次数按"筛完的候选"算 —— 把工具块算进去，这个数会直接变大
  expect('调用次数只按筛完的候选算（ceil(候选/每批)）',
    lastExpand !== null && lastExpand.calls === Math.max(1, Math.ceil(expectedTargets / 8)),
    `calls=${lastExpand?.calls} 期望=${Math.max(1, Math.ceil(expectedTargets / 8))}`);
  console.log(`    块 ${mixRecords.length}（工具 ${toolBlocks.length} / 非工具 ${nonToolBlocks.length}）· `
    + `扩写候选 ${lastExpand?.candidates} · 跳过工具 ${lastExpand?.skippedTool} · 调用 ${lastExpand?.calls}`);
  await put({ llmAssistEnabled: false, llmIngestExpand: false });
  console.log(`  ㉔ 段累计：通过 ${d24Passed} 条，失败 ${d24Failed} 条。`);
}
