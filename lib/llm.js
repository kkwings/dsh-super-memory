/**
 * dsh-super-memory — 可选的模型辅助（唯一受支持路径：`ctx.llm`）
 *
 * 三条铁律（来自交接报告 §3 与实施方案 §12）：
 *   1. **热路径绝不调模型**：提问时的本地检索保持"零延迟、零 token"；
 *      模型只用在 ① 压缩入库时 与 ③ 用户主动点击"未命中诊断"之后。
 *   2. **不自己实现 HTTP / 不自己存密钥**：免费渠道与本地模型（Ollama / LM Studio）
 *      都由用户在 DSH 侧登记为路由，插件这边只填 `provider` + `model` 两个字符串。
 *   3. **任何失败都静默降级**：插件在模型不可用时的表现必须与"没这个功能"完全一致。
 *
 * 服务本身**不提供**重试 / 缓存 / 限流（官方 README 明说），所以这三件事都在这里做。
 * 失败按**稳定 code** 路由，绝不解析错误消息文本。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './config.js';
import { buildPagePrompt, pagePickSystem, pickAcrossPages, PAGE_PICK_MAX_TOKENS } from './diagnose.js';
import { estimateTokens } from './text.js';

/** 稳定失败码 → 人话提示 + 退避时长（毫秒）。 */
const FAILURES = {
  UNAVAILABLE: { hint: 'DSH 未提供 llm 服务（或本插件没拿到它）', cooldownMs: 0 },
  NO_ADAPTER: { hint: '提供方未注册或名字写错（检查 provider 拼写）', cooldownMs: 30 * 60_000 },
  MISSING_CREDENTIAL: { hint: '该提供方缺凭据（到 DSH 设置里配置密钥）', cooldownMs: 30 * 60_000 },
  INVALID_CREDENTIAL: { hint: '凭据格式不对', cooldownMs: 30 * 60_000 },
  AUTH: { hint: '鉴权失败', cooldownMs: 30 * 60_000 },
  RATE_LIMIT: { hint: '被限流（已自动暂停一段时间）', cooldownMs: 10 * 60_000 },
  QUOTA: { hint: '额度用尽（已自动暂停一段时间）', cooldownMs: 10 * 60_000 },
  ACCOUNT_QUOTA: { hint: '账户额度用尽（已自动暂停一段时间）', cooldownMs: 10 * 60_000 },
  CONTEXT_WINDOW_EXCEEDED: { hint: '送审内容超过该模型窗口', cooldownMs: 0 },
  TIMEOUT: { hint: '超时（已主动放弃，不影响回答）', cooldownMs: 0 },
  ABORTED: { hint: '被取消', cooldownMs: 0 },
  DAILY_CAP: { hint: '今日调用次数已达上限（次日自动恢复）', cooldownMs: 0 },
  COOLDOWN: { hint: '刚失败过，该路径暂停中', cooldownMs: 0 },
  BAD_OUTPUT: { hint: '模型输出不符合要求的格式（已丢弃，保留原值）', cooldownMs: 0 },
  NO_ROUTE: { hint: '未配置 provider/model，且读不到当前会话的主模型', cooldownMs: 0 },
  ERROR: { hint: '未预期的错误', cooldownMs: 0 },
};

/** 失败码的人话提示。 */
export function failureHint(code) {
  return FAILURES[code]?.hint ?? String(code ?? '未知失败');
}

/** 把任意异常映射成稳定 code（不解析消息文本，只看 code 字段）。 */
function codeOf(error) {
  const raw = typeof error?.code === 'string' ? error.code : '';
  return Object.hasOwn(FAILURES, raw) ? raw : 'ERROR';
}

function hash(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 今天（**本地时区**）的日期串 `YYYY-MM-DD`。
 *
 * 不能用 `toISOString()`：它按 UTC 换日，东八区用户在本地 08:00 之前会被算成"昨天"，
 * 于是"今日调用上限"在北京时间 0:00–8:00 之间用的是前一天的计数（限流窗口与用户认知不一致）。
 * @param {Function} now - 取当前时间（毫秒）。
 * @returns {string} 本地日期串。
 */
function today(now) {
  const date = new Date(now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 当日用量文件（`dsh-super-memory.llm-usage.json`）的推算：**累加**调用次数与 token 估算，
 * **跨日整体清零**（与 `date` 的重置口径一致）。
 *
 * ```json
 * { "date": "2026-10-07", "calls": 4, "inTokensEst": 5120, "outTokensEst": 860 }
 * ```
 *
 * 为什么要有 token 记账（2026-10-07 用户决定）：以前只有 `calls` 一个数字，
 * 算账得靠"字符 ÷ 4"这类换算，越传越失真；现在每次调用都用插件自己的
 * `estimateTokens` 记一笔，以后看数据就行。
 *
 * 纯函数（不碰磁盘），单独导出是为了能**真的测**：跨日重置与旧文件兼容都在这里。
 * @param {object} record - 磁盘上现有的记录（可能是旧版本写的、可能损坏）。
 * @param {string} day - 今天的本地日期串。
 * @param {number} calls - 本次新增的调用次数（通常 1）。
 * @param {number} inTokens - 本次输入 token 估算。
 * @param {number} outTokens - 本次输出 token 估算。
 * @returns {object} 要写回磁盘的新记录（token 字段为整数，调用次数 ≥ 0）。
 */
export function mergeUsage(record, day, calls, inTokens, outTokens) {
  const sameDay = record !== null && typeof record === 'object' && record.date === day;
  const num = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  return {
    date: day,
    calls: (sameDay && Number.isSafeInteger(record.calls) && record.calls > 0 ? record.calls : 0) + Math.max(0, Math.round(calls)),
    inTokensEst: (sameDay ? num(record.inTokensEst) : 0) + num(inTokens),
    outTokensEst: (sameDay ? num(record.outTokensEst) : 0) + num(outTokens),
  };
}

/**
 * 建立模型网关。
 *
 * @param {object} options - 依赖与配置。
 * @param {Function} options.getLlm - `() => llmService|null`（经 `ctx.inject(['llm'], …)` 拿到）。
 * @param {Function} options.getSettings - `() => settings`。
 * @param {object} [options.diag] - 诊断日志（可空）。
 * @param {string} options.usagePath - 每日用量文件（调用次数 + token 估算）。
 * @param {string} options.cachePath - 查询改写缓存文件。
 * @param {string} [options.tracePath] - 调用留痕文件（只有元数据，无内容）。
 * @param {Function} [options.now] - 取当前时间（测试用）。
 * @returns {object} 网关。
 */
export function createLlmGateway(options) {
  const now = options.now ?? (() => Date.now());
  const diag = options.diag ?? null;
  const llmOf = options.getLlm;
  const settingsOf = options.getSettings;

  /** 冷却截止时间（按"路径"分别记：入库扩写与检索改写互不牵连）。 */
  const cooldown = new Map();
  let lastFailure = null;
  let lastRoute = null;

  function readJson(path, fallback) {
    try {
      if (!existsSync(path)) return fallback;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : fallback;
    } catch { return fallback; }
  }

  /**
   * 今日用量（次数 + token 估算）。
   *
   * `calls` 是**日上限**的口径（`llmDailyCallCap` 只数次数）；两个 token 字段纯记账，
   * 不参与任何判定 —— 它们存在只为"以后算账看数据，不再靠字符换算"。
   */
  function usage() {
    const settings = settingsOf();
    const cap = Math.max(0, Number(settings.llmDailyCallCap) || 0);
    const record = readJson(options.usagePath, {});
    const day = today(now);
    const sameDay = record.date === day;
    const calls = sameDay && Number.isSafeInteger(record.calls) ? record.calls : 0;
    const tokens = (key) => (sameDay && Number.isFinite(record[key]) && record[key] > 0 ? Math.round(record[key]) : 0);
    return {
      date: day,
      calls,
      cap,
      remaining: cap === 0 ? 0 : Math.max(0, cap - calls),
      inTokensEst: tokens('inTokensEst'),
      outTokensEst: tokens('outTokensEst'),
    };
  }

  /**
   * 记一次调用（累加"日上限口径"的次数 + token 估算）。
   *
   * `calls` 的语义是**日上限的口径**（`llmDailyCallCap` 只数它），所以必须"一次调用 +1"。
   * token 却可能分两笔写：输入在入流前就定死了，输出要等流结束 —— 那时传 `calls: 0`
   * 只补记 token，**不重复计数**。
   *
   * 这条口径是被 `harness.mjs` 的 ㉓ 段真实抓出来的：早先把每次调用的 calls 记成 2，
   * 于是 `llmDailyCallCap: 50` 的额度提前一半用光，表现为"改写突然被 DAILY_CAP 挡掉"的假红。
   * @param {object} entry - `{calls, inTokens, outTokens}`。
   * @returns {number} 累加后的今日调用次数。
   */
  function countCall(entry = {}) {
    const record = readJson(options.usagePath, {});
    const next = mergeUsage(
      record,
      today(now),
      Number(entry.calls) || 0,
      Number(entry.inTokens) || 0,
      Number(entry.outTokens) || 0,
    );
    try {
      mkdirSync(dirname(options.usagePath), { recursive: true });
      writeFileAtomic(options.usagePath, `${JSON.stringify(next)}\n`);
    } catch (error) {
      // 落盘失败 = 计数不持久：本进程内照常累加，但重启后会回到旧值（日上限可能被突破）。
      // 属于"必须留证据"的事件，写一行诊断而不是静默吞掉。
      diag?.write?.({
        at: new Date(now()).toISOString(),
        event: 'llm-usage-write-error',
        path: options.usagePath,
        calls: next.calls,
        inTokensEst: next.inTokensEst,
        outTokensEst: next.outTokensEst,
        message: String(error?.message ?? error),
      });
    }
    return next.calls;
  }

  /** 留痕（元数据；写入失败不影响功能）。 */
  function trace(entry) {
    if (typeof options.tracePath !== 'string' || options.tracePath === '') return;
    try {
      mkdirSync(dirname(options.tracePath), { recursive: true });
      writeFileSync(options.tracePath, `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`, { encoding: 'utf8', flag: 'a' });
    } catch { /* 忽略 */ }
  }

  /** 读改写缓存。 */
  function cacheGet(key) {
    const settings = settingsOf();
    if (settings.llmCacheEnabled !== true) return null;
    const cache = readJson(options.cachePath, {});
    const hit = cache[key];
    if (hit === undefined) return null;
    if (typeof hit.at !== 'number' || now() - hit.at > 30 * 24 * 3600_000) return null;
    return Array.isArray(hit.terms) ? hit.terms : null;
  }

  /** 写改写缓存（只留最近 200 条）。 */
  function cacheSet(key, terms) {
    const settings = settingsOf();
    if (settings.llmCacheEnabled !== true) return;
    try {
      const cache = readJson(options.cachePath, {});
      cache[key] = { at: now(), terms: terms.slice(0, 20) };
      const keys = Object.keys(cache);
      if (keys.length > 200) {
        keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0));
        for (const stale of keys.slice(0, keys.length - 200)) delete cache[stale];
      }
      mkdirSync(dirname(options.cachePath), { recursive: true });
      writeFileAtomic(options.cachePath, JSON.stringify(cache));
    } catch { /* 忽略 */ }
  }

  /** 是否可用（服务在 + 该路径不在冷却里 + 没到日上限）。 */
  function check(path) {
    const settings = settingsOf();
    // 「是否允许调用」的**唯一判据**是模型档位：`off` = 一次都不调用。
    //
    // 2026-10-08 改：这里原先是 `settings.llmAssistEnabled !== true`。两个字段在**正常路径**
    // 上是同步的（`applyLlmMode` 会一起设），但设置文件可以手改 —— 实测把
    // `llmMode:'off'` 与 `llmAssistEnabled:true` 并存时，网关**真的会调用**模型，
    // 而面板按 `llmMode` 显示"不调用"：面板与宿主直接矛盾。现在两边都只认 `llmMode`，
    // 结构上不可能再不一致（`status().enabled` 与 client.js 的面板判据同源）。
    // 上游的 `llmAssistEnabled`/`llmIngestExpand`/`llmRecallRewrite` 只表达"哪个时机想调用"，
    // 不再决定"允不允许调用"。冷却 / 日上限 / 超时逻辑一律保留在下面。
    if (settings.llmMode === 'off') return { ok: false, code: 'UNAVAILABLE' };
    const llm = llmOf();
    if (llm === null || llm === undefined) return { ok: false, code: 'UNAVAILABLE' };
    const until = cooldown.get(path) ?? 0;
    if (until > now()) return { ok: false, code: 'COOLDOWN' };
    const use = usage();
    if (use.cap > 0 && use.calls >= use.cap) return { ok: false, code: 'DAILY_CAP' };
    return { ok: true, llm };
  }

  /** 记录失败：写诊断 + 按码退避。detail 尽量带上可诊断的信息（名字/码/栈首行）。 */
  function fail(path, code, detail) {
    const info = FAILURES[code] ?? FAILURES.ERROR;
    if (info.cooldownMs > 0) cooldown.set(path, now() + info.cooldownMs);
    lastFailure = { code, path, at: new Date(now()).toISOString(), detail: String(detail ?? '') };
    diag?.write?.({ event: 'llm', path, ok: false, code, hint: info.hint, detail: String(detail ?? '') });
    return { ok: false, code, hint: info.hint };
  }

  /** 把异常压成一行可诊断文本：`Name: message (code) @ 栈首行`。 */
  function describeError(error) {
    if (error === null || error === undefined) return '(无异常信息)';
    if (typeof error === 'string') return error;
    const name = typeof error.name === 'string' ? error.name : 'Error';
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : '(空 message)';
    const code = typeof error.code === 'string' ? ` [${error.code}]` : '';
    const frame = typeof error.stack === 'string' ? (error.stack.split('\n')[1] ?? '').trim() : '';
    return `${name}: ${message}${code}${frame === '' ? '' : ` @ ${frame}`}`;
  }

  /**
   * 选路：配了就用配的，没配就跟随当前会话的主模型。
   *
   * 传进来的 provider/model 是**同一对** `settings.llmProvider`/`settings.llmModel`
   * （入库扩写与检索改写/重排都用它；早先"入库/检索各配一套"的两对字段已收敛删除）。
   * 两者任一为空 → 视为"跟随主模型"，走下面的会话事件回退。
   *
   * "主模型"有三个来源，按可靠性依次回退 —— 实测有些会话**根本没有** `model/selection` 事件
   * （本机当前会话就是 0 条），只认它会让「测试连接」永远报 NO_ROUTE：
   *   ① `model/selection`（用户显式切换过模型时才有）
   *   ② `request/header` → `data.header.config.{provider, model}`（每次请求都记，最可靠）
   *   ③ `request/context` → `data.{provider, model}`
   * @param {object} session - 会话（可为 null，此时无法跟随）。
   * @param {string} provider - 配置的提供方（可为空）。
   * @param {string} model - 配置的模型（可为空）。
   * @returns {{provider:string, model:string}|null} 路由。
   */
  function resolveRoute(session, provider, model) {
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      return { provider, model };
    }
    let events = [];
    try { events = session?.snapshotEvents?.() ?? []; } catch { events = []; }
    for (const wanted of ['model/selection', 'request/header', 'request/context']) {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event?.type !== wanted) continue;
        const data = wanted === 'request/header' ? (event.data?.header?.config ?? {}) : (event.data ?? {});
        if (typeof data.provider === 'string' && data.provider !== '' && typeof data.model === 'string' && data.model !== '') {
          // 只取提供方与型号。**思考强度一律不带**：插件不指定思考强度，也不继承主对话的设置
          // （继承主对话的 max 会又慢又贵，实测确认过那是 bug；设置键已按用户决定删除）。
          return { provider: data.provider, model: data.model };
        }
      }
    }
    return null;
  }

  /**
   * 发起一次最小调用（含超时、计数、token 记账、留痕、失败分类）。
   * @param {object} input - 调用参数。
   * @param {string} [input.inCharsText] - `inChars` 对应的那段原文（用于 token 估算）。
   * @returns {Promise<{ok:boolean, text?:string, code?:string, hint?:string, ms:number, route?:object}>} 结果。
   */
  async function call(input) {
    const started = now();
    const path = input.path;
    const gate = check(path);
    if (!gate.ok) return { ok: false, code: gate.code, hint: failureHint(gate.code), ms: 0 };
    const timeoutMs = Math.max(1, Number(input.timeoutMs) || 4000);
    // 思考强度：**插件不指定，也不继承主对话的设置**（完全交给 DSH 侧的模型配置）。
    // 这里曾经读过 `settings.llmReasoningEffort`，更早还继承过主对话的 `request/header.config.reasoningEffort`
    // —— 那会让辅助调用又慢又贵（实测确认是 bug）；设置键与继承路径已于 2026-10-07 一并删除。
    //
    // 输入 token 估算：按**真正送出去的那段文本**算，口径与插件别处（注入预算、总览）
    // 完全一致 —— 都是 lib/text.js 的 estimateTokens。
    const inTokensEst = estimateTokens(input.inCharsText ?? '');
    const signal = AbortSignal.timeout(timeoutMs);
    let text = '';
    // 留痕用的真实输出量：`outChars` 以前只写 `text.length`，而思考型模型（实测 glm-5.3-flash）
    // 经常**只产出 reasoning-delta、text 块一个字都没吐**就超时/结束 —— 于是留痕里 outChars
    // 恒为 0，"到底是没输出还是我们没记"永远分不清。这里按分片**累加真实长度**，
    // 并且把"思考"与"正文"分开记（`outReasoningChars`），一眼就能看出钱花在哪。
    let outChars = 0;
    let outReasoningChars = 0;
    /** 输出 token 估算：思考也算钱（同样是模型吐出来的），所以正文与思考一起估。 */
    const outTokensOf = () => estimateTokens('x'.repeat(outChars + outReasoningChars));
    // 调用**尝试**就先计数（失败也算，避免坏的提供方被反复捶）。
    // 输入那一笔在这里就能算准（要送的文本已经定了），**输出那一笔必须等流结束**：
    // 早先这里写成 `countCall(inTokensEst, outTokensOf())` —— 求值发生在入流**之前**，
    // 于是用量文件里的 `outTokensEst` 恒为 0（只读审查报告 7 实测确认）。
    // 现在改成两段记账：先记"这一次调用 + 输入"，流结束后（含失败/超时/中断路径）
    // 用**真实输出量**补记输出（`calls: 0`，不重复计数）。
    countCall({ calls: 1, inTokens: inTokensEst });
    // 补记输出：`mergeUsage` 是累加的，所以这一次调用会写两行 usage，合计才是这次的真实用量。
    // 失败路径也必须补记 —— 思考型模型超时前吐的 token 照样计费，漏记等于账是假的。
    let outputCounted = false;
    const countOutputOnce = () => {
      if (outputCounted) return;
      outputCounted = true;
      const out = outTokensOf();
      if (out > 0) countCall({ calls: 0, outTokens: out });
    };
    const traceShape = () => ({
      outChars,
      outReasoningChars,
      inTokensEst,
      outTokensEst: outTokensOf(),
    });
    try {
      const stream = gate.llm.stream({
        provider: input.route.provider,
        model: input.route.model,
        // 消息必须是**完整形状**：官方 createMessage() 会补 `id`（branded UUID）并冻结对象；
        // 只给 {role, content} 会在校验处抛错（实测报的是一句 message 为空的 ERROR）。
        messages: (Array.isArray(input.messages) ? input.messages : []).map((message, index) => ({
          id: typeof message?.id === 'string' && message.id !== ''
            ? message.id
            : `dsm-${path}-${index}-${Math.random().toString(36).slice(2, 10)}`,
          role: typeof message?.role === 'string' ? message.role : 'user',
          content: Array.isArray(message?.content) ? message.content : [],
          source: message?.source ?? { kind: 'dsh-super-memory' },
        })),
        ...(typeof input.system === 'string' && input.system !== '' ? { system: input.system } : {}),
        maxTokens: Math.max(1, Number(input.maxTokens) || 256),
        purpose: input.purpose ?? 'dsh-super-memory',
        // 思考强度：**不传这个字段** —— 插件不覆盖、也不继承，由 DSH 官方「设置 → 模型」决定。
        signal,
      });
      let finish = null;
      for await (const chunk of stream) {
        if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          outChars += chunk.text.length;
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // 只计数、**绝不并进 text**：模型输出必须是干净答案（解析严格 JSON 靠它），
          // 思考串进来会直接导致 JSON 解析失败、整批扩写被丢。这里纯粹为了留痕可诊断。
          outReasoningChars += chunk.text.length;
        } else if (chunk?.type === 'finish') finish = chunk;
      }
      // 结束分片在不同版本里字段不同（实测本机是 `reason`，官方另一处源码是 `kind`）：
// 只认"有 failure 或明确 error/aborted"为失败，其余（stop/length/…）都算成功。
      const terminal = String(finish?.kind ?? finish?.reason ?? '');
      const failed = finish !== null && (finish.failure !== undefined || terminal === 'error' || terminal === 'aborted');
      countOutputOnce();
      if (failed) {
        // 真实失败码优先原样带出（哪怕不在我们的映射表里）——否则面板只会显示"未预期的错误"，
        // 而真正的原因（提供方返回的 code/message）就丢了，排查要靠猜。
        const raw = typeof finish.failure?.code === 'string' && finish.failure.code !== '' ? finish.failure.code : '';
        const code = raw !== '' ? raw : (finish.kind === 'aborted' ? 'ABORTED' : 'ERROR');
        const detail = `${finish.kind}: ${String(finish.failure?.message ?? '')} ${JSON.stringify(finish).slice(0, 300)}`.trim();
        const ms = now() - started;
        trace({ path, ok: false, code, ms, route: input.route, inChars: input.inChars ?? 0, ...traceShape(), detail });
        return fail(path, code, detail);
      }
      const ms = now() - started;
      trace({ path, ok: true, ms, route: input.route, inChars: input.inChars ?? 0, ...traceShape() });
      lastRoute = input.route;
      return { ok: true, text, ms, route: input.route };
    } catch (error) {
      const code = signal.aborted ? 'TIMEOUT' : codeOf(error);
      const ms = now() - started;
      countOutputOnce();   // 失败/超时路径也要记已产生的输出（审查报告 7）
      trace({ path, ok: false, code, ms, route: input.route, inChars: input.inChars ?? 0, ...traceShape() });
      return fail(path, code, describeError(error));
    }
  }

  return {
    /** 面板"测试连接"与状态显示用。 */
    status() {
      const settings = settingsOf();
      const cooldownUntil = Math.max(0, ...[...cooldown.values()]);
      return {
        // 与 `check()`、与面板同一条判据：只看模型档位（见 check() 的注释）。
        enabled: settings.llmMode !== 'off',
        serviceAvailable: llmOf() !== null && llmOf() !== undefined,
        usage: usage(),
        cooldownUntil: cooldownUntil > now() ? new Date(cooldownUntil).toISOString() : null,
        lastFailure,
        lastRoute,
      };
    },

    /** 已注册的提供方（面板显示"当前解析到的提供方与模型"）。 */
    async listProviders() {
      const llm = llmOf();
      if (llm === null || llm === undefined) return null;
      let raw = null;
      try { raw = await llm.listProviders(); } catch { return null; }
      // 形状归一：可能是裸数组、{providers}、{routes}，或异步可迭代
      let list = [];
      if (Array.isArray(raw)) list = raw;
      else if (Array.isArray(raw?.providers)) list = raw.providers;
      else if (Array.isArray(raw?.routes)) list = raw.routes;
      else if (raw !== null && typeof raw?.[Symbol.asyncIterator] === 'function') {
        for await (const item of raw) list.push(item);
      }
      const providers = [];
      for (const item of list) {
        if (typeof item === 'string') { providers.push({ provider: item, models: [] }); continue; }
        const provider = typeof item?.provider === 'string' ? item.provider
          : (typeof item?.id === 'string' ? item.id : (typeof item?.name === 'string' ? item.name : ''));
        if (provider === '') continue;
        const models = Array.isArray(item?.models)
          ? item.models.map((m) => (typeof m === 'string' ? m : String(m?.id ?? m?.model ?? m?.name ?? ''))).filter((id) => id !== '')
          : [];
        providers.push({ provider, models });
      }
      // 型号清单要用**模型目录**接口（`listModels`）；适配器没实现就留空（面板会提示）
      const shapes = [];
      for (const entry of providers) {
        if (entry.models.length > 0) continue;
        for (const call of [() => llm.listModels?.(entry.provider), () => llm.listModels?.({ provider: entry.provider }), () => llm.listModels?.()]) {
          let value = null;
          try { value = await call(); } catch { continue; }
          if (value === null || value === undefined) continue;
          const array = Array.isArray(value) ? value
            : (Array.isArray(value?.models) ? value.models : (Array.isArray(value?.items) ? value.items : []));
          const ids = array.map((m) => (typeof m === 'string' ? m : String(m?.id ?? m?.model ?? m?.name ?? ''))).filter((id) => id !== '');
          shapes.push(`${entry.provider}:${Array.isArray(value) ? 'array' : typeof value}/${array.length}`);
          if (ids.length > 0) { entry.models = ids; break; }
        }
      }
      // 只记形状与条数（元数据，不含任何密钥），万一还是空的可以一眼看清官方返回了什么
      diag?.write?.({ event: 'llm-providers', providers: providers.length, models: providers.reduce((n, p) => n + p.models.length, 0), shapes });
      return providers;
    },

    /**
     * 测试连接：固定 10 token 的最小请求（§13.5）。
     * @param {object} session - 会话（用于跟随主模型）。
     * @param {object} overrides - 临时覆盖的 provider/model。
     * @returns {Promise<object>} 结果。
     */
    async testConnection(session, overrides = {}) {
      const settings = settingsOf();
      const route = resolveRoute(session, overrides.provider ?? settings.llmProvider, overrides.model ?? settings.llmModel);
      if (route === null) return { ok: false, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const result = await call({
        path: 'test',
        route,
        timeoutMs: overrides.timeoutMs ?? settings.llmIngestTimeoutMs ?? 8000,
        maxTokens: 64,
        inChars: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: '这是一次连通性测试。请直接回复两个字：收到' }] }],
      });
      return { ...result, route };
    },

    /**
     * ① 入库扩写：给一批摘要块生成"用户可能怎么问这块内容"。
     *
     * 输出强约束为 JSON：`{"0": ["关键词", …], "1": [...]}`；解析失败**整批放弃**，
     * 保留原有词频 keywords（绝不写坏数据）。
     * @param {object} input - session / blocks / 配置。
     * @returns {Promise<{ok:boolean, byIndex:Map<number,string[]>, code?:string, hint?:string, batch:number}>} 结果。
     */
    async expandKeywords(input) {
      const settings = settingsOf();
      const empty = { ok: false, byIndex: new Map(), batch: 0 };
      const blocks = Array.isArray(input.blocks) ? input.blocks : [];
      if (blocks.length === 0) return { ...empty, code: 'EMPTY' };
      const route = resolveRoute(input.session, settings.llmProvider, settings.llmModel);
      if (route === null) return { ...empty, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };

      const system = '你在为一个"跨压缩记忆"插件的检索索引做扩写。给每段文本生成 3–6 个短词或短句，'
        + '要求是"用户以后可能用哪些说法来问这段内容"——包括同义词、口语说法、以及这段内容涉及的关键实体名。'
        + '只输出严格 JSON，键是给定的编号字符串，值是字符串数组；不要解释、不要 Markdown 代码块。';
      // 每块送多少字符：`llmIngestBlockChars`（默认 600，范围 100–4000）。
      // 早先这里写死 1200 —— 实测一次压缩入库的输入是 3,926 字符；扩写只需要"这块在讲什么"，
      // 前 600 字符足够覆盖主题，输入量直接砍掉约一半（省的是钱，不是效果）。
      const blockChars = Math.max(100, Math.min(4000, Number(settings.llmIngestBlockChars) || 600));
      const numbered = blocks.map((block, index) => `[${index}] ${String(block.text ?? '').slice(0, blockChars)}`).join('\n\n');
      const result = await call({
        path: 'ingest',
        route,
        system,
        timeoutMs: settings.llmIngestTimeoutMs ?? 8000,
        maxTokens: settings.llmIngestMaxTokens ?? 240,
        inChars: numbered.length,
        inCharsText: numbered,
        messages: [{ role: 'user', content: [{ type: 'text', text: numbered }] }],
      });
      if (!result.ok) return { ...empty, code: result.code, hint: result.hint, batch: blocks.length };

      const parsed = parseJsonObject(result.text);
      if (parsed === null) return { ...empty, code: 'BAD_OUTPUT', hint: failureHint('BAD_OUTPUT'), batch: blocks.length, detail: String(result.text ?? '').slice(0, 200) };
      const byIndex = new Map();
      for (const [key, value] of Object.entries(parsed)) {
        const index = Number.parseInt(key, 10);
        if (!Number.isSafeInteger(index) || index < 0 || index >= blocks.length) continue;
        if (!Array.isArray(value)) continue;
        const terms = value
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().slice(0, 24))
          .filter((item) => item !== '')
          .slice(0, 6);
        if (terms.length > 0) byIndex.set(index, terms);
      }
      if (byIndex.size === 0) return { ...empty, code: 'BAD_OUTPUT', hint: failureHint('BAD_OUTPUT'), batch: blocks.length, detail: String(result.text ?? '').slice(0, 200) };
      return { ok: true, byIndex, batch: blocks.length, ms: result.ms, route };
    },

    /**
     * ③ 查询改写：把口语长句改写成若干关键词/短语（默认关）。
     *
     * 架构上是**安全**的：改写出来的词仍要自己过本地 BM25 阈值，
     * 模型无法凭一句话把不相关的内容塞进上下文。
     * @param {object} input - session / query / 配置。
     * @returns {Promise<{ok:boolean, terms:string[], cached:boolean, code?:string, hint?:string}>} 结果。
     */
    async rewriteQuery(input) {
      const settings = settingsOf();
      const query = String(input.query ?? '').trim();
      if (query === '') return { ok: false, terms: [], cached: false, code: 'EMPTY' };
      const route = resolveRoute(input.session, settings.llmProvider, settings.llmModel);
      if (route === null) return { ok: false, terms: [], cached: false, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const key = hash(`rewrite\u0000${route.provider}\u0000${route.model}\u0000${query}`);
      const cached = cacheGet(key);
      if (cached !== null) return { ok: true, terms: cached, cached: true };

      const result = await call({
        path: 'rewrite',
        route,
        system: '把用户的问题改写成 5–10 个关键词或短语，用来做本地关键词检索。'
          + '要求：包含同义词与口语说法；只输出严格 JSON 数组，元素是字符串；不要解释。',
        timeoutMs: settings.llmRecallTimeoutMs ?? 8000,
        // 只要 5–10 个关键词（严格 JSON 数组）：默认 120 token（设置项 `llmRewriteMaxTokens`）。
        // 原先写死 200 —— 多出来的额度模型会拿去写解释，反而更容易格式不对被整批丢弃。
        maxTokens: Math.max(1, Number(settings.llmRewriteMaxTokens) || 120),
        inChars: query.length,
        inCharsText: query,
        messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
      });
      if (!result.ok) return { ok: false, terms: [], cached: false, code: result.code, hint: result.hint };
      const terms = parseJsonArray(result.text);
      if (terms === null || terms.length === 0) return { ok: false, terms: [], cached: false, code: 'BAD_OUTPUT', hint: failureHint('BAD_OUTPUT') };
      cacheSet(key, terms);
      return { ok: true, terms, cached: false };
    },

    /**
     * ✕ 通道的**分页挑选**（2026-10-08 新增；用户实测的失效案例就是它要修的）。
     *
     * 旧实现只把本地词面分数最高的 **3 条 × 100 字**喂给模型 —— 用户问
     * "我最早对设置面板要求的原话是什么？"时，正确答案（本会话第一条消息）字面上
     * **没有"最早"二字**，于是分数排在第 4 名之后、**根本没被送进候选**，
     * 模型只能在错的里挑。现在改成**按页喂**：每页 30 条（序号 + 时间 + 标题 + 首句），
     * 模型只回一个页内编号或 `NONE`；`NONE` 就翻下一页，最多 `llmDiagnosePageLimit` 页。
     *
     * 分工：页构造/提示词/解析/循环全在 `lib/diagnose.js`（纯函数、可单测），
     * 这里只负责"真的调一次模型"（超时、计数、token 记账、失败分类都由 `call` 管）。
     * 调用失败 → **立刻停**，不再翻页花钱；扫完仍无 → 如实回 `found:false`，绝不硬凑。
     * @param {object} input - `{session, query, pages, pageLimit}`。
     * @returns {Promise<object>} `{ok, found, index, item, page, asked, pages, code?, hint?}`。
     */
    async selectPages(input) {
      const settings = settingsOf();
      const pages = Array.isArray(input?.pages) ? input.pages : [];
      const base = { ok: true, found: false, index: 0, item: null, page: 0, asked: 0, pages: pages.length };
      if (pages.length === 0) return { ...base, code: 'EMPTY' };
      const query = String(input?.query ?? '');
      const route = resolveRoute(input?.session, settings.llmProvider, settings.llmModel);
      if (route === null) return { ...base, ok: false, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const pageLimit = Math.max(1, Math.min(20, Number(input?.pageLimit) || Number(settings.diagnosePageLimit) || 4));
      let lastFailure = null;
      const result = await pickAcrossPages({
        pages,
        pageLimit,
        ask: async (page) => {
          const prompt = buildPagePrompt(query, page);
          const answer = await call({
            path: 'pick',
            route,
            system: pagePickSystem(),
            timeoutMs: settings.llmRecallTimeoutMs ?? 8000,
            // 只要一个编号/`NONE`：额度给多了模型会拿它写解释，反而更容易被判成格式不对
            maxTokens: PAGE_PICK_MAX_TOKENS,
            inChars: prompt.length,
            inCharsText: prompt,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          });
          if (!answer.ok) lastFailure = { code: answer.code, hint: answer.hint };
          return answer;
        },
      });
      // 模型调用失败（超时/限流/未配提供方/格式不对）：如实报失败 —— 调用方据此
      // 让用户看到"为什么没找到"，而不是伪装成"翻完了、库里没有"。
      if (lastFailure !== null && (result.found !== true)) {
        return { ...base, ok: false, ...lastFailure, asked: result.asked, page: result.page };
      }
      return {
        ...base,
        found: result.found === true,
        index: result.index,
        item: result.record ?? null,
        page: result.page,
        asked: result.asked,
        // 被页数上限截住（后面还有候选没看）——调用方要如实说明，不许说成"全库都看过了"
        truncated: result.limitReached === true,
        stopped: result.stopped ?? '',
        ...(lastFailure !== null ? { lastCode: lastFailure.code } : {}),
      };
    },

    /**
     * ③ 重排（**已无调用方**，2026-10-08 由上面的 `selectPages` 取代）。
     *
     * 保留实现只为兼容外部/测试对它的直接调用；`lib/routes.js` 的 ✕ 通道**不再**用它
     * —— 那条路径的失效根因正是"只喂 3 条 × 100 字，正确答案没进候选"（见 `selectPages`）。
     * 新代码不要用它：`scripts/unit.mjs` 有一条断言钉住"✕ 通道走的是 selectPages"。
     * @param {object} input - session / query / candidates（[{fp,title,preview}]）。
     * @returns {Promise<{ok:boolean, fp:string|null, index:number, code?:string, hint?:string}>} 结果。
     */
    async rerank(input) {
      const settings = settingsOf();
      const candidates = Array.isArray(input.candidates) ? input.candidates : [];
      if (candidates.length === 0) return { ok: false, fp: null, index: 0, code: 'EMPTY' };
      const route = resolveRoute(input.session, settings.llmProvider, settings.llmModel);
      if (route === null) return { ok: false, fp: null, index: 0, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const list = candidates.map((item, index) => `${index + 1}. ${item.title} — ${String(item.preview ?? '').slice(0, 100)}`).join('\n');
      const result = await call({
        path: 'rerank',
        route,
        system: '下面是从用户旧对话里检索到的候选片段。判断哪一条最可能回答用户的问题。'
          + '只输出一个数字：最相关候选的编号；如果都不相关就输出 0。不要解释、不要输出别的字符。',
        timeoutMs: settings.llmRecallTimeoutMs ?? 8000,
        maxTokens: 8,
        inChars: list.length,
        inCharsText: list,
        messages: [{ role: 'user', content: [{ type: 'text', text: `问题：${String(input.query ?? '')}\n\n候选：\n${list}` }] }],
      });
      if (!result.ok) return { ok: false, fp: null, index: 0, code: result.code, hint: result.hint };
      const index = Number.parseInt(String(result.text).replace(/[^\d]/g, '').slice(0, 3), 10);
      if (!Number.isSafeInteger(index) || index < 0 || index > candidates.length) {
        return { ok: false, fp: null, index: 0, code: 'BAD_OUTPUT', hint: failureHint('BAD_OUTPUT') };
      }
      if (index === 0) return { ok: true, fp: null, index: 0 };
      return { ok: true, fp: candidates[index - 1].fp, index };
    },

    /** 清空冷却（面板"测试连接"成功后调用，避免用户等了 10 分钟却什么都没变）。 */
    clearCooldown() {
      cooldown.clear();
    },
  };
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 包裹与前后废话）。 */
export function parseJsonObject(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** 从模型输出里抠出第一个 JSON 数组。 */
export function parseJsonArray(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().slice(0, 24))
      .filter((item) => item !== '')
      .slice(0, 12);
  } catch { return null; }
}

/** 把模型生成的词并进原有 keywords（模型失败时行为不退化：原词仍然在）。 */
export function mergeKeywords(original, generated, limit = 10) {
  const out = [];
  const seen = new Set();
  for (const word of [...(Array.isArray(original) ? original : []), ...(Array.isArray(generated) ? generated : [])]) {
    const key = String(word ?? '').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}
