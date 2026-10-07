/**
 * dsh-super-memory — 原始会话日志读取（只在用户明确要求查原文时才会用到）
 *
 * DSH 的会话日志是**多帧 zstd** 容器（每帧是一批 JSONL 行）。Node 的
 * `zstdDecompressSync` 只解**第一帧**，所以这里按帧结构扫描边界再逐帧解压。
 * 帧扫描算法与 DSH 自己的 session-persistence-jsonl 保持一致。
 *
 * 只读，绝不修改：本模块不会写、删或移动 ~/.dsh/sessions 下的任何文件。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { resolveDshHome } from './config.js';

const ZSTD_MAGIC = 4247762216;

/**
 * 扫描多帧 zstd 容器的帧边界，不依赖解压。
 * @param {Buffer} buffer - 文件全部字节。
 * @returns {{frames:{start:number,end:number}[], tornStart?:number}} 帧区间与末帧是否残缺。
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * 逐帧解压整个容器。
 * @param {Buffer} buffer - 文件全部字节。
 * @returns {{text:string, frames:number, failed:number}} 解压后的 JSONL 文本。
 */
export function decompressFrames(buffer) {
  if (typeof zstdDecompressSync !== 'function') throw new Error('当前运行时不支持 node:zlib zstd');
  const { frames } = scanZstdFrames(buffer);
  const parts = [];
  let failed = 0;
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    } catch {
      failed += 1;
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, failed };
}

/**
 * 定位某个会话的原始日志文件（只读）。
 *
 * 匹配规则（按可靠性排序）：
 *   ① **目录名全等** —— 会话 id 就是目录名，这是唯一无歧义的匹配；
 *   ② 找不到全等时才退化为**前缀匹配，且必须唯一**（有些调用方拿到的 id 是被截短的）；
 *   ③ 有歧义（多个目录同时前缀命中）→ 返回 null，宁可说"读不到"也不读错会话的日志。
 *
 * 早先这里用 `entry.name.includes(wanted)`：只要别处的会话 id 里含有这段字符串就会命中，
 * 而 wanted 较短时（例如 'session'）几乎必然命中**别人的会话**——用户的"查原文"
 * 会读到另一个会话的内容。
 * @param {string} sessionId - 会话 id。
 * @returns {string|null} 日志文件路径。
 */
function findSessionLog(sessionId) {
  const root = join(resolveDshHome(), 'sessions');
  if (!existsSync(root) || !sessionId) return null;
  const wanted = String(sessionId);
  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  const exact = [];
  const prefixed = [];
  for (const project of projects) {
    const projectDir = join(root, project.name);
    let sessions = [];
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessions) {
      // 只认"每会话一个目录"的布局：会话 id 就是目录名。
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(wanted)) continue;
      const dir = join(projectDir, entry.name);
      let files = [];
      try { files = readdirSync(dir); } catch { continue; }
      const logs = [];
      for (const file of files) {
        if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(file)) continue;
        logs.push({ path: join(dir, file), zstd: file.endsWith('.zstd') });
      }
      if (logs.length === 0) continue;
      if (entry.name === wanted) exact.push(...logs);
      else prefixed.push(...logs);
    }
  }
  // 歧义按**目录**判定：一个目录下的多份日志（session.jsonl / session.v4.jsonl.zstd）
  // 属于同一个会话，不能算两次命中。
  let matches = exact;
  if (matches.length === 0) {
    if (new Set(prefixed.map((match) => dirname(match.path))).size !== 1) return null;
    matches = prefixed;
  }
  if (matches.length === 0) return null;
  // 优先 zstd、其次文件名版本号大的
  matches.sort((a, b) => Number(b.zstd) - Number(a.zstd) || b.path.localeCompare(a.path));
  return matches[0].path;
}

/**
 * 读取并解析会话日志事件（只读；损坏帧跳过）。
 * @param {string} sessionId - 会话 id。
 * @param {object} [options] - 选项。
 * @param {string} [options.path] - 直接指定日志路径。
 * @returns {{events:object[], path:string|null, frames:number, failed:number}} 事件数组。
 */
export function readSessionEvents(sessionId, options = {}) {
  const path = options.path ?? findSessionLog(sessionId);
  if (path === null || !existsSync(path)) return { events: [], path: null, frames: 0, failed: 0 };
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return { events: [], path, frames: 0, failed: 0 };
  }
  let text;
  let frames = 0;
  let failed = 0;
  if (path.endsWith('.zstd')) {
    try {
      const result = decompressFrames(buffer);
      text = result.text;
      frames = result.frames;
      failed = result.failed;
    } catch {
      return { events: [], path, frames: 0, failed: 1 };
    }
  } else {
    text = buffer.toString('utf8');
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line);
      if (event !== null && typeof event === 'object' && typeof event.type === 'string') events.push(event);
    } catch { /* 首行 header 或损坏行跳过 */ }
  }
  return { events, path, frames, failed };
}

/**
 * 会话日志文件大小（字节）；取不到返回 null。
 *
 * 返回**数字**而不是对象：调用方要拿它跟上限比大小，早先这里返回 `{path, bytes}`，
 * 于是 `bytes > LIMIT` 永远为 false —— 体积闸门形同虚设（实测踩过这个坑）。
 * @param {string} sessionId - 会话 id。
 * @returns {number|null} 字节数。
 */
export function sessionLogBytes(sessionId) {
  const path = findSessionLog(sessionId);
  if (path === null) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
