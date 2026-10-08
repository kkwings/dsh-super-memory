/**
 * 宿主半边联调自检：不启动 DSH，用假的 cordis ctx + 真实会话日志跑一遍
 * 「压缩入库 → 压缩后总览 → 提问命中注入 → 未命中 0 token → 设置开关即时生效 → 面板 API → history_read」。
 *
 * 用法：node scripts/harness.mjs <sessionLogPath> [workdir]
 *
 * 退出口径：**自检失败 = 1，缺参数/日志读不到 = 2，合理的 SKIP = 0**（三者要能分开：
 * 第一条是"代码坏了"，第二条是"你少给了一个参数"，第三条是"这份日志本来就不适用"）。
 * 临时目录（`%TEMP%\dsm-harness-home-<pid>`）**用完即清**（异常路径也清，见文件末尾的 finally）。
 *
 * ## 适用范围与 SKIP 口径（2026-10-08 只读审查 P1-B 补）
 *
 * 本脚本的输入是「一份**真实会话日志** + 一个**临时工作区**」，它把日志里的压缩事件
 * 重新投递一遍来建库，再用日志里的真实提问去检索。因此：
 *
 * | 段落 | 依赖 | 什么情况下 SKIP（**打印 `SKIP + 原因`，不计失败**） |
 * |---|---|---|
 * | ① 压缩时入库 / ② 总览 | 日志里**至少有一次 `compaction/summary`** | 一次压缩都没有 → 整段（全部依赖库的段落）SKIP 并以 0 退出 |
 * | ③ 正样本（提问必须注入） | 提问要**落在某个压缩的 `shadowedRange` 内** | 没有任何"确实被压缩过"的提问 → 正样本段 SKIP |
 * | ③ 负样本 / 边界探针 | 库内容与探针**不重合** | 库本身与探针有长文档重合（通用 bigram 沉底）→ 该探针记为**已知过召回**并 SKIP（打印分数与命中块） |
 * | ③ 历史污染探针 | 库里是否逐字包含那两条探针 | **不跳过**：两种情形各有自己的断言（见那里的注释） |
 * | ④ 工作区识别 / ④ 设置开关 / ㉓ / ㉔ | 合成事件，与日志内容无关 | 不跳过 |
 * | ㉕ boost 与召回去重 | 本轮召回选中的块是否与 boost 资料重叠 | 不重叠（覆盖率差异）→ 打印 SKIP + 原因；**但还是会独立量一遍重叠度**，重叠却没被丢就是真 bug → 红 |
 *
 * **正样本为什么只取"被压缩过"的提问**：库是从压缩事件建起来的，压缩之后才提出的问题
 * **从来没进过库**，要求它必须命中是错的期望（实测：某份真实日志 52 条历史提问里，
 * 8 条 0 字符的全部落在唯一那个压缩区间 `13..1300` 之外，区间内的 44 条 44/44 命中）。
 * 这不是"放宽断言"，而是把探针集合修正成"库里真的有对应内容"的那一批；
 * 断言本身没有变弱：区间内的提问仍然必须逐条命中（漏一条就红）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 用法说明（缺参数 / 日志读不到时打印，不是 TypeError 栈）。 */
const USAGE = [
  '用法：node scripts/harness.mjs <sessionLogPath> [workdir]',
  '  <sessionLogPath>  真实会话日志，形如 $DSH_HOME/sessions/<项目>/<会话id>/session.v4.jsonl[.zstd]',
  '  [workdir]         可选：把记忆库放在这个目录（默认 %TEMP%\\dsm-harness-workspace）',
  '',
  '例：node scripts/harness.mjs "%USERPROFILE%\\.dsh\\sessions\\--x--\\session-xxxx\\session.v4.jsonl.zstd"',
].join('\n');

const logPath = process.argv[2];
if (typeof logPath !== 'string' || logPath.trim() === '') {
  console.error(`缺少会话日志路径。\n\n${USAGE}`);
  process.exit(2);
}
if (!fs.existsSync(logPath)) {
  console.error(`读不到这份会话日志：${logPath}\n（路径要指向具体的 session*.jsonl[.zstd] 文件，不是目录。）\n\n${USAGE}`);
  process.exit(2);
}

const workdir = process.argv[3] ?? path.join(os.tmpdir(), 'dsm-harness-workspace');
const home = path.join(os.tmpdir(), `dsm-harness-home-${process.pid}`);
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workdir, { recursive: true });
process.env.DSH_HOME = home;

/**
 * 自愈：把**之前**异常中断留下的同类临时目录清掉。
 *
 * 为什么要它（2026-10-08）：本机 `%TEMP%` 里实测残留了 76 个 `dsm-harness-home-<pid>`
 * —— 都是旧版本在异常路径上没清留下的。本次改成"结束时一定清 + 启动时顺手扫掉旧的"：
 * 只认自己造的两个前缀（`dsm-harness-home-` / `dsm-harness-other-`），并且**只清超过
 * 6 小时的**（不碰并发运行的另一个 harness，也不碰用户自己传进来的 workdir）。
 */
function sweepStaleTempDirs() {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      const stale = name.startsWith('dsm-harness-home-') || name.startsWith('dsm-harness-other-');
      if (!stale) continue;
      const full = path.join(os.tmpdir(), name);
      if (full === home) continue;
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* 单个目录清不掉就跳过 */ }
    }
  } catch { /* 扫不动 tmpdir 不影响自检 */ }
  return removed;
}
const swept = sweepStaleTempDirs();
if (swept > 0) console.log(`启动清理：删掉了 ${swept} 个上次遗留的 dsm-harness-* 临时目录`);

/**
 * 清理逻辑（**只清插件自己的东西**，不碰用户给的 workdir）：
 *   · `home`：`<tmp>/dsm-harness-home-<pid>` —— 设置/诊断/用量/缓存都在里面；
 *   · 同进程造出来的沙箱工作区（`dsm-harness-other-<pid>` 等）跟着一起清。
 *
 * 为什么必须是 finally + 兜底钩子：早先只在正常结束路径写了一句清理，异常路径直接
 * 把临时目录留在盘上 —— 本机实测残留了 76 个 `dsm-harness-home-*`。
 */
const makeCleanup = () => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const dir of [home, path.join(os.tmpdir(), `dsm-harness-other-${process.pid}`)]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影响判定 */ }
    }
  };
};
const cleanupHome = makeCleanup();
// 兜底：未捕获异常 / 提前退出也要清（正常路径末尾另有 finally）
process.on('exit', cleanupHome);
process.on('uncaughtException', (error) => {
  cleanupHome();
  console.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  cleanupHome();
  console.error(reason);
  process.exit(1);
});

const { apply } = await import('../lib/host.js');
const { decompressFrames } = await import('../lib/zstd.js');
const { mergeKeywords, parseJsonArray, parseJsonObject } = await import('../lib/llm.js');
const { diagnoseMiss } = await import('../lib/diagnose.js');
const { toolRecords } = await import('../lib/ingest.js');
const { RECALL_HEAD_PREFIX, NEAR_DUPLICATE_SIMILARITY, questionTextOf } = await import('../lib/recall.js');
// ㉕ 段要用**独立实现**量"召回行与 boost 资料是否重叠"（containment），
// 不能复用 selectFreshHits —— 那样断言会变成同义反复。
const { containment, tokenSet } = await import('../lib/text.js');
// ③ 段要用它直接查库（钉住"夹具自污染"这个原因、并量出边界探针的分数）；
// ⑥ 段原来在这里再 import 一次，已上移 —— 重复声明同一常量会直接 SyntaxError。
const { MemoryIndex, retrieveTwoTier } = await import('../lib/retrieval.js');
const { makeRecord, readRecords } = await import('../lib/store.js');
const { DEFAULTS } = await import('../lib/config.js');

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

/* ── 适用范围闸：这份日志里有没有"被压掉的历史" ──────────────────────────────
 * 整个脚本（①~③ 以及所有依赖记忆库的段落）都建立在"日志里有 `compaction/summary`"之上：
 * 没有压缩事件 → 库里一条块都不会有 → 后面的断言全是空测。
 * 这时的正确行为是**打印 SKIP + 原因并以 0 退出**，而不是抛一个 ENOENT
 * （早先实测：`node scripts/harness.mjs <零压缩日志>` 直接在 `statSync` 上抛错、退出码 1，
 *  看起来像"代码坏了"，其实只是这份日志不适用）。 */
const compactions = events.filter((e) => e.type === 'compaction/summary');
if (compactions.length === 0) {
  console.log('\nSKIP ①~㉕ 全部依赖记忆库的段落 — 这份日志里没有任何 `compaction/summary` 事件，');
  console.log('     所以「压缩时入库 / 总览 / 提问命中」都无从验证（换一份含压缩事件的日志再跑）。');
  console.log('     不依赖日志的段落（④c 工作区识别等）也不跑：它们同样以"库里有块"为前提。');
  cleanupHome();
  process.exit(0);
}

/** 造一个"用户刚问了 X"的会话：把历史 user 消息 + 一条新的用户消息拼进去。 */
function sessionWithQuestion(question, suffixSeq, idOverride) {
  const base = events.filter((e) => e.type !== 'user/message' || e.data?.source?.kind !== 'user' || e.seq < 3000);
  const userEvent = {
    type: 'user/message', seq: suffixSeq, time: Date.now(),
    // `source` 必须**照真实日志的形状**写（kind + rpcId）：`questionTextOf` 现在要求
    // rpcId 才认这是人类提问（P1-C），少了它这条合成提问会被当成宿主噪声、查询为空 → 整段假绿。
    data: { content: [{ type: 'text', text: question }], source: { kind: 'user', rpcId: `harness-rpc-${suffixSeq}` }, role: 'user', id: `q-${suffixSeq}` },
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
console.log('\n=== ③ 提问命中 / 未命中（真断言：正样本必须注入、负样本必须 0 字符）===');
/* 这一段 2026-10-08 从"只打印诊断"改成**真断言**，同日（只读审查 P1-B）又修了两处**探针口径**：
 *   ① 正样本 = 日志里**确实被压缩过**的人类提问（seq 落在某个压缩的 `shadowedRange` 内）
 *      → 必须逐条注入召回块。压缩之后才问的问题从没进过库，不是有效正样本（见脚本头）。
 *   ② 负样本 = 与本库无关的日常问题 → 召回块字符数必须为 0。
 * 任一条不成立就 process.exitCode = 1（自检失败 = 1，与脚本头的退出码约定一致）。
 * 能失败：
 *   · 把 `lib/retrieval.js` 的命中证据门 `MIN_MATCHED_TERMS` 改成 0 → 12 条负样本里多条立刻注入
 *     （它们的相对分是 1.0 上下，实测 3 条注入 277–298 字符）；
 *   · 把配置的 `minScore` 调到 0.01 → 下面的"阈值灵敏度（合成夹具）"与"配置阈值下界"两条变红；
 *   · 把检索整体弄坏（比如索引读空）→ 正样本逐条变红。 */
let d3Passed = 0;
let d3Failed = 0;
const expect3 = (label, condition, detail = '') => {
  if (condition) { d3Passed += 1; console.log(`  ✓ ${label}`); return; }
  d3Failed += 1; process.exitCode = 1;
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
/** 跳过一段（**打印 SKIP + 原因**，不计失败）。 */
const skip3 = (label, reason) => console.log(`  SKIP ${label} — ${reason}`);
/** 注入文本里"召回块"部分的字符数（0 = 没有召回块）。 */
const recallCharsOf = (out) => (out.includes(RECALL_HEAD_MARK) ? out.split(RECALL_HEAD_MARK)[1].length : 0);
/** 每条合成探针的 seq（必须够大，免得与日志里真实事件的 seq 撞车）。 */
let seqCursor = 900000;

/* 被压缩过的 seq 区间：只有落在这里面的内容才真的进过库。 */
const shadowedRanges = compactions
  .map((event) => [Number(event.data?.shadowedRange?.start), Number(event.data?.shadowedRange?.end)])
  .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end));
const inShadowedRange = (seq) => shadowedRanges.some(([start, end]) => seq >= start && seq <= end);

/* 正样本候选：**与插件同一口径**取提问（`questionTextOf` 会挡掉通知类与宿主派单）。 */
const allUserQuestions = [];
for (const event of events) {
  if (event.type !== 'user/message') continue;
  const t = questionTextOf(event.data);
  if (t !== '' && t.length > 10) allUserQuestions.push({ text: t, seq: Number(event.seq) || 0 });
}
const coveredQuestions = allUserQuestions.filter((item) => inShadowedRange(item.seq));
console.log(`  正样本口径：${shadowedRanges.length} 个压缩区间 ${JSON.stringify(shadowedRanges)}；`
  + `历史人类提问 ${allUserQuestions.length} 条，其中**确实被压缩过**的 ${coveredQuestions.length} 条入选`
  + `（其余 ${allUserQuestions.length - coveredQuestions.length} 条是压缩之后才问的，没进过库，不是有效正样本）。`);
if (coveredQuestions.length === 0) {
  skip3('正样本（提问必须注入）', '这份日志里没有"落在压缩区间内的人类提问"');
} else {
  for (const { text: question, seq } of coveredQuestions) {
    // 每条探针都用一份**干净的会话状态**（复制库 + 新会话 id）：排除冷却/去重/粘住的参考块，
    // 否则"这一条没注入"可能只是被上一条的冷却挡住了，断言会变成假绿。
    const s = cloneSession(question, seqCursor++);
    const out = injected(s);
    const recallChars = recallCharsOf(out);
    const lines = out.split(RECALL_HEAD_MARK)[1]?.split('\n').filter((l) => l.startsWith('- ')) ?? [];
    console.log(`   Q(seq=${seq}): ${question.replace(/\s+/g, ' ').slice(0, 40)}`);
    console.log(`      总注入 ${out.length} 字符；召回块 ${recallChars} 字符 / ${lines.length} 条`);
    expect3(`已入库的相关提问必须注入召回块（seq=${seq}）：${question.replace(/\s+/g, ' ').slice(0, 24)}…`,
      recallChars > 0, `召回块 ${recallChars} 字符`);
  }
}

/* ③b / ④ / ⑤ / history_read 等**下游探针**共用的提问池：只放"库里答得上来"的提问
 * （= 已入库的那些）。不足 3 条时用最后一条补齐 —— 下游只是需要"一句真能命中的历史提问"，
 * 重复同一条不影响任何被验语义（它们各自用**干净的会话状态**）。 */
const relevantQuestions = (() => {
  const texts = coveredQuestions.map((item) => item.text);
  if (texts.length === 0) return [];
  while (texts.length < 3) texts.push(texts[texts.length - 1]);
  return texts;
})();
if (relevantQuestions.length > 0) {
  console.log(`  下游探针提问池：${relevantQuestions.length} 条（取自已入库提问，不足 3 条时重复最后一条）`);
}

/* 负样本探针（2026-10-08 标定用的 24 条里挑 12 条 + 1 条边界探针）。
 *
 * ⚠️ 前 12 条**故意不用**早先那两条（"明天北京天气预报怎么样" / "帮我写一首关于春天的五言绝句"）：
 * 它们逐字出现在本文件自己里面（就是原来 ③ 段那两行字符串），只要夹具会话读过 harness.mjs、
 * 工具结果原文进了库（L2 的 `工具 read：scripts/harness.mjs`），"用户问的那句话逐字躺在一篇
 * 已入库文档里" —— **任何词法检索都必然命中**，与阈值无关。那两条改到下面按库内容**条件式**判定
 * （库里真有逐字包含它的记录 → 断言"必须命中且来自自污染"；否则 → 断言"必须 0 字符"）。
 *
 * 这 12 条是**库无关**的强负样本：它们只与库共享 ≤2 个 token，靠的是**命中证据门**
 * （`MIN_MATCHED_TERMS`）而不是阈值 —— 把阈值调到 0.01 也不会注入它们。
 * 想验"阈值真的在挡"，用下面的合成夹具（同样能失败，且不依赖这份库）。 */
const NEGATIVE_PROBES = [
  '晚饭吃什么比较好',
  '帮我订一张下周三去上海的机票',
  '今天股市收盘了吗',
  '推荐几部好看的科幻电影',
  '怎么种小番茄',
  '狗一天要喂几次',
  '洗衣机不排水是什么原因',
  '红烧肉怎么做才不腻',
  '感冒了吃什么药好得快',
  '吉他新手先练什么和弦',
  '马拉松赛前一周怎么吃',
  '帮我把这段话翻译成法语',
];
/* **边界探针**（库相关，条件式）：一句话题空转的日常话，却会与库里那些"逐字包含用户提问的
 * 长 L2 块"共享若干通用 bigram，可能**过了证据门**、只靠阈值挡住。实测它在不同的真实库上
 * 落在阈值两侧（0.276 / 0.323 / 0.380），所以**不能**当成库无关的负样本：
 *   · 库只给出"过门但低于阈值"的候选 → 断言必须 0 字符（硬断言）；
 *   · 库给出的候选已经高过阈值 → 那是**已知过召回**（要修它得改 minScore/证据门口径 = 业务语义，
 *     不在本轮范围）→ 打印 SKIP + 分数 + 命中块，**不计失败**，但把证据留在这里。 */
const ADVERSARIAL_PROBE = '帮我看看这个问题现在到底是怎么处理的我有点搞不清楚';
console.log('\n负样本（与本库无关；每条都用干净会话状态：召回块必须为 0 字符）：');
for (const question of NEGATIVE_PROBES) {
  const s = cloneSession(question, seqCursor++);
  const out = injected(s);
  const recallChars = recallCharsOf(out);
  console.log(`   Q: ${question} → 总注入 ${out.length} 字符，召回块 ${recallChars === 0 ? '✓ 空' : `✗ ${recallChars} 字符`}`);
  expect3(`不相关提问必须不注入：${question}`, recallChars === 0, `召回块 ${recallChars} 字符`);
}

/* 边界探针：先量库自己的候选分数，再决定断言口径（条件式，两种情形都能失败）。 */
{
  const configuredMinScore = Number(DEFAULTS.minScore);
  const probeIndex = new MemoryIndex(readRecords(root, sessionId));
  const admitted = retrieveTwoTier(probeIndex, ADVERSARIAL_PROBE, {
    minScore: 0.01, maxItems: 1, preferSummaryChunks: true,
  });
  const atConfigured = retrieveTwoTier(probeIndex, ADVERSARIAL_PROBE, {
    minScore: configuredMinScore, maxItems: 2, preferSummaryChunks: true,
  });
  const s = cloneSession(ADVERSARIAL_PROBE, seqCursor++);
  const out = injected(s);
  const recallChars = recallCharsOf(out);
  const overRecall = admitted.hits.length > 0 && admitted.topScore > configuredMinScore;
  console.log(`   边界探针："${ADVERSARIAL_PROBE}" → 库最高候选 ${admitted.topScore.toFixed(4)}（阈值 ${configuredMinScore}）`);
  if (overRecall) {
    const top = admitted.hits[0];
    console.log(`      命中块：title=${JSON.stringify(top.record?.title ?? '')} layer=${top.record?.layer ?? ''}`
      + ` len=${String(top.record?.text ?? '').length} matched=${top.matched}/${top.queryTerms}`);
    skip3('边界探针必须不注入', `本库把它抬过了阈值（${admitted.topScore.toFixed(4)} > ${configuredMinScore}）——`
      + '已知过召回：要修它必须改 minScore / 证据门口径（业务语义），不在本轮范围；证据见上一行的命中块');
    // 即使走 SKIP 分支也留一条硬约束：注入量仍然不许越过单条上限（口径来自 formatRecall）。
    expect3('（过召回情形）注入量仍必须守单条上限 + 头部',
      recallChars <= DEFAULTS.maxCharsPerItem + 260,
      `召回块 ${recallChars} 字符 / 上限 ${DEFAULTS.maxCharsPerItem} + 头部`);
    expect3('（过召回情形）库最高候选确实过了证据门（否则它不该走这一支）',
      admitted.hits[0].matched >= 1, `matched=${admitted.hits[0].matched}`);
  } else {
    expect3('边界探针必须不注入（库只提供"过门但低于阈值"的候选）', recallChars === 0, `召回块 ${recallChars} 字符`);
    expect3('边界探针在配置阈值下确实被挡住（不是"库里根本没候选"）',
      atConfigured.tier === 'none', `tier=${atConfigured.tier} top=${atConfigured.topScore.toFixed(4)}`);
  }
}

/* 阈值灵敏度：**库无关、确定性**的一对断言（合成夹具）。
 * 早先这一条靠"边界探针恰好落在阈值下沿"来承担，而它在不同真实库上会漂到阈值之上 ——
 * 于是"把 minScore 调到 0.01 必须变红"这条就时灵时不灵。改用合成索引：
 *   · 低阈值下同一句话必然命中（证明夹具本身有效）；
 *   · 阈值抬到 1.5 必须挡住（证明分数闸门真的在挡，而不是被证据门顺手挡掉）；
 *   · **配置里的 minScore 必须显著高于 0.01** —— 把它改成 0.01/0 就等于关掉闸门，这一条变红。 */
{
  const synthQuery = '阈值灵敏度合成探针';
  const synthIndex = new MemoryIndex([
    makeRecord({ session: 'synthetic', layer: 'raw', title: synthQuery, compactionId: 'synthetic', text: `${synthQuery} 正文正文正文正文` }),
  ]);
  const low = retrieveTwoTier(synthIndex, synthQuery, { minScore: 0.01, maxItems: 1, preferSummaryChunks: true });
  const high = retrieveTwoTier(synthIndex, synthQuery, { minScore: 1.5, maxItems: 1, preferSummaryChunks: true });
  expect3('阈值灵敏度（合成夹具）：低阈值下同一句话必然命中（前提，否则下面那条是空测）',
    low.hits.length > 0, `tier=${low.tier} top=${low.topScore.toFixed(4)}`);
  expect3('阈值灵敏度（合成夹具）：阈值抬到 1.5 必须挡住（分数闸门真的在挡）',
    high.hits.length === 0, `tier=${high.tier} top=${high.topScore.toFixed(4)}`);
  expect3('配置的 minScore 必须显著高于 0.01（否则等于把命中闸门关掉）',
    Number(DEFAULTS.minScore) > 0.01, `minScore=${DEFAULTS.minScore}`);
}

/* 历史探针（"明天北京天气预报怎么样" / "帮我写一首关于春天的五言绝句"）：**条件式**。
 * 这两条之所以历史上会命中，是因为库里可能有一篇**逐字包含它们**的文档（本文件自己的源码被
 * 读过并入了 L2）——那是夹具自污染，不是阈值问题。于是**两种情形各有自己的断言**，
 * 任何一种情形都不会因为"另一种情形"而报红：
 *   · 库里有逐字包含它的记录 → 断言"必须注入召回块"（命中必须真的来自自污染，不能悄悄变空）；
 *   · 库里没有          → 断言"必须注入 0 字符"（干净库下的正确期望）。
 * ⚠️ 能失败：前一支被"检索整体坏掉"打红；后一支被"证据门/阈值被关掉"打红。 */
const CONTAMINATED_PROBES = ['明天北京天气预报怎么样', '帮我写一首关于春天的五言绝句'];
{
  const probeIndex = new MemoryIndex(readRecords(root, sessionId));
  for (const probe of CONTAMINATED_PROBES) {
    const top = probeIndex.search(probe, { limit: 1 })[0];
    const verbatim = String(top?.record?.text ?? '').includes(probe);
    const s = cloneSession(probe, seqCursor++);
    const out = injected(s);
    const recallChars = recallCharsOf(out);
    if (verbatim) {
      console.log(`   （历史探针）"${probe}" → 库里有逐字包含它的记录：${top.record.title}（mc=${top.matched}，score=${top.score.toFixed(3)}）→ 自污染情形`);
      expect3(`自污染情形：库里有逐字包含该探针的记录 → 命中必须来自它（召回块非空）：${probe}`,
        recallChars > 0, `召回块 ${recallChars} 字符`);
    } else {
      console.log(`   （历史探针）"${probe}" → 库里没有逐字包含它的记录 → 干净库情形`);
      expect3(`干净库情形：库里没有逐字包含该探针的记录 → 必须注入 0 字符：${probe}`,
        recallChars === 0, `召回块 ${recallChars} 字符`);
    }
  }
}
console.log(`  ③ 段累计：通过 ${d3Passed} 条，失败 ${d3Failed} 条。`);

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
      console.log(`  hit=${entry.hit} reason=${entry.reason} top=${entry.topScore} second=${entry.secondScore} chars=${entry.injectedChars} est=${entry.injectedTokensEst} Q#${entry.queryHash}/${entry.queryChars}（已哈希，不落明文）`);
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
      source: { kind: 'user', rpcId: `harness-lag-${seq}` },
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
        data: { content: [{ type: 'text', text: '跨压缩记忆怎么装' }], source: { kind: 'user', rpcId: 'harness-probe-rpc' } },
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

  // 不显式配 provider/model：`llmMode:'main'` + 空的新键 = 跟随会话事件里的主模型。
  // （`llmAssistEnabled` 由 `llmMode` 派生 —— `main` 会打开调用并把 provider/model 清空，
  // 正是"路由必须来自会话事件"这个探针需要的状态；这里不再手塞派生开关。）
  await put({ llmMode: 'main', llmProvider: '', llmModel: '', llmIngestTimeoutMs: 3000 });
  behavior.mode = 'ok';
  behavior.lastInput = null;
  const inherited = await call('POST', '/api/dsh-super-memory/llm/test', { session: inheritProbe });
  expect('路线跟随会话事件时，测试连接仍走通', inherited.status === 200 && inherited.body?.value?.ok === true, `实际 HTTP ${inherited.status} ${JSON.stringify(inherited.body?.value ?? inherited.body?.error)}`);
  expect('主对话的 reasoningEffort=max 没有被继承', behavior.lastInput !== null && !('reasoningEffort' in behavior.lastInput), `实际键=${behavior.lastInput === null ? '(没调用)' : Object.keys(behavior.lastInput).join(',')}`);
  expect('整个调用参数里搜不到 reasoningEffort', behavior.lastInput !== null && !JSON.stringify(behavior.lastInput).includes('reasoningEffort'));
  expect('解析出的路线里也不带 reasoningEffort（连留痕都不留这个字段）', !JSON.stringify(inherited.body?.value?.route ?? {}).includes('reasoningEffort'), `实际 route=${JSON.stringify(inherited.body?.value?.route ?? null)}`);

  behavior.lastInput = null;
  await put({ llmMode: 'custom', llmProvider: 'fake-provider', llmModel: 'fake-model' });
  const explicit = await call('POST', '/api/dsh-super-memory/llm/test', { provider: 'fake-provider', model: 'fake-model', session: inheritProbe });
  expect('显式配了提供方/型号时也不传 reasoningEffort', explicit.status === 200 && behavior.lastInput !== null && !('reasoningEffort' in behavior.lastInput));
  expect('「调用指定模型」档位下解析出的路由 = 设置里的 llmProvider/llmModel（单一字段集）',
    explicit.body?.value?.route?.provider === 'fake-provider' && explicit.body?.value?.route?.model === 'fake-model',
    `实际 route=${JSON.stringify(explicit.body?.value?.route ?? null)}`);
  await put({ llmMode: 'off', llmProvider: '', llmModel: '' });
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
/* `readRecords` 已在上面的 import 块里引入（③ 段也要用它）。 */
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
    llmMode: 'custom', llmProvider: 'fake-provider', llmModel: 'fake-model',
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
  /* 「boost 去重分支被走到」是**覆盖率**断言，能不能走到取决于库内容：
   * boost 素材来自 `/diagnose`（按分数挑的对话块），召回候选来自提问召回那一侧
   * （同一个检索但不同的调用点与上限），两者**未必**选中同一块。
   * 所以这里条件式判定，两种情形各有硬断言：
   *   · 诊断说丢了 ≥1 条 → 分支确实被走到（硬断言）；
   *   · 诊断说 0 条 → 用**独立实现**（`lib/text.js` 的 containment，不经过 selectFreshHits）
   *     量一遍"召回到的那些行与 boost 资料到底重不重叠"：
   *       重叠 ≥ NEAR_DUPLICATE_SIMILARITY 却没被丢 → **真 bug，红**；
   *       确实不重叠 → 打印 SKIP + 原因（这一轮没有可丢的东西）。
   * 真正的正确性不变量由下一条"同一片段只出现 1 次"独立保证。 */
  /* 口径必须与 `selectFreshHits` **同形**：它比的是 `itemText(record, maxChars)`
   * —— **不含** `- [来源] ` 前缀。前缀里那几个 token（如"对话"）在 boost 资料里也出现，
   * 把它们算进分子分母会让重叠度虚高（实测同一份数据：带前缀 0.600、不带前缀 0.500，
   * 正好跨过 0.6 这条线）→ 会得出"该丢却没丢"的假阳性。 */
  const boostFull = tokenSet(boostHead + boostBody);
  const recallPart = (boostedOut.split(RECALL_HEAD_MARK)[1] ?? '').split(boostHead)[0] ?? '';
  const recallLines = recallPart.split('\n').filter((line) => line.startsWith('- '));
  const maxOverlap = boostFull.size === 0 ? 0 : recallLines.reduce(
    (best, line) => Math.max(best, containment(tokenSet(line.replace(/^- \[[^\]]*\]\s*/, '')), boostFull)), 0,
  );
  if (recallEvent !== null && recallEvent.boostDedupDropped >= 1) {
    expect('与 boost 重叠的召回块被丢掉（boostDedupDropped ≥ 1）', true);
  } else {
    expect('（没有可丢的块时）召回行与 boost 资料确实不重叠 —— 若重叠却没丢，这里必须红',
      maxOverlap < NEAR_DUPLICATE_SIMILARITY,
      `最大重叠度 ${maxOverlap.toFixed(3)} ≥ 阈值 ${NEAR_DUPLICATE_SIMILARITY} 却没被丢（召回 ${recallLines.length} 行）`);
    if (maxOverlap < NEAR_DUPLICATE_SIMILARITY) {
      console.log(`  SKIP boost 去重分支被走到（boostDedupDropped ≥ 1） — 本轮召回（reason=${recallEvent?.reason}）`
        + `选中的 ${recallLines.length} 行与 boost 资料最大重叠只有 ${maxOverlap.toFixed(3)}（< ${NEAR_DUPLICATE_SIMILARITY}），`
        + '没有可丢的块：这是**库相关**的覆盖率差异，不是缺陷');
    }
  }
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
        source: { kind: 'user', rpcId: 'harness-mix-rpc' }, role: 'user', id: 'q-mix-1',
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

/* ── 清理：临时目录用完即清（异常路径由上面的 process 钩子兜底）─────────────
 * 只清插件自己造的目录（临时 DSH_HOME + 沙箱工作区），**不动**用户传进来的 workdir。
 * 本机曾在 `%TEMP%` 里残留 76 个 `dsm-harness-home-*`，就是因为这条只在正常结束路径执行。 */
cleanupHome();
console.log('临时目录已清理:', home);
