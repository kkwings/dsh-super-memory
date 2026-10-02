/**
 * dsh-super-memory — 会话标题
 *
 * 面板里列出"被保存的压缩内容"时，用户要看到的是**和 DSH 侧栏一致的会话标题**，
 * 而不是会话 id 或记忆块标题（那两样用户都读不懂）。
 *
 * 标题来源（按优先级）：
 *   ① `$DSH_HOME/storages/session_projcache/sessions/<会话id>.json` 的
 *      `record.rows.title.val` —— 就是侧栏显示的那个标题，由 DSH 的
 *      `session-title-first-prompt-llm` 生成；该文件里还有首条提问可兜底。
 *   ② 同一文件的 `titleInput.val.first.text`（首条提问）截断。
 *   ③ 调用方给的兜底（通常是本地记忆里第一块的标题）。
 *
 * 只读、不写、不联网。按**单个会话 id** 读对应文件并做 15 秒缓存——
 * 不整目录扫描（会话多了之后整扫是白读几百个文件）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshHome } from './config.js';

/** 单个会话标题的缓存时长。 */
const TTL_MS = 15000;
/** 缓存条目上限（面板一次最多列几十个会话，500 足够）。 */
const MAX_CACHE = 500;
/** sessionId → { at, entry }。 */
const cache = new Map();

/** DSH 每会话投影缓存目录。 */
function projCacheDir() {
  return join(resolveDshHome(), 'storages', 'session_projcache', 'sessions');
}

/** 读一个会话的标题信息（含首条提问与 cwd）；读不到返回 null。 */
function readEntry(sessionId) {
  const file = join(projCacheDir(), `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))?.record;
    const title = record?.rows?.title?.val;
    const first = record?.rows?.titleInput?.val?.first?.text;
    return {
      title: typeof title === 'string' ? title.trim() : '',
      first: typeof first === 'string' ? first : '',
    };
  } catch {
    return null;
  }
}

/**
 * 取一个会话的展示标题。
 * @param {string} sessionId - 会话 id（形如 `session-<uuid>`）。
 * @param {string} [fallback] - 都取不到时的兜底标题。
 * @returns {string} 展示标题。
 */
export function sessionTitleOf(sessionId, fallback = '') {
  const id = String(sessionId ?? '');
  if (id === '') return String(fallback ?? '');
  const hit = cache.get(id);
  let entry;
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
    entry = hit.entry;
  } else {
    entry = readEntry(id);
    cache.set(id, { at: Date.now(), entry });
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  if (entry === null || entry === undefined) return String(fallback ?? '');
  if (entry.title !== '') return entry.title;
  const first = entry.first.replace(/\s+/g, ' ').trim();
  if (first !== '') return first.length > 28 ? `${first.slice(0, 28)}…` : first;
  return String(fallback ?? '');
}

/**
 * 会话的短标识：同名会话用来互相区分（用户说的"系统编码"）。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 8 位短码。
 */
export function shortSessionId(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8);
}
