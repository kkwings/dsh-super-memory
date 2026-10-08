/**
 * dsh-super-memory — 文本工具（本地、确定性、0 模型调用）
 *
 * 负责：token 估算、中英混合分词（字符 bigram + 拉丁词）、主题行提炼、
 * 关键词提炼、对话文字过滤、内容切块。
 */

/** 所有本插件注入块统一携带的标记；入库时整块排除，防止"摘要的摘要"自我膨胀。 */
export const MARKER = '⟦mem-hist⟧';

/**
 * 注入块的**闭合哨兵**（与 `MARKER` 配对）。
 *
 * 为什么要闭合（只读审查报告 5）：只有开头标记时，模型无法可靠判断"哪一段是历史数据、
 * 到哪里结束"。块内如果复刻了一段形如头部的文字（工具结果、网页正文原样入 L2 时完全可能），
 * 后面所有内容都会被误读成同一段参考。有闭合哨兵，边界是**结构化**的，不靠猜。
 */
export const MARKER_END = '⟦/mem-hist⟧';

/** 匹配开/闭哨兵本身的模式（**局部 new**：全局正则的 `lastIndex` 是有状态的，
 * 跨调用共享会让过滤逐行抽搐 —— 实测踩过：一整段 L2 被静默清空）。 */
const MARKER_TOKEN_SOURCE = '⟦\\s*\\/?\\s*mem-hist\\s*⟧';

/**
 * 这一行/这一段**以哨兵开头**吗？
 *
 * 这是"真注入块"的形状判据：插件注入的块第一行就是 `⟦mem-hist⟧【…】`，块内的闭合哨兵
 * 也单独成行。用它来决定"整段丢掉"，而不是"段里含标记就丢" —— 后者会让
 * 网页正文里引用了一个 `⟦/mem-hist⟧` 的整段内容静默消失。
 */
const MARKER_LINE_RE = new RegExp(`^\\s*${MARKER_TOKEN_SOURCE}`);

/**
 * 这段文本里有没有"本插件哨兵"的痕迹。
 *
 * 判据是**字符**而不是正则：`MARKER` 里那个 `⟦`（U+27E6，数学双括号）在正常对话与
 * 工具结果里都不会出现（本机 122 块真实记忆库里 0 次），而伪造型的 `⟦/mem-hist⟧`
 * 也必须被认出来（旧版只判 `includes('⟦mem-hist⟧')`，会漏掉闭合哨兵）。
 * 正则只用来**替换**，永远不用来做"有没有"的判断 —— 避免 `.test()` 的 `lastIndex` 状态。
 * @param {string} value - 待检查文本。
 * @returns {boolean} 是否含有哨兵痕迹（开或闭都算）。
 */
function hasMarkerToken(value) {
  return String(value ?? '').includes('⟦');
}

/**
 * 头部文案的**独特片段**列表（净化用）。
 *
 * 只在"确实复刻了头部"时命中：这些都是插件自己写的整句，正常对话/网页正文里不会
 * 恰好出现。用它们做判据而不是只判"参考"两个字 —— 后者会把正常中文句子一起误伤。
 */
const HEADER_FINGERPRINTS = [
  '本次会话更早（已被压缩）的参考',
  '本次会话更早（已被压缩）的参考 · 用户点了「✕」后由辅助模型找到',
  '以下内容来自本会话早前（已被压缩）的部分，仅供参照',
  '此前是 X，这次因为 Y 改为 Z',
];

/** 伪头部行的形状：以「【本次会话更早」开头的整行。 */
const FAKE_HEADER_LINE_RE = /^\s*【本次会话更早/;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_+\-.#/]{1,}/g;

/** 常见虚词/单字停用词，用于剔除无信息量的 token。 */
const STOP_CHARS = new Set(
  '的了是在和与及也就都而及其这那有为以对于不我你他她它们个中之于被把给让使从到向由等如若则而且但因为所以可以一个什么怎么怎样如何以及还有如果就是说呢吧吗啊嗯哦很非常已经将要会能可能应该需要'.split(''),
);
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'you', 'your',
  'not', 'but', 'can', 'will', 'has', 'have', 'had', 'its', 'it', 'is', 'be', 'as', 'at',
  'on', 'in', 'of', 'to', 'or', 'if', 'by', 'we', 'they', 'them', 'then', 'than', 'so',
]);

/** 是否包含中日韩字符。 */
function isCjkChar(ch) {
  return CJK_RE.test(ch);
}

/**
 * 估算 token 数。中文按 0.85 token/字（与"700 token ≈ 840 中文字"口径一致），
 * 拉丁文按 4 字符/token。
 * @param {string} text - 待估算文本。
 * @returns {number} 估算 token 数（向上取整）。
 */
export function estimateTokens(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else if (/\s/.test(ch)) continue;
    else other += 1;
  }
  return Math.ceil(cjk * 0.85 + other / 4);
}

/**
 * 词法分词：拉丁词小写化 + CJK 连续段切成字符 bigram（单字段落保留单字）。
 * @param {string} text - 待分词文本。
 * @returns {string[]} token 序列（含重复，供词频统计）。
 */
export function tokenize(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return [];
  const out = [];
  for (const m of s.matchAll(LATIN_WORD_RE)) {
    const w = m[0].toLowerCase();
    if (!STOP_WORDS.has(w)) out.push(w);
  }
  for (const m of s.matchAll(CJK_RUN_RE)) {
    const run = m[0];
    if (run.length === 1) {
      if (!STOP_CHARS.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bg = run.slice(i, i + 2);
      if (STOP_CHARS.has(bg[0]) && STOP_CHARS.has(bg[1])) continue;
      out.push(bg);
    }
  }
  return out;
}

/** token 去重集合，供 bigram Jaccard 相似度使用。 */
export function tokenSet(text) {
  return new Set(tokenize(text));
}

/**
 * 两个文本的 token 集合 Jaccard 相似度。
 * @param {string} a - 文本 A。
 * @param {string} b - 文本 B。
 * @returns {number} 0..1。
 */
export function jaccard(a, b) {
  const sa = a instanceof Set ? a : tokenSet(a);
  const sb = b instanceof Set ? b : tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * **有向包含度**：`a` 的 token 里有多大比例出现在 `b` 里（0..1）。分母只算 `a`。
 *
 * 与 `jaccard` 的分工：Jaccard 回答"这两段是不是同一段"（两边尺寸相当才有效），
 * 包含度回答"这一**小**段是不是已经并进那一**大**段了"。后者是「✕」的 boost
 * （一次 1250–1925 字符）与召回候选行（≤300 字符）的唯一可行判据：
 * 两者尺寸差一个数量级时，Jaccard 的上限只有 300/1925 ≈ 0.16，内容再怎么重叠
 * 也永远够不到 0.6 的阈值（等于没做）。
 * @param {Set<string>|string} a - 被检查的一方（小段）。
 * @param {Set<string>|string} b - 容器一方（大段）。
 * @returns {number} 0..1。
 */
export function containment(a, b) {
  const sa = a instanceof Set ? a : tokenSet(a);
  const sb = b instanceof Set ? b : tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / sa.size;
}

/** 看起来像"上一句的续行"（不该被当成主题行）。 */
function looksLikeContinuation(line) {
  if (line.length < 3) return true;
  if (/^[a-z]/.test(line)) return true;
  if (/^[)）,，。、；：;:.…\-|*>`\]]/.test(line)) return true;
  if (/^(<|>|\/)/.test(line) && line.length < 24) return true;
  return false;
}

/** 去掉 Markdown 装饰与行内代码标记。 */
function cleanLine(line) {
  return line
    .replace(/^[#>\-*\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

/** 在句读处截断，避免把半个词当标题。 */
function truncateAt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'),
    cut.lastIndexOf(';'), cut.lastIndexOf('.'), cut.lastIndexOf(','), cut.lastIndexOf(' '),
  );
  return (at >= max * 0.4 ? cut.slice(0, at) : cut).trim();
}

/**
 * 提炼一句话主题行：默认优先 Markdown 标题，其次第一条"像正常句子开头"的行。
 * @param {string} text - 来源文本。
 * @param {number} [max] - 最大字符数。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.preferHeading] - 是否优先取 Markdown 标题（默认 true）。
 * @returns {string} 主题行（可能为空）。
 */
export function extractTitle(text, max = 40, options = {}) {
  const s = typeof text === 'string' ? text : '';
  const lines = s.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (options.preferHeading !== false) {
    for (const line of lines) {
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (heading !== null) {
        const title = cleanLine(heading[1]);
        if (title !== '' && !title.includes(MARKER)) return truncateAt(title, max);
      }
    }
  }
  for (const line of lines) {
    const title = cleanLine(line);
    if (title === '' || title.includes(MARKER)) continue;
    if (looksLikeContinuation(title)) continue;
    return truncateAt(title, max);
  }
  for (const line of lines) {
    const title = cleanLine(line);
    if (title === '' || title.includes(MARKER)) continue;
    return truncateAt(title, max);
  }
  return '';
}

/**
 * 用本地规则提炼关键词：词频排序，标题命中加权，过滤停用词与一次性噪声。
 * @param {string} text - 来源文本。
 * @param {object} [options] - 选项。
 * @param {string} [options.title] - 主题行（其中的词加权）。
 * @param {number} [options.max] - 最多返回多少个关键词。
 * @returns {string[]} 关键词数组。
 */
export function extractKeywords(text, options = {}) {
  const max = options.max ?? 8;
  const title = options.title ?? '';
  const counts = new Map();
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const titleTokens = new Set(tokenize(title));
  const scored = [];
  for (const [token, count] of counts) {
    let score = count;
    if (titleTokens.has(token)) score += 1.5;
    if (token.length >= 2) score += 0.5;
    // 只出现一次的长文本噪声（长行数字/路径）降权
    if (count === 1 && token.length > 12) score -= 1;
    if (score <= 0) continue;
    scored.push([token, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return scored.slice(0, max).map(([token]) => token);
}

/**
 * 去掉包含本插件标记的段落，避免把注入块再存回库（防自我膨胀）。
 *
 * 2026-10-08（报告 5 之后按实测重定的口径）**必须同时满足两个方向**：
 *   · **真注入块的整段要被去掉**（防自我膨胀）—— 它的形状是"开头一行就是哨兵"；
 *   · **正文里出现的伪造哨兵不许吞掉正文** —— `web_fetch` 抓回的网页、被引用的文档
 *     完全可能带一个 `⟦/mem-hist⟧`，早先"段落里只要含标记就整段丢"会让整条 L2
 *     静默消失（工具的 `kept` 计数也不涨，事后完全查不出来）。
 * 于是：**行首**是哨兵的段落 → 整段去掉（那就是我们自己的块）；
 * 其它行只把哨兵**替换**成中性形式，正文一字不丢。
 *
 * ⚠️ 判定必须用**局部新建**的正则或纯字符检查：`g` 标志的 `lastIndex` 有状态，
 * 跨调用共享会让逐行过滤的结果随上一段文本变化（实测踩过：同一段文本有时整段保留、
 * 有时整段变空 —— 那是静默丢数据，比"净化不彻底"严重得多）。
 * @param {string} text - 原始文本。
 * @returns {string} 清理后的文本。
 */
export function stripMarkerSegments(text) {
  const s = typeof text === 'string' ? text : '';
  if (!hasMarkerToken(s)) return s;
  const isInjected = (para) => MARKER_LINE_RE.test(para);
  const neutralize = (line) => (hasMarkerToken(line)
    ? line.replace(new RegExp(MARKER_TOKEN_SOURCE, 'g'), '[mem-hist]')
    : line);
  return s
    .split(/\n{2,}/)
    .filter((para) => !isInjected(para))
    .join('\n\n')
    .split('\n')
    .filter((line) => !MARKER_LINE_RE.test(line))
    .map(neutralize)
    .join('\n')
    .trim();
}

/**
 * 中和"头部文案"：把文本里可能被复刻的标记与头部整句换掉。
 *
 * 三道替换（顺序不能反）：
 *   ① 哨兵本身 → `[mem-hist]`（去掉尖括号，块内再也复刻不出同一串标记）；
 *   ② 含头部独特整句的**行** → 整行替换成 `[历史头部文案已移除]`；
 *   ③ 以「【本次会话更早」开头的行 → 换成中性前缀（伪头部即便句式微调也拦得住）。
 * 不做更宽泛的替换（例如删掉"参考"二字）：那会误伤正常内容。
 * @param {string} text - 待净化文本。
 * @returns {string} 净化后的文本。
 */
export function neutralizeHeaderText(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return '';
  // 先判"有没有伪装"：没有就走快路径，只做哨兵替换（绝大多数文本都走这里）。
  const suspicious = HEADER_FINGERPRINTS.some((needle) => s.includes(needle)) || FAKE_HEADER_LINE_RE.test(s);
  const stripped = suspicious
    ? s
      .split('\n')
      .map((line) => {
        // ⚠️ 判据必须在**替换哨兵之前**看原始行：伪造的头部往往写成
        // `⟦mem-hist⟧【本次会话更早…】…`，先替换会把指纹一起换掉、这行反而漏网。
        if (HEADER_FINGERPRINTS.some((needle) => line.includes(needle))) return '[历史头部文案已移除]';
        if (FAKE_HEADER_LINE_RE.test(line)) return line.replace(FAKE_HEADER_LINE_RE, '【历史数据片段');
        return line;
      })
      .join('\n')
    : s;
  // 最后统一把哨兵本身中性化：块内再也复刻不出同一串标记。
  // ⚠️ 这里必须用**新建的正则实例**（`g` 标志的 `lastIndex` 有状态，共享会让替换漏掉）。
  return stripped.replace(new RegExp(MARKER_TOKEN_SOURCE, 'g'), '[mem-hist]');
}

/**
 * 入库前的净化：中和头部文案 + **删掉本插件自己注入的整段**。
 *
 * 与 `stripMarkerSegments` 的分工：那个函数负责"别把注入过的参考再存回库"（防自我膨胀），
 * 这个函数负责"块里不许出现可复刻的头部/哨兵"（防伪指令）。两条都要过。
 * @param {string} text - 原始文本。
 * @returns {string} 可入库的文本。
 */
export function sanitizeForStorage(text) {
  return stripMarkerSegments(neutralizeHeaderText(text));
}

/**
 * 从 ContentBlock[] 中抽取纯文本（忽略 reasoning / tool-call / 图片等块）。
 * @param {unknown} blocks - 内容块数组。
 * @returns {string} 拼接后的文本。
 */
export function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** 把超长片段在行/句边界处切开，返回 [头, 余]。 */
function sliceAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return [text, ''];
  const window = text.slice(0, maxChars);
  const candidates = [
    window.lastIndexOf('\n'),
    window.lastIndexOf('。'),
    window.lastIndexOf('；'),
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
    window.lastIndexOf(' '),
  ];
  let cut = -1;
  for (const at of candidates) if (at > cut) cut = at;
  if (cut < maxChars * 0.5) cut = maxChars - 1;
  return [text.slice(0, cut + 1), text.slice(cut + 1)];
}

/**
 * 按 Markdown 标题切分摘要：每个分块都带上它所属的标题前缀，
 * 这样主题行、关键词字段一致（后续切片也能被同一话题的词命中）。
 * @param {string} text - 摘要正文。
 * @param {object} [options] - 选项。
 * @returns {string[]} 切好的块。
 */
export function splitSummarySections(text, options = {}) {
  const target = options.target ?? 500;
  const maxChars = options.maxChars ?? 900;
  const s = typeof text === 'string' ? text : '';
  if (s.trim() === '') return [];
  const sections = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body !== '' || heading !== '') sections.push({ heading, body });
    buf = [];
  };
  for (const line of s.split('\n')) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match !== null) {
      flush();
      heading = `## ${match[1]}`;
      continue;
    }
    buf.push(line);
  }
  flush();

  const blocks = [];
  for (const section of sections) {
    const body = section.body;
    if (body === '') {
      if (section.heading !== '') blocks.push(section.heading);
      continue;
    }
    const pieces = splitIntoBlocks(body, { target, maxChars });
    for (const piece of pieces) {
      const combined = section.heading === '' ? piece : `${section.heading}\n${piece}`;
      if (combined.length <= maxChars) {
        blocks.push(combined);
        continue;
      }
      // 带标题超出上限时按边界切开，标题留在第一片
      let rest = combined;
      while (rest.length > maxChars) {
        const [head, tail] = sliceAtBoundary(rest, maxChars);
        blocks.push(head);
        rest = tail;
      }
      if (rest.trim() !== '') blocks.push(rest);
    }
  }
  return mergeTinyBlocks(blocks, { minChars: 80, maxChars });
}

/** 把过短的碎片块并入相邻块，避免产生"半句话"主题行。 */
function mergeTinyBlocks(blocks, options = {}) {
  const minChars = options.minChars ?? 80;
  const maxChars = options.maxChars ?? 900;
  const limit = maxChars + minChars;
  const out = [];
  let pending = '';
  const absorb = (piece) => {
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.length + piece.length + 1 <= limit) {
      out[out.length - 1] = `${previous}\n${piece}`;
      return true;
    }
    return false;
  };
  for (const block of blocks) {
    const piece = pending === '' ? block : `${pending}\n${block}`;
    pending = '';
    if (piece.length < minChars) {
      if (absorb(piece)) continue;
      pending = piece; // 留给下一块
      continue;
    }
    out.push(piece);
  }
  if (pending !== '') {
    if (!absorb(pending)) out.push(pending);
  }
  return out.filter((block) => block.trim() !== '');
}

/**
 * 把一段长文本切成语义块：先按 Markdown 标题/空行分段，再合并到目标长度。
 * 超长片段在行/句边界处切开，避免块首是半句话（否则主题行会变成乱码片段）。
 * @param {string} text - 来源文本。
 * @param {object} [options] - 选项。
 * @param {number} [options.target] - 目标块长度（字符）。
 * @param {number} [options.maxChars] - 单块硬上限（字符）。
 * @returns {string[]} 切好的块。
 */
export function splitIntoBlocks(text, options = {}) {
  const target = options.target ?? 420;
  const maxChars = options.maxChars ?? 900;
  const s = typeof text === 'string' ? text : '';
  if (s.trim() === '') return [];
  const segments = [];
  let buf = [];
  const flushSegment = () => {
    const joined = buf.join('\n').trim();
    if (joined !== '') segments.push(joined);
    buf = [];
  };
  for (const line of s.split('\n')) {
    if (/^\s{0,3}#{1,6}\s+\S/.test(line) && buf.length > 0) flushSegment();
    if (line.trim() === '') flushSegment();
    else buf.push(line);
  }
  flushSegment();

  const blocks = [];
  let current = '';
  for (const segment of segments) {
    let piece = segment;
    while (piece.length > maxChars) {
      if (current !== '') {
        blocks.push(current);
        current = '';
      }
      const [head, rest] = sliceAtBoundary(piece, maxChars);
      blocks.push(head.trim());
      piece = rest;
    }
    piece = piece.trim();
    if (piece === '') continue;
    if (current === '') current = piece;
    else if (current.length + piece.length + 1 <= target) current = `${current}\n${piece}`;
    else {
      blocks.push(current);
      current = piece;
    }
  }
  if (current !== '') blocks.push(current);
  return blocks;
}

/** 结论性文本标记：命中说明这一块更可能是"判据/决定"，检索时轻微加权。 */
const CONCLUSION_MARKERS = ['结论', '决定', '定为', '确定', '规则', '约定', '必须', '不要', '采用', '最终', '默认', '方案', '需求', '验收'];

/**
 * 结论性倾向（0..1）：用于检索加权与总览排序。
 * @param {string} text - 待评估文本。
 * @returns {number} 0..1 之间的倾向值。
 */
export function conclusionScore(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return 0;
  let hits = 0;
  for (const marker of CONCLUSION_MARKERS) if (s.includes(marker)) hits += 1;
  return Math.min(1, hits / 4);
}
