# dsh-super-memory（超级记忆）

**跨压缩记忆**插件：在**同一个超长会话**里聊到被上下文压缩过几次之后，你提到更早（已被压掉）问过 / 定过的事时，模型**先看到**它，并**作为参考**结合这次的新条件综合分析——不会当新问题从零重来。

> 它只做「跨压缩」，不做跨会话；自包含，**不依赖任何其他记忆插件**。

## 三件事

| # | 时机 | 做什么 | 成本 |
| --- | --- | --- | --- |
| ① | **压缩时** | 把这次被压掉的内容**本地入库**：L1 摘要块（用 DSH 已生成好的摘要）+ L2 对话原文块（只留用户问题与助手回答的文字） | **0 模型调用** |
| ② | **压缩后** | 注入一份**目录级「本会话此前脉络」**（话题 — 结论），让新窗口一开场就知道过去聊过哪几大块 | ≤ **300 token**，自适应，**可为 0** |
| ③ | **提问时** | 每次提问先在本地词法检索这个库，**命中才注入**参考 | 命中 ≤ **500 token**（≤2 条、每条 ≤300 字符）；**未命中 0 token** |

**原文只在用户明确要求时**才由 `history_read` 工具读取（例如「把当时那段原文调出来」），日常不会自动展开。

## 数据落在哪里

**记忆本体一律放在会话所属工作区内**（Windows 上就是 `<工作区>\.dsh-compaction-memory\`），
不同项目天然隔离，不占用系统盘：

```
<workspace>/.dsh-compaction-memory/
  <sessionId>.jsonl        该会话的压缩记忆（一行一条块）
  _trash/<时间>_<会话>/    回收站（blocks.jsonl + manifest.json）
  _audit.jsonl             删除 / 还原 / 清空的审计
```

**只有两个全局文件**放在"全局数据目录"里，默认是 `$DSH_HOME`（默认 `~/.dsh`）。
不想让它落在系统盘？设一个环境变量指到任意目录即可（例：`setx DSH_SUPER_MEMORY_HOME "E:\DSH-data\dsh-super-memory"`，然后重启 DSH）：

| 文件 | 大小 | 为什么是全局的 |
| --- | --- | --- |
| `dsh-super-memory.settings.json` | <1 KB | 设置跨工作区生效，还存着面板登记的已知工作区列表 |
| `dsh-super-memory.diag.jsonl` | 上限 4000 行（超了自动压缩） | 打分日志横跨所有会话，排障要看全局 |

装载回执等调试输出都写进上面这个诊断日志，**不再另开文件**。面板 ⑥ 里会显示当前解析到的
全局数据目录及其来源（环境变量 / 默认），一眼能看出有没有落在系统盘。
**记忆目录**可以在面板 ⑥「记忆目录」里直接改：填相对路径 = 每个工作区各自一份（默认），
填绝对路径 = 所有工作区集中存到一个目录（例如 `D:\dsh-memory`）。改完对**新写入**生效，
已有记忆不会自己搬家（想搬就手动剪切那个目录）。

（建议把 `.dsh-compaction-memory` 加进项目的 `.gitignore`，可选。）

**安全边界**：本插件只操作自己 `storeDir` 内的文件（路径规范化 + 穿越校验），**绝不触碰** DSH 原始会话日志 `~/.dsh/sessions/**`——删除记忆不会动到会话本体。

## 设置面板「超级记忆」

面板按**插件实际做的三件事**分板块，每块只放跟它有关的开关与参数，块标题旁直接标出**这块花不花 token**；
最上面是一张「30 秒读懂」卡（做什么、成本、边界），最下面是两个辅助板块。

| 板块 | 做什么 | 成本 |
| --- | --- | --- |
| **① 压缩时：把被压掉的内容存到本地** | 摘要入库（L1）+ 原文入库（L2，只留对话文字）；显示本工作区最近一次入库 | **0 token**（只占磁盘） |
| **② 压缩后：注入一份脉络总览** | 压缩后注入目录级「本会话此前脉络」；可调总览上限、是否在窗口内保持稳定；带「预览它会注入什么」 | **≤N token / 次压缩**，可为 0 |
| **③ 提问时：检索历史，命中才参考** | 提问时本地检索：命中阈值、单轮上限、条数、每条字符、参考块保持显示、指纹去重；带「试检索」自检 | **未命中 0；命中 ≤N token / 轮** |
| **④ 被保存的压缩内容** | 编号列表：**会话标题（与 DSH 左栏一致）** + 相对时间 + 已压缩几轮 + 存了 L1/L2 各几块 + 占用；每行有「浏览 / 明细 / 删除」，另有删除保护期 | 只占磁盘 |
| **⑤ 回收站** | 编号列表：标题 + 删除于多久前 + 条数；每行「还原」（还原后回到 ④）；卡片底部是回收站设置（先进回收站 / 自动清空 / 保留天数） | 只占磁盘 |
| **⑥ 诊断与高级**（默认折叠） | 命中/未命中计数、打分日志、回填开关、查询轮数、L1/L2 优先级、会话累计上限、路径与「恢复默认设置」 | — |

**会话标题从哪来**：`$DSH_HOME/storages/session_projcache/sessions/<会话id>.json` 的 `record.rows.title.val`
——就是 DSH 侧栏显示的那一个（由 `session-title-first-prompt-llm` 生成）；取不到时退回该会话的首条提问截断，
再取不到才用记忆块标题。**同名会话**会在标题后补 8 位短码（如 `#1a2b3c4d`）以便区分。

**「浏览」怎么实现**：宿主半边新增 `POST /api/dsh-super-memory/reveal`，在系统文件管理器里定位该会话的
记忆文件（Windows `explorer /select,`、macOS `open -R`、Linux `xdg-open`）。路径必须落在插件自己的
`storeDir` 内，越界工作区一律 403。

要点：

- 顶部有一个**总开关**；关掉后 ①②③ 会整块变灰并标注「总开关已关：本块不生效」。
- 每个被注入的历史块抬头都写着「历史只作参考，不作结论；若与当前结论不同，请说明此前是 X、这次因为 Y 改为 Z」——
  所以在后续对话里把方案 A 改成方案 B 时，回答以 B 为准并解释变化，该推理推理、该联网联网，不会被旧内容绑住。
- 所有参数**改完即时生效，不需要重启**（面板 ↔ 宿主走 `/api/dsh-super-memory/*`）。

## 默认配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `injectRecap` / `injectRecall` | `true` / `true` | 两个注入开关，都关 = 零注入 |
| `ingestSummary` / `ingestRawText` | `true` / `true` | 两层入库开关，都关 = 不写盘 |
| `compactionRecapMaxTokens` | `300` | 压缩后总览 token 上限（0 = 不注入） |
| `maxTokensPerTurn` | `500` | 单轮注入上限（0 = 不注入） |
| `maxItems` | `2` | 单轮最多条数（0–5） |
| `maxCharsPerItem` | `300` | 每条最大字符 |
| `sessionBudgetRatio` | `0.02` | 会话累计注入上限（窗口比例；**0 = 关闭全部自动注入**） |
| `recapPersist` | `true` | 总览在本次压缩窗口内保持稳定（省一次上下文快照，且整段窗口都看得到）；关 = 压缩后只注入一轮 |
| `minScore` | `0.28` | 命中阈值（见下面的标定） |
| `observationTurns` | `3` | 查询拼接最近几条用户消息 |
| `preferSummaryChunks` | `true` | 先 L1 摘要块，分数不够再 L2 原文块兜底 |
| `dedupe` | `true` | 同块永不重复注入；连续两轮同话题不重复 |
| `cooldownTurns` | `1` | 同话题连续轮次的最小间隔 |
| `storeDir` | `.dsh-compaction-memory` | 相对工作区；也可填绝对路径集中存放 |
| `includeToolResults` | `false` | 默认**不存**工具调用 / 工具结果（深度思考**永不入库**，没有开关） |
| `includePrune` | `false` | 是否也记录 `compaction/prune` |
| `maxRawCharsPerCompaction` | `400000` | 单次压缩 L2 入库字符上限（超出均匀抽样） |
| `backfillOnStart` | `true` | 插件中途装上时，把本会话已有压缩补进库（0 token） |
| `trashEnabled` | `true` | 删除先进回收站 |
| `protectRecentDays` | `7` | 删除保护期天数（0 = 不保护，需警告确认） |
| `trashAutoPurgeEnabled` / `trashAutoPurgeDays` | `true` / `7` | 回收站自动清空开关与天数（≥1） |
| `logScores` | `true` | 写打分日志 |

### `minScore` 的标定

用真实会话（3.8 MB / 5388 事件 / 2 次压缩 / 404K+308K token 被压掉）实测：

| 查询类型 | L1 摘要块 top 分 | L2 原文块 top 分 |
| --- | --- | --- |
| 与已压缩内容相关的历史问题（12 条抽样） | 0.02 – 0.48 | **0.72 – 1.50** |
| 完全不相关的问题（3 条） | 0.00 – 0.07 | 0.07 – 0.14 |

两者分得很开，**默认 0.28** 落在中间偏保守的一侧。跑几天后可以看「诊断 → 打分日志」里 `hit:false reason=below-threshold/...` 的 `topScore` 分布，漏召多就往下调。

## 安装 / 卸载

支持 DSH **0.1.7-rc.2 与 0.2.0-rc.1 及以上**（见 `package.json` 的 `peerDependencies`；已在 0.2.0-rc.2 客户端实测）。

**方式一：插件市场**——在 DSH 里打开插件市场搜 `dsh-super-memory` 直接装（若你的版本带市场）。

**方式二：让 DSH 自己装**（把 `<本机插件目录>` 换成你 clone / 解压出来的路径）：

```
plugin_manager  action: install_bundle  target: <本机插件目录>
```

**方式三：从 npm 装**（已发布时）：

```
plugin_manager  action: install_bundle  target: dsh-super-memory
```

装完**重启 DSH 客户端**：宿主插件代码在进程里缓存，不重启不会生效。重启后在
「设置 → 超级记忆」能看到分节、工具列表里出现 `history_read` 即为成功。

**方式四：桌面端 CLI**（路径按你自己的安装位置改；`$DSH_HOME` 默认是 `~/.dsh`）：

```powershell
$exe = '<DSH 安装目录>\DeepSeek Harness.exe'
$cli = '<DSH 安装目录>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$env:ELECTRON_RUN_AS_NODE = '1'
& $exe $cli plugin --profile desktop add '<本机插件目录>' 2>&1 | Out-String -Width 200
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

> Windows 上有个坑：必须把输出接给 cmdlet（`2>&1 | Out-String`），否则 PowerShell 不等这个
> GUI 子系统的 exe，命令看着"秒退"。

卸载：`& $exe $cli plugin --profile desktop remove 'dsh-super-memory'`。
卸载**不会**自动删除工作区里的 `.dsh-compaction-memory` 与全局目录下的两个文件，需要手动清理
（数据位置见上一节）。

## 自检脚本

需要 **Node ≥ 22.15**（原始会话日志是多帧 zstd，用到 `zstdDecompressSync`；低版本跑自检脚本会直接报"不支持 zstd"）。
DSH 自带的 node 在 `<DSH 安装目录>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe`，
系统里装了新版 node 也可以直接 `node`。

**`npm test` 会真的报错**（退出码非 0），不是"打印给人看"：它跑 ① 单元测试（纯函数，含历次真实
bug 的回归检查）与 ② 面板静态自检（设置键 / CSS 类名 / API 路径 / 功能板块 / 数字框精度）。
其余脚本用真实会话日志做端到端验证：

```bash
# 0) 单元测试 + 面板自检（不需要会话日志，`npm test` 就是这两条）
node scripts/unit.mjs
node scripts/panel-check.mjs

# 1) 纯离线：用真实会话日志跑通「压缩入库 → 检索 → 总览 → 注入样例」+ minScore 标定表
node scripts/selftest.mjs <session.v4.jsonl.zstd>

# 2) 宿主半边联调：假 cordis ctx + 真实日志，跑通入库/总览/命中/未命中/开关/面板 API/history_read
#    含 ③b 回归（inbox 事件一到即召回、同一提问落库后文本逐字不变、未命中不回退）
#    与 ④b 安全断言（写操作来源校验：无来源标记/非 JSON → 403）
node scripts/harness.mjs <session.v4.jsonl.zstd> [临时工作区]

# 3) 验收证据导出：库条目统计、总览预览、试检索命中、最近打分日志
node scripts/inspect.mjs "<工作区>" "<一个旧话题>"

# 4) 时序排障：压缩事件、投影里还剩哪些用户消息、每份运行上下文快照的字符/token
node scripts/compactions.mjs <sessionId> [fromSeq toSeq | --snap | --raw <seq>]

# 5) L2 抽取完整度审核：日志里"应当收进来的文字"vs 插件实际入库字符数
node scripts/shadow-audit.mjs <sessionId> <fromSeq> <toSeq> [插件记账的rawChars]
```

会话日志位置：`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，脚本里按帧解码；
Windows 上路径形如 `C:\Users\<你>\.dsh\sessions\...`）。

## 已知行为与限制

- **成本机制**：DSH 的运行时上下文按「快照有变化才追加一条消息」处理，所以注入块**变了**就会追加快照（内容 = 全部运行时上下文分节，通常几百字符）。本插件因此：总览在窗口内保持稳定（不churn）、命中块指纹去重、同一轮内结果稳定、未命中返回空串。这是 DSH 的既有机制，不是本插件引入的开销。
- **压缩时 0 模型调用**：入库只用 `compaction/summary` 里现成的摘要文本 + 本地字符 bigram 规则提词，不做任何模型提炼。
- **L2 兜底依赖 `shadowedRange`**：取自当前会话的事件流（`session.snapshotEvents()`），不依赖读取压缩日志文件；**取不到就不入库**（不会退化成"把整个会话当原文"）。
- **会话累计额度不会自动重置**：`sessionBudgetRatio`（默认窗口 2%）是**整个会话**的成本红线，只累加、不重置，用尽后"提问时注入"会停（压缩后总览不受此限）。面板 ⑥ 会显示「已用 X / 上限 Y」并在用尽时给出明确提示——想恢复就重启 DSH 或调大上限。
- **记忆目录在用户项目里**：如果工作区本身是 git 仓库，记忆文件（对话原文）有被提交的风险。面板 ④ 会检测到并给一个「帮我加忽略规则」按钮，把它写进该项目的 `.gitignore`。
- **总览是"目录"不是"全文"**：同一个标题只保留一条（标题在同一会话里会反复出现），新一轮的内容优先；被挤掉的早期内容仍可通过提问时的检索找回。
- **失败静默**：检索不到、插件内部出错都不影响正常回答（全部路径都包了 try/catch，只写诊断日志）。
- 检索只用**纯本地词法**（BM25 + 中文字符 bigram），不引入任何模型依赖；查询改写 / 本地向量检索属于未实现的路线图，**没有对应的配置项**，免得留下"改了没用"的空旋钮。
