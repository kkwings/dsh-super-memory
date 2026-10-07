/**
 * dsh-super-memory — 提问时检索与注入文本（命中才注入，未命中 0 token）
 *
 * 查询构造：当前用户消息 + 最近 2–3 条用户消息拼接 —— 这样"那这个呢"这类
 * 指代型短问句也能带上前面几轮的话题词。
 */
import { MARKER, estimateTokens, jaccard, stripMarkerSegments, textFromBlocks, tokenSet } from './text.js';

const HEADER = `${MARKER}【本次会话更早（已被压缩）的参考】以下内容来自本会话早前（已被压缩）的部分，仅供参照；若当前结论与它不同，请说明"此前是 X，这次因为 Y 改为 Z"，不要静默改口。`;

/**
 * 从一条"用户消息形状"的对象里取出提问文本。
 * 只认 `source.kind === 'user'`；运行时上下文快照、检查点、指令注入、
 * 只含本插件标记的段落一律返回 ''（这些不是用户在问问题）。
 * @param {object} message - UserMessage 形状的对象（`{content, source}`）。
 * @returns {string} 提问文本，没有则 ''。
 */
export function questionTextOf(message) {
  const data = message ?? {};
  if (data.source?.kind !== 'user') return '';
  const text = stripMarkerSegments(textFromBlocks(data.content)).trim();
  if (text === '' || text.includes(MARKER)) return '';
  return text;
}

/**
 * 从一条 `user/message` 会话事件里取出提问文本。
 * @param {object} event - 会话事件。
 * @returns {string} 提问文本，没有则 ''。
 */
export function queryTextOf(event) {
  if (event?.type !== 'user/message') return '';
  return questionTextOf(event.data);
}

/**
 * 收集最近若干条真实用户消息作为查询。
 * 返回两个形态：`latest` 只有当前这条提问（干净、精确），`text` 是它与前几轮的拼接
 * （给"那这个呢"这类指代型短问句兜底）。检索时先用 latest，不够再用 text。
 * @param {object} session - DSH Session。
 * @param {number} turns - 取多少条（含当前这条）。
 * @returns {{text:string, latest:string, seq:number}} 查询文本与最新用户消息的 seq。
 */
export function collectQuery(session, turns) {
  const n = Math.max(1, turns ?? 3);
  const messages = [];
  let latestSeq = -1;
  let events = [];
  try {
    events = session.snapshotEvents();
  } catch {
    return { text: '', latest: '', seq: -1 };
  }
  for (let i = events.length - 1; i >= 0 && messages.length < n; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    const text = queryTextOf(event);
    if (text === '') continue;
    if (latestSeq < 0) latestSeq = Number(event.seq) || 0;
    messages.push(text);
  }
  messages.reverse();
  const latest = messages.length > 0 ? messages[messages.length - 1] : '';
  return { text: messages.join('\n'), latest, seq: latestSeq };
}

/**
 * 「近重复」阈值（bigram Jaccard），与去重的既有口径一致。
 *
 * 用途见 `selectFreshHits`：同一个话题在不同轮次被反复讨论、又被压缩多次之后，库里会留下
 * 多份高度相似的块（本机实测：同名「Primary Request and Intent」7 块，两两相似度
 * 0.628~0.996，全部在阈值之上）。**只比"本进程已经注入过的正文"挡不住"同一轮里两条近似块
 * 一起被选中"** —— 那才是真实浪费（实测每轮约 195 token）。
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.6;

/**
 * 把一条记忆块压成"话题 — 结论"一行。
 *
 * 导出的原因：这一行就是**真正会被注入的那一行**（截断也在里面），
 * 去重必须与注入口径一致（见 `selectFreshHits`），不能再拿完整正文去比。
 * @param {object} record - 记忆块记录。
 * @param {number} maxChars - 单条字符上限。
 * @returns {string} 单行文本。
 */
export function itemText(record, maxChars) {
  const title = String(record.title ?? '').trim();
  const body = String(record.text ?? '')
    .split('\n')
    .map((line) => line.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((line) => line !== '' && line !== title);
  const preferred = body.filter((line) => !line.startsWith('问：') && !line.startsWith('答：'));
  const source = preferred.length > 0 ? preferred : body;
  const conclusion = source.join(' ').replace(/\s+/g, ' ').trim();
  let line = title === '' ? conclusion : (conclusion === '' ? title : `${title} — ${conclusion}`);
  line = line.replace(/\s+/g, ' ').trim();
  if (line.length > maxChars) line = `${line.slice(0, Math.max(1, maxChars - 1))}…`;
  return line;
}

/**
 * 挑出"这一轮真正值得注入"的候选（纯函数，便于测试；宿主每轮调用一次）。
 *
 * 三道闸门，命中任一就丢掉该条：
 *   ① **指纹**（跨轮）：同一个块永不重复注入（`options.injectedFps`）。
 *   ② **已注入过的文本**（跨轮）：与 `options.injectedTexts` 里的任一条相似度超阈值就丢。
 *      口径必须是**截断后、真正会被注入的那一行**（`itemText(record, maxChars)`）——
 *      早先存的是完整正文的 tokenSet，而注入的是截断文本，两者口径不一致：存的是"整块注入过"，
 *      实际只注入了前 300 字符，于是只在前 300 字符里相似的块照样会在不同轮里各注入一次。
 *   ③ **同一轮内互相去重**：只留**分数最高**的那条。判据有三，满足其一即算重复：
 *      · 标题相同 —— L1 分块共享标题，同一个话题的两片本来就不该一起注入；
 *      · 完整正文相似度 ≥ `NEAR_DUPLICATE_SIMILARITY`；
 *      · **会被注入的那一行**相似度 ≥ `NEAR_DUPLICATE_SIMILARITY` —— 两个块可能指纹不同、
 *        正文相似度不到阈值，但截断后的 300 字符一模一样（`scripts/selftest.mjs` 的注入样例里
 *        就能看到这种两条逐字相同的行），那对模型就是同一段文字被重复投喂。
 *      闸门 ① ② 都只在"已经注入过"之后才生效，挡不住库里本就近重复的多块在同一轮被一起选中
 *      （实测约 195 token/轮白花），③ 就是补这一刀。
 *
 * ③ 里"标题相同"这一条**不受 `dedupe` 开关控制**（历史行为：v0.1.0 起，标题相同的分块就
 * 永不一起注入）；另外两条判据跟着 `dedupe` 走。保留的是**先出现的那条**：调用方必须按分数
 * 降序传入（host.js 会显式排一次序），这样"先出现的"就是"分数最高的"。
 * @param {object[]} hits - 候选（`{record, score, fp}`），按分数降序。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.dedupe] - 是否去重（= 面板上的「同一段不重复塞」；默认 true）。
 * @param {number} [options.maxCharsPerItem] - 每条最大字符（与 `formatRecall` 同口径）。
 * @param {Set<string>} [options.injectedFps] - 已经注入过的块指纹。
 * @param {Set<string>[]} [options.injectedTexts] - 已经注入过的**注入文本** tokenSet。
 * @returns {{fresh:object[], dropped:{fp:string,reason:string}[]}} 留下的候选与丢弃记录。
 */
export function selectFreshHits(hits, options = {}) {
  const dedupe = options.dedupe !== false;
  const maxChars = Math.max(50, options.maxCharsPerItem ?? 300);
  const injectedFps = options.injectedFps instanceof Set ? options.injectedFps : new Set();
  const injectedTexts = Array.isArray(options.injectedTexts) ? options.injectedTexts : [];
  const fresh = [];
  const dropped = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    const record = hit?.record ?? {};
    const fp = String(hit?.fp ?? record.fp ?? '');
    if (dedupe && injectedFps.has(fp)) {
      dropped.push({ fp, reason: 'injected-fp' });
      continue;
    }
    // 注入口径：截断后的那一行（与 formatRecall 里真正注入的文本同源）
    const line = itemText(record, maxChars);
    const tokens = tokenSet(line);
    const body = tokenSet(record.text ?? '');
    if (dedupe && injectedTexts.some((previous) => jaccard(tokens, previous) >= NEAR_DUPLICATE_SIMILARITY)) {
      dropped.push({ fp, reason: 'injected-text' });
      continue;
    }
    const title = String(record.title ?? '').trim();
    const twin = fresh.find((item) => (title !== '' && item.title === title)
      || (dedupe && (jaccard(body, item.body) >= NEAR_DUPLICATE_SIMILARITY
        || jaccard(tokens, item.tokens) >= NEAR_DUPLICATE_SIMILARITY)));
    if (twin !== undefined) {
      dropped.push({ fp, reason: title !== '' && twin.title === title ? 'same-title' : 'near-duplicate' });
      continue;
    }
    fresh.push({ ...hit, fp, line, tokens, body, title });
  }
  return { fresh, dropped };
}

/**
 * 按硬上限拼装注入文本：条数、每条字符数、单轮 token 数三重夹紧。
 * @param {object[]} hits - 检索结果（含 record）。
 * @param {object} limits - 上限。
 * @returns {{text:string, tokens:number, items:number, lines:string[], fps:string[]}} 注入文本；
 *   `lines` 是**逐条真正注入的文本**（含 `- ` 前缀，与 `text` 逐字对应），`fps` 是与它一一对应的
 *   记录指纹 —— 宿主用它们登记"已经注入过什么"（口径必须与真正注入的一致，见 `selectFreshHits`）。
 */
export function formatRecall(hits, limits) {
  const maxItems = Math.max(0, limits.maxItems ?? 2);
  // 每条下限 50 字符（与 config.js 的 INTEGER_FIELDS 下限、面板 NumberRow 的 min 三处一致）：
  // 20 字符连一句结论都装不下，注入了也是白花 token —— 不想注入应当去关注入开关。
  const maxChars = Math.max(50, limits.maxCharsPerItem ?? 300);
  const maxTokens = Math.max(0, limits.maxTokensPerTurn ?? 500);
  if (maxItems === 0 || maxTokens === 0 || !Array.isArray(hits) || hits.length === 0) {
    return { text: '', tokens: 0, items: 0, lines: [], fps: [] };
  }
  const lines = [];
  const fps = [];
  for (const hit of hits.slice(0, maxItems)) {
    const line = itemText(hit.record, maxChars);
    if (line.trim() === '') continue;
    lines.push(`- ${line}`);
    fps.push(String(hit.fp ?? hit.record?.fp ?? ''));
  }
  if (lines.length === 0) return { text: '', tokens: 0, items: 0, lines: [], fps: [] };
  let text = `${HEADER}\n${lines.join('\n')}`;
  while (lines.length > 1 && estimateTokens(text) > maxTokens) {
    lines.pop();
    fps.pop();
    text = `${HEADER}\n${lines.join('\n')}`;
  }
  if (estimateTokens(text) > maxTokens) {
    // 单条也超预算：按**实际估算**迭代收缩，而不是用固定的字符/token 比反推
    // —— 拉丁文正文的字符/token 比跟中文差三倍，一次反推往往仍然超预算。
    let keep = lines[0].length;
    while (keep > 40) {
      const trial = `${HEADER}\n${[`${lines[0].slice(0, keep)}…`, ...lines.slice(1)].join('\n')}`;
      if (estimateTokens(trial) <= maxTokens) break;
      keep = Math.floor(keep * 0.9);
    }
    lines[0] = lines[0].length > keep ? `${lines[0].slice(0, keep)}…` : lines[0];
    text = `${HEADER}\n${lines.join('\n')}`;
    // 收缩到底仍然超预算（HEADER 自己就占掉大半、或上限被设得极小）：
    // **宁可不注入，也不能越过单轮硬上限** —— maxTokensPerTurn 是承诺给用户的成本红线。
    if (estimateTokens(text) > maxTokens) return { text: '', tokens: 0, items: 0, lines: [], fps: [] };
  }
  return { text, tokens: estimateTokens(text), items: lines.length, lines, fps };
}
