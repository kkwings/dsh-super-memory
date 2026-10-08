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
/** 「打开原文」摘抄目录（相对记忆库根）：`_readable/excerpts/<会话id>-<ts>.md`。 */
export const EXCERPT_DIR = '_readable/excerpts';
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

/**
 * 路径校验的**导出别名**（`assertInside` 本体保持私有，避免别处误用成"放行"）。
 * @param {string} root - 允许的根目录（绝对路径）。
 * @param {string} target - 待校验路径。
 * @returns {string} 规范化后的绝对路径。
 * @throws {Error} 当路径等于 root 或逃出 root 时。
 */
export function assertInsidePath(root, target) {
  return assertInside(root, target);
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

/**
 * 单写者串行化（进程内互斥）。
 *
 * 要挡的是什么（只读审查报告 3 号问题）：`appendRecords` 是**追加**写，而
 * `saveRecords`/`patchKeywords` 是**读-改-写**——入库扩写那条链路里，读与写之间隔着
 * 数秒的模型调用。两条写操作交错时，后写的旧快照会把中间追加进来的新块整段抹掉：
 * 默认 `backfillOnStart: true` 时多半能自愈，一旦用户把它关掉就是**永久丢块**。
 *
 * 实现取舍（为什么是 promise 队列而不是 setTimeout 轮询）：
 *   · 队列挂在**文件路径**上，`withFileLock` 返回的 promise 按入队顺序 resolve，
 *     所以临界区天然不交错；
 *   · `patchKeywords` 的**读也在锁内**：它拿到的快照一定包含"排在它前面那次 append"
 *     写进去的块，于是重写时不会把新块丢掉；
 *   · 无竞争时（绝大多数调用）只是多一层微任务，不改变可观察顺序；
 *   · 同步函数（`appendRecords`/`writeRecords`）保持同步：它们在 JS 里不可能被打断，
 *     本身不会交错，改动它们只会破坏 `restoreFromTrash` 的"先追加再判定"顺序。
 *
 * 局限（明确写出来，不假装解决）：只覆盖**本进程内**。跨进程（两个 DSH 实例指向同一个
 * 记忆目录）仍然可能互相覆盖——那需要文件锁，超出本轮范围。
 */
const fileLocks = new Map();

/**
 * 在指定文件的写锁内执行一段异步操作（同一路径严格串行）。
 * @param {string} key - 锁键（这里用会话记忆文件的绝对路径）。
 * @param {Function} task - `() => T | Promise<T>`。
 * @returns {Promise<T>} task 的结果。
 */
export async function withFileLock(key, task) {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const next = previous.then(() => task(), () => task());
  // 队列尾只用于串行，不让失败传播到下一个等待者（否则一次异常会毒死整条队列）
  const tail = next.then(() => undefined, () => undefined);
  fileLocks.set(key, tail);
  try {
    return await next;
  } finally {
    // 队列已排空 → 删掉键，避免 Map 随会话数无界增长（`tail === fileLocks.get(key)`
    // 保证"后面又有人入队"时不会误删新的队列尾）。
    const settled = await tail.then(() => true, () => true);
    if (settled && fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

/** 会话记忆文件的绝对路径（带越界校验）。 */
function sessionFile(root, sessionId) {
  return assertInside(root, join(root, `${safeSessionId(sessionId)}.jsonl`));
}

/**
 * 追加记录到会话文件。
 *
 * 同步、不可打断：JS 里这段没有 await，所以不会与别的写操作交错。
 */
export function appendRecords(root, sessionId, records) {
  if (records.length === 0) return 0;
  const file = sessionFile(root, sessionId);
  mkdirSync(root, { recursive: true });
  const payload = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(file, payload, { encoding: 'utf8', flag: 'a' });
  return records.length;
}

/** 文件版本（size + mtime），用于"写前重读比对"：不一致说明期间有别的写者动过。 */
function fileVersion(file) {
  try {
    const stat = statSync(file);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/** 覆盖写入某个会话的记录（用于删除单条 / 还原）。 */
export function writeRecords(root, sessionId, records) {
  const file = sessionFile(root, sessionId);
  if (records.length === 0) {
    try { rmSync(file, { force: true }); } catch { /* 忽略 */ }
    return;
  }
  mkdirSync(root, { recursive: true });
  writeFileAtomic(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/**
 * 覆盖写入的**并发安全**版本：在写锁内重读 + 重新套用变更，再落盘。
 *
 * 与 `writeRecords` 的分工：`writeRecords` 用于"用户盯着内容做的手术式删除"（快照就是
 * 用户看到的那一份，语义上就该整份覆盖）；只要调用方是"基于早先读到的快照做修改"，
 * 就必须走这里 —— 它会拿锁、**在锁内重新读一次**、把 `mutate` 重新套到最新快照上。
 *
 * 另外还有一道"写前重读比对 size/mtime"的检查：即使用户绕过锁（或将来换成多进程），
 * 只要期间文件变过就重做一次，最多重做 `MAX_REDO` 次，绝不把新块抹掉。
 * @param {string} root - 记忆库根目录。
 * @param {string} sessionId - 会话 id。
 * @param {Function} mutate - `(latest: object[]) => object[]|null`；返回 null = 放弃写入。
 * @returns {Promise<{written:boolean, records:number, redone:number}>} 结果。
 */
export function writeRecordsSafely(root, sessionId, mutate) {
  const file = sessionFile(root, sessionId);
  return withFileLock(file, () => {
    const MAX_REDO = 4;
    let redone = 0;
    for (;;) {
      const version = fileVersion(file);
      const latest = readRecords(root, sessionId);
      const next = mutate(latest);
      if (next === null || !Array.isArray(next)) return { written: false, records: latest.length, redone };
      // 写前比对：期间有别的写者动过文件就重做（把变更重新套到新快照上）
      if (fileVersion(file) !== version && redone < MAX_REDO) { redone += 1; continue; }
      writeRecords(root, sessionId, next);
      return { written: true, records: next.length, redone };
    }
  });
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
 * **并发安全（2026-10-08 修）**：以前这里是"读快照 → 改 → 写回快照"，读与写之间隔着
 * 数秒的模型调用；期间只要有一次压缩入库（`appendRecords`），回写就会把**新块整段抹掉**。
 * 现在读也放进写锁里（`withFileLock`），并且用 `writeRecordsSafely` 做"写前重读比对"，
 * 于是新块一定在最终结果里（`backfillOnStart: false` 的用户不再永久丢块）。
 * @param {string} root - 记忆库根目录。
 * @param {string} sessionId - 会话 id。
 * @param {Map<string, string[]>} updates - fp → 新的关键词数组。
 * @returns {Promise<number>} 实际更新的条数。
 */
export async function patchKeywords(root, sessionId, updates) {
  if (!(updates instanceof Map) || updates.size === 0) return 0;
  let changed = 0;
  await writeRecordsSafely(root, sessionId, (latest) => {
    let touched = 0;
    for (const record of latest) {
      const terms = updates.get(String(record.fp));
      if (terms === undefined) continue;
      record.keywords = terms.slice(0, 12);
      touched += 1;
    }
    changed = touched;
    // 一条都没命中（比如这些块在扩写期间被用户删了）：**不要**回写，
    // 否则等于把一份没做任何修改的旧快照覆盖上去 —— 那正是要修的那个 bug。
    return touched > 0 ? latest : null;
  });
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

/**
 * 清空整个回收站，返回删除的条目数与字节数。
 *
 * **同时清掉 `_readable/excerpts/` 里的摘抄**：那些 md 是逐字的提问 + 回答，
 * 用户点「清空回收站」的语义是"这些内容我不要了"，留着可读的摘抄等于没删干净。
 * @param {string} root - 记忆库根目录。
 * @param {object} [options] - `{withExcerpts: false}` 可跳过摘抄（默认一并清理）。
 * @returns {{entries:number, bytes:number, excerpts:number}} 清理结果。
 */
export function purgeTrash(root, options = {}) {
  const entries = listTrash(root);
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    removeTrashEntry(root, entry.id);
  }
  const excerpts = options.withExcerpts === false ? 0 : purgeExcerpts(root);
  return { entries: entries.length, bytes, excerpts };
}

/**
 * 摘抄文件是否属于某个会话。
 *
 * 命名口径来自 `transcript.js`：`<safeSessionId>-<ts36>.md`（`ts36` 是 `Date.now().toString(36)`，
 * 只含 0-9a-z）。这里要求**三段都严**：`<safeSessionId>-` 前缀 + 中间只能是 base36 时间戳
 * + `.md` 结尾。
 *
 * 为什么中间那段也要严（实测踩到）：会话 id 天然互为前缀（`session-aaaa-1111` 与
 * `session-aaaa-1111-extra`）。只判 `startsWith('<safeId>-')` 的话，删 A 会把 B 的摘抄
 * 一起删掉 —— 那是**误删别的会话的对话原文**。所以多出来的那一段必须长得像时间戳。
 * @param {string} name - 目录里的文件名。
 * @param {string} sessionId - 会话 id（内部再走一遍 safeSessionId）。
 * @returns {boolean} 是否属于该会话。
 */
export function isExcerptOf(name, sessionId) {
  const file = String(name ?? '');
  const safe = safeSessionId(sessionId);
  if (!file.startsWith(`${safe}-`) || !file.endsWith('.md')) return false;
  const middle = file.slice(safe.length + 1, -3);
  return middle !== '' && /^[0-9a-z]+$/.test(middle);
}

/**
 * 摘抄归属的**抛错版**（删除路径用的那种"严格校验"）。
 *
 * 与 `isExcerptOf` 的分工：那个是布尔判据，给"批量挑文件"用；这个是**删除前的把关** ——
 * 文件名与该会话无关就直接抛错。删除路径上返回布尔太弱：调用方容易把 false 当成
 * "本来就没有这样一份摘抄"，继续往下走，于是误删/漏删都查不出来。
 * @param {string} name - 目录里的文件名。
 * @param {string} sessionId - 会话 id。
 * @throws {Error} 文件名与该会话无关（前缀不符 / 时间戳段不像 / 后缀不是 .md）。
 */
export function assertExcerptOf(name, sessionId) {
  if (!isExcerptOf(name, sessionId)) {
    throw new Error(`拒绝删除不属于会话 ${safeSessionId(sessionId)} 的摘抄：${String(name ?? '')}`);
  }
}

/** 摘抄目录的绝对路径。 */
function excerptDir(root) {
  return join(resolve(root), ...EXCERPT_DIR.split('/'));
}

/**
 * 删除某个会话的「打开原文」摘抄。
 *
 * 为什么必须有：`/delete` 与 `/trash/purge` 早先只动记忆库本体与回收站，而
 * `_readable/excerpts/*.md` 里是**逐字的用户提问 + AI 回答**（就是用户想删掉的那份内容）。
 * 用户点了「删干净」却还在磁盘上留着能直接读的 md，等于删除语义是假的。
 *
 * 安全口径（四层，缺一不可）：
 *   ① 只在**记忆库根目录内**的 `_readable/excerpts` 里找（`assertInside` 校验每个候选路径）；
 *   ② 文件名必须严格匹配 `<safeSessionId>-<base36>.md`（见 `assertExcerptOf`），不通配；
 *   ③ 只删**普通文件**（目录/符号链接一律跳过）；
 *   ④ 每个候选在删之前**再抛错校验一次**（`assertExcerptOf`）—— 这样"把关"这件事
 *      在代码里是**可失败的**：删错文件会抛，而不是静默继续。
 * @param {string} root - 记忆库根目录。
 * @param {string} sessionId - 会话 id。
 * @returns {number} 删掉的摘抄文件数。
 */
export function removeSessionExcerpts(root, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return 0;
  const dir = excerptDir(root);
  if (!existsSync(dir)) return 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isExcerptOf(entry.name, sessionId)) continue;
    assertExcerptOf(entry.name, sessionId);   // ④ 严格校验（会抛）
    let target;
    try {
      target = assertInside(root, join(dir, entry.name));
    } catch { continue; }   // 越界/符号链接逃逸：跳过，绝不删
    try { rmSync(target, { force: true }); removed += 1; } catch { /* 单个文件删不掉不影响其余 */ }
  }
  return removed;
}

/**
 * 清空全部摘抄（回收站清空 / 自动清理时一并做）。
 * @param {string} root - 记忆库根目录。
 * @returns {number} 删掉的摘抄文件数。
 */
export function purgeExcerpts(root) {
  const dir = excerptDir(root);
  if (!existsSync(dir)) return 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    let target;
    try {
      target = assertInside(root, join(dir, entry.name));
    } catch { continue; }
    try { rmSync(target, { force: true }); removed += 1; } catch { /* 忽略 */ }
  }
  // 目录本身留着（下次写入不必重建），但只有在**真的空了**才尝试删掉，
  // 免得把别的文件（用户手放的说明）一起带走。
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { force: true, recursive: false });
  } catch { /* 忽略 */ }
  return removed;
}

/**
 * 回收站自动清空：删除超过 N 天的条目，并顺手清掉**已无回收站条目引用**的会话摘抄。
 *
 * 摘抄（`_readable/excerpts/<会话id>-<ts>.md`）里是逐字问答，不能因为"回收站自动清了"
 * 就永远留在磁盘上（只读审查报告 2a）。判据是"该会话在剩余回收站条目里已经没有任何引用"
 * —— 用会话 id 精确比对，不做通配。
 * @param {string} root - 记忆库根目录。
 * @param {number} days - 天数（≥1）。
 * @returns {{entries:number, bytes:number, excerpts:number}} 清理结果。
 */
export function purgeTrashOlderThan(root, days) {
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const entries = listTrash(root);
  let count = 0;
  let bytes = 0;
  let excerpts = 0;
  const expiredSessions = new Set();
  for (const entry of entries) {
    const at = Date.parse(entry.deletedAt ?? '');
    let mtime = Number.NaN;
    try { mtime = statSync(entry.dir).mtimeMs; } catch { /* 忽略 */ }
    const when = Number.isFinite(at) ? at : mtime;
    if (!Number.isFinite(when) || when >= cutoff) continue;
    bytes += entry.bytes;
    if (removeTrashEntry(root, entry.id)) {
      count += 1;
      if (typeof entry.sessionId === 'string' && entry.sessionId !== '') expiredSessions.add(entry.sessionId);
    }
  }
  if (expiredSessions.size > 0) {
    const stillReferenced = new Set(listTrash(root).map((entry) => String(entry.sessionId ?? '')));
    for (const sessionId of expiredSessions) {
      if (stillReferenced.has(sessionId)) continue;
      excerpts += removeSessionExcerpts(root, sessionId);
    }
  }
  return { entries: count, bytes, excerpts };
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
