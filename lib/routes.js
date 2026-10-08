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
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import {
  DEFAULTS, EDITABLE_FIELDS, dataHomeInfo, defaultDiagPath, defaultSettingsPath, resolveDshHome,
} from './config.js';
import {
  AUDIT_FILE, appendPair, audit, dirBytes, listSessionFiles, listTrash, moveToTrash,
  purgeTrash, readAudit, readPairs, readRecords, removeSessionExcerpts, removeTrashEntry,
  restoreFromTrash, safeSessionId, storeRoot, writeRecords,
} from './store.js';
import { MemoryIndex, localTopScore, retrieveTwoTier } from './retrieval.js';
import { formatRecall, queryTextOf, sourceLabelOf } from './recall.js';
import { writeExcerpt } from './transcript.js';
import { neutralizeHeaderText } from './text.js';
import { buildRecap } from './recap.js';
import { diagnoseMiss, tokenSpread } from './diagnose.js';
import { sessionTitleOf, shortSessionId } from './titles.js';

const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({ ok: false, error });

/** 「强命中」倍数：本地粗筛的最好一条已经达到 `minScore` 的这个倍数时，跳过查询改写。 */
export const STRONG_HIT_RATIO = 1.5;

/**
 * "强命中"分数线（点 ✕ 时决定要不要花钱改写的门槛）。
 *
 * 标定依据（2026-10-07，真实会话日志 89 条历史提问 + 本插件默认阈值 minScore=0.28，
 * 由 `scripts/measure-savings.mjs` 复现）：
 *   · `minScore` 是本地检索"算不算命中"的**操作点**（默认 0.28），它之上就是我们自己
 *     认定"这段内容能回答这个问题"的分数；
 *   · 粗筛候选（`index.search`，不带 L2 折扣）与注入判定（`retrieveTwoTier`，L2 乘 0.85）
 *     用的不是同一个数，所以门槛**必须高于** `minScore` 才不会在"擦边命中"上误判：
 *     1.5 × 0.28 = 0.42；该日志里 89 条提问有 31 条本地已命中，其中 29 条的粗筛 top-1
 *     越过 0.42（跳过改写），只剩 2 条仍走改写；取 2× 或 3× 只会多跳过 1 条 / 9 条，
 *     省下的钱微乎其微，却把"擦边命中"也一起跳掉 —— 不值，所以取 1.5×。
 *   · 取 `max(0, minScore, minScore × 1.5)`：即使有人把阈值设成 0 或负数，
 *     也不会出现"任何候选都算强命中"（那会让改写永远不触发）。
 * @param {number} minScore - 当前命中阈值。
 * @returns {number} 分数线。
 */
export function strongHitScore(minScore) {
  const base = Number.isFinite(minScore) ? minScore : 0;
  return Math.max(0, base, base * STRONG_HIT_RATIO);
}

/**
 * 唯一的子进程出口：`spawn` **立刻挂 `error` 监听**，并原样保留 `unref()` 语义。
 *
 * 为什么必须有这一层（只读审查报告的 1 号问题）：可执行文件不存在 / 权限不足时，
 * 失败走的是**异步 `error` 事件**，外层 `try/catch` 根本捕不到；而没有监听者的
 * `'error'` 在 Node 里会升级成**未捕获异常**，直接掀翻宿主进程（面板点一次「浏览」
 * 就能把 DSH 打挂）。所以任何 spawn 都必须经过这里：启动失败只写一行诊断 + 回调返回
 * 失败，绝不抛。
 *
 * 诊断日志走**可选注入**（`options.diag`）：模块内的 `revealInFileManager` 拿不到
 * 路由闭包里的 diag，所以用模块级 setter 注入（见 `setRevealDiag`）。没有日志时
 * 静默降级，行为仍然安全（不抛）。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数数组。
 * @param {object} [options] - `{windowsVerbatimArguments, diag, onError, spawnImpl}`。
 *   `spawnImpl` 只用于测试注入（默认就是 `node:child_process` 的 `spawn`），
 *   生产路径永远不传它。
 * @returns {import('node:child_process').ChildProcess|null} 子进程；同步抛错时 null。
 */
export function spawnDetached(command, args, options = {}) {
  const diag = options.diag ?? revealDiag ?? null;
  const launch = options.spawnImpl ?? spawn;
  const report = (detail) => {
    try {
      diag?.write?.({ at: new Date().toISOString(), event: 'reveal-spawn-error', command, args, message: String(detail ?? '') });
    } catch { /* 诊断失败绝不影响响应 */ }
    try { options.onError?.(); } catch { /* 回调异常同样吞掉 */ }
  };
  let child = null;
  try {
    child = launch(command, args, {
      detached: true,
      stdio: 'ignore',
      ...(options.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    report(error?.message ?? error);
    return null;
  }
  // 这里**必须**立刻挂上：异步 `error` 是"启动失败"的唯一通道，漏挂 = 未捕获异常 = 宿主崩。
  child.on('error', (error) => report(error?.message ?? error));
  try { child.unref(); } catch { /* unref 失败不影响已发起的进程 */ }
  return child;
}

/** 面板路由的 diag 注入点（`makeRoutes` 构造时设置，只写诊断、不影响行为）。 */
let revealDiag = null;

/**
 * 把插件诊断日志接到 spawn 失败上报上（由 `makeRoutes` 调用一次）。
 * @param {object|null} diag - 诊断日志（`{write(entry)}`）。
 */
export function setRevealDiag(diag) {
  revealDiag = diag ?? null;
}

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
        spawnDetached('explorer.exe', [`/select,"${native}"`], { windowsVerbatimArguments: true });
      } else {
        spawnDetached('explorer.exe', [native]);
      }
    } else if (process.platform === 'darwin') {
      spawnDetached('open', isFile ? ['-R', target] : [target]);
    } else {
      spawnDetached('xdg-open', [isFile ? dirname(target) : target]);
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

/**
 * 滑动窗口限流（每键独立计数 + 硬上限）。
 *
 * 为什么需要它（只读审查报告 4 号问题）：`/diagnose` 的 `rewrite: true` 来自请求体，
 * 而 DSH 的 web server **不做鉴权** —— 本机任意进程都可以反复 POST，等于每次点击都能
 * 让插件去花一次模型调用。限流不替代模型档位闸门（`llmAssistEnabled`/冷却/日上限都
 * 照旧生效），它只挡"同一会话在一分钟内被反复捶"。
 *
 * 纯内存、不落盘：进程重启即清零（这不是配额，是防抖）。
 */
export class RateLimiter {
  /**
   * @param {object} options - `{windowMs, max}`。
   */
  constructor(options = {}) {
    this.windowMs = Math.max(1000, Number(options.windowMs) || 60000);
    this.max = Math.max(1, Number(options.max) || 6);
    /** key → 时间戳数组（升序）。 */
    this.hits = new Map();
  }

  /** 阈值（面板/测试直接读它，避免两处写死不同数）。 */
  thresholds() {
    return { windowMs: this.windowMs, max: this.max };
  }

  /**
   * 尝试记一次调用。
   *
   * `options.bypass` 只给**测试**用：真实路径永远不带这个选项。存在的理由是要能把
   * "限流"与"强命中跳过改写"两条闸门分开验证 —— 否则一条命中率很高的库里
   * `localBest >= 1.5 × minScore` 会先一步跳过改写，限流分支根本不可达
   * （实测踩过：测试会误报"限流没生效"）。
   * @param {string} key - 限流键（这里用会话 id；空则用 '-'）。
   * @param {number} [at] - 当前时间（毫秒，测试可注入）。
   * @param {object} [options] - `{bypass: true}` 直接放行（仅测试）。
   * @returns {{allowed:boolean, used:number, max:number, retryAfterMs:number, message:string}} 判定结果。
   */
  hit(key, at = Date.now(), options = {}) {
    if (options.bypass === true) {
      return { allowed: true, used: 0, max: this.max, retryAfterMs: 0, message: '' };
    }
    const id = typeof key === 'string' && key !== '' ? key : '-';
    const cutoff = at - this.windowMs;
    const kept = (this.hits.get(id) ?? []).filter((stamp) => stamp > cutoff);
    if (kept.length >= this.max) {
      const retryAfterMs = Math.max(0, kept[0] + this.windowMs - at);
      this.hits.set(id, kept);
      return {
        allowed: false,
        used: kept.length,
        max: this.max,
        retryAfterMs,
        message: `这个会话最近 ${Math.round(this.windowMs / 1000)} 秒内已经让辅助模型改写查询 ${kept.length} 次`
          + `（上限 ${this.max} 次），请等约 ${Math.max(1, Math.ceil(retryAfterMs / 1000))} 秒再点；`
          + '本地检索结果不受影响。',
      };
    }
    kept.push(at);
    this.hits.set(id, kept);
    return { allowed: true, used: kept.length, max: this.max, retryAfterMs: 0, message: '' };
  }
}

/** 全进程共用一个限流器（`/diagnose` 的模型改写）。 */
const REWRITE_LIMITER = new RateLimiter({ windowMs: 60000, max: 6 });

/** 暴露给测试：确认阈值本身没被悄悄改成"等于不限"。 */
export function rewriteRateLimits() {
  return REWRITE_LIMITER.thresholds();
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
 * 记忆库里的摘抄目录是否被 git **跟踪**（不是"是否被忽略"）。
 *
 * 为什么单查这一项（2026-10-08 顺带发现）：`.gitignore` 里的 `.dsh-compaction-memory/`
 * 只对**未跟踪**文件生效。`_readable/excerpts/*.md` 里是"用户提问 + AI 回答"的逐字摘抄，
 * 一旦早先误提交过（或被人 `git add -f`），它就变成**已跟踪文件** —— 此后 `.gitignore`
 * 形同虚设，而插件删除摘抄时只是 `fs.rm`（不会 `git rm`），于是"删干净"之后
 * `git status` 里仍留着一份可读的对话原文。面板据此提醒用户去 `git rm --cached`。
 * @param {string} root - 记忆库根目录。
 * @returns {{excerptDir:string, tracked:boolean}} 摘抄目录路径与是否被 git 跟踪。
 */
function excerptGitState(root) {
  const dir = join(root, '_readable', 'excerpts');
  if (!existsSync(dir)) return { excerptDir: dir, tracked: false };
  try {
    // 只用 git 自己的退出码判定（0 = 该路径有被跟踪的文件）；任何异常都当作"没跟踪"，
    // 绝不因为一次 git 调用失败就阻断面板。
    const result = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', '_readable/excerpts'], {
      stdio: 'ignore',
      timeout: 4000,
    });
    return { excerptDir: dir, tracked: result.status === 0 };
  } catch {
    return { excerptDir: dir, tracked: false };
  }
}

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
 * 会话的注入量统计（**纯展示**）。
 *
 * 这里以前算的是"额度 = 上下文窗口 × `sessionBudgetRatio`"，以及"额度是否用尽"。
 * 2026-10-07 按用户实测决定删除那道闸门：一天只有 19 次辅助调用、整场超长会话的插件
 * 总开销约 6 万 token（主模型累积 5.6 亿 token，占比约 0.01%），而闸门唯一的实际效果
 * 是"命中率莫名其妙下降"。所以 `state.injectedTokens` 从"计费闸门"降级为**计数器**：
 * 只在面板上回答"这个会话一共注入过多少"。
 * @param {object} state - 会话状态。
 * @returns {object} 展示信息。
 */
function injectedInfo(state) {
  const usedTokens = Math.round(state.injectedTokens ?? 0);
  return {
    injectedTokens: usedTokens,
    // 兼容旧字段名（面板早先读的是这个；两个名字同值，避免漏改一处就显示成 undefined）
    injectedTokensEst: usedTokens,
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

/** 会话日志体积上限（与 host.js 的 `history_read` 闸门同一个数：64MB）。 */
export const SESSION_LOG_MAX_MB = 64;
/** 体积上限的字节形式。 */
const SESSION_LOG_MAX_BYTES = SESSION_LOG_MAX_MB * 1024 * 1024;

/**
 * 「日志太大，不能读」的可读提示（纯函数，便于直接测）。
 *
 * 只读审查报告 2b：`/diagnose`（点 ✕）与 `GET /trash?session=…` 会同步整份解压会话日志，
 * 却没有体积闸 —— 一个几百 MB 的日志就能把事件循环冻住。宿主侧的闸门在
 * `host.js` 的 `findSessionById` 里（超限就不解压），这里负责把**为什么点不动**说清楚，
 * 而不是笼统地报"未知工作区/点了没反应"。
 * @param {number|null} bytes - 日志字节数（取不到给 null）。
 * @returns {string} 超限时的提示；未超限返回 ''。
 */
export function sessionLogSizeHint(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '';
  if (bytes <= SESSION_LOG_MAX_BYTES) return '';
  return `这个会话的原始日志有 ${Math.round(bytes / 1048576)} MB，超过 ${SESSION_LOG_MAX_MB} MB 的读取上限，`
    + '插件没有解压它（避免卡住面板）。记忆库里已保存的内容照旧可查，'
    + '也可以直接把关键词说得更具体再试。';
}

/**
 * 构造面板路由。
 * @param {object} deps - 依赖。
 * @returns {object} webServer 路由定义。
 */
export function makeRoutes(deps) {
  const { settings, diag, states, knownWorkspaces, build, llm = null, dataHome = '' } = deps;
  // spawn 失败的诊断上报（见 spawnDetached 的注释：那条异步 error 漏挂会掀翻宿主）
  setRevealDiag(diag);

  /** 按会话 id 找会话对象（模型辅助要读 `model/selection` 以"跟随主模型"）。 */
  function findSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    try { return deps.findSession?.(sessionId) ?? null; } catch { return null; }
  }

  /**
   * workspace 参数校验：必须是**已知工作区**（面板登记 / DSH 工作区注册表 / 本进程见过）。
   *
   * 不能拿"记忆库目录存在"当放行依据：`storeDir` 允许配绝对路径，那时 `existsSync(root)`
   * 检查的是那个共享目录本身（永远为真），任何字符串都会被当成合法工作区 ——
   * 后面的删除、回收站、摘抄写入就都落到没校验过的路径上。
   * @param {string} workspace - 工作区路径。
   * @returns {{workspace:string, root:string}|null} 目标；未知工作区返回 null。
   */
  function resolvePanelRoot(workspace) {
    const current = settings.get().settings;
    if (typeof workspace !== 'string' || workspace.trim() === '') return null;
    const value = workspace.trim();
    if (!knownWorkspaces().includes(value)) return null;
    return { workspace: value, root: storeRoot(value, current.storeDir) };
  }

  /**
   * 会话自己的 cwd（**只来自宿主/会话日志**，绝不采信请求体里的路径）。
   * 实测：会话日志首行的 `type:"session"` 头记录里带顶层 `cwd`，`findSession` 会把它
   * 挂到 `header.cwd` 上（见 host.js `findSessionById` / `sessionLogCwd`）。
   * @param {string} sessionId - 会话 id。
   * @returns {string} cwd；取不到时 ''。
   */
  function sessionCwdOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return '';
    const own = findSession(sessionId);
    const cwd = own?.header?.cwd;
    return typeof cwd === 'string' ? cwd.trim() : '';
  }

  /**
   * 面板路由统一的工作区解析（**带"会话自己的 cwd"兜底**）。
   *
   * 为什么要兜底：插件刚重启时进程内没有任何会话状态，面板拿不到当前工作区
   * （`/diagnostics` 的 runtime 是空的），于是点 ✕ 只能报"未知工作区，先随便发一条消息"
   * —— 用户看到的就是"点了没反应"（2026-10-07 用户实测反馈）。
   *
   * 口径（两条都不能破）：
   *   ① 兜底值只能来自 `findSession(sessionId).header.cwd`（宿主对象 / 会话日志），
   *      **绝不允许**拿 `body.workspace` 里的任意字符串去试；
   *   ② 登记成"已知工作区"之后**仍然走 `resolvePanelRoot()`** 的
   *      `knownWorkspaces().includes()` 判定 —— 是让校验通过，不是跳过校验。
   * @param {unknown} workspace - 请求里带来的工作区（可空/未知）。
   * @param {unknown} sessionId - 请求里带来的会话 id（可空）。
   * @returns {{workspace:string, root:string}|null} 目标；解析不出来返回 null。
   */
  function resolveTarget(workspace, sessionId) {
    const direct = resolvePanelRoot(workspace);
    if (direct !== null) return direct;
    const cwd = sessionCwdOf(sessionId);
    if (cwd === '') return null;
    try { deps.rememberWorkspace?.(cwd); } catch { /* 登记失败就按未知处理 */ }
    return resolvePanelRoot(cwd);
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
        // 暴露出去。只接受**已知工作区**（见 resolvePanelRoot），否则回落到第一个已知工作区。
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
            knownCompactions: state.knownCompactions.size,
            ...injectedInfo(state),
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
        const target = resolveTarget(url.searchParams.get('workspace'), url.searchParams.get('session'));
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
        const target = resolveTarget(url.searchParams.get('workspace'), url.searchParams.get('session'));
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
        const target = resolveTarget(body.workspace, body.session);
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
        // 「打开原文」生成的摘抄（`_readable/excerpts/<会话id>-<ts>.md`）里是**逐字的
        // 提问与回答**，不跟着一起删就等于"删除"没删干净（只读审查报告 2a）。
        // 按会话 id 前缀 + assertInside 严格校验匹配，不做通配。
        const excerpts = removeSessionExcerpts(target.root, sessionId);
        audit(target.root, {
          action: ids === null ? 'delete-session' : 'delete-blocks',
          session: sessionId,
          blocks: victims.length,
          bytes: victims.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8'), 0),
          excerpts,
          trashId,
        });
        json(res, OK({ deleted: victims.length, remaining: remaining.length, trashId, trashed: trashId !== null, excerpts, excerptGit: excerptGitState(target.root) }));
        return;
      }

      // ── 未命中诊断（纯本地全库扫描，0 模型调用）────────────────────────
      if (pathname === '/api/dsh-super-memory/diagnose' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        // 工作区未知时用**会话自己的 cwd** 兜底（口径见 resolveTarget）：面板在"插件刚重启、
        // 还没读到会话状态"时拿不到工作区（body.workspace 为空），若直接 403，
        // 用户看到的就是"点了没反应"。cwd 只来自会话日志/宿主，登记后仍走 knownWorkspaces 判定。
        const target = resolveTarget(body.workspace, body.session);
        if (target === null) {
          // 日志过大时 `findSessionById` 会拒绝解压并返回 null —— 面板上表现为"未知工作区"，
          // 用户只会觉得"点了没反应"。所以这里先按体积给一条**具体**的原因。
          const large = sessionLogSizeHint(sessionLogInfo(String(body.session ?? ''))?.bytes ?? null);
          json(res, FAIL({
            code: large === '' ? 'forbidden' : 'log-too-large',
            message: large !== '' ? large : (body.session === undefined || body.session === ''
              ? '未知工作区（请求里没有会话 id，无法从会话日志读出 cwd；请带 session 再试）'
              : '未知工作区（这个会话的日志里也读不到 cwd；先随便发一条消息，让插件见到本会话，再点 ✕）'),
          }), 403);
          return;
        }
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
        // **候选必须只来自目标会话**：记忆库是按工作区放的，同一个工作区里通常躺着
        // 好几个会话的块。不过滤的话，别的会话（甚至别的项目话题）的内容会被当成
        // "本会话已压缩的历史"注入给模型 —— 用户看到的就是"它在说我根本没说过的事"。
        // 没有 `session` 字段的记录一律视为不匹配（旧格式/损坏文件不参与）。
        const wantedSession = typeof body.session === 'string' ? body.session : '';
        const records = readWorkspaceRecords(target.root)
          .filter((record) => wantedSession !== '' && String(record.session ?? '') === wantedSession);
        const index = new MemoryIndex(records);
        const report = diagnoseMiss({
          records,
          query,
          minScore: current.minScore,
          limit: parseCount(body.limit, 10, 20),
          search: (text, options) => index.search(text, { limit: options?.limit ?? 10 }),
        });

        // ③ 可选的模型辅助：查询改写（默认关）。
        //    `rewrite: true` 来自**用户点击**（会话内按钮/面板按钮）——点一次发一次，
        //    所以不需要预先打开 llmRecallRewrite；但仍要求总开关打开（那是联网的知情同意）。
        //    这里**不再有重排（rerank）分支**：唯一的消费者是已删除的死旋钮
        //    `llmRecallRerank`（面板无控件、applyLlmMode 也不设它 —— 那段代码永不可达）。
        //    注意：✕ 路径的**强相关判定**走的是 `deps.llm.rerank`（见下面 boost 分支），
        //    那条**保留不动**，它与这个设置键没有任何关系。
        const assist = { rewrite: null };
        /** 本次改写是否被限流挡下（回执里如实带出，用户才知道"为什么没花钱"）。 */
        let rewriteThrottle = null;
        const wantsRewrite = current.llmRecallRewrite === true || body.rewrite === true;
        // **本地已强命中 → 跳过改写**（2026-10-07，用户决定：不许为省 token 降智，
        // 只在"本来就能找到"时才跳过）。依据与标定见 `strongHitScore`。
        const localBest = localTopScore(report.candidates);
        const skipScore = strongHitScore(current.minScore);
        const skippedRewrite = wantsRewrite && llm !== null && current.llmAssistEnabled === true && localBest >= skipScore;
        if (skippedRewrite) {
          assist.rewrite = { ok: true, terms: [], cached: false, skipped: true, best: localBest, strong: skipScore };
          diag?.write?.({
            at: new Date().toISOString(),
            event: 'rewrite-skipped',
            session: String(body.session ?? ''),
            reason: 'local-strong-hit',
            best: localBest,
            strong: skipScore,
            candidates: report.candidates.length,
          });
        }
        if (llm !== null && current.llmAssistEnabled === true && !skippedRewrite) {
          const session = findSession(body.session);
          // 限流（只读审查报告 4）：`body.rewrite` 来自请求体，而 DSH 的 web server 不做鉴权
          // —— 本机任意进程都能反复 POST，每一次都会花一次模型调用。**只限流，不替代闸门**：
          // 上面那层 `llmAssistEnabled === true` 与网关内部的冷却/日上限照旧生效，
          // 关着模型档位时一次都不会调用（限流器在 `wantsRewrite` 之后才计数，
          // 所以"没打算改写"的请求不会白吃配额）。
          if (wantsRewrite) {
            const verdict = REWRITE_LIMITER.hit(String(body.session ?? ''), Date.now(), { bypass: body.__bypassRewriteLimit === true });
            if (!verdict.allowed) {
              rewriteThrottle = verdict;
              assist.rewrite = { ok: false, code: 'RATE_LIMITED', hint: verdict.message };
              diag?.write?.({
                at: new Date().toISOString(),
                event: 'rewrite-throttled',
                session: String(body.session ?? ''),
                used: verdict.used,
                max: verdict.max,
                windowMs: verdict.retryAfterMs > 0 ? REWRITE_LIMITER.thresholds().windowMs : 0,
              });
            }
          }
          if (wantsRewrite && rewriteThrottle === null) {
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
        }

        // 给会话内「✕」用的**资料原文**：取分数最高的若干块（**只取对话内容**，
        // 工具结果是给检索用的原料，人读起来是噪声）。每块 600 字符上限用于**注入**。
        const pickedRecords = (() => {
          const byFp = new Map(records.map((record) => [record.fp, record]));
          const out = [];
          for (const item of report.candidates ?? []) {
            const record = byFp.get(item.fp);
            if (record === undefined || record.src === 'tool') continue;
            if (String(record.text ?? '').trim() === '') continue;
            out.push({ ...record, score: item.score });
            if (out.length >= 3) break;     // 最多 3 段：够用且不淹没上下文
          }
          return out;
        })();
        const materialOf = (list) => list
          .map((record) => `【${sourceLabelOf(record)}】${record.title || '(无标题)'}\n${neutralizeHeaderText(String(record.text ?? '')).replace(/\s+/g, ' ').trim().slice(0, 600)}`)
          .join('\n\n');
        const material = materialOf(pickedRecords);
        // 「✕」的 boost 模式：把资料排进**下一轮**注入（不回给界面 —— 用户看不到任何提示词）
        if (body.boost === true) {
          const model = String(current.llmIngestModel || current.llmRecallModel || '');
          // **强相关判定**（用户明确要求）：长会话里"有点关系"的内容很多，但只有
          // 会**改变答案**的那种才算数。配了辅助模型就让它判（只回一个编号，回 0 = 都不强相关）；
          // 没配模型则退回本地阈值（行为与旧版一致）。
          let strong = pickedRecords;
          if (typeof deps.llm?.rerank === 'function' && pickedRecords.length > 1) {
            try {
              const judged = await deps.llm.rerank({
                session: findSession(String(body.session ?? '')),
                query,
                candidates: pickedRecords.map((record) => ({
                  fp: record.fp,
                  title: record.title ?? '',
                  preview: String(record.text ?? '').replace(/\s+/g, ' ').slice(0, 100),
                })),
              });
              if (judged.ok === true) {
                strong = judged.fp === null ? [] : pickedRecords.filter((record) => record.fp === judged.fp);
                diag?.write?.({ at: new Date().toISOString(), event: 'strong-relevance', session: String(body.session ?? ''), index: judged.index, kept: strong.length });
              }
            } catch { /* 判定失败就退回本地结果，不阻断 ✕ */ }
          }
          const found = strong.length > 0;
          const strongMaterial = materialOf(strong);
          const queued = found && typeof deps.boostFor === 'function'
            ? deps.boostFor(String(body.session ?? ''), strongMaterial) === true
            : false;
          // 「打开原文」打开的是**相关段落摘抄**（有几段相关就摘几段、逐字原文、
          // 只留提问与回答）—— 纯代码生成，0 token（用户明确要求：摘抄用代码省 token）。
          // 没有任何对话段落命中 → 不产出文件，前端也就不显示这个按钮。
          let file = '';
          let excerptInfo = { ok: false, reason: 'no-passage' };
          try {
            // 摘抄只包含**强相关**的那几段（辅助模型判过），不是本地粗筛的全部候选
            const written = writeExcerpt(target.root, String(body.session ?? ''), strong, {
              model,
              query,
              sourceFile: join(target.root, `${String(body.session ?? '')}.jsonl`),
            });
            // 回执里的段数必须是**真正摘抄进去的**段数（strong），不是粗筛候选数：
            // 下面的 diag `excerpt` 事件直接读 excerptInfo.passages，所以数字自动同步。
            if (written !== null) { file = written; excerptInfo = { ok: true, passages: strong.length }; }
          } catch (error) {
            excerptInfo = { ok: false, reason: String(error?.message ?? error) };
          }
          diag?.write?.({ at: new Date().toISOString(), event: 'excerpt', session: String(body.session ?? ''), ok: excerptInfo.ok, reason: excerptInfo.reason ?? '', passages: excerptInfo.passages ?? 0, file });
          json(res, OK({
            verdict: report.verdict, found, boosting: queued, chars: strongMaterial.length, model,
            material,
            file,
            // 改写回执也一并带出（面板不显示，但排障要能看出"模型到底帮没帮上忙"）。
            // boost 分支的 `material` 是整段资料，不含提示词，所以这里带 assist 不会泄露什么。
            assist,
            // 这次有没有跳过查询改写（本地已强命中）。**只是回执字段**：面板照旧不弹提示，
            // 但"找没找到"那一行可以顺带说清楚"没用模型改写也找到了"。
            // boost 分支不返回 assist（用户看不到提示词），所以这个标记要单独带出来。
            rewriteSkipped: skippedRewrite,
            // 被限流时如实带出（用户/排障一眼看出"这次没花钱"以及为什么）
            rewriteThrottled: rewriteThrottle === null ? null : { used: rewriteThrottle.used, max: rewriteThrottle.max, hint: rewriteThrottle.message },
          }));
          return;
        }
        json(res, OK({
          ...report,
          material,
          assist,
          rewriteThrottled: rewriteThrottle === null ? null : { used: rewriteThrottle.used, max: rewriteThrottle.max, hint: rewriteThrottle.message },
          spread: tokenSpread(records, query),
          pairs: readPairs(target.root, 5),
        }));
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
      // 面板侧已不再调用（旧的诊断弹窗已移除）；目前由自检脚本 scripts/harness.mjs 消费。
      if (pathname === '/api/dsh-super-memory/pair' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolveTarget(body.workspace, body.session);
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
        const target = resolveTarget(body.workspace, body.session);
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
        const target = resolveTarget(body.workspace, body.session);
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
        const target = resolveTarget(url.searchParams.get('workspace'), url.searchParams.get('session'));
        if (target === null) {
          // 与 /diagnose 同一个口径：`?session=` 存在时，`resolveTarget` 会走
          // `findSession(sessionId).header.cwd` —— 那条路径要**整份解压会话日志**，
          // 所以先过体积闸（只读审查报告 2b），超限就友好失败而不是冻住事件循环。
          const large = sessionLogSizeHint(sessionLogInfo(String(url.searchParams.get('session') ?? ''))?.bytes ?? null);
          json(res, FAIL({ code: large === '' ? 'forbidden' : 'log-too-large', message: large === '' ? '未知工作区' : large }), 403);
          return;
        }
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

      if (pathname === '/api/dsh-super-memory/trash/restore' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) { json(res, FAIL({ code: 'bad-request', message: '请求体不是合法 JSON' }), 400); return; }
        const target = resolveTarget(body.workspace, body.session);
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
        const target = resolveTarget(body.workspace, body.session);
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
          ? [resolveTarget(body.workspace, body.session)]
          : knownWorkspaces().map((workspace) => resolvePanelRoot(workspace));
        let entries = 0;
        let bytes = 0;
        let excerpts = 0;
        for (const target of targets) {
          if (target === null) continue;
          // `purgeTrash` 同时清掉 `_readable/excerpts/` 的摘抄（里面有逐字问答）
          const result = purgeTrash(target.root);
          entries += result.entries;
          bytes += result.bytes;
          excerpts += result.excerpts ?? 0;
          if (result.entries > 0 || (result.excerpts ?? 0) > 0) {
            audit(target.root, { action: 'trash-purge', entries: result.entries, bytes: result.bytes, excerpts: result.excerpts ?? 0 });
          }
        }
        json(res, OK({ entries, bytes, excerpts }));
        return;
      }

      // ── 审计与诊断 ──────────────────────────────────────────────────────
      // /audit 面板侧不请求；目前由自检脚本 scripts/harness.mjs 消费。
      if (pathname === '/api/dsh-super-memory/audit' && method === 'GET') {
        const target = resolveTarget(url.searchParams.get('workspace'), url.searchParams.get('session'));
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
            knownCompactions: state.knownCompactions.size,
            recapChars: state.recapText.length,
            // 会话内「没想起来？」按钮用它做诊断：最近一次提问（本地记账，不出本机）
            lastQuery: typeof state.lastRecallQuery === 'string' ? state.lastRecallQuery.slice(0, 500) : '',
            ...injectedInfo(state),
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
