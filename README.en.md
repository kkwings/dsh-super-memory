# dsh-super-memory (Super Memory)

A **cross-compaction memory** plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness).

When one very long session has been compacted a few times, things you asked or decided earlier
**fall out of the context window**. This plugin keeps them: it stores what a compaction drops into a
local file, and hands it back as *reference material* exactly when a new question is related to it.
The model sees the old decision first and reasons about it together with the new conditions —
instead of starting from zero.

> Scope: **cross-compaction only** (same session). No cross-session memory. Self-contained:
> no other memory plugin, no network, no model calls.

## What it does

| # | When | What | Cost |
| --- | --- | --- | --- |
| ① | **On compaction** | Ingest what is being dropped into a local store: L1 summary chunks (reusing the summary DSH already generated) + L2 conversation-text chunks (user questions and assistant answers only) | **0 model calls** |
| ② | **After compaction** | Inject a directory-level outline of "what this session was about" so the new window is not disconnected | ≤ **300 tokens**, adaptive, may be 0 |
| ③ | **On every question** | Search the local store lexically first; inject a reference **only on a hit** | hit ≤ **500 tokens** (≤2 items, ≤300 chars each); **miss = 0 tokens** |

Verbatim history is only read through the `history_read` tool when you explicitly ask for it.

Injected blocks are labelled as *reference, not conclusion*: if a later decision contradicts an
earlier one, the assistant is told to say "earlier it was X, now it is Z because Y" rather than
silently switching answers.

## Where data lives

**All memory content stays inside the session's own workspace**, so projects are isolated and the
system drive is untouched:

```
<workspace>/.dsh-compaction-memory/
  <sessionId>.jsonl        this session's memory (one block per line)
  _trash/<time>_<session>/ recycle bin (blocks.jsonl + manifest.json)
  _audit.jsonl             audit of delete / restore / purge
```

Only two small **global** files live in the "global data directory" (default `$DSH_HOME`, i.e.
`~/.dsh`): the settings file (<1 KB) and a capped diagnostics log. Set the environment variable
`DSH_SUPER_MEMORY_HOME` to move them to another location. The memory directory itself can be
changed in the panel (relative = per workspace, absolute = one shared directory).

## Install

Requires DSH **0.1.7-rc.2 / 0.2.0-rc.1 or newer** (see `peerDependencies`; tested on the 0.2.0-rc.2
desktop client). After installing, **restart the DSH client** — host plugin code is cached in the
process. Success = a "超级记忆 / Super Memory" section in Settings and a `history_read` tool.

```
plugin_manager  action: install_bundle  target: dsh-super-memory
```

## Panel

Settings are grouped by the three things the plugin does, and each group shows its own cost:
① ingest (0 tokens) · ② post-compaction outline (≤N tokens per compaction) · ③ question-time recall
(0 on a miss, ≤N per turn). Two more groups: ④ saved compaction content (session list with the same
titles as the DSH sidebar, browse/delete) and ⑤ recycle bin (restore / delete permanently), plus a
collapsed ⑥ diagnostics section.

> The panel UI text is currently **Chinese only**; plugin metadata (title/description) ships in both
> Chinese and English.

## Self-checks

Requires **Node ≥ 22.15** (session logs are multi-frame zstd; older Node cannot decode them).

```bash
npm test                                    # unit tests + panel static checks, no session log needed
node scripts/selftest.mjs <session.v4.jsonl.zstd>
node scripts/harness.mjs  <session.v4.jsonl.zstd> [tmp workspace]
node scripts/inspect.mjs  "<workspace>" "<an old topic>"
```

`npm test` exits non-zero on failure (it is a real check, not a printout). `harness.mjs` boots the host half
against a fake Cordis context and a real session log, and asserts ingest idempotency, hit/miss cost, toggle
effects, the panel API contract (including the CSRF guard and path-traversal rejection), workspace isolation
and `history_read` cleanliness.

## Privacy

- **Local only, nothing leaves the machine**: no network calls, no model calls, no telemetry. `lib/` pulls in
  no HTTP client (`node:http(s)`, `net`, `dns`, `tls` are absent); the only "network" traffic is your browser
  talking to the plugin's own routes on `127.0.0.1` when you click a button in the settings panel.
- **What is stored**: conversation text only — your questions and the assistant's answer text. **No** reasoning
  blocks, no tool calls, no tool results, no system-injected content. Long answers are split into chunks.
- **Where**: `<workspace>/.dsh-compaction-memory/` (per workspace) plus two small global files (settings and a
  capped diagnostics log). Nothing is written anywhere else, and the original DSH session logs are **never**
  touched.
- **When verbatim history is read**: only when you explicitly ask for it (`history_read`); day-to-day turns do
  not read raw history.
- **Accidental commit risk**: the memory directory lives inside *your* project folder. If that workspace is a
  git repository, the settings panel (section ④) detects it and offers a one-click button that adds the ignore
  rule to that project's `.gitignore`. The plugin's own `.gitignore` cannot cover your project.
- **Deleting**: removing `<workspace>/.dsh-compaction-memory/` clears that project's memory completely; the
  panel can also delete per session (7-day protection period by default, configurable) and empty the recycle bin.

## License

MIT
