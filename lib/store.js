/**
 * dsh-super-memory — 本地记忆库（默认落在会话所属工作区内）
 *
 * 布局：
 *   <workspace>/.dsh-compaction-memory/<sessionId>.jsonl        会话记忆（一行一条块）
 *   <workspace>/.dsh-compaction-memory/_trash/<ts>_<sid>/       回收站（blocks.jsonl + manifest.json）
 *   <workspace>/.dsh-compaction-memory/_audit.jsonl             删除/还原/清空审计
 *
 * 安全边界：本模块只允许操作 storeRoot 之内的文件；所有路径先规范化再校验，
 * 拒绝 `..` 逃逸、绝对路径逃逸与符号链接逃逸；**绝不触碰** DSH 原始会话日志
 * （~/.dsh/sessions/**）。
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from './config.js';

/** 回收站目录名。 */
const TRASH_DIR = '_trash';
/** 审计日志文件名（routes.js 也用它，避免两边各写一份字符串）。 */
export const AUDIT_FILE = '_audit.jsonl';

/** 人工配对记账文件（问 → 块 → 判定），与记忆块分开存，避免污染检索。 */
export const PAIRS_FILE = '_pairs.jsonl';
/** 记录 schema 版本。 */
const RECORD_SCHEMA = 1;

/** 会话 id 规范化：只保留安全字符，避免路径穿越。 */
export function safeSessionId(sessionId) {
  return String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

/**
 * 解析记忆库根目录：storeDir 为绝对路径时直接使用，否则相对会话工作区。
 * @param {string} workspace - 会话工作区绝对路径。
 * @param {string} storeDir - 配置项 storeDir。
 * @returns {string} 记忆库根目录绝对路径。
 */
export function storeRoot(workspace, storeDir) {
  const base = typeof workspace === 'string' && workspace !== '' ? workspace : process.cwd();
  if (typeof storeDir === 'string' && isAbsolute(storeDir)) return resolve(storeDir);
  return resolve(base, storeDir || '.dsh-compaction-memory');
}

/**
 * 路径规范化 + 逃逸校验：target 必须**严格位于** root 之内（root 本身也不允许）。
 *
 * 为什么连 root 都拒绝：`_trash/..` 归一化后正好等于 root，若放行，
 * 一次"删除回收站条目"的请求就会把整个记忆库（全部会话记忆 + 审计 + 回收站）删掉。
 * 另外对**已存在**的路径再做一次 realpath 比对，堵住"目录里放一个指向外部的符号链接"。
 * @param {string} root - 允许的根目录（绝对路径）。
 * @param {string} target - 待校验路径。
 * @returns {string} 规范化后的绝对路径。
 * @throws {Error} 当路径等于 root 或逃出 root 时。
 */
function assertInside(root, target) {
  const rootAbs = resolve(root);
  const targetAbs = resolve(target);
  const rel = relative(rootAbs, targetAbs);
  if (rel === '') throw new Error(`拒绝越界路径（不允许等于根目录）：${targetAbs}`);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`拒绝越界路径：${targetAbs}`);
  if (existsSync(targetAbs)) {
    try {
      const realRoot = realpathSync(rootAbs);
      const realTarget = realpathSync(targetAbs);
      const realRel = relative(realRoot, realTarget);
      if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error(`拒绝符号链接逃逸：${targetAbs}`);
    } catch (error) {
      if (String(error?.message ?? '').startsWith('拒绝')) throw error;
      /* realpath 失败（权限等）不阻断，字符串校验已经过了 */
    }
  }
  return targetAbs;
}

/** 目录占用字节数（失败返回 0）。 */
export function dirBytes(path) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(child);
      else if (entry.isFile()) total += statSync(child).size;
    } catch { /* 忽略单个文件错误 */ }
  }
  return total;
}

/** 内容指纹（16 位十六进制）。 */
export function fingerprint(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 构造一条记忆记录。
 * @param {object} input - 字段。
 * @returns {object} 记录对象。
 */
export function makeRecord(input) {
  return {
    schema: RECORD_SCHEMA,
    layer: input.layer,
    session: String(input.session),
    compactionId: String(input.compactionId ?? ''),
    at: input.at ?? new Date().toISOString(),
    turn: typeof input.turn === 'number' ? input.turn : null,
    seqRange: Array.isArray(input.seqRange) ? input.seqRange : null,
    shadowedTokenCount: typeof input.shadowedTokenCount === 'number' ? input.shadowedTokenCount : null,
    title: String(input.title ?? ''),
    keywords: Array.isArray(input.keywords) ? input.keywords.slice(0, 12) : [],
    text: String(input.text ?? ''),
    fp: input.fp ?? fingerprint(`${input.layer}\u0000${input.text ?? ''}`),
    // 可选来源标记（目前只有"工具结果块"会带）。字段是**追加**的：
    // 不传时记录的字节形状与老版本完全一致，schema 也不用升。
    ...(input.src === undefined ? {} : { src: String(input.src) }),
    ...(input.tool === undefined ? {} : { tool: String(input.tool) }),
  };
}

/** 读取某个会话的全部记录（损坏行跳过）。 */
export function readRecords(root, sessionId) {
  const file = assertInside(root, join(root, `${safeSessionId(sessionId)}.jsonl`));
  if (!existsSync(file)) return [];
  const out = [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line);
      if (record !== null && typeof record === 'object' && typeof record.text === 'string') out.push(record);
    } catch { /* 损坏行跳过 */ }
  }
  return out;
}

/** 追加记录到会话文件。 */
export function appendRecords(root, sessionId, records) {
  if (records.length === 0) return 0;
  const file = assertInside(root, join(root, `${safeSessionId(sessionId)}.jsonl`));
  mkdirSync(root, { recursive: true });
  const payload = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(file, payload, { encoding: 'utf8', flag: 'a' });
  return records.length;
}

/** 覆盖写入某个会话的记录（用于删除单条 / 还原）。 */
export function writeRecords(root, sessionId, records) {
  const file = assertInside(root, join(root, `${safeSessionId(sessionId)}.jsonl`));
  if (records.length === 0) {
    try { rmSync(file, { force: true }); } catch { /* 忽略 */ }
    return;
  }
  mkdirSync(root, { recursive: true });
  writeFileAtomic(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/** 列出记忆库中所有会话文件（不含回收站/审计）。 */
export function listSessionFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    // 下划线开头的是插件自己的账本（_audit / _pairs …），不是会话记忆
    if (entry.name.startsWith('_')) continue;
    const full = join(root, entry.name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    out.push({
      sessionId: entry.name.slice(0, -'.jsonl'.length),
      path: full,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return out;
}

/** 追加一行审计日志。 */
export function audit(root, entry) {
  try {
    mkdirSync(root, { recursive: true });
    const file = assertInside(root, join(root, AUDIT_FILE));
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { encoding: 'utf8', flag: 'a' });
  } catch { /* 审计失败不影响主流程 */ }
}

/** 读取最近的审计行。 */
export function readAudit(root, limit = 100) {
  try {
    const file = assertInside(root, join(root, AUDIT_FILE));
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch {
    return [];
  }
}

/**
 * "这条候选到底对不对"的配对记账（人工标注数据）。
 *
 * 与记忆块分开存：它是**评估数据**（提问 → 块 → 用户判定），不是记忆本身；
 * 混进记忆库会污染检索。放在 `_pairs.jsonl`，与 `_audit.jsonl` 同级、同样只追加。
 * @param {string} root - 记忆库根目录。
 * @param {object} entry - 一行配对（query / fp / verdict / session 等）。
 * @returns {boolean} 是否写入成功。
 */
export function appendPair(root, entry) {
  try {
    mkdirSync(root, { recursive: true });
    const file = assertInside(root, join(root, PAIRS_FILE));
    const line = JSON.stringify({
      at: new Date().toISOString(),
      session: String(entry.session ?? ''),
      query: String(entry.query ?? '').slice(0, 2000),
      fp: String(entry.fp ?? ''),
      verdict: entry.verdict === 'hit' ? 'hit' : 'none',
      score: typeof entry.score === 'number' ? Math.round(entry.score * 10000) / 10000 : null,
      title: String(entry.title ?? '').slice(0, 200),
    });
    appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 读取最近的配对记录（面板展示 + 统计）。 */
export function readPairs(root, limit = 50) {
  try {
    const file = assertInside(root, join(root, PAIRS_FILE));
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch {
    return [];
  }
}

/**
 * 按指纹就地更新若干条记录的 `keywords`（读-改-写，找不到的跳过）。
 *
 * 用途：入库扩写是**后台**做的（模型可能要几秒到几十秒），块早就写盘并可检索了；
 * 扩写回来后用这个函数把新词并进去，而不是等模型才写、或写第二份重复块。
 * 指纹只由 layer+text 决定，改 keywords 不影响去重。
 *
 * @param {string} root - 记忆库根目录。
 * @param {string} sessionId - 会话 id。
 * @param {Map<string, string[]>} updates - fp → 新的关键词数组。
 * @returns {number} 实际更新的条数。
 */
export function patchKeywords(root, sessionId, updates) {
  if (!(updates instanceof Map) || updates.size === 0) return 0;
  const records = readRecords(root, sessionId);
  let changed = 0;
  for (const record of records) {
    const terms = updates.get(String(record.fp));
    if (terms === undefined) continue;
    record.keywords = terms.slice(0, 12);
    changed += 1;
  }
  if (changed > 0) {
    // 重新读一次再写，缩小"扩写期间又来了新压缩"的竞态窗口
    const latest = readRecords(root, sessionId);
    for (const record of latest) {
      const terms = updates.get(String(record.fp));
      if (terms !== undefined) record.keywords = terms.slice(0, 12);
    }
    writeRecords(root, sessionId, latest);
  }
  return changed;
}

/** 把一组记录移入回收站，返回回收站条目 id。 */export function moveToTrash(root, sessionId, records, meta = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `${stamp}_${safeSessionId(sessionId)}`;
  const dir = assertInside(root, join(root, TRASH_DIR, id));
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, 'blocks.jsonl'), records.length === 0 ? '' : `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  writeFileAtomic(join(dir, 'manifest.json'), `${JSON.stringify({
    id,
    sessionId: String(sessionId),
    deletedAt: new Date().toISOString(),
    blocks: records.length,
    bytes: records.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r), 'utf8'), 0),
    originalFile: `${safeSessionId(sessionId)}.jsonl`,
    source: meta.source ?? 'panel',
  }, null, 2)}\n`);
  return id;
}

/** 列出回收站条目（按删除时间倒序）。 */
export function listTrash(root) {
  const base = join(root, TRASH_DIR);
  if (!existsSync(base)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    let manifest = null;
    try {
      const file = join(dir, 'manifest.json');
      if (existsSync(file)) manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* 忽略损坏 manifest */ }
    const blocksFile = join(dir, 'blocks.jsonl');
    let blocks = 0;
    try {
      if (existsSync(blocksFile)) {
        blocks = readFileSync(blocksFile, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
      }
    } catch { /* 忽略 */ }
    out.push({
      id: entry.name,
      dir,
      sessionId: manifest?.sessionId ?? entry.name.replace(/^.*?_/, ''),
      deletedAt: manifest?.deletedAt ?? null,
      blocks,
      bytes: dirBytes(dir),
    });
  }
  out.sort((a, b) => String(b.deletedAt ?? b.id).localeCompare(String(a.deletedAt ?? a.id)));
  return out;
}

/** 读取回收站条目的记录。 */
export function readTrashBlocks(root, trashId) {
  const dir = assertInside(root, join(root, TRASH_DIR, String(trashId)));
  const file = join(dir, 'blocks.jsonl');
  if (!existsSync(file)) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
    }
  } catch { /* 忽略 */ }
  return out;
}

/** 删除回收站条目目录（只允许删 `_trash` 的直接子目录）。 */
export function removeTrashEntry(root, trashId) {
  const base = join(resolve(root), TRASH_DIR);
  const dir = assertInside(root, join(base, String(trashId)));
  // 再确认一次"是 _trash 的直接子目录"，避免任何拼接意外
  if (dirname(dir) !== base) throw new Error(`拒绝删除非回收站目录：${dir}`);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 清空整个回收站，返回删除的条目数与字节数。 */
export function purgeTrash(root) {
  const entries = listTrash(root);
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    removeTrashEntry(root, entry.id);
  }
  return { entries: entries.length, bytes };
}

/**
 * 回收站自动清空：删除超过 N 天的条目。
 * @param {string} root - 记忆库根目录。
 * @param {number} days - 天数（≥1）。
 * @returns {{entries:number, bytes:number}} 清理结果。
 */
export function purgeTrashOlderThan(root, days) {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const entries = listTrash(root);
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.deletedAt ?? '');
    let mtime = Number.NaN;
    try { mtime = statSync(entry.dir).mtimeMs; } catch { /* 忽略 */ }
    const when = Number.isFinite(at) ? at : mtime;
    if (!Number.isFinite(when) || when >= cutoff) continue;
    bytes += entry.bytes;
    if (removeTrashEntry(root, entry.id)) count += 1;
  }
  return { entries: count, bytes };
}

/** 把回收站条目还原回会话文件（同 layer+compactionId+fp 去重）。 */
export function restoreFromTrash(root, trashId, onlyFps = null) {
  const blocks = readTrashBlocks(root, trashId);
  if (blocks.length === 0) return { restored: 0, skipped: 0, sessionId: null, left: 0 };
  const sessionId = String(blocks[0].session ?? '');
  const existing = readRecords(root, sessionId);
  const seen = new Set(existing.map((record) => `${record.layer}\u0000${record.compactionId}\u0000${record.fp}`));
  const restored = [];
  let skipped = 0;
  for (const block of blocks) {
    if (onlyFps !== null && !onlyFps.includes(String(block.fp))) continue;
    const key = `${block.layer}\u0000${block.compactionId}\u0000${block.fp}`;
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    restored.push(block);
  }
  if (restored.length > 0) appendRecords(root, sessionId, restored);

  // 回收站里只保留"没被选中还原"的块；全空则删掉整个条目
  const keep = onlyFps === null ? [] : blocks.filter((block) => !onlyFps.includes(String(block.fp)));
  if (keep.length === 0) {
    removeTrashEntry(root, trashId);
  } else {
    const dir = assertInside(root, join(root, TRASH_DIR, String(trashId)));
    writeFileAtomic(join(dir, 'blocks.jsonl'), `${keep.map((block) => JSON.stringify(block)).join('\n')}\n`);
  }
  return { restored: restored.length, skipped, sessionId, left: keep.length };
}
