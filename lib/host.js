/**
 * dsh-super-memory — 宿主半边（设置面板标题「超级记忆」）
 *
 * 核心三件事（成本红线）：① 压缩时入库（默认 0 模型调用；开了模型辅助则给每块补几个
 * 关键词）；② 压缩后注入 ≤300 token 的自适应总览（可为 0）；③ 提问时本地检索、命中才
 * 注入（单轮 ≤500 token、≤2 条、每条 ≤300 字符）。未命中一分不花；原文只在用户明确要求时
 * 由 history_read 读取。
 *
 * 边界：**只读会话日志、不写入**（记忆另存于工作区的 .dsh-compaction-memory 里）+
 * 只在 `systemPrompt.context()` 提供一个运行时上下文块；不改写会话内容、不依赖任何其他
 * 记忆插件。模型调用**默认关闭**，可选开启后只在两个时机发生（压缩时扩写关键词 / 用户点 ✕
 * 时再搜一遍并判强相关）；**不访问互联网**，只经 DSH 的模型服务。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticsLog, SettingsStore, defaultSettingsPath, resolveDshHome, resolveDataHome } from './config.js';
import { appendRecords, audit, fingerprint, patchKeywords, purgeTrashOlderThan, readRecords, safeSessionId, storeRoot } from './store.js';
import { conversationTurns, rawRecords, summaryRecords } from './ingest.js';
import { createLlmGateway, mergeKeywords } from './llm.js';
import { MemoryIndex, retrieveTwoTier } from './retrieval.js';
import { buildRecap } from './recap.js';
import { collectQuery, formatRecall, questionTextOf, queryTextOf } from './recall.js';
import { estimateTokens, jaccard, tokenSet } from './text.js';
import { readSessionEvents, sessionLogBytes } from './zstd.js';
import { makeRoutes } from './routes.js';

/** 上下文块在运行时上下文里的排序位置（在所有内建 context 之后，追加在快照末尾）。 */
const CONTEXT_ORDER = 900;
/** 上下文块注册名。 */
const CONTEXT_NAME = 'plugin:dsh-super-memory';
/** history_read 单次返回的字符上限。 */
const HISTORY_MAX_CHARS = 12000;
/** history_read 回落到原始会话日志时的体积上限（超过就拒读，避免同步解压卡死宿主）。 */
const HISTORY_LOG_MAX_BYTES = 64 * 1024 * 1024;
/** 进程内最多保留多少个会话的派生状态（LRU；记忆本体在磁盘上，淘汰不丢数据）。 */
const MAX_STATES = 24;
/**
 * 构建标记：直接读 package.json 的版本号，避免"手写常量忘了跟着改"。
 * 用途是回答"现在跑的是哪份代码"——写进诊断日志的 `load` 事件，面板标题栏也会显示。
 */
const BUILD = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version !== '' ? `v${pkg.version}` : 'unknown';
  } catch {
    return 'unknown';
  }
})();

/**
 * 挂载前必须先就位的服务：工具注册表、系统提示/上下文注册表、HTTP 载体。
 * 缺任何一个这个插件都无法工作，所以声明为硬依赖（Cordis 会等它们出现）。
 */
export const inject = ['tools', 'systemPrompt', 'webServer'];

/** 读取会话工作区（cwd）。 */
function workspaceOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/**
 * 从**会话日志的事件数组**里取这个会话自己的 cwd（只读；取不到返回 ''）。
 *
 * 实测依据（2026-10-07，把本机 61 份真实会话日志逐份扫了一遍）：每份的首行都是会话头
 * `{"type":"session","version":4,"id":"…","createdAt":…,"cwd":"E:\\软件\\DeepSeek Harness",…}`，
 * 即 cwd 在**顶层**字段（同一行的 `data.*` 里没有 cwd），61/61 份都能读到。
 * 注意 v4 的这行头记录本身是合法 JSON 且带 `type`，所以 `readSessionEvents` 会把它
 * 保留成一条事件（不是被跳过的那类"首行"）。
 * @param {object[]} events - 会话日志事件（`readSessionEvents().events`）。
 * @returns {string} cwd；读不到时 ''。
 */
function sessionLogCwd(events) {
  if (!Array.isArray(events)) return '';
  for (const event of events) {
    if (event?.type !== 'session') continue;
    const cwd = event.cwd;
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd.trim();
  }
  return '';
}

/** 读取 DSH 的工作区注册表（只读；不存在或损坏就忽略）。 */
function readWorkspaceRegistry() {
  const out = [];
  try {
    const path = join(resolveDshHome(), 'storages', 'workspace.json');
    if (!existsSync(path)) return out;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const table = parsed?.tables?.workspaces ?? {};
    for (const entry of Object.values(table)) {
      if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') out.push(entry.path);
    }
  } catch { /* 忽略 */ }
  return out;
}

/**
 * 宿主插件入口。
 * @param {object} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  const settings = new SettingsStore({ path: defaultSettingsPath() });
  const diag = new DiagnosticsLog({ enabled: true });
  /** 插件全局数据目录（设置/诊断/模型调用计数与缓存在这里；记忆本体在工作区）。 */
  const dataHome = resolveDataHome();
  // 装载回执：确认当前代码真的被加载了（排查模块缓存 / 热重载问题时最直接的证据）。
  // 写进诊断日志本身，不再另开 $DSH_HOME 下的文件——插件不往 C 盘丢多余文件。
  try {
    diag.write({
      at: new Date().toISOString(),
      event: 'load',
      build: BUILD,
      pid: process.pid,
      file: import.meta.url,
    });
  } catch { /* 回执失败不影响插件 */ }
  /** 每个会话的派生状态（进程内缓存；记忆本体在磁盘上）。 */
  const states = new Map();
  /** 本进程见过的会话工作区。 */
  const seenWorkspaces = new Set();

  /**
   * 可选的模型服务：用 `ctx.inject` 拿，**不写进插件级 `inject`**。
   * 写进去会让"没有 llm 服务的 profile"里整个插件不加载 —— 记忆功能会跟着一起消失；
   * 用注入回调则是"有就用、没有就降级"。
   */
  let llmCtx = null;
  const llmGateway = createLlmGateway({
    getLlm: () => llmCtx?.llm ?? null,
    getSettings: () => settings.get().settings,
    diag,
    usagePath: join(dataHome, 'dsh-super-memory.llm-usage.json'),
    cachePath: join(dataHome, 'dsh-super-memory.llm-cache.json'),
    tracePath: join(dataHome, 'dsh-super-memory.llm.jsonl'),
  });
  ctx.inject(['llm'], (scoped) => {
    llmCtx = scoped;
    return () => { if (llmCtx === scoped) llmCtx = null; };
  });

  // 「写打分日志」只控制**每条召回的打分日志**（`logScore` → `write(…, {scoring:true})`）。
  // 错误 / 入库 / 加载类事件不受它影响，始终落盘：那些是排查"为什么没想起来"的唯一证据。
  diag.enabled = settings.get().settings.logScores !== false;

  /** 已知工作区：面板登记过的 + DSH 工作区注册表 + 本进程见过的。 */
  function knownWorkspaces() {
    const out = [];
    const push = (value) => {
      if (typeof value !== 'string' || value === '') return;
      if (!out.includes(value)) out.push(value);
    };
    for (const value of settings.get().settings.knownWorkspaces ?? []) push(value);
    for (const value of readWorkspaceRegistry()) push(value);
    for (const value of seenWorkspaces) push(value);
    return out;
  }

  /** 按需清理过期的回收站条目。 */
  function sweepTrash(current) {
    if (!current.trashAutoPurgeEnabled) return;
    for (const workspace of knownWorkspaces().slice(0, 40)) {
      try {
        const root = storeRoot(workspace, current.storeDir);
        if (!existsSync(root)) continue;
        const result = purgeTrashOlderThan(root, current.trashAutoPurgeDays);
        if (result.entries > 0) {
          audit(root, { action: 'trash-auto-purge', entries: result.entries, bytes: result.bytes, days: current.trashAutoPurgeDays });
          diag.write({ at: new Date().toISOString(), event: 'trash-auto-purge', root, entries: result.entries, bytes: result.bytes });
        }
      } catch { /* 自动清空失败不影响主流程 */ }
    }
  }

  settings.subscribe(({ settings: next }) => {
    // 同上：只切换"打分日志"这一类，其余事件照写（见 config.js DiagnosticsLog.write）
    diag.enabled = next.logScores !== false;
    if (next.trashAutoPurgeEnabled) sweepTrash(next);
  });

  /**
   * 当前会话的派生状态（带 LRU 上限）。
   *
   * 客户端可能连开几天、几百个会话，而每个 state 里都挂着记忆索引（最大那个）：
   * 不设上限就是慢性内存泄漏。这里按"最近使用"淘汰，只留最近 MAX_STATES 个会话；
   * 被淘汰的会话下次用到会重新从磁盘加载（记忆本体在磁盘上，不丢数据）。
   *
   * **key 带上工作区**：记忆库是按工作区隔离的，派生状态（索引、总览文本、粘住的
   * 参考块、已注入指纹）也必须跟着隔离——只按会话 id 做 key 的话，同一个 id 换个
   * 工作区就会读到上一个工作区的总览与参考块。
   */
  function stateFor(session) {
    const id = String(session?.id ?? '');
    const workspace = workspaceOf(session);
    const key = `${workspace}\u0000${id}`;
    const existing = states.get(key);
    if (existing !== undefined) {
      // 重新插入以刷新 LRU 顺序
      states.delete(key);
      states.set(key, existing);
      return existing;
    }
    const state = {
      id,
      workspace,
      session,
      root: null,
      index: null,
      indexKey: '',
      knownCompactions: new Set(),
      knownFps: new Set(),
      backfilled: false,
      recall: null,
      pendingQuery: null,
      stickyRecall: '',
      injectedFps: new Set(),
      injectedTexts: [],
      injectedTokens: 0,
      recapKey: '',
      recapText: '',
      recapCounted: '',
      pendingRecap: false,
      /** 「✕」排进的**下一轮**参考（只注入一次；整轮文本稳定，轮次结束才清）。 */
      nextTurnBoost: '',
      /** 本轮是否已经注入过 boost（**按轮计费一次**；也是"该清空了"的标记）。 */
      boostConsumed: false,
      /** boost 被排进队列时所在的轮次号（用于"跨轮才清"，见 turn/end 分支）。 */
      boostQueuedTurn: 0,
      /** 当前的轮次号（turn/start、turn/end 事件都会刷新）。 */
      currentTurn: 0,
      lastRecallQuery: '',
      hits: 0,
      misses: 0,
    };
    states.set(key, state);
    while (states.size > MAX_STATES) {
      const oldest = states.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      states.delete(oldest);
    }
    return state;
  }

  /**
   * 确保会话的记忆库已加载、必要时回填（0 模型调用、不依赖 zstd）。
   * @returns {MemoryIndex} 索引。
   */
  function ensureStore(session, current, state) {
    const workspace = workspaceOf(session);
    seenWorkspaces.add(workspace);
    // 最近的会话工作区排在最前，面板据此把"当前工作区"置顶
    settings.rememberWorkspace(workspace);
    const root = storeRoot(workspace, current.storeDir);
    state.root = root;
    const file = join(root, `${safeSessionId(state.id)}.jsonl`);
    let key = `${file}:missing`;
    if (existsSync(file)) {
      try {
        const stat = statSync(file);
        key = `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch { /* 忽略 */ }
    }
    if (key === state.indexKey && state.index !== null) return state.index;

    let records = readRecords(root, state.id);
    state.knownCompactions = new Set(
      records.map((record) => String(record.compactionId ?? '')).filter((value) => value !== ''),
    );
    state.knownFps = new Set(records.map((record) => String(record.fp ?? '')));

    if (current.backfillOnStart && !state.backfilled) {
      state.backfilled = true;
      const pending = backfillPlan(session, current, state);
      // `pending === null` = 没有需要补的压缩：什么都不用做，按正常路径建索引即可。
      //
      // **绝不能 `await`**：`ensureStore` 在 `systemPrompt.context().text()` 里被调用，
      // 而那个回调的契约是**同步返回字符串**（`PromptContext.text: (context) => string`）。
      // 所以回填走"先返回、后台补齐"：本次组装先用已有记录，补齐后立刻失效索引，
      // 下一次组装就能看到刚回填的块。
      //
      // 这里曾经写成 `const added = backfill(...)`，而 `backfill` 内部是
      // `added += ingestCompaction(...)`（async）→ `added` 恒为 NaN → `added > 0` 永不成立
      // → 索引永远不刷新、`backfill` 诊断事件永远不写、"冷启动第一次组装看不到回填块"。
      if (pending !== null) {
        void kickBackfill(session, current, state, root, pending).catch((error) => {
          diag.write({
            at: new Date().toISOString(),
            event: 'backfill-error',
            session: state.id,
            message: String(error?.message ?? error),
          });
        });
      }
    }

    state.index = new MemoryIndex(records);
    state.indexKey = key;
    return state.index;
  }

  /**
   * 回填的**同步部分**：只做"排查 + 取摘要文本"（全部本地读，0 模型调用），返回待入库的清单。
   *
   * 把同步部分与异步部分（写盘 + 可选的后台关键词扩写）分开，是因为调用方
   * `ensureStore` 必须同步返回索引：真正落盘发生在 `kickBackfill` 里，写完再让索引失效。
   * @param {object} session - 会话。
   * @param {object} current - 当前设置。
   * @param {object} state - 会话状态。
   * @returns {object[]|null} 待入库的事件清单；`null` 表示不需要回填。
   */
  function backfillPlan(session, current, state) {
    let events = [];
    try {
      events = session.snapshotEvents();
    } catch {
      return null;
    }
    const pending = [];
    // 这里**同步**先记下 compactionId：`kickBackfill` 尚未落盘时，`compaction/summary`
    // 的 live 监听器可能先跑（它同样会 `ensureStore`），同步登记能保证同一批不会入库两次。
    const claimed = new Set(state.knownCompactions ?? []);
    for (const event of events) {
      if (event?.type !== 'compaction/summary') continue;
      const id = String(event.data?.compactionId ?? '');
      if (id === '' || claimed.has(id)) continue;
      claimed.add(id);
      pending.push(event);
    }
    if (pending.length === 0) return null;
    state.knownCompactions = claimed;
    return pending;
  }

  /**
   * 回填的**异步部分**：逐条入库（`ingestCompaction` 会写盘，并在开启扩写时于后台补关键词），
   * 落盘后让索引失效 —— 下一次组装上下文就能看到这些块。
   * @param {object} session - 会话。
   * @param {object} current - 当前设置。
   * @param {object} state - 会话状态。
   * @param {string} root - 记忆库根目录。
   * @param {object[]} pending - `backfillPlan` 给出的待入库事件。
   * @returns {Promise<number>} 真正新增的块数。
   */
  async function kickBackfill(session, current, state, root, pending) {
    let added = 0;
    for (const event of pending) {
      try {
        added += await ingestCompaction(session, event, current, state, 'backfill');
      } catch (error) {
        diag.write({
          at: new Date().toISOString(),
          event: 'backfill-error',
          session: state.id,
          compactionId: String(event?.data?.compactionId ?? ''),
          message: String(error?.message ?? error),
        });
      }
    }
    if (added <= 0) return 0;
    // 让 `ensureStore` 重新读盘（它按 `${file}:${size}:${mtime}` 判缓存）。
    // 清掉之后**不需要**在这里重建索引：下一次组装上下文自然会重建，
    // 而"下次组装"通常就是紧接着的同一步 —— 冷启动第一次组装看不到回填块的问题就此消失。
    state.index = null;
    state.indexKey = '';
    const total = (() => {
      try { return readRecords(root, state.id).length; } catch { return null; }
    })();
    // 这行是"回填确实发生了"的唯一证据（面板 ⑥ 的诊断日志里能看到 event=backfill）。
    diag.write({
      at: new Date().toISOString(),
      event: 'backfill',
      session: state.id,
      compactions: pending.length,
      blocks: added,
      blocksTotal: total,
      source: 'backfill',
    });
    return added;
  }

  /**
   * 压缩时入库（0 模型调用）：L1 用现成摘要，L2 取被压掉那段的对话文字。
   * @returns {number} 新增块数。
   */
  async function ingestCompaction(session, event, current, state, source = 'live') {
    const data = event?.data ?? {};
    const compactionId = String(data.compactionId ?? '');
    if (compactionId === '') return 0;
    const root = storeRoot(workspaceOf(session), current.storeDir);
    const at = new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString();
    const records = [];
    if (current.ingestSummary) {
      records.push(...summaryRecords({
        sessionId: state.id,
        compactionId,
        at,
        turn: typeof data.turn === 'number' ? data.turn : null,
        seqRange: data.shadowedRange ? [data.shadowedRange.start, data.shadowedRange.end] : null,
        shadowedTokenCount: data.shadowedTokenCount,
        summary: data.summary,
      }));
    }
    let rawInfo = { records: [], chars: 0, truncated: false };
    if (current.ingestRawText) {
      try {
        rawInfo = rawRecords({
          session,
          sessionId: state.id,
          compactionId,
          at,
          turn: typeof data.turn === 'number' ? data.turn : null,
          range: data.shadowedRange,
          shadowedTokenCount: data.shadowedTokenCount,
          settings: current,
        });
      } catch (error) {
        // 绝不静默：这里出错意味着**整段 L2 原文没入库**，用户只会觉得"这插件想不起来"。
        diag.write({
          at: new Date().toISOString(),
          event: 'raw-error',
          session: state.id,
          compactionId,
          message: String(error?.message ?? error),
        });
        rawInfo = { records: [], chars: 0, truncated: false };
      }
      records.push(...rawInfo.records);
    }
    if (records.length === 0) return 0;
    // 同一会话里内容完全相同的块不重复入库（重试/重新生成会产生重复原话）
    const knownFps = state.knownFps ?? new Set();
    const fresh = records.filter((record) => {
      const fp = String(record.fp ?? '');
      return fp !== '' && !knownFps.has(fp);
    });
    if (fresh.length === 0) return 0;
    // 先把块写进磁盘，**成功之后**才登记指纹：否则一旦写入失败（磁盘满/只读盘/权限），
    // 这些块在本进程里会被永久当成"已入库"，既不再重试也不会补写——静默丢数据。
    appendRecords(root, state.id, fresh);
    for (const record of fresh) knownFps.add(String(record.fp ?? ''));
    state.knownFps = knownFps;
    state.knownCompactions.add(compactionId);
    state.indexKey = ''; // 强制下次重新加载索引
    state.index = null;
    diag.write({
      at: new Date().toISOString(),
      event: 'ingest',
      source,
      session: state.id,
      compactionId,
      layer: {
        summary: fresh.filter((record) => record.layer === 'summary').length,
        raw: fresh.filter((record) => record.layer === 'raw').length,
      },
      toolKept: rawInfo.toolKept ?? 0,
      toolChars: rawInfo.toolChars ?? 0,
      toolSkipped: rawInfo.toolSkipped ?? 0,
      skippedDuplicates: records.length - fresh.length,
      rawChars: rawInfo.chars,
      rawTruncated: rawInfo.truncated,
      shadowedTokenCount: data.shadowedTokenCount ?? null,
      modelCalls: 0,
    });
    // ① 可选：模型扩写关键词（后台补齐；失败/超时/日限都只是"这次没扩"，原有词频照旧）
    if (current.llmAssistEnabled && current.llmIngestExpand) {
      await expandKeywordsInBackground(session, current, state, root, fresh);
    }
    return fresh.length;
  }

  /**
   * 后台扩写：给刚入库的块生成"用户可能怎么问这块内容"，并按指纹并进 `keywords`。
   *
   * 调用量与成本：每批 `llmIngestBatchBlocks` 块一次调用，计入 `llmDailyCallCap`；
   * 结果直接落进块里，因此**同一块永远不会重复扩写**（指纹已在库里）。
   * @param {object} session - 会话。
   * @param {object} current - 当前设置。
   * @param {object} state - 会话状态。
   * @param {string} root - 记忆库根目录。
   * @param {object[]} fresh - 本次新入库的块。
   * @returns {Promise<number>} 实际并进新词的块数。
   */
  async function expandKeywordsInBackground(session, current, state, root, fresh) {
    const batchSize = Math.max(1, Math.min(50, Number(current.llmIngestBatchBlocks) || 5));
    // 太短的块没有扩写价值（标题类），跳过能省调用
    const targets = fresh.filter((record) => String(record.text ?? '').length >= 120);
    let enriched = 0;
    let calls = 0;
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      const batch = targets.slice(offset, offset + batchSize);
      const result = await llmGateway.expandKeywords({ session, blocks: batch });
      calls += 1;
      if (!result.ok) {
        diag.write({
          at: new Date().toISOString(),
          event: 'llm-expand',
          session: state.id,
          ok: false,
          code: result.code,
          hint: result.hint ?? null,
          batch: batch.length,
          at_offset: offset,
        });
        // 服务不可用/被限流/到日限：后面的批次不必再试
        break;
      }
      const updates = new Map();
      for (const [index, terms] of result.byIndex) {
        const record = batch[index];
        if (record === undefined) continue;
        updates.set(String(record.fp), mergeKeywords(record.keywords, terms, 10));
      }
      if (updates.size === 0) continue;
      try {
        enriched += patchKeywords(root, state.id, updates);
      } catch { /* 并词失败只影响检索质量，不影响已入库的块 */ }
    }
    if (calls > 0) {
      state.index = null;
      state.indexKey = '';
      diag.write({
        at: new Date().toISOString(),
        event: 'llm-expand',
        session: state.id,
        ok: enriched > 0,
        calls,
        enriched,
        candidates: targets.length,
      });
    }
    return enriched;
  }

  /** 找到某个会话的记忆库根目录（先当前会话，再已知工作区）。 */
  function resolveRoot(sessionId, sessionHint) {
    const current = settings.get().settings;
    if (sessionHint !== null && String(sessionHint.id) === String(sessionId)) {
      return storeRoot(workspaceOf(sessionHint), current.storeDir);
    }
    for (const workspace of knownWorkspaces()) {
      const root = storeRoot(workspace, current.storeDir);
      if (existsSync(join(root, `${safeSessionId(sessionId)}.jsonl`))) return root;
    }
    return sessionHint !== null ? storeRoot(workspaceOf(sessionHint), current.storeDir) : null;
  }

  // ── ① 压缩时入库 ─────────────────────────────────────────────────────────
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      const current = settings.get().settings;
      if (!current.enabled) return;
      const state = stateFor(session);
      // 提问一到就记下来。两条来源，缺一不可：
      //   ① `agent/inbox/spliced`（target=next-turn）—— 实测比 `user/message` 早 3.4 秒，
      //      而 DSH 求值运行时上下文就在这 3.4 秒窗口里；只监听 ② 会永远慢一档。
      //   ② `user/message`（kind=user）—— 正常落库路径，也是 ① 的确认。
      if (event?.type === 'agent/inbox/spliced') {
        const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
        for (const item of inserted) {
          const text = questionTextOf(item);
          if (text !== '') rememberPending(state, Number(event.seq) || 0, text);
        }
        return;
      }
      if (event?.type === 'user/message') {
        const text = queryTextOf(event);
        if (text !== '') rememberPending(state, Number(event.seq) || 0, text);
        return;
      }
      if (event?.type === 'compaction/summary') {
        if (!current.ingestSummary && !current.ingestRawText) return;
        // 先确保已加载库内已有的 compactionId / 指纹，避免重复入库
        ensureStore(session, current, state);
        // 监听器是**观测者**（DSH 不 await 返回值），所以这里可以安全地 await 模型调用：
        // 块先写盘、马上可检索；可选的关键词扩写在写盘后于后台补齐，绝不阻塞宿主。
        // 注：可读文档**只在用户点 ✕ 的「打开原文」时生成一份"相关段落摘抄"**
        // （短、逐字、0 token）。早先设想的"每次压缩落一份整会话抄本"经用户判定取消，
        // 所以这里不再有任何存档动作（也不留开关）。
        void ingestCompaction(session, event, current, state, 'live').catch((error) => {
          diag.write({ at: new Date().toISOString(), event: 'ingest-error', session: state.id, message: String(error?.message ?? error) });
        });
      } else if (event?.type === 'compaction/end') {
        state.pendingRecap = true;
        state.stickyRecall = '';
        if (current.trashAutoPurgeEnabled) sweepTrash(current);
      } else if (event?.type === 'compaction/prune' && current.includePrune) {
        diag.write({
          at: new Date().toISOString(),
          event: 'prune',
          session: state.id,
          shadowedRange: event.data?.shadowedRange ?? null,
          shadowedTokenCount: event.data?.shadowedTokenCount ?? null,
        });
      } else if (event?.type === 'turn/start') {
        state.currentTurn = Number(event.data?.turn) || state.currentTurn;
      } else if (event?.type === 'turn/end') {
        const turn = Number(event.data?.turn) || state.currentTurn;
        state.currentTurn = turn;
        // 「✕」注入的参考只服务它被注入的那一轮，轮次一结束就丢弃。
        // 清空点放在这里（而不是组装上下文时）：组装每个 step 都会跑，早清会让
        // 真正作答的那一步看不到它，且文本一跳变就多追加一份上下文快照。
        // 条件是 `boostQueuedTurn < turn`：✕ 是在某一轮**进行中**被点的话
        // （那时该轮的剩余 step 就会带上它），要留到**下一轮**也看得见。
        if (state.boostConsumed === true && state.boostQueuedTurn < turn) {
          state.nextTurnBoost = '';
          state.boostConsumed = false;
        }
      }
    } catch (error) {
      diag.write({ at: new Date().toISOString(), event: 'ingest-error', message: String(error?.message ?? error) });
    }
  }), 'dsh-super-memory: compaction ingest');

  // ── ②③ 运行时上下文注入（压缩后总览 / 提问时召回） ─────────────────────────
  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (context) => {
      try {
        return buildContext(context, settings.get().settings, stateFor, ensureStore, diag);
      } catch (error) {
        diag.write({ at: new Date().toISOString(), event: 'context-error', message: String(error?.message ?? error) });
        return '';
      }
    },
  }), 'dsh-super-memory: runtime context');

  // ── 显式工具：只在用户明确要求查原文时使用 ────────────────────────────────
  ctx.effect(() => ctx.tools.register(historyReadTool({
    settings,
    resolveRoot,
    diag,
  })), 'dsh-super-memory: history_read');

  /**
   * 按会话 id 拿会话对象：优先用进程内已有的（真实对象，能读事件），
   * 否则从会话日志临时构造一个只读视图（面板可能在本次启动还没收到任何事件时被点）。
   *
   * **cwd 必须一起带上**（实测 2026-10-07：本机 61 份真实会话日志**逐份**扫过，61/61 的首行
   * `type:"session"` 头记录里都有顶层 `cwd` 字段；`$DSH_HOME/storages/workspace.json` 里只有
   * 工作区注册表、不含 cwd，所以要靠日志本身）：形如
   * `{"type":"session","version":4,"id":…,"cwd":"E:\\…"}`，cwd 是**顶层字段**（不是 `data.cwd`）；
   * `readSessionEvents` 会把它当作 `type="session"` 的事件返回。
   * 补这一段的理由：早先这里只返回 `{id, snapshotEvents}`，于是"插件刚重启、面板还没收到
   * 任何会话事件"时 `findSession(id).header.cwd` 恒为 undefined → 面板点 ✕ 只能报"未知工作区"。
   * 注意 cwd 的来源只有**会话日志 / 宿主自己**，绝不采信任何请求体里传来的路径。
   * @param {string} sessionId - 会话 id。
   * @returns {object|null} 会话对象。
   */
  function findSessionById(sessionId) {
    const id = String(sessionId ?? '');
    if (id === '') return null;
    for (const state of states.values()) {
      if (state.id === id) return state.session ?? null;
    }
    try {
      const { events } = readSessionEvents(id);
      if (events.length === 0) return null;
      const cwd = sessionLogCwd(events);
      return {
        id,
        // 只有真的读到才挂 header：否则 workspaceOf() 会把它当成"没有 cwd"而回落到 process.cwd()
        ...(cwd === '' ? {} : { header: { cwd } }),
        snapshotEvents: () => events,
      };
    } catch { return null; }
  }

  // ── 面板 API ─────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register(makeRoutes({
    settings,
    diag,
    states,
    knownWorkspaces,
    build: BUILD,
    llm: llmGateway,
    dataHome,
    /**
     * 把「✕」找到的资料排进**下一轮**的注入（不显示给用户）。
     * @param {string} sessionId - 会话 id。
     * @param {string} material - 已整理好的资料原文。
     * @returns {boolean} 是否成功排入（找不到会话时 false）。
     */
    boostFor: (sessionId, material) => {
      const text = String(material ?? '').trim();
      if (text === '') return false;
      const session = findSessionById(sessionId);
      if (session === null) return false;
      const state = stateFor(session);
      const root = storeRoot(workspaceOf(session), settings.get().settings.storeDir);
      // 注入文本里**明确要求模型在回答正文里转述**：用户点了 ✕，要的是"你在会话窗口里
      // 告诉我找到了什么"，而不是插件弹个小窗（用户明确要求不要弹窗）。
      state.nextTurnBoost = '⟦mem-hist⟧【本次会话更早（已被压缩）的参考 · 用户点了「✕」后由辅助模型找到】\n'
        + '请在回答正文里**明确告诉用户**：你从本会话"已压缩的历史"里找到了哪些相关内容，'
        + '并引用其中 1–3 句关键原文（太长就取第一句 + 省略号），再结合用户新增的条件回答；'
        + '如果这些内容与问题无关，请直接说明"已压缩的历史里没有相关内容"。\n'
        + `（原始记忆文件：${root}\\${state.id}.jsonl）\n\n${text}`;
      // 记下"排进队列时是哪一轮"：如果 ✕ 是在本轮进行中点下的（本轮剩余 step 就会带上它），
      // 那么本轮结束**不能**清（否则用户下一次提问就看不到了），要留到下一轮。
      state.boostConsumed = false;
      state.boostQueuedTurn = Number(state.currentTurn) || 0;
      diag.write({
        at: new Date().toISOString(),
        event: 'boost-queued',
        session: sessionId,
        chars: text.length,
        injectedChars: state.nextTurnBoost.length,
        turn: state.boostQueuedTurn,
      });
      return true;
    },
    findSession: findSessionById,
    /**
     * 把一个工作区登记为"已知"（**与会话内 ensureStore 的登记口径完全一致**：
     * 本进程见过的集合 + 持久化的已知工作区名单）。
     *
     * 只给面板路由在"workspace 参数为空/未知、而会话日志里能读到 cwd"时用 ——
     * 登记完仍然要走 `resolvePanelRoot()` 的 `knownWorkspaces().includes()` 判定，
     * 不是绕过校验。cwd 的来源只有宿主/会话日志，**绝不采信请求体**。
     * @param {string} workspace - 工作区绝对路径。
     * @returns {boolean} 是否登记成功。
     */
    rememberWorkspace: (workspace) => {
      if (typeof workspace !== 'string' || workspace.trim() === '') return false;
      const value = workspace.trim();
      seenWorkspaces.add(value);
      try { settings.rememberWorkspace(value); } catch { /* 落盘失败不影响本次解析 */ }
      return true;
    },
  })), 'dsh-super-memory: panel routes');

  // 启动时按需清理过期回收站
  try {
    const initial = settings.get().settings;
    if (initial.trashAutoPurgeEnabled) sweepTrash(initial);
  } catch { /* 忽略 */ }

  ctx.effect(() => () => { states.clear(); }, 'dsh-super-memory: state cleanup');
}

/**
 * 记下"当前这一问"。同一条提问会先以 `agent/inbox/spliced` 出现、后以 `user/message` 落库，
 * 文本相同则保留先到的 seq：这样一轮之内查询身份不变，既不会重复检索，也不会让召回块
 * 来回消失又出现（每变一次都要重发一整份上下文快照，那是白花的 token）。
 * @param {object} state - 会话状态。
 * @param {number} seq - 事件 seq。
 * @param {string} text - 提问文本。
 */
function rememberPending(state, seq, text) {
  const previous = state.pendingQuery;
  if (previous !== null && previous !== undefined && previous.text === text) return;
  state.pendingQuery = { seq, text };
}

/**
 * 组装本次的注入文本：压缩后总览 + 命中召回。两者都没有时返回 ''（0 token）。
 * @param {object} context - 系统提示装配上下文。
 * @param {object} current - 当前设置。
 * @param {Function} stateFor - 会话状态取用器。
 * @param {Function} ensureStore - 记忆库加载器。
 * @param {object} diag - 诊断日志。
 * @returns {string} 注入文本。
 */
function buildContext(context, current, stateFor, ensureStore, diag) {
  if (!current.enabled) return '';
  const session = context?.agent?.session;
  if (session === undefined || session === null) return '';
  const state = stateFor(session);

  // 召回通道是否真的能注入（只看开关）。boost 是"召回"的一种，跟着一起判定。
  //
  // 早先这里还带一个"会话累计额度 > 0"的条件——那个累计上限（`sessionBudgetRatio`）已按
  // 用户实测决定删除：它达到上限后会让"提问时注入"静默停掉，而用户完全不知道是自己点了
  // 几次 ✕ 花掉了额度，只会觉得"这插件后来就不灵了"。成本控制改由单次口径负责。
  const recallOn = current.injectRecall === true;
  if (state.nextTurnBoost !== '' && !recallOn) {
    // 通道关着时**立刻丢弃**：留着的话，用户重新打开开关后会被注入一段
    // 上一次点 ✕ 留下的、早已过期的资料（那是"穿越"到旧话题的内容）。
    state.nextTurnBoost = '';
    state.boostConsumed = false;
  }

  if (!current.injectRecap && !current.injectRecall) return '';
  const parts = [];

  // ① 压缩后总览
  if (current.injectRecap && current.compactionRecapMaxTokens > 0) {
    const recap = computeRecap(session, current, state, ensureStore);
    const show = current.recapPersist ? recap.text !== '' : (state.pendingRecap && recap.text !== '');
    if (!current.recapPersist) state.pendingRecap = false;
    if (show) {
      parts.push(recap.text);
      if (state.recapCounted !== recap.text) {
        state.recapCounted = recap.text;
        state.injectedTokens += recap.tokens;
      }
    }
  }

  // ② 提问时召回
  if (current.injectRecall && current.maxTokensPerTurn > 0 && current.maxItems > 0) {
    const recall = computeRecall(session, current, state, ensureStore, diag);
    if (recall.text !== '') {
      parts.push(recall.text);
      if (current.stickyRecall) state.stickyRecall = recall.text;
    } else if (current.stickyRecall && state.stickyRecall !== '') {
      // 本轮没命中，但本窗口内已经注入过参考块：继续挂着。
      // 文本不变 → DSH 不会追加新快照；这块的 token 早在注入时付过了，这里不再计费。
      parts.push(state.stickyRecall);
    }
  }

  // ③ 「✕」排进的参考：整轮都注入，**这里绝不清空**。
  //    用户点 ✕ 的语义是"这段历史我记得聊过"，所以接下来的提问必须带上它
  //    —— 用户看不到任何提示词，只会觉得"它记得"。
  //
  //    为什么清空点搬到了 `turn/end`：组装上下文**每个 step 都跑一次**，在这里清
  //    等于只在第 1 步可见 —— 真正作答的那一步反而看不到；而且文本一变，DSH 会
  //    再追加一份整上下文快照（白花 token）。留在 state 里则整轮文本完全稳定。
  //    计费沿用 stickyRecall 的口径：同一次 boost 只计一次（boostConsumed）。
  if (state.nextTurnBoost !== '' && recallOn) {
    parts.push(state.nextTurnBoost);
    if (state.boostConsumed !== true) {
      state.boostConsumed = true;
      const tokens = estimateTokens(state.nextTurnBoost);
      state.injectedTokens += tokens;
      diag.write({
        at: new Date().toISOString(),
        event: 'boost-consumed',
        session: state.id,
        chars: state.nextTurnBoost.length,
        injectedTokensEst: tokens,
        sessionInjectedTokensEst: state.injectedTokens,
      });
    }
  }

  return parts.join('\n\n');
}

/** 计算（并缓存）本窗口的总览。 */
function computeRecap(session, current, state, ensureStore) {
  const index = ensureStore(session, current, state);
  if (state.indexKey === state.recapKey) return { text: state.recapText, tokens: estimateTokens(state.recapText) };
  const built = buildRecap(index.records, { maxTokens: current.compactionRecapMaxTokens });
  state.recapKey = state.indexKey;
  state.recapText = built.text;
  return { text: built.text, tokens: built.tokens };
}

/**
 * 提问时检索 + 注入决策（未命中返回空文本，0 token）。
 * 同一用户消息 seq 的结果在本轮内保持稳定 → 工具循环多步不会反复追加快照。
 */
function computeRecall(session, current, state, ensureStore, diag) {
  let query;
  try {
    query = collectQuery(session, current.observationTurns);
  } catch {
    return { text: '', tokens: 0, items: 0 };
  }
  // 本轮提问可能来自 inbox 事件（还没落进快照），也可能快照已经能看到了。
  const pending = state.pendingQuery;
  if (pending !== null && pending !== undefined && pending.text !== '') {
    if (pending.seq > query.seq) {
      query = {
        text: query.text === '' ? pending.text : `${query.text}\n${pending.text}`,
        latest: pending.text,
        seq: pending.seq,
      };
    } else if (query.latest === pending.text) {
      // 快照已经追上同一条提问：沿用 inbox 的 seq，保证整轮查询身份稳定（→ 命中缓存、不再重算）
      query = { text: query.text, latest: query.latest, seq: pending.seq };
    }
  }
  if (query.text === '' || query.seq < 0) return { text: '', tokens: 0, items: 0 };
  if (state.recall !== null && state.recall.seq === query.seq) return state.recall.result;
  const result = runRecall(session, current, state, ensureStore, diag, query);
  state.recall = { seq: query.seq, result };
  return result;
}

/** 真正做一次检索与预算判定。 */
function runRecall(session, current, state, ensureStore, diag, query) {
  const empty = { text: '', tokens: 0, items: 0 };
  // 这里曾经读 `session.requestContext().contextWindow` 并写进 `state.contextWindow`：
  // 它的**唯一**用途是算"会话累计额度"（用尽后 `reason=session-budget` 停止注入），
  // 而那道闸门已按用户实测决定删除（理由见 config.js DEFAULTS 与 buildContext 的注释）。
  // 2026-10-07 复查：全仓库除这一处写入外**没有任何读取方**（面板/路由/日志都不用它），
  // 所以连同 `state.contextWindow` 字段一起删掉 —— 只写不读的字段就是下一个误导。
  // 单次注入的量仍由 maxItems / maxCharsPerItem / maxTokensPerTurn 严格约束，
  // `state.injectedTokens` 只用于面板展示"本会话已注入 ≈N token"。

  // 同一话题连续两轮不重复注入
  if (current.cooldownTurns > 0 && state.lastRecallQuery !== ''
    && jaccard(tokenSet(query.text), tokenSet(state.lastRecallQuery)) >= 0.35) {
    state.misses += 1;
    logScore(diag, current, session, query, { topScore: 0, secondScore: 0, hit: false, reason: 'cooldown', injectedChars: 0, state });
    return empty;
  }

  const index = ensureStore(session, current, state);
  if (index.size === 0) {
    state.misses += 1;
    logScore(diag, current, session, query, { topScore: 0, secondScore: 0, hit: false, reason: 'empty-store', injectedChars: 0, state });
    return empty;
  }

  // 两段式查询：先用当前这条提问（干净），不够再用"当前 + 前几轮"（救指代型短问句）
  const attempts = [];
  if (query.latest !== undefined && query.latest.length >= 3) attempts.push({ text: query.latest, mode: 'latest' });
  if (query.text !== query.latest) attempts.push({ text: query.text, mode: 'combined' });
  if (attempts.length === 0) attempts.push({ text: query.text, mode: 'combined' });

  let found = null;
  let mode = attempts[0].mode;
  for (const attempt of attempts) {
    const result = retrieveTwoTier(index, attempt.text, {
      minScore: current.minScore,
      maxItems: current.maxItems,
      preferSummaryChunks: current.preferSummaryChunks,
    });
    if (found === null || result.topScore > found.topScore) {
      found = result;
      mode = attempt.mode;
    }
    if (result.tier !== 'none') break;
  }
  const reason = (tier) => `${tier}/${mode}`;

  const fresh = [];
  const batchTitles = new Set();
  for (const hit of found.hits) {
    const fp = String(hit.record.fp ?? fingerprint(hit.record.text ?? ''));
    if (current.dedupe && state.injectedFps.has(fp)) continue;
    const tokens = tokenSet(hit.record.text ?? '');
    if (current.dedupe && state.injectedTexts.some((previous) => jaccard(tokens, previous) >= 0.6)) continue;
    // 同一轮里不要注入同一个话题的两片（L1 分块会共享标题）
    const title = String(hit.record.title ?? '').trim();
    if (title !== '' && batchTitles.has(title)) continue;
    if (title !== '') batchTitles.add(title);
    fresh.push({ ...hit, fp, tokens });
  }

  const built = formatRecall(fresh, {
    maxItems: current.maxItems,
    maxCharsPerItem: current.maxCharsPerItem,
    maxTokensPerTurn: current.maxTokensPerTurn,
  });

  if (fresh.length === 0 || built.text === '') {
    state.misses += 1;
    logScore(diag, current, session, query, {
      topScore: found.topScore,
      secondScore: found.secondScore,
      hit: false,
      reason: found.tier === 'none' ? reason('below-threshold') : 'deduped',
      injectedChars: 0,
      state,
    });
    if (found.tier === 'none') state.lastRecallQuery = '';
    return empty;
  }

  // 这里曾经有一道「会话累计额度」闸门：用尽后 `reason=session-budget` 静默停止注入。
  // 已按用户决定删除（理由见 buildContext 与 config.js DEFAULTS 处的注释）：
  // 单次注入的量仍受 maxItems / maxCharsPerItem / maxTokensPerTurn 严格约束，
  // 而 `state.injectedTokens` 只用来在面板上显示"本会话已注入 ≈N token"。

  for (const item of fresh.slice(0, built.items)) {
    state.injectedFps.add(item.fp);
    state.injectedTexts.push(item.tokens);
    // 两个集合都滚动：长期运行的宿主不能让它们随会话长度无界增长
    if (state.injectedTexts.length > 40) state.injectedTexts.shift();
    if (state.injectedFps.size > 40) {
      const oldest = state.injectedFps.values().next().value;
      if (oldest !== undefined) state.injectedFps.delete(oldest);
    }
  }
  state.injectedTokens += built.tokens;
  state.hits += 1;
  state.lastRecallQuery = query.text;
  logScore(diag, current, session, query, {
    topScore: found.topScore,
    secondScore: found.secondScore,
    hit: true,
    reason: reason(found.tier),
    injectedChars: built.text.length,
    injectedTokens: built.tokens,
    state,
  });
  return built;
}

/** 写一行打分日志（诊断用，不是记忆内容）。 */
function logScore(diag, current, session, query, info) {
  if (!current.logScores) return;
  diag.write({
    at: new Date().toISOString(),
    event: 'recall',
    session: String(session.id),
    queryHead: query.text.replace(/\s+/g, ' ').slice(0, 60),
    topScore: Number((info.topScore ?? 0).toFixed(4)),
    secondScore: Number((info.secondScore ?? 0).toFixed(4)),
    hit: info.hit,
    reason: info.reason,
    injectedChars: info.injectedChars,
    injectedTokensEst: info.injectedTokens ?? 0,
    sessionInjectedTokensEst: info.state?.injectedTokens ?? 0,
  }, { scoring: true });
}

/**
 * 显式原文读取工具。只在用户明确要求时调用；返回与 L2 入库同口径的对话文字。
 * @param {object} deps - 依赖。
 * @returns {object} 工具定义。
 */
function historyReadTool(deps) {
  const { settings, resolveRoot } = deps;
  return {
    name: 'history_read',
    description: [
      '读取**本次会话已被压缩掉的旧对话原文**（只含用户问题与助手回答的文字，不含深度思考、工具调用与工具结果）。',
      '仅在用户**明确要求**时调用（例如「把当时那段原文调出来」「查原文」「看原始记录」）；不要自动调用，也不要用它代替日常的记忆检索。',
      '默认按 query 做本地词法检索取最相关的若干轮；不给 query 时返回最近若干轮。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的旧话题关键词或问题；省略则返回最近若干轮。' },
        sessionId: { type: 'string', description: '目标会话 id；省略则用当前会话。' },
        limit: { type: 'integer', description: '最多返回多少块/轮，默认 5，上限 20。' },
        source: {
          type: 'string',
          enum: ['auto', 'store', 'log'],
          description: 'auto（默认）先查本地记忆库、不足再回落到原始会话日志；store 只查库；log 只查原始日志。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, found: { type: 'boolean' }, chars: { type: 'integer' } },
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args, exec) {
      const current = settings.get().settings;
      const session = exec?.agent?.session ?? null;
      const fallbackId = session !== null ? String(session.id) : null;
      const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : fallbackId;
      if (sessionId === null) throw new Error('history_read：无法确定目标会话，请显式传 sessionId');
      const limit = Math.min(20, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 5));
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      const source = args?.source === 'store' || args?.source === 'log' ? args.source : 'auto';
      const root = resolveRoot(sessionId, session);

      let provenance = '';
      let chosen = [];
      if (source !== 'log' && root !== null) {
        try {
          const records = readRecords(root, sessionId).filter((record) => record.layer === 'raw');
          if (records.length > 0) {
            chosen = query === ''
              ? records.slice(-limit)
              : new MemoryIndex(records).search(query, { layers: ['raw'], limit }).map((hit) => hit.record);
            if (chosen.length > 0) provenance = `来源：本地记忆库 L2 原文块（会话 ${sessionId}）`;
          }
        } catch { /* 回落到日志 */ }
      }
      if (chosen.length === 0 && source !== 'store') {
        // 读原始日志要先把整份日志读进内存再逐帧解压：超大日志会同步阻塞事件循环。
        // 先按体积设闸，超了就明确告诉用户「太大，改用记忆库」，而不是把宿主卡死。
        const bytes = sessionLogBytes(sessionId);
        if (bytes !== null && bytes > HISTORY_LOG_MAX_BYTES) {
          return {
            text: `这个会话的原始日志有 ${Math.round(bytes / 1048576)} MB，超过 ${Math.round(HISTORY_LOG_MAX_BYTES / 1048576)} MB 的读取上限，`
              + `为避免卡住客户端没有读它。请改用 source:'store'（读本地记忆库里的原文块），或把关键词说得更具体。`,
            found: false,
            chars: 0,
          };
        }
        const { events, failed } = readSessionEvents(sessionId);
        const turns = events.length === 0 ? [] : conversationTurns(events, current);
        if (turns.length > 0) {
          if (query === '') chosen = turns.slice(-limit);
          else {
            const wanted = tokenSet(query);
            chosen = turns
              .map((turn) => ({ turn, score: jaccard(wanted, tokenSet(`${turn.user}\n${turn.assistant}`)) }))
              .filter((item) => item.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, limit)
              .map((item) => item.turn);
          }
          if (chosen.length > 0) {
            provenance = `来源：DSH 原始会话日志（只读；会话 ${sessionId}）`
              + (failed > 0 ? `（注意：有 ${failed} 帧解码失败，内容可能不完整）` : '');
          }
        }
      }

      if (chosen.length === 0) {
        return {
          text: `没有找到可读取的旧对话（会话 ${sessionId}${query === '' ? '' : `，关键词「${query}」`}）。`,
          found: false,
          chars: 0,
        };
      }

      const pieces = [];
      let used = 0;
      for (const item of chosen) {
        if (used >= HISTORY_MAX_CHARS) break;
        const raw = item.text !== undefined
          ? String(item.text)
          : (item.assistant === '' ? `问：${item.user}` : `问：${item.user}\n答：${item.assistant}`);
        const text = raw.slice(0, HISTORY_MAX_CHARS - used);
        pieces.push(text);
        used += text.length;
      }
      const body = pieces.join('\n\n---\n\n');
      return {
        text: [
          `【历史原文】${provenance}`,
          '（只含用户问题与助手回答文字；不含深度思考、工具调用与工具结果。用户明确要求查原文，故不受日常注入的小上限约束。）',
          '',
          body,
        ].join('\n'),
        found: true,
        chars: body.length,
      };
    },
  };
}
