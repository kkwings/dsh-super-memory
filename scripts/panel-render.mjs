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

/** effect 真的跑了几次 / cleanup 真的跑了几次（依赖数组语义的守卫，见 ReactStub.useEffect）。 */
let effectRuns = 0;
let effectCleanups = 0;
const effectCounter = {
  reset() { effectRuns = 0; effectCleanups = 0; },
  snapshot() { return { runs: effectRuns, cleanups: effectCleanups }; },
};

/**
 * 依赖数组比较（与真 React 同口径：逐项 `Object.is`，长度也要一致）。
 * @param {unknown} previous - 上一轮的依赖数组（`null` = 没给依赖数组）。
 * @param {unknown} next - 本轮的依赖数组。
 * @returns {boolean} 是否"依赖没变"。
 */
function sameDeps(previous, next) {
  if (previous === null || next === null || previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return false;
  }
  return true;
}

/**
 * 控件 ↔ 设置键的绑定审计收集器（2026-10-08 新增）。
 *
 * `lib/client.js` 里那四个基础控件（Toggle / NumberRow / TextRow / SelectRow）外面包了一层
 * `tracked()`：渲染时把「控件类型 + 它拿到的那个键名 + 它读到的值」推进
 * `window.__dsmControlAudit`。桩渲染不产生 DOM，这是唯一能"看见值"的地方 ——
 * **开关接到错的键**在真机上表现是"拨了没反应/拨错东西"，而在这张表里表现是
 * "值等于另一个键的值"，断言直接对不上。
 *
 * 每次 `render()` 都会把它重置为空数组，所以读到的永远是**本次渲染**的取值。
 */
const controls = { audit: [] };

/**
 * 从本次审计表里按标签取控件。
 *
 * ⚠️ 取**最后一条**，不是第一条（2026-10-08 修）：`render()` 会稳定迭代最多 8 轮，
 * 每轮都往审计表里追加一份条目，而设置/提供方清单是**异步落地**的（第一轮还只是初值）。
 * 原来取第一条 = 断言读的是**第一轮**的过期快照 —— 于是"下拉里有哪些选项"这类断言
 * 在变异实验里完全测不红（把兜底项改成无条件显示都全绿）。最后一轮才对应屏幕上那一帧。
 * @param {string} label - 控件的 auditLabel。
 * @returns {{kind:string,label:string,value:unknown,options?:string[]}|null} 最后一个同名控件。
 */
function controlByLabel(label) {
  let found = null;
  for (const item of controls.audit) if (item.label === label) found = item;
  return found;
}

/** 解析过程中"当前控件"的祖先链（`resolveTree` 维护；控件原型据此找自己的标签）。 */
const controlStack = [];

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
  /* ── 依赖数组必须被真的尊重（2026-10-08 修）──────────────────────────────
   * 早先的桩是"每渲染一次就把 effect 跑一次、cleanup 直接丢掉"：
   *   · 依赖没变也重跑 → 掩盖"依赖写错/漏写"（真机上 effect 不会重跑，桩里却会，
   *     于是测试看到的清理时机、请求次数与真机完全不同）；
   *   · cleanup 从不执行 → `alive = false` 那类取消逻辑一次都没被验证过；
   *   · useMemo/useCallback 直接调工厂 → 依赖变化带来的重算/不重算都测不出来。
   * 现在三者的语义与真 React 一致：依赖逐项 `Object.is` 比较，不变就不重跑；
   * 依赖变了先跑上一轮的 cleanup 再跑新的；`[]` 表示只跑一次。
   * 这一切都有 `effectRuns` / `effectCleanups` 计数，断言直接盯着数。 */
  useEffect(fn, deps) {
    const slot = `${currentComponent}#eff${hookIndex++}`;
    const previous = hookStore.get(slot);
    const changed = previous === undefined || !sameDeps(previous.deps, deps);
    if (!changed) return undefined;
    if (typeof previous?.cleanup === 'function') {
      effectCleanups += 1;
      try { previous.cleanup(); } catch { /* cleanup 异常不影响结构与后续渲染 */ }
    }
    let cleanup;
    effectRuns += 1;
    try { cleanup = fn(); } catch { /* 桩里效应失败不影响结构断言 */ }
    hookStore.set(slot, { deps: Array.isArray(deps) ? deps.slice() : null, cleanup: typeof cleanup === 'function' ? cleanup : null });
    return undefined;
  },
  useCallback(fn, deps) {
    const slot = `${currentComponent}#cb${hookIndex++}`;
    const previous = hookStore.get(slot);
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn;
    hookStore.set(slot, { deps: Array.isArray(deps) ? deps.slice() : null, fn });
    return fn;
  },
  useMemo(fn, deps) {
    const slot = `${currentComponent}#memo${hookIndex++}`;
    const previous = hookStore.get(slot);
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value;
    const value = fn();
    hookStore.set(slot, { deps: Array.isArray(deps) ? deps.slice() : null, value });
    return value;
  },
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
      llmAssistEnabled: true, llmIngestExpand: true, llmMode: 'custom', llmProvider: 'zai', llmModel: 'glm-5.3-flash',
      llmIngestTimeoutMs: 8000, llmIngestBatchBlocks: 8, llmIngestBlockChars: 600, llmIngestMaxTokens: 240,
      llmRecallRewrite: true,
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
/**
 * 把元素树里的文本抽出来。
 *
 * ⚠️ 必须和 `resolveTree` 一样**真的调用函数组件**（2026-10-08 修）：早先这里对
 * `node.type` 是函数的元素直接返回 ''，于是任何"被包了一层的控件"（例如 1c 里为
 * 绑定审计而加的 `Tracked` 包装）在文本断言里**整体消失** —— 断言会报"找不到这个控件"，
 * 而真机上面板好端端的。桩渲染器的两半（结构 / 文本）对函数组件的口径必须一致。
 * @param {unknown} node - 元素树 / 文本。
 * @param {number} [depth] - 递归深度保护。
 * @param {string} [path] - 组件路径（与 resolveTree 保持 hook 槽位一致）。
 * @returns {string} 文本。
 */
function textOf(node, depth = 0, path = 'root') {
  if (depth > 200 || node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map((item, index) => textOf(item, depth + 1, `${path}.${index}`)).join(' ');
  if (typeof node !== 'object' || node.type === undefined) return '';
  const props = node.props ?? {};
  if (node.type === FRAGMENT) return textOf(props.children, depth + 1, `${path}.frag`);
  if (typeof node.type === 'function') {
    const name = node.type.displayName ?? node.type.name ?? 'Anon';
    const isClass = typeof node.type.prototype?.render === 'function';
    const output = withComponent(`${path}<${name}>`, () => (isClass ? new node.type(props).render() : node.type(props)));
    return textOf(output, depth + 1, `${path}<${name}>`);
  }
  return textOf(props.children, depth + 1, `${path}.${String(node.type)}`);
}

/* ── 渲染：反复跑直到状态稳定（桩 useState 会把异步回来的数据写进槽位）──── */
/**
 * 最小渲染器：把元素树里的函数/类组件真正调用一遍，展开成宿主元素树。
 * （没有这一步，"树"只是元素对象，Panel 根本不会被执行。）
 */
function resolveTree(node, path = 'root', depth = 0) {
  if (depth > 200 || node === null || node === undefined) return null;
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
  controlStack.push(node);
  try {
    return { type: node.type, props: { ...props, children: resolveTree(props.children, `${path}.${String(node.type)}`, depth + 1) } };
  } finally {
    controlStack.pop();
  }
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
/**
 * 本次 `render()` 要种进「已配置提供方清单」的桩数据（`null` = 不种，走 /llm/providers 的
 * 正常路径）。桩渲染没有真正的重渲染，effect 里 `setState` 的结果回灌不进下一轮 —— 所以那份
 * 清单**只能在种 hook 槽位时**喂进去（面板为此提供 `window.__dsmProviders` 这个只改初值的口）。
 */
let seedProviders = null;
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
  // 控件 ↔ 键的绑定审计（见上面的控件包装）：每次 `render()` 从空数组开始收集本次渲染的取值。
  controls.audit = [];
  window.__dsmControlAudit = controls.audit;
  for (const key of [...hookStore.keys()]) {
    if (key.startsWith(base)) hookStore.delete(key);
  }
  initialSlots.forEach((value, index) => hookStore.set(`${base}#${index}`, value));
  // 提供方清单只能在这一刻种（面板的初值读的就是 window.__dsmProviders）
  window.__dsmProviders = Array.isArray(seedProviders) ? seedProviders : undefined;
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
  /* 「恢复默认设置」的行为提示必须先写清楚（2026-10-08）：
   * 它现在是"逐键重置 + 保留模型档位"，不再是删掉整个设置文件。按钮上只有四个字，
   * 用户点之前必须能知道"模型选择不会被清掉"，否则要么不敢点、要么点了才发现差别。
   * 能失败：把 client.js 里那句 dsm-hint 删掉 / 改成不提"保留模型选择"，这一条立刻红。 */
  check('⑥ 的「恢复默认设置」写明了会重置参数但保留模型选择',
    diagText.includes('会重置所有参数，但保留模型选择'),
    '按钮 hint 丢失 —— 用户无从得知模型档位不会被清掉（2026-10-08 就是这么丢的）');
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


/* ── 断言：⑦ 的"提供方 / 模型 / 测试连接"只认单一字段集（2026-10-08）───────────
 * 收敛后只有一对模型字段（`llmProvider`/`llmModel`）；旧的两对影子键
 * （`llmIngest*` / `llmRecall*`）已从设置里删除，设置文件里即使残留也会在 load() 时
 * 被搬进新键并丢弃。这一节钉死两条，每条都能失败：
 *   ① 控件的取值来自新键（绑到旧键 → 值对不上 → 红）；
 *   ② 提交的补丁**只含新键**（把旧键一起写回去的那种补丁 → 红）。
 * ② 只能看源码：桩渲染不产生 DOM，"点一下下拉"在这里没有真实的交互对象。 */
{
  const originalValue = settingsPayload.value;
  settingsPayload.value = {
    ...originalValue,
    settings: { ...originalValue.settings, llmMode: 'custom', llmProvider: 'zai', llmModel: 'glm-5.3-flash' },
  };
  await render(false, true);
  settingsPayload.value = originalValue;
  for (const [label, value] of [['提供方', 'zai'], ['模型', 'glm-5.3-flash']]) {
    const control = controlByLabel(label);
    check(`⑦「${label}」控件读的是新键（值 = ${value}）`,
      control !== null && control.kind === 'select' && String(control.value) === value,
      `控件=${JSON.stringify(control)}（若绑到已删除的 llmIngest*/llmRecall* 键，这里会读到空串）`);
  }
  /**
   * 取两个下拉**各自**在 `client.js` 里的源码块（从块的唯一标记到 `}),` 收尾）。
   *
   * ⚠️ 三个坑（2026-10-08 实测各踩过）：
   *   ① 必须 `lastIndexOf`：`client.js` 的源码拼在**本测试文件之后**，而这段断言自己也会写
   *      字面量 `auditLabel: '模型'` —— 用 `indexOf` 会切到断言自己身上（报"没找到 patch"）；
   *   ② 起点不能停在 `auditLabel` 那一行：模型块里 `hint: modelHintFor(scope),` 自身就以
   *      `}),` 收尾，从 `auditLabel` 往后找第一个 `}),` 会**在 hint 行截断**，把后面的
   *      `onCommit: (value) => patch(...)` 整段切掉 → 两条"补丁键"断言假红；
   *   ③ 两个下拉的收尾 `}),` 都不是字符串字面量，切片不会误伤（切到 `}),` 前一位为止）。
   */
  const blockOf = (label) => {
    const marker = label === '提供方' ? "onCommit: (value) => patch(providerChangePatch(value))" : 'hint: modelHintFor(scope),';
    const start = source.lastIndexOf(marker);
    if (start < 0) return '';
    const end = source.indexOf('}),', start);
    return end < 0 ? '' : source.slice(start, end);
  };
  /* 两个下拉的提交补丁各钉一条。
   *
   *   · 「提供方」：补丁由 `providerChangePatch()` 生成 —— 修法要求"换提供方时，若型号不属于
   *     新提供方，**同一次补丁**里带上 `llmModel: ''`"。所以这里不能再要求
   *     `patch({ llmProvider: value })`（那是修复前的写法），改成钉死"就走这个函数"；
   *     真正的键集合（含 `llmModel: ''`）由下面 `llmModelScope` 那节按**行为**断言。
   *     （旧影子键 `llmIngest…` / `llmRecall…` 也不许写回去：`providerChangePatch` 的返回值里
   *      只有 `llmProvider` / `llmModel` 两个键，`panel-check.mjs` 的 patchKeys 会把
   *      每个键拿去与 EDITABLE_FIELDS 比对。）
   *   · 「模型」：仍是"只含新键 `llmModel`"。**必须按块单独断言** —— 2026-10-08 起自动清空
   *     那条 effect 也会 `patch({ llmModel: '' })`，按标签取块会把两处混在一起。 */
  {
    const providerBlock = blockOf('提供方');
    check('⑦「提供方」的提交走 providerChangePatch()（换提供方时同一次补丁清空不属于它的型号）',
      providerBlock.includes('patch(providerChangePatch(value))'),
      `提供方块：${providerBlock.replace(/\s+/g, ' ').slice(0, 160)}`);
    const modelBlock = blockOf('模型');
    const keys = [...modelBlock.matchAll(/patch\(\{([^}]*)/g)]
      .flatMap((m) => m[1].split(',').map((item) => item.trim().split(':')[0].trim()).filter(Boolean));
    check('⑦「模型」提交的补丁仍只含 llmModel（自动清空那处在别的块里，不在这块）',
      keys.length === 1 && keys[0] === 'llmModel',
      `模型块 patch 到：${keys.join(',') || '(没找到 patch)'}（块：${modelBlock.replace(/\s+/g, ' ').slice(0, 160)}）`);
  }
  const offText = await (async () => {
    settingsPayload.value = {
      ...originalValue,
      settings: { ...originalValue.settings, llmMode: 'off', llmAssistEnabled: false, llmProvider: 'zai', llmModel: 'glm-5.3-flash' },
    };
    const tree = await render(false, true);
    settingsPayload.value = originalValue;
    return tree === null ? '' : textOf(tree);
  })();
  check('⑦ off 档位下不显示提供方/型号下拉（它们只在 custom 下有意义）',
    !offText.includes('下拉里是你在「设置 → 模型」里配好的提供方'), 'off 档位下不该出现提供方下拉');
}

/* ── 断言：「模型」下拉的作用域 + 换提供方后的清空（2026-10-08，用户报告）───────────
 * 用户原话：把模型提供方改成 deepseek 之后，模型下拉里**不该**再有
 * 「跟随主模型」和旧提供方的 `glm-5.3-flash`；提供方改成其它时同理。
 *
 * 这里用**桩提供方清单**（`/llm/providers` 的返回形状：`{ provider, models }`）把四种状态
 * 一次测清：
 *   ① 提供方非空 + 一个**不属于它**的型号 → 下拉里既没有旧型号也不出现「跟随主模型」；
 *   ② 切提供方 → 同一个补丁里带上了 `llmModel: ''`（换提供方的联动）；
 *   ③ 提供方为空 → 首项是「跟随主模型」；提供方非空且型号为空 → 首项**不是**它；
 *   ④ 清单为空（读不到型号清单）→ **保留**原值、不下发清空补丁，且原值仍显示在下拉里。
 *
 * 桩数据里的三个型号名是**专供本段**的哨兵（`selftest` / 其它脚本不会用到），
 * 免得与别处的 `glm-*` 桩值互相干扰。 */
{
  const STUB_PROVIDERS = [
    { provider: 'stub-zhipu', models: ['stub-glm-5.3-flash', 'stub-glm-4.6'] },
    { provider: 'stub-deepseek', models: ['stub-ds-v4-flash', 'stub-ds-v4-pro'] },
  ];
  /**
   * 找到某个标签所在行里**真正渲染出来的** `<select>`，并抽出它的 `<option>` 取值。
   *
   * 为什么不能只看控件审计里的 `options`（2026-10-08 实测踩过）：那是**传进来的 prop**，
   * 不是最终 DOM 的子节点 —— 把 `SelectRow` 的兜底项改成"无条件把当前值也加一项"，
   * 审计里的 options 一个字都不变，于是"下拉里没有旧型号"这条断言**测不红**（假的守卫）。
   * 这条按 DOM 走：标签 → 同一行 → select → option，多一项就露馅。
   * @param {object} tree - 已解析的渲染树。
   * @param {string} label - 行标签（如「模型」）。
   * @returns {string[]|null} option 的 value 列表（找不到返回 null）。
   */
  const renderedOptionValues = (tree, label) => {
    const findByLabel = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const item of node) { const hit = findByLabel(item); if (hit) return hit; } return null; }
      const own = textOf(node.props?.children);
      const isRow = String(node.props?.className ?? '') === 'dsm-row' && own.startsWith(label);
      if (isRow) return node;
      for (const child of Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]) {
        const hit = findByLabel(child);
        if (hit) return hit;
      }
      return null;
    };
    const findSelect = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const item of node) { const hit = findSelect(item); if (hit) return hit; } return null; }
      if (node.type === 'select') return node;
      for (const child of Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]) {
        const hit = findSelect(child);
        if (hit) return hit;
      }
      return null;
    };
    const row = findByLabel(tree);
    const select = row === null ? null : findSelect(row);
    if (select === null) return null;
    const values = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node.type === 'option') values.push(String(node.props?.value ?? ''));
      for (const child of Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]) walk(child);
    };
    walk(select);
    return values;
  };
  const stubOriginalValue = settingsPayload.value;
  const stubOriginalSettings = stubOriginalValue.settings;
  const stubOriginalFetch = globalThis.fetch;
  /* 先把"提供方清单"这个种子显式种上：本段必须从一开始就在"读得到清单"的状态下渲染，
   * 否则面板里 `llmProviders` 的初值是空数组，前几步渲染就把空数组写进 hook 槽位了
   *（实测踩过：`providerChangePatch` 拿到的是空清单 → 断言假红）。 */
  seedProviders = STUB_PROVIDERS;
  /** 观察到的「写设置」请求体（含别处 effect 顺带触发的）：用来证明"清空"真的写盘了。 */
  const stubPuts = [];
  const stubWith = (providers) => {
    /* 桩渲染不会把 effect 里的 setState 结果回灌到下一轮渲染（没有真正的重渲染），
     * 于是 `/llm/providers` 的返回在渲染断言里永远看不见 —— 用**种槽位时**的初值口
     * 把清单喂进去（`render()` 读 `seedProviders` 写 `window.__dsmProviders`；
     * 真机不设它，走 `/llm/providers` 的正常路径）。 */
    seedProviders = providers;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      if (options?.method === 'PUT' && target.includes('/settings')) stubPuts.push(String(options.body ?? ''));
      if (target.includes('/llm/providers')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { serviceAvailable: true, providers } }) };
      }
      return stubOriginalFetch(url, options);
    };
  };
  /** 带一段提供方清单渲染面板，返回「模型」下拉控件（含本次渲染的 options 清单）。
   * `seenPuts` 传数组时只收**本次渲染窗口内**的写设置请求体 —— 断言因此能精确到
   * "这一种状态有没有触发清空"，不受别处 effect 的异步写盘干扰。
   * （面板的 hook 槽位是共享的：两个渲染不能并行跑，否则会互相覆盖状态。） */
  const renderModelControl = async (settingsPatch, providers, seenPuts = null) => {
    settingsPayload.value = { ...stubOriginalValue, settings: { ...stubOriginalSettings, llmMode: 'custom', ...settingsPatch } };
    const before = stubPuts.length;
    stubWith(providers);
    const tree = await render(false, true);
    const mine = stubPuts.slice(before);
    if (Array.isArray(seenPuts)) seenPuts.push(...mine);
    settingsPayload.value = stubOriginalValue;
    globalThis.fetch = stubOriginalFetch;
    return { tree, control: controlByLabel('模型'), puts: mine };
  };
  try {
    /* ① 提供方非空 + 型号不属于它 → 下拉里没有旧型号，也没有「跟随主模型」；
     *    并且**真的写盘清空**（不是只是不显示）。 */
    {
      const seen = [];
      const { tree, control } = await renderModelControl(
        { llmProvider: 'stub-deepseek', llmModel: 'stub-glm-5.3-flash' }, STUB_PROVIDERS, seen);
      const options = control?.options ?? [];
      const shown = textOf(tree);
      const domOptions = renderedOptionValues(tree, '模型');
      check('⑦ 换提供方后：旧提供方的型号不再出现在模型下拉的选项里',
        !options.includes('stub-glm-5.3-flash') && !options.includes('stub-glm-4.6'),
        `选项=${JSON.stringify(options)}（提供方 stub-deepseek，型号清单里不该有 glm）`);
      /* DOM 侧再钉一遍（这条才是真守卫：变异实验里只有它会红）。 */
      check('⑦ 换提供方后：**渲染出来的**模型下拉里没有旧型号那一项（DOM 级，不只看 prop）',
        domOptions !== null && !domOptions.includes('stub-glm-5.3-flash') && !domOptions.includes('stub-glm-4.6'),
        `DOM option 值=${JSON.stringify(domOptions)}`);
      check('⑦ 换提供方后：下拉里不再出现「跟随主模型」（提供方已选定，这句不成立）',
        !shown.includes('（跟随主模型）'),
        `实际下拉文本含：${(shown.match(/（[^）]*模型[^）]*）/g) ?? ['(没有)']).join(' / ')}`);
      check('⑦ 换提供方后：模型下拉只列该提供方公布的型号',
        options.length === 2 && options.includes('stub-ds-v4-flash') && options.includes('stub-ds-v4-pro'),
        `选项=${JSON.stringify(options)}`);
      /* 必须有这一条，前面那条才不是"空断言"：当前值确实是一个**非空的旧型号**，
       * 而它不在作用域清单里 —— 这正是"兜底项要不要显示"的判定场景。
       * 当前值为空时 `current !== ''` 不成立，`keepUnknown` 改回旧写法也不会露馅
       *（2026-10-08 实测：少了这条，变异①测不出来）。 */
      check('⑦ 前提：当前值是一个**非空**的旧提供方型号（否则"不显示旧型号"是空断言）',
        String(control?.value ?? '') === 'stub-glm-5.3-flash',
        `控件值=${JSON.stringify(control?.value)} 选项=${JSON.stringify(options)}`);
      check('⑦ 清单非空且型号不属于该提供方时，配置里也真的**清空**了（下发了 llmModel:"" 的 PUT，不是只是不显示）',
        seen.some((body) => body.includes('"llmModel":""')),
        `本次渲染窗口内的 PUT：${seen.length === 0 ? '(一个都没有)' : seen.join(' | ')}`);
    }
    /* ② 切提供方 → 同一个补丁里带上 llmModel: ''（这就是"清空"那条修法）
     *
     * ⚠️ 这里**不通过** `window.__dsmTestHooks.providerChangePatch` 调 —— 那是个闭包，
     * 桩渲染每跑完一轮都会重新登记，而 `render()` 结尾会把 hook 槽位重置成初值，
     * 于是"事后调它"用到的是**某一轮渲染**捕获的 `llmProviders`，不一定是我刚种的那份
     *（2026-10-08 实测：槽位里是种子、闭包里却是空数组，断言假红）。
     * 改成直接钉**它内部的纯判据** `selectModelScope`（同一份作用域也真的在渲染里用了，
     * 见 ① 的选项断言），并在下面按源码钉"提供方提交走的就是 providerChangePatch"。
     * 行为侧（真的下发 llmModel:"" 的 PUT）由 ① 的渲染窗口断言负责 —— 那条是端到端的。 */
    {
      const { control } = await renderModelControl(
        { llmProvider: 'stub-zhipu', llmModel: 'stub-glm-5.3-flash' }, STUB_PROVIDERS);
      const hooks = globalThis.window?.__dsmTestHooks;
      check('⑦ 面板导出了模型作用域纯函数（本段断言的前提）',
        hooks !== undefined && typeof hooks.selectModelScope === 'function',
        `hooks=${hooks === undefined ? 'undefined' : Object.keys(hooks).join(',')}`);
      const scopeFn = hooks?.selectModelScope;
      check('⑦ 前提成立：这一步渲染的当前型号确实是 stub-glm-5.3-flash（否则下面两条是空的）',
        String(control?.value ?? '') === 'stub-glm-5.3-flash', `控件=${JSON.stringify(control)}`);
      const nextScope = scopeFn?.('stub-deepseek', 'stub-glm-5.3-flash', STUB_PROVIDERS);
      check('⑦ 切到别的提供方时：该型号不在新提供方的清单里 → `keepUnknown:false`（= 补丁里会带上 llmModel:""）',
        nextScope?.keepUnknown === false && nextScope?.known === true,
        `scope=${JSON.stringify(nextScope)}（"提供方已切、型号没清"就是用户报的那个 bug）`);
      /* 反向：新提供方的清单里**有**这个型号时不许清（正常换型号不该丢配置） */
      const keepScope = scopeFn?.('stub-zhipu', 'stub-glm-5.3-flash', STUB_PROVIDERS);
      check('⑦ 型号属于新提供方时**不清空**（keepUnknown:true，补丁里不含 llmModel）',
        keepScope?.keepUnknown === true,
        `scope=${JSON.stringify(keepScope)}`);
      /* 清空决策的写法必须与 `providerChangePatch` 的返回值一致：两个键都在同一个对象里。 */
      const block = source.slice(source.lastIndexOf('function providerChangePatch'), source.indexOf('测试钩子', source.lastIndexOf('function providerChangePatch')));
      check('⑦ 清空是写在**同一个补丁对象**里的（`{ llmProvider, llmModel: \'\' }`），不是两次写盘',
        /llmProvider:\s*value,\s*llmModel:\s*''/.test(block.replace(/\s+/g, ' ')),
        `providerChangePatch 片段：${block.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    /* ③ 首项文案：提供方为空 → 「跟随主模型」；提供方非空且型号为空 → 不是它 */
    {
      const { tree } = await renderModelControl({ llmProvider: '', llmModel: '' }, STUB_PROVIDERS);
      const shown = textOf(tree);
      check('⑦ 提供方为空 → 模型下拉第一项是「跟随主模型」', shown.includes('（跟随主模型）'),
        `实际下拉文本含：${(shown.match(/（[^）]*）/g) ?? ['(没有)']).slice(0, 8).join(' ')}`);
    }
    {
      const { tree, control } = await renderModelControl({ llmProvider: 'stub-zhipu', llmModel: '' }, STUB_PROVIDERS);
      const shown = textOf(tree);
      check('⑦ 提供方非空且型号为空 → 第一项不是「跟随主模型」', !shown.includes('（跟随主模型）'),
        '提供方已选定，这里只能写"用该提供方的默认模型"之类');
      check('⑦ 提供方非空且型号为空 → 第一项写成「用该提供方的默认模型」',
        shown.includes('（用该提供方的默认模型）'), `选项=${JSON.stringify(control?.options ?? [])}`);
    }
    /* ④ 清单为空 → 保留原值、不清空、原值仍显示在下拉里 */
    {
      const seen = [];
      const { tree, control } = await renderModelControl(
        { llmProvider: 'stub-zhipu', llmModel: 'stub-glm-5.3-flash' }, [], seen);
      check('⑦ 提供方清单为空：原值**仍显示**在模型下拉里（查不到 ≠ 用户配错了）',
        (control?.options ?? []).includes('stub-glm-5.3-flash') || textOf(tree).includes('stub-glm-5.3-flash'),
        `选项=${JSON.stringify(control?.options ?? [])}`);
      check('⑦ 提供方清单为空：不下发任何清空补丁（"查不到清单"绝不能清掉用户配置）',
        !seen.some((body) => body.includes('"llmModel":""')),
        `本次渲染窗口内的 PUT：${seen.length === 0 ? '(一个都没有)' : seen.join(' | ')}`);
    }
  } finally {
    settingsPayload.value = stubOriginalValue;
    globalThis.fetch = stubOriginalFetch;
  }
  /* 行为级反向守卫：那两个"配置里也清空了 / 没有清空"的断言已经在 ①/④ 的渲染窗口里量过
   *（`renderModelControl` 会把窗口内的 PUT 请求体带回来）—— 这里不再重复一遍。 */
}

/* ── 断言：✕ 的结果块**不得跨轮残留**（2026-10-08 回归修复）────────────────────────
 * 用户实测回归：上一轮点 ✕ 之后出现的结果块（以及"检索中"那块）跟到了下一轮回答后面。
 *
 * 取证结论（写在这里，免得以后又被猜成别的原因）：
 *   · `MissAction` 探测 `/diagnostics` 时**带了**自定义头与 `?session=`，
 *     宿主（`lib/routes.js` 1315–1345）在"点名 session"时也**确实回** `lastQuery`
 *     —— 所以"请求没带 session / 被 guard 抹空导致 lastQuery 恒为空"这个怀疑**不成立**；
 *   · 真正的原因是**陈旧判定用的是提问文本**：旧代码 `if (now !== lastSeenQuery.current)`
 *     靠 `lastQuery` 变没变来决定要不要清上一轮的结果。用户按 ✕ 的文案
 *     "直接继续提问即可"再问一遍**同一句话**时文本不变 → 永远不清 → 结果块跟着走。
 *
 * 修法：结果发布时记下它属于哪一轮（`turnTail` 槽位给的 `turn`），渲染时按轮次取
 *（`missResultFor`）——不再依赖提问文本。下面三条分别钉住：跨轮不显示、pending 同理、
 * 同一句话重复提问也得清。 */
{
  const hooks = globalThis.window?.__dsmTestHooks ?? {};
  /** 找可点元素（本段自备一份：别处的同名工具在别的块作用域里）。 */
  const findClickable = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) findClickable(item, out); return out; }
    if (node.type === 'button' && typeof node.props?.onClick === 'function') out.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) findClickable(child, out);
    return out;
  };
  check('✕ 结果按轮次判定的钩子已导出（本段断言的前提）',
    typeof hooks.missResultFor === 'function' && typeof hooks.publishMiss === 'function' && typeof hooks.resetMiss === 'function',
    `hooks=${Object.keys(hooks).join(',') || '(空)'}`);
  const missSession = 'session-regression';
  /**
   * 渲染一次 `turnTail` 那一块（每次都从干净槽位开始，等价于"新一轮挂载"）。
   *
   * ⚠️ 这一段**不能**留着 `seedProviders`（见上）：它会把"已配置提供方清单"这个种子
   * 带到后面所有渲染里 —— 两块状态互相串味（2026-10-08 实测：⑦ 的切提供方断言因此变红）。
   * 所以进这一段先清掉它，走 `/llm/providers` 的正常路径。
   */
  seedProviders = null;
  const renderTailFor = async (sessionId, turn, key) => {
    hookIndex = 0;
    currentComponent = key;
    const out = withComponent(key, () => renderMissTail({ sessionId, turn, seq: turn }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { text: textOf(out), tree: out };
  };
  const renderTail = (turn, key) => renderTailFor(missSession, turn, key);
  hooks.resetMiss?.(missSession);
  hooks.publishMiss?.(missSession, { found: true, model: 'stub-model', excerpt: '上一轮找到的资料', file: 'E:\\w\\a.md' }, 1);
  check('✕ 前提：刚发布的结果属于第 1 轮（`missResultFor(session, 1)` 能拿到）',
    hooks.missResultFor?.(missSession, 1)?.turn === 1,
    `stored=${JSON.stringify(hooks.missResultFor?.(missSession, 1))}`);
  /* 先把"轮次判定"这条判据**在渲染之前**钉死（渲染会把陈旧项清掉，事后就测不到了）：
   * 仓库里明明躺着第 1 轮的结果，"第 2 轮"必须取不到；同一轮必须取得到。
   * 能失败：把 `missResultFor` 的轮次比较撤掉（`return stored`）→ 第一条立刻红。 */
  check('✕ 判据本身：轮次不同的仓库项取不到（这就是"不得跨轮显示"的根）',
    hooks.missResultFor?.(missSession, 2) === null,
    `第 2 轮取到=${JSON.stringify(hooks.missResultFor?.(missSession, 2))}（它明明属于第 1 轮）`);
  check('✕ 判据本身：同一轮的仓库项取得到（不能把正常显示一起修没）',
    hooks.missResultFor?.(missSession, 1)?.found === true,
    `第 1 轮取到=${JSON.stringify(hooks.missResultFor?.(missSession, 1))}`);
  check('✕ 参考点：同一轮（turn=1）**仍然显示**结果块（不能把正常显示一起修没）',
    (await renderTail(1, 'missTurnSame')).text.includes('找到相关内容'),
    '同一轮必须照常显示，否则这条修复等于把功能关掉了');
  const nextTurn = await renderTail(2, 'missTurnNext');
  check('✕ 核心回归：上一轮的结果块**不得出现在新一轮**（turn=2 渲染不出上一轮的内容）',
    !nextTurn.text.includes('找到相关内容') && !nextTurn.text.includes('上一轮找到的资料'),
    `新一轮实际渲染：${nextTurn.text.slice(0, 120) || '(空)'}`);
  /* 同一句话重复提问：文本判据永远触发不了，只有轮次判据能拦住 —— 这条专门钉住那个洞。 */
  hooks.resetMiss?.(missSession);
  hooks.publishMiss?.(missSession, { pending: true, model: 'stub-model' }, 7);
  check('✕ 前提：pending（"检索中"）已发布在第 7 轮',
    hooks.missResultFor?.(missSession, 7)?.pending === true,
    `stored=${JSON.stringify(hooks.missResultFor?.(missSession, 7))}`);
  check('✕ 同一轮仍然显示"检索中"（用户点了 ✕ 要立刻有反馈）',
    (await renderTail(7, 'missPendSame')).text.includes('检索中'),
    '同一轮的 pending 必须显示');
  const pendingNext = await renderTail(8, 'missPendNext');
  check('✕ 上一轮的"检索中"也不得跟到下一轮（pending 与最终结果同等对待）',
    !pendingNext.text.includes('检索中'),
    `新一轮实际渲染：${pendingNext.text.slice(0, 120) || '(空)'}`);

  /* ── 第二条路径：`MissAction` 的"新问题一到就清"（同一句话重复提问）──────────
   * 旧代码 `if (now !== lastSeenQuery.current)` 拿**提问文本**当轮次判据：用户按 ✕ 的
   * 文案"直接继续提问即可"再问一遍同一句话时文本不变 → 永远不触发 → 结果块跟着走。
   * 新代码的判据抽成 `missActionDecide(探测到的提问, 挂载时的提问)`，这里直接钉它：
   * 文本相同也必须判"新问题已到"（因为**动作栏实例换了一个**，说明又答了一轮）。
   * ⚠️ 为什么不整条渲染出来测：桩渲染不会自动重渲染，异步回来的 `ready.lastQuery`
   * 进不了 effect 的第二次执行（实测：effect 只跑到 `ready` 落地那次）。 */
  {
    check('✕ 旧写法的判据就是"提问文本变没变"（取证件：源码里不再有那个按文本比较的 ref）',
      !source.includes('lastSeenQuery'),
      '还在用按提问文本比较的 ref —— 陈旧判定仍依赖提问文本');
    /* 交互面：真的渲染一次 `MissAction`、真的点一次 ✕ —— 保证"发布结果"这条路径
     * 在加了轮次归属之后**没被修坏**（本轮必须能显示；能失败：把结果块整块吞掉就会红）。
     * 顺序说明：`missActionDecide` 是在 `MissAction` 渲染时才登记的，所以判据断言放在**后面**。 */
    const originalFetch = globalThis.fetch;
    const session = 'session-q-repeat';
    const reply = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) });
    /* 记下 ✕ 发给 `/diagnose` 的**请求体**：这一段要证明"按钮把这一轮的
     * `messageId` 一起发出去了"（宿主靠它把 ✕ 绑定到该轮的提问，见 lib/routes.js）。 */
    const diagnoseBodies = [];
    const actionMessageId = 'msg-of-turn-1';
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes('/diagnostics')) {
        return reply({ runtime: [{ sessionId: session, workspace: 'E:\\w', knownCompactions: 2, hits: 1, misses: 1, lastQuery: '同一句话' }] });
      }
      if (target.includes('/diagnose')) {
        if (typeof init?.body === 'string') {
          try { diagnoseBodies.push(JSON.parse(init.body)); } catch { diagnoseBodies.push({ __raw: init.body }); }
        }
        return reply({ boosting: true, found: true, material: '【对话】找到的资料', model: 'stub-model', file: 'E:\\w\\a.md' });
      }
      if (target.includes('/settings')) return settingsPayload;
      if (target.includes('/overview')) return overviewPayload;
      return reply({});
    };
    try {
      hooks.resetMiss?.(session);
      const key = 'missRepeat';
      /* 先渲染一次"本轮的尾巴"，把这一轮的轮次身份登记进去 —— 真机上点 ✕ 时这一轮的
       * `turnTail` 一定已经挂载（`assistant-actions` 是它的子节点），所以这是**更真实**的顺序：
       * 结果发布时就带上轮次，而不是靠后面渲染尾巴时才补。 */
      await renderTailFor(session, 1, 'missRepeatTail');
      /** 渲染一次动作栏（沿用同一路径 = 同一个实例），渲染两轮让异步 `ready` 落地。 */
      const renderAction = async () => {
        let out = null;
        for (let round = 0; round < 2; round += 1) {
          hookIndex = 0;
          currentComponent = key;
          // 与真机同形：DSH 的 `TurnTailNodeView` 只给这个槽位 `{ messageId }`
          //（`renderSlot("conversation.chat.assistant-actions", { messageId })`），
          // `sessionId` 由本插件的 `inject` 补上。
          out = withComponent(key, () => renderMiss({ sessionId: session, messageId: actionMessageId }));
          for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return out;
      };
      const first = await renderAction();
      const button = findClickable(first).find((node) => String(textOf(node.props.children) ?? '').includes('✕')) ?? null;
      check('✕ 前提：拿到了 ✕ 按钮（否则下面"点了之后有结果"是空的）', button !== null,
        `可点元素=${findClickable(first).length}`);
      button?.props.onClick();
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      const published = hooks.missResultFor?.(session, 1);
      check('✕ 点 ✕ 之后结果块真的发布了（并且打上了轮次归属 —— 交互路径没被修坏）',
        published !== null && published !== undefined,
        `stored=${JSON.stringify(published)}`);
      check('✕ 结果块挂在这一轮上（第 1 轮渲染得出来；跨轮才不显示）',
        (await renderTailFor(session, 1, 'missRepeatSame')).text.includes('找到相关内容'),
        '同一轮必须显示 —— 若这里也空，说明把功能整体关掉了，不是修好');
      /* ✕ 请求必须带上**这一轮的 `messageId`**（宿主据此把 ✕ 精确定位到"这条回答对应的
       * 提问"，而不是"会话最后一条提问"）。
       * ⚠️ 能失败：把 `body: JSON.stringify({... messageId: ownMessageId ...})` 里的
       * `messageId` 去掉 → 这一条立刻红（真机上表现为"点 ✕ 查的是别的问题"）。 */
      const sentBody = diagnoseBodies.slice(-1)[0] ?? null;
      check('✕ 发出的 /diagnose 请求带上了这一轮的 messageId',
        sentBody?.messageId === actionMessageId, `实际请求体=${JSON.stringify(sentBody)}`);
      check('✕ 请求里的 session 与"这一轮所在的会话"一致',
        sentBody?.session === session, `实际 session=${JSON.stringify(sentBody?.session)}`);
      check('✕ 请求里的提问是宿主探测到的**该轮**提问（面板不自己编词）',
        sentBody?.query === '同一句话' && sentBody?.rewrite === true && sentBody?.boost === true,
        `实际请求体=${JSON.stringify(sentBody)}`);

      const decide = globalThis.window?.__dsmTestHooks?.missActionDecide;
      check('✕ `MissAction` 的陈旧判据已导出（渲染过动作栏之后才登记）', typeof decide === 'function',
        `hooks=${Object.keys(globalThis.window?.__dsmTestHooks ?? {}).join(',')}（这里是 ${typeof decide}）`);
      check('✕ 判据：文本**不变**时也算"新问题已到"（同一句话重复提问 = 又答了一轮）',
        decide?.('同一句话', '同一句话', 2) === true,
        `decide('同一句话','同一句话',2)=${String(decide?.('同一句话', '同一句话', 2))}（旧写法这里是 false，正是那个回归）`);
      check('✕ 判据：文本变了 → 清（正常路径不受影响）',
        decide?.('下一句', '上一句', 1) === true, `decide=${String(decide?.('下一句', '上一句', 1))}`);
      check('✕ 判据：还没认清"这一轮问的是什么"（挂载时为空）→ 先不动',
        decide?.('第一句', null, 1) === false, `decide=${String(decide?.('第一句', null, 1))}`);
      check('✕ 判据：读不到提问（空串）→ 不动（不能凭空调掉用户刚看到的结果）',
        decide?.('', '上一句', 2) === null, `decide=${String(decide?.('', '上一句', 2))}`);
      check('✕ 判据：只是同一次探测重复执行（文本不变、次数仍为 1）→ 不误清',
        decide?.('同一句话', '同一句话', 1) === false,
        `decide=${String(decide?.('同一句话', '同一句话', 1))}（误清会把刚显示的结果立刻抹掉）`);
      hooks.resetMiss?.(session);
    } finally {
      globalThis.fetch = originalFetch;
      hooks.resetMiss?.(session);
    }
  }
}
/* ── 断言：桩 React 的依赖数组语义 + useRef 跨渲染复用（2026-10-08）──────────
 * 这里量的是**桩本身**的行为（不是面板文案）：依赖不变 → effect 不重跑；
 * 依赖变了 → 先跑上一轮的 cleanup 再跑新的；useRef 同一个槽位返回同一个对象。
 * 这三条正是"effect 依赖写错"能被测出来的前提 —— 桩不尊重依赖数组时，
 * 真机上"该跑一次的跑了十次"和"该重跑的没重跑"在测试里都看不见。 */
{
  const key = `depsProbe<${process.pid}>`;
  /** 一次"渲染"：依赖值完全由外部传入（`useState` 只负责占一个槽位，不参与依赖）。 */
  const probe = (dep) => {
    ReactStub.useState('x');
    ReactStub.useEffect(() => () => { /* cleanup 的真实次数由桩自己计数 */ }, [dep]);
    return ReactStub.useRef({ slot: 'stable' });
  };
  currentComponent = key;
  hookIndex = 0;
  effectCounter.reset();
  const ref1 = probe('a');
  hookIndex = 0;
  const ref2 = probe('a');
  check('依赖不变 → effect 不重跑（桩真的在看依赖数组）',
    effectRuns === 1, `effect 跑了 ${effectRuns} 次`);
  check('依赖不变 → cleanup 也不跑', effectCleanups === 0, `cleanup 跑了 ${effectCleanups} 次`);
  check('useRef 跨渲染返回同一个对象（每次新建会让"只在首次渲染记一个值"的组件每帧重置）',
    ref1 === ref2, `same=${ref1 === ref2}`);
  hookIndex = 0;
  probe('b');
  check('依赖变了 → 先跑 cleanup 再跑新的 effect', effectRuns === 2 && effectCleanups === 1,
    `effect=${effectRuns} cleanup=${effectCleanups}`);
  hookIndex = 0;
  const ref3 = probe('b');
  check('useRef 仍复用同一个槽位对象（值不因渲染重建而换）', ref3 === ref1);
  // 清掉探针槽位，免得影响后面的渲染
  for (const storedKey of [...hookStore.keys()]) if (storedKey.startsWith(key)) hookStore.delete(storedKey);
}

/* ── 断言：控件 ↔ 设置键的绑定（这才是抓"开关接到错的键"的守卫）──────────────
 * 桩数据里**种入与默认值不同**的取值（true↔false 互换、数字换成别的合法值、
 * 下拉换成另一档），再逐项断言"控件拿到的值 === `effective(对应键)`"。
 *   · 覆盖 5 个开关（布尔，含 true/false 两种）、3 个数字框、1 个文本框、1 个下拉；
 *   · 判据是**值**不是文案：把某个控件的键名改成另一个键（临时），值就会等于那个键的
 *     取值，下面必然有一条对上不 → 红。 */
{
  const originalValue = settingsPayload.value;
  const originalSettings = originalValue.settings;
  const seeded = {
    ...originalSettings,
    // 开关：与默认值相反，证明"读的是这个键"而不是"恰好等于默认值"
    ingestSummary: false,
    ingestRawText: true,
    injectRecap: false,
    // 数字框：换成别的合法值
    minScore: 0.42,
    observationTurns: 5,
    maxRawCharsPerCompaction: 123456,
    // 文本框 / 下拉
    toolResultNames: 'read, grep',
    // 下拉：种 custom 档（这样「使用方式 / 提供方 / 模型」三个下拉都会渲染出来），
    // 值都与默认不同 → 绑错键必然对不上。
    llmMode: 'custom',
    llmProvider: 'seeded-provider',
    llmModel: 'seeded-model',
    llmAssistEnabled: true,
  };
  settingsPayload.value = { ...originalValue, settings: seeded };
  await render(true, true);
  settingsPayload.value = originalValue;

  const expected = [
    // [标签, 键, 控件类型] —— 键名就是"这个控件应该绑到哪"
    ['存摘要', 'ingestSummary', 'toggle'],
    ['存原文', 'ingestRawText', 'toggle'],
    ['压缩后注入总览', 'injectRecap', 'toggle'],
    ['命中阈值', 'minScore', 'number'],
    ['查询携带最近几条提问', 'observationTurns', 'number'],
    ['单次压缩原文上限', 'maxRawCharsPerCompaction', 'number'],
    ['收哪些工具', 'toolResultNames', 'text'],
    ['使用方式', 'llmMode', 'select'],
    ['提供方', 'llmProvider', 'select'],
    ['模型', 'llmModel', 'select'],
  ];
  // 前提：每个标签都真的被采集到了（没采集到就看不见，等于这条断言形同虚设）
  const missing = expected.filter(([label]) => controlByLabel(label) === null).map(([label]) => label);
  check(`控件审计采集到了 ${expected.length} 个控件（含开关/数字框/文本框/下拉）`,
    missing.length === 0, `没采集到：${missing.join('、')}；实际采集 ${controls.audit.length} 个：${[...new Set(controls.audit.map((c) => c.label))].join('、')}`);
  for (const [label, key, kind] of expected) {
    const control = controlByLabel(label);
    const want = String(seeded[key]);
    check(`「${label}」的值 = effective('${key}')（${kind}）`,
      control !== null && String(control.value) === want && control.kind === kind,
      `控件=${JSON.stringify(control)} 期望值=${want}`);
  }
  // 反向守卫：开关类控件的取值必须**两种都出现**（全 true / 全 false 说明绑到了同一个键）
  const toggles = expected.filter(([, , kind]) => kind === 'toggle')
    .map(([label]) => controlByLabel(label)?.value);
  check('三个开关的取值没有全都一样（否则说明它们读到的是同一个键）',
    new Set(toggles.map(String)).size > 1, JSON.stringify(toggles));
}

console.log(`\n通过 ${passed} 条，失败 ${failures} 条。`);

/* ── 断言：删除回执里的「摘抄已被 git 跟踪」提示（2026-10-08）────────────────
 * `/delete` 的回执早就带 `excerptGit.tracked`，但面板从来没消费它 —— 用户删完
 * 以为干净了，而 git 索引里还躺着一份逐字问答摘抄（`.gitignore` 对已跟踪文件无效）。
 * 这里真点一遍「删除 → 确认删除」，断言 tracked=true 时出现那句 `git rm --cached`、
 * tracked=false 时不出现。**能失败的验证**：把 client.js 里那段提示删掉 → 第一条红；
 * 无条件拼上那句 → 第二条红。 */
{
  const clickable = (node, out = []) => {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const item of node) clickable(item, out); return out; }
    if (node.type === 'button' && typeof node.props?.onClick === 'function') out.push(node);
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) clickable(child, out);
    return out;
  };
  const findButton = (node, needle) => clickable(node).find((item) => textOf(item.props.children).includes(needle)) ?? null;
  /** 找删除按钮：**按类名**找（danger = 删除类操作），比按文案稳（受保护时会加 title）。 */
  const findDangerButton = (node) => clickable(node).find((item) => String(item.props.className ?? '').includes('dsm-btn-danger')) ?? null;
  /** 点一次「删除 → 确认删除」，返回提示文本与抓到的请求。 */
  const deleteWith = async (tracked) => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url);
      calls.push(`${options.method ?? 'GET'} ${target}`);
      if (target.includes('/delete')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            value: {
              deleted: 3, remaining: 0, trashId: 't1', trashed: true, excerpts: 2,
              excerptGit: { excerptDir: 'E:\\w\\.dsh-compaction-memory\\_readable\\excerpts', tracked },
            },
          }),
        };
      }
      const body = target.includes('/overview') ? overviewPayload
        : target.includes('/settings') ? settingsPayload
          : { ok: true, value: {} };
      return { ok: true, status: 200, json: async () => body };
    };
    // ⚠️ 交互后**不能再调 `render()`**：它会把面板的 hook 槽位重置成初始值
    // （`confirmDelete` / `notice` 一起被清掉），于是"点了删除但确认卡不出现"。
    // 这里用一个只做"渲染 + 让 effect 落地"的轻量步进器，模拟 React 的
    // render → commit → effect 循环。
    const step = async (times = 4) => {
      hookIndex = 0;
      currentComponent = 'root';
      pendingUpdate = false;
      const out = resolveTree(renderPanel({}));
      for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      return out;
    };
    await render(false, true);
    findDangerButton(await step())?.props.onClick();
    findButton(await step(), '确认删除')?.props.onClick();
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const finalTree = await step();
    return { text: textOf(finalTree), calls };
  };
  const trackedResult = await deleteWith(true);
  check('删除真的走到了 POST /delete（前提成立）',
    trackedResult.calls.some((line) => line.startsWith('POST') && line.includes('/delete')),
    trackedResult.calls.join(' | '));
  check('tracked=true → 提示里出现「已被 git 跟踪」与 git rm --cached',
    trackedResult.text.includes('已被 git 跟踪') && trackedResult.text.includes('git rm --cached'),
    `实际提示：${(trackedResult.text.match(/已删除[^。]*/) ?? ['(没渲染)'])[0].slice(0, 200)}`);
  const untrackedResult = await deleteWith(false);
  check('tracked=false → 不出现这句提示（不能无条件拼）',
    !untrackedResult.text.includes('git rm --cached'),
    `实际提示：${(untrackedResult.text.match(/已删除[^。]*/) ?? ['(没渲染)'])[0].slice(0, 200)}`);
}

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
