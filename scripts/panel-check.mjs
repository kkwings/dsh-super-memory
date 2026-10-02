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

/* ① 设置键 */
console.log('\n① 设置键（client.js ↔ config.js）');
const { DEFAULTS, EDITABLE_FIELDS } = await import('../lib/config.js');
const known = new Set(Object.keys(DEFAULTS));
const editable = new Set(EDITABLE_FIELDS);
const usedKeys = new Set();
for (const m of client.matchAll(/effective\(\s*'([A-Za-z0-9_]+)'/g)) usedKeys.add(m[1]);
for (const m of client.matchAll(/patch\(\s*\{\s*([A-Za-z0-9_]+)/g)) usedKeys.add(m[1]);
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
const cssStart = client.indexOf('const CSS = `');
const cssEnd = client.indexOf('`;', cssStart);
const css = client.slice(cssStart, cssEnd);
const code = client.slice(0, cssStart) + client.slice(cssEnd);
const defined = new Set([...css.matchAll(/\.(dsm-[a-z0-9-]+)/g)].map((m) => m[1]));
// 用到的地方不止 className：也有 'dsm-cost dsm-cost-free' 这种拼在变量里的
const used = new Set([...code.matchAll(/(dsm-[a-z0-9-]+)/g)].map((m) => m[1]));
const missing = [...used].filter((c) => !defined.has(c));
const unused = [...defined].filter((c) => !used.has(c));
console.log(`  CSS 定义 ${defined.size} 个类 / 代码用到 ${used.size} 个`);
if (missing.length > 0) fail(`用到但没定义（会没有样式）：${missing.join(', ')}`);
if (unused.length > 0) fail(`定义了但没用到（死样式，建议删）：${unused.join(', ')}`);
if (missing.length === 0 && unused.length === 0) ok('类名双向一致');

/* ③ API 路径 */
console.log('\n③ API 路径（client.js ↔ routes.js）');
const paths = new Set([...client.matchAll(/\bapi\(\s*[`']([^`'?${]+)/g)].map((m) => m[1].trim()));
const declared = new Set([...routes.matchAll(/'(\/api\/dsh-super-memory\/[a-z/]*?)'/g)].map((m) => m[1]));
const missingPaths = [...paths].filter((p) => !declared.has(`/api/dsh-super-memory${p}`));
console.log(`  客户端请求 ${paths.size} 条：${[...paths].sort().join(', ')}`);
if (missingPaths.length > 0) fail(`路由里找不到：${missingPaths.join(', ')}`);
if (missingPaths.length === 0) ok('请求的路径在 routes.js 里都有分支');

/* ④ 三板块编号 */
console.log('\n④ 功能板块');
for (const no of ['①', '②', '③']) {
  if (client.includes(`no: '${no}'`)) ok(`板块 ${no} 在位`);
  else fail(`缺少板块 ${no}`);
}

console.log(problems === 0 ? '\n全部通过。\n' : `\n发现 ${problems} 处问题。\n`);
process.exit(problems === 0 ? 0 : 1);
