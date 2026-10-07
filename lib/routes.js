/**
 * dsh-super-memory — 面板 API（/api/dsh-super-memory/*）
 *
 * 读写设置、按工作区列出本地记忆占用、删除单条/整会话（默认 7 天保护期）、
 * 回收站还原/手动清空/审计，以及一个用于标定 minScore 的试检索接口。
 *
 * 安全边界：只操作插件自己 storeDir 内的文件；workspace 参数必须来自
 * 已知工作区（面板登记 / DSH 工作区注册表 / 本进程见过），绝不触碰
 * DSH 原始会话日志 ~/.dsh/sessions/**（只做 stat 读大小，绝不写/删）。
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import {
  DEFAULTS, EDITABLE_FIELDS, dataHomeInfo, defaultDiagPath, defaultSettingsPath, resolveDshHome,
} from './config.js';
import {
  AUDIT_FILE, appendPair, audit, dirBytes, listSessionFiles, listTrash, moveToTrash,
  purgeTrash, readAudit, readPairs, readRecords, readTrashBlocks, removeTrashEntry, restoreFromTrash,
  safeSessionId, storeRoot, writeRecords,
} from './store.js';
import { MemoryIndex, retrieveTwoTier } from './retrieval.js';
import { formatRecall, queryTextOf } from './recall.js';
import { buildRecap } from './recap.js';
import { diagnoseMiss, tokenSpread } from './diagnose.js';
import { sessionTitleOf, shortSessionId } from './titles.js';

const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({ ok: false, error });

/**
 * 在系统文件管理器里定位一个文件或目录（面板的「浏览」按钮）。
 * Windows 用 explorer 的 `/select,`；macOS 用 `open -R`；其它用 `xdg-open`。
 * 路径由调用方保证落在插件自己的 storeDir 内。
 * @param {string} target - 文件或目录的绝对路径。
 * @returns {boolean} 是否成功发起。
 */
function revealInFileManager(target) {
  try {
    const isFile = existsSync(target) && statSync(target).isFile();
    if (process.platform === 'win32') {
      const native = target.replace(/\//g, '\\');
      if (isFile) {
        // explorer 只认 `/select,"<路径>"` 这种"引号紧跟逗号"的形式。用 spawn 默认加引号
        // 会把引号放到 `/select,` 前面，explorer 解析失败就退回到"文档"（实测踩过）。
        // 所以用 windowsVerbatimArguments 原样把参数交给系统。
        spawn('explorer.exe', [`/select,"${native}"`], {
          detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
        }).unref();
      } else {
        spawn('explorer.exe', [native], { detached: true, stdio: 'ignore' }).unref();
      }
    } else if (process.platform === 'darwin') {
      spawn('open', isFile ? ['-R', target] : [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [isFile ? dirname(target) : target], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/** 写一个 JSON 信封响应。 */
export function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(envelope));
}

/** 读取有上限的 JSON 请求体。 */
async function readJsonBody(req, limit = 1 << 20) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    total += chunk.length;
    if (total > limit) return null;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 面板写请求必须带的自定义头（跨站请求带它会触发 CORS 预检从而被浏览器拦下）。 */
const CSRF_HEADER = 'x-dsh-super-memory';

/**
 * 工作区是否是 git 仓库、以及记忆目录是否已被忽略。
 * 记忆里存的是**对话原文**，一旦被提交上去就不可逆，所以面板要能提醒。
 * @param {string} workspace - 工作区路径。
 * @param {string} storeDir - 记忆目录（相对工作区或绝对路径）。
 * @returns {{gitRepo:boolean, ignoreRule:boolean, rule:string}} 检查结果。
 */
function gitIgnoreState(workspace, storeDir) {
  const rule = typeof storeDir === 'string' && storeDir !== '' && !isAbsolute(storeDir)
    ? `${storeDir.replace(/[\\/]+$/, '')}/`
    : '.dsh-compaction-memory/';
  const gitRepo = existsSync(join(workspace, '.git'));
  let ignoreRule = false;
  if (gitRepo) {
    try {
      const file = join(workspace, '.gitignore');
      ignoreRule = existsSync(file) && readFileSync(file, 'utf8').includes(rule.replace(/\/$/, ''));
    } catch { ignoreRule = false; }
  }
  return { gitRepo, ignoreRule, rule };
}

/**
 * 往工作区的 `.gitignore` 追加记忆目录忽略规则（只在**确实是 git 仓库**且规则缺失时写）。
 * @param {string} workspace - 工作区路径。
 * @param {string} storeDir - 记忆目录。
 * @returns {{changed:boolean, already:boolean, file:string, rule:string}|null} 结果；非 git 仓库返回 null。
 */
function ensureGitIgnore(workspace, storeDir) {
  const state = gitIgnoreState(workspace, storeDir);
  if (!state.gitRepo) return null;
  const file = join(workspace, '.gitignore');
  if (state.ignoreRule) return { changed: false, already: true, file, rule: state.rule };
  const header = existsSync(file) ? '' : '# 由 dsh-super-memory 创建：记忆里是对话原文，别提交\n';
  appendFileSync(file, `${header}${state.rule}\n`, 'utf8');
  return { changed: true, already: false, file, rule: state.rule };
}

/**
 * 写操作的来源校验。
 * @param {object} req - HTTP 请求。
 * @param {string} method - 已大写的请求方法。
 * @returns {string|null} 错误信息，null 表示放行。
 */
function writeGuard(req, method) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const headers = req.headers ?? {};
  if (String(headers[CSRF_HEADER] ?? '') !== '1') return '写操作必须由插件面板发起（缺少来源标记）';
  if (!String(headers['content-type'] ?? '').includes('application/json')) return '写操作必须使用 application/json 请求体';
  return null;
}

/** 解析查询里的数字参数，非法值回落到默认值（`Number('abc')=NaN` 会让 slice(-NaN) 变成 slice(0)）。 */
function parseCount(raw, fallback, maximum) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(maximum, value);
}

/**
 * 读某个工作区记忆库里的**全部会话**记录（未命中诊断要全库扫描；
 * 不带 `_audit.jsonl` / `_pairs.jsonl` 这些账本 —— listSessionFiles 已按下划线前缀跳过）。
 * @param {string} root - 记忆库根目录。
 * @returns {object[]} 全部记录。
 */
function readWorkspaceRecords(root) {
  const out = [];
  for (const file of listSessionFiles(root)) {
    try {
      out.push(...readRecords(root, file.sessionId));
    } catch { /* 单个文件坏了不影响整体诊断 */ }
  }
  return out;
}

/**
 * 会话的注入额度用量。
 *
 * 额度 = 上下文窗口 × `sessionBudgetRatio`，**只在会话生命周期内累加、不重置**（这是当初定下的
 * 成本红线）。额度用尽后"提问时注入"会静默停止——所以这里把它算出来给面板显示，
 * 让"为什么后来不灵了"一眼可见，而不是只能翻诊断日志里的 `reason=session-budget`。
 * @param {object} state - 会话状态。
 * @param {object} current - 当前设置。
 * @returns {object} 额度信息。
 */
function budgetInfo(state, current) {
  const window = typeof state.contextWindow === 'number' && state.contextWindow > 0 ? state.contextWindow : null;
  const ratio = typeof current.sessionBudgetRatio === 'number' ? current.sessionBudgetRatio : 0;
  const off = !(ratio > 0);
  const budgetTokens = window === null || off ? null : Math.round(window * ratio);
  const usedTokens = Math.round(state.injectedTokens ?? 0);
  return {
    budgetTokens,
    budgetUsedTokens: usedTokens,
    budgetOff: off,
    budgetExhausted: budgetTokens !== null && budgetTokens > 0 && usedTokens >= budgetTokens,
  };
}

/** 会话日志索引缓存（判定保护期要用会话目录 mtime，但整棵树扫描较慢）。 */
let logIndexCache = { at: 0, map: new Map() };

function sessionLogIndex() {
  // 只看时间戳：早先这里还要求 map.size > 0，导致"一个会话日志都没有"时
  // 每次调用都重扫整棵 sessions 树，而面板每个会话行都会查一次。
  if (Date.now() - logIndexCache.at < 60000) return logIndexCache.map;
  const map = new Map();
  const root = join(resolveDshHome(), 'sessions');
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = join(root, project.name);
      let entries = [];
      try { entries = readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(projectDir, entry.name);
        let files = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const file of files) {
          if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(file)) continue;
          const full = join(dir, file);
          let stat;
          try { stat = statSync(full); } catch { continue; }
          // 会话目录名就是完整会话 id（形如 session-<uuid>）；记忆文件名与记录里的
          // sessionId 也是这个带前缀的形式，所以 key 必须原样保留，不能再剥前缀。
          const id = entry.name;
          const previous = map.get(id);
          if (previous === undefined || stat.mtimeMs > previous.mtimeMs) {
            map.set(id, { path: full, mtimeMs: stat.mtimeMs, bytes: stat.size });
          }
        }
      }
    }
  } catch { /* 索引失败不影响面板 */ }
  logIndexCache = { at: Date.now(), map };
  return map;
}

/** 某个会话日志的 mtime（毫秒），取不到返回 0。 */
function sessionLogMtime(sessionId) {
  const entry = sessionLogIndex().get(String(sessionId));
  return entry === undefined ? 0 : entry.mtimeMs;
}

/** 会话日志大小与路径。 */
function sessionLogInfo(sessionId) {
  return sessionLogIndex().get(String(sessionId)) ?? null;
}

/**
 * 构造面板路由。
 * @param {object} deps - 依赖。
 * @returns {object} webServer 路由定义。
 */
export function makeRoutes(deps) {
  const { settings, diag, states, knownWorkspaces, build, llm = null, dataHome = '' } = deps;

  /** 按会话 id 找会话对象（模型辅助要读 `model/selection` 以"跟随主模型"）。 */
  function findSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    try { return deps.findSession?.(sessionId) ?? null; } catch { return null; }
  }

  /** workspace 参数校验：必须是已知工作区，或其记忆库已存在。 */
  function resolvePanelRoot(workspace) {
    const current = settings.get().settings;
    if (typeof workspace !== 'string' || workspace.trim() === '') return null;
    const value = workspace.trim();
    const known = knownWorkspaces();
    const root = storeRoot(value, current.storeDir);
    const allowed = known.includes(value) || existsSync(root);
    if (!allowed) return null;
    return { workspace: value, root };
  }

  /** 单个会话的统计（含保护期判定）。 */
  function sessionEntry(root, file, current) {
    const sessionId = file.sessionId;
    const records = readRecords(root, sessionId);
    let latest = 0;
    let summary = 0;
    let raw = 0;
    for (const record of records) {
      if (record.layer === 'raw') raw += 1;
      else summary += 1;
      const at = Date.parse(record.at ?? '');
      if (Number.isFinite(at) && at > latest) latest = at;
    }
    const activity = Math.max(latest, sessionLogMtime(sessionId), file.mtimeMs);
    const protectDays = current.protectRecentDays;
    const protectedUntil = protectDays > 0 ? activity + protectDays * 86400000 : 0;
    const isProtected = protectedUntil > Date.now();
    const newest = records.slice(-1)[0];
    const titleRecord = [...records].reverse().find((record) => record.layer === 'summary' && record.title)
      ?? newest;
    // 标题优先用 DSH 侧栏那个（用户认得），取不到才退回记忆块标题
    const fallbackTitle = String(titleRecord?.title ?? '');
    const compactions = new Set(records.map((record) => String(record.compactionId ?? '')).filter((id) => id !== '')).size;
    return {
      sessionId,
      title: sessionTitleOf(sessionId, fallbackTitle),
      titleFallback: fallbackTitle,
      shortId: shortSessionId(sessionId),
      blocks: records.length,
      summaryBlocks: summary,
      rawBlocks: raw,
      compactions,
      bytes: file.bytes,
      updatedAt: latest > 0 ? new Date(latest).toISOString() : null,
      activityAt: activity > 0 ? new Date(activity).toISOString() : null,
      lastActivityMs: activity,
      protected: isProtected,
      protectDaysLeft: isProtected ? Math.ceil((protectedUntil - Date.now()) / 86400000) : 0,
      log: sessionLogInfo(sessionId),
    };
  }

  /** 一个工作区的完整概览。 */
  function workspaceOverview(workspace, current) {
    const root = storeRoot(workspace, current.storeDir);
    const exists = existsSync(root);
    const files = exists ? listSessionFiles(root) : [];
    const sessions = files.map((file) => {
      try {
        return sessionEntry(root, file, current);
      } catch {
        return { sessionId: file.sessionId, title: '', blocks: 0, bytes: file.bytes, protected: false };
      }
    });
    sessions.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));
    const trash = exists ? listTrash(root) : [];
    let trashBytes = 0;
    for (const entry of trash) trashBytes += entry.bytes;
    let libraryBytes = 0;
    for (const file of files) libraryBytes += file.bytes;
    const auditFile = join(root, AUDIT_FILE);
    const auditBytes = exists && existsSync(auditFile)
      ? (() => { try { return statSync(auditFile).size; } catch { return 0; } })()
      : 0;
    return {
      workspace,
      root,
      exists,
      sessions,
      git: gitIgnoreState(workspace, current.storeDir),
      libraryBytes,
      libraryBlocks: sessions.reduce((sum, item) => sum + (item.blocks ?? 0), 0),
      trashBytes,
      trashEntries: trash.length,
      auditBytes,
      totalBytes: libraryBytes + trashBytes + auditBytes,
    };
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/api/dsh-super-memory';
    const method = (req.method ?? 'GET').toUpperCase();
    const current = settings.get().settings;

    try {
      // 写操作来源校验（防 CSRF）：DSH 的 web server 只做前缀匹配就把请求交给插件，
      // 本身不带鉴权与 Origin 检查，所以 `POST /trash/purge` 这类请求如果只靠
      // "浏览器不会跨站发 POST" 就太薄了——加一个自定义头：跨站请求带它会触发
      // CORS 预检，而被拒；同时要求 JSON content-type，挡掉表单式简单请求。
      const guard = writeGuard(req, method);
      if (guard !== null) { json(res, FAIL({ code: 'forbidden', message: guard }), 403); return; }
      // ── 设置 ────────────────────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/settings') {
        if (method === 'GET') {
          json(res, OK({
            ...settings.get(),
            defaults: DEFAULTS,
            fields: EDITABLE_FIELDS,
            settingsPath: defaultSettingsPath(),
            dataHome: dataHomeInfo(),
            diagPath: defaultDiagPath(),
          }));
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
          try {
            json(res, OK(settings.update(body)));
          } catch (error) {
            json(res, FAIL({ code: 'bad-request', message: String(error?.message ?? error) }), 400);
          }
          return;
        }
        if (method === 'DELETE') {
          json(res, OK(settings.reset()));
          return;
        }
      }

      // ── 总览（按工作区分组） ────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/overview' && method === 'GET') {
        const known = knownWorkspaces();
        // `?current=` 不能是任意路径：否则就是把"某目录下有没有记忆文件、多大、什么时候改的"
        // 暴露出去。只接受已知工作区（或其记忆库已存在）的路径，否则回落到第一个已知工作区。
        const requested = url.searchParams.get('current') ?? '';
        const currentWorkspace = requested !== '' && resolvePanelRoot(requested) !== null
          ? requested
          : (known[0] ?? '');
        const list = [];
        if (currentWorkspace !== '') list.push(currentWorkspace);
        for (const workspace of known) if (!list.includes(workspace)) list.push(workspace);
        const workspaces = list.map((workspace) => {
          try {
            return workspaceOverview(workspace, current);
          } catch (error) {
            return { workspace, root: storeRoot(workspace, current.storeDir), exists: false, sessions: [], error: String(error?.message ?? error) };
          }
        });
        workspaces.sort((a, b) => {
          if (a.workspace === currentWorkspace) return -1;
          if (b.workspace === currentWorkspace) return 1;
          return (b.totalBytes ?? 0) - (a.totalBytes ?? 0);
        });
        const runtime = [];
        for (const state of states.values()) {
          runtime.push({
            sessionId: state.id,
            workspace: state.workspace ?? null,
            hits: state.hits,
            misses: state.misses,
            injectedTokensEst: state.injectedTokens,
            knownCompactions: state.knownCompactions.size,
            ...budgetInfo(state, current),
          });
        }
        json(res, OK({
          currentWorkspace,
          build: typeof build === 'string' ? build : null,
          workspaces,
          totals: {
            libraryBytes: workspaces.reduce((sum, item) => sum + (item.libraryBytes ?? 0), 0),
            trashBytes: workspaces.reduce((sum, item) => sum + (item.trashBytes ?? 0), 0),
          },
          runtime,
          llm: llm === null ? null : llm.status(),
        }));
        return;
      }

      // ── 单个会话的块列表 ────────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/session' && method === 'GET') {
        const target = resolvePanelRoot(url.searchParams.get('workspace'));
        const sessionId = url.searchParams.get('session');
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        if (sessionId === null) { json(res, FAIL({ code: 'bad-request', message: '缺少 session' }), 400); return; }
        const records = readRecords(target.root, sessionId);
        json(res, OK({
          workspace: target.workspace,
          sessionId,
          blocks: records.map((record, index) => ({
            index,
            layer: record.layer,
            title: record.title,
            keywords: record.keywords,
            at: record.at,
            chars: String(record.text ?? '').length,
            preview: String(record.text ?? '').slice(0, 200),
            fp: record.fp,
            compactionId: record.compactionId,
          })),
        }));
        return;
      }

      // ── 试检索（标定 minScore 用） ──────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/search' && method === 'GET') {
        const target = resolvePanelRoot(url.searchParams.get('workspace'));
        const sessionId = url.searchParams.get('session');
        const query = url.searchParams.get('query') ?? '';
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        if (sessionId === null || query === '') { json(res, FAIL({ code: 'bad-request', message: '缺少 session 或 query' }), 400); return; }
        const records = readRecords(target.root, sessionId);
        const index = new MemoryIndex(records);
        const minScore = Number(url.searchParams.get('minScore') ?? current.minScore);
        const found = retrieveTwoTier(index, query, {
          minScore: Number.isFinite(minScore) ? minScore : current.minScore,
          maxItems: current.maxItems,
          preferSummaryChunks: current.preferSummaryChunks,
        });
        const summaryHits = index.search(query, { layers: ['summary'], limit: 5 });
        const rawHits = index.search(query, { layers: ['raw'], limit: 5 });
        json(res, OK({
          query,
          minScore,
          tier: found.tier,
          topScore: found.topScore,
          secondScore: found.secondScore,
          wouldInject: formatRecall(found.hits, {
            maxItems: current.maxItems,
            maxCharsPerItem: current.maxCharsPerItem,
            maxTokensPerTurn: current.maxTokensPerTurn,
          }),
          summary: summaryHits.map((hit) => ({ score: hit.score, matched: hit.matched, title: hit.record.title, layer: hit.record.layer })),
          raw: rawHits.map((hit) => ({ score: hit.score, matched: hit.matched, title: hit.record.title, layer: hit.record.layer })),
          recap: buildRecap(records, { maxTokens: current.compactionRecapMaxTokens }),
        }));
        return;
      }

      // ── 删除 ────────────────────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/delete' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        const sessionId = typeof body.session === 'string' ? body.session : '';
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        if (sessionId === '') { json(res, FAIL({ code: 'bad-request', message: '缺少 session' }), 400); return; }
        if (body.confirm !== true) { json(res, FAIL({ code: 'need-confirm', message: '需要二次确认' }), 409); return; }

        const files = listSessionFiles(target.root);
        const file = files.find((item) => item.sessionId === safeSessionId(sessionId) || item.sessionId === sessionId);
        if (file === undefined) { json(res, FAIL({ code: 'not-found', message: '该会话没有本地记忆' }), 404); return; }

        const ids = Array.isArray(body.fps) ? body.fps.map(String) : null;
        // 保护期只拦"整会话删除"：删单条是用户盯着内容做的手术式操作，不该被锁住
        if (ids === null && current.protectRecentDays > 0) {
          const activity = Math.max(file.mtimeMs, sessionLogMtime(sessionId));
          const protectedUntil = activity + current.protectRecentDays * 86400000;
          if (protectedUntil > Date.now()) {
            const left = Math.ceil((protectedUntil - Date.now()) / 86400000);
            json(res, FAIL({
              code: 'protected',
              message: `该会话最近 ${current.protectRecentDays} 天内更新过，还剩 ${left} 天可删（可在面板把保护期改成 0，但会先弹警告；删除单条不受保护期限制）`,
            }), 423);
            return;
          }
        }

        const all = readRecords(target.root, sessionId);
        const victims = ids === null ? all : all.filter((record) => ids.includes(String(record.fp)));
        if (victims.length === 0) { json(res, FAIL({ code: 'not-found', message: '没有匹配的记忆条目' }), 404); return; }
        const remaining = all.filter((record) => !victims.includes(record));

        let trashId = null;
        if (current.trashEnabled) trashId = moveToTrash(target.root, sessionId, victims, { source: 'panel' });
        writeRecords(target.root, sessionId, remaining);
        audit(target.root, {
          action: ids === null ? 'delete-session' : 'delete-blocks',
          session: sessionId,
          blocks: victims.length,
          bytes: victims.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0),
          trashId,
        });
        json(res, OK({ deleted: victims.length, remaining: remaining.length, trashId, trashed: trashId !== null }));
        return;
      }

      // ── 未命中诊断（纯本地全库扫描，0 模型调用）────────────────────────
      if (pathname === '/api/dsh-super-memory/diagnose' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        let query = typeof body.query === 'string' ? body.query.trim() : '';
        // 面板可能拿不到"上一个问题"（插件刚重启时内存状态是空的）——那就自己从会话日志里取最后一条用户提问
        if (query === '' && typeof body.session === 'string' && body.session !== '') {
          const session = findSession(body.session);
          try {
            const events = session?.snapshotEvents?.() ?? [];
            for (let i = events.length - 1; i >= 0 && query === ''; i -= 1) {
              if (events[i]?.type !== 'user/message') continue;
              query = queryTextOf(events[i]);
            }
          } catch { /* 取不到就走下面的 400 */ }
        }
        if (query === '') { json(res, FAIL({ code: 'bad-request', message: '拿不到上一个问题（会话里还没有用户提问）' }), 400); return; }
        const records = readWorkspaceRecords(target.root);
        const index = new MemoryIndex(records);
        const report = diagnoseMiss({
          records,
          query,
          minScore: current.minScore,
          limit: parseCount(body.limit, 10, 20),
          search: (text, options) => index.search(text, { limit: options?.limit ?? 10 }),
        });

        // ③ 可选的模型辅助：改写（默认关）与重排（默认关，且必须允许"都不相关"）
        //    `rewrite: true` 来自**用户点击**（会话内按钮/面板按钮）——点一次发一次，
        //    所以不需要预先打开 llmRecallRewrite；但仍要求总开关打开（那是联网的知情同意）。
        const assist = { rewrite: null, rerank: null };
        const wantsRewrite = current.llmRecallRewrite === true || body.rewrite === true;
        if (llm !== null && current.llmAssistEnabled === true) {
          const session = findSession(body.session);
          if (wantsRewrite) {
            const result = await llm.rewriteQuery({ session, query });
            assist.rewrite = result.ok
              ? { ok: true, terms: result.terms, cached: result.cached === true }
              : { ok: false, code: result.code, hint: result.hint };
            if (result.ok && result.terms.length > 0) {
              // 用改写结果再跑一遍本地检索并合并候选（改写词仍要自己过阈值）
              const boosted = index.search(result.terms.join(' '), { limit: 20 });
              const known = new Set(report.candidates.map((item) => item.fp));
              for (const hit of boosted) {
                const fp = hit.record?.fp ?? '';
                if (fp === '' || known.has(fp)) continue;
                known.add(fp);
                report.candidates.push({
                  fp,
                  title: hit.record?.title ?? '',
                  layer: hit.record?.layer ?? '',
                  src: hit.record?.src ?? '',
                  tool: hit.record?.tool ?? '',
                  at: hit.record?.at ?? '',
                  score: Math.round((hit.score ?? 0) * 10000) / 10000,
                  chars: String(hit.record?.text ?? '').length,
                  preview: String(hit.record?.text ?? '').replace(/\s+/g, ' ').slice(0, 120),
                  viaRewrite: true,
                });
              }
              report.candidates.sort((a, b) => b.score - a.score);
              report.candidates = report.candidates.slice(0, parseCount(body.limit, 10, 20));
            }
          }
          if (current.llmRecallRerank === true && report.candidates.length > 0) {
            const result = await llm.rerank({ session, query, candidates: report.candidates });
            assist.rerank = result.ok
              ? { ok: true, fp: result.fp, index: result.index }
              : { ok: false, code: result.code, hint: result.hint };
            if (result.ok) {
              const at = report.candidates.findIndex((item) => item.fp === result.fp);
              if (at > 0) {
                const [picked] = report.candidates.splice(at, 1);
                report.candidates.unshift({ ...picked, reranked: true });
              }
            }
          }
        }

        // 给会话内「✕」用的**资料原文**（不只是 120 字预览）：取分数最高的 1–2 块，
        // 每块上限 600 字符，拼成可直接交给主模型的参考资料。
        const material = (() => {
          const picked = (report.candidates ?? []).slice(0, 2);
          if (picked.length === 0) return '';
          const byFp = new Map(records.map((record) => [record.fp, record]));
          const parts = [];
          for (const item of picked) {
            const record = byFp.get(item.fp);
            if (record === undefined) continue;
            const text = String(record.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
            if (text === '') continue;
            parts.push(`【${record.src === 'tool' ? '工具结果' : '对话'}】${record.title || '(无标题)'}\n${text}`);
          }
          return parts.join('\n\n');
        })();
        json(res, OK({ ...report, material, assist, spread: tokenSpread(records, query), pairs: readPairs(target.root, 5) }));
        return;
      }
      // ── 已注册的提供方与型号（面板下拉/联想用；与官方「模型」页同源）──────
      if (pathname === '/api/dsh-super-memory/llm/providers' && method === 'GET') {
        if (llm === null) { json(res, OK({ serviceAvailable: false, providers: [] })); return; }
        const raw = await llm.listProviders();
        // 官方返回的形状未必是裸数组（可能是 {providers:[…]} / {routes:[…]}）；
        // 都兼容，取不到就返回空清单（面板会提示"可直接手填"）。
        const asArray = Array.isArray(raw) ? raw
          : (Array.isArray(raw?.providers) ? raw.providers
            : (Array.isArray(raw?.routes) ? raw.routes : []));
        const providers = [];
        if (Array.isArray(asArray)) {
          for (const item of asArray) {
            if (typeof item === 'string') { providers.push({ provider: item, models: [] }); continue; }
            const provider = typeof item?.provider === 'string' ? item.provider
              : (typeof item?.id === 'string' ? item.id : (typeof item?.name === 'string' ? item.name : ''));
            if (provider === '') continue;
            const models = Array.isArray(item?.models)
              ? item.models.map((model) => (typeof model === 'string' ? model : String(model?.id ?? model?.model ?? ''))).filter((id) => id !== '')
              : [];
            providers.push({ provider, models });
          }
        }
        json(res, OK({ serviceAvailable: true, providers, status: llm.status() }));
        return;
      }

      // ── 投递实验（临时）：插件能不能往会话里投一条输入并触发主模型跑一轮 ──
      // 机制依据：`agent/inbox/spliced` 是事件驱动的收件箱，agent loop 只认这一种事件
      // （dsh-agent-loop/index.js:34）。这里验证"插件 append 它是否被接受"。
      // 只在手动点击时执行一次；成功/失败都写诊断日志，便于复盘。
      if (pathname === '/api/dsh-super-memory/inbox-probe' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const sessionId = typeof body.session === 'string' ? body.session : '';
        const session = findSession(sessionId);
        if (session === null) { json(res, FAIL({ code: 'no-session', message: '拿不到会话对象（本进程还没见过这个会话；随便发一条消息后再试）' }), 409); return; }
        if (typeof session.append !== 'function') {
          json(res, FAIL({ code: 'no-append', message: '会话对象没有 append 方法（平台没给插件这个口子）' }), 501);
          return;
        }
        const text = '【超级记忆·投递实验】看到这句话说明插件可以投递输入。请只回复四个字：投递成功';
        try {
          session.append('agent/inbox/spliced', {
            target: 'next-turn',
            inserted: [{
              id: `dsm-probe-${Date.now().toString(36)}`,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'dsh-super-memory' },
            }],
          });
          diag?.write?.({ at: new Date().toISOString(), event: 'inbox-probe', session: sessionId, ok: true });
          json(res, OK({ appended: true, expect: '若主模型随后回答了「投递成功」，说明这条路可用' }));
        } catch (error) {
          const message = String(error?.message ?? error);
          diag?.write?.({ at: new Date().toISOString(), event: 'inbox-probe', session: sessionId, ok: false, message });
          json(res, FAIL({ code: 'append-failed', message }), 500);
        }
        return;
      }

      // ── 模型辅助：测试连接（面板按钮）──────────────────────────────────
      if (pathname === '/api/dsh-super-memory/llm/test' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        if (llm === null) { json(res, FAIL({ code: 'unavailable', message: '本进程没有模型网关' }), 503); return; }
        const session = findSession(body.session);
        const result = await llm.testConnection(session, {
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
        });
        if (result.ok) llm.clearCooldown();
        json(res, OK({
          ok: result.ok,
          ms: result.ms ?? 0,
          route: result.route ?? null,
          code: result.code ?? null,
          hint: result.hint ?? null,
          text: typeof result.text === 'string' ? result.text.slice(0, 80) : '',
          status: llm.status(),
        }));
        return;
      }

      // ── 配对记账（用户认定"就是这条 / 都不对"）──────────────────────────
      if (pathname === '/api/dsh-super-memory/pair' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const saved = appendPair(target.root, {
          session: typeof body.session === 'string' ? body.session : '',
          query: body.query,
          fp: body.fp,
          verdict: body.verdict,
          score: typeof body.score === 'number' ? body.score : undefined,
          title: body.title,
        });
        if (!saved) { json(res, FAIL({ code: 'write-failed', message: '写入配对记录失败' }), 500); return; }
        json(res, OK({ saved: true }));
        return;
      }

      // ── git 忽略规则（记忆目录在用户项目里，别让它被提交上去） ──────────
      if (pathname === '/api/dsh-super-memory/ignore-rule' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const result = ensureGitIgnore(target.workspace, current.storeDir);
        if (result === null) { json(res, FAIL({ code: 'not-a-repo', message: '这个工作区不是 git 仓库，不需要忽略规则' }), 400); return; }
        if (result.already === true) { json(res, OK({ changed: false, file: result.file })); return; }
        audit(target.root, { action: 'add-gitignore', file: result.file, rule: result.rule });
        json(res, OK({ changed: true, file: result.file, rule: result.rule }));
        return;
      }

      // ── 在系统文件管理器里显示（面板「浏览」按钮） ──────────────────────
      if (pathname === '/api/dsh-super-memory/reveal' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const sessionId = typeof body.session === 'string' ? body.session : '';
        let path = target.root;
        if (sessionId !== '') {
          const file = join(target.root, `${safeSessionId(sessionId)}.jsonl`);
          if (!existsSync(file)) { json(res, FAIL({ code: 'not-found', message: '这个会话还没有本地记忆文件' }), 404); return; }
          path = file;
        } else if (!existsSync(target.root)) {
          json(res, FAIL({ code: 'not-found', message: '这个工作区还没有记忆目录' }), 404); return;
        }
        if (!revealInFileManager(path)) {
          json(res, FAIL({ code: 'unsupported', message: `无法自动打开文件夹，请手动打开：${path}` }), 500);
          return;
        }
        json(res, OK({ path }));
        return;
      }

      // ── 回收站 ──────────────────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/trash' && method === 'GET') {
        const target = resolvePanelRoot(url.searchParams.get('workspace'));
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const entries = listTrash(target.root).map((entry) => ({
          ...entry,
          dir: undefined,
          blocks: entry.blocks,
          title: sessionTitleOf(entry.sessionId, ''),
          shortId: shortSessionId(entry.sessionId),
        }));
        json(res, OK({ workspace: target.workspace, root: target.root, entries }));
        return;
      }

      if (pathname === '/api/dsh-super-memory/trash/blocks' && method === 'GET') {
        const target = resolvePanelRoot(url.searchParams.get('workspace'));
        const id = url.searchParams.get('id');
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        if (id === null) { json(res, FAIL({ code: 'bad-request', message: '缺少 id' }), 400); return; }
        const blocks = readTrashBlocks(target.root, id).map((record) => ({
          layer: record.layer,
          title: record.title,
          at: record.at,
          chars: String(record.text ?? '').length,
          preview: String(record.text ?? '').slice(0, 200),
          fp: record.fp,
        }));
        json(res, OK({ id, blocks }));
        return;
      }

      if (pathname === '/api/dsh-super-memory/trash/restore' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const id = typeof body.id === 'string' ? body.id : '';
        if (id === '') { json(res, FAIL({ code: 'bad-request', message: '缺少 id' }), 400); return; }
        const fps = Array.isArray(body.fps) ? body.fps.map(String) : null;
        const result = restoreFromTrash(target.root, id, fps);
        audit(target.root, { action: 'restore', session: result.sessionId, trashId: id, blocks: result.restored, partial: fps !== null });
        json(res, OK(result));
        return;
      }

      if (pathname === '/api/dsh-super-memory/trash/delete' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolvePanelRoot(body.workspace);
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        if (body.confirm !== true) { json(res, FAIL({ code: 'need-confirm', message: '需要二次确认' }), 409); return; }
        const id = typeof body.id === 'string' ? body.id : '';
        if (id === '') { json(res, FAIL({ code: 'bad-request', message: '缺少 id' }), 400); return; }
        const removed = removeTrashEntry(target.root, id);
        if (removed) audit(target.root, { action: 'trash-delete-entry', trashId: id });
        json(res, OK({ removed }));
        return;
      }

      if (pathname === '/api/dsh-super-memory/trash/purge' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        if (body.confirm !== true) { json(res, FAIL({ code: 'need-confirm', message: '需要二次确认' }), 409); return; }
        const targets = typeof body.workspace === 'string' && body.workspace !== ''
          ? [resolvePanelRoot(body.workspace)]
          : knownWorkspaces().map((workspace) => resolvePanelRoot(workspace));
        let entries = 0;
        let bytes = 0;
        for (const target of targets) {
          if (target === null) continue;
          const result = purgeTrash(target.root);
          entries += result.entries;
          bytes += result.bytes;
          if (result.entries > 0) audit(target.root, { action: 'trash-purge', entries: result.entries, bytes: result.bytes });
        }
        json(res, OK({ entries, bytes }));
        return;
      }

      // ── 审计与诊断 ──────────────────────────────────────────────────────
      if (pathname === '/api/dsh-super-memory/audit' && method === 'GET') {
        const target = resolvePanelRoot(url.searchParams.get('workspace'));
        if (target === null) { json(res, FAIL({ code: 'forbidden', message: '未知工作区' }), 403); return; }
        const limit = parseCount(url.searchParams.get('limit'), 100, 500);
        json(res, OK({ workspace: target.workspace, entries: readAudit(target.root, limit) }));
        return;
      }

      if (pathname === '/api/dsh-super-memory/diagnostics' && method === 'GET') {
        const limit = parseCount(url.searchParams.get('limit'), 100, 500);
        const runtime = [];
        for (const state of states.values()) {
          runtime.push({
            sessionId: state.id,
            workspace: state.workspace ?? null,
            root: state.root,
            hits: state.hits,
            misses: state.misses,
            injectedTokensEst: state.injectedTokens,
            knownCompactions: state.knownCompactions.size,
            recapChars: state.recapText.length,
            // 会话内「没想起来？」按钮用它做诊断：最近一次提问（本地记账，不出本机）
            lastQuery: typeof state.lastRecallQuery === 'string' ? state.lastRecallQuery.slice(0, 500) : '',
            ...budgetInfo(state, current),
          });
        }
        json(res, OK({
          settingsPath: defaultSettingsPath(),
          diagPath: diag?.path ?? null,
          storeDirBytes: (() => {
            let total = 0;
            for (const workspace of knownWorkspaces()) {
              const root = storeRoot(workspace, current.storeDir);
              if (existsSync(root)) total += dirBytes(root);
            }
            return total;
          })(),
          runtime,
          recent: diag?.tail(limit) ?? [],
        }));
        return;
      }

      json(res, FAIL({ code: 'not-found', message: `未知接口 ${method} ${pathname}` }), 404);
    } catch (error) {
      json(res, FAIL({ code: 'internal', message: String(error?.message ?? error) }), 500);
    }
  };

  return { kind: 'prefix', path: '/api/dsh-super-memory', handler };
}
