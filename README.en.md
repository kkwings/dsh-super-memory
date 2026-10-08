# dsh-super-memory (Super Memory)

**Cross-compaction memory** for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness).

After a very long session has been compacted a few times, things you asked or decided early on **fall out of the context window**. This plugin stores what a compaction drops on your own machine, then hands those passages back to the model **only when they are relevant** — so it can recall an earlier decision instead of starting from zero.

> Scope: **within one session, across compactions**. **Cross-session memory is out of scope.**
> Self-contained: no other memory plugin, **no internet access**, and **zero model calls by default**.

## What it does and does not do

**Does** — three things, each with its own switch and its own cost:

| # | When | What | Cost |
| --- | --- | --- | --- |
| ① | **On compaction** | Ingest what is being dropped: a summary layer (reusing the summary DSH already wrote, split by section) and a raw-conversation layer (your questions + the assistant's answer text), plus **the file/search results the model read** (`read`, `grep`, `glob`, `web_fetch`, `history_read`). | **0 model calls** |
| ② | **After compaction** | Inject a directory-level outline of "what this session was about" (topic — conclusion). Nothing worth keeping means nothing is injected. | ≤ **300 tokens per compaction**, adaptive, **may be 0** |
| ③ | **On every question** | Score the local store first; inject a reference **only on a hit**. | hit ≤ **700 tokens/turn** (≤2 items, ≤300 chars each); **miss = 0 tokens** |

**Does not**:

- **No cross-session memory.** A different session has a different store (memory lives per workspace + session id).
- **Cannot send messages for you.** The plugin's session handle has **no append capability** (verified platform boundary). It can only queue material into your **next** turn — it cannot make the main model answer again immediately.
- **Never rewrites your conversation, never writes to DSH's native session logs** (read-only), **never reads or stores API keys**.

## Two ways to retrieve (the first one is the default)

| | ① Local retrieval (default) | ② Model-assisted retrieval (optional) |
| --- | --- | --- |
| When | every question | only after you pick a tier in panel section ⑦ |
| How | local lexical scoring: CJK character bigrams + latin words, weighted fields (title / keywords / body) via BM25, then a score threshold | ① at compaction the model adds "how might the user ask about this block" keywords; ② when you click ✕ it rewrites your phrasing and **judges which passage is strongly relevant** |
| Cost | **0 model calls, 0 tokens**; a miss costs **nothing at all** (no text is produced) | pay per call through DSH's model service; one call per batch at compaction, one per ✕ click (same question cached 30 days) |
| How to switch | it is the default | panel ⑦ "usage": **no model (default)** / **main model** / **a specific model** |

Both can coexist, but **the question-time retrieval is always local**: the model is only ever called at "compaction keyword expansion" and "you clicked ✕" — **never in the question hot path**.

## The meaning of the ✕ button

Every assistant answer in a **compacted** session shows a small **✕** (it only appears once the session has been compacted — before that there is nothing to find).

1. Clicking it **immediately** shows a line in the conversation: "**xxx (auxiliary model) searching, please wait…**". No popup, and **no buttons** while it runs.
2. The plugin searches **this session's** compacted history with your last question, optionally has the model rewrite it into keywords, and then has the model **decide which passage is strongly relevant** — meaning "it would change the answer", not "it is somewhat related". The model may answer **0 = none of them qualify** (weak models tend to be people-pleasers; forcing a pick is the dangerous failure mode).
3. Result:
   - **Something is strongly relevant** → the conversation shows "found related content" plus **「open the verbatim excerpt」** (a Markdown file with **only** the strongly relevant passages, questions and answers only, generated in code, **0 tokens**) and a dismiss button. The material is **queued into your next turn**: just **ask your next question** and the model answers with it.
   - **Nothing is strongly relevant** → it says so plainly ("**no strongly related content found**"), injects **nothing**, and offers **no** "open excerpt" button.
4. **Be clear about this**: the plugin **cannot** make the model re-answer right now. It can only queue the material into your next turn. That is exactly what the on-screen line means.

If local search already found a strong hit (top score ≥ threshold × 1.5), the rewrite call is **skipped** and the plugin says so — pure saving, same result. The ✕ search waits at most **8 seconds** (configurable); a timeout only writes a diagnostic line and never blocks your conversation.

## The cost account

All limits are **single-shot ceilings**, not quotas:

| Item | Number |
| --- | --- |
| Post-compaction outline | ≤ 300 tokens per compaction, may be 0 |
| Per-turn injection | ≤ 700 tokens, ≤ 2 items, ≤ 300 chars each (≥ 50 chars per item). 700 is what actually fits two full CJK items **plus the header** (2×≈255 + ≈105); at 500 the budget loop drops the second item, i.e. only one is ever injected |
| Measured single injection | 128 / 167 / 458 tokens |
| Ingest expansion | first **600 chars** of each block, **8 blocks** per batch, **output cap 240 tokens** (bad format = whole batch dropped, original keywords kept) |
| Query rewrite | output cap 120 tokens |
| Daily call cap | default **0 = unlimited** |

**The deleted gate**: an earlier version capped the *cumulative* injection per session (2% of the window). Measured on 2026-10-07 it was removed — a day had only 19–21 auxiliary calls and a whole long session cost about 60k tokens against 560M tokens of main-model usage (≈0.01%). Its only reliable effect was "hit rate mysteriously drops", because **users do not attribute their own ✕ clicks to an exhausted budget**. Cost control is now per-call only.

**Order of magnitude**: **5 compactions + 20 ✕ clicks ≈ 33k tokens**, versus hundreds of millions of tokens of main-model usage in the same session — roughly **0.01%**. (The 33k figure comes from `scripts/measure-savings.mjs` replaying the production ingest path over a real session log.)

## Architecture and terminology

- **L0** = DSH's native session log (multi-frame zstd). Read-only, never written.
- **L1** = summary blocks: the summary DSH already generated, split by Markdown section. Short, precise, conclusion-level.
- **L2** = conversation-text blocks distilled from what was dropped (your question + the answer), **with a title and keywords**, plus read-class tool results.

**Why L2 is not just L0**: (1) L0 is a compressed, machine-format archive — parsing it live on the question hot path is far too slow; (2) tool results in L0 are **3.3× the volume** of the actual conversation, so noise would drown the retrieval; (3) titles and keywords only exist in L2, and scoring weights them 3× and 4× over the body. Retrieval is local BM25 over CJK bigrams; each block carries a 16-hex content fingerprint so nothing is injected twice.

## Optional model assist (off by default)

Only **two moments** ever call a model: keyword expansion at compaction, and query rewrite + strong-relevance judgement when you click ✕. Failure of any kind degrades silently (diagnostic log only). Cooldowns: rate/quota errors 10 minutes, provider/credential errors 30 minutes. Timeouts: ingest 8000 ms, ✕ 8000 ms (it was 4000 ms; thinking models often spent 4 s emitting only reasoning, wasting the click). Same input is cached 30 days (rewrite results). The plugin **neither sets nor inherits reasoning effort** — configure that on DSH's own model settings page. Call traces contain **metadata only**.

There is exactly **one** model selection: `llmMode` (`off` / `main` / `custom`) plus `llmProvider` + `llmModel`. On `custom` that single pair is the effective route for **both** moments above; if either is empty the plugin falls back to the session's main model (it never silently reverts to another field). `off` does not clear a provider/model you picked earlier — that is remembered for when you switch back. The earlier per-moment fields (`llmIngestProvider`, `llmIngestModel`, `llmRecallProvider`, `llmRecallModel`) were **removed**; a settings file still carrying them has its values moved into `llmProvider`/`llmModel` once at load, and the old keys are then deleted from disk. No compatibility layer is kept (the plugin has no released users yet).

## Privacy and boundaries

- **Dependencies**: no third-party runtime dependencies at all (`peerDependencies` only, all `@deepseek-ai/*` provided by DSH itself). Services used: `tools`, `systemPrompt`, `webServer` (required) and `llm` (optional).
- **Reads**: DSH session logs (`$DSH_HOME/sessions/**`, read-only, never written) and the session-title projection cache. Stat-only for size queries.
- **Writes**: inside the session's own workspace, `<workspace>/.dsh-compaction-memory/` (per-session `.jsonl`, `_trash/`, `_audit.jsonl`, `_pairs.jsonl`, `_readable/excerpts/*.md`), plus five small files in the global data directory (settings, diagnostics, daily usage, rewrite cache, call trace).
- **Deletes**: every delete path is validated to be **strictly inside** the memory directory (equal to the root is refused too; `..`, absolute paths and symlink escapes are rejected). Deletes go to a recycle bin by default and are audited.
- **Network**: **no internet access.** `lib/` imports no HTTP client; every panel `fetch` targets the local `/api/dsh-super-memory/*` routes. Model calls happen only through DSH's `llm` service, only after you opt in.
- **Command execution**: exactly **one** `spawn` in the whole repo — `revealInFileManager()` in `lib/routes.js`, used solely to reveal a file in your file manager (Windows `explorer /select,`, macOS `open -R`, else `xdg-open`). No shell, no request-supplied executable or arguments, path built server-side, out-of-scope workspaces answered with 403.
- **Credentials**: never read, stored or forwarded. The plugin only fills in two **string names** (`provider`, `model`); DSH holds the keys.

## Install and use

Requires DSH **0.1.7-rc.2 / 0.2.0-rc.1 or newer** (tested on the 0.2.0-rc.2 desktop client).

```
plugin_manager  action: install_bundle  target: dsh-super-memory
```

Then **restart the DSH client** (host plugin code is cached in the process). Success = a "超级记忆 / Super Memory" section in Settings and a `history_read` tool. To uninstall: `plugin_manager action: remove_bundle target: dsh-super-memory` — the memory directory and the global files are **not** removed automatically.

Day to day you only need three sentences: it stores what compaction drops, it hands back only the relevant passages (≤ 700 tokens/turn, **nothing at all when nothing matches**), and if you think it forgot something you just click **✕** under the answer. All tuning lives behind the collapsed "参数设置" button; everything applies immediately, no restart.

> The panel UI text is Chinese only; plugin metadata (title/description) ships in both languages.

## Data and privacy notes

- **The plugin writes your worktree's `.gitignore` only when you click the button.** If the workspace is a git repository and the memory directory is not ignored yet, section ④ offers "add the ignore rule"; clicking it appends one line (`storeDir/`) to that workspace's `.gitignore` (creating the file with a one-line comment if needed) and records the action in `_audit.jsonl`. It never edits `.gitignore` on its own.
- **Read-only requests (GET) have no persistent side effect.** Opening the panel issues `/session`, `/trash`, `/audit`, … which only remember the current session's cwd **in process memory**; the persisted "known workspaces" list is written on write operations only (delete / restore / purge / settings / ignore rule). It holds up to 200 entries, evicting the least recently used.
- **The diagnostics log stores no question text.** `recall` entries carry a short hash and a character count (`queryHash`, `queryChars`) instead. For local debugging you can set `DSM_DIAG_QUERY_PLAINTEXT=1` to also write plaintext. Disclosure: versions up to 0.2.2 wrote `queryHead` (the first 60 plaintext characters) into that log, which lives in `$DSH_HOME` and aggregates across workspaces; lines already written by an older build stay in that file until you delete it (deleting it only loses diagnostic history, never memory data).
- **Panel UI language:** Chinese only (the plugin metadata is bilingual; the settings panel itself is not localised).

## Notable fixes in the current version

Path-traversal write via the session id in the excerpt filename; the ✕ material being visible only in the first step of a turn (clear point moved to `turn/end`); cross-session bleed in `/diagnose` (candidates are now filtered to the target session); a backfill `NaN` that kept cold-start blocks invisible; `outChars` always 0 for models that only emit reasoning; a millisecond-resolution staleness check that dropped fresh results (now a publish sequence number); hooks placed after an early return (the ✕ button vanished), and a TDZ crash in the ✕ click handler. `npm test` used to be unable to see the host half at all (a corrupted `lib/host.js` passed every test), so `scripts/host-smoke.mjs` now checks every file's bytes, syntax, loadability and export contract.

Since 0.2.2 (version number unchanged): the injected line now prefers the **answer / conclusion sentence** over the question text; a failed `spawn` no longer kills the host (the async `error` event is always handled); deleting memory also removes that session's verbatim excerpts; memory writes are serialised with a file lock; `/diagnose` query rewriting is rate-limited (60s window); `outTokensEst` is accounted from real streamed output; the model settings collapsed to a **single field set** (`llmMode` + `llmProvider` + `llmModel`, with a one-shot migration off the four removed per-moment keys). `npm test` is now wired to the wiring layer too: `host-smoke.mjs` really calls `apply(ctx)` (context provider, `session/event` subscription, panel routes, `history_read`) and drives the `routes.js` request chain with synthetic req/res, the panel stub honours hook dependency arrays and runs cleanups, `load()` clamps settings with the same bounds as the panel API, and the diagnostics log stores a query hash instead of plaintext.

## Self-checks

Requires **Node ≥ 22.15**. `npm test` exits non-zero on failure and runs four suites: unit tests, panel static checks, panel render smoke, host smoke.

```bash
npm test
node scripts/selftest.mjs <session.v4.jsonl.zstd>
node scripts/harness.mjs  <session.v4.jsonl.zstd> [tmp workspace]
```

## License

MIT
