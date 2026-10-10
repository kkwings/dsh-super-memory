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

### What it still cannot do (and why)

This section exists because it genuinely **cannot recall things "the way a person would"** yet. Each limit below is measured, not modesty.

1. **It only has what was compacted away.**
   Anything still inside the window is already in front of the model; the plugin neither has it nor needs it. Measured: of the 162 questions in the reference session, only **71 (43.8%)** had ever fallen inside a compaction range — the rest were still live. So it gets more useful the longer a session runs, and is near-useless in a young one.

2. **It matches words, not meaning.**
   If your wording differs from the original, it may miss. We tried adding a local embedding model (turn text into vectors and compare): it was **not better** than word matching on our real store, and would have cost several hundred MB — so it is not shipped. Re-phrasings still depend on the optional auxiliary model (§7).

3. **"Earliest / first time / last time" is recognised now, but not reasoned about.**
   Since 0.2.5 those time-reference words are detected, the words near them are weighted up, and earlier records win ties — but the plugin **cannot decide on its own** which stretch of time to search. That step belongs to **the model you are talking to**.

4. **It cannot think for you, and cannot send messages.**
   All it can do is put a few passages **in front of the model**. Platform limit: a plugin cannot insert a message into the session or make the model answer again — so what ✕ finds arrives in your **next** turn (§4).

5. **It does not guarantee a hit — but it says so.**
   When nothing is found it prints "no strongly related content" instead of padding. A miss costs zero tokens.

6. **One line: it is a car, not a turnstile.**
   It is good at "**the thing you are asking about has a distinctive wording and was compacted**", and bad at "**you ask the way you'd talk to a person**". The latter needs the **model to understand your intent first and then drive it** — e.g. when you ask "how did we originally decide the control panel thing", the correct move is to first realise this means "find the earliest one", then drive the search with "control panel"; tapping it like a card reader fails.

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
| Measured single injection | 128 / 167 / 395 / 458 tokens (depending on how many items hit and how long the text is) |
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

## Changelog

Version numbers below are release versions; **"after 0.2.2" means local commits with the version number deliberately unchanged** ([package.json](package.json) still says 0.2.2).

| Version | Key changes |
| --- | --- |
| **0.1.0** | The three jobs land: ingest what a compaction drops (L1 = the summary DSH already wrote, L2 = conversation text only), inject a ≤300-token outline after each compaction, and retrieve locally at question time — inject only on a hit. Memory lives in the session's own workspace. |
| **0.1.1 → 0.1.2** | Fix "the first request of a turn cannot see the recall" (read the question from the `agent/inbox/spliced` event, a few ms earlier than run-context evaluation); add `stickyRecall` (a hit block stays put, saving one snapshot append). |
| **0.1.3 → 0.1.6** | The panel is reorganised around the three jobs; ④ splits into "stored compactions" + "recycle bin"; session titles match DSH's own sidebar; the global data directory can be moved off the system drive with `DSH_SUPER_MEMORY_HOME`. |
| **0.2.0** | Audit-driven safety and correctness fixes: path traversal (even equality with the root is refused), a CSRF guard on writes, the `sessionLogBytes` contract, losing the workspace list when settings were saved, `?limit=abc` propagating into `slice(0,-NaN)`, a 64 MB gate on the `history_read` log fallback, an LRU for `states`. Adds `scripts/unit.mjs` (non-zero exit on failure). |
| **0.2.1** | The cost story becomes "the user picks a tier + strict single-shot ceilings"; the reasoning-effort key and its inheritance path are **removed** (it was a bug: slower and more expensive); automatic workspace detection; the host smoke guard `host-smoke.mjs`. |
| **0.2.2** | Auxiliary cost halved: **tool-result blocks are no longer sent for expansion** (their filename/title alone is enough to retrieve them, and they are 3.3× the volume of the conversation), batch 5→8 blocks, expansion output cap 300→240; the rewrite call is **skipped** on a strong local hit (one call saved, same result); ✕ shows "searching" immediately and its timeout goes 4 s→8 s; traces and usage start recording token estimates; the millisecond staleness comparison is fixed; the **cumulative per-session injection cap is deleted** (the daily cap default becomes 0 = unlimited). |
| **after 0.2.2** | **① The injected line answers first**: it used to be "the question + truncated body"; now it takes the **answer / conclusion sentence** and only falls back to the head of the question when the answer is empty (`itemText` in [recall.js](lib/recall.js)) — measured on a real store, the answer text reached the injected line in **1% → 100%** of hits, so what you see it "remember" is the conclusion instead of your own question re-read. **② False injections are fixed**: a candidate must now match **≥ min(4, distinct query tokens)** *different* query tokens, and the "previous turns" fallback only runs when the current question itself is too short (< 4 distinct tokens) — measured on two real stores, unrelated probes went from **12/12 injecting** to **0/12**, while related questions kept their recall. **③ The normalisation no longer drifts with question length**: the denominator only sums IDF of tokens that actually occur in the store (`df>0`), so pasting an unrelated tail onto a related question no longer pushes it below the threshold (0.210 → 0.983 on the same sample); the threshold stays 0.28 and the separating feature is the evidence gate. **④ Wiring-layer self-checks**: `host-smoke.mjs` really calls `apply(ctx)` and drives `routes.js` with synthetic req/res, and the panel stub honours hook dependency arrays and runs cleanups (see the developer notes). **⑤ One model field set**: `llmMode` (`off`/`main`/`custom`) + `llmProvider` + `llmModel` replace the four per-moment shadow keys — the settings schema goes from **47 keys to 43**, with a one-shot migration at load. **⑥ Tool-result cap enforced where the text is assembled**: "slice, then glue the header on" let the stored record exceed the cap (4068 with a cap of 4000; 284 with a cap of 200); it is now clamped to the **final stored text** in `clampToolText`/`toolRecordText` and again at the `rawRecords` merge exit. **⑦ The plugin no longer indexes its own source**: tool results whose target path falls inside the plugin directory are skipped from L2 (narrow rule, counted in the diagnostic `selfSourceSkipped`) — such a block is a universal attractor that makes any probe question written verbatim in the source hit by construction. **⑧ "Restore defaults" resets key by key and keeps the model tier** (`llmMode`/`llmProvider`/`llmModel` are kept, see `RESET_KEEP_FIELDS`) instead of deleting the whole settings file. **⑨ Diagnostics store a question hash**: `recall` entries carry `queryHash` + `queryChars` instead of the first 60 plaintext characters (`queryHead`). |
| **0.2.5** | **All of it is "hand over the information that was already there", not a new mechanism** (the mechanism swaps — local embeddings, re-chunking, graded keywords, multi-query union — were all measured and gave no gain or a loss; see the design notes). **① The answer continuation finally reaches the injected line**: L2 is `问：…\n答：…` but only the first answer line carries a prefix, and the old extractor accepted prefixed lines only, so every continuation fell into a pool no injection path can read. Proof: deleting every continuation line left the injected line **byte-identical for 70/70 blocks**; a complementary split now grows the injected content by **58.7% (real store) / 180.9% (one-QA-per-block store)**, worst block 30 → 300 chars. **② Pure numbers and short identifiers are no longer dropped**: the old regex required a leading letter, so `252`, `0.28`, `stickyRecall`, `maxCharsPerItem` matched **nothing** (zero candidates across three stores and twelve gate settings) — while numbers are this corpus's densest anchors. Numbers, decimals and identifier parts now tokenize (unique tokens +3.4%…+6.8%, search +0.04 ms). **③ A long message no longer dilutes itself**: the denominator sums only the top 12 in-store tokens by IDF (calibration: uncapped fixes 0/13 real misses; k=8 fixes all 13 but pushes long unrelated false positives 4/16→5/16; **k=12 fixes all 13 with false positives unchanged**). **④ Several topics in one message no longer crowd each other out**: retrieval is segmented (each segment gets its own denominator) and merged by fingerprint — "what is the injection cap + the button disappeared" used to surface one topic, now both are candidates. **⑤ Time-reference words ("最早/第一次/上次") are recognised and weighted** (±60-char window as an extra path, 1.35×; ties prefer the earlier block — only when such a word is present; byte-identical otherwise). **⑥ On ✕ the auxiliary model first names the single point the question is about**, then extracts keywords there: on a 1000-character question the keyword span collapsed from **979 to 9 characters** and the unrelated half contributed nothing. **⑦ Sentence splitting no longer swallows the real question** (`…问题：我们最早聊控制面板的时候是怎么定的？你可以尝试…` used to glue the question to its lead-in and then merge it away; clauses containing a question mark now stand alone, and colons/enumeration commas are lead-in boundaries). **⑧ Three real user questions became permanent regression cases** ("first time we talked about the control panel", "the original wording of my panel requirement", and the negative "what did you have for dinner" which must inject nothing). |
| **removed features (and why)** | **A per-compaction "whole session as readable Markdown"** — cancelled, not even at 0 tokens: the window can already scroll back; the real problem is that the *model* forgets, so writing a second copy fixes nothing (only the on-demand verbatim excerpt stays). **A manual candidate-picking UI** — cancelled: making the user choose among ten candidates hands the retrieval algorithm's job to the user, who also cannot know which passage "would change the answer"; the auxiliary model judges strong relevance instead and says "none" when there is none. **The "why did it miss" panel** — the UI is cancelled (the host route `/diagnose` stays, reused by ✕): "not ingested / not ranked / still only in the dropped original" is *our* troubleshooting data and it is already in the diagnostics log, while the user's real question ("did we ever discuss this?") is answered by ✕ itself. Also deleted: the cumulative per-session injection cap and the reasoning-effort key. Not implemented and not planned: cross-session memory, local vector search, writing back into the conversation (the platform has no append capability). |

## Developer notes: design and lessons

### Real defects fixed in this round (each with an assertion that turns red)

- **Path-traversal write** — the session id arrives in the request body, so `..\..\..` escaped the memory directory and wrote anywhere. Fixed by keeping only safe characters in the filename *and* asserting the resolved target is still inside the root (two layers).
- **The injected line swallowed the conclusion** — the recall line was assembled from the question plus a truncated body, so the conclusion could fall outside the cut. It now prefers the **answer / conclusion sentence** and only falls back to the head of the question when there is no answer.
- **Cross-session bleed** — the store is per workspace, so several sessions' blocks sit in one file; `/diagnose` could answer with a passage from another session. Candidates are now filtered to the target session id, and old records without a `session` field never match.
- **The `combined` fallback dragged in previous turns' questions** — widening the query to "current + previous turns" pulled real related questions from earlier turns into the query, and they lifted *unrelated* questions over the threshold (12/12 unrelated probes injected 256 chars each). The fallback now runs only when the current question itself is too short (< 4 distinct tokens).
- **Backfill `NaN`** — `const added = backfill(...)` while the body did `+= await …`, so `added` was always NaN and the index was never refreshed; cold-start blocks stayed invisible. The bad await chain is gone, a real count is returned and the index is invalidated after a write.
- **`outChars` always 0** — a thinking model emits only reasoning, so the trace's output count was always 0 and "no output" was indistinguishable from "not accounted". Real streamed lengths are accumulated, with reasoning and answer text accounted separately.
- **Millisecond staleness check** — "is this result from the previous turn?" was decided with `Date.now()`, so a result published in the same millisecond was judged stale and the whole block disappeared. It is now a monotonic publish sequence number.
- **Hooks order / TDZ** — a hook placed after an early return unmounted the component and the ✕ button vanished; the ✕ `onClick` referenced a `const run` defined below it, so the click threw a TDZ error that was silently swallowed ("clicking does nothing"). All hooks moved above the early return, `run` stays a hoisted function declaration, both pinned by source-level assertions.
- **`npm test` could not see the host half** — `lib/host.js` was once written as UTF-16 garbage and every suite stayed green, because the three scripts imported only a few modules. `scripts/host-smoke.mjs` now checks every file's bytes (non-empty, no BOM, no NUL), runs `node --check` on each, imports the host entry and the key modules for real, verifies the export contract, and calls `apply(fakeCtx)` — asserting the `systemPrompt.context` provider, the `session/event` subscription, the panel routes and the `history_read` tool, then fires a real-shaped `compaction/summary` event. It also drives the `routes.js` request chain with synthetic req/res (GET 200, unknown path 404, write without the origin header 403, parameterised paths 200), so a wrong method string or a removed write guard is no longer invisible.

### Hard-won lessons

- **Never write large text with PowerShell** — `lib/host.js` was once written as UTF-16 + NUL garbage while `npm test` stayed green. Use precise replacement tools, and re-run the syntax check after every edit.
- **Concurrent edits overwrite each other** — two processes rewriting the same file means the later write wins wholesale. Sequence the edits when several tasks touch one file.
- **Two stub-render traps** — ① `useRef` must be reused **across renders** like real React (a fresh object each render makes a "remember on first render" component reset every frame, so the stub's staleness behaviour differs from the real one); ② the stub `fetch` must **dispatch by URL** (the host has several routes; returning one payload for everything makes cross-route reads permanently `undefined`).
- **Hook slot indices are array indices**, not "the n-th useState" — planting a value in the wrong slot (say 6 for `openLlm`) mutates a different state and leaves an assertion that looks fine but proves nothing.
- **Injection blocks must be stable** — any change to one section of the context makes DSH append the **entire** run-context snapshot; even *removing* a block costs tokens.
- **A stale `profiles/node_modules` junction makes investigations wrong** — the `@deepseek-ai/*` entries under `C:\Users\Administrator\.dsh\profiles\node_modules` are junctions pointing at **0.1.7-rc.2**, while the desktop actually runs **0.2.0-rc.2** (inside `app.asar`). Reading that layer yields outdated conclusions about what the official API can do; read the running `app.asar` instead (see section 11 above).

## Why the plugin keeps its own settings (instead of the official settings form)

**Status quo**: every parameter is stored by the plugin itself (`$DSH_HOME/dsh-super-memory.settings.json`, see `SettingsStore` in [config.js](lib/config.js)), and the UI is a **full settings section the plugin registers itself** (`ctx.slots.inject('settings.section', …)` in [client.js](lib/client.js)). Official DSH 0.2 offers another route: a plugin exports `export const Config = Schema.object({...})`, a field must be marked `.volatile()` to appear in the form, the host reads it with `config.<field>.get()`, changes arrive via `ctx.on('loader/volatile-update', …)`, and values land in the **current profile's `cordis.patch.yml`** (per profile, **not per workspace**). The points below are the conclusions of a **read-only probe** and explain why we **do not migrate**.

- **The decisive fact: DSH 0.2's shared form controls are a text box and a password box only** — **no switch, no dropdown, no checkbox** (the switches and dropdowns you see on official pages are hand-drawn by each plugin).
- **Dropdown options cannot be supplied dynamically**: the schema is serialised to JSON to cross the boundary and functions are rejected — so this plugin's provider dropdown (options from `ctx.llm.listProviders()`) **cannot** be produced by the official form.
- **The official form takes no custom controls** (buttons, lists, "test connection"); anything custom means registering your own page — which is exactly what we use `settings.section` for (a standard extension point, not a workaround).
- **So migrating would save only "storage + validation + reset + notification", never the UI itself**, and the price is real: possibly **a second entry point** (the official form on the plugin page and our panel in Settings can both change the same thing); config is replaced wholesale rather than deep-merged; **a missing `.volatile()` fails silently** (the field is written to disk but never shown or notified); and one **unverified** risk — which copy of `@deepseek-ai/*` wins when an external plugin resolves it: the 0.2.0-rc.2 inside `app.asar` or the 0.1.7-rc.2 behind the `profiles\node_modules` junction.
- **Conclusion: keep self-managed settings.** Every read point in this plugin looks at `SettingsStore`; migrating means rewriting all of them, and the only gain is deleting a few hundred lines of storage code — with **zero existing users**, that risk is not worth it.

**The one adopted item**: the only "cheap and clearly better" suggestion from the probe has landed — "restore defaults" now **resets key by key and keeps the model tier** (`SettingsStore.reset()` + `RESET_KEEP_FIELDS`) instead of deleting the whole settings file. The old implementation called `unlinkSync(settingsPath)`, so one click lost `llmMode`/`llmProvider`/`llmModel` too (observed in practice).

> ⚠️ **Warning for future maintainers**: the junctions under `C:\Users\Administrator\.dsh\profiles\node_modules\@deepseek-ai\*` point at **0.1.7-rc.2**, while the desktop actually runs **0.2.0-rc.2** (inside `app.asar`). **Reading through that junction yields outdated conclusions** (for example "the official API has no such capability" may really mean "the *old* official API did not"). To judge official capabilities, read the matching version inside `app.asar`.

## Self-checks

Requires **Node ≥ 22.15** (native session logs are multi-frame zstd, which needs `zstdDecompressSync`). `npm test` exits non-zero on failure and runs four suites: ① unit tests (pure functions plus regressions for every real bug), ② panel static checks (settings keys / CSS classes / API paths / sections / number-box precision), ③ panel render smoke (the whole panel tree rendered through a stub React, including the "control ↔ settings key" bindings), ④ **host smoke** (every file non-empty with no BOM and no NUL, `node --check` on each, the host entry really loads, the export contract holds, plus one real `apply(ctx)` call and the panel request chain driven with synthetic req/res).

```bash
npm test
# selftest now carries real assertions (ingest counts, L1+L2 present, recap within
# budget, a hit sample that injects and stays under the per-turn cap, the injected line
# carrying answer text, unrelated questions injecting 0). Failure exits 1; a log with no
# compaction events SKIPs that whole part with a printed reason instead of failing.
node scripts/selftest.mjs <session.v4.jsonl.zstd>
node scripts/harness.mjs  <session.v4.jsonl.zstd> [tmp workspace]
```

## License

MIT
