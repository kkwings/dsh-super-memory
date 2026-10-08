/**
 * 可读文档：把记忆里命中的段落导出成**给人读的 Markdown**。
 *
 * 现在只有**一种**形态（口径见下面 `writeExcerpt` 的注释）：用户点 ✕ 的「打开原文」时，
 * 生成一份**相关段落摘抄** —— 有几段摘几段、逐字原文、只留用户提问与 AI 回答、纯代码生成 0 token。
 *
 * 早先设想的"整会话可读抄本 / 每次压缩落一份 L2 存档"已被用户判定取消（2026-10-07），
 * 对应的整会话导出函数与那个导出脚本一并删除（历史说明，文件已移除），本文件不再读会话日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertInsidePath } from './store.js';

/**
 * 生成「相关段落摘抄」MD（用户点 ✕ 后打开的那份）。
 *
 * 口径（用户明确要求）：
 *   - **有几段相关就摘几段**（不硬凑、也不截成一段）；
 *   - **逐字原文**（一字不改）；
 *   - **只保留用户提问与 AI 回答** —— 工具结果（`src === 'tool'`）不进摘抄；
 *   - **纯代码生成，0 token**（摘抄是"搬运"，不需要模型）。
 *
 * @param {string} root - 记忆库目录（写到其下的 `_readable/excerpts/`）。
 * @param {string} sessionId - 会话 id。
 * @param {Array<{title?:string, text?:string, score?:number, src?:string, fp?:string}>} items - 命中的段落（按相关度排序）。
 * @param {{model?:string, query?:string, sourceFile?:string}} [meta] - 表头信息。
 * @returns {string|null} 写出的文件路径；没有可摘内容时 null。
 */
export function writeExcerpt(root, sessionId, items, meta = {}) {
  const usable = (Array.isArray(items) ? items : [])
    .filter((item) => item !== null && typeof item === 'object')
    // 只留对话内容：工具结果是给检索用的原料，人读起来是噪声（用户明确要求剔除）
    .filter((item) => item.src !== 'tool' && String(item.text ?? '').trim() !== '');
  if (usable.length === 0) return null;
  const lines = [
    '# 本次查找命中的历史内容（逐字摘抄）',
    '',
    `> 会话：\`${String(sessionId ?? '')}\``,
    `> 由辅助模型判定相关：**${usable.length} 段**${meta.model ? ` · 使用 ${meta.model}` : ''}`,
    meta.query ? `> 针对的问题：${String(meta.query).slice(0, 200)}` : '',
    meta.sourceFile ? `> 出自：\`${meta.sourceFile}\`` : '',
    '> 说明：**逐字原文**（只保留用户提问与 AI 回答，不含工具调用与思考）。',
    '',
    '---',
    '',
  ].filter((line) => line !== '');
  usable.forEach((item, index) => {
    lines.push(`## 第 ${index + 1} 段${typeof item.score === 'number' ? `（相关度 ${item.score.toFixed(3)}）` : ''}`);
    if (item.title) lines.push('', `*${String(item.title).slice(0, 120)}*`);
    lines.push('', String(item.text).trim(), '', '---', '');
  });
  // **会话 id 来自请求体，绝不能直接进文件名**：`..\..\..` 之类会逃出记忆目录、写到任意位置
  // （只读审查实测：`..\..\..\..\Users\Administrator\pwn` 会落到记忆目录之外 ✗）。
  // 这是唯一没走 safeSessionId/assertInside 的写路径，所以三重设防：
  // ① 文件名只留安全字符（`safeId`）；
  // ② 落盘前走 `lib/store.js` 的 `assertInsidePath`（**含 realpath 校验**）——
  //    与其余写/删路径（appendRecords / writeRecords / moveToTrash / removeTrashEntry）
  //    **同一口径**：字符串前缀比较挡不住"目录里放一个指向外部的符号链接"
  //    （2026-10-08 只读审查报告 P2 修；早先这里只做 `target.startsWith(resolve(root) + sep)`）；
  // ③ 越界/符号链接逃逸一律**不写**并返回 null，绝不抛到调用方。
  const dir = path.join(root, '_readable', 'excerpts');
  const safeId = String(sessionId ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
  const target = path.join(dir, `${safeId}-${Date.now().toString(36)}.md`);
  // 先在**建目录之前**做一次纯字符串校验：`..` 之类的拼接逃逸在这里就被挡下，
  // 不会先去 root 之外创建一个目录。
  try {
    assertInsidePath(root, dir);
    assertInsidePath(root, target);
  } catch {
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  // 目录已存在 → 再校验一次：这一遍 `assertInside` 的 **realpath 分支真的会跑**，
  // 把"`_readable/excerpts` 是指向外部的符号链接"这种逃逸也挡掉。
  try {
    assertInsidePath(root, dir);
    assertInsidePath(root, target);
  } catch {
    return null;   // 越界一律不写
  }
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  return target;
}
