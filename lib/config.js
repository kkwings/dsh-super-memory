/**
 * dsh-super-memory — 配置与设置持久化
 *
 * 启动默认值写在代码里（不占 profile 的 cordis.patch.yml）；
 * 用户在「设置 → 超级记忆」里的改动写入
 * $DSH_HOME/dsh-super-memory.settings.json，宿主每次用到时现读，即时生效、重启保持。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 设置文件格式版本（写进文件，便于将来迁移）。 */
const SETTINGS_VERSION = 1;

/** 写死的默认值（对应交接报告 §5.8 / §1.2 的成本红线）。 */
export const DEFAULTS = Object.freeze({
  enabled: true,

  // ① 注入开关
  injectRecap: true,
  injectRecall: true,

  // ② 入库开关（都是 0 模型调用）
  ingestSummary: true,
  ingestRawText: true,

  // ③ 成本上限（都是**单次**口径）。
  //
  // 这里曾经还有一个"会话累计注入上限"（`sessionBudgetRatio`，默认窗口 2%），2026-10-07 按
  // 用户实测决定**删除**：一天只有 19 次辅助调用、整场超长会话的插件总开销约 6 万 token，
  // 而主模型累积已用 5.6 亿 token（占比约 0.01%）。累计闸门带来的唯一实际效果是"命中率
  // 会莫名其妙下降"——用户不会想到是自己多点了几次 ✕ 把额度花完了。成本控制改由**单次**
  // 口径负责（总览上限 / 单轮上限 / 单次输出上限 / 每批块数 / 每块字符数 / 日调用上限）。
  compactionRecapMaxTokens: 300,
  maxTokensPerTurn: 500,
  maxItems: 2,
  maxCharsPerItem: 300,

  // 总览注入形态：true = 本次压缩窗口内保持稳定（省一次快照追加，推荐）；
  // false = 压缩后只注入一轮（严格照报告 §5.3）
  recapPersist: true,

  // 参考块注入形态：true = 命中过的参考块在本窗口内一直挂着（推荐）。
  // 下一次未命中时若把它撤掉，整份运行上下文快照的文本就变了，DSH 会再追加一份
  // （实测 1054 字符 ≈ 252 token）。挂着则文本不变、不再追加，且历史参考始终可见。
  stickyRecall: true,

  // 检索
  observationTurns: 3,
  minScore: 0.28,
  dedupe: true,
  cooldownTurns: 1,
  preferSummaryChunks: true,

  // 入库口径：思考过程**永不入库**。工具结果默认只收"读类工具"的结果原文
  // （模型读过的设定文件/章节/检索结果，往往是项目真正的知识），带白名单与两级上限；
  // shell 之类的高噪声输出默认不收。
  storeDir: '.dsh-compaction-memory',
  includeToolResults: true,
  toolResultNames: 'read, grep, glob, web_fetch, history_read',
  toolResultMaxChars: 4000,
  toolResultBudgetChars: 120000,
  includePrune: false,
  maxRawCharsPerCompaction: 400000,
  backfillOnStart: true,

  // 本地记忆管理
  trashEnabled: true,
  protectRecentDays: 7,
  trashAutoPurgeEnabled: true,
  trashAutoPurgeDays: 7,

  // 诊断
  logScores: true,

  // 模型辅助（可选；**默认全关**，关着时行为与"没有这个功能"逐字节一致）
  // 铁律：模型只用在 ① 压缩入库时 与 ③ 用户主动点击"未命中诊断"之后，绝不进提问热路径。
  llmAssistEnabled: false,
  llmIngestExpand: false,
  llmIngestProvider: '',
  llmIngestModel: '',
  llmIngestTimeoutMs: 8000,
  // 每批块数 5 → 8（2026-10-07，用户决定：再砍一刀成本，但**不许为省 token 降智**）。
  // 依据：扩写的每块输入字符数由 `llmIngestBlockChars`（600）夹死，与批大小无关，
  // 所以"同样的块摊到更少的调用"是纯省钱 —— 15 块从 3 次调用降到 2 次，
  // 系统提示词（约 120 token）也少交一次。批大了唯一风险是"整批 JSON 解析失败就整批丢"，
  // 因此 24 块的输出上限（见 llmIngestMaxTokens）与 240 的额度配套，格式不对仍然整批放弃、
  // 保留原有词频（绝不写坏数据）。
  llmIngestBatchBlocks: 8,
  // 每块**送多少字符**给模型做关键词扩写（2026-10-07 新增，取代原先写死的 1200）。
  // 实测 1200 时一次压缩入库的输入是 3,926 字符；600 已足够覆盖"这块在讲什么"，
  // 输入 token 直接砍掉约一半（扩写只需要主题，不需要全文细节）。
  llmIngestBlockChars: 600,
  // 单次**输出**上限。600 → 300 → 240（2026-10-07）：一批 8 块的严格 JSON
  // （`{"0":["词",…]}`，每块 3–6 个 ≤24 字的词）用不到 240 token；
  // 实测模型常在额度里"多说几句"再被我们丢掉（格式不对就整批放弃），收紧反而更稳。
  llmIngestMaxTokens: 240,
  llmRecallRewrite: false,
  llmRecallRerank: false,
  llmRecallProvider: '',
  llmRecallModel: '',
  // ✕ 路径的检索调用超时 4000 → 8000（2026-10-07，用户决定）。
  // 依据：这条路径本来就是"用户在等一个明确结果"，而且现在有「检索中」提示（见 client.js
  // MissTail），等待是可见的；实测思考型模型（glm-5.3-flash）4 秒常常只吐思考、正文一个字
  // 都没有 → 这一次就白点了。8 秒是**上限**，不是每次都等满：模型正常返回就立刻结束。
  llmRecallTimeoutMs: 8000,
  // 查询改写的输出上限：只要求 5–10 个关键词（JSON 数组），120 token 足够；
  // 原先 200 是白给的额度（模型会用它写解释，反而更容易触发 BAD_OUTPUT 被整批丢弃）。
  llmRewriteMaxTokens: 120,
  // 每日调用上限：**默认 0 = 不限**（2026-10-07 按用户实测改，原先 200）。
  // 依据：一天实测只有 19 次调用，200 的闸门从未触发；而它一旦触发就是"静默停用到次日"，
  // 用户只会觉得插件突然不灵了。字段保留，想自设上限的人仍然可以填。
  llmDailyCallCap: 0,
  llmCacheEnabled: true,
  // 思考强度：**插件没有这个概念，也不许有**（2026-10-07 按用户决定删除 `llmReasoningEffort`）。
  // 插件只让模型做"换个说法"这类小事，思考强度完全交给 DSH 官方「设置 → 模型」页；
  // 插件既不指定、也**绝不继承主对话的**（继承会又慢又贵 —— 实测确认过这就是个 bug）。

  // ── 用哪个模型：只给三种选择（用户明确要求，取代早先"入库/检索各配一套"）──
  //   off    = 插件不调用大模型（默认；命中率稍低，成本最低）
  //   main   = 调用主模型（命中率高，成本随主模型）
  //   custom = 调用指定模型（命中率高，成本随所选模型）
  // llmProvider/llmModel 只在 custom 下有意义；内部仍用 ingest/recall 两对字段，
  // 由 normalizeSettings 从模式**派生** —— 宿主代码因此不需要任何改动。
  // 说明：可读文档**只在用户点 ✕ 的「打开原文」时生成一份"相关段落摘抄"**（短、
  // 逐字、0 token）。早先设想的"每次压缩落一份整会话 L2 抄本"经用户判定取消，
  // 因此这里不保留任何开关（不留死旋钮）。
  llmMode: 'off',
  llmProvider: '',
  llmModel: '',
});

/** 布尔字段白名单。 */
const BOOLEAN_FIELDS = Object.freeze([
  'enabled', 'injectRecap', 'injectRecall', 'ingestSummary', 'ingestRawText',
  'recapPersist', 'stickyRecall', 'dedupe', 'preferSummaryChunks',
  'includeToolResults', 'includePrune', 'backfillOnStart', 'trashEnabled',
  'trashAutoPurgeEnabled', 'logScores',
  'llmAssistEnabled', 'llmIngestExpand', 'llmRecallRewrite', 'llmRecallRerank', 'llmCacheEnabled',
]);

/** 整数字段白名单及其下限（0 表示允许为 0）。 */
const INTEGER_FIELDS = Object.freeze({
  compactionRecapMaxTokens: 0,
  maxTokensPerTurn: 0,
  maxItems: 0,
  // 下限 50（不是 0、也不是 20）：20 字符连一句结论都装不下，注入了也是白花 token；
  // 不想注入应当去关注入开关，而不是把每条压到没有信息量。
  maxCharsPerItem: 50,
  observationTurns: 1,
  cooldownTurns: 0,
  maxRawCharsPerCompaction: 0,
  protectRecentDays: 0,
  trashAutoPurgeDays: 1,
  toolResultMaxChars: 200,
  toolResultBudgetChars: 0,
  llmIngestTimeoutMs: 1,
  llmIngestBatchBlocks: 1,
  llmIngestBlockChars: 100,
  llmIngestMaxTokens: 1,
  llmRecallTimeoutMs: 1,
  llmRewriteMaxTokens: 1,
  llmDailyCallCap: 0,
});

/** 浮点字段白名单（目前只剩命中阈值；原有的 `sessionBudgetRatio` 已按用户决定删除）。 */
const NUMBER_FIELDS = Object.freeze(['minScore']);

/** 字符串字段白名单（不允许为空）。 */
const STRING_FIELDS = Object.freeze(['storeDir', 'toolResultNames']);

/** 允许为空的字符串字段：空 = **跟随当前会话的主模型**（不填就是默认行为）。 */
const OPTIONAL_STRING_FIELDS = Object.freeze([
  'llmIngestProvider', 'llmIngestModel', 'llmRecallProvider', 'llmRecallModel',
  'llmMode', 'llmProvider', 'llmModel',
]);

/**
 * 把"三种选择"派生成内部使用的两对字段（入库 / 检索）。
 *
 * 用户只需要回答一个问题：**插件要不要调用模型、调用哪个**。内部保留两对字段是为了
 * 不改动宿主与网关的既有代码路径（也方便将来需要时再拆开）。
 * @param {object} out - 正在规范化中的设置对象（会被就地修改）。
 * @returns {object} 同一个对象。
 */
function applyLlmMode(out) {
  const mode = out.llmMode === 'main' || out.llmMode === 'custom' ? out.llmMode : 'off';
  out.llmMode = mode;
  if (mode === 'off') {
    out.llmAssistEnabled = false;
    out.llmIngestExpand = false;
    out.llmRecallRewrite = false;
    out.llmIngestProvider = '';
    out.llmIngestModel = '';
    out.llmRecallProvider = '';
    out.llmRecallModel = '';
    return out;
  }
  // 选了模式 = 明确要它干活：两个时机都开（检索那条仍然只在用户点击时才真的调用）
  out.llmAssistEnabled = true;
  out.llmIngestExpand = true;
  out.llmRecallRewrite = true;
  const provider = mode === 'custom' ? String(out.llmProvider ?? '') : '';
  const model = mode === 'custom' ? String(out.llmModel ?? '') : '';
  out.llmIngestProvider = provider;
  out.llmIngestModel = model;
  out.llmRecallProvider = provider;
  out.llmRecallModel = model;
  return out;
}

/** 面板可改的全部键。 */
export const EDITABLE_FIELDS = Object.freeze([
  ...BOOLEAN_FIELDS, ...Object.keys(INTEGER_FIELDS), ...NUMBER_FIELDS, ...STRING_FIELDS, ...OPTIONAL_STRING_FIELDS,
]);

/** DSH_HOME 解析（环境变量优先，回落到 ~/.dsh）。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * 插件**全局数据**目录（设置 + 诊断日志）。
 *
 * 记忆本体永远在工作区的 `.dsh-compaction-memory` 里；只有这两个跨工作区的文件需要
 * 一个"全局的家"。默认跟 DSH 自己的配置放一起（`$DSH_HOME`）；如果不想让它落在系统盘，
 * 设环境变量 `DSH_SUPER_MEMORY_HOME` 指到任意目录即可（例：`E:\DSH-data\dsh-super-memory`）。
 * @returns {string} 全局数据目录绝对路径。
 */
export function resolveDataHome() {
  const fromEnv = process.env.DSH_SUPER_MEMORY_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return resolveDshHome();
}

/**
 * 全局数据目录的来源（面板用它提示"现在落在哪个盘、为什么"）。
 * @returns {{dir:string, source:'env'|'dsh-home', envName:string}} 目录与来源。
 */
export function dataHomeInfo() {
  const fromEnv = process.env.DSH_SUPER_MEMORY_HOME;
  const hasEnv = typeof fromEnv === 'string' && fromEnv.trim() !== '';
  return { dir: hasEnv ? fromEnv.trim() : resolveDshHome(), source: hasEnv ? 'env' : 'dsh-home', envName: 'DSH_SUPER_MEMORY_HOME' };
}

/** 默认设置文件路径。 */
export function defaultSettingsPath() {
  return join(resolveDataHome(), 'dsh-super-memory.settings.json');
}

/** 诊断日志路径（与工作区内的记忆库分开，删库不会连带丢日志）。 */
export function defaultDiagPath() {
  return join(resolveDataHome(), 'dsh-super-memory.diag.jsonl');
}

function clampInt(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const v = Math.floor(value);
  // 越界就夹到边界，而不是悄悄变回默认值（否则 observationTurns:0 会变成 3，
  // 用户看到的值和他填的完全不是一回事）
  const clamped = v < minimum ? minimum : v;
  return maximum === undefined ? clamped : Math.min(maximum, clamped);
}

/**
 * 把不可信的部分设置规范化到已知良好的默认值之上。
 * @param {unknown} value - 待规范化的部分设置。
 * @param {object} [defaults] - 默认值。
 * @returns {object} 完整设置对象。
 */
export function normalizeSettings(value, defaults = DEFAULTS, options = {}) {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  const out = { ...defaults };
  for (const key of BOOLEAN_FIELDS) {
    if (typeof record[key] === 'boolean') out[key] = record[key];
  }
  for (const [key, minimum] of Object.entries(INTEGER_FIELDS)) {
    if (key in record) out[key] = clampInt(record[key], defaults[key], minimum, key === 'maxItems' ? 5 : undefined);
  }
  for (const key of NUMBER_FIELDS) {
    const v = record[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  // `llmIngestBlockChars` 有**上限**（4000）：超过 4000 就不是"每块送多少"而是"整块灌进去"，
  // 那正是要收紧的东西。夹到边界而不是悄悄回落到默认值（用户填 9999 应看到 4000）。
  out.llmIngestBlockChars = clampInt(out.llmIngestBlockChars, defaults.llmIngestBlockChars, 100, 4000);
  // 字符串字段：统一 trim + 长度上限。storeDir 另有"不能含 .."的规则（见下），
  // 空串一律视为"用默认值"，避免面板清空后插件拿到空目录名。
  for (const key of STRING_FIELDS) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const next = raw.trim().slice(0, 300);
    if (next !== '') out[key] = next;
  }
  // 可为空的字符串（provider/model）：空串是**有意义的取值**（= 跟随主模型），要原样保留
  for (const key of OPTIONAL_STRING_FIELDS) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    out[key] = raw.trim().slice(0, 120);
  }
  if (typeof out.storeDir === 'string' && out.storeDir.split(/[\\/]/).includes('..')) {
    out.storeDir = defaults.storeDir;
  }

  // 插件自己的登记信息（面板用它按工作区分组）：不在"可编辑字段"里，但必须**原样保留**。
  // 否则每次改设置、每次重载设置文件都会把它丢掉（曾经的 bug：改个开关，工作区名单就空了）。
  const known = record.knownWorkspaces ?? defaults.knownWorkspaces;
  if (Array.isArray(known)) {
    out.knownWorkspaces = known.filter((item) => typeof item === 'string' && item !== '').slice(0, 40);
  }
  // 派生夹紧：会话累计占比的上限（0.5）随 `sessionBudgetRatio` 一起去掉了。
  // 用户只需选"用哪个模型"，内部两对字段由模式派生。
  //
  // **派生条件必须严格**：只认"这次提交/这份文件**真的带了非默认的 llmMode**"。
  // 早先写成 `'llmMode' in record` —— 而设置文件里一旦被写入默认的 'off'，
  // 之后**每次保存任何设置**都会触发派生，把用户刚选的 provider/model 清空、
  // 开关也关掉（实测现象：下拉选了就弹回"跟随主模型"、点不动）。
  const modeExplicit = options.deriveMode !== undefined
    ? options.deriveMode === true
    : ('llmMode' in record && record.llmMode !== defaults.llmMode);
  if (modeExplicit) applyLlmMode(out);
  return out;
}

/**
 * 校验面板提交的增量设置。返回错误信息字符串，或 undefined 表示通过。
 * @param {unknown} patch - 面板提交的字段。
 * @param {object} base - 当前设置。
 * @returns {string|undefined} 错误信息。
 */
export function validatePatch(patch, base) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return '设置必须是一个对象';
  const keys = Object.keys(patch);
  if (keys.length === 0) return '没有需要更新的字段';
  const unknown = keys.find((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown !== undefined) return `未知设置项：${unknown}`;
  for (const key of BOOLEAN_FIELDS) {
    if (key in patch && typeof patch[key] !== 'boolean') return `${key} 必须是布尔值`;
  }
  for (const [key, minimum] of Object.entries(INTEGER_FIELDS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (!Number.isSafeInteger(v) || v < minimum) return `${key} 必须是不小于 ${minimum} 的整数`;
    if (key === 'maxItems' && v > 5) return 'maxItems 最大为 5';
  }
  for (const key of NUMBER_FIELDS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${key} 必须是不小于 0 的数字`;
  }
  for (const key of STRING_FIELDS) {
    if (key in patch && (typeof patch[key] !== 'string' || patch[key].trim() === '')) return `${key} 必须是非空字符串`;
    if (key in patch && patch[key].length > 300) return `${key} 太长（上限 300 字符）`;
  }
  if (typeof patch.storeDir === 'string' && patch.storeDir.split(/[\\/]/).includes('..')) {
    return 'storeDir 不能包含 ..（它参与删除时的路径拼接）';
  }
  if (patch.toolResultMaxChars !== undefined && patch.toolResultMaxChars > 20000) return '单条工具结果上限最大 20000 字符';
  if (patch.toolResultBudgetChars !== undefined && patch.toolResultBudgetChars > 2000000) return '每次压缩的工具结果上限最大 2000000 字符';
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'string') return `${key} 必须是字符串（空 = 跟随主模型）`;
    if (patch[key].length > 120) return `${key} 太长（上限 120 字符）`;
  }
  if (patch.llmIngestTimeoutMs !== undefined && patch.llmIngestTimeoutMs > 300000) return '入库调用超时最大 300000 毫秒';
  if (patch.llmRecallTimeoutMs !== undefined && patch.llmRecallTimeoutMs > 300000) return '检索调用超时最大 300000 毫秒';
  if (patch.llmDailyCallCap !== undefined && patch.llmDailyCallCap > 100000) return '每日调用上限最大 100000';
  if (patch.llmIngestBatchBlocks !== undefined && patch.llmIngestBatchBlocks > 50) return '每批块数最大 50';
  if (patch.llmIngestBlockChars !== undefined && patch.llmIngestBlockChars > 4000) return '每块字符数最大 4000（这就是要收紧的那个量，别再放大）';
  if (patch.llmIngestBlockChars !== undefined && patch.llmIngestBlockChars < 100) return '每块字符数最小 100（再小模型就看不出这块在讲什么了）';
  if (patch.llmIngestMaxTokens !== undefined && patch.llmIngestMaxTokens > 8000) return '单次输出上限最大 8000 token';
  if (patch.llmRewriteMaxTokens !== undefined && patch.llmRewriteMaxTokens > 4000) return '查询改写输出上限最大 4000 token';
  const merged = { ...base, ...patch };
  if (merged.compactionRecapMaxTokens > 2000) return '压缩后总览上限最大 2000 token';
  if (merged.maxTokensPerTurn > 4000) return '单轮注入上限最大 4000 token';
  if (merged.trashAutoPurgeEnabled && merged.trashAutoPurgeDays < 1) return '回收站自动清空天数至少为 1';
  return undefined;
}

/** 原子写文件（同目录临时文件 + rename）。 */
export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    throw error;
  }
}

/**
 * 进程中现读的设置存储：写入即落盘并广播，宿主各处每次现读 → 即时生效。
 */
export class SettingsStore {
  /** @param {object} [options] - 选项。 */
  constructor(options = {}) {
    this.path = options.path ?? defaultSettingsPath();
    this.defaults = normalizeSettings(options.defaults ?? {}, DEFAULTS);
    this.value = { ...this.defaults };
    this.persisted = false;
    this.listeners = new Set();
    this.load();
  }

  /** 当前设置快照。 */
  get() {
    return { settings: { ...this.value }, source: this.persisted ? 'web' : 'default' };
  }

  /** 订阅变更。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * 更新设置（浅合并 + 落盘 + 广播）。
   * @param {object} patch - 字段增量。
   * @returns {object} 新快照。
   */
  update(patch) {
    const error = validatePatch(patch, this.value);
    if (error !== undefined) throw new TypeError(error);
    const next = normalizeSettings({ ...this.value, ...patch }, this.defaults, { deriveMode: 'llmMode' in patch });
    this.save(next);
    this.value = next;
    this.persisted = true;
    return this.emit();
  }

  /** 清除覆盖，回到启动默认值（保留"已知工作区"这类登记信息，否则面板列表会突然变空）。 */
  reset() {
    try { if (existsSync(this.path)) unlinkSync(this.path); } catch { /* 忽略 */ }
    this.value = normalizeSettings({ knownWorkspaces: this.value.knownWorkspaces }, this.defaults);
    this.persisted = false;
    return this.emit();
  }

  /** 记录一个"已知工作区"（用于面板按工作区分组列出，最多保留 40 个）。 */
  rememberWorkspace(root) {
    if (typeof root !== 'string' || root === '') return;
    const list = Array.isArray(this.value.knownWorkspaces) ? this.value.knownWorkspaces.slice() : [];
    const next = [root, ...list.filter((item) => item !== root)].slice(0, 40);
    if (next.length === list.length && next.every((item, i) => item === list[i])) return;
    this.value = { ...this.value, knownWorkspaces: next };
    try { this.save(this.value); } catch { /* 记忆工作区失败不影响主流程 */ }
  }

  emit() {
    const snapshot = this.get();
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); } catch { /* 监听器异常不影响设置写入 */ }
    }
    return snapshot;
  }

  load() {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      const known = Array.isArray(parsed.knownWorkspaces)
        ? parsed.knownWorkspaces.filter((item) => typeof item === 'string').slice(0, 40)
        : [];
      const candidate = {};
      for (const key of EDITABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) candidate[key] = parsed[key];
      }
      this.value = { ...normalizeSettings(candidate, this.defaults), knownWorkspaces: known };
      this.persisted = true;
    } catch {
      // 损坏的可选设置文件不能让 DSH 起不来：保持默认值，等用户显式保存。
    }
  }

  save(value) {
    const payload = { version: SETTINGS_VERSION, ...value };
    // 已删除的设置项必须**真的从盘上消失**：`load()` 只挑 EDITABLE_FIELDS 里的键，
    // 所以旧文件里的 `sessionBudgetRatio` / `llmReasoningEffort` 不会再被读回来；
    // 这里再显式删一次，让用户下次打开设置文件时不会看到一个"还在、但改不动"的死旋钮。
    delete payload.sessionBudgetRatio;
    delete payload.llmReasoningEffort;
    writeFileAtomic(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

/** 极简追加式诊断日志（有上限，防止无限增长）。 */
export class DiagnosticsLog {
  /** @param {object} [options] - 选项。 */
  constructor(options = {}) {
    this.path = options.path ?? defaultDiagPath();
    this.enabled = options.enabled ?? true;
    this.maxLines = options.maxLines ?? 4000;
    // 从文件既有行数起算：否则每次启动都从 0 数，文件会一路长到 2×maxLines + 上次残留
    this.lines = 0;
    try {
      if (existsSync(this.path)) {
        this.lines = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
      }
    } catch { /* 读不到就从 0 起算 */ }
  }

  /**
   * 追加一条诊断记录；失败静默。
   *
   * `options.scoring` 标记"这条是**每条召回的打分日志**"（量最大、最可选的那类）：
   * 只有它受 `logScores`（= `this.enabled`）开关控制。错误 / 入库 / 加载失败这类
   * **排查问题必需的**事件一律照写 —— 曾经整个日志被这一个开关连带关掉，用户一关
   * 打分日志，真出问题时连一条证据都没有（"为什么没想起"永远查不出来）。
   * @param {object} entry - 记录。
   * @param {object} [options] - `{scoring: true}` = 属于可开关的打分日志。
   */
  write(entry, options = {}) {
    if (options.scoring === true && !this.enabled) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
      this.lines += 1;
      if (this.lines > this.maxLines * 2) this.compact();
    } catch { /* 诊断日志失败绝不影响主流程 */ }
  }

  /** 只保留最后 maxLines 行。 */
  compact() {
    try {
      if (!existsSync(this.path)) return;
      const all = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim() !== '');
      const kept = all.slice(-this.maxLines);
      writeFileAtomic(this.path, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
      this.lines = kept.length;
    } catch { /* 忽略 */ }
  }

  /** 读取最近 n 条。 */
  tail(n = 200) {
    try {
      if (!existsSync(this.path)) return [];
      const all = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim() !== '');
      return all.slice(-n).map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
    } catch {
      return [];
    }
  }
}
