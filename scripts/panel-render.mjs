/**
 * 面板渲染冒烟测试：不开浏览器，把 `lib/client.js` 的整棵渲染树真正跑一遍。
 *
 * 为什么需要它：客户端半边（约 1200 行）此前从没在浏览器之外执行过 ——
 * 括号错位、引用未定义变量、板块被误嵌进另一个板块，这些只有渲染一次才会暴露。
 * 这里用一个极小的 React 桩（useState/useEffect/useCallback/useMemo/Fragment/Component）
 * 与桩 fetch 把"设置已加载"之后的那棵树渲染出来，并断言七个板块都在、且是根节点的直接子节点。
 *
 * 用法：node scripts/panel-render.mjs      （失败退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

let failures = 0;
let passed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); return; }
  failures += 1;
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/* ── 桩 React ─────────────────────────────────────────────────────────── */
const FRAGMENT = Symbol('Fragment');
/** hooks 按「组件路径 + 槽位」分开存，等价于 React 的"每个组件实例自己的 hook 链表"。 */
const hookStore = new Map();
let hookIndex = 0;
let currentComponent = 'root';
let pendingUpdate = false;

function createElement(type, props, ...children) {
  const flat = [];
  const push = (value) => {
    if (Array.isArray(value)) { for (const item of value) push(item); return; }
    if (value === null || value === undefined || value === false || value === true) return;
    flat.push(value);
  };
  for (const child of children) push(child);
  return { type, props: { ...(props ?? {}), children: flat } };
}

function withComponent(key, fn) {
  const previousKey = currentComponent;
  const previousIndex = hookIndex;
  currentComponent = key;
  hookIndex = 0;
  try { return fn(); } finally { currentComponent = previousKey; hookIndex = previousIndex; }
}

const ReactStub = {
  Fragment: FRAGMENT,
  createElement,
  useState(initial) {
    const slot = `${currentComponent}#${hookIndex++}`;
    if (!hookStore.has(slot)) hookStore.set(slot, typeof initial === 'function' ? initial() : initial);
    const set = (value) => {
      hookStore.set(slot, typeof value === 'function' ? value(hookStore.get(slot)) : value);
      pendingUpdate = true;
    };
    return [hookStore.get(slot), set];
  },
  useEffect(fn) { hookIndex += 1; try { fn(); } catch { /* 桩里效应失败不影响结构断言 */ } },
  useCallback(fn) { hookIndex += 1; return fn; },
  useMemo(fn) { hookIndex += 1; return fn(); },
  // ⚠️ `useRef` **必须像真 React 一样跨渲染复用同一个对象**（按槽位缓存）。
  // 每次渲染都新建一个 {current} 的话，凡是"只在首次渲染记一个值"的组件（例如
  // MissTail 的 mountedAt 用于判断陈旧结果）在测试里就会每次都被重置 ——
  // 结果就是"实测的陈旧判定"和"真机行为"不一致（这正是把 pending 结果误判为陈旧的原因）。
  useRef(value) {
    const slot = `${currentComponent}#ref${hookIndex++}`;
    if (!hookStore.has(slot)) hookStore.set(slot, { current: value });
    return hookStore.get(slot);
  },
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...next }; pendingUpdate = true; }
    render() { return null; }
  },
};

/* ── 桩宿主环境 ───────────────────────────────────────────────────────── */
const settingsPayload = {
  ok: true,
  value: {
    source: 'web',
    settingsPath: 'E:\\DSH-data\\dsh-super-memory\\dsh-super-memory.settings.json',
    dataHome: { dir: 'E:\\DSH-data\\dsh-super-memory', source: 'env', envName: 'DSH_SUPER_MEMORY_HOME' },
    settings: {
      enabled: true, injectRecap: true, injectRecall: true, ingestSummary: true, ingestRawText: true,
      includeToolResults: true, toolResultNames: 'read, grep', toolResultMaxChars: 4000, toolResultBudgetChars: 120000,
      compactionRecapMaxTokens: 300, maxTokensPerTurn: 700, maxItems: 2, maxCharsPerItem: 300,
      recapPersist: true, stickyRecall: true, minScore: 0.28, dedupe: true,
      observationTurns: 3, cooldownTurns: 1, preferSummaryChunks: true, storeDir: '.dsh-compaction-memory',
      trashEnabled: true, protectRecentDays: 7, trashAutoPurgeEnabled: true, trashAutoPurgeDays: 7,
      logScores: true, backfillOnStart: true, includePrune: false, maxRawCharsPerCompaction: 400000,
      llmAssistEnabled: true, llmIngestExpand: true, llmIngestProvider: 'zai', llmIngestModel: 'glm-5.3-flash',
      llmIngestTimeoutMs: 8000, llmIngestBatchBlocks: 8, llmIngestBlockChars: 600, llmIngestMaxTokens: 240,
      llmRecallRewrite: true, llmRecallProvider: '', llmRecallModel: '',
      llmRecallTimeoutMs: 8000, llmRewriteMaxTokens: 120, llmDailyCallCap: 0, llmCacheEnabled: true,
    },
  },
};
const overviewPayload = {
  ok: true,
  value: {
    currentWorkspace: 'E:\\软件\\DeepSeek Harness',
    build: 'v0.1.0',
    totals: { libraryBytes: 30687, trashBytes: 0 },
    llm: {
      enabled: true, serviceAvailable: true,
      // usage 现在带 token 估算（E 项）：面板要把它显示出来，字段名必须与 host 的
      // `usage()` 完全一致（calls / inTokensEst / outTokensEst），否则显示成 0。
      usage: { date: '2026-10-06', calls: 3, cap: 200, remaining: 197, inTokensEst: 5120, outTokensEst: 860 },
      cooldownUntil: null, lastFailure: null, lastRoute: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    workspaces: [{
      workspace: 'E:\\软件\\DeepSeek Harness',
      root: 'E:\\软件\\DeepSeek Harness\\.dsh-compaction-memory',
      exists: true,
      libraryBytes: 30687,
      trashBytes: 0,
      git: { gitRepo: false, ignoreRule: false, rule: '.dsh-compaction-memory/' },
      sessions: [{
        sessionId: 'session-d7e61f90-e491-45ad-9378-0b6fc158ca15', shortId: 'd7e61f90',
        title: '开发超级记忆跨压缩插件', titleFallback: '开发超级记忆跨压缩插件',
        blocks: 197, bytes: 30687, compactions: 2, protected: true, activityAt: Date.now(), updatedAt: Date.now(),
      }, {
        // 第二个会话：用来抓「本工作区 N 条」只读 `sessions[0]` 的那个 bug
        // （只读审查报告 6 的第 3 条）。数量刻意不同，读错就会露馅。
        sessionId: 'session-bbbb2222-cccc-3333-dddd-444455556666', shortId: 'bbbb2222',
        title: '另一个会话', titleFallback: '另一个会话',
        blocks: 43, summaryBlocks: 20, rawBlocks: 23, bytes: 8000, compactions: 1,
        protected: false, activityAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000,
      }],
      // 宿主 workspaceOverview() 的合计口径（面板优先用它）
      libraryBlocks: 240,
    }],
    runtime: [{
      sessionId: 'session-d7e61f90-e491-45ad-9378-0b6fc158ca15', workspace: 'E:\\软件\\DeepSeek Harness',
      root: 'E:\\软件\\DeepSeek Harness\\.dsh-compaction-memory', hits: 0, misses: 2,
      // 上限字段（budgetTokens / budgetUsedTokens / budgetOff / budgetExhausted）随
      // 「会话累计上限」的删除一起消失；现在只报"本会话已注入 ≈N token"这一个计数器。
      injectedTokens: 167, injectedTokensEst: 167, knownCompactions: 2,
    }],
  },
};

globalThis.window = {
  // 真实形态：load({ id, factory }) —— 工厂是 meta 上的属性，不是第二个参数
  __ModuleLoader__: {
    load(meta) {
      check('模块声明了 id', typeof meta?.id === 'string' && meta.id !== '');
      globalThis.__factory = meta?.factory;
    },
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
globalThis.fetch = async (url) => {
  const target = String(url);
  const body = target.includes('/overview') ? overviewPayload
    : target.includes('/settings') ? settingsPayload
      : target.includes('/trash') ? { ok: true, value: { entries: [] } }
        : target.includes('/diagnostics') ? { ok: true, value: { runtime: [], recent: [], settingsPath: 'x', diagPath: 'y', storeDirBytes: 0 } }
          : { ok: true, value: {} };
  return { ok: true, status: 200, json: async () => body };
};

/* ── 加载模块并抓到注册的渲染函数 ─────────────────────────────────────── */
const requireStub = (name) => {
  if (name === 'react') return ReactStub;
  throw new Error(`桩 require 不认识：${name}`);
};
// client.js 是 ModuleLoader 脚本（没有 ESM import），用 vm 在带桩的全局里真正执行它
runInThisContext(source, { filename: 'lib/client.js' });
const moduleExports = globalThis.__factory(requireStub);
check('模块能加载（工厂返回 { inject, apply }）', typeof moduleExports?.apply === 'function');

let renderPanel = null;
let renderMiss = null;
let renderMissTail = null;
const registered = [];
const ctx = {
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } return () => {}; },
  slots: {
    inject: (name, cb) => { registered.push(name); try { cb(); } catch { /* 忽略 */ } return () => {}; },
    register: (slot, render) => {
      // 按槽位分别捕获：面板 / 会话内按钮 / 会话内结果块是三个不同的渲染函数
      if (slot?.name === 'settings.section') renderPanel = render;
      else if (slot?.name === 'conversation.chat.assistant-actions') renderMiss = render;
      else if (slot?.name === 'conversation.chat.turnTail') renderMissTail = render;
      return () => {};
    },
  },
};
moduleExports.apply(ctx);
check('注册了 settings.section 槽位', registered.includes('settings.section'));
check('注册了 conversation.chat.assistant-actions 槽位', registered.includes('conversation.chat.assistant-actions'));
check('拿到了面板渲染函数', typeof renderPanel === 'function');
check('拿到了会话内按钮渲染函数', typeof renderMiss === 'function');
check('拿到了会话内结果块渲染函数（turnTail）', typeof renderMissTail === 'function');

/* ── 最小渲染器需要的文本提取（放在断言之前）────────────────────────── */
function textOf(node, depth = 0) {
  if (depth > 60 || node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map((item) => textOf(item, depth + 1)).join(' ');
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children, depth + 1);
  return '';
}

/* ── 渲染：反复跑直到状态稳定（桩 useState 会把异步回来的数据写进槽位）──── */
/**
 * 最小渲染器：把元素树里的函数/类组件真正调用一遍，展开成宿主元素树。
 * （没有这一步，"树"只是元素对象，Panel 根本不会被执行。）
 */
function resolveTree(node, path = 'root', depth = 0) {
  if (depth > 40 || node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node === 'boolean') return null;
  if (Array.isArray(node)) {
    return node.map((item, index) => resolveTree(item, `${path}.${index}`, depth + 1)).filter((item) => item !== null);
  }
  if (typeof node !== 'object' || node.type === undefined) return node;

  const props = node.props ?? {};
  if (node.type === FRAGMENT) return resolveTree(props.children, `${path}.frag`, depth + 1);
  if (typeof node.type === 'function') {
    const name = node.type.displayName ?? node.type.name ?? 'Anon';
    // 类组件：实例化后调 render；函数组件：直接调（hooks 按组件路径分槽）
    const isClass = typeof node.type.prototype?.render === 'function';
    const output = withComponent(`${path}<${name}>`, () => (isClass ? new node.type(props).render() : node.type(props)));
    return resolveTree(output, `${path}<${name}>`, depth + 1);
  }
  // 宿主元素：保留它 + 展开 children（断言"根节点的直接子节点"要用这一层）
  return { type: node.type, props: { ...props, children: resolveTree(props.children, `${path}.${String(node.type)}`, depth + 1) } };
}

let tree = null;
for (let pass = 0; pass < 8; pass += 1) {
  hookIndex = 0;
  currentComponent = 'root';
  pendingUpdate = false;
  tree = resolveTree(renderPanel({}));
  // 让 refresh() 的 promise 落地
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!pendingUpdate) break;
}

check('渲染没有抛错', tree !== null && typeof tree === 'object');
check('面板已脱离"加载中"（settings 已就绪）', textOf(tree).includes('超级记忆'), `树文本前 80 字：${textOf(tree).slice(0, 80)}`);

const defaultText = textOf(tree);

/**
 * 按板块标题行切分整棵树的文本，得到"每块自己有多少字"。
 *
 * ⑦ 另按「使用方式」再切一刀：那是一组控件（三个选项的字面就写在控件里），
 * 不是说明文字，所以长度只对**卡片头**（标题 + 副标题）有约束。
 * @param {string} fullText - `textOf(tree)` 的结果。
 * @param {string[]} marks - 切分标记（按出现顺序）。
 * @returns {{mark:string,length:number}[]} 每段的字数。
 */
function boardSegments(fullText, marks) {
  return marks.map((mark, index) => {
    const at = fullText.indexOf(mark);
    if (at < 0) return { mark, length: -1 };
    const end = index + 1 < marks.length ? fullText.indexOf(marks[index + 1]) : fullText.length;
    return { mark, length: (end < 0 ? fullText.length : end) - at };
  });
}

/* ── 断言：首屏（默认态）───────────────────────────────────────────────────
 * 不断言"必须是根节点的直接子节点"：那取决于 Board 组件的包装层次，
 * 太脆；这里断言"每个板块标题都渲染出来了，且顺序是 ①→⑦"。
 * 精简改版后，七个板块标题仍必须**默认可见**（它们是首屏的骨架）。 */
const text = defaultText;
const sectionNumbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];
for (const no of sectionNumbers) {
  check(`渲染树里有板块 ${no}`, text.includes(`${no} `), `找不到「${no} 」`);
}
check('板块顺序正确（①→⑦）', (() => {
  let last = -1;
  for (const no of sectionNumbers) {
    const at = text.indexOf(`${no} `);
    if (at < 0 || at < last) return false;
    last = at;
  }
  return true;
})());

/* 关键控件/文案是否真的渲染出来了（桩渲染下能拿到的文案） */
for (const [label, needle] of [
  ['顶部三句话之一（它做什么）', '压缩那一刻'],
  /* 2026-10-07：用户钦定的顶部文案里**删掉了"不联网"**（他要的是"可选调用辅助大模型"那段），
   * 边界声明整体搬到了 ⑦ 展开态的隐私提示（见下面的展开态断言）。
   * 这里改成守住**事实本身**：只读会话日志、不存密钥、不改写对话 —— 这三条还在顶部。 */
  ['顶部边界声明（不存密钥 / 不改写对话 / 只读会话日志）', '本插件不存密钥、不改写你的对话；只读 DSH 的会话日志'],
  ['顶部模型辅助说明（可选调用辅助大模型）', '可以选择调用辅助大模型增加检索历史记忆的命中率'],
  ['顶部操作性指引（点 ✕）', '就点回答下面的 ✕ 让它再找一遍'],
  ['未命中诊断门槛提示或入口', '压缩'],
  ['板块 ① 的两条人话开关', '存摘要'],
]) {
  check(`渲染树里含${label}`, text.includes(needle), `找不到「${needle}」`);
}
// 会话内结果块（turnTail）：从没在浏览器之外渲染过，这里至少确认它在"无结果"时不渲染
check('turnTail 无结果时不渲染任何内容',
  textOf(resolveTree(withComponent('missTail', () => renderMissTail({ sessionId: 'session-x' })))).trim() === '', '');

/* ── 断言：首屏的"信息密度"（本次改版的核心目标）─────────────────────────
 * 判据是**每块的字数**（标题行 + 至多 1 行说明）：阈值取得宽，
 * 只拦"又把设计论证塞回界面"这种明显回退，不追求卡死排版。
 * ① – ⑥ 的上限 420 字；⑦ 单独给 720 —— 它把三选一的三个选项（控件本身）和
 * 「提供方 / 模型 / 测试连接」一起摊在首屏，字面量本来就多，但都必须是**人话短句**。
 * 「使用方式」段（三选一控件 + 紧邻它的那一行调用统计）单独给 820：字面量本来就多，
 * 但都必须是**人话短句**。（2026-10-07 用户要求把"今日调用 / 估算用量"搬回首屏，
 * 就挂在这一段里 —— 实测 757 字，上限从 720 提到 820 只给它让出那 ~80 字的额度；
 * 再往这段里塞整段说明仍然会被拦下。切分不按「今日调用」来切：那样会把它一路量到
 * 面板末尾，反而量错东西。） */
{
  const marks = ['① ', '② ', '③ ', '④ ', '⑤ ', '⑥ ', '⑦ '];
  if (text.includes('使用方式')) marks.push('使用方式');
  const segments = boardSegments(text, marks);
  const limit = (mark) => (mark === '使用方式' ? 820 : 420);
  const fat = segments.filter((item) => item.length < 0 || item.length > limit(item.mark));
  check('首屏每块都短（没有哪块塞回了一大段说明）', fat.length === 0,
    fat.map((item) => `${item.mark} ${item.length} 字（上限 ${limit(item.mark)}）`).join('、'));
}
/* 设计论证必须**离开界面**：这些词以前就写在面板上，现在只应存在于 README/代码注释里。
 * 注意只查**渲染出来的文本**，不查源码 —— 源码注释里保留这些解释是刻意的。 */
for (const [label, needle] of [
  ['实测数据（本机实测 …）', '本机实测'],
  ['阈值标定依据（分得很开 / 0.7–1.5）', '分得很开'],
  ['指纹去重的原理说明', '指纹去重'],
  ['L1 / L2 分层术语', '（L1）'],
  ['前缀缓存/快照追加量这类实现细节', '前缀缓存'],
]) {
  check(`首屏不再出现${label}`, !text.includes(needle), `仍然出现「${needle}」——这类内容应写进 README，不是面板`);
}

/* ── 断言：参数设置默认收起（"参数收进折叠的高级"这把刀）─────────────────
 * 收起时既不能显示调参项，也不能显示⑥里那些排障/路径细节。 */
for (const [label, needle] of [
  ['命中阈值', '命中阈值'],
  ['单轮注入上限', '单轮注入上限'],
  ['入库冷却', '入库冷却'],
  ['工具结果白名单', '收哪些工具'],
  ['记忆目录输入框', '记忆目录'],
  ['本会话已注入 ≈N token（排障行）', '本会话已注入'],
]) {
  check(`参数设置收起时不显示${label}`, !text.includes(needle), `「${needle}」默认就渲染出来了`);
}
// ⑦ 模型辅助：用户明确要求**默认展开**（不再折叠）——正文应直接渲染出来
check('⑦ 默认展开（能看到隐私提示与使用方式）', text.includes('会被发送到') && text.includes('使用方式'),
  '用户已确认不要折叠：可选功能的入口要一眼可见；「测试连接」只在选"调用指定模型"时出现');
check('⑦ 默认展开且只有三选一，没有第二段说明',
  text.includes('不调用大模型') && text.includes('调用指定模型'),
  '三选一的三个选项必须在首屏；「测试连接」只在选"调用指定模型"时出现');
/* ⑦ 的调用统计：2026-10-07 用户要求**搬回首屏**（"今日调用 N 次 / 估算用量"是他的账，
 * 不是我们的排障细节，收进折叠区等于看不见）。断言意图随之反转但**意图本身不变**：
 * 统计必须可见，且字段名必须与宿主 `usage()` 一致（calls / inTokensEst / outTokensEst）——
 * 对不上就会显示成 0，这条就是那个守卫。
 * 只认统计行自己的说法，别误伤隐私提示里那句"你选的那个模型服务"。 */
check('⑦ 首屏（参数设置收起）就显示调用统计',
  text.includes('今日调用') && text.includes('估算用量'),
  '调用统计必须默认可见：它是用户要看的账，不是折叠区里的排障细节');
check('⑦ 首屏的调用统计读的是宿主字段（calls / inTokensEst / outTokensEst）',
  text.includes('今日调用 3 / 200 次') && text.includes('输入 ≈5120') && text.includes('输出 ≈860'),
  `实际：${(text.match(/今日调用[^。]*/) ?? ['(没渲染)'])[0]}`);
check('⑦ 不再有"命中率提升来自两处"这段原理说明', !text.includes('命中率的提升来自两处'),
  '设计论证应写进 README，不是面板');
// 用户明确要求：**只让用户选一次**（要不要调用大模型），不许再拆成"入库/检索"两套
check('⑦ 只选一次：出现「使用方式」', text.includes('使用方式'), `找不到「使用方式」`);
check('⑦ 不再出现两套字段（入库用 / 检索用）', !text.includes('入库用 provider') && !text.includes('检索用 provider'),
  '把实现结构暴露成用户决策是设计错误：用户只需回答"要不要调用大模型"');
check('⑦ 三种选择都在', text.includes('不调用大模型') && text.includes('调用主模型') && text.includes('调用指定模型'),
  '三选一：不调用 / 主模型 / 指定模型');

/* ── 渲染器：默认态（参数设置与⑥都收起）与展开态 ───────────────────────────
 * 2026-10-07 精简改版：面向调参的项全部收进**默认折叠**的「参数设置」，
 * 所以「同一棵树渲染多次」成为默认断言姿势：
 *   · `render()`                  —— 用户打开面板看到的首屏（两个都收起）；
 *   · `render(true)`              —— 点开「参数设置」之后（所有设置项都必须在，一个都不能少）；
 *   · `render(false, true, true)` —— 点开 ⑥「诊断与路径」之后（排障行/日志/路径/恢复默认设置）。
 *   两个开关**必须互相独立**（2026-10-07 修：早先 ⑥ 与「参数设置」共用一个状态，
 *   展开 ⑥ 会把页面最底部的整块参数区一起摊开）。
 * 桩 React 不会点按钮，所以展开态是**直接往 hook 槽位里种**（见下 slots 表）。
 * `openLlm=false` 用来验证「⑦ 收起时统计照样在」——⑦ 自身也有一个折叠按钮。 */
const STABLE_PASSES = 8;
async function render(openAdvanced = false, openLlm = true, openDiag = false) {
  const panelKey = [...hookStore.keys()].find((key) => key.startsWith('root<PanelBoundary>.0<Panel>#'));
  if (panelKey === undefined) {
    check('面板的 hook 槽位存在（展开态可渲染）', false, '找不到 Panel 的 hook 槽位');
    return null;
  }
  const base = panelKey.slice(0, panelKey.lastIndexOf('#'));
  /* 把面板自己的所有 hook 槽位重置成初始值（= 一组全新的 useState），
   * 再按需要种 `openAdvanced` / `openDiag` / `openLlm`。**不要清空整个 hookStore** ——
   * 别的组件的槽位（会话内按钮 / 结果块）不受影响。
   *
   * 槽位顺序就是 Panel 里 `React.useState` 的出现顺序：
   *   0 settings · 1 overview · 2 diag · 3 trash · 4 detail · 5 openAdvanced · 6 openDiag …
   * 其中 `detail`（记忆明细）在真机上只有 `loadBlocks()` 成功返回才会是完整对象，
   * 桩渲染里可能残留半成品 → 一并清成 null，让两次渲染都走"没有明细"的正常路径。 */
  const initialSlots = [null, null, null, {}, null, false, false, true, false, null, null, null, null, null, null, null, null, true, false, '', ''];
  for (const key of [...hookStore.keys()]) {
    if (key.startsWith(base)) hookStore.delete(key);
  }
  initialSlots.forEach((value, index) => hookStore.set(`${base}#${index}`, value));
  /* ⚠️ 槽位下标是**数组下标**，不是"第几个 useState"。实际顺序（与 lib/client.js 里
   * `React.useState` 的出现顺序一致，加字段时请同步更新这张表）： */
  const SLOTS = {
    settings: 0, overview: 1, diag: 2, trash: 3, detail: 4,
    openAdvanced: 5, openDiag: 6, openLibrary: 7, confirmZero: 8, pending: 9,
    confirmDelete: 10, confirmTrashDelete: 11, confirmPurge: 12, query: 13, search: 14,
    llmTest: 15, llmTestBusy: 16, openLlm: 17, error: 18, notice: 19, llmProviders: 20,
  };
  /* （off-by-one 踩过两次：把 `detail` 种成 true 会让面板去读 `detail.blocks.length` 而崩；
   * 把 `openLlm` 的槽位号写成 6 会去改 `openLibrary`，于是"收起 ⑦"的断言形同虚设。
   * 2026-10-07 拆开 ⑥ 之后新增 `openDiag`（= 6），它之后的所有槽位整体后移一位：
   * `openLibrary` 6→7、`openLlm` 16→17、`llmProviders` 19→20 —— 上表是当前准确值。） */
  if (openAdvanced) hookStore.set(`${base}#${SLOTS.openAdvanced}`, true);
  if (openDiag) hookStore.set(`${base}#${SLOTS.openDiag}`, true);
  hookStore.set(`${base}#${SLOTS.openLlm}`, openLlm);
  let out = null;
  for (let pass = 0; pass < STABLE_PASSES; pass += 1) {
    hookIndex = 0;
    currentComponent = 'root';
    pendingUpdate = false;
    out = resolveTree(renderPanel({}));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!pendingUpdate) break;
  }
  return out;
}

/**
 * 为什么要长度断言：本次改版的核心是"首屏每块不超过 2 行"，而"行"在桩渲染里
 * 拿不到 —— 用每块的字符数当代理（标题行 + 1 行说明大约 40–90 字），
 * 阈值给得宽，只拦"又塞回一段设计论证"这种明显回退。
 */

/* ── 断言：参数设置展开后，**一个设置项都不能少** ────────────────────────
 * 本次改版只做"折叠 + 精简文案"，删掉任何一项都会变成"配了不生效的死键"：
 * 这条断言就是那件事的守卫（设置键 → 展开后必须能找到的文案）。 */
{
  const advancedTree = await render(true);
  const advancedText = advancedTree === null ? '' : textOf(advancedTree);
  check('参数设置展开后不再出现「额度：N / M」「已用尽」这类已删除的额度文案',
    !advancedText.includes('额度：') && !advancedText.includes('已用尽') && !advancedText.includes('额度已关闭'),
    '累计上限已删除，面板不应再显示额度/用尽提示');
  check('参数设置展开后仍显示本进程注入估算', advancedText.includes('估算注入'), '找不到「估算注入」');
  // E 项：今日 token 估算要真的显示出来（字段名对不上就会显示成 0）。
  // 2026-10-07：这行统计**搬回了首屏**（⑦ 里、紧邻「使用方式」，收起 ⑦ 时由板块下方那行兜住），
  // 所以真正该守住的不再是"展开态里有没有它"，而是"**收起时也**看得到它"——
  // 下面这条改成在**默认态**（参数设置收起）的文本上断言，展开态只是顺带再确认一次。
  check('调用统计在默认态（参数设置收起）就显示今日 token 估算（输入/输出）',
    text.includes('输入 ≈5120') && text.includes('输出 ≈860'),
    `默认态实际：${(text.match(/估算用量[^·]*/) ?? ['(没渲染)'])[0]}`);
  check('参数设置展开后调用统计仍在（输入/输出）',
    advancedText.includes('输入 ≈5120') && advancedText.includes('输出 ≈860'),
    `实际：${(advancedText.match(/估算用量[^·]*/) ?? ['(没渲染)'])[0]}`);
  for (const [label, needle] of [
    ['minScore 命中阈值', '命中阈值'],
    ['maxTokensPerTurn 单轮注入上限', '单轮注入上限'],
    ['maxItems 单轮最多条数', '单轮最多条数'],
    ['maxCharsPerItem 每条最大字符', '每条最大字符'],
    ['compactionRecapMaxTokens 总量上限', '总量上限'],
    ['observationTurns 查询携带最近几条提问', '查询携带最近几条提问'],
    ['cooldownTurns 入库冷却', '入库冷却'],
    ['preferSummaryChunks 先查摘要再用原文兜底', '先查摘要，再用原文兜底'],
    ['recapPersist 总览在本窗口内保持稳定', '总览在本窗口内保持稳定'],
    ['stickyRecall 参考块命中后一直显示', '参考块命中后一直显示'],
    ['dedupe 同一段不重复塞', '同一段不重复塞'],
    ['maxRawCharsPerCompaction 单次压缩原文上限', '单次压缩原文上限'],
    ['includeToolResults 工具结果入库开关', '入库模型读过的文件/检索结果'],
    ['toolResultNames 收哪些工具', '收哪些工具'],
    ['toolResultMaxChars 单条工具结果上限', '单条工具结果上限'],
    ['toolResultBudgetChars 工具结果总量上限', '工具结果总量上限'],
    ['includePrune 也收录被压缩掉的历史片段', '也收录被压缩掉的历史片段'],
    ['protectRecentDays 删除保护期', '删除保护期'],
    ['trashEnabled 删除先进回收站', '删除先进回收站'],
    ['trashAutoPurgeEnabled 回收站自动清空', '回收站自动清空'],
    ['trashAutoPurgeDays 回收站保留天数', '回收站保留天数'],
    ['llmIngestTimeoutMs 入库调用超时', '入库调用超时'],
    ['llmIngestBatchBlocks 每批块数', '每批块数'],
    ['llmIngestBlockChars 每块送多少字符', '每块送多少字符'],
    ['llmRecallTimeoutMs 检索调用超时', '检索调用超时'],
    ['llmDailyCallCap 每日调用上限', '每日调用上限'],
    ['llmCacheEnabled 相同输入不重复调用', '相同输入不重复调用'],
    ['llmIngestMaxTokens 单次输出上限（扩写）', '单次输出上限（扩写）'],
    ['llmRewriteMaxTokens 单次输出上限（查询改写）', '单次输出上限（查询改写）'],
  ]) {
    check(`参数设置展开后有${label}`, advancedText.includes(needle), `找不到「${needle}」`);
  }
  // 这两句以前写在界面上当"设计论证"，精简后仍应保留**可操作的事实**（该去哪个菜单改）。
  check('参数设置展开后仍说明"思考强度去哪设"', advancedText.includes('到「设置 → 模型」里对该型号设置'),
    '用户会来问"推理强度怎么调不动"，这句是唯一的路标');
  /* 顶部文案 2026-10-07 按用户钦定版改写后**删掉了"不联网"**：
   * 这条事实改由 ⑦ 展开态的隐私提示承担 —— 它必须仍在，因为它是市场审查要看的边界声明。
   * （断言写在展开态里：那句话本来就只随 ⑦ 展开显示。） */
  check('⑦ 展开态仍有边界声明（不访问互联网 / 不自己连网 / 不存密钥）',
    advancedText.includes('不访问互联网') && advancedText.includes('不自己连网') && advancedText.includes('不存密钥'),
    '顶部已不再写"不联网"，这条事实必须在 ⑦ 的隐私提示里仍然可见');
  /* 两个开关**必须互相独立**：展开「参数设置」不该把 ⑥ 的诊断内容一起摊开 */
  check('展开「参数设置」不会连带展开 ⑥ 的诊断内容（本会话已注入 / 全局数据目录 / 恢复默认设置）',
    !advancedText.includes('本会话已注入') && !advancedText.includes('全局数据目录：') && !advancedText.includes('恢复默认设置'),
    '参数设置只该管它自己那一块');
}

/* ── 断言：⑥「诊断与路径」有**自己的**展开开关（2026-10-07 修）───────────────
 * 修的是什么：早先 ⑥ 的「展开」和顶部「参数设置」共用 `openAdvanced`，
 * 点 ⑥ 的展开会把页面最底部的整块参数区一起摊开（用户：反直觉）。
 * 这里的几条断言就是"两个状态真的分开了"的守卫：
 *   · ⑥ 展开 → 它自己的内容（排障行 / 打分日志 / 记忆目录 / 全局数据目录 / 恢复默认设置）都在；
 *   · ⑥ 展开 → 参数设置的调参项一个都不出现；
 *   · 默认态（两个都收起）→ 两边的内容都不出现。 */
{
  const diagTree = await render(false, true, true);
  const diagText = diagTree === null ? '' : textOf(diagTree);
  check('⑥ 展开后能看到「本会话已注入 ≈167 token（不设上限）」',
    diagText.includes('本会话已注入 ≈167 token（不设上限）'),
    '注入计数没渲染出来 —— 面板读的字段名可能与 routes.js 返回的不一致');
  check('⑥ 展开后能看到本进程排障行（命中 / 未命中 / 估算注入）',
    diagText.includes('本进程：命中'), '找不到 ⑥ 的排障行');
  check('⑥ 展开后仍显示路径信息（全局数据目录 / 设置文件）',
    diagText.includes('全局数据目录：') && diagText.includes('设置文件：'),
    '排障需要真实路径，不能只剩抽象说明');
  check('⑥ 展开后有 storeDir「记忆目录」输入框与「恢复默认设置」按钮',
    diagText.includes('记忆目录') && diagText.includes('恢复默认设置'),
    '这两项属于 ⑥（诊断与路径），不该跟着「参数设置」走');
  check('⑥ 展开后有「写打分日志」与「启动时回填」两个开关',
    diagText.includes('写打分日志') && diagText.includes('启动时回填'),
    '找不到 ⑥ 的两个开关');
  /* 反向守卫：⑥ 的展开**不许**把参数区摊开（这正是这次修掉的那个反直觉行为）。
   * 判据只挑**「参数设置」独有**的文案：⑦ 的「调用参数」区（入库调用超时 / 每批块数 /
   * 单次输出上限…）不受 `openAdvanced` 控制，用它当判据会误报。 */
  check('⑥ 展开不会连带展开「参数设置」（调参项一个都不出现）',
    !diagText.includes('命中阈值') && !diagText.includes('单轮注入上限') && !diagText.includes('单轮最多条数')
    && !diagText.includes('每条最大字符') && !diagText.includes('入库冷却') && !diagText.includes('回收站自动清空'),
    '⑥ 只该管它自己那一块：顶部「参数设置」由它自己的按钮控制');
  /* 默认态：两个开关都收起时，两边的内容都不该出现 */
  check('默认态（两个都收起）⑥ 的内容不出现',
    !text.includes('本会话已注入') && !text.includes('全局数据目录：') && !text.includes('恢复默认设置'),
    '⑥ 默认是收起的');
}

/* ── 断言：⑦ 自身收起时，调用统计照样在（2026-10-07 车回首屏的那一行）──────
 * 意图：**统计必须可见**。⑦ 收起时正文（隐私提示 / 三选一控件）整块消失，
 * 但那一行统计必须由板块下方兜住，否则用户一点「收起」就再也看不到自己的账。 */
{
  const collapsedLlmTree = await render(false, false);
  const collapsedLlmText = collapsedLlmTree === null ? '' : textOf(collapsedLlmTree);
  check('⑦ 收起时也显示调用统计（今日调用 + 估算用量）',
    collapsedLlmText.includes('今日调用 3 / 200 次')
    && collapsedLlmText.includes('输入 ≈5120') && collapsedLlmText.includes('输出 ≈860'),
    `实际：${(collapsedLlmText.match(/当前：[^。]*/) ?? ['(没渲染)'])[0]}`);
  check('⑦ 收起时不再显示被折叠的正文（隐私提示与三选一控件）',
    !collapsedLlmText.includes('会被发送到') && !collapsedLlmText.includes('不调用大模型'),
    '收起就该收起：只留那行统计');
}


/* ── 断言：⑦ 在 off 档位下要把"设置文件里还记着哪套型号"说出来（2026-10-08）────
 * 修的是什么：`llmMode:'off'` 时面板**不显示**提供方/型号下拉（它们只在 custom 下有意义），
 * 但设置文件里的旧字段（`llmIngest*`）可能还留着上次配的型号 —— 而用户一改选
 * 「调用指定模型」，宿主就会把它当作回落值重新用上。不说这一句，用户会以为早配好的型号没了。
 * 两条断言都要能失败：文案删掉 → 第一条红；无条件拼上这句话 → 第二条（空配置时不该出现）红。 */
{
  const originalValue = settingsPayload.value;
  const renderWith = async (settings) => {
    settingsPayload.value = { ...originalValue, settings: { ...originalValue.settings, ...settings } };
    const tree = await render(false, true);
    return tree === null ? '' : textOf(tree);
  };
  const offWithLegacy = await renderWith({ llmMode: 'off', llmAssistEnabled: false, llmIngestProvider: 'zai', llmIngestModel: 'glm-5.3-flash' });
  check('⑦ off + 旧字段非空 → 提示"设置文件里还记着 zai / glm-5.3-flash，改选「调用指定模型」会重新用上"',
    offWithLegacy.includes('设置文件里还记着 zai / glm-5.3-flash，改选「调用指定模型」会重新用上'),
    `实际：${(offWithLegacy.match(/当前：纯本地[^。]*。[^。]*。?/) ?? ['(没渲染)'])[0]}`);
  check('⑦ off 时确实不显示提供方/型号下拉（所以只能靠上面那句话告知）',
    !offWithLegacy.includes('下拉里是你在「设置 → 模型」里配好的提供方'), 'off 档位下不该出现提供方下拉');
  const offWithoutLegacy = await renderWith({ llmMode: 'off', llmAssistEnabled: false, llmIngestProvider: '', llmIngestModel: '', llmRecallProvider: '', llmRecallModel: '' });
  check('⑦ off 且什么都没配过 → 不出现"还记着"那句话（不能无条件拼）',
    !offWithoutLegacy.includes('设置文件里还记着'), '空配置下不该出现"还记着…"');
  settingsPayload.value = originalValue;
}

console.log(`\n通过 ${passed} 条，失败 ${failures} 条。`);

/* ── 断言：面板文案三处错的修正（只读审查报告 6）────────────────────────────
 *  ① 全仓没有 clipboard 调用，却写着"找到的资料会自动复制，粘贴发送即可" → 必须删掉这个承诺；
 *  ② 会话内结果块里的 `**直接继续提问即可**` 是普通文本节点，Markdown 不渲染，
 *     用户看到的就是两个星号 → 不许出现裸 `**`；
 *  ③ 「本工作区 N 条」只统计 `sessions[0]` → 数字必须来自真实合计。
 * 这三条都写在**渲染出来的文本**上（不是源码），所以文案改回去就会红。 */
{
  check('面板不再承诺"自动复制/粘贴发送"（实现里根本没有 clipboard）',
    !text.includes('自动复制') && !text.includes('粘贴发送') && !text.includes('粘贴'),
    `实际：${(text.match(/[^。]*复制[^。]*/) ?? ['(没出现)'])[0]}`);
  check('「本工作区」徽标的数字是真实合计（桩数据里宿主给 240，不是 sessions[0] 的 197）',
    text.includes('本工作区 2 个会话 · 共 240 条'),
    `实际：${(text.match(/本工作区[^、]*/) ?? ['(没渲染)'])[0]} / ${(text.match(/共 \d+ 条/) ?? ['(没有合计)'])[0]}`);
  check('徽标不再直接写成"本工作区 197 条"（那正是只读 sessions[0] 的症状）',
    !/本工作区\s*197\s*条/.test(text), '徽标仍在读 sessions[0].blocks');
}

/* ②：会话内结果块（turnTail）在"找到"状态下的文本 —— 点一次 ✕ 再放行，
 * 把真实的"找到相关内容"那块渲染出来查裸星号与复制承诺。 */
{
  const compacted = { ok: true, value: { runtime: [{ sessionId: 'session-x', workspace: 'E:\\w', knownCompactions: 2, hits: 1, misses: 2, lastQuery: '之前那个问题' }] } };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/diagnose') && !target.includes('/diagnostics')) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, value: { verdict: 'above-threshold', found: true, boosting: true, chars: 120, model: 'glm-5.3-flash', material: '资料', file: 'E:\\w\\excerpt.md' } }),
      };
    }
    const body = target.includes('/settings') ? settingsPayload : compacted;
    return { ok: true, status: 200, json: async () => body };
  };
  const tick = async (times = 4) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const renderOne = () => {
    hookIndex = 0; currentComponent = 'missBare';
    return resolveTree(withComponent('missBare', () => renderMiss({ sessionId: 'session-x' })));
  };
  hookStore.clear();
  let out = renderOne();
  await tick();
  out = renderOne();
  const findClickable = (node, acc = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return acc;
    if (node.type === 'button' && typeof node.props?.onClick === 'function') acc.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) findClickable(child, acc);
    return acc;
  };
  await new Promise((resolve) => setTimeout(resolve, 2));
  out = renderOne();
  findClickable(out).find((node) => (textOf(node.props.children) ?? '').includes('✕'))?.props.onClick();
  await tick();
  hookIndex = 0; currentComponent = 'missTailBare';
  const tailText = textOf(resolveTree(withComponent('missTailBare', () => renderMissTail({ sessionId: 'session-x' }))));
  check('会话内结果块渲染出来了（前提成立）', tailText.includes('找到相关内容'), `实际=${tailText.slice(0, 80)}`);
  check('结果块里没有裸 `**`（Markdown 不会在文本节点里渲染）',
    !tailText.includes('**'), `实际=${(tailText.match(/.{0,20}\*\*.{0,20}/) ?? ['(没有)'])[0]}`);
  check('结果块里也不再有"自动复制/粘贴"的暗示', !tailText.includes('复制') && !tailText.includes('粘贴'), tailText.slice(0, 80));
}

if (failures > 0) process.exit(1);

/* ── 会话内「没想起来？」按钮：只在压缩过的会话里出现 ─────────────────── */
{
  // diagnostics 里有这个会话且 knownCompactions>0 → 应渲染出按钮
  const compacted = { ok: true, value: { runtime: [{ sessionId: 'session-x', workspace: 'E:\\w', knownCompactions: 2, hits: 1, misses: 2, lastQuery: '之前那个问题' }] } };
  const fresh = { ok: true, value: { runtime: [{ sessionId: 'session-x', workspace: 'E:\\w', knownCompactions: 0, hits: 0, misses: 0, lastQuery: '' }] } };
  let last = null;
  /** 多等几个微任务：点 ✕ 之后的结果是跨 fetch/await 才发布的。 */
  const tick = async (times = 4) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  /**
   * 渲染一次（会等几轮微任务，让 effect 里的 fetch 落地）并把解析后的树留在 `last`。
   * fetch 桩**按 URL 分派**（宿主就是这样：/diagnostics 与 /settings 是两个接口）——
   * 全都回同一个 payload 会让"模型名"这类跨接口的读取永远读到 undefined。
   */
  const renderNode = async (payload) => {
    globalThis.fetch = async (url) => ({
      ok: true, status: 200,
      json: async () => (String(url).includes('/settings') ? settingsPayload : payload),
    });
    hookStore.clear();
    hookIndex = 0; currentComponent = 'miss';
    let out = resolveTree(withComponent('miss', () => renderMiss({ sessionId: 'session-x' })));
    await tick();
    hookIndex = 0; currentComponent = 'miss';
    out = resolveTree(withComponent('miss', () => renderMiss({ sessionId: 'session-x' })));
    await tick();
    last = out;
    return textOf(out);
  };
  const render = async (payload) => renderNode(payload);
  const withHistory = await render(compacted);
  const without = await render(fresh);
  check('压缩过的会话 → 出现「未命中诊断」按钮（图标 ✕）', withHistory.includes('✕'), `实际文本：${withHistory.slice(0, 60)}`);
  check('没压缩过的会话 → 完全不渲染按钮', without.trim() === '', `实际文本：${without.slice(0, 60)}`);

  /* ── 点 ✕ 之后的两种状态：先「检索中」，再用结果替换 ─────────────────────
   * 用户要求：点了要**立刻**在会话里看到一行「xxx（辅助模型）检索中，请稍后…」，
   * 检索完成后再替换成"找到/没找到"那两种文案。这条断言必须能失败：
   * 若 pending 不渲染（或渲染了按钮），下面的 ✗ 会直接报出来。 */
  const findClickable = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (node.type === 'button' && typeof node.props?.onClick === 'function') out.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) findClickable(child, out);
    return out;
  };

  await renderNode(compacted);
  const clickable = findClickable(last);
  check('拿到了 ✕ 按钮的点击处理', clickable.length > 0, `按钮数=${clickable.length}`);
  // 挂起 /diagnose 的响应：点下去之后**只能**看到"检索中"这一行
  let release = null;
  globalThis.fetch = (url) => {
    const target = String(url);
    // ⚠️ 必须排除 `/diagnostics`：它里面也含 `/diagnose` 这个子串，
    // 只写 includes('/diagnose') 会把诊断探测一起挂起（实测踩过）。
    if (target.includes('/diagnose') && !target.includes('/diagnostics')) {
      return new Promise((resolve) => {
        release = () => resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, value: { verdict: 'above-threshold', found: true, boosting: true, chars: 120, model: 'glm-5.3-flash', material: '【对话】标题\n正文', file: 'E:\\w\\excerpt.md' } }),
        });
      });
    }
    const body = target.includes('/settings') ? settingsPayload
      : target.includes('/diagnostics') ? compacted : { ok: true, value: {} };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };
  // 点之前先睡一下、并**重新取一次**按钮：上一次渲染拿到的那个元素带着旧的闭包
  // （busy/note 是旧的）。
  await new Promise((resolve) => setTimeout(resolve, 3));
  const liveButton = findClickable(last).find((node) => (textOf(node.props.children) ?? '').includes('✕'));
  check('点下去之前能拿到当前的 ✕ 按钮元素', liveButton !== undefined, `按钮数=${findClickable(last).length}`);
  (liveButton ?? clickable[0]).props.onClick();
  check('点下 ✕ 后立刻拿到"检索中"状态', release !== null, 'onClick 没有发起 /diagnose 请求');
  hookIndex = 0; currentComponent = 'missTail';
  const pendingTree = resolveTree(withComponent('missTail', () => renderMissTail({ sessionId: 'session-x' })));
  const pendingText = textOf(pendingTree);
  check('"检索中"显示配置里的模型名', pendingText.includes('glm-5.3-flash（辅助模型）检索中，请稍后…'),
    `实际文本：${pendingText.slice(0, 80)}`);
  check('"检索中"状态不显示任何按钮（结果没出来不该给操作）',
    !pendingText.includes('知道了') && !pendingText.includes('打开原文'), `实际文本：${pendingText.slice(0, 80)}`);
  // 放行 → 同一块被最终结果替换
  if (release !== null) release();
  await tick();
  hookIndex = 0; currentComponent = 'missTail';
  const doneTree = resolveTree(withComponent('missTail', () => renderMissTail({ sessionId: 'session-x' })));
  const doneText = textOf(doneTree);
  check('结果回来后替换成"找到相关内容"', doneText.includes('找到相关内容'), `实际文本：${doneText.slice(0, 80)}`);
  check('找到时保留「打开原文」与「知道了」两个按钮',
    doneText.includes('打开原文') && doneText.includes('知道了'), `实际文本：${doneText.slice(0, 120)}`);
  check('结果显示的模型名与"检索中"一致', doneText.includes('glm-5.3-flash'), `实际文本：${doneText.slice(0, 80)}`);
}

if (failures > 0) process.exit(1);
console.log('全部通过。');
