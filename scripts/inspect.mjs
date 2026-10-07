/**
 * 验收证据导出：读某个工作区的记忆库，打印条目统计、总览预览、命中抽查与最近打分日志。
 * 只读，不写任何东西。
 *
 * 用法：
 *   node scripts/inspect.mjs [workspace] [query]
 * 例：
 *   node scripts/inspect.mjs "<工作区绝对路径>" "早前定过的某个结论"
 */
import fs from 'node:fs';
import path from 'node:path';

const workspace = process.argv[2] ?? process.cwd();
const query = process.argv[3] ?? '';

const { storeRoot, listSessionFiles, readRecords } = await import('../lib/store.js');
const { MemoryIndex, retrieveTwoTier } = await import('../lib/retrieval.js');
const { buildRecap } = await import('../lib/recap.js');
const { formatRecall } = await import('../lib/recall.js');
// 诊断日志的路径**必须与生产代码同源**（`lib/config.js`）：用户可以用
// DSH_SUPER_MEMORY_HOME 把全局数据目录挪到别的盘（例：E:\DSH-data\dsh-super-memory），
// 这里若自己拼 `$DSH_HOME/...`，在那种机器上就永远打印"（没有诊断日志）"，
// 而面板 ⑥ 读得到 —— 排查时最容易被这个假象带偏。
const { dataHomeInfo, defaultDiagPath } = await import('../lib/config.js');

const root = storeRoot(workspace, '.dsh-compaction-memory');
console.log(`工作区: ${workspace}`);
console.log(`记忆库: ${root}  存在=${fs.existsSync(root)}`);
if (!fs.existsSync(root)) process.exit(0);

const files = listSessionFiles(root);
let totalBlocks = 0;
let totalBytes = 0;
console.log(`\n=== 会话（${files.length} 个）===`);
for (const file of files) {
  const records = readRecords(root, file.sessionId);
  const summary = records.filter((r) => r.layer === 'summary').length;
  const raw = records.filter((r) => r.layer === 'raw').length;
  const chars = records.reduce((sum, r) => sum + String(r.text ?? '').length, 0);
  const latest = records.reduce((max, r) => Math.max(max, Date.parse(r.at ?? '') || 0), 0);
  totalBlocks += records.length;
  totalBytes += file.bytes;
  console.log(`  ${file.sessionId}`);
  console.log(`    L1 ${summary} 块 / L2 ${raw} 块 / ${chars} 字符 / ${file.bytes} B / 更新 ${latest ? new Date(latest).toISOString() : '—'}`);
  const noise = records.filter((r) => r.text.includes('"type":"reasoning"') || r.text.includes('\u27e6mem-hist\u27e7'));
  console.log(`    含思考痕迹或自身注入标记的条目: ${noise.length}（应为 0）`);
}
console.log(`合计 ${totalBlocks} 块 / ${totalBytes} B`);

const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
const trashDir = path.join(root, '_trash');
const trashCount = fs.existsSync(trashDir) ? fs.readdirSync(trashDir).length : 0;
console.log(`回收站条目: ${trashCount}`);

/* 总览预览（最大的那个会话） */
const biggest = files.map((f) => ({ f, records: readRecords(root, f.sessionId) }))
  .sort((a, b) => b.records.length - a.records.length)[0];
if (biggest !== undefined) {
  const recap = buildRecap(biggest.records, { maxTokens: 300 });
  console.log(`\n=== 压缩后总览预览（会话 ${biggest.f.sessionId}，上限 300 token）===`);
  console.log(recap.text === '' ? '（无可留结论 → 完全不注入，0 token）' : recap.text);
  console.log(`—— ${recap.tokens} token / ${recap.lines} 行 / ${recap.text.length} 字符`);

  if (query !== '') {
    const index = new MemoryIndex(biggest.records);
    const found = retrieveTwoTier(index, query, { minScore: 0.28, maxItems: 2, preferSummaryChunks: true });
    const built = formatRecall(found.hits, { maxItems: 2, maxCharsPerItem: 300, maxTokensPerTurn: 500 });
    console.log(`\n=== 试检索「${query}」===`);
    console.log(`tier=${found.tier}  L1 top=${found.summaryTop.toFixed(3)}  L2 top=${found.rawTop.toFixed(3)}`);
    console.log(built.text === '' ? '（未命中 → 不注入，0 token）' : `${built.text}\n—— ${built.tokens} token / ${built.items} 条 / ${built.text.length} 字符`);
  }
}

/* 诊断日志（路径与生产代码同源：DSH_SUPER_MEMORY_HOME > $DSH_HOME > ~/.dsh） */
const diagPath = defaultDiagPath();
const home = dataHomeInfo();
console.log(`\n=== 打分日志（最近 12 条，${diagPath}；数据目录来源=${home.source}）===`);
if (fs.existsSync(diagPath)) {
  for (const line of fs.readFileSync(diagPath, 'utf8').split('\n').filter(Boolean).slice(-12)) {
    const entry = JSON.parse(line);
    if (entry.event === 'recall') {
      console.log(`  hit=${entry.hit} reason=${entry.reason} top=${entry.topScore} chars=${entry.injectedChars} est=${entry.injectedTokensEst} cum=${entry.sessionInjectedTokensEst} Q=${String(entry.queryHead).slice(0, 26)}`);
    } else if (entry.event === 'ingest') {
      console.log(`  [ingest/${entry.source}] ${String(entry.compactionId).slice(0, 8)} L1=${entry.layer?.summary} L2=${entry.layer?.raw} rawChars=${entry.rawChars} 模型调用=${entry.modelCalls}`);
    } else {
      console.log(`  [${entry.event}] ${JSON.stringify(entry).slice(0, 120)}`);
    }
  }
} else {
  console.log('  （没有诊断日志）');
}
