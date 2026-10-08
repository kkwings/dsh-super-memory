/**
 * 面板静态自检：不启动浏览器，靠交叉比对抓"点开面板才会发现的错"。
 *   ① client.js 里读写过的设置键，必须都在 config.js 的 DEFAULTS 与 EDITABLE_FIELDS 里
 *   ② client.js 里用到的 .dsm-* 类名，必须在同文件的 CSS 里定义（反向报告未使用的类）
 *   ③ client.js 请求过的 /api 路径，必须在 routes.js 里有对应分支
 *   ④ 面板里出现的三个功能板块编号是否齐全
 * 用法：node scripts/panel-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '..', 'lib');
const client = fs.readFileSync(path.join(lib, 'client.js'), 'utf8');
const config = fs.readFileSync(path.join(lib, 'config.js'), 'utf8');
const routes = fs.readFileSync(path.join(lib, 'routes.js'), 'utf8');

let problems = 0;
const fail = (msg) => { problems += 1; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const checkEq = (label, actual, expected) => {
  if (actual === expected) { ok(label); return; }
  fail(`${label} —— 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
};

/* ④ 会话内按钮的 TDZ 防线（实测踩过，且 node --check / 渲染自检都抓不到）
 *
 * 背景：✕ 按钮的 onClick 引用了 `run`。当 `run` 写成 `const run = async () => {}` 且定义在
 * onClick **之后**时，点击会抛 "Cannot access 'run' before initialization" —— 抛在事件回调里、
 * 不在 try/catch 范围内，于是**完全静默**：用户看到的就是"点了没反应"。
 * 唯一可靠的预防是让 `run` 保持**函数声明**（会提升），所以在这里钉死。
 */
console.log('\n④ 会话内按钮：run 必须是提升的函数声明（防 TDZ 静默失效）');
if (/async function run\(/.test(client)) {
  ok('run 是函数声明（会被提升），onClick 提前引用也安全');
} else {
  fail('run 不是函数声明 —— 若用 `const run = …` 且 onClick 在它之前，点击会抛 TDZ 错误且被静默吞掉');
}
if (/const run = async/.test(client)) {
  fail('发现 `const run = async`：会与上面的早返回分支形成 TDZ 陷阱');
}

/* ① 设置键 */
console.log('\n① 设置键（client.js ↔ config.js）');
const { DEFAULTS, EDITABLE_FIELDS } = await import('../lib/config.js');
const known = new Set(Object.keys(DEFAULTS));
const editable = new Set(EDITABLE_FIELDS);

/**
 * 剥掉 JS 注释（行注释与块注释两种写法），**保留字符串字面量与模板字面量**。
 *
 * 为什么必须有（2026-10-08 修的真缺陷）：`usedKeys` 原来是对**整份源码**跑
 * `/effective\(\s*'([A-Za-z0-9_]+)'/g`，于是**注释里**写过的键也算"面板用到的键"。
 * 当时统计出来的 41 个键里有 1 个假阳性：`llmAssistEnabled` —— 它只出现在 client.js
 * 第 600 行那句注释（"这里原先是 effective('llmAssistEnabled', false) === true"）里，
 * 面板早就不读它了。后果是报告数字虚高，且"注释里写什么键都不报警"＝这类检查永远发现不了
 * "注释与实际代码不一致"。
 *
 * 字符串不能被误伤：字符串字面量与模板字面量里出现的注释符号必须原样保留 ——
 * 所以这里是一个**最小词法扫描**，不是正则替换。
 * 代价（可接受）：区分不了正则字面量；本文件里没有任何"含注释符号的正则字面量"。
 * @param {string} source - 源码。
 * @returns {string} 注释已替换为空白的源码（保留换行，行号不变）。
 */
function stripComments(source) {
  const s = String(source ?? '');
  let out = '';
  let i = 0;
  let quote = null; // 当前字符串引号：' " 或 `
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') out += '\n'; i += 1; }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
// 自检（**能失败**）：把 stripComments 换回"原样返回"，下面第 1/2 条立刻红。
{
  checkEq('stripComments 去掉行注释', stripComments("a; // effective('x')\nb;"), 'a; \nb;');
  checkEq('stripComments 去掉块注释（保留换行、不留字符）', stripComments("a; /* effective('x')\n effective('y') */ b;"), 'a; \n b;');
  checkEq('stripComments 不误伤字符串里的注释符号', stripComments("const u = 'http://x'; const v = '/* 不是注释 */';"),
    "const u = 'http://x'; const v = '/* 不是注释 */';");
  checkEq('stripComments 不误伤模板字面量', stripComments('const t = `a // b`;'), 'const t = `a // b`;');
  checkEq('stripComments 不误伤字符串里的转义引号', stripComments("const q = 'it\\'s // fine';"), "const q = 'it\\'s // fine';");
}
const clientCode = stripComments(client);
const usedKeys = new Set();
for (const m of clientCode.matchAll(/effective\(\s*'([A-Za-z0-9_]+)'/g)) usedKeys.add(m[1]);

/**
 * 取出 `client.js` 里所有 `patch({ … })` 的**全部**键名（含跨行 / 多键）。
 *
 * 2026-10-08 改：原先是 `client.matchAll(/patch\(\s*\{\s*([A-Za-z0-9_]+)/g)` ——
 * **只抓第一个键**。今天 40 个调用点恰好都是单键，所以它看起来是对的；但只要有人写成
 * `patch({ minScore: v, maxItems: n })`，第二个键就完全不检查 —— 一个"面板改不动"的
 * 键（不在 EDITABLE_FIELDS 里）会被静默放行，用户点了没反应且没有任何提示。
 * 这里改成"定位 `patch({` → 花括号配对 → 取对象体内所有 `键:`"。
 * @param {string} source - client.js 源码。
 * @returns {Set<string>} 键名集合。
 */
function patchKeys(source) {
  const keys = new Set();
  const re = /patch\(\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let body = '';
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      body += ch;
    }
    for (const hit of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.add(hit[1]);
    re.lastIndex = i + 1;
  }
  return keys;
}
// 自检（**能失败**）：把上面换回"只抓第一个键"的正则，这一条立刻红。
// 用途：client.js 目前所有 patch({…}) 都是单键，"漏抓多键"这个 bug 在真实源码上看不出来。
{
  const multi = patchKeys('patch({ a: 1, b: two,\n  c: three, })');
  if (multi.size !== 3 || !multi.has('b') || !multi.has('c')) {
    fail(`patchKeys 抓不到 patch({…}) 里的全部键（抓到：${[...multi].join(',') || '空'}）—— 面板键检查会漏检多键调用`);
  } else {
    ok('patchKeys 能抓到 patch({…}) 的全部键（含跨行、多键）');
  }
}
for (const key of patchKeys(clientCode)) usedKeys.add(key);
const unknown = [...usedKeys].filter((k) => !known.has(k));
const blocked = [...usedKeys].filter((k) => known.has(k) && !editable.has(k));
console.log(`  面板用到 ${usedKeys.size} 个键：${[...usedKeys].sort().join(', ')}`);
if (unknown.length > 0) fail(`DEFAULTS 里没有这些键：${unknown.join(', ')}`);
if (blocked.length > 0) fail(`这些键不在 EDITABLE_FIELDS（面板改不动）：${blocked.join(', ')}`);
if (unknown.length === 0 && blocked.length === 0) ok('全部键都存在且可编辑');
const defaulted = [...known].filter((k) => editable.has(k));
const notInPanel = defaulted.filter((k) => !usedKeys.has(k));
if (notInPanel.length > 0) console.log(`  · 可编辑但面板没暴露（可能是刻意留的）：${notInPanel.join(', ')}`);

/* ② CSS 类 */
console.log('\n② CSS 类（h(...) 用到 ↔ CSS 里定义）');
// 同样在**剥掉注释之后**的源码上做：注释里写过的 `dsm-*` 不该算"用到"（会掩盖死样式）。
const cssStart = clientCode.indexOf('const CSS = `');
const cssEnd = clientCode.indexOf('`;', cssStart);
const css = clientCode.slice(cssStart, cssEnd);
const code = clientCode.slice(0, cssStart) + clientCode.slice(cssEnd);
const defined = new Set([...css.matchAll(/\.(dsm-[a-z0-9-]+)/g)].map((m) => m[1]));
// 用到的地方不止 className：也有 'dsm-cost dsm-cost-free' 这种拼在变量里的。
const used = new Set([...code.matchAll(/(dsm-[a-z0-9-]+)/g)].map((m) => m[1]));
const missing = [...used].filter((c) => !defined.has(c));
const unused = [...defined].filter((c) => !used.has(c));
console.log(`  CSS 定义 ${defined.size} 个类 / 代码用到 ${used.size} 个`);
if (missing.length > 0) fail(`用到但没定义（会没有样式）：${missing.join(', ')}`);
if (unused.length > 0) fail(`定义了但没用到（死样式，建议删）：${unused.join(', ')}`);
if (missing.length === 0 && unused.length === 0) ok('类名双向一致');

/* ③ API 路径 */
console.log('\n③ API 路径（client.js ↔ routes.js）');
// 同样剥注释：注释里提到的路径不该算"客户端请求了它"。
const paths = new Set([...clientCode.matchAll(/\bapi\(\s*[`']([^`'?${]+)/g)].map((m) => m[1].trim()));
const declared = new Set([...routes.matchAll(/'(\/api\/dsh-super-memory\/[a-z/-]*?)'/g)].map((m) => m[1]));
const missingPaths = [...paths].filter((p) => !declared.has(`/api/dsh-super-memory${p}`));
console.log(`  客户端请求 ${paths.size} 条：${[...paths].sort().join(', ')}`);
if (missingPaths.length > 0) fail(`路由里找不到：${missingPaths.join(', ')}`);
if (missingPaths.length === 0) ok('请求的路径在 routes.js 里都有分支');

/* ④ 三板块编号 */
console.log('\n④ 功能板块');
for (const no of ['①', '②', '③']) {
  if (clientCode.includes(`no: '${no}'`)) ok(`板块 ${no} 在位`);
  else fail(`缺少板块 ${no}`);
}

/* ⑤ 源码级回归：数字框精度
 * 曾经真实出过的 bug：NumberRow 无条件 Math.floor(parsed)，于是「命中阈值 0.28」只要点进
 * 输入框再点走就被抹成 0（阈值归零 → 命中判定形同关闭，几乎每轮都注入）。
 *
 * 守卫的**本意**是"凡是小数型设置，面板必须声明 step"——所以断言写法是"每个小数项都在"，
 * 而不是钉死某一个键：2026-10-07 删掉了另一个小数项（会话累计上限 0.02 / step 0.005），
 * 这里跟着改成只要求当前仅剩的小数项 `minScore`（step 0.01）。将来再加小数项，请把它的
 * step 一并加进下面的清单——**不要**把这条断言删掉或改成恒真。 */
console.log('\n⑤ 数字框精度（源码级回归守卫）');
const numberRowSrc = clientCode.slice(clientCode.indexOf('function NumberRow'), clientCode.indexOf('function Card'));
const DECIMAL_FIELDS = [
  { key: 'minScore', step: 'step: 0.01' },
];
const missingStep = DECIMAL_FIELDS.filter((item) => !clientCode.includes(item.step));
if (/let next = Math\.floor\(parsed\)/.test(numberRowSrc)) {
  fail('NumberRow 仍在无条件取整（0.28 会被抹成 0）');
} else if (!/decimalsOf\(|toFixed\(/.test(numberRowSrc)) {
  fail('NumberRow 没有按 step 处理小数');
} else if (missingStep.length > 0) {
  fail(`小数参数没有声明 step：${missingStep.map((item) => `${item.key} 需要 ${item.step}`).join('、')}`);
} else {
  ok(`NumberRow 按 step 保留小数，${DECIMAL_FIELDS.length} 个小数参数都声明了 step（${DECIMAL_FIELDS.map((item) => item.key).join('、')}）`);
}

console.log(problems === 0 ? '\n全部通过。\n' : `\n发现 ${problems} 处问题。\n`);
process.exit(problems === 0 ? 0 : 1);
