/**
 * 宿主半边冒烟守卫：不启动 DSH、不需要会话日志，专抓"文件级损坏"与"接线级接错"。
 *
 * 为什么非要有它（2026-10-07 实测踩过，代价很高）：`lib/host.js` 一度被写坏成
 * UTF-16 BOM + NUL 字节的乱码，而 `npm test` **全绿** —— 因为原来那三套脚本只
 * import 了 lib 里的少数几个模块，坏掉的宿主入口根本没人碰，直到真的在 DSH 里加载才发现。
 * 这个守卫把"每个文件都是正常 UTF-8 源码、宿主入口真的能被加载"钉成硬性检查。
 *
 * 2026-10-08 补的三道（第三方只读审查点名的"结构性盲区"，三类事故历史上都真出过）：
 *   ④ **真的调用 `apply(ctx)`**（不是只 import）：断言真注册了 `systemPrompt.context`
 *      提供者、订阅了 `session/event`、注册了 `webServer` 路由、注册了 `history_read`
 *      工具，并触发一条真实形状的 `compaction/summary` 事件。
 *      → 抓"开关接错键 / 注册被注释掉 / apply 中途抛错"。
 *   ⑤ **用合成 req/res 真打一遍 `routes.js` 的请求链**（GET/POST/未知路径/方法分发）。
 *      → 抓"HTTP 方法写错、路径字符串写错、写守卫被摘掉"。
 *   ⑥ **诊断日志不含提问明文**（只落 `queryHash` + `queryChars`）。
 *      → 抓"哪天又被改回 `queryHead` 明文"。
 *
 * 检查项：
 *   ① 完整性：`lib/` 下**每个** .js 非空、不以 UTF-8/UTF-16 BOM 开头、不含 NUL 字节
 *   ② 语法：每个 .js 都能被 `node --check` 解析（等价于语法可解析）
 *   ③ 可加载：宿主入口与关键模块能动态 import，且 lib/host.js 的导出契约正确
 *   ④ 接线：`apply(ctx)` 真跑，注册项逐条核对
 *   ⑤ 请求链：合成的 GET/POST 真打过 `makeRoutes()` 的 handler
 *   ⑥ 隐私：诊断日志里只有提问的哈希与长度
 *
 * 用法：node scripts/host-smoke.mjs [libDir]
 *   libDir 默认是仓库自己的 lib/。给一个"同样布局的目录"就能自证守卫会报红，例如：
 *     cp lib/*.js %TEMP%\dsm-smoke\   # 再把其中一个改成 UTF-16 BOM/
 *     node scripts/host-smoke.mjs %TEMP%\dsm-smoke
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const libDir = resolve(process.argv[2] ?? join(here, '..', 'lib'));

/** 提问哈希的口径来源：直接用**被测代码自己的那个函数**（`config.js` 的 shortHash）。 */
const { shortHash } = await import(pathToFileURL(join(libDir, 'config.js')).href);
/** 召回块首行判据：也直接用被测代码自己的常量（`recall.js`），不在脚本里复刻一份。 */
const { RECALL_HEAD_PREFIX } = await import(pathToFileURL(join(libDir, 'recall.js')).href);

/**
 * 本进程建的临时目录/big 环境（④⑤⑥ 段用）：无论正常结束还是抛错都要清掉。
 *
 * 为什么必须 `finally`：`harness.mjs` 那边就因为"异常路径忘了清"在本机残留了几十个
 * `dsm-harness-home-<pid>` 目录。这里的 try/finally 包住了真正会用临时目录的那一段，
 * 和 harness.mjs 的 finally 是同一套纪律。
 */
const tempDirs = [];
function makeTempDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${tempDirs.length}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

/** 目录是否存在（清理断言用；`existsSync` 的薄包装，免得读代码时看不出用意）。 */
function existsSyncSafe(path) {
  try { return existsSync(path); } catch { return false; }
}

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/** UTF-16 BOM（FF FE / FE FF）与 UTF-8 BOM（EF BB BF）。 */
function bomKind(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return 'UTF-16LE BOM (FF FE)';
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return 'UTF-16BE BOM (FE FF)';
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'UTF-8 BOM (EF BB BF)';
  return '';
}

console.log(`宿主半边冒烟守卫：libDir=${libDir}\n`);

let files = [];
try {
  files = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort();
} catch (error) {
  console.log(`  ✗ 读不到 lib 目录：${String(error?.message ?? error)}`);
  failures.push('读不到 lib 目录');
}

console.log(`① 完整性与语法（${files.length} 个 .js：非空 / 无 BOM / 无 NUL / node --check）`);
for (const name of files) {
  const path = join(libDir, name);
  let buffer = null;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    check(`${name} 可读`, false, String(error?.message ?? error));
    continue;
  }
  const size = buffer.length;
  const bom = bomKind(buffer);
  const nul = buffer.includes(0);
  const bytesOk = size > 0 && bom === '' && !nul;
  check(
    `${name}（${size} B）`,
    bytesOk,
    [size === 0 ? '文件是空的' : '', bom === '' ? '' : `带 ${bom}`, nul ? '含 NUL 字节' : ''].filter(Boolean).join('；'),
  );
  // 语法：等价于 `node --check <file>`。stdio 全部 ignore —— 不建管道，沙箱里也能跑。
  const parsed = spawnSync(process.execPath, ['--check', path], { stdio: 'ignore' });
  check(
    `${name} 语法可解析（node --check）`,
    parsed.status === 0,
    parsed.error ? `无法启动 node --check：${parsed.error.code ?? parsed.error.message}` : `退出码 ${parsed.status}`,
  );
}

console.log('\n② 可加载（动态 import）与导出契约');
const KEY_MODULES = [
  'host.js', 'routes.js', 'ingest.js', 'llm.js', 'recall.js',
  'store.js', 'config.js', 'zstd.js', 'transcript.js',
];
const loaded = new Map();
for (const name of KEY_MODULES) {
  const path = join(libDir, name);
  try {
    loaded.set(name, await import(pathToFileURL(path).href));
    check(`${name} 可被动态 import`, true);
  } catch (error) {
    check(`${name} 可被动态 import`, false, String(error?.message ?? error).slice(0, 200));
  }
}

{
  const host = loaded.get('host.js');
  check('host.js 导出 apply 函数（DSH 插件入口）', typeof host?.apply === 'function');
  check('host.js 导出 inject 数组（挂载前所需服务）', Array.isArray(host?.inject));
  check(
    'host.js 的 inject 声明了 tools/systemPrompt/webServer',
    Array.isArray(host?.inject)
      && ['tools', 'systemPrompt', 'webServer'].every((name) => host.inject.includes(name)),
    Array.isArray(host?.inject) ? `实际=${host.inject.join(',')}` : '',
  );
}

// 关键模块各自的对外函数也要在位：文件"能 import"不等于"内容没被删掉"
const CONTRACTS = [
  ['config.js', ['DEFAULTS', 'normalizeSettings', 'validatePatch', 'SettingsStore']],
  ['routes.js', ['makeRoutes']],
  ['recall.js', ['formatRecall']],
  ['store.js', ['storeRoot', 'readRecords']],
  ['zstd.js', ['readSessionEvents']],
  ['transcript.js', ['writeExcerpt']],
];
for (const [name, keys] of CONTRACTS) {
  const module = loaded.get(name);
  const missing = module === undefined ? keys : keys.filter((key) => module[key] === undefined);
  check(`${name} 导出 ${keys.join(' / ')}`, missing.length === 0, missing.length === 0 ? '' : `缺 ${missing.join(', ')}`);
}

// 已按用户决定删掉的设置键不许偷偷回来（插件不再有"思考强度"这个概念，
// 用户要调就去 DSH 官方「设置 → 模型」页调）。最后四个是 2026-10-08 收敛为
// 单一字段集（`llmMode` + `llmProvider` + `llmModel`）时删除的"入库/检索各配一套"影子键：
// 它们只允许出现在 `config.js` 的 `load()` 一次性迁移（读取）与 `save()`（删除）里。
for (const key of [
  'llmReasoningEffort',
  'llmIngestProvider', 'llmIngestModel', 'llmRecallProvider', 'llmRecallModel',
]) {
  const config = loaded.get('config.js');
  check(`config.js 不再有 ${key} 设置键`, config?.DEFAULTS !== undefined && !(key in config.DEFAULTS));
  check(`config.js 的可编辑字段里也没有 ${key}`, Array.isArray(config?.EDITABLE_FIELDS) && !config.EDITABLE_FIELDS.includes(key));
}

/* ─────────────────────────────────────────────────────────────────────────
 * ④ 真的调用 apply(ctx)：接线层自检（第三方只读审查点名的第 1 个盲区）
 *
 * 为什么必须真调用：`apply()` 是全插件的唯一入口，而它此前**从没在测试里执行过** ——
 * 只 import 一个模块证明不了"注册项真的注册了"。历史上真出过的事故：开关接到错的键、
 * 某个 `ctx.effect(() => …register…)` 被注释掉、apply 中途抛错（整块功能静默消失，
 * 而三套自检全绿）。
 *
 * ⚠️ **能失败的验证**（人工做一次就会看到本段变红）：
 *   · 把 `ctx.systemPrompt.context({…})` 那一行注释掉 → 「注册了 systemPrompt.context」红；
 *   · 把 `ctx.effect(() => ctx.on('session/event', …))` 整段注释掉 → 「订阅了 session/event」红；
 *   · 把 `ctx.tools.register(historyReadTool(…))` 注释掉 → 「注册了 history_read 工具」红；
 *   · 把 `ctx.webServer.register(makeRoutes(…))` 注释掉 → 「注册了面板路由」红（⑤ 段也会红）。
 *
 * 假 ctx 的写法与 `scripts/harness.mjs` 的 `makeCtx()` **完全一致**（同一套语义：
 * `effect` 立刻执行并把返回值当 disposer、`inject(['llm'], cb)` 有 llm 就回调），
 * 两处不要各写一套 —— 那是下一处"测试与真机不一致"的产地。
 */
let fakeCtx = null;
let fakeHost = null;
let tempHome = null;
try {
  console.log('\n④ 真的调用 apply(ctx)（接线层自检）');

  tempHome = makeTempDir('dsm-hostsmoke-home');
  const workspace = makeTempDir('dsm-hostsmoke-ws');
  // 环境必须在 import host.js **之前**设好：`defaultSettingsPath()` 是调用时读环境的
  // （见 config.js 的 resolveDataHome），但 import 期也会算一次 BUILD，早点设更稳。
  process.env.DSH_HOME = tempHome;
  process.env.DSH_SUPER_MEMORY_HOME = tempHome;

  /** 会话日志（v4 布局）：首行头记录带顶层 cwd —— 与真实 DSH 日志逐字同形。 */
  const SESSION_ID = 'session-hostsmoke-0001';
  const sessionsRoot = join(tempHome, 'sessions', '--hostsmoke--', SESSION_ID);
  mkdirSync(sessionsRoot, { recursive: true });

  /** 假模型服务：形状与 harness.mjs 的一致（apply 只在"有 llm"时才把网关接上）。 */
  const fakeLlm = {
    async listProviders() { return [{ provider: 'fake-provider', model: 'fake-model' }]; },
    async *stream() { yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', kind: 'done' }; },
  };

  const calls = { effect: 0, on: 0, provider: 0, tool: 0, route: 0, inject: 0 };
  const handlers = new Map();
  const contexts = new Map();
  const tools = new Map();
  const routes = [];
  const makeCtx = () => ({
    effect(fn) { calls.effect += 1; const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    on(name, fn) {
      calls.on += 1;
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {};
    },
    systemPrompt: { context(entry) { calls.provider += 1; contexts.set(entry.name, entry); return () => {}; } },
    tools: { register(tool) { calls.tool += 1; tools.set(tool.name, tool); return () => {}; } },
    webServer: { register(route) { calls.route += 1; routes.push(route); return () => {}; } },
    inject(deps, callback) {
      calls.inject += 1;
      if (Array.isArray(deps) && deps.includes('llm')) {
        try { callback({ llm: fakeLlm, inject: () => () => {} }); } catch { /* 忽略 */ }
      }
      return () => {};
    },
    log: { info() {}, warn() {}, error() {} },
    _handlers: handlers,
    _contexts: contexts,
    _tools: tools,
    _routes: routes,
  });

  fakeHost = await import(pathToFileURL(join(libDir, 'host.js')).href);
  fakeCtx = makeCtx();
  let applyError = null;
  try {
    const maybe = fakeHost.apply(fakeCtx);
    // apply 内部有 await 点（kickBackfill 是后台跑的），但契约是**同步注册完备**；
    // 万一将来改成 async，这里也等它一次，不让"没等"变成假红。
    if (maybe !== undefined && maybe !== null && typeof maybe.then === 'function') await maybe;
  } catch (error) {
    applyError = error;
  }
  check('apply(ctx) 不抛错', applyError === null, String(applyError?.stack ?? applyError ?? '').split('\n').slice(0, 3).join(' / '));
  // 「真的执行到了」的唯一硬证据：桩上的调用计数 > 0（`.catch(() => {})` 之类证明不了）
  check('apply 真的执行到了（桩上的注册调用计数 > 0）',
    calls.effect + calls.on + calls.provider + calls.tool + calls.route > 0,
    JSON.stringify(calls));
  check('apply 期间用了 ctx.inject 拿可选服务（llm）', calls.inject > 0, JSON.stringify(calls));

  const provider = fakeCtx._contexts.get('plugin:dsh-super-memory') ?? null;
  check('① 注册了 systemPrompt.context 提供者', provider !== null, `已注册：${[...fakeCtx._contexts.keys()].join(',') || '（无）'}`);
  check('① 提供者的 text() 可调用并返回字符串', typeof provider?.text === 'function'
    && typeof provider.text({ agent: { session: null } }) === 'string',
    `类型=${typeof provider?.text}`);
  check('② 订阅了 session/event', (fakeCtx._handlers.get('session/event') ?? []).length > 0,
    `已订阅：${[...fakeCtx._handlers.keys()].join(',') || '（无）'}`);
  check('③ 通过 webServer.register 注册了面板路由',
    fakeCtx._routes.length > 0 && typeof fakeCtx._routes[0]?.handler === 'function',
    `路由数=${fakeCtx._routes.length}`);
  check('③ 路由是 /api/dsh-super-memory 前缀路由',
    fakeCtx._routes[0]?.kind === 'prefix' && fakeCtx._routes[0]?.path === '/api/dsh-super-memory',
    JSON.stringify({ kind: fakeCtx._routes[0]?.kind, path: fakeCtx._routes[0]?.path }));
  check('④ 注册了 history_read 工具', fakeCtx._tools.has('history_read'),
    `已注册：${[...fakeCtx._tools.keys()].join(',') || '（无）'}`);

  // 触发一次真实形状的 compaction/summary：监听器必须吞掉一切异常（事件监听器抛错会掀翻宿主）
  const emit = (session, event) => {
    for (const fn of fakeCtx._handlers.get('session/event') ?? []) {
      try { fn(session, event); } catch (error) {
        check(`触发 ${event.type} 事件不抛错`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' / '));
        return false;
      }
    }
    return true;
  };
  const emitSession = {
    id: SESSION_ID,
    header: { cwd: workspace },
    snapshotEvents: () => [],
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const compactionEvent = {
    type: 'compaction/summary',
    seq: 7,
    time: Date.now(),
    data: {
      compactionId: 'hostsmoke-c1',
      turn: 1,
      shadowedRange: { start: 1, end: 6 },
      shadowedTokenCount: 1234,
      summary: [{ type: 'text', text: '# 结论\nhost-smoke 用一条最小合成事件验证监听器不抛错。'.repeat(3) }],
    },
  };
  const okEvent = emit(emitSession, compactionEvent);
  check('⑤ 触发一条 compaction/summary 事件不抛错（监听器是观测者，异常必须自己吞）', okEvent);
  check('⑤ 触发事件后 context 提供者仍可正常求值（返回字符串）',
    typeof provider?.text({ agent: { session: emitSession } }) === 'string');
  // 事件处理里的异步入库（void ingestCompaction(...)）让它跑完，后面 ⑥ 段才有 recall 事件
  await new Promise((r) => setTimeout(r, 30));

  /* ───────────────────────────────────────────────────────────────────────
   * ⑤ 用合成 req/res 真打一遍 routes.js 的请求链（第三方只读审查点名的第 2 个盲区）
   *
   * 此前 `makeRoutes()` 的 handler 在 `npm test` 里**零执行**：方法和路径写错、
   * 写守卫被摘掉，四套自检全绿。这里用最小可用的 req/res 桩真打五条：
   *   · GET /overview            → 200 且 JSON 含 ok:true（抓"路径字符串写错/分支没走到"）
   *   · GET /不存在              → 404
   *   · POST /settings 不带来源头 → 403（writeGuard 生效）
   *   · POST 只支持 GET 的路径    → 与"未知接口"同一条兜底 404（**按现实现断言，不为断言改实现**；
   *                                本仓没有 405 分支，所以这里钉的就是"落进 catch-all"这个事实）
   *   · GET /session?…（带参数）  → 200（抓"参数化路径写错"）
   *
   * ⚠️ **能失败的验证**：摘掉 `writeGuard` 判定 → 403 那条变红；把
   * `/api/dsh-super-memory/overview` 或 `/session` 的字符串改错 → 200 那两条变红。
   */
  console.log('\n⑤ 面板请求链（合成 req/res 真打 handler）');
  const route = fakeCtx._routes[0];
  const request = (method, url, body, headers = {}) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    return {
      method,
      url,
      headers: { 'content-type': 'application/json', 'x-dsh-super-memory': '1', ...headers },
      async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
    };
  };
  const call = (method, url, body, headers = {}) => new Promise((resolveCall) => {
    const res = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
      end(text) { this.body = text; resolveCall({ status: this.status, headers: this.headers, body: JSON.parse(text) }); },
    };
    Promise.resolve(route.handler(request(method, url, body, headers), res)).catch((error) => {
      resolveCall({ status: -1, body: { ok: false, error: { message: String(error?.message ?? error) } } });
    });
  });

  const overview = await call('GET', '/api/dsh-super-memory/overview');
  check('GET /overview → 200 且 JSON 含 ok:true',
    overview.status === 200 && overview.body?.ok === true,
    `HTTP ${overview.status} ${JSON.stringify(overview.body?.error ?? overview.body)?.slice(0, 160)}`);

  const unknown = await call('GET', '/api/dsh-super-memory/no-such-endpoint');
  check('未知路径 → 404', unknown.status === 404, `HTTP ${unknown.status}`);

  const noHeader = await call('POST', '/api/dsh-super-memory/settings', { enabled: false }, { 'x-dsh-super-memory': '' });
  check('POST /settings 不带规定请求头 → 403（writeGuard 生效）',
    noHeader.status === 403 && noHeader.body?.error?.code === 'forbidden',
    `HTTP ${noHeader.status} code=${noHeader.body?.error?.code}`);

  // 方法分发：/trash 只实现 GET；POST 会落进末尾的 catch-all（404）。
  // 这里**不断言 405** —— 现实现没有 405 分支，断言必须跟着真实行为走（不改实现迎合断言）。
  const wrongMethod = await call('POST', '/api/dsh-super-memory/trash', {});
  check('对只支持 GET 的路径发 POST → 404（落进 catch-all，现实现无 405 分支）',
    wrongMethod.status === 404 && wrongMethod.body?.error?.code === 'not-found',
    `HTTP ${wrongMethod.status} code=${wrongMethod.body?.error?.code} message=${String(wrongMethod.body?.error?.message ?? '').slice(0, 80)}`);

  const sessionRead = await call('GET', `/api/dsh-super-memory/session?workspace=${encodeURIComponent(workspace)}&session=${SESSION_ID}`);
  check('GET /session?workspace=&session= → 200（参数化路径真的走到了）',
    sessionRead.status === 200 && sessionRead.body?.ok === true,
    `HTTP ${sessionRead.status} ${JSON.stringify(sessionRead.body?.error ?? '')?.slice(0, 160)}`);
  check('读请求仍然能正常服务该会话（GET 不做持久写也照样可用）',
    sessionRead.body?.value?.workspace === workspace,
    `实际=${sessionRead.body?.value?.workspace}`);

  const searchRead = await call('GET', `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workspace)}&session=${SESSION_ID}&query=${encodeURIComponent('host-smoke 参数化路径探针')}`);
  check('GET /search?…&query= → 200（第二条带参路径）',
    searchRead.status === 200 && searchRead.body?.ok === true,
    `HTTP ${searchRead.status} ${JSON.stringify(searchRead.body?.error ?? '')?.slice(0, 160)}`);

  /* ── P2-3：`/search` 的 minScore 必须有下界与上界 ────────────────────────
   * 这条路由的 `minScore` 直接来自 URL：`?minScore=-5` 比任何分数都小 → 全部候选都算"命中"，
   * 等于**用一个 URL 参数把命中阈值关掉**（面板标定会被带偏）；`?minScore=99` 则相反。
   * 现在夹紧到 [0,1]，非有限值回落到当前设置，并在回执里带 `minScoreClamped`。
   * ⚠️ 能失败：把 clamp 改回 `Number(url.searchParams.get('minScore') ?? current.minScore)`
   *   （只判 isFinite）→ 下面第一条立刻红（minScore 会是 -5）。 */
  const searchBase = `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workspace)}&session=${SESSION_ID}&query=${encodeURIComponent('host-smoke 参数化路径探针')}`;
  const negScore = await call('GET', `${searchBase}&minScore=-5`);
  check('P2-3 负数 minScore 被夹到 0（不能用一个 URL 参数把阈值关掉）',
    negScore.body?.value?.minScore === 0 && negScore.body?.value?.minScoreClamped === true,
    `minScore=${negScore.body?.value?.minScore} clamped=${negScore.body?.value?.minScoreClamped}`);
  const hugeScore = await call('GET', `${searchBase}&minScore=99`);
  check('P2-3 minScore > 1 被夹到 1', hugeScore.body?.value?.minScore === 1, `minScore=${hugeScore.body?.value?.minScore}`);
  const nanScore = await call('GET', `${searchBase}&minScore=abc`);
  check('P2-3 非数字 minScore 回落到当前设置（不是 NaN、也不是 0）',
    Number.isFinite(nanScore.body?.value?.minScore) && nanScore.body.value.minScore > 0
    && nanScore.body?.value?.minScoreClamped === false,
    `minScore=${nanScore.body?.value?.minScore} clamped=${nanScore.body?.value?.minScoreClamped}`);

  // ⚠️ **能失败的验证（第 4 项要求的"能失败的验证"）**：去掉 GET 分支里的
  // `{persist:false}`（也就是让读请求重新走会写盘的那条登记）→ 这里的
  // "设置文件没被改写"会变红。这条是"GET 不产生持久写副作用"的正向证据。
  const settingsFile = join(tempHome, 'dsh-super-memory.settings.json');
  const settingsMtimeBefore = existsSync(settingsFile) ? statSync(settingsFile).mtimeMs : null;
  // 不带 workspace 再打一次：走的是"从会话日志读 cwd + 登记"那条兜底路径（读请求）
  const sessionByCwd = await call('GET', `/api/dsh-super-memory/session?session=${SESSION_ID}`);
  const settingsMtimeAfter = existsSync(settingsFile) ? statSync(settingsFile).mtimeMs : null;
  check('GET 走 cwd 兜底路径也能 200（不做持久写也照样服务该请求）',
    sessionByCwd.status === 200 && sessionByCwd.body?.value?.workspace === workspace,
    `HTTP ${sessionByCwd.status} workspace=${sessionByCwd.body?.value?.workspace}`);
  check('连续 GET 前后设置文件 mtime 不变（读请求不产生持久写副作用）',
    settingsMtimeBefore === settingsMtimeAfter,
    `before=${settingsMtimeBefore} after=${settingsMtimeAfter}`);

  /* ───────────────────────────────────────────────────────────────────────
   * ⑥ 诊断日志不含提问明文（只落 queryHash + queryChars）
   *
   * 历史版本把 `queryHead`（提问前 60 字符**明文**）写进 `$DSH_HOME` 的诊断日志 ——
   * 那是一个跨工作区汇聚的文件。这一节同时钉正反两面：
   *   · 有：最后一条 recall 事件的 `queryHash` 等于该问题的 sha256 前 8 位、`queryChars` 等于归一化长度；
   *   · 无：整个诊断文件里**没有任何** `queryHead` 字段（改回明文必然变红）。
   *
   * ⚠️ **能失败的验证**：把 `logScore` 的 `queryHash` 改回 `queryHead: query.text…` → 两条都红。
   */
  console.log('\n⑥ 诊断日志：提问只留哈希与长度');
  const diagFile = join(tempHome, 'dsh-super-memory.diag.jsonl');
  const question = 'host-smoke 探针';
  const searchProbe = await call('GET', `/api/dsh-super-memory/search?workspace=${encodeURIComponent(workspace)}&session=${SESSION_ID}&query=${encodeURIComponent(question)}`);
  check('（探针）带 query 的 GET /search 真的触发了诊断写入', searchProbe.status === 200, `HTTP ${searchProbe.status}`);

  // 真正会落 `recall` 统计的是**提问路径**（`systemPrompt.context().text()` → runRecall →
  // logScore）。所以这里用一条最小 user/message 事件问一次，让那条诊断真的写出来。
  const askSession = {
    id: SESSION_ID,
    header: { cwd: workspace },
    snapshotEvents: () => [{
      type: 'user/message', seq: 100, time: Date.now(),
      data: { content: [{ type: 'text', text: question }], source: { kind: 'user', rpcId: 'hostsmoke-rpc' }, role: 'user', id: 'q-hostsmoke' },
    }],
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const injectedText = provider.text({ agent: { session: askSession } });
  check('（探针）提问路径真的产出了注入文本或空串（没抛错）', typeof injectedText === 'string');

  // 写完再读（顺序很重要：先读会读到还没写 recall 的旧文件）
  const diagEntries = readFileSync(diagFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const recalls = diagEntries.filter((entry) => entry.event === 'recall');
  const lastRecall = recalls[recalls.length - 1] ?? null;
  console.log(`   （探针）诊断事件：${[...new Set(diagEntries.map((entry) => entry.event))].join(',')}`);
  check('诊断路径真的跑了（至少写了一条 recall 事件）', lastRecall !== null,
    `事件：${[...new Set(diagEntries.map((entry) => entry.event))].join(',')}`);
  check('recall 事件带 queryHash（8 位十六进制）',
    typeof lastRecall?.queryHash === 'string' && /^[0-9a-f]{8}$/.test(lastRecall.queryHash),
    JSON.stringify(lastRecall));
  check('queryHash 与提问的哈希一致（同一段文本稳定同哈希）',
    lastRecall?.queryHash === shortHash(question),
    `实际=${lastRecall?.queryHash} 期望=${shortHash(question)}`);
  check('queryChars 是提问的字符数（排障仍能分辨"空查询/长短问句"）',
    lastRecall?.queryChars === question.length, `实际=${lastRecall?.queryChars} 期望=${question.length}`);
  check('recall 事件不再带 queryHead 明文字段', lastRecall !== null && !('queryHead' in lastRecall),
    JSON.stringify(lastRecall));
  check('整个诊断文件里没有任何 queryHead 字段（历史明文不许残留）',
    diagEntries.every((entry) => !('queryHead' in entry)),
    diagEntries.filter((entry) => 'queryHead' in entry).map((entry) => entry.event).join(','));

  /* ── ⑥b P1-C：非提问的队列消息不得顶替真提问 ─────────────────────────────
   * 场景按**真实日志的顺序**复现（先真提问、后通知插进同一个队列）：
   *   ① `agent/inbox/spliced` 送来人类提问（source 带 rpcId）→ 应为本轮查询；
   *   ② 同一个队列随后插进一条**宿主代发的后台任务通知**
   *      （`kind:'user'`、无 rpcId —— 本机 50/50 条这种形状全是派单，没有一条是提问）
   *      → 旧口径会把它也当提问、覆盖 pendingQuery，于是本轮检索用的是通知那段噪声。
   * 观测点用宿主自己的诊断（`recall.queryHash` / `queryChars`，不落明文）：
   * 断言实际检索的查询就是真提问。
   * ⚠️ 能失败：删掉 `questionTextOf` 的 rpcId 闸门（或把拼接处的 rpcId 复核去掉）→
   *   查询哈希变成通知那段 → 两条全红。
   */
  const realQuery = 'P1C 真提问：跨压缩记忆的注入成本上限到底是多少';
  const noticeQuery = 'background job pwsh-99 (node scripts/harness.mjs …) 已完成，退出码 0';
  // seq 按真实顺序：inbox 里的提问**早于**它落库（8000 < 9000），后台任务通知更晚（9002）。
  const p1cSeq = { inboxQuestion: 8000, committed: 9000, notice: 9002 };
  const p1cSession = {
    id: SESSION_ID,
    header: { cwd: workspace },
    snapshotEvents: () => [{
      type: 'user/message', seq: p1cSeq.committed, time: Date.now(),
      data: { content: [{ type: 'text', text: realQuery }], source: { kind: 'user', rpcId: 'p1c-real-rpc' }, role: 'user', id: 'q-p1c' },
    }],
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  const inboxItem = (text, source, seq) => ({
    type: 'agent/inbox/spliced',
    seq,
    time: Date.now(),
    data: {
      target: 'next-turn',
      inserted: [{ content: [{ type: 'text', text }], source, role: 'user', id: `inbox-${seq}` }],
    },
  });
  emit(p1cSession, inboxItem(realQuery, { kind: 'user', rpcId: 'p1c-real-rpc' }, p1cSeq.inboxQuestion));
  emit(p1cSession, inboxItem(noticeQuery, { kind: 'user' }, p1cSeq.notice));
  provider.text({ agent: { session: p1cSession } });
  const p1cEntries = readFileSync(diagFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry) => entry?.event === 'recall' && entry.session === SESSION_ID);
  const p1cLast = p1cEntries[p1cEntries.length - 1] ?? null;
  check('⑥b （前提）通知插进队列后确实又跑了一次检索并落了诊断',
    p1cLast !== null && p1cLast.queryHash === shortHash(realQuery),
    `实际 hash=${p1cLast?.queryHash} chars=${p1cLast?.queryChars}；真提问 hash=${shortHash(realQuery)}/${realQuery.length}，通知 hash=${shortHash(noticeQuery)}/${noticeQuery.length}`);
  check('⑥b 通知不得顶替真提问：查询身份仍是真提问（不是那段通知）',
    p1cLast?.queryHash !== shortHash(noticeQuery),
    `实际=${p1cLast?.queryHash}`);
  check('⑥b 查询长度也是真提问的长度（没把通知拼进去）',
    p1cLast?.queryChars === realQuery.length,
    `实际=${p1cLast?.queryChars} 期望=${realQuery.length}`);

  /* ── ⑥c P2-1：`/diagnostics` 的来源校验 + 会话过滤（会话内 ✕ 按钮的数据来源）────
   * 这条路由会回传"这个会话上一个问题"的**原文**。要求（只读审查 P2-1）：
   *   ① 不带那个自定义头 → 拒（本机任意进程不能直接 GET 读用户提问原文）；
   *   ② 点名了 session → 只回**这一个**会话的文本，且长度受限；
   *   ③ 没点名 → 只回计数器，任何提问文本都不下发；
   *   ④ 同时**✕ 功能必须仍然可用**：点名 session 时必须能真的拿到那句问题。
   * 观测点：真打路由（合成 req/res），不是桩。
   * ⚠️ 能失败：去掉 `panelReadGuard` → 第一条红；去掉会话过滤 → 第三条红。
   */
  // 先造一次**真命中**：投一份含探针原文的压缩摘要，再问那一句 ——
  // `lastRecallQuery` 只在命中时才写，所以这是 ✕ 按钮真正的数据来源。
  const p21Probe = 'P2-1 探针：跨压缩记忆的注入成本上限是多少';
  const p21Session = {
    id: SESSION_ID,
    header: { cwd: workspace },
    snapshotEvents: () => [{
      type: 'user/message', seq: 5000, time: Date.now(),
      data: { content: [{ type: 'text', text: p21Probe }], source: { kind: 'user', rpcId: 'p21-rpc' }, role: 'user', id: 'q-p21' },
    }],
    requestContext: () => ({ contextWindow: 1000000 }),
  };
  emit(emitSession, {
    type: 'compaction/summary',
    seq: 77,
    time: Date.now(),
    data: {
      compactionId: 'hostsmoke-p21',
      turn: 2,
      shadowedRange: { start: 70, end: 76 },
      shadowedTokenCount: 900,
      summary: [{ type: 'text', text: `# 注入成本\n${p21Probe}。结论：单轮注入上限是 700 token。`.repeat(4) }],
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  // 走**真实提问路径**：先让 inbox 送来这一问（这是 DSH 里提问最早出现的形态），
  // 否则上一条 ⑥b 留在 pending 里的问题会盖住它（那正是 P1-C 描述的机制）。
  emit(p21Session, {
    type: 'agent/inbox/spliced',
    seq: 5001,
    time: Date.now(),
    data: {
      target: 'next-turn',
      inserted: [{ content: [{ type: 'text', text: p21Probe }], source: { kind: 'user', rpcId: 'p21-rpc' }, role: 'user', id: 'inbox-p21' }],
    },
  });
  const p21Injected = provider.text({ agent: { session: p21Session } });
  check('⑥c （前提）探针问题真的命中了（否则 lastQuery 恒为空，下面的断言会假绿）',
    p21Injected.includes(RECALL_HEAD_PREFIX), `注入 ${p21Injected.length} 字符`);

  const diagNoHeader = await call('GET', `/api/dsh-super-memory/diagnostics?session=${SESSION_ID}`, undefined, { 'x-dsh-super-memory': '' });
  check('⑥c 不带来源标记的 GET /diagnostics → 403 forbidden',
    diagNoHeader.status === 403 && diagNoHeader.body?.error?.code === 'forbidden',
    `HTTP ${diagNoHeader.status} code=${diagNoHeader.body?.error?.code}`);
  const diagScoped = await call('GET', `/api/dsh-super-memory/diagnostics?session=${SESSION_ID}&limit=1`);
  const scopedRows = diagScoped.body?.value?.runtime ?? [];
  check('⑥c 带标记 + 点名 session → 只回该会话（不是所有进程内会话）',
    diagScoped.status === 200 && scopedRows.length === 1 && scopedRows[0]?.sessionId === SESSION_ID,
    `HTTP ${diagScoped.status} rows=${scopedRows.map((row) => row.sessionId).join(',') || '(空)'}`);
  check('⑥c ✕ 路径仍能拿到"上一个问题"文本（点名 session 时）',
    scopedRows[0]?.lastQuery === p21Probe,
    `实际=${JSON.stringify(scopedRows[0]?.lastQuery)}`);
  const diagGlobal = await call('GET', '/api/dsh-super-memory/diagnostics?limit=1');
  const globalRows = diagGlobal.body?.value?.runtime ?? [];
  check('⑥c 没点名 session 时任何提问文本都不下发（只回计数器）',
    diagGlobal.status === 200 && Array.isArray(globalRows) && globalRows.every((row) => row.lastQuery === ''),
    `rows=${globalRows.length} 非空文本=${globalRows.filter((row) => row.lastQuery !== '').length}`);
  check('⑥c 回执里带过滤条件（服务端确实按会话过滤，不是客户端挑的）',
    diagScoped.body?.value?.filtered?.session === SESSION_ID,
    JSON.stringify(diagScoped.body?.value?.filtered));
} catch (error) {
  check('④⑤⑥ 段整体执行不抛错', false, String(error?.stack ?? error).split('\n').slice(0, 4).join(' / '));
} finally {
  // 临时目录用完就清（异常路径也清）—— 本机曾残留几十个 dsm-* 临时目录就是漏了这一步。
  // DSH_HOME 也要还原：它会影响同一个进程里后续任何模块的读路径。
  delete process.env.DSH_HOME;
  delete process.env.DSH_SUPER_MEMORY_HOME;
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清不掉不影响判定 */ }
  }
  check('④⑤⑥ 段的临时目录已清理', tempDirs.every((dir) => !existsSyncSafe(dir)),
    tempDirs.filter((dir) => existsSyncSafe(dir)).join(', '));
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log('全部通过。');
}
