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
  AUDIT_FILE, audit, dirBytes, listSessionFiles, listTrash, moveToTrash, purgeTrash, readAudit,
  readRecords, readTrashBlocks, removeTrashEntry, restoreFromTrash, safeSessionId,
  storeRoot, writeRecords,
} from './store.js';
import { MemoryIndex, retrieveTwoTier } from './retrieval.js';
import { formatRecall } from './recall.js';
import { buildRecap } from './recap.js';
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
  const { settings, diag, states, knownWorkspaces, build } = deps;

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
