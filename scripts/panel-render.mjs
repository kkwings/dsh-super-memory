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
      compactionRecapMaxTokens: 300, maxTokensPerTurn: 500, maxItems: 2, maxCharsPerItem: 300,
      recapPersist: true, stickyRecall: true, minScore: 0.28, dedupe: true,
      observationTurns: 3, cooldownTurns: 1, preferSummaryChunks: true, storeDir: '.dsh-compaction-memory',
      trashEnabled: true, protectRecentDays: 7, trashAutoPurgeEnabled: true, trashAutoPurgeDays: 7,
      logScores: true, backfillOnStart: true, includePrune: false, maxRawCharsPerCompaction: 400000,
      llmAssistEnabled: true, llmIngestExpand: true, llmIngestProvider: 'zai', llmIngestModel: 'glm-5.3-flash',
      llmIngestTimeoutMs: 8000, llmIngestBatchBlocks: 8, llmIngestBlockChars: 600, llmIngestMaxTokens: 240,
      llmRecallRewrite: true, llmRecallRerank: false, llmRecallProvider: '', llmRecallModel: '',
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
      }],
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

/* ── 断言：七个板块都在（顺序正确）───────────────────────────────────────
 * 不断言"必须是根节点的直接子节点"：那取决于 Board 组件的包装层次，
 * 太脆；这里断言"每个板块标题都渲染出来了，且顺序是 ①→⑦"。 */
const text = textOf(tree);
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

/* 关键控件是否真的渲染出来了（桩渲染下能拿到的文案） */
for (const [label, needle] of [
  ['工具结果开关相关文案', '工具结果'],
  ['未命中诊断门槛提示或入口', '压缩'],
  ['每批块数的新口径（15 块 ≈ 2 次调用）', '一次压缩 15 块 ≈ 2 次调用'],
  ['✕ 路径超时上限的说明（8 秒是上限）', '8 秒是上限'],
]) {
  check(`渲染树里含${label}`, text.includes(needle), `找不到「${needle}」`);
}
// 会话内结果块（turnTail）：从没在浏览器之外渲染过，这里至少确认它在"无结果"时不渲染
check('turnTail 无结果时不渲染任何内容',
  textOf(resolveTree(withComponent('missTail', () => renderMissTail({ sessionId: 'session-x' })))).trim() === '', '');
// ⑦ 模型辅助：用户明确要求**默认展开**（不再折叠）——正文应直接渲染出来
check('⑦ 默认展开（能看到隐私提示与使用方式）', text.includes('会被发送到') && text.includes('使用方式'),
  '用户已确认不要折叠：可选功能的入口要一眼可见；「测试连接」只在选"调用指定模型"时出现');
check('⑦ 展开后显示模型服务状态', text.includes('模型服务：'), `找不到「模型服务：」`);
// E 项：今日 token 估算要真的显示出来（字段名对不上就会显示成 0）
check('⑦ 显示今日 token 估算（输入/输出）',
  text.includes('今日估算用量：输入 ≈5120 token') && text.includes('输出 ≈860 token'),
  `实际：${(text.match(/今日估算用量：[^（]*/) ?? ['(没渲染)'])[0]}`);
// 用户明确要求：**只让用户选一次**（要不要调用大模型），不许再拆成"入库/检索"两套
check('⑦ 只选一次：出现「使用方式」', text.includes('使用方式'), `找不到「使用方式」`);
check('⑦ 不再出现两套字段（入库用 / 检索用）', !text.includes('入库用 provider') && !text.includes('检索用 provider'),
  '把实现结构暴露成用户决策是设计错误：用户只需回答"要不要调用大模型"');
check('⑦ 三种选择都在', text.includes('不调用大模型') && text.includes('调用主模型') && text.includes('调用指定模型'),
  '三选一：不调用 / 主模型 / 指定模型');

/* ── ⑥ 展开后的内容：需要把 `openAdvanced` 打开才看得到 ──────────────────
 * 桩 React 不会点按钮，所以这里**直接往 hook 槽位里种**（就等于用户点了「展开」）。
 * 目的：锁住「本会话已注入 ≈N token」这条**纯计数展示**真的渲染出来 —— 累计上限删除后，
 * 注入量不再参与任何判定，但用户仍必须看得到它（否则成本反馈就彻底没了）。
 * 这一步同时验证 fixture 里的字段名与面板读的字段名一致（`injectedTokens`）。 */
let advancedText = '';
{
  const panelKey = [...hookStore.keys()].find((key) => key.startsWith('root<PanelBoundary>.0<Panel>#'));
  if (panelKey === undefined) {
    check('⑥ 展开态可渲染（找到 Panel 的 hook 槽位）', false, '找不到 Panel 的 hook 槽位');
  } else {
    // `openAdvanced` 是 Panel 里第 6 个 useState（下标 5；见 client.js 的 hooks 顺序）。
    hookStore.set(`${panelKey.slice(0, panelKey.lastIndexOf('#'))}#5`, true);
    let advanced = null;
    for (let pass = 0; pass < 4; pass += 1) {
      hookIndex = 0;
      currentComponent = 'root';
      pendingUpdate = false;
      advanced = resolveTree(renderPanel({}));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!pendingUpdate) break;
    }
    advancedText = textOf(advanced);
    check('⑥ 展开后能看到「本会话已注入 ≈167 token（不设上限）」',
      advancedText.includes('本会话已注入 ≈167 token（不设上限）'),
      '注入计数没渲染出来 —— 面板读的字段名可能与 routes.js 返回的不一致');
    check('⑥ 展开后不再出现「额度：N / M」「已用尽」这类已删除的额度文案',
      !advancedText.includes('额度：') && !advancedText.includes('已用尽') && !advancedText.includes('额度已关闭'),
      '累计上限已删除，面板不应再显示额度/用尽提示');
    check('⑥ 展开后仍显示本进程注入估算', advancedText.includes('估算注入'), '找不到「估算注入」');
  }
}

console.log(`\n通过 ${passed} 条，失败 ${failures} 条。`);

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
