/**
 * 宿主半边冒烟守卫：不启动 DSH、不需要会话日志，专抓"文件级损坏"。
 *
 * 为什么非要有它（2026-10-07 实测踩过，代价很高）：`lib/host.js` 一度被写坏成
 * UTF-16 BOM + NUL 字节的乱码，而 `npm test` **全绿** —— 因为原来那三套脚本只
 * import 了 lib 里的少数几个模块，坏掉的宿主入口根本没人碰，直到真的在 DSH 里加载才发现。
 * 这个守卫把"每个文件都是正常 UTF-8 源码、宿主入口真的能被加载"钉成硬性检查。
 *
 * 检查项：
 *   ① 完整性：`lib/` 下**每个** .js 非空、不以 UTF-8/UTF-16 BOM 开头、不含 NUL 字节
 *   ② 语法：每个 .js 都能被 `node --check` 解析（等价于语法可解析）
 *   ③ 可加载：宿主入口与关键模块能动态 import，且 lib/host.js 的导出契约正确
 *
 * 用法：node scripts/host-smoke.mjs [libDir]
 *   libDir 默认是仓库自己的 lib/。给一个"同样布局的目录"就能自证守卫会报红，例如：
 *     cp lib/*.js %TEMP%\dsm-smoke\   # 再把其中一个改成 UTF-16 BOM/
 *     node scripts/host-smoke.mjs %TEMP%\dsm-smoke
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const libDir = resolve(process.argv[2] ?? join(here, '..', 'lib'));

let passed = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
}

/** UTF-16 BOM（FF FE / FE FF）与 UTF-8 BOM（EF BB BF）。 */
function bomKind(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return 'UTF-16LE BOM (FF FE)';
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return 'UTF-16BE BOM (FE FF)';
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'UTF-8 BOM (EF BB BF)';
  return '';
}

console.log(`宿主半边冒烟守卫：libDir=${libDir}\n`);

let files = [];
try {
  files = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort();
} catch (error) {
  console.log(`  ✗ 读不到 lib 目录：${String(error?.message ?? error)}`);
  failures.push('读不到 lib 目录');
}

console.log(`① 完整性与语法（${files.length} 个 .js：非空 / 无 BOM / 无 NUL / node --check）`);
for (const name of files) {
  const path = join(libDir, name);
  let buffer = null;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    check(`${name} 可读`, false, String(error?.message ?? error));
    continue;
  }
  const size = buffer.length;
  const bom = bomKind(buffer);
  const nul = buffer.includes(0);
  const bytesOk = size > 0 && bom === '' && !nul;
  check(
    `${name}（${size} B）`,
    bytesOk,
    [size === 0 ? '文件是空的' : '', bom === '' ? '' : `带 ${bom}`, nul ? '含 NUL 字节' : ''].filter(Boolean).join('；'),
  );
  // 语法：等价于 `node --check <file>`。stdio 全部 ignore —— 不建管道，沙箱里也能跑。
  const parsed = spawnSync(process.execPath, ['--check', path], { stdio: 'ignore' });
  check(
    `${name} 语法可解析（node --check）`,
    parsed.status === 0,
    parsed.error ? `无法启动 node --check：${parsed.error.code ?? parsed.error.message}` : `退出码 ${parsed.status}`,
  );
}

console.log('\n② 可加载（动态 import）与导出契约');
const KEY_MODULES = [
  'host.js', 'routes.js', 'ingest.js', 'llm.js', 'recall.js',
  'store.js', 'config.js', 'zstd.js', 'transcript.js',
];
const loaded = new Map();
for (const name of KEY_MODULES) {
  const path = join(libDir, name);
  try {
    loaded.set(name, await import(pathToFileURL(path).href));
    check(`${name} 可被动态 import`, true);
  } catch (error) {
    check(`${name} 可被动态 import`, false, String(error?.message ?? error).slice(0, 200));
  }
}

{
  const host = loaded.get('host.js');
  check('host.js 导出 apply 函数（DSH 插件入口）', typeof host?.apply === 'function');
  check('host.js 导出 inject 数组（挂载前所需服务）', Array.isArray(host?.inject));
  check(
    'host.js 的 inject 声明了 tools/systemPrompt/webServer',
    Array.isArray(host?.inject)
      && ['tools', 'systemPrompt', 'webServer'].every((name) => host.inject.includes(name)),
    Array.isArray(host?.inject) ? `实际=${host.inject.join(',')}` : '',
  );
}

// 关键模块各自的对外函数也要在位：文件"能 import"不等于"内容没被删掉"
const CONTRACTS = [
  ['config.js', ['DEFAULTS', 'normalizeSettings', 'validatePatch', 'SettingsStore']],
  ['routes.js', ['makeRoutes']],
  ['recall.js', ['formatRecall']],
  ['store.js', ['storeRoot', 'readRecords']],
  ['zstd.js', ['readSessionEvents']],
  ['transcript.js', ['writeExcerpt']],
];
for (const [name, keys] of CONTRACTS) {
  const module = loaded.get(name);
  const missing = module === undefined ? keys : keys.filter((key) => module[key] === undefined);
  check(`${name} 导出 ${keys.join(' / ')}`, missing.length === 0, missing.length === 0 ? '' : `缺 ${missing.join(', ')}`);
}

// 已按用户决定删掉的设置键不许偷偷回来（插件不再有"思考强度"这个概念，
// 用户要调就去 DSH 官方「设置 → 模型」页调）。
for (const key of ['llmReasoningEffort']) {
  const config = loaded.get('config.js');
  check(`config.js 不再有 ${key} 设置键`, config?.DEFAULTS !== undefined && !(key in config.DEFAULTS));
  check(`config.js 的可编辑字段里也没有 ${key}`, Array.isArray(config?.EDITABLE_FIELDS) && !config.EDITABLE_FIELDS.includes(key));
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条。`);
if (failures.length > 0) {
  console.log('失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
} else {
  console.log('全部通过。');
}
