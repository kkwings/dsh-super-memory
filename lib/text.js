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
/**
 * "词"的扫描形状（2026-10-09 修 bug 2）：
 *   · 拉丁/标识符：首字符必须是字母、总长 ≥2（旧口径，保持不变）；
 *   · **纯数字**：`\d+(\.\d+)?` —— 旧正则要求首字符是字母，**数字串被整段跳过**，
 *     而 CJK bigram 也不覆盖数字，于是 `252` / `167` / `0.28` / `700` 这些
 *     **最重要的检索锚点**完全不可检索（实测：原库142 上「252是什么」0 候选，
 *     而正确答案就是"252 token"）。带单位/百分号时只取数字部分（`34.3%` → `34.3`）。
 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_+\-.#/]+|\d+(?:\.\d+)?/g;
/** 标识符里的**结构分隔符**：拆开后可当独立词命中（`dsh-compaction-memory` → `dsh`/`compaction`/`memory`）。 */
const ID_SEP_RE = /[_\-./#+]+/;

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
 * 拉丁/标识符扫描：返回 **surface 词**（照旧的一条：数字原样、字母词小写整串）与
 * **额外结构片段**（标识符拆开后的 `sticky`/`recall` 这一类）。
 *
 * 2026-10-09 修 bug 2（"纯数字与短标识符检索不到"）：
 *   ① **纯数字保留**（含小数）：`252` / `0.28` / `167` / `700`；带单位/百分比时只取数字部分。
 *      旧正则是 `[A-Za-z][A-Za-z0-9_+\-.#/]{1,}` —— **要求首字符是字母**，纯数字串被整段跳过，
 *      而 CJK bigram 也不覆盖数字，于是这些**最重要的检索锚点**完全不可检索
 *      （实测原库142「252是什么」0 候选，而正确答案就是"252 token"）。
 *   ② 标识符照旧产出小写整串，**额外**产出结构片段：按 `-`/`_`/`.`/`/`/`+` 拆，
 *      再在 camelCase 边界切（`stickyRecall` → `sticky`/`recall`）。为什么是"拆开"而不是
 *      "只留整串"：库里的写法与用户的写法常只差分隔符/驼峰大小写，而实测真实库（415 块）上
 *      只加纯数字时「stickyRecall 省多少」**仍是 0 候选**（命中证据门 floor=3，最相关那块
 *      只命中 1 个 token）；拆开后同一块命中 3 个 token，该查询 **0 候选 → 5 候选**。
 *      **整串仍进词表**，所以"整词精确命中"没有被削弱。
 * @param {string} s - 文本。
 * @returns {{surface:string[], extra:string[]}} 两部分。
 */
function latinPieces(s) {
  const surface = [];
  const extra = [];
  for (const m of s.matchAll(LATIN_WORD_RE)) {
    const raw = m[0];
    // 纯数字（含小数）：原样进词表（不做停用词判定 —— 停用词表里没有数字）。
    if (raw.charCodeAt(0) >= 48 && raw.charCodeAt(0) <= 57) {
      surface.push(raw);
      continue;
    }
    const w = raw.toLowerCase();
    if (!STOP_WORDS.has(w)) surface.push(w);
    for (const part of identifierParts(raw)) {
      if (part !== w && !STOP_WORDS.has(part)) extra.push(part);
    }
  }
  return { surface, extra };
}

/**
 * CJK 连续段切成字符 bigram（单字段落保留单字），与旧口径逐字一致。
 * @param {string} s - 文本。
 * @returns {string[]} token 列表。
 */
function cjkPieces(s) {
  const out = [];
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

/**
 * **表面词**（用户实际打出来的词）：拉丁词的小写整串、纯数字、CJK bigram。
 *
 * 这就是 2026-10-09 之前 `tokenize` 的返回值，**只多了一类：纯数字**。
 * 单独导出它的原因在 `lib/retrieval.js` 的命中证据门：门的标定是"用户表面词命中几个"
 * （`MIN_MATCHED_TERMS` 的注释里写的是"查询去重 token 数"）。分词现在会把一个标识符
 * 展开成多个 token（`stickyRecall` → `stickyrecall`/`sticky`/`recall`），如果门还按
 * **展开后**的 token 数去取 `min(4, n)`，那么"用户只打了一个词"也会变成 3–5 个词的门 ——
 * 门会在标识符查询上**悄悄升高**（测试与标定全部失效）。所以门数**表面词**，
 * 而"命中几个"按真实进索引的 token 计（见 `retrieval.js` 的 `matched`）。
 * @param {string} text - 待分词文本。
 * @returns {string[]} 表面词序列（含重复）。
 */
export function surfaceTermsOf(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return [];
  return [...latinPieces(s).surface, ...cjkPieces(s)];
}

/**
 * 词法分词：表面词 + 标识符的**结构片段**（供索引与打分）。
 * @param {string} text - 待分词文本。
 * @returns {string[]} token 序列（含重复，供词频统计）。
 */
export function tokenize(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return [];
  const { surface, extra } = latinPieces(s);
  return [...surface, ...extra, ...cjkPieces(s)];
}

/** 需要拆分标识符的字符形状：含分隔符，或含 camelCase 驼峰边界。用 `test` 做**快速否决**。 */
const ID_SPLITTABLE_RE = /[_\-./#+]|[a-z0-9][A-Z]/;

/**
 * 一个标识符的**结构片段**（小写、去重、长度 ≥2）。
 *
 * 两步：先按 `_`/`-`/`.`/`/`/`+` 拆，再在每个片段内部的 camelCase 边界
 * （小写/数字后紧跟大写）拆。例：`stickyRecall` → `sticky`,`recall`；
 * `dsh-compaction-memory` → `dsh`,`compaction`,`memory`；`maxCharsPerItem` →
 * `max`,`chars`,`per`,`item`（同时保留整串 `maxcharsperitem`）。
 * 单字符片段（`-` 拆出来的 `x`）不进词表：太短没有区分度。
 *
 * **快速否决**：绝大多数标识符是纯小写、无分隔符（`token`、`build`、`file`）——
 * 它们拆出来只有自己，白拆。先用一条正则判掉，`tokenize` 的吞吐从 ~24 千字符/ms
 * 回到 ~37 千字符/ms（实测真实库 463,912 字符：19.3ms → 12.6ms）。
 * @param {string} raw - 原始词形。
 * @returns {string[]} 片段列表（可能为空）。
 */
function identifierParts(raw) {
  if (!ID_SPLITTABLE_RE.test(raw)) return [];
  const parts = new Set();
  for (const piece of String(raw).split(ID_SEP_RE)) {
    if (piece === '') continue;
    for (const sub of piece.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const low = sub.toLowerCase();
      if (low.length >= 2) parts.add(low);
    }
  }
  return [...parts];
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
 * 注入行里"头部内容（答/开头）"能占的预算比例，剩下的留给结论句与结尾取样。
 *
 * 为什么需要这个上限（2026-10-08 的实测缺陷）：注入行是"标题 — 正文前 N 字符"，
 * 而 L2 块的中位长度是 918 字符（上限 1500）、`maxCharsPerItem` 只有 300 ——
 * 预算全被**第一段提问**花光，块末的"答："与结论句一个字符都进不来。
 * 本机 122 块实测：含"答："的 29 个块里 **29 个（100%）** 的"答"文本进入注入行
 * 0 字符。所以头部内容不再吃满预算，`(1 - ITEM_LEAD_SHARE)` 明确留给"结论句 + 结尾"。
 *
 * 为什么是 0.75 而不是更"稳"的 0.6：0.6 时实测注入行中位只有 248 字符、43/122 块不足
 * 200 字符（预算白白空着），而结尾那 25% 常常因为"下一句整句塞不进 64 字符"而空手而归
 * （`lib/recall.js` 的 `selectHeadTailSentences` 是**整句**取舍，不切半句）。
 * 0.75 把额度还回正文，同时保留"结尾取样"这条例外通道；尾部真取不到东西时，
 * `itemText` 还有一次"把省下的额度还给头部"的收尾。0.7～0.85 的实测指标完全相同
 * （注入行中位 270、整块无结论 29/51），取中间值 0.75 留出两端余量。
 */
export const ITEM_LEAD_SHARE = 0.75;

/**
 * 按中文/西文句读切句（保留句末标点），供"结论句优先"使用。
 *
 * **换行也是句子边界**：L1 摘要是"标题一行 + 正文"、L2 块是"问：…答：…"多行，
 * 只按 `。！？；` 切会把标题行和下一行正文粘成一句 —— 实测后果：标题行
 * `入快照追加语义」的结论` 与正文首句粘在一起后，**整句不等于正文里那一句**，
 * 去重的前缀比较失效，注入行里同一段正文出现两遍。
 * 切完顺手去掉行首 Markdown 装饰（`#`/`>`/`-`/`*`）与空白，不丢正文字符。
 * @param {string} text - 待切文本。
 * @returns {string[]} 句子数组（已 trim，可能为空数组）。
 */
export function splitSentences(text) {
  const s = typeof text === 'string' ? text : '';
  if (s.trim() === '') return [];
  const pieces = s
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；!?;])/))
    .map((sentence) => sentence.replace(/^[#>\-*\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((sentence) => sentence !== '');
  // 把"没以句读收尾的片段"并进下一句：`## 三、本轮实机验收` 这类标题行单独成句会变成
  // 注入行里的孤立片段（实测出现过 `… — 三、本轮实机验收（真实压缩，不是模拟） — 关键推论…`）。
  // 并入下一句既保住标题文字，也让取样接缝落在真正的句读上。
  const out = [];
  for (const piece of pieces) {
    const previous = out[out.length - 1];
    if (previous !== undefined && !/[。！？；!?;]$/.test(previous)) {
      out[out.length - 1] = `${previous} ${piece}`.trim();
      continue;
    }
    out.push(piece);
  }
  return out;
}

/**
 * 折叠整段的重复：**相邻句子逐字相同**时只留一句（保序）。
 *
 * 用途见 `collapseRepeats`（整段就是同一句话的多次重复时，`splitSentences` 切出来的
 * 每一句都一样 —— 那样"已经出现过"的去重判据是无效的，因为**每一句都是第一句**）。
 * 只丢"逐字相同的相邻重复"，不做模糊相似度判断，避免误删正常叙述。
 * @param {string} text - 文本。
 * @returns {string} 去重后的文本。
 */
export function dedupeAdjacentSentences(text) {
  const s = typeof text === 'string' ? text : '';
  if (s === '') return s;
  const sentences = splitSentences(s);
  if (sentences.length < 2) return s;
  const kept = [];
  for (const sentence of sentences) {
    if (kept.length > 0 && kept[kept.length - 1] === sentence) continue;
    kept.push(sentence);
  }
  return collapseRepeats(kept.join(' '));
}

/**
 * 把"同一段短句自己重复很多遍"的句子折叠成一遍。
 *
 * 为什么需要（实测）：真实块里有一句来自中文填充测试数据 ——
 * `结论：单轮注入上限必须放得下两条满额的中文块。结论：单轮注入上限必须放得下两条满额的中文块。…`
 * 整块没有句读以外的边界，`splitSentences` 只切出**一句**，于是它整句进注入行、
 * 而"已经出现过"的去重判据（整句比较/前缀比较）对**自己内部的重复**无能为力 ——
 * 300 字符的注入行里同一句话印了两遍。
 * 判据：长 ≥24 字符、长度能被"重复次数"（2..12）整除、且每一份逐字相同。
 * @param {string} sentence - 单句。
 * @returns {string} 折叠后的句子（无重复时原样返回）。
 */
function collapseRepeats(sentence) {
  const s = typeof sentence === 'string' ? sentence : '';
  const length = s.length;
  if (length < 24) return s;
  for (let times = 2; times <= 12; times += 1) {
    if (length % times !== 0) continue;
    const unit = length / times;
    if (unit < 8) continue;
    const head = s.slice(0, unit);
    let repeated = true;
    for (let i = unit; i < length; i += unit) {
      if (s.slice(i, i + unit) !== head) { repeated = false; break; }
    }
    if (repeated) return head;
  }
  return s;
}

/**
 * 句子是否"含结论/决定"（用代码里唯一那份 `CONCLUSION_MARKERS`）。
 * @param {string} sentence - 单句。
 * @returns {boolean} 是否含结论标记。
 */
export function isConclusionSentence(sentence) {
  const s = typeof sentence === 'string' ? sentence : '';
  return CONCLUSION_MARKERS.some((marker) => s.includes(marker));
}

/**
 * 首末取样：**不是**无差别砍掉尾部，而是"开头 + 结尾"两段都拿。
 *
 * 依据同上：长文本的结论几乎总在段末（实测 122 块里结论句落在注入行之外 84.1%），
 * 只取开头等于把结论删掉。两段之间用 `…` 连起来，长度**不超过** `max`。
 * 边界情形：`max` 极小（≤2）时只返回省略号；头尾本来就重叠（文本刚好比 max 长一点）
 * 时退回"取头部"，不会重复输出同一段文字。
 * @param {string} text - 待取样文本。
 * @param {number} max - 字符上限。
 * @param {number} [headShare] - 头部占比（默认 `ITEM_LEAD_SHARE`）。
 * @returns {string} 取样结果（长度 ≤ max）。
 */
export function sampleHeadTail(text, max, headShare = ITEM_LEAD_SHARE) {
  const s = typeof text === 'string' ? text : '';
  const limit = Math.max(0, Number(max) || 0);
  if (s.length <= limit) return s;
  if (limit <= 2) return '…'.slice(0, limit);
  const body = limit - 1; // 给中间的 `…` 留一个字符
  const share = Number.isFinite(headShare) ? Math.min(0.9, Math.max(0.1, headShare)) : ITEM_LEAD_SHARE;
  const headLen = Math.max(1, Math.min(body - 1, Math.floor(body * share)));
  const tailLen = Math.max(1, body - headLen);
  if (s.length - tailLen <= headLen) return s.slice(0, body);
  return `${s.slice(0, headLen)}…${s.slice(s.length - tailLen)}`;
}

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
