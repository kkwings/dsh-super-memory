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

/** 今天（本地时区）的日期串。 */
function today(now) {
  return new Date(now()).toISOString().slice(0, 10);
}

/**
 * 建立模型网关。
 *
 * @param {object} options - 依赖与配置。
 * @param {Function} options.getLlm - `() => llmService|null`（经 `ctx.inject(['llm'], …)` 拿到）。
 * @param {Function} options.getSettings - `() => settings`。
 * @param {object} [options.diag] - 诊断日志（可空）。
 * @param {string} options.usagePath - 每日调用计数文件。
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

  /** 今日用量。 */
  function usage() {
    const settings = settingsOf();
    const cap = Math.max(0, Number(settings.llmDailyCallCap) || 0);
    const record = readJson(options.usagePath, {});
    const day = today(now);
    const calls = record.date === day && Number.isSafeInteger(record.calls) ? record.calls : 0;
    return { date: day, calls, cap, remaining: cap === 0 ? 0 : Math.max(0, cap - calls) };
  }

  /** 记一次调用（计入日上限；调用**尝试**就算，失败也算，避免坏的提供方被反复捶）。 */
  function countCall() {
    const current = usage();
    const next = { date: current.date, calls: current.calls + 1 };
    try {
      mkdirSync(dirname(options.usagePath), { recursive: true });
      writeFileAtomic(options.usagePath, `${JSON.stringify(next)}\n`);
    } catch { /* 计数落盘失败不影响调用本身 */ }
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
    if (settings.llmAssistEnabled !== true) return { ok: false, code: 'UNAVAILABLE' };
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
   * "主模型"有三个来源，按可靠性依次回退 —— 实测有些会话**根本没有** `model/selection` 事件
   * （本机当前会话就是 0 条），只认它会让「测试连接」永远报 NO_ROUTE：
   *   ① `model/selection`（用户显式切换过模型时才有）
   *   ② `request/header` → `data.header.config.{provider, model}`（每次请求都记，最可靠）
   *   ③ `request/context` → `data.{provider, model}`
   * @param {object} session - 会话（可为 null，此时无法跟随）。
   * @param {string} provider - 配置的提供方（可为空）。
   * @param {string} model - 配置的模型（可为空）。
   * @returns {{provider:string, model:string, reasoningEffort?:string}|null} 路由。
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
          return {
            provider: data.provider,
            model: data.model,
            ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
          };
        }
      }
    }
    return null;
  }

  /**
   * 发起一次最小调用（含超时、计数、留痕、失败分类）。
   * @param {object} input - 调用参数。
   * @returns {Promise<{ok:boolean, text?:string, code?:string, hint?:string, ms:number, route?:object}>} 结果。
   */
  async function call(input) {
    const started = now();
    const path = input.path;
    const gate = check(path);
    if (!gate.ok) return { ok: false, code: gate.code, hint: failureHint(gate.code), ms: 0 };
    const timeoutMs = Math.max(1, Number(input.timeoutMs) || 4000);
    // 辅助调用的思考强度：只认插件自己的设置，**不继承主对话的 max**（继承会又慢又贵）。
    const reasoningEffort = String(settingsOf().llmReasoningEffort ?? '').trim().slice(0, 32);
    countCall();
    const signal = AbortSignal.timeout(timeoutMs);
    let text = '';
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
        // 思考强度**只认插件自己的设置**：跟随主模型时若把主对话的 max 一起带过来，
        // 辅助调用会又慢又贵（实测确认过这个继承是 bug）。空 = 不指定。
        ...(reasoningEffort === '' ? {} : { reasoningEffort }),
        signal,
      });
      let finish = null;
      for await (const chunk of stream) {
        if (signal.aborted) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk?.type === 'finish') finish = chunk;
      }
      // 结束分片在不同版本里字段不同（实测本机是 `reason`，官方另一处源码是 `kind`）：
// 只认"有 failure 或明确 error/aborted"为失败，其余（stop/length/…）都算成功。
      const terminal = String(finish?.kind ?? finish?.reason ?? '');
      const failed = finish !== null && (finish.failure !== undefined || terminal === 'error' || terminal === 'aborted');
      if (failed) {
        // 真实失败码优先原样带出（哪怕不在我们的映射表里）——否则面板只会显示"未预期的错误"，
        // 而真正的原因（提供方返回的 code/message）就丢了，排查要靠猜。
        const raw = typeof finish.failure?.code === 'string' && finish.failure.code !== '' ? finish.failure.code : '';
        const code = raw !== '' ? raw : (finish.kind === 'aborted' ? 'ABORTED' : 'ERROR');
        const detail = `${finish.kind}: ${String(finish.failure?.message ?? '')} ${JSON.stringify(finish).slice(0, 300)}`.trim();
        const ms = now() - started;
        trace({ path, ok: false, code, ms, route: input.route, inChars: input.inChars ?? 0, outChars: text.length, detail });
        return fail(path, code, detail);
      }
      const ms = now() - started;
      trace({ path, ok: true, ms, route: input.route, inChars: input.inChars ?? 0, outChars: text.length });
      lastRoute = input.route;
      return { ok: true, text, ms, route: input.route };
    } catch (error) {
      const code = signal.aborted ? 'TIMEOUT' : codeOf(error);
      const ms = now() - started;
      trace({ path, ok: false, code, ms, route: input.route, inChars: input.inChars ?? 0, outChars: text.length });
      return fail(path, code, describeError(error));
    }
  }

  return {
    /** 面板"测试连接"与状态显示用。 */
    status() {
      const settings = settingsOf();
      const cooldownUntil = Math.max(0, ...[...cooldown.values()]);
      return {
        enabled: settings.llmAssistEnabled === true,
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
      try {
        // **原样返回**：官方的形状未必是裸数组（可能是 {providers}/{routes}，或异步可迭代）。
        // 早先这里 `Array.isArray(x) ? x : null` 把"非数组但可用"的清单直接丢成 null，
        // 结果面板永远读不到提供方（实测踩过）。
        return await llm.listProviders();
      } catch { return null; }
    },

    /**
     * 测试连接：固定 10 token 的最小请求（§13.5）。
     * @param {object} session - 会话（用于跟随主模型）。
     * @param {object} overrides - 临时覆盖的 provider/model。
     * @returns {Promise<object>} 结果。
     */
    async testConnection(session, overrides = {}) {
      const settings = settingsOf();
      const route = resolveRoute(session, overrides.provider ?? settings.llmIngestProvider, overrides.model ?? settings.llmIngestModel);
      if (route === null) return { ok: false, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const result = await call({
        path: 'test',
        route,
        timeoutMs: overrides.timeoutMs ?? settings.llmIngestTimeoutMs ?? 8000,
        maxTokens: 64,
        inChars: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: '回答一个字：好' }] }],
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
      const route = resolveRoute(input.session, settings.llmIngestProvider, settings.llmIngestModel);
      if (route === null) return { ...empty, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };

      const system = '你在为一个"跨压缩记忆"插件的检索索引做扩写。给每段文本生成 3–6 个短词或短句，'
        + '要求是"用户以后可能用哪些说法来问这段内容"——包括同义词、口语说法、以及这段内容涉及的关键实体名。'
        + '只输出严格 JSON，键是给定的编号字符串，值是字符串数组；不要解释、不要 Markdown 代码块。';
      const numbered = blocks.map((block, index) => `[${index}] ${String(block.text ?? '').slice(0, 1200)}`).join('\n\n');
      const result = await call({
        path: 'ingest',
        route,
        system,
        timeoutMs: settings.llmIngestTimeoutMs ?? 8000,
        maxTokens: settings.llmIngestMaxTokens ?? 600,
        inChars: numbered.length,
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
      const route = resolveRoute(input.session, settings.llmRecallProvider, settings.llmRecallModel);
      if (route === null) return { ok: false, terms: [], cached: false, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const key = hash(`rewrite\u0000${route.provider}\u0000${route.model}\u0000${query}`);
      const cached = cacheGet(key);
      if (cached !== null) return { ok: true, terms: cached, cached: true };

      const result = await call({
        path: 'rewrite',
        route,
        system: '把用户的问题改写成 5–10 个关键词或短语，用来做本地关键词检索。'
          + '要求：包含同义词与口语说法；只输出严格 JSON 数组，元素是字符串；不要解释。',
        timeoutMs: settings.llmRecallTimeoutMs ?? 4000,
        maxTokens: 200,
        inChars: query.length,
        messages: [{ role: 'user', content: [{ type: 'text', text: query }] }],
      });
      if (!result.ok) return { ok: false, terms: [], cached: false, code: result.code, hint: result.hint };
      const terms = parseJsonArray(result.text);
      if (terms === null || terms.length === 0) return { ok: false, terms: [], cached: false, code: 'BAD_OUTPUT', hint: failureHint('BAD_OUTPUT') };
      cacheSet(key, terms);
      return { ok: true, terms, cached: false };
    },

    /**
     * ③ 重排（**默认关**，见方案 §7.3）：把候选按"一行摘要 + 编号"给模型，只回编号或 0。
     *
     * 必须允许"0 = 都不相关"：弱模型有"老好人"倾向，硬挑一条正是最危险的失败模式。
     * @param {object} input - session / query / candidates（[{fp,title,preview}]）。
     * @returns {Promise<{ok:boolean, fp:string|null, index:number, code?:string, hint?:string}>} 结果。
     */
    async rerank(input) {
      const settings = settingsOf();
      const candidates = Array.isArray(input.candidates) ? input.candidates : [];
      if (candidates.length === 0) return { ok: false, fp: null, index: 0, code: 'EMPTY' };
      const route = resolveRoute(input.session, settings.llmRecallProvider, settings.llmRecallModel);
      if (route === null) return { ok: false, fp: null, index: 0, code: 'NO_ROUTE', hint: failureHint('NO_ROUTE') };
      const list = candidates.map((item, index) => `${index + 1}. ${item.title} — ${String(item.preview ?? '').slice(0, 100)}`).join('\n');
      const result = await call({
        path: 'rerank',
        route,
        system: '下面是从用户旧对话里检索到的候选片段。判断哪一条最可能回答用户的问题。'
          + '只输出一个数字：最相关候选的编号；如果都不相关就输出 0。不要解释、不要输出别的字符。',
        timeoutMs: settings.llmRecallTimeoutMs ?? 4000,
        maxTokens: 8,
        inChars: list.length,
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
