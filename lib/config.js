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

/** 设置文件版本。 */
/** 设置文件格式版本（写进文件，便于将来迁移）。 */
const SETTINGS_VERSION = 1;

/** 写死的默认值（对应交接报告 §5.8 / §1.2 的成本红线）。 */
export const DEFAULTS = Object.freeze({
  schema: SETTINGS_VERSION,
  enabled: true,

  // ① 注入开关
  injectRecap: true,
  injectRecall: true,

  // ② 入库开关（都是 0 模型调用）
  ingestSummary: true,
  ingestRawText: true,

  // ③ 成本上限
  compactionRecapMaxTokens: 300,
  maxTokensPerTurn: 500,
  maxItems: 2,
  maxCharsPerItem: 300,
  sessionBudgetRatio: 0.02,

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

  // 入库口径：只存对话文字。思考过程永不入库（见 README「成本」一节），
  // 工具结果默认也不存——这样 L2 的体积与 token 才可控。
  storeDir: '.dsh-compaction-memory',
  includeToolResults: false,
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
});

/** 布尔字段白名单。 */
const BOOLEAN_FIELDS = Object.freeze([
  'enabled', 'injectRecap', 'injectRecall', 'ingestSummary', 'ingestRawText',
  'recapPersist', 'stickyRecall', 'dedupe', 'preferSummaryChunks',
  'includeToolResults', 'includePrune', 'backfillOnStart', 'trashEnabled',
  'trashAutoPurgeEnabled', 'logScores',
]);

/** 整数字段白名单及其下限（0 表示允许为 0）。 */
const INTEGER_FIELDS = Object.freeze({
  compactionRecapMaxTokens: 0,
  maxTokensPerTurn: 0,
  maxItems: 0,
  maxCharsPerItem: 0,
  observationTurns: 1,
  cooldownTurns: 0,
  maxRawCharsPerCompaction: 0,
  protectRecentDays: 0,
  trashAutoPurgeDays: 1,
});

/** 浮点字段白名单。 */
const NUMBER_FIELDS = Object.freeze(['minScore', 'sessionBudgetRatio']);

/** 字符串字段白名单。 */
const STRING_FIELDS = Object.freeze(['storeDir']);

/** 面板可改的全部键。 */
export const EDITABLE_FIELDS = Object.freeze([
  ...BOOLEAN_FIELDS, ...Object.keys(INTEGER_FIELDS), ...NUMBER_FIELDS, ...STRING_FIELDS,
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
export function normalizeSettings(value, defaults = DEFAULTS) {
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
  if (typeof record.storeDir === 'string' && record.storeDir.trim() !== '') {
    const next = record.storeDir.trim();
    // 拒绝 `..`：storeDir 会参与「删除记忆文件」的路径拼接，允许上跳等于允许删到记忆库之外
    if (!next.split(/[\\/]/).includes('..')) out.storeDir = next;
  }
  // 派生夹紧：会话累计占比不超过窗口的一半
  out.sessionBudgetRatio = Math.min(out.sessionBudgetRatio, 0.5);
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
  }
  if (typeof patch.storeDir === 'string' && patch.storeDir.split(/[\\/]/).includes('..')) {
    return 'storeDir 不能包含 ..（它参与删除时的路径拼接）';
  }
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
    const next = normalizeSettings({ ...this.value, ...patch }, this.defaults);
    this.save(next);
    this.value = next;
    this.persisted = true;
    return this.emit();
  }

  /** 清除覆盖，回到启动默认值（保留"已知工作区"这类登记信息，否则面板列表会突然变空）。 */
  reset() {
    try { if (existsSync(this.path)) unlinkSync(this.path); } catch { /* 忽略 */ }
    const known = Array.isArray(this.value.knownWorkspaces) ? this.value.knownWorkspaces : [];
    this.value = { ...this.defaults, knownWorkspaces: known };
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

  /** 追加一条诊断记录；失败静默。 */
  write(entry) {
    if (!this.enabled) return;
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
