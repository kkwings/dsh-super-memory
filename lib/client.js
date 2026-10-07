/**
 * dsh-super-memory — 客户端半边：设置 →「超级记忆」
 *
 * 面板按"插件做的三件事"分板块，每块只放跟它有关的开关与参数：
 *   ① 压缩时：把被压掉的内容存到本地（0 token）
 *   ② 压缩后：注入一份脉络总览（≤N token / 次压缩）
 *   ③ 提问时：检索并参考历史（未命中 0，命中 ≤N token / 轮）
 * 另加 ④ 本地记忆库（三块共用的仓库）与 ⑤ 诊断与高级（默认折叠）。
 * 全部读写都由宿主半边的 /api/dsh-super-memory/* 提供；本文件不引入任何
 * Harness 客户端包，只用 react 与主题 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-super-memory',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/dsh-super-memory';

    /* ─────────────────────────── 样式（只用主题 token） ─────────────────────────── */
    const CSS = `
.dsm-root { display:flex; flex-direction:column; gap:14px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dsm-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); overflow:hidden; }
.dsm-card-head { padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); font-weight:600; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dsm-card-body { padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
.dsm-row { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
.dsm-row-main { display:flex; flex-direction:column; gap:3px; min-width:0; }
.dsm-label { font-weight:500; }
.dsm-hint { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
.dsm-num { width:96px; padding:4px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; text-align:right; }
.dsm-num:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.dsm-switch { position:relative; width:38px; height:21px; border-radius:11px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); cursor:pointer; padding:0; flex:none; transition:background .15s,border-color .15s; }
.dsm-switch[aria-checked="true"] { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsm-switch i { position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .15s; }
.dsm-switch[aria-checked="true"] i { transform:translateX(17px); }
.dsm-btn { padding:4px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; font-size:12px; white-space:nowrap; }
.dsm-btn:hover { border-color:var(--dsw-alias-brand-primary); }
.dsm-btn[disabled] { opacity:.45; cursor:not-allowed; }
.dsm-btn-danger { color:var(--dsw-alias-state-error-primary); }
.dsm-btn-sm { padding:2px 7px; font-size:11px; }
.dsm-path { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.dsm-badge { display:inline-block; padding:0 6px; border-radius:9px; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsm-badge-lock { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dsm-no { flex:none; min-width:18px; color:var(--dsw-alias-label-secondary); font-size:12px; }
/* 列表项：标题独占一行（长标题不再被右侧按钮挤断），第二行放说明与操作 */
.dsm-item { padding:7px 10px; border-top:1px solid var(--dsw-alias-border-l1); display:flex; gap:8px; align-items:flex-start; }
.dsm-item-body { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.dsm-item-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dsm-item-title { font-weight:500; word-break:break-word; }
.dsm-item-foot { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:space-between; }
.dsm-item-actions { display:flex; flex-direction:column; gap:4px; flex:0 0 auto; }
.dsm-tag { font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
/* ── 会话内「没想起来？」按钮 ── 图标刻意用 ✕，与官方点赞/点踩（👍👎）区分开 ── */
.dsm-miss-wrap { position:relative; display:inline-flex; align-items:center; }
.dsm-miss-btn { width:calc(26px + var(--dsh-content-font-delta,0px)); height:calc(26px + var(--dsh-content-font-delta,0px)); display:inline-flex; align-items:center; justify-content:center; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:13px; line-height:1; }
.dsm-miss-btn:hover { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.dsm-miss-pop { position:absolute; z-index:40; bottom:calc(100% + 6px); right:0; width:min(460px,80vw); max-height:60vh; overflow:auto; background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base)); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.18); padding:10px; display:flex; flex-direction:column; gap:6px; }
.dsm-miss-pop .dsm-item { border-top:1px solid var(--dsw-alias-border-l1); }
/* 点 ✕ 之后在会话末尾长出的一块（不是弹窗，就在对话流里） */
.dsm-miss-tail { margin:6px 0; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); display:flex; flex-direction:column; gap:6px; }
.dsm-miss-tail .dsm-pre { max-height:200px; }
.dsm-mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dsm-block { padding:6px 8px; border-top:1px solid var(--dsw-alias-border-l1); display:flex; gap:8px; align-items:flex-start; }
.dsm-block-body { flex:1; min-width:0; }
.dsm-pre { white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,Consolas,monospace; font-size:11px; line-height:1.55; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:8px; max-height:260px; overflow:auto; }
.dsm-inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsm-input { flex:1; min-width:180px; padding:4px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.dsm-err { color:var(--dsw-alias-state-error-primary); font-size:12px; }
.dsm-ok { color:var(--dsw-alias-state-success-primary); font-size:12px; }
.dsm-warn { color:var(--dsw-alias-state-warn-primary); font-size:12px; }
.dsm-totals { display:flex; gap:16px; flex-wrap:wrap; color:var(--dsw-alias-label-secondary); font-size:12px; }
/* 板块标题：序号 + 一句话功能 + 成本徽章 */
.dsm-board-head { display:flex; flex-direction:column; gap:4px; }
.dsm-board-line { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dsm-board-title { font-weight:600; }
.dsm-cost { display:inline-block; padding:0 7px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:11px; font-weight:400; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dsm-cost-free { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dsm-cost-capped { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dsm-steps { display:flex; flex-direction:column; gap:7px; }
.dsm-step { display:flex; gap:8px; align-items:flex-start; }
.dsm-step-no { flex:none; width:16px; height:16px; margin-top:1px; border-radius:50%; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); font-size:10px; line-height:15px; text-align:center; color:var(--dsw-alias-label-secondary); }
.dsm-step-body { min-width:0; }
.dsm-sec { border-top:1px solid var(--dsw-alias-border-l1); margin-top:2px; padding-top:8px; }
.dsm-disabled { opacity:.5; }
`;

    /** 注入样式表；返回清理函数。 */
    function mountStyles() {
      const el = document.createElement('style');
      el.setAttribute('data-dsh-plugin', 'super-memory');
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => { try { el.remove(); } catch { /* 忽略 */ } };
    }

    /* ─────────────────────────── API ─────────────────────────── */
    /**
     * 调宿主接口。写操作会带一个自定义头 `x-dsh-super-memory`：宿主用它挡掉
     * 跨站伪造请求（浏览器对带自定义头的跨站请求会先发 CORS 预检，从而被拒）。
     */
    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          'x-dsh-super-memory': '1',
          ...(options?.headers ?? {}),
        },
      });
      let body = null;
      try { body = await response.json(); } catch { /* 落到下面的错误 */ }
      if (body === null || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      }
      return body.value;
    }

    function bytes(n) {
      const value = Number(n ?? 0);
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(2)} MB`;
    }

    function shortTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—';
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return '—';
      const d = new Date(t);
      const pad = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 相对时间："3 天""18 分钟"这种，比绝对时间戳好读。 */
    function relTime(iso) {
      const t = Date.parse(iso ?? '');
      if (!Number.isFinite(t)) return '—';
      const diff = Date.now() - t;
      if (diff < 0) return shortTime(iso);
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return `${min} 分钟`;
      const hour = Math.floor(min / 60);
      if (hour < 24) return `${hour} 小时`;
      const day = Math.floor(hour / 24);
      if (day < 30) return `${day} 天`;
      const month = Math.floor(day / 30);
      if (month < 12) return `${month} 个月`;
      return shortTime(iso).slice(0, 10);
    }

    /** 工作区短名（路径最后一段）。 */
    function workspaceName(path) {
      const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] ?? String(path ?? '');
    }

    /* ─────────────────────────── 基础控件 ─────────────────────────── */
    function Toggle({ checked, onChange, disabled }) {
      return h('button', {
        type: 'button',
        className: 'dsm-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      }, h('i'));
    }

    function SwitchRow({ label, hint, checked, onChange, disabled }) {
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h(Toggle, { checked, onChange, disabled }));
    }

    /**
     * 按 step 的小数位决定精度：整数参数才取整。
     *
     * 为什么不能一律取整：「命中阈值」(0.28) 与「会话累计上限」(0.02) 是小数参数，
     * 一律取整会在**点一下输入框再点走**时就把它们抹成 0——阈值归零会让几乎每轮都注入，
     * 上限归零则直接关掉整条注入通路，而用户看不出发生了什么。
     */
    function decimalsOf(step) {
      if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return 0;
      const text = String(step);
      const dot = text.indexOf('.');
      return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
    }

    function NumberRow({ label, hint, value, min, max, step, suffix, onCommit, warnZero, onWarnZero }) {
      const [draft, setDraft] = React.useState(String(value));
      React.useEffect(() => { setDraft(String(value)); }, [value]);
      const commit = () => {
        // 光标进出、没改过内容：什么都不做（避免"点一下就写盘"）
        if (draft.trim() === String(value)) { setDraft(String(value)); return; }
        const parsed = Number(draft);
        if (!Number.isFinite(parsed)) { setDraft(String(value)); return; }
        const decimals = decimalsOf(step);
        let next = decimals > 0 ? Number(parsed.toFixed(decimals)) : Math.floor(parsed);
        if (typeof min === 'number' && next < min) next = min;
        if (typeof max === 'number' && next > max) next = max;
        setDraft(String(next));
        if (next === value) return;
        if (warnZero === true && next === 0) { onWarnZero(next); return; }
        onCommit(next);
      };
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h('div', { className: 'dsm-inline' },
          suffix ? h('span', { className: 'dsm-hint' }, suffix) : null,
          h('input', {
            className: 'dsm-num',
            type: 'number',
            value: draft,
            min, max, step,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } },
          })));
    }

    function Card({ title, extra, children }) {
      return h('div', { className: 'dsm-card' },
        h('div', { className: 'dsm-card-head' }, h('span', null, title), extra ?? null),
        h('div', { className: 'dsm-card-body' }, children));
    }

    /**
     * 纯下拉行：**点开即列表**（不是"下拉 + 手输"的混合框）。
     *
     * 为什么不用 datalist：混合框里想换一个值时，得先把原内容删干净才能再次展开 ——
     * 多一步操作。这里第一项固定是「（跟随主模型）」（值 = 空串，可清空），
     * 其余来自**你在「设置 → 模型」里已配置好**的提供方/型号。
     */
    function SelectRow({ label, hint, value, options, emptyHint, onCommit, firstLabel, hideEmpty }) {
      const pairs = (Array.isArray(options) ? options : [])
        .map((item) => (typeof item === 'string'
          ? { value: item, label: item }
          : { value: String(item?.value ?? ''), label: String(item?.label ?? item?.value ?? '') }))
        .filter((pair) => pair.value !== '');
      const current = String(value ?? '');
      const known = pairs.some((pair) => pair.value === current);
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h('select', {
          className: 'dsm-num',
          style: { width: '260px', textAlign: 'left' },
          value: current,
          onChange: (event) => onCommit(event.target.value),
        },
          hideEmpty === true ? null : h('option', { value: '' }, firstLabel ?? '（跟随主模型）'),
          // 当前值不在清单里（手填的旧值 / 清单还没读到）也要显示，不能悄悄吞掉
          current !== '' && !known ? h('option', { value: current }, current) : null,
          ...pairs.map((pair) => h('option', { key: pair.value, value: pair.value }, pair.label)),
          pairs.length === 0 && current === '' && typeof emptyHint === 'string'
            ? h('option', { value: '', disabled: true }, emptyHint)
            : null));
    }

    /**
     * 文本行（失焦或回车提交）。
     *
     * `list` = 关联的 `<datalist>` id：点一下就能从**已配置的**提供方/型号里选，
     * 同时保留自由填写（有些适配器不公布型号清单，那时手填仍然可用）。
     * `allowEmpty` = 允许清空（= 跟随主模型）。
     */
    function TextRow({ label, hint, value, placeholder, onCommit, width, list, allowEmpty }) {
      const [draft, setDraft] = React.useState(String(value ?? ''));
      React.useEffect(() => { setDraft(String(value ?? '')); }, [value]);
      const commit = () => {
        const next = draft.trim();
        if (next === '' ) {
          if (allowEmpty === true && String(value ?? '') !== '') { onCommit(''); return; }
          setDraft(String(value ?? ''));
          return;
        }
        if (next === String(value ?? '')) { setDraft(String(value ?? '')); return; }
        onCommit(next);
      };
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h('input', {
          className: 'dsm-num',
          style: { width: `${width ?? 260}px`, textAlign: 'left' },
          type: 'text',
          value: draft,
          placeholder: placeholder ?? '',
          ...(typeof list === 'string' && list !== '' ? { list } : {}),
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } },
        }));
    }

    /** 成本徽章：新用户最先想知道的就是"这块花不花钱"。 */
    function Cost({ kind, children }) {
      const cls = kind === 'free' ? 'dsm-cost dsm-cost-free' : (kind === 'capped' ? 'dsm-cost dsm-cost-capped' : 'dsm-cost');
      return h('span', { className: cls }, children);
    }

    /** 功能板块：序号 + 一句话功能（副标题）+ 成本徽章。dim = 总开关关掉时整块变灰。 */
    function Board({ no, title, subtitle, cost, costKind, extra, dim, children }) {
      return h('div', { className: 'dsm-card' },
        h('div', { className: 'dsm-card-head' },
          h('div', { className: 'dsm-board-head' },
            h('div', { className: 'dsm-board-line' },
              h('span', { className: 'dsm-board-title' }, `${no} ${title}`),
              cost ? h(Cost, { kind: costKind }, cost) : null,
              dim === true ? h(Cost, null, '总开关已关：本块不生效') : null),
            subtitle ? h('div', { className: 'dsm-hint' }, subtitle) : null),
          extra ?? null),
        h('div', { className: dim === true ? 'dsm-card-body dsm-disabled' : 'dsm-card-body' }, children));
    }

    /** 有序步骤说明（新用户看这个就懂）。 */
    function Steps({ items }) {
      return h('div', { className: 'dsm-steps' },
        items.map((text, index) => h('div', { className: 'dsm-step', key: index },
          h('span', { className: 'dsm-step-no' }, String(index + 1)),
          h('span', { className: 'dsm-hint dsm-step-body' }, text))));
    }

    /* ─────────────────────────── 主面板 ─────────────────────────── */
    function Panel(props) {
      const [settings, setSettings] = React.useState(null);
      const [overview, setOverview] = React.useState(null);
      const [diag, setDiag] = React.useState(null);
      const [trash, setTrash] = React.useState({});
      const [detail, setDetail] = React.useState(null);
      const [openAdvanced, setOpenAdvanced] = React.useState(false);
      const [openAbout, setOpenAbout] = React.useState(false);
      const [openLibrary, setOpenLibrary] = React.useState(true);
      const [confirmZero, setConfirmZero] = React.useState(false);
      const [pending, setPending] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(null);
      const [confirmTrashDelete, setConfirmTrashDelete] = React.useState(null);
      const [confirmPurge, setConfirmPurge] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [search, setSearch] = React.useState(null);
      const [diagnoseQuery, setDiagnoseQuery] = React.useState('');
      const [diagnose, setDiagnose] = React.useState(null);
      const [diagnoseBusy, setDiagnoseBusy] = React.useState(false);
      const [llmTest, setLlmTest] = React.useState(null);
      const [llmTestBusy, setLlmTestBusy] = React.useState(false);
      const [openLlm, setOpenLlm] = React.useState(true);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const [s, o] = await Promise.all([api('/settings'), api('/overview')]);
          setSettings(s);
          setOverview(o);
          setError('');
          // 顺手把当前工作区的回收站读出来（用户最常看的就是它）
          const ws = o?.currentWorkspace ?? o?.workspaces?.[0]?.workspace ?? '';
          if (ws !== '') {
            try {
              const value = await api(`/trash?workspace=${encodeURIComponent(ws)}`);
              setTrash((previous) => ({ ...previous, [ws]: value.entries }));
            } catch { /* 回收站读不到不影响主流程 */ }
          }
        } catch (e) { setError(String(e.message ?? e)); }
      }, []);

      const refreshDiag = React.useCallback(async () => {
        try { setDiag(await api('/diagnostics?limit=60')); } catch { /* 忽略 */ }
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      const patch = async (body, options = {}) => {
        try {
          const next = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
          setSettings(next);
          setError('');
          setNotice(options.notice ?? '已保存（即时生效）');
          if (!options.silent) refresh();
          window.setTimeout(() => setNotice(''), 2500);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      const current = settings?.settings ?? null;
      const effective = (key, fallback) => (current === null ? fallback : current[key]);

      const loadTrash = async (workspace) => {
        try {
          const value = await api(`/trash?workspace=${encodeURIComponent(workspace)}`);
          setTrash((previous) => ({ ...previous, [workspace]: value.entries }));
        } catch (e) { setError(String(e.message ?? e)); }
      };

      const loadBlocks = async (workspace, sessionId, title) => {
        try {
          const value = await api(`/session?workspace=${encodeURIComponent(workspace)}&session=${encodeURIComponent(sessionId)}`);
          setDetail({ workspace, sessionId, title: title ?? '', blocks: value.blocks });
        } catch (e) { setError(String(e.message ?? e)); }
      };

      const doDelete = async (target) => {
        setConfirmDelete(null);
        try {
          const result = await api('/delete', {
            method: 'POST',
            body: JSON.stringify({
              workspace: target.workspace,
              session: target.sessionId,
              ...(Array.isArray(target.fps) ? { fps: target.fps } : {}),
              confirm: true,
            }),
          });
          setNotice(`已删除 ${result.deleted} 条${result.trashed ? '（可在回收站还原）' : ''}`);
          window.setTimeout(() => setNotice(''), 3000);
          if (detail !== null && detail.sessionId === target.sessionId && Array.isArray(target.fps)) {
            await loadBlocks(target.workspace, target.sessionId);
          } else if (detail !== null && detail.sessionId === target.sessionId) {
            setDetail(null);
          }
          await refresh();
          await loadTrash(target.workspace);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      const doRestore = async (workspace, id, fps) => {
        try {
          const result = await api('/trash/restore', {
            method: 'POST',
            body: JSON.stringify({ workspace, id, ...(Array.isArray(fps) ? { fps } : {}) }),
          });
          setNotice(`已还原 ${result.restored} 条，回到上面的「被保存的压缩内容」里了`);
          window.setTimeout(() => setNotice(''), 3500);
          await refresh();
          await loadTrash(workspace);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 回收站单条彻底删除（不能还原）。 */
      const doTrashDelete = async (entry) => {
        setConfirmTrashDelete(null);
        try {
          const result = await api('/trash/delete', {
            method: 'POST',
            body: JSON.stringify({ workspace: entry.workspace, id: entry.id, confirm: true }),
          });
          setNotice(result.removed ? '已彻底删除（不可还原）' : '这条已经不在回收站里了');
          window.setTimeout(() => setNotice(''), 3000);
          await refresh();
          await loadTrash(entry.workspace);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 「浏览」：让宿主在系统文件管理器里定位这个会话的记忆文件。 */
      const doReveal = async (workspace, sessionId) => {
        try {
          await api('/reveal', { method: 'POST', body: JSON.stringify({ workspace, session: sessionId }) });
          setNotice('已在文件管理器中定位该会话的记忆文件');
          window.setTimeout(() => setNotice(''), 3000);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 一键把记忆目录加进工作区的 .gitignore（只在确实是 git 仓库时）。 */
      const doAddIgnoreRule = async (workspace) => {
        try {
          const result = await api('/ignore-rule', { method: 'POST', body: JSON.stringify({ workspace }) });
          setNotice(result.changed ? `已把 ${result.rule} 写入 ${result.file}` : '这个项目已经忽略过了');
          window.setTimeout(() => setNotice(''), 4000);
          await refresh();
        } catch (e) { setError(String(e.message ?? e)); }
      };

      const doPurge = async (workspace) => {
        setConfirmPurge(false);
        try {
          const result = await api('/trash/purge', {
            method: 'POST',
            body: JSON.stringify({ ...(workspace ? { workspace } : {}), confirm: true }),
          });
          setNotice(`已清空回收站：${result.entries} 项 / ${bytes(result.bytes)}`);
          window.setTimeout(() => setNotice(''), 3000);
          await refresh();
          if (workspace) await loadTrash(workspace);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 面板里的自检都打在"当前工作区 + 它最近的一个会话"上。 */
      const probeTarget = () => {
        const list = overview?.workspaces ?? [];
        const workspace = list.some((w) => w.workspace === overview?.currentWorkspace)
          ? overview.currentWorkspace
          : (list[0]?.workspace ?? '');
        const session = list.find((w) => w.workspace === workspace)?.sessions?.[0]?.sessionId ?? '';
        return { workspace, session };
      };

      const runSearch = async () => {
        const { workspace, session } = probeTarget();
        if (!workspace || !session || query.trim() === '') return;
        try {
          setSearch(await api(`/search?workspace=${encodeURIComponent(workspace)}&session=${encodeURIComponent(session)}&query=${encodeURIComponent(query)}`));
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 预览"压缩后会看到的总览"：复用试检索接口（总览与查询词无关）。 */
      const runRecapPreview = async () => {
        const { workspace, session } = probeTarget();
        if (!workspace || !session) { setNotice('这个工作区还没有压缩记忆'); window.setTimeout(() => setNotice(''), 2500); return; }
        try {
          const value = await api(`/search?workspace=${encodeURIComponent(workspace)}&session=${encodeURIComponent(session)}&query=${encodeURIComponent('总览预览')}`);
          setSearch(value);
          if ((value.recap?.text ?? '') === '') {
            setNotice('目前挑不出可留的结论 → 压缩后不会注入任何东西（0 token）');
            window.setTimeout(() => setNotice(''), 3500);
          }
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /** 未命中诊断：全库扫描 + 三种原因分类（可选改写/重排）。 */
      const runDiagnose = async () => {
        const { workspace, session } = probeTarget();
        if (!workspace || diagnoseQuery.trim() === '') { setNotice('先填一个没命中的问题'); window.setTimeout(() => setNotice(''), 2500); return; }
        setDiagnoseBusy(true);
        try {
          const value = await api('/diagnose', {
            method: 'POST',
            body: JSON.stringify({ workspace, session, query: diagnoseQuery, limit: 10 }),
          });
          setDiagnose(value);
        } catch (e) { setError(String(e.message ?? e)); } finally { setDiagnoseBusy(false); }
      };

      /** 记一条人工判定（评估数据，不参与检索）。 */
      const savePair = async (item, verdict) => {
        const { workspace, session } = probeTarget();
        try {
          await api('/pair', {
            method: 'POST',
            body: JSON.stringify({ workspace, session, query: diagnoseQuery, fp: item.fp, verdict, score: item.score, title: item.title }),
          });
          setNotice(verdict === 'hit' ? '已记为"就是这条"' : '已记为"也不对"');
          window.setTimeout(() => setNotice(''), 2500);
        } catch (e) { setError(String(e.message ?? e)); }
      };

      /**
       * 测试连接：`kind` = 'ingest' | 'recall'。
       *
       * 必须**分别测对应的那一对字段** —— 早先固定用「入库用」的字段，用户在
       * 「检索用」里配了 GLM，测试却回落到主模型（DeepSeek），显示的路由和他
       * 刚配的完全不是一回事（实测踩过）。
       */
      const runLlmTest = async (kind) => {
        const { session } = probeTarget();
        const provider = kind === 'recall' ? effective('llmRecallProvider', '') : effective('llmIngestProvider', '');
        const model = kind === 'recall' ? effective('llmRecallModel', '') : effective('llmIngestModel', '');
        setLlmTestBusy(true);
        try {
          const value = await api('/llm/test', { method: 'POST', body: JSON.stringify({ session, provider, model }) });
          setLlmTest({ ...value, kind });
        } catch (e) { setError(String(e.message ?? e)); } finally { setLlmTestBusy(false); }
      };

      /** 投递实验：验证"插件能否投一条输入并触发主模型跑一轮"。 */
      const runInboxProbe = async () => {
        const { session } = probeTarget();
        setLlmTestBusy(true);
        try {
          const value = await api('/inbox-probe', { method: 'POST', body: JSON.stringify({ session }) });
          setLlmTest({ kind: 'probe', ok: value.appended === true, ms: 0, text: value.expect ?? '', route: null, hint: '' });
        } catch (e) {
          setLlmTest({ kind: 'probe', ok: false, ms: 0, code: String(e.message ?? e), hint: '（若提示拿不到会话对象：先随便发一条消息，再点一次）', route: null });
        } finally { setLlmTestBusy(false); }
      };

      /** 测试结果（按区块显示，紧跟在所测字段下方）。 */
      const renderLlmTest = (kind) => {
        if (llmTest === null || llmTest.kind !== kind) return null;
        if (kind === 'probe') {
          return h('div', { className: llmTest.ok ? 'dsm-ok' : 'dsm-warn' },
            llmTest.ok ? `已投递：${llmTest.text} —— 请看对话里是否出现「投递成功」` : `投递失败：${llmTest.code} ${llmTest.hint ?? ''}`);
        }
        return h('div', { className: llmTest.ok ? 'dsm-ok' : 'dsm-warn' },
          llmTest.ok
            ? `连接成功（${llmTest.ms} ms）· 路由 ${llmTest.route?.provider ?? '?'} / ${llmTest.route?.model ?? '?'} · 模型回了「${llmTest.text || '（没有输出文本，但连接是通的）'}」`
            : `连接失败：${llmTest.code} —— ${llmTest.hint}${llmTest.route === null ? '' : `（路由 ${llmTest.route.provider}/${llmTest.route.model}）`}`);
      };

      const llmStatus = overview?.llm ?? null;
      const llmEnabled = effective('llmAssistEnabled', false) === true;
      const assisted = (key, fallback) => (llmEnabled ? effective(key, fallback) === true : false);
      /**
       * 面板显示的"使用方式"。
       *
       * 以 `llmMode` 为准；但**旧设置文件里没有这个键**（早期版本用两对字段 + 三个开关），
       * 这时按旧状态反推，免得老用户打开面板看到"未启用"却其实在调用模型。
       */
      const llmMode = (() => {
        const stored = String(effective('llmMode', 'off') ?? 'off');
        if (stored === 'main' || stored === 'custom') return stored;
        if (llmEnabled !== true) return 'off';
        const provider = effective('llmIngestProvider', '') || effective('llmRecallProvider', '');
        const model = effective('llmIngestModel', '') || effective('llmRecallModel', '');
        return provider !== '' || model !== '' ? 'custom' : 'main';
      })();

      /* 已配置的提供方/型号（与官方「模型」页同源）：供下拉点选，仍可自由填写。
       * 放在这里是因为它要用到上面刚算出的 llmEnabled；hooks 仍是无条件调用。 */
      const [llmProviders, setLlmProviders] = React.useState([]);
      React.useEffect(() => {
        if (llmEnabled !== true) return undefined;
        let alive = true;
        api('/llm/providers')
          .then((value) => { if (alive) setLlmProviders(Array.isArray(value?.providers) ? value.providers : []); })
          .catch(() => { /* 取不到就只剩手填，不影响功能 */ });
        return () => { alive = false; };
      }, [llmEnabled]);
      const providerNames = llmProviders.map((item) => item.provider).filter((name) => typeof name === 'string' && name !== '');
      const modelNames = [...new Set(llmProviders.flatMap((item) => (Array.isArray(item.models) ? item.models : [])))];
      /**
       * 某提供方下的型号：选了 zhipu-glm 就只列 GLM 的那几个，不用在几十个型号里翻。
       * 提供方留空（跟随主模型）时列出全部已知型号；列表始终只是建议，仍可手填。
       */
      const modelsFor = (provider) => {
        const name = String(provider ?? '').trim();
        if (name === '') return modelNames;
        const hit = llmProviders.find((item) => item.provider === name);
        const list = Array.isArray(hit?.models) ? hit.models : [];
        return list.length > 0 ? list : modelNames;
      };

      if (settings === null) {
        return h('div', { className: 'dsm-root', 'data-dsh-plugin': 'super-memory' },
          h(Card, { title: '超级记忆' }, error ? h('div', { className: 'dsm-err' }, error) : h('div', { className: 'dsm-hint' }, '正在读取设置…')));
      }

      const workspaces = overview?.workspaces ?? [];
      const totals = overview?.totals ?? { libraryBytes: 0, trashBytes: 0 };
      const runtime = overview?.runtime ?? [];
      const hits = runtime.reduce((sum, r) => sum + r.hits, 0);
      const injected = runtime.reduce((sum, r) => sum + r.injectedTokensEst, 0);
      const enabled = effective('enabled', true);
      const recapCap = effective('compactionRecapMaxTokens', 300);
      const turnCap = effective('maxTokensPerTurn', 500);
      const itemsCap = effective('maxItems', 2);
      const charsCap = effective('maxCharsPerItem', 300);
      const workspaceNow = workspaces.find((w) => w.workspace === overview?.currentWorkspace) ?? workspaces[0] ?? null;
      const latestSession = workspaceNow?.sessions?.[0] ?? null;

      /* ④ 被保存的压缩内容：跨工作区平铺成一份编号列表（标题与 DSH 侧栏一致）。 */
      const savedRows = [];
      for (const workspace of workspaces) {
        for (const session of workspace.sessions) {
          savedRows.push({
            ...session,
            workspace: workspace.workspace,
            workspaceName: workspaceName(workspace.workspace),
          });
        }
      }
      savedRows.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));

      /* ⑤ 回收站：同样平铺。 */
      const trashRows = [];
      for (const workspace of workspaces) {
        for (const entry of trash[workspace.workspace] ?? []) {
          trashRows.push({ ...entry, workspace: workspace.workspace, workspaceName: workspaceName(workspace.workspace) });
        }
      }
      trashRows.sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')));

      /* 同名会话用短码互相区分（用户说的"系统编码"）。 */
      const titleCounts = new Map();
      for (const row of savedRows.concat(trashRows)) {
        const key = row.title ?? '';
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
      }

      /* 记忆里是对话原文：工作区若是 git 仓库又没忽略它，提交上去就不可逆 → 提醒 + 一键加规则 */
      const gitWarn = workspaces.find((w) => w.workspace === (overview?.currentWorkspace ?? '') && w.git?.gitRepo && !w.git?.ignoreRule)
        ?? workspaces.find((w) => w.git?.gitRepo && !w.git?.ignoreRule)
        ?? null;

      return h('div', { className: 'dsm-root', 'data-dsh-plugin': 'super-memory' },
        error ? h('div', { className: 'dsm-err' }, error) : null,
        notice ? h('div', { className: 'dsm-ok' }, notice) : null,

        /* ── 顶部：一句话 + 三步（细节收进「了解更多」） ─────────────────── */
        h(Card, {
          title: '超级记忆',
          extra: h('span', { className: 'dsm-badge' }, `设置来源：${settings.source === 'web' ? '面板覆盖' : '默认值'}${typeof overview?.build === 'string' ? ` · 构建 ${overview.build}` : ''}`),
        },
        h('div', { className: 'dsm-hint' },
          '超长会话被压缩几次之后，你早先定过的事就从上下文里消失了。这个插件在压缩那一刻把它存到本地，之后按需递回给模型。'),
        h(Steps, {
          items: [
            '压缩时：把被压掉的那段存到本地（摘要 + 对话原文）—— 0 token',
            `压缩后：注入一份目录级脉络，让新窗口不脱节 —— ≤ ${recapCap} token / 次`,
            `提问时：本地检索，命中才注入历史参考 —— 未命中 0，命中 ≤ ${turnCap} token`,
          ],
        }),
        h('div', { className: 'dsm-inline' },
          h('span', { className: 'dsm-hint' }, '历史只作参考，不作结论：你把方案 A 改成 B，回答以 B 为准并说明为什么变。'),
          h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenAbout((v) => !v) }, openAbout ? '收起说明' : '了解更多')),
        !openAbout ? null : h('div', { className: 'dsm-hint' },
          `细节：原文入库只保留你和助手的文字（不含深度思考、工具调用与工具结果）；检索全程在本地做词法匹配，0 模型调用、不联网、不改写你的对话内容，也不会动 DSH 的原始会话日志；逐字原文只在你说"查原文"时才由 history_read 工具读取。`
          + `范围是同一个会话内、跨压缩——换会话不共享，跨会话记忆不在本插件范围内。参数上限：${itemsCap} 条 / 每条 ${charsCap} 字符 / 会话累计不超过窗口的 2%。`
          + `记忆存在会话所属工作区的 .dsh-compaction-memory 目录里；只有设置与诊断日志是全局的（⑥ 里能看到它们的实际路径）。`),
        h('div', { className: 'dsm-sec' },
          h(SwitchRow, {
            label: '启用「超级记忆」',
            hint: '总开关。关掉 = 不写入本地、不注入任何内容，等于没装（本地已有数据不动）。',
            checked: enabled,
            onChange: (value) => patch({ enabled: value }),
          })),
        h('div', { className: 'dsm-totals' },
          h('span', null, `记忆库占用：${bytes(totals.libraryBytes)}`),
          h('span', null, `回收站占用：${bytes(totals.trashBytes)}`),
          h('span', null, `本进程命中 ${hits} 次 / 估算注入 ${injected} token`),
          h('span', null, `工作区 ${workspaces.length} 个`)),

        /* ── ① 压缩时：入库 ──────────────────────────────────────────── */
        h(Board, {
          no: '①',
          title: '压缩时：把被压掉的内容存到本地',
          subtitle: '记忆的来源：压缩一发生就自动把被压掉的对话文字、以及模型读过的文件/检索结果存进本工作区，不需要你做任何事。',
          cost: '0 token',
          costKind: 'free',
          dim: !enabled,
          extra: h('span', { className: 'dsm-badge' }, `本工作区 ${latestSession ? `${latestSession.blocks} 条` : '暂无数据'}`),
        },
        h(SwitchRow, {
          label: '摘要入库（L1）',
          hint: '把每次压缩时 DSH 已经生成好的摘要按标题切块存下来。检索首选：短、准、结论级。',
          checked: effective('ingestSummary', true),
          onChange: (value) => patch({ ingestSummary: value }),
          disabled: !enabled,
        }),
        h(SwitchRow, {
          label: '原文入库（L2）',
          hint: '把被压掉那段的对话原文也存下来，只保留用户提问与助手回答的文字（不含深度思考、工具调用与工具结果）。摘要没写到的细节靠它兜底。',
          checked: effective('ingestRawText', true),
          onChange: (value) => patch({ ingestRawText: value }),
          disabled: !enabled,
        }),
        h('div', { className: 'dsm-hint' },
          '只占本地磁盘，不花 token、不调用模型。关掉哪层就只跳过哪层，已有数据保留、仍可检索；但关着的那段时间是**真的漏记**，重新打开也补不回来。'),
        latestSession
          ? h('div', { className: 'dsm-hint' },
            `最近入库：${latestSession.title || '(无主题)'} · ${latestSession.blocks} 条（摘要 ${latestSession.summaryBlocks} / 原文 ${latestSession.rawBlocks}）· ${bytes(latestSession.bytes)} · ${shortTime(latestSession.updatedAt)}`)
          : h('div', { className: 'dsm-hint' }, '这个工作区还没有压缩记忆：等这个会话第一次被压缩后，这里就会显示入库情况。')),

        /* ── ② 压缩后：总览 ──────────────────────────────────────────── */
        h(Board, {
          no: '②',
          title: '压缩后：注入一份脉络总览',
          subtitle: '压缩把上下文换成了摘要，这一步顺手塞回一张"目录"，让压缩后的新窗口知道此前聊过什么。',
          cost: `≤ ${recapCap} token / 次压缩`,
          costKind: recapCap > 0 ? 'capped' : 'free',
          dim: !enabled,
          extra: h('button', { className: 'dsm-btn dsm-btn-sm', onClick: runRecapPreview }, '预览它会注入什么'),
        },
        h(SwitchRow, {
          label: '压缩后注入总览',
          hint: '压缩完成后，新窗口开场带一份「本会话此前脉络」（目录级）。关掉则压缩后不注入任何东西，本地入库不受影响。',
          checked: effective('injectRecap', true),
          onChange: (value) => patch({ injectRecap: value }),
          disabled: !enabled,
        }),
        h(NumberRow, {
          label: '总览上限', suffix: 'token', value: recapCap, min: 0, max: 2000,
          hint: '0 = 不注入总览（相当于关掉功能 2，但仍照常入库）。这是天花板不是配额：挑不出值得留的就完全不注入（0 token）。',
          onCommit: (value) => patch({ compactionRecapMaxTokens: value }),
        }),
        h(SwitchRow, {
          label: '总览在本次压缩窗口内保持稳定',
          hint: '开（推荐）：总览在窗口内文本不变，只追加一次上下文快照、能吃前缀缓存，而且整段窗口都看得到。关：压缩后只注入一轮，下一轮就消失（会多追加一次快照）。',
          checked: effective('recapPersist', true),
          onChange: (value) => patch({ recapPersist: value }),
          disabled: !enabled,
        }),
        search !== null
          ? h('div', null,
            h('div', { className: 'dsm-hint' }, '总览预览（与上面的试检索共用一次计算）：'),
            h('pre', { className: 'dsm-pre' }, (search.recap?.text ?? '') === ''
              ? '（目前挑不出可留的结论 → 压缩后不注入，0 token）'
              : `${search.recap.text}\n\n—— ${search.recap.tokens} token / ${search.recap.lines} 行`))
          : null),

        /* ── ③ 提问时：检索并注入参考 ────────────────────────────────── */
        h(Board, {
          no: '③',
          title: '提问时：检索历史，命中才参考',
          subtitle: '每轮提问先在本地比一次关联性。不相干就当没这回事，正常回答、不多花一分钱。',
          cost: `未命中 0；命中 ≤ ${turnCap} token / 轮`,
          costKind: 'capped',
          dim: !enabled,
        },
        h(SwitchRow, {
          label: '提问时注入记忆',
          hint: `命中才注入「参考」块（≤ ${itemsCap} 条 / 每条 ≤ ${charsCap} 字符 / 合计 ≤ ${turnCap} token）。未命中什么都不注入，连上下文快照都不会变。`,
          checked: effective('injectRecall', true),
          onChange: (value) => patch({ injectRecall: value }),
          disabled: !enabled,
        }),
        h(NumberRow, {
          label: '命中阈值 minScore', suffix: '', value: effective('minScore', 0.28), min: 0, max: 1, step: 0.01,
          hint: '低于它一个字都不注入。本机实测：相关历史问题约 0.7–1.5，不相关问题约 0.05–0.15，默认 0.28 分得很开。调高更保守（更省、可能漏），调低更容易命中（更全、可能多花）。',
          onCommit: (value) => patch({ minScore: value }),
        }),
        h(NumberRow, {
          label: '单轮注入上限', suffix: 'token', value: turnCap, min: 0, max: 4000,
          hint: '命中一次最多占多少上下文。0 = 命中也不注入（相当于只看功能 2 的总览）。',
          onCommit: (value) => patch({ maxTokensPerTurn: value }),
        }),
        h(NumberRow, {
          label: '单轮最多条数', suffix: '条', value: itemsCap, min: 0, max: 5,
          hint: '只有最高分明显高于第二条时才取 2 条，否则只 1 条（宁少勿多）。0 = 不注入。',
          onCommit: (value) => patch({ maxItems: value }),
        }),
        h(NumberRow, {
          label: '每条最大字符', suffix: '字符', value: charsCap, min: 100, max: 1000,
          hint: '越小越省，越可能丢条件。超出会在句边界截断并加省略号。',
          onCommit: (value) => patch({ maxCharsPerItem: value }),
        }),
        h(SwitchRow, {
          label: '参考块在本窗口内保持显示',
          hint: '开（推荐，更省）：命中过的「参考」块在本次压缩窗口内一直挂着。关掉的话，下一次未命中会把它撤掉——整份运行上下文快照的文本随之变化，DSH 会再追加一份（实测约 1054 字符 ≈ 252 token）。挂着的块不重复计费。',
          checked: effective('stickyRecall', true),
          onChange: (value) => patch({ stickyRecall: value }),
          disabled: !enabled,
        }),
        h(SwitchRow, {
          label: '指纹去重',
          hint: '同一个块永不重复注入；连续两轮同话题也不重复注入。',
          checked: effective('dedupe', true),
          onChange: (value) => patch({ dedupe: value }),
          disabled: !enabled,
        }),
        h('div', { className: 'dsm-sec' },
          h('div', { className: 'dsm-inline' },
            h('input', {
              className: 'dsm-input', placeholder: '自检：输入一个旧话题的关键词，看看现在会不会命中…', value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') runSearch(); },
            }),
            h('button', { className: 'dsm-btn', onClick: runSearch }, '试检索'),
            h('button', { className: 'dsm-btn', onClick: () => { setSearch(null); setQuery(''); } }, '清除')),
          search !== null
            ? h('div', null,
              h('div', { className: 'dsm-hint' }, `命中层级 tier=${search.tier}  top=${Number(search.topScore ?? 0).toFixed(3)}  second=${Number(search.secondScore ?? 0).toFixed(3)}  minScore=${search.minScore}`),
              h('pre', { className: 'dsm-pre' }, (search.wouldInject?.text ?? '') === ''
                ? '（未命中：不会注入任何东西，0 token）'
                : `${search.wouldInject.text}\n\n—— ${search.wouldInject.tokens} token / ${search.wouldInject.items} 条`))
            : h('div', { className: 'dsm-hint' }, '试检索只读本地记忆，不调用模型、不产生任何注入，随便试。')),

        /* 未命中诊断界面已移除（2026-10-07，用户决定）：
         * 用户不需要知道"内容没进库 / 在库里没排上来 / 还在被压掉的原文里" ——
         * 那是**我们的**排障信息（诊断日志里本来就有：入库条数、每次未命中的 reason 码）；
         * 用户真正的问题是"这段到底聊没聊过"，而他点 ✕ 时辅助模型会直接回答这个问题
         * （有就翻出来重答，没有就说没聊过）。宿主侧的 `/diagnose` 路由保留，
         * 供 ✕ 的模型路径复用。 */

        /* ── ④ 被保存的压缩内容 ──────────────────────────────────────── */
        h(Board, {
          no: '④',
          title: '被保存的压缩内容',
          subtitle: '每次上下文被压缩，被压掉的那段就存到这里。列表标题与 DSH 左侧会话列表里的标题一致，方便对上号。',
          cost: '只占本地磁盘',
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenLibrary((v) => !v) }, openLibrary ? '收起' : '展开'),
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => { refresh(); workspaces.forEach((w) => loadTrash(w.workspace)); } }, '刷新')),
        },
        !openLibrary ? null : h(React.Fragment, null,
          gitWarn === null ? null : h('div', { className: 'dsm-warn' },
            `这个工作区是 git 仓库，而记忆目录还没被忽略：记忆里存的是**对话原文**，一旦提交上去就收不回来。建议把 `
            + `${gitWarn.git?.rule ?? '.dsh-compaction-memory/'} 加进它的 .gitignore。`),
          gitWarn === null ? null : h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => doAddIgnoreRule(gitWarn.workspace) }, '帮我加忽略规则'),
            h('span', { className: 'dsm-mono' }, gitWarn.workspace)),
          h('div', { className: 'dsm-hint' },
            `存在会话所属工作区的 ${current?.storeDir ?? '.dsh-compaction-memory'} 目录里，换工作区互不可见；删除只影响该工作区，绝不会碰 DSH 原始会话日志。「浏览」会在文件管理器里定位该会话的记忆文件。`),

          h(NumberRow, {
            label: '删除保护期', suffix: '天', value: effective('protectRecentDays', 7), min: 0, max: 365,
            hint: '最近 X 天内更新过的会话，**整会话删除**会被拦住（判定取记忆最后写入时间与会话日志 mtime 中较新者）；删单条不受限制，方便你直接剔除某一两条。填 0 = 不做任何保护，连今天刚用过的工作区也能整会话删掉。',
            warnZero: true,
            onWarnZero: (value) => { setPending({ protectRecentDays: value }); setConfirmZero(true); },
            onCommit: (value) => patch({ protectRecentDays: value }),
          }),
          confirmZero
            ? h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-card-body' },
                h('div', { className: 'dsm-warn' }, '你将可以删除任何会话的压缩记忆，包括今天还在用的。删除后该会话的历史检索会立即失效（仍可在回收站还原）。'),
                h('div', { className: 'dsm-inline' },
                  h('button', {
                    className: 'dsm-btn dsm-btn-danger',
                    onClick: () => { setConfirmZero(false); if (pending) patch(pending); setPending(null); },
                  }, '我明白，设为 0'),
                  h('button', { className: 'dsm-btn', onClick: () => { setConfirmZero(false); setPending(null); } }, '取消'))))
            : null,

          savedRows.length === 0
            ? h('div', { className: 'dsm-hint' }, '还没有保存过内容：等某个会话第一次被压缩，这里就会出现它（标题与 DSH 左侧列表一致）。')
            : h('div', null, savedRows.map((row, index) => h('div', { className: 'dsm-item', key: row.sessionId },
              h('span', { className: 'dsm-no' }, `${index + 1}.`),
              h('div', { className: 'dsm-item-body' },
                h('div', { className: 'dsm-item-head' },
                  h('span', { className: 'dsm-item-title' }, row.title || '(无标题会话)'),
                  titleCounts.get(row.title) > 1 ? h('span', { className: 'dsm-mono' }, `#${row.shortId}`) : null,
                  h('span', { className: 'dsm-badge' }, row.workspaceName),
                  row.protected ? h('span', { className: 'dsm-badge dsm-badge-lock' }, `保护中·${row.protectDaysLeft} 天`) : null),
                h('div', { className: 'dsm-item-foot' },
                  h('span', { className: 'dsm-mono' },
                    `${relTime(row.activityAt ?? row.updatedAt)}前更新 · 已压缩 ${row.compactions} 轮 · ${[
                      row.summaryBlocks > 0 ? `摘要 L1 ${row.summaryBlocks} 块` : '',
                      row.rawBlocks > 0 ? `原文 L2 ${row.rawBlocks} 块` : '',
                    ].filter(Boolean).join(' + ') || '无分层信息'} · ${bytes(row.bytes)}`),
                  h('span', { className: 'dsm-inline' },
                    h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => doReveal(row.workspace, row.sessionId) }, '浏览'),
                    h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => loadBlocks(row.workspace, row.sessionId, row.title) }, '明细'),
                    h('button', {
                      className: 'dsm-btn dsm-btn-sm dsm-btn-danger',
                      disabled: row.protected,
                      title: row.protected ? '在保护期内，先把上面的保护期改成 0' : '',
                      onClick: () => setConfirmDelete({ workspace: row.workspace, sessionId: row.sessionId }),
                    }, '删除'))))))),

          confirmDelete
            ? h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-card-body' },
                h('div', { className: 'dsm-warn' }, `确认删除会话 ${confirmDelete.sessionId} 的全部压缩记忆？删除后该会话的历史检索立即失效${effective('trashEnabled', true) ? '（可在回收站还原）' : '（回收站已关闭，不可还原）'}。DSH 原始会话日志不受影响。`),
                h('div', { className: 'dsm-inline' },
                  h('button', { className: 'dsm-btn dsm-btn-danger', onClick: () => doDelete(confirmDelete) }, '确认删除'),
                  h('button', { className: 'dsm-btn', onClick: () => setConfirmDelete(null) }, '取消'))))
            : null,

          detail !== null
            ? h(Card, {
              title: `记忆明细：${detail.title || detail.sessionId}`,
              extra: h('div', { className: 'dsm-inline' },
                h('span', { className: 'dsm-badge' }, `${detail.blocks.length} 条`),
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setDetail(null) }, '收起')),
            },
            h('div', { className: 'dsm-hint' },
              '这些是插件存下来的检索单元（标题来自压缩摘要的小节名），平时不用看，看不懂可以直接忽略：想看原始文件请用上面的「浏览」。删除单条只影响这一块，下次提问就检索不到它了。'),
            detail.blocks.length === 0
              ? h('div', { className: 'dsm-hint' }, '（没有条目）')
              : detail.blocks.map((block) => h('div', { className: 'dsm-block', key: `${block.fp}-${block.index}` },
                h('div', { className: 'dsm-block-body' },
                  h('div', null,
                    h('span', { className: 'dsm-badge' }, block.layer === 'raw' ? '原文 L2' : '摘要 L1'),
                    ' ',
                    h('span', { className: 'dsm-label' }, block.title || '(无主题)')),
                  h('div', { className: 'dsm-mono' }, `${shortTime(block.at)} · ${block.chars} 字符 · ${(block.keywords ?? []).slice(0, 6).join(' / ')}`),
                  h('div', { className: 'dsm-pre', style: { maxHeight: 140 } }, block.preview)),
                h('button', {
                  className: 'dsm-btn dsm-btn-sm dsm-btn-danger',
                  onClick: () => doDelete({ workspace: detail.workspace, sessionId: detail.sessionId, fps: [block.fp] }),
                }, '删除'))))
            : null)),

        /* ── ⑤ 回收站 ───────────────────────────────────────────────── */
        h(Board, {
          no: '⑤',
          title: '回收站',
          subtitle: '删掉的记忆先放到这里，可以还原；确认不要了再清空——清空才真正释放磁盘空间。',
          cost: '只占本地磁盘',
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => { refresh(); workspaces.forEach((w) => loadTrash(w.workspace)); } }, '读取回收站'),
            confirmPurge
              ? h(React.Fragment, null,
                h('span', { className: 'dsm-warn' }, '清空全部回收站？'),
                h('button', { className: 'dsm-btn dsm-btn-sm dsm-btn-danger', onClick: () => doPurge(null) }, '确认清空'),
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setConfirmPurge(false) }, '取消'))
              : h('button', { className: 'dsm-btn dsm-btn-sm dsm-btn-danger', onClick: () => setConfirmPurge(true) }, '清空回收站')),
        },
        trashRows.length === 0
          ? h('div', { className: 'dsm-hint' }, '回收站是空的。删除的会话会先来这里，默认保留 7 天后自动清空（可在下面改）。')
          : h('div', null, trashRows.map((entry, index) => h('div', { className: 'dsm-item', key: entry.id },
            h('span', { className: 'dsm-no' }, `${index + 1}.`),
            h('div', { className: 'dsm-item-body' },
              h('div', { className: 'dsm-item-head' },
                h('span', { className: 'dsm-item-title' }, entry.title || '(无标题会话)'),
                titleCounts.get(entry.title) > 1 ? h('span', { className: 'dsm-mono' }, `#${entry.shortId}`) : null,
                h('span', { className: 'dsm-badge' }, entry.workspaceName)),
              h('div', { className: 'dsm-item-foot' },
                h('span', { className: 'dsm-mono' },
                  `${relTime(entry.deletedAt)}前删除（手动删除）· ${entry.blocks} 条 · ${bytes(entry.bytes)}`),
                h('span', { className: 'dsm-inline' },
                  h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => doRestore(entry.workspace, entry.id) }, '还原'),
                  h('button', {
                    className: 'dsm-btn dsm-btn-sm dsm-btn-danger',
                    onClick: () => setConfirmTrashDelete(entry),
                  }, '彻底删除'))))))),
        h('div', { className: 'dsm-sec' },
          h('div', { className: 'dsm-label' }, '回收站设置'),
          h(SwitchRow, {
            label: '删除先进回收站',
            hint: '关掉 = 删除即永久删除，无法还原。',
            checked: effective('trashEnabled', true),
            onChange: (value) => patch({ trashEnabled: value }),
          }),
          h(SwitchRow, {
            label: '回收站自动清空',
            hint: '关掉 = 永不自动清空，只能手动清。',
            checked: effective('trashAutoPurgeEnabled', true),
            onChange: (value) => patch({ trashAutoPurgeEnabled: value }),
          }),
          h(NumberRow, {
            label: '回收站保留天数', suffix: '天', value: effective('trashAutoPurgeDays', 7), min: 1, max: 365,
            hint: '仅在上面的开关打开时生效，最少 1 天。',
            onCommit: (value) => patch({ trashAutoPurgeDays: value }),
          }))),

        confirmTrashDelete !== null
          ? h('div', { className: 'dsm-card' },
            h('div', { className: 'dsm-card-body' },
              h('div', { className: 'dsm-warn' }, `彻底删除「${confirmTrashDelete.title || confirmTrashDelete.sessionId}」在回收站里的内容？这是永久删除、不能还原（DSH 原始会话日志不受影响）。`),
              h('div', { className: 'dsm-inline' },
                h('button', { className: 'dsm-btn dsm-btn-danger', onClick: () => doTrashDelete(confirmTrashDelete) }, '确认彻底删除'),
                h('button', { className: 'dsm-btn', onClick: () => setConfirmTrashDelete(null) }, '取消'))))
          : null,

        /* ── ⑥ 诊断与高级（默认折叠） ─────────────────────────────────── */
        h(Card, {
          title: '⑥ 诊断与高级（一般不用动）',
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: refreshDiag }, '读取打分日志'),
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenAdvanced((v) => !v) }, openAdvanced ? '收起' : '展开')),
        },
        h('div', { className: 'dsm-hint' },
          '排障用：看它到底检索到了什么、为什么没命中、注入了多少 token。展开后还有少数几个检索参数与路径信息。'),
        !openAdvanced ? null : h(React.Fragment, null,
          h('div', { className: 'dsm-hint' },
            `本进程：命中 ${hits} 次 / 未命中 ${runtime.reduce((s, r) => s + r.misses, 0)} 次 / 估算注入 ${injected} token`),
          /* 额度用尽必须显性提示：否则用户只会觉得"这插件后来就不灵了" */
          runtime.some((r) => r.budgetExhausted)
            ? h('div', { className: 'dsm-warn' },
              `本会话的「提问时注入」额度已用尽（累计注入达到上限）—— 它不会再注入历史参考，`
              + `但「压缩后总览」不受此限、仍在工作。想恢复：重启 DSH，或在 ③ 里把「会话累计上限」调大（关掉本次会话的计数）。`)
            : null,
          runtime.some((r) => r.budgetOff)
            ? h('div', { className: 'dsm-warn' }, '「会话累计上限」当前为 0 → 全部自动注入已关闭（等于停用功能 ②③）。')
            : null,
          runtime.length > 0
            ? h('pre', { className: 'dsm-pre', style: { maxHeight: 140 } },
              runtime.map((r) => {
                const budget = r.budgetTokens === null
                  ? (r.budgetOff ? '额度：已关闭' : '额度：待首次检索后可知')
                  : `额度：${r.budgetUsedTokens} / ${r.budgetTokens} token${r.budgetExhausted ? '（已用尽）' : ''}`;
                return `${r.sessionId}  命中 ${r.hits} / 未命中 ${r.misses} / 注入 ≈${r.injectedTokensEst} token / 已知压缩 ${r.knownCompactions} 次 / ${budget}`;
              }).join('\n'))
            : null,
          h(SwitchRow, {
            label: '写打分日志',
            hint: `每次提问写一行本地日志（不是记忆内容）：命中与否、分数、注入字符数与估算 token。它是"未命中 = 0 token"最直接的证据。文件：${diag?.diagPath ?? '（点上面的"读取打分日志"后显示）'}`,
            checked: effective('logScores', true),
            onChange: (value) => patch({ logScores: value }),
          }),
          h(SwitchRow, {
            label: '启动时回填本会话已有的压缩',
            hint: '插件往往在会话中途才装上；打开这个开关，会把当前会话里已经发生过的压缩摘要补进本地库（0 token、不读原始日志文件）。',
            checked: effective('backfillOnStart', true),
            onChange: (value) => patch({ backfillOnStart: value }),
          }),
          h('div', { className: 'dsm-sec' },
            h(NumberRow, {
              label: '查询携带最近几条提问', suffix: '条', value: effective('observationTurns', 3), min: 1, max: 8,
              hint: '像「那这个呢」这种指代型短问句，必须带上前面几轮的话题词才检索得到。',
              onCommit: (value) => patch({ observationTurns: value }),
            }),
            h(SwitchRow, {
              label: '先摘要块（L1）再看原文块（L2）',
              hint: '开（推荐）：摘要命中即结论级参考，短而准；不够再用原文兜底。关：两层一起比分数。',
              checked: effective('preferSummaryChunks', true),
              onChange: (value) => patch({ preferSummaryChunks: value }),
            })),
          h('div', { className: 'dsm-sec' },
            h(NumberRow, {
              label: '会话累计上限', suffix: '× 窗口', value: effective('sessionBudgetRatio', 0.02), min: 0, max: 0.5, step: 0.005,
              hint: '单个会话累计注入不超过上下文窗口的这个比例（1M 窗口 × 2% ≈ 20K token，压缩后总览也计入）。0 = 关闭全部自动注入。',
              onCommit: (value) => patch({ sessionBudgetRatio: value }),
            })),
          diag === null
            ? null
            : h('pre', { className: 'dsm-pre' }, (diag.recent ?? []).slice(-24).reverse()
              .map((entry) => JSON.stringify(entry)).join('\n') || '（暂无日志）'),
            h('div', { className: 'dsm-sec' },
              h(TextRow, {
                label: '记忆目录',
                hint: '相对路径 = 每个工作区各自一份（默认）；绝对路径 = 所有工作区集中存到一个目录（例如 D:\\dsh-memory）。不能包含 ..；改完对**新写入**生效，已有记忆不会自己搬家。',
                value: current?.storeDir ?? '.dsh-compaction-memory',
                placeholder: '.dsh-compaction-memory',
                onCommit: (value) => patch({ storeDir: value }),
              })),
            h('div', { className: 'dsm-sec' },
              h('div', { className: 'dsm-path' }, `记忆目录：<工作区>\\${current?.storeDir ?? '.dsh-compaction-memory'}\\<会话 id>.jsonl（记忆本体都在工作区里；卸载插件不会自动删除这些本地文件）`),
            h('div', { className: 'dsm-path' },
              `全局数据目录：${settings.dataHome?.dir ?? '—'}`
              + (settings.dataHome?.source === 'env'
                ? `（来自环境变量 ${settings.dataHome.envName}）`
                : '（默认跟 DSH 配置同目录；想挪到别的盘，设环境变量 DSH_SUPER_MEMORY_HOME 指到任意目录）')),
            h('div', { className: 'dsm-path' }, `设置文件：${settings.settingsPath}`),
            h('div', { className: 'dsm-inline', style: { marginTop: 6 } },
              h('button', {
                className: 'dsm-btn',
                onClick: async () => {
                  try { setSettings(await api('/settings', { method: 'DELETE' })); refresh(); } catch (e) { setError(String(e.message ?? e)); }
                },
              }, '恢复默认设置'))))),

        /* ── ⑦ 模型辅助（可选；默认全关） ────────────────────────────── */
        h(Board, {
          no: '⑦',
          title: '模型辅助（可选）：让"换个说法"也能被想起',
          subtitle: '默认关闭 —— 不打开时插件与以前完全一样（本地、0 token）。打开后：压缩入库时给每块补几个"你以后可能怎么问它"的说法；检索不入时，可以点一下让模型把问题换成关键词。**提问本身永远是本地检索，不会因此变慢**。成本口径也随之更新：从"尽量不花钱"变成"在你选择的档位内严格控制成本"—— 用哪个模型、每次最多花多少，都由你定。',
          cost: '默认 0；开了按次计费',
          costKind: 'capped',
          dim: !enabled,
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenLlm((v) => !v) }, openLlm ? '收起' : '展开')),
        }),
        !openLlm ? h('div', { className: 'dsm-hint' },
          `当前：${llmEnabled ? '已启用' : '关闭'}${llmStatus?.usage?.cap > 0 ? ` · 今日已用 ${llmStatus.usage.calls} / ${llmStatus.usage.cap} 次` : ''}`)
          : h(React.Fragment, null,
            h('div', { className: 'dsm-warn' },
              '开启后，插件的这些内容会被发送到**你选择的模型服务**：① 压缩入库时：被压缩内容的摘要块/工具结果原文；'
              + '② 你点击"诊断"且开了改写时：你的提问原文与候选摘要。免费渠道通常会把请求内容用于改进模型，请自行确认服务条款。'
              + '想"开了但不出本机"：在 DSH 侧把提供方指向本地 Ollama / LM Studio 的 OpenAI 兼容地址即可（插件不直接连网）。'),
            // ── 只需要回答一个问题：要不要额外调用大模型来提高命中率 ──
            h(SelectRow, {
              label: '使用方式',
              hint: '只需要选这一次（两种时机一起生效：压缩入库时扩写关键词、你点击 ✕ 未命中诊断时改写查询）。',
              value: llmMode,
              options: [
                { value: 'off', label: '不调用大模型（默认，最省）' },
                { value: 'main', label: '调用主模型（命中率更高）' },
                { value: 'custom', label: '调用指定模型（成本自选）' },
              ],
              hideEmpty: true,
              onCommit: (value) => patch({ llmMode: value }),
            }),
            h('div', { className: 'dsm-hint' },
              llmMode === 'off'
                ? '当前：**纯本地**。提问零延迟、零 token；压缩后仍会注入总览与命中的参考，只是不做任何模型调用。'
                : (llmMode === 'main'
                  ? '当前：用**你的主模型**做"补可能的问法"与"把问题换成关键词"。提问本身仍是本地检索，不会因此变慢。'
                  : '当前：上面两处改用**你指定的模型**（例如主对话用 pro、这里用更便宜的 flash 省成本）。')),
            llmMode !== 'custom' ? null : h(React.Fragment, null,
              h(SelectRow, {
                label: '提供方',
                hint: '下拉里是**你已在「设置 → 模型」配好的**提供方（插件不存密钥、不自己连网）。',
                value: effective('llmProvider', '') || effective('llmIngestProvider', ''),
                options: providerNames, emptyHint: '（读不到清单：重启 DSH 后可点选）',
                onCommit: (value) => patch({ llmProvider: value, llmIngestProvider: value, llmRecallProvider: value }),
              }),
              h(SelectRow, {
                label: '模型',
                hint: '只列**所选提供方**的型号（选 zhipu-glm 就只列 GLM 系列）。',
                value: effective('llmModel', '') || effective('llmIngestModel', ''),
                options: modelsFor(effective('llmProvider', '') || effective('llmIngestProvider', '')),
                emptyHint: '（该提供方未公布型号清单）',
                onCommit: (value) => patch({ llmModel: value, llmIngestModel: value, llmRecallModel: value }),
              }),
              h('div', { className: 'dsm-inline' },
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => runLlmTest('ingest'), disabled: llmTestBusy || !llmEnabled }, llmTestBusy ? '测试中…' : '测试连接')),
              renderLlmTest('ingest')),
            h('div', { className: 'dsm-hint' },
              '命中率的提升来自两处，都随上面这一次选择一起开关：① 压缩入库时给每块补几个"你以后可能怎么问它"的说法；'
              + '② 你点击「✕ 未命中诊断」时，让模型先把问题换成关键词，再走一遍本地检索。'),
            h('div', { className: 'dsm-hint' },
              llmStatus === null
                ? '（读不到模型服务状态）'
                : `模型服务：${llmStatus.serviceAvailable ? '可用' : '不可用（DSH 没提供 llm 服务）'}`
                  + ` · 今日调用 ${llmStatus.usage.calls}${llmStatus.usage.cap > 0 ? ` / ${llmStatus.usage.cap}` : '（不限）'} 次`
                  + (llmStatus.cooldownUntil === null ? '' : ` · 暂停中至 ${new Date(llmStatus.cooldownUntil).toLocaleTimeString()}`)
                  + (llmStatus.lastFailure === null ? '' : ` · 上次失败：${llmStatus.lastFailure.code}`)),
            h('div', { className: 'dsm-hint' },
              llmProviders.length > 0
                ? `可点选的提供方（来自你在「设置 → 模型」里配好的）：${providerNames.join(' / ') || '（无）'}`
                : '读不到已配置的提供方清单 —— 若你刚更新过插件，重启 DSH 后这里会出现可点选的清单。'),
            h('div', { className: 'dsm-sec' },
              h('div', { className: 'dsm-label' }, '调用参数（一般不用改）'),
              h(NumberRow, {
                label: '入库调用超时', suffix: 'ms', value: effective('llmIngestTimeoutMs', 8000), min: 1, max: 300000,
                hint: '超过就主动放弃这一次（不会等它自然结束），原有词频照旧。',
                onCommit: (value) => patch({ llmIngestTimeoutMs: value }),
              }),
              h(NumberRow, {
                label: '每批块数', suffix: '块', value: effective('llmIngestBatchBlocks', 5), min: 1, max: 50,
                hint: '一次调用处理几块，省调用次数。一次压缩 15 块 ≈ 3 次调用。',
                onCommit: (value) => patch({ llmIngestBatchBlocks: value }),
              }),
              h(NumberRow, {
                label: '检索调用超时', suffix: 'ms', value: effective('llmRecallTimeoutMs', 4000), min: 1, max: 300000,
                hint: '你在等结果，所以这里给的时间更短。',
                onCommit: (value) => patch({ llmRecallTimeoutMs: value }),
              })),
            h('div', { className: 'dsm-sec' },
              h('div', { className: 'dsm-label' }, '成本与缓存'),
              h(NumberRow, {
                label: '每日调用上限', suffix: '次', value: effective('llmDailyCallCap', 200), min: 0, max: 100000,
                hint: '到上限就静默停用到次日（面板会显示原因），避免免费额度被打爆。0 = 不限。',
                onCommit: (value) => patch({ llmDailyCallCap: value }),
              }),
              h(SwitchRow, {
                label: '相同输入不重复调用',
                hint: '改写结果按提问哈希缓存（落盘在全局数据目录，30 天有效，最多 200 条）。',
                checked: effective('llmCacheEnabled', true) === true,
                onChange: (value) => patch({ llmCacheEnabled: value }),
                disabled: !llmEnabled,
              }),
              h(NumberRow, {
                label: '单次输出上限', suffix: 'token', value: effective('llmIngestMaxTokens', 600), min: 1, max: 8000,
                hint: '入库扩写的输出上限（要求模型返回严格 JSON，格式不对就整批丢弃、保留原词）。',
                onCommit: (value) => patch({ llmIngestMaxTokens: value }),
              }),
              h('div', { className: 'dsm-hint' },
                '**思考强度 / 是否推理**不在这里设 —— 到「设置 → 模型」里对该型号设置（那才是它真正的归属）。'
                + '插件不会覆盖你在那边的声明，也**不会继承主对话的 max**（否则辅助调用又慢又贵）。'),
              h('div', { className: 'dsm-hint' },
                '插件**不自己连网、不自己存密钥**：所有提供方（含免费渠道与本地 Ollama / LM Studio）都在 DSH 侧登记，'
                + '这里只填 provider 与 model 两个名字。调用留痕（只有元数据，没有内容）写在全局数据目录的 dsh-super-memory.llm.jsonl。'))))));
    }

    /* ─────────────────────────── 插件入口 ─────────────────────────── */
    /** 错误边界：面板里任何渲染异常都只显示一行提示，不让整个设置分节变成空白。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dsm-root', 'data-dsh-plugin': 'super-memory' },
            h('div', { className: 'dsm-card' },
              h('div', { className: 'dsm-card-head' }, '超级记忆'),
              h('div', { className: 'dsm-card-body' },
                h('div', { className: 'dsm-err' }, `面板渲染出错：${String(this.state.error?.message ?? this.state.error)}`),
                h('div', { className: 'dsm-hint' }, '插件本身仍在工作（入库与注入由宿主半边负责）；打开浏览器控制台可以看到完整堆栈。'),
                h('button', {
                  className: 'dsm-btn',
                  onClick: () => this.setState({ error: null }),
                }, '重试'))));
        }
        return this.props.children;
      }
    }

    /**
     * 「✕」的结果（跨槽位共享）：按钮在 `assistant-actions`，结果显示在
     * `conversation.chat.turnTail`（同一轮的末尾）—— 两个槽位是不同组件实例，
     * 所以用模块级小仓库 + 订阅把结果传过去。
     */
    const MISS_RESULTS = new Map();
    const MISS_LISTENERS = new Map();
    function publishMiss(sessionId, value) {
      MISS_RESULTS.set(sessionId, value);
      for (const listener of MISS_LISTENERS.get(sessionId) ?? []) {
        try { listener(value); } catch { /* 单个订阅者出错不影响别人 */ }
      }
    }
    function subscribeMiss(sessionId, listener) {
      if (!MISS_LISTENERS.has(sessionId)) MISS_LISTENERS.set(sessionId, new Set());
      MISS_LISTENERS.get(sessionId).add(listener);
      return () => { MISS_LISTENERS.get(sessionId)?.delete(listener); };
    }

    /**
     * 会话内那一块：**点 ✕ 之后直接在对话里出现**（用户要求：不要弹窗，就在会话窗口里回答）。
     *
     * 插件无法往会话里"发一条消息"（已实测：会话句柄没有 append 能力），
     * 但可以在**这一轮末尾**渲染一块内容 —— 用户看到的效果与"点完就得到回应"一致。
     */
    function MissTail({ sessionId, openFile }) {
      const [result, setResult] = React.useState(() => MISS_RESULTS.get(sessionId) ?? null);
      const [expanded, setExpanded] = React.useState(false);
      // 这一块只属于**点 ✕ 的那一轮**：组件是那一轮挂载的，
      // 结果如果产生得更早（上一轮留下的），就是陈旧数据 —— 直接清掉不再显示。
      // （用户实测到的现象：上一个问题点 ✕，那块却跟到了下一个问题下面。）
      const mountedAt = React.useRef(Date.now()).current;
      React.useEffect(() => subscribeMiss(sessionId, setResult), [sessionId]);
      if (result === null) return null;
      if (typeof result.at === 'number' && result.at < mountedAt) {
        publishMiss(sessionId, null);
        return null;
      }
      const excerpt = String(result.excerpt ?? '');
      return h('div', { className: 'dsm-miss-tail' },
        h('div', { className: 'dsm-inline' },
          h('strong', null, '超级记忆'),
          result.found
            ? h('span', { className: 'dsm-ok' }, `已用 ${result.model || '主模型'} 搜索已压缩的历史：找到相关内容`)
            : h('span', { className: 'dsm-warn' }, `已用 ${result.model || '主模型'} 搜索已压缩的历史：没有找到相关内容（可能确实没聊过）`),
          result.found && excerpt !== ''
            ? h('button', {
              className: 'dsm-btn dsm-btn-sm',
              // **在右侧栏打开**（槽位把 openFile 给了我们）——比在会话里摊一段
              // 机器格式的原文块友好得多（用户反馈：展开的原文像乱码）。
              onClick: () => {
                try {
                  if (typeof openFile === 'function' && result.file) openFile(result.file);
                  else setExpanded((v) => !v);
                } catch { setExpanded((v) => !v); }
              },
            }, '打开原文')
            : null,
          h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => publishMiss(sessionId, null) }, '知道了')),
        result.found && expanded && excerpt !== '' ? h('pre', { className: 'dsm-pre' }, excerpt) : null,
        result.found
          ? h('div', { className: 'dsm-hint' }, '资料已备好 —— **直接继续提问即可**（随口说一句也行），主模型会带着它重新回答。')
          : null,
        result.file ? h('div', { className: 'dsm-mono' }, `原始记忆文件：${result.file}`) : null);
    }

    /**
     * 会话内「没想起来？」按钮。
     *
     * 三条设计约束（都是用户明确要求的）：
     *   1. **只在会话发生过压缩后出现** —— 没压缩过的会话记忆库还是空的，
     *      按钮既没用又打扰；所以 `knownCompactions === 0` 时直接不渲染。
     *   2. **不点就等于没有这个插件** —— 按钮本身只做本地诊断（0 token、0 模型调用）；
     *      只有点了「用主模型再找一遍」才会调用一次模型。
     *   3. **图标不与官方点赞/点踩重复** —— 用 ✕，并带 aria-label 与 title。
     */
    function MissAction({ sessionId }) {
      const [open, setOpen] = React.useState(false);
      const [ready, setReady] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [report, setReport] = React.useState(null);
      const [note, setNote] = React.useState('');
      // 提示**必须会自己消失**（用户反馈：之前那条提示关不掉，一直挂在按钮上）
      React.useEffect(() => {
        if (note === '') return undefined;
        const timer = window.setTimeout(() => setNote(''), 5000);
        return () => window.clearTimeout(timer);
      }, [note]);

      // 探测：这个会话压缩过没有 + 上一条提问是什么（都是本地只读接口）
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        let alive = true;
        fetch(`${API}/diagnostics?limit=1`).then((r) => r.json()).then((body) => {
          if (!alive || body?.ok !== true) return;
          const row = (body.value.runtime ?? []).find((item) => item.sessionId === sessionId) ?? null;
          setReady(row === null ? null : {
            compactions: Number(row.knownCompactions ?? 0),
            workspace: row.workspace ?? '',
            lastQuery: row.lastQuery ?? '',
            hits: row.hits ?? 0,
            misses: row.misses ?? 0,
          });
        }).catch(() => { /* 宿主没起来就不显示按钮 */ });
        return () => { alive = false; };
      }, [sessionId]);

      // ⚠️ **所有 Hook 必须在提前 return 之前**：本组件有两个提前 return
      // （`ready === null` 的占位、`compactions <= 0` 时不渲染），而 `ready` 会在数据
      // 到达后从 null 变成对象 —— Hook 若放在 return 之后，两次渲染的 Hook 数量不一致，
      // React 抛 "Rendered more hooks than during the previous render"，组件整个崩掉
      // （实测现象：**✕ 按钮直接消失**）。
      const lastSeenQuery = React.useRef('');
      React.useEffect(() => {
        // **新问题一来就清掉上一轮的 ✕ 结果**，否则那块会跟到后面的轮次下面
        // （用户实测："上一个问题点 ✕，内容跟到了下一个问题下面"）。
        const now = String(ready?.lastQuery ?? '');
        if (now === '') return;
        if (lastSeenQuery.current === '') { lastSeenQuery.current = now; return; }
        if (now !== lastSeenQuery.current) {
          lastSeenQuery.current = now;
          publishMiss(sessionId, null);
        }
      }, [ready?.lastQuery, sessionId]);

      // 按钮**永远渲染**（读不到状态也要在，否则用户会以为插件坏了）。
      // 读不到状态时点它就直接问宿主 —— 宿主自己会从会话日志里取"上一个问题"。
      if (ready === null) {
        return h('div', { className: 'dsm-miss-wrap' },
          h('button', {
            className: 'dsm-miss-btn',
            title: '没想起来？让辅助大模型在已压缩的内容里再找一遍',
            'aria-label': '未命中：再查一遍',
            onClick: () => { if (busy !== true) run(true); },
          }, busy ? '…' : '✕'),
          note === '' ? null : h('div', { className: 'dsm-miss-pop', style: { width: 'min(360px, 70vw)' } },
            h('div', { className: 'dsm-hint' }, note)));
      }
      // 没压缩过的会话：记忆库是空的，不必打扰（用户要求过：压缩后才出现）
      if (ready.compactions <= 0) return null;

      // **必须是函数声明**（会提升）：上面的早返回分支已经引用 run，而 `const run = …`
      // 在它之后 —— 那会抛 TDZ 错误（"Cannot access 'run' before initialization"），
      // 表现就是"点 ✕ 完全没反应"（实测踩过，且被 try/catch 之外的路径吞掉）。
      async function run(allowModel) {
        // **必须 null-safe**：按钮现在永远渲染，但状态可能读不到（插件刚重启时就是这样）。
        // 之前这里直接读 `ready.workspace` → 抛错被静默吞掉，用户看到的就是"点了没反应"。
        const workspace = String(ready?.workspace ?? '');
        const query = String(ready?.lastQuery ?? '');
        setBusy(true);
        setNote('');
        try {
          const response = await fetch(`${API}/diagnose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-super-memory': '1' },
            body: JSON.stringify({ workspace, session: sessionId, query, limit: 8, rewrite: allowModel === true, boost: allowModel === true }),
          });
          const body = await response.json();
          if (body?.ok !== true) {
            setNote(`查找失败：${String(body?.error?.message ?? response.status)} —— 若提示"未知工作区"，先随便发一条消息（让插件见到本会话）再点 ✕`);
            return;
          }
          setReport(body.value);
          // boost：资料已排进"下一轮注入"。
          // **成功时不给任何面板提示** —— 用户明确要求：找没找到由主模型在会话窗口里回答。
          if (body.value?.boosting !== undefined) {
            setNote('');
            setOpen(false);
            // 结果直接放到**会话里**那一块（本轮末尾），不再弹面板提示
            const material = String(body.value.material ?? '');
            publishMiss(sessionId, {
              found: body.value.found === true,
              model: String(body.value.model || '').trim() || '主模型',
              excerpt: material,
              file: String(body.value.file ?? ''),
              at: Date.now(),
            });
            return;
          }
          // 旧宿主（还没重启）不认 boost：必须说清楚，否则点了像"没反应"（用户就是这么遇到的）
          if (allowModel === true && body.value?.material !== undefined) {
            setNote('宿主还是旧代码：请重启 DSH，之后点 ✕ 才会把资料排进下一轮');
            return;
          }
          if (allowModel === true && body.value?.assist?.rewrite != null && body.value.assist.rewrite.ok !== true) {
            setNote(`模型没帮上忙：${body.value.assist.rewrite.code} —— ${body.value.assist.rewrite.hint}`);
          }
        } catch (e) { setNote(String(e?.message ?? e)); } finally { setBusy(false); }
      };

      /** 兜底：复制资料（剪贴板不可用时让用户手动拿）。 */
      const copyMaterial = async () => {
        const material = String(report?.material ?? '');
        if (material === '') { setNote('没有可复制的资料'); return; }
        try {
          await navigator.clipboard.writeText(`【超级记忆】以下是从本会话"已压缩的历史"里找到的相关原文，请作为参考资料结合我新增的条件重新回答上一个问题：\n\n${material}`);
          setNote('已复制到剪贴板');
        } catch { setNote('复制失败，请手动选中下面的资料'); }
      };

      const pair = async (item, verdict) => {
        try {
          await fetch(`${API}/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-super-memory': '1' },
            body: JSON.stringify({ workspace: ready.workspace, session: sessionId, query: ready.lastQuery, fp: item.fp, verdict, score: item.score, title: item.title }),
          });
          setNote(verdict === 'hit' ? '已记为"就是这条"' : '已记为"也不对"');
        } catch (e) { setNote(String(e?.message ?? e)); }
      };

      return h('div', { className: 'dsm-miss-wrap' },
        h('button', {
          className: 'dsm-miss-btn',
          title: '没想起来？让辅助大模型在已压缩的内容里再找一遍（找到的资料会自动复制，粘贴发送即可）',
          'aria-label': '未命中：再查一遍',
          // 一次点击就开查（用户明确要求：不要"弹窗 + 再点一次"）
          onClick: () => { if (busy !== true) run(true); },
        }, busy ? '…' : '✕'),
        // 一行轻提示（不需要用户操作）：复制成功、或失败原因
        note === '' ? null : h('div', { className: 'dsm-miss-pop', style: { width: 'min(360px, 70vw)' } },
          h('div', { className: 'dsm-hint' }, note)),
        !open ? null : h('div', { className: 'dsm-miss-pop' },
          h('div', { className: 'dsm-inline' },
            h('strong', null, '没想起来？'),
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => run(true), disabled: busy }, busy ? '查找中…' : '再找一遍'),
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpen(false) }, '关闭')),
          h('div', { className: 'dsm-hint' },
            `本会话已压缩 ${ready.compactions} 轮 · 本地命中 ${ready.hits} / 未命中 ${ready.misses}。`
            + '点击会把这条提问发给**你配置的辅助模型**，由它把问题换成关键词后重新检索已压缩的内容（每个问题只在你点击时发一次）。'),
          // 没配辅助模型：**不**再弹一堆低分候选让人工挑，直接说明并引导去配置（用户明确要求）
          report !== null && report.assist?.rewrite == null
            ? h('div', { className: 'dsm-warn' },
              '现在插件没有配置辅助大模型，所以无法深入查找已压缩的内容。需要这个能力的话，'
              + '到「设置 → 超级记忆 → ⑦ 模型辅助」把「使用方式」选成"调用主模型"或"调用指定模型"，配好之后再点这个 ✕ 就能检索了。')
            : null,
          report === null || report.assist?.rewrite == null ? null : h(React.Fragment, null,
            h('div', { className: 'dsm-warn' }, `判定：${report.verdict} —— ${report.advice}`),
            h('div', { className: 'dsm-hint' },
              `查询词 ${report.queryTokens.total} 个，其中 ${report.queryTokens.present} 个在库里出现过；扫描 ${report.scanned.records} 条记忆块。`),
            report.assist?.rewrite == null ? null : h('div', { className: 'dsm-hint' },
              report.assist.rewrite.ok
                ? `改写结果${report.assist.rewrite.cached ? '（缓存）' : ''}：${report.assist.rewrite.terms.join(' / ')}`
                : `改写失败：${report.assist.rewrite.code} —— ${report.assist.rewrite.hint}`),
            ...(report.candidates ?? []).map((item) => h('div', { className: 'dsm-item', key: item.fp },
              h('div', { className: 'dsm-item-body' },
                h('div', { className: 'dsm-item-head' },
                  h('span', { className: 'dsm-item-title' }, `${item.score.toFixed(3)} · ${item.title || '(无标题)'}`),
                  item.src === 'tool' ? h('span', { className: 'dsm-tag' }, '工具结果') : null,
                  item.viaRewrite ? h('span', { className: 'dsm-tag' }, '改写得来') : null),
                h('div', { className: 'dsm-hint' }, item.preview)),
              h('div', { className: 'dsm-item-actions' },
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => pair(item, 'hit') }, '就是这条'),
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => pair(item, 'none') }, '也不对'))))),
          note === '' ? null : h('div', { className: 'dsm-hint' }, note)));
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.effect(() => mountStyles(), 'dsh-super-memory: styles');
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'super-memory',
        order: 26,
        label: () => '超级记忆',
      }, (props) => h(PanelBoundary, null, h(Panel, props)))), 'dsh-super-memory: settings section');
      // 会话内「没想起来？」入口。注册失败（宿主没有会话 UI）绝不能影响插件其余部分。
      ctx.effect(() => {
        try {
          return ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
            name: 'conversation.chat.assistant-actions',
            id: 'super-memory-miss',
            order: 30,
            inject: (sessionId) => ({ sessionId }),
          }, MissAction));
        } catch { return () => {}; }
      }, 'dsh-super-memory: miss action');
      // 点 ✕ 之后在**这一轮末尾**长出结果块（用户要求：不要弹窗，就在会话里回答）
      ctx.effect(() => {
        try {
          return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'super-memory-miss-tail',
            order: 30,
            inject: (sessionId) => ({ sessionId }),
          }, MissTail));
        } catch { return () => {}; }
      }, 'dsh-super-memory: miss tail');
    }

    return { inject, apply };
  },
});
