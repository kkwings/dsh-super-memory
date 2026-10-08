/**
 * dsh-super-memory — 客户端半边：设置 →「超级记忆」
 *
 * 面板分两层（2026-10-07 精简改版，用户要求"说人话"）：
 *   · 首屏：顶部三句话（它做什么 / 花不花 token / 我该做什么 + 边界声明），
 *     下面七个板块，每块只有标题 + 一行说明。
 *     ① 压缩时入库、② 压缩后总览、③ 提问时检索、④ 被保存的内容、
 *     ⑤ 回收站、⑥ 诊断与路径、⑦ 模型辅助（默认"不调用大模型"）。
 *   · 「参数设置」（默认折叠）：所有面向调参的项都在这里——检索阈值与上限、
 *     工具结果口径、记忆管理、模型调用参数、记忆目录。**没有任何设置项被删除**。
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
/* ── 会话内「没想起来？」按钮 ── 图标刻意用 ✕，与官方点赞/点踩（👍👎）区分开 ── */
.dsm-miss-wrap { position:relative; display:inline-flex; align-items:center; }
.dsm-miss-btn { width:calc(26px + var(--dsh-content-font-delta,0px)); height:calc(26px + var(--dsh-content-font-delta,0px)); display:inline-flex; align-items:center; justify-content:center; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:13px; line-height:1; }
.dsm-miss-btn:hover { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.dsm-miss-pop { position:absolute; z-index:40; bottom:calc(100% + 6px); right:0; width:min(460px,80vw); max-height:60vh; overflow:auto; background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base)); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.18); padding:10px; display:flex; flex-direction:column; gap:6px; }
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
/* 折叠的「参数设置」：默认收起，卡头右侧一个纯文本按钮负责开合 */
.dsm-adv-toggle { background:none; border:none; padding:0; color:var(--dsw-alias-brand-primary); font-size:12px; cursor:pointer; white-space:nowrap; }
.dsm-adv-toggle:hover { text-decoration:underline; }
.dsm-advanced { display:flex; flex-direction:column; gap:10px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:10px; }
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

    function SwitchRow({ label, hint, checked, onChange, disabled, auditLabel, auditValue }) {
      if (auditLabel !== undefined) controlAudit('toggle', auditLabel, auditValue);
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h(Toggle, { checked, onChange, disabled }));
    }

    /**
     * 按 step 的小数位决定精度：整数参数才取整。
     *
     * 为什么不能一律取整：「命中阈值」(0.28) 是小数参数，一律取整会在**点一下输入框
     * 再点走**时把它抹成 0——阈值归零等于关掉命中判定，几乎每轮都会注入。
     * （原先这句还举了「会话累计上限 0.02」当例子，那个设置项已按用户决定删除。）
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

    /* ── 基础控件的"绑定审计"包装（2026-10-08 新增）──────────────────────────
     * 面板历史上真出过"开关接到错的键"这类事故，而桩渲染只看得见文案，看不见
     * "这个开关当前绑的是哪个键"。三个基础控件外面各包一层：渲染时如实上报
     * 「控件类型 + 它拿到的那个键名 + 它读到的值」，`scripts/panel-render.mjs`
     * 再拿它与同一份桩设置里的对应键逐项比对 —— 值对不上就说明绑错了键。
     *
     * 宿主里 `window.__dsmControlAudit` 不存在，函数体立刻返回：**零行为差异**
     * （不写 DOM、不发请求、不改任何状态）。
     */
    function controlAudit(kind, label, value, options) {
      try {
        const tracker = window?.__dsmControlAudit;
        if (Array.isArray(tracker)) tracker.push({ kind, label, value, options });
      } catch { /* 审计钩子绝不影响渲染 */ }
    }
    /** 把 `Component` 包成"先上报取值、再正常渲染"，并把标签透传给它。 */
    function tracked(Component, kind) {
      return function Tracked(props) {
        /* `options` 也一起上报（2026-10-08）：桩渲染不产生 DOM，"模型下拉里到底有哪些项"
         * 只能从这里看见 —— 换提供方后旧型号是否还残留在**可选项**里，靠这一列断言。
         * 只做"把清单抄一份"，不参与任何渲染决策；非下拉控件传 undefined。 */
        const options = kind === 'select' && Array.isArray(props?.options)
          ? props.options.map((item) => (typeof item === 'string' ? item : String(item?.value ?? '')))
          : undefined;
        controlAudit(kind, props?.auditLabel ?? '', props?.auditValue, options);
        return h(Component, props);
      };
    }

    /**
     * 空值的**显示文案**（值仍是空串，只是换了说法）：
     *   · 提供方也为空 → 「跟随主模型」：空串走 `resolveRoute` 的既有降级路径，语义就是跟随；
     *   · 提供方非空   → 不许再写"跟随主模型"（用户报告的就是这句）。
     *     `llm.js` 的 `resolveRoute` 只在 provider 与 model **都非空**时才用这一对，
     *     所以这里仍然是"回落主模型"；文案不提"主模型"是因为**提供方已经选定了**，
     *     用户要在这一项里读到的信息是"不再指定具体型号"。
     */
    const FOLLOW_MAIN_LABEL = '（跟随主模型）';
    const PROVIDER_DEFAULT_MODEL_LABEL = '（用该提供方的默认模型）';

    /**
     * 纯下拉行：**点开即列表**（不是"下拉 + 手输"的混合框）。
     *
     * 为什么不用 datalist：混合框里想换一个值时，得先把原内容删干净才能再次展开 ——
     * 多一步操作。第一项是「（跟随主模型）」（值 = 空串，可清空，文案由调用方给），
     * 其余来自**你在「设置 → 模型」里已配置好**的提供方/型号。
     *
     * `keepUnknown`（2026-10-08 新增，默认 true = 保持历史行为）：
     *   · true  —— 当前值不在清单里也**照原样显示一行**。手填的旧值 / 清单还没读到，
     *     都不能悄悄吞掉（吞掉的话用户看到的是"跟随主模型"，以为配置丢了）。
     *   · false —— 当前值**不再作为可选项**出现。给「模型」下拉在
     *     "提供方非空 + 该提供方型号清单非空"时用：那时清单是**该提供方的权威清单**，
     *     不在其中的型号属于别的提供方（换提供方后的残留），留着就是用户报的那个 bug。
     */
    function SelectRow({ label, hint, value, options, emptyHint, onCommit, firstLabel, hideEmpty, keepUnknown = true }) {
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
          hideEmpty === true ? null : h('option', { value: '' }, firstLabel ?? FOLLOW_MAIN_LABEL),
          // 当前值不在清单里（手填的旧值 / 清单还没读到）也要显示，不能悄悄吞掉；
          // keepUnknown=false 时这条关闭（见上面的说明）。
          keepUnknown === true && current !== '' && !known ? h('option', { value: current }, current) : null,
          ...pairs.map((pair) => h('option', { key: pair.value, value: pair.value }, pair.label)),
          pairs.length === 0 && current === '' && typeof emptyHint === 'string'
            ? h('option', { value: '', disabled: true }, emptyHint)
            : null));
    }

    /** 文本行（失焦或回车提交）。 */
    function TextRow({ label, hint, value, placeholder, onCommit }) {
      const [draft, setDraft] = React.useState(String(value ?? ''));
      React.useEffect(() => { setDraft(String(value ?? '')); }, [value]);
      const commit = () => {
        const next = draft.trim();
        if (next === '') { setDraft(String(value ?? '')); return; }
        if (next === String(value ?? '')) { setDraft(String(value ?? '')); return; }
        onCommit(next);
      };
      return h('div', { className: 'dsm-row' },
        h('div', { className: 'dsm-row-main' },
          h('span', { className: 'dsm-label' }, label),
          hint ? h('span', { className: 'dsm-hint' }, hint) : null),
        h('input', {
          className: 'dsm-num',
          style: { width: '260px', textAlign: 'left' },
          type: 'text',
          value: draft,
          placeholder: placeholder ?? '',
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } },
        }));
    }

    /**
     * 基础控件的"绑定审计"实例：全部声明在四个组件**之后**（TDZ 安全）。
     * 面板里凡是需要被 `scripts/panel-render.mjs` 核对的控件都改用它们。
     * 只包一层、只上报，不改变任何渲染结果。
     *
     * ⚠️ **开关不在这个清单里**：开关的完整视觉单元是 `SwitchRow`（标签 + 说明 + 开关），
     * 不能把 `Toggle` 单独换成包装版 —— 那样渲染出来的就只剩一个孤零零的按钮，
     * 标签整块消失（2026-10-08 实测踩过）。`SwitchRow` 内部自己调 `controlAudit`。
     */
    const AuditedNumberRow = tracked(NumberRow, 'number');
    const AuditedTextRow = tracked(TextRow, 'text');
    const AuditedSelectRow = tracked(SelectRow, 'select');

    /** 成本徽章：新用户最先想知道的就是"这块花不花钱"。 */
    function Cost({ kind, children }) {
      const cls = kind === 'free' ? 'dsm-cost dsm-cost-free' : (kind === 'capped' ? 'dsm-cost dsm-cost-capped' : 'dsm-cost');
      return h('span', { className: cls }, children);
    }

    /**
     * 点 ✕ 时那一行「xxx（辅助模型）检索中」里显示的模型名。
     *
     * 口径与宿主一致：用配置里的 `llmModel`（唯一的那一套模型字段）；
     * 跟随主模型或没配 → 显示"主模型"（不再显示一个我们猜的型号名）。
     * @param {object} settings - 面板读到的设置对象（可为空）。
     * @returns {string} 模型名。
     */
    function resolveModelName(settings) {
      const model = String(settings?.llmModel || '').trim();
      return model === '' ? '主模型' : model;
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

    /* ─────────────────────────── 主面板 ─────────────────────────── */
    function Panel(props) {
      const [settings, setSettings] = React.useState(null);
      const [overview, setOverview] = React.useState(null);
      const [diag, setDiag] = React.useState(null);
      const [trash, setTrash] = React.useState({});
      const [detail, setDetail] = React.useState(null);
      const [openAdvanced, setOpenAdvanced] = React.useState(false);
      /* ⑥ 的展开是**独立**状态：它只摊开自己那块（排障行 / 打分日志 / 记忆目录 / 恢复默认设置）。
       * 2026-10-07 之前 ⑥ 的「展开」和顶部「参数设置」共用 `openAdvanced` —— 于是展开 ⑥ 会把
       * 页面最底部那整块参数区一起摊开（用户：反直觉）。两个开关，各管各的。 */
      const [openDiag, setOpenDiag] = React.useState(false);
      const [openLibrary, setOpenLibrary] = React.useState(true);
      const [confirmZero, setConfirmZero] = React.useState(false);
      const [pending, setPending] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(null);
      const [confirmTrashDelete, setConfirmTrashDelete] = React.useState(null);
      const [confirmPurge, setConfirmPurge] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [search, setSearch] = React.useState(null);
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
          // 摘抄已被 git **跟踪**时必须说出来（2026-10-08）：`.gitignore` 只对未跟踪文件
          // 生效，早先误提交过的 `_readable/excerpts/*.md` 里是逐字问答原文，插件删了
          // 工作区里的文件，但 git 索引里还留着一份 —— 不说这句，用户会以为"删干净了"。
          const trackedHint = result.excerptGit?.tracked === true
            ? `　⚠️ 这些摘抄已被 git 跟踪：插件删掉了文件，但 git 索引里还在。请在该工作区执行 git rm --cached ${result.excerptGit.excerptDir ?? '<摘抄目录>'} 之后再提交。`
            : '';
          setNotice(`已删除 ${result.deleted} 条${result.trashed ? '（可在回收站还原）' : ''}${trackedHint}`);
          window.setTimeout(() => setNotice(''), trackedHint === '' ? 3000 : 12000);
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

      /**
       * 测试连接：`kind` = 'ingest' | 'recall'。
       *
       * **不分档**：模型配置只有一套（`llmProvider`/`llmModel`），入库与检索用的是同一对，
       * 所以测试连接固定测这一对（`kind` 仍保留在回执文案里，值只影响显示标签）。
       */
      const runLlmTest = async (kind) => {
        const { session } = probeTarget();
        const provider = effective('llmProvider', '');
        const model = effective('llmModel', '');
        setLlmTestBusy(true);
        try {
          const value = await api('/llm/test', { method: 'POST', body: JSON.stringify({ session, provider, model }) });
          setLlmTest({ ...value, kind });
        } catch (e) { setError(String(e.message ?? e)); } finally { setLlmTestBusy(false); }
      };

      /** 测试结果（按区块显示，紧跟在所测字段下方）。 */
      const renderLlmTest = (kind) => {
        if (llmTest === null || llmTest.kind !== kind) return null;
        return h('div', { className: llmTest.ok ? 'dsm-ok' : 'dsm-warn' },
          llmTest.ok
            ? `连接成功（${llmTest.ms} ms）· 路由 ${llmTest.route?.provider ?? '?'} / ${llmTest.route?.model ?? '?'} · 模型回了「${llmTest.text || '（没有输出文本，但连接是通的）'}」`
            : `连接失败：${llmTest.code} —— ${llmTest.hint}${llmTest.route === null ? '' : `（路由 ${llmTest.route.provider}/${llmTest.route.model}）`}`);
      };

      const llmStatus = overview?.llm ?? null;
      /**
       * 面板显示的"使用方式"。**直接读 `llmMode`**（唯一的模型选择字段，见 lib/config.js）：
       * 设置文件加载时已经把早先那四个影子键搬进 `llmProvider`/`llmModel` 并丢弃，
       * 所以这里不需要、也不许再反推任何旧状态。
       */
      const llmMode = (() => {
        const stored = String(effective('llmMode', 'off') ?? 'off');
        return stored === 'main' || stored === 'custom' ? stored : 'off';
      })();
      /**
       * "会不会调用模型" = 模型档位（与宿主网关 `check()`、`status().enabled` **同一条判据**）。
       *
       * 2026-10-08 改：这里原先是 `effective('llmAssistEnabled', false) === true`。
       * 手改设置文件让 `llmMode:'off'` 与 `llmAssistEnabled:true` 并存时，面板会显示
       * "已启用"而档位那一行写着"不调用大模型" —— 同一个面板里两句话互相矛盾。
       * 现在只有一个来源，矛盾在结构上不可能出现。**不要**改回去读开关字段。
       */
      const llmEnabled = llmMode !== 'off';

      /**
       * ⑦ 的调用统计（**首屏就显示**，2026-10-07 用户要求从「参数设置」搬回来）。
       *
       * 用户原话：今日调用了几次、花了多少 token 属于**他自己要看的账**，不是我们的排障细节，
       * 收进折叠区等于看不见。所以 ⑦ 收起时这一行就在，展开时另有一行更全的（多模型服务
       * 可用性与冷却状态）。收起那一行必须**只有一行**：**不要在这里展开诊断细节**。
       *
       * 字段名必须与宿主 `usage()` 完全一致（`calls` / `inTokensEst` / `outTokensEst`），
       * 对不上就会显示成 0（面板渲染冒烟测试专门盯着这条）。
       * @returns {string} 一行统计文本。
       */
      const llmStatsLine = () => {
        const head = `当前：${llmEnabled ? '已启用' : '关闭'}`;
        if (llmStatus === null || llmStatus?.usage === undefined) return head;
        const usage = llmStatus.usage;
        return head
          + ` · 今日调用 ${usage.calls}${usage.cap > 0 ? ` / ${usage.cap}` : '（不限）'} 次`
          + ` · 估算用量 输入 ≈${Number(usage.inTokensEst ?? 0)} / 输出 ≈${Number(usage.outTokensEst ?? 0)} token`;
      };

      /* 已配置的提供方/型号（与官方「模型」页同源）：供下拉点选，仍可自由填写。
       * 放在这里是因为它要用到上面刚算出的 llmEnabled；hooks 仍是无条件调用。
       *
       * 初值只有一处例外：桩渲染（`scripts/panel-render.mjs`）不产生 DOM，也**不会**把
       * effect 里 `setState` 的结果回灌到下一次渲染 —— 于是"提供方清单读到了没有"在渲染
       * 断言里永远看不到。`window.__dsmProviders` 允许桩**种子化**这份清单（真机不设它，
       * 走 `/llm/providers` 的正常路径）。**只影响初值，不影响任何判定逻辑**。 */
      const seededProviders = typeof window !== 'undefined' && Array.isArray(window.__dsmProviders)
        ? window.__dsmProviders
        : [];
      const [llmProviders, setLlmProviders] = React.useState(seededProviders);
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

      /**
       * 「模型」下拉的作用域 + `keepUnknown` 的判定（2026-10-08，纯函数，无 hook）。
       *
       * 用户报告的 bug：提供方从 `zhipu-glm` 改成 `deepseek-account` 之后，模型下拉里
       * 还留着旧提供方的 `glm-5.3-flash`，以及一句在"提供方已选定"语境下不成立的
       * 「（跟随主模型）」。这里把两件事一次算清：
       *
       *   · `options`  —— 提供方为空时列全部已知型号；提供方非空时**只列该提供方的型号**。
       *     注意与 `modelsFor()` 的区别：`modelsFor` 在该提供方读不到型号时会回落到
       *     "全部型号"，那是给**建议列表**用的；模型下拉不能那样回落（回落 = 把别的
       *     提供方的型号摆进来，正是要修的 bug）。所以这里读不到就返回空数组。
       *   · `firstLabel` —— 提供方为空 → 「跟随主模型」（空串的真语义）；
       *     提供方非空 → 「用该提供方的默认模型」（此时不指定型号；`resolveRoute` 只在
       *     provider 与 model **都非空**时用这一对，空了就走既有的主模型降级，无新行为）。
       *   · `keepUnknown` —— 清单**读得到且非空**（这时它才是该提供方的权威清单）→ false，
       *     旧提供方残留的型号不再作为可选项出现；**清单为空**（型号清单读不到 / 该提供方
       *     没公布）→ true，保留原值并显示（"查不到"绝不能被当成"用户配错了"而抹掉）。
       *   · `known` —— 本次作用域内是否读到了可信清单（供"自动清空"那条 effect 判定用）。
       * @param {string} provider - 当前提供方（可为空）。
       * @param {string} model - 当前型号（可为空）。
       * @param {Array<{provider:string,models?:string[]}>} providers - `/llm/providers` 的清单。
       * @returns {{options:string[],firstLabel:string,keepUnknown:boolean,known:boolean}} 作用域。
       */
      function selectModelScope(provider, model, providers) {
        const list = Array.isArray(providers) ? providers : [];
        const rows = list.map((item) => ({
          provider: typeof item?.provider === 'string' ? item.provider : '',
          models: Array.isArray(item?.models) ? item.models.filter((name) => typeof name === 'string' && name !== '') : [],
        }));
        const name = String(provider ?? '').trim();
        const all = [...new Set(rows.flatMap((row) => row.models))];
        const hit = rows.find((row) => row.provider === name) ?? null;
        const scoped = name === '' ? all : (hit === null ? [] : hit.models);
        const current = String(model ?? '');
        return {
          options: scoped,
          firstLabel: name === '' ? FOLLOW_MAIN_LABEL : PROVIDER_DEFAULT_MODEL_LABEL,
          keepUnknown: !(name !== '' && hit !== null && scoped.length > 0 && !scoped.includes(current)),
          known: name !== '' && hit !== null && scoped.length > 0,
        };
      }

      /**
       * 「提供方」下拉提交时的补丁（纯函数，无 hook）。
       *
       * 换了提供方之后，上一家的型号在该提供方**不一定存在** ——
       * "跟着 A 提供方的型号去调 B 提供方"是没有意义的组合，所以同一个补丁里把它清空
       *（`llmModel: ''` = 回到"不指定型号"，走 `resolveRoute` 的既有降级路径）。
       * 清空的前提是**新提供方的型号清单读得到且非空**：读不到就保留原值，
       * 不许因为"查不到"就清掉用户配置。
       * @param {string} value - 用户选中的新提供方。
       * @returns {{llmProvider:string,llmModel?:string}} 交给 `patch()` 的补丁。
       */
      function providerChangePatch(value) {
        const scope = selectModelScope(value, effective('llmModel', ''), llmProviders);
        const current = String(effective('llmModel', '') ?? '');
        return scope.known && current !== '' && !scope.options.includes(current)
          ? { llmProvider: value, llmModel: '' }
          : { llmProvider: value };
      }

      /**
       * 测试钩子（2026-10-08）：把上面两个**纯函数**交给 `scripts/panel-render.mjs`，
       * 让"换提供方 → 补丁里同时带 `llmModel: ''`"这类交互断言不必依赖浏览器。
       * 面板行为不读它；只在桩环境里存在，真机 `window.__dsmTestHooks` 是 undefined。
       */
      window.__dsmTestHooks = { selectModelScope, providerChangePatch, modelsFor: (name) => modelsFor(name), ...(window.__dsmTestHooks ?? {}) };

      /**
       * 「不指定型号」时的提示文案。空值在数据层仍是空串（`resolveRoute` 的既有降级路径），
       * 这里只负责把"接下来会发生什么"说清楚：`llm.js` 只在 provider 与 model **都非空**时
       * 用这一对，任一为空就回落到当前会话的主模型。
       */
      const modelHintFor = (scope) => (
        scope.options.length > 0
          ? '只列所选提供方的型号。'
          : '该提供方没有公布型号清单，面板读不到 —— 若这里留着空，就跟随当前会话的主模型。'
      );

      /* ── 换提供方后，不属于该提供方的型号**清掉**（不是"只是不显示"）───────────
       * 用户报告：提供方从 zhipu-glm 改成 deepseek-account 后，模型下拉里还留着
       * glm-5.3-flash。下拉已经不再列它（`keepUnknown: false`），但**配置里也必须清空** ——
       * 否则"跟着 A 提供方的型号去调 B 提供方"会一直生效下去。
       *
       * 只在**有可信清单**时动手（`scope.known`）：清单读不到（`/llm/providers` 还没回来 /
       * 该提供方没公布型号）一律保留原值，绝不因为"查不到"就抹掉用户配置。
       * 幂等：清成空串之后不再满足条件，不会反复写盘。 */
      React.useEffect(() => {
        if (llmEnabled !== true) return;
        const scope = selectModelScope(effective('llmProvider', ''), effective('llmModel', ''), llmProviders);
        if (String(effective('llmModel', '') ?? '') === '') return;
        if (!scope.known || scope.keepUnknown) return;
        patch({ llmModel: '' }, { notice: '该型号不属于当前提供方，已清空（改回不指定型号）' });
      }, [llmEnabled, llmProviders, current?.llmProvider, current?.llmModel]);

      if (settings === null) {
        return h('div', { className: 'dsm-root', 'data-dsh-plugin': 'super-memory' },
          h(Card, { title: '超级记忆' }, error ? h('div', { className: 'dsm-err' }, error) : h('div', { className: 'dsm-hint' }, '正在读取设置…')));
      }

      /* 「模型」下拉的当前作用域（选项 / 首项文案 / 是否保留清单外的当前值）。
       * 必须在 `settings === null` 的早返回**之后**才能算：它要读 `effective()` 里的设置。 */
      const scope = selectModelScope(effective('llmProvider', ''), effective('llmModel', ''), llmProviders);

      const workspaces = overview?.workspaces ?? [];
      const totals = overview?.totals ?? { libraryBytes: 0, trashBytes: 0 };
      const runtime = overview?.runtime ?? [];
      const hits = runtime.reduce((sum, r) => sum + r.hits, 0);
      const injected = runtime.reduce((sum, r) => sum + r.injectedTokensEst, 0);
      const enabled = effective('enabled', true);
      const recapCap = effective('compactionRecapMaxTokens', 300);
      const turnCap = effective('maxTokensPerTurn', 700);
      const itemsCap = effective('maxItems', 2);
      const charsCap = effective('maxCharsPerItem', 300);
      const workspaceNow = workspaces.find((w) => w.workspace === overview?.currentWorkspace) ?? workspaces[0] ?? null;
      const latestSession = workspaceNow?.sessions?.[0] ?? null;
      /* 「本工作区 N 条」徽标：以前直接读 `sessions[0].blocks`，而 sessions 是按活动时间
       * 排序的**会话列表** —— 于是徽标显示的是"最近一个会话有多少条"，却写成"本工作区"，
       * 工作区里其它会话的块数全部没算进去（只读审查报告 6 的第 3 条）。
       * 这里改成**真实合计**：与宿主的 `workspaceOverview().libraryBlocks` 同口径
       * （优先用宿主给的合计，取不到才自己加）。 */
      const workspaceBlocks = (() => {
        if (typeof workspaceNow?.libraryBlocks === 'number') return workspaceNow.libraryBlocks;
        let sum = 0;
        for (const session of workspaceNow?.sessions ?? []) sum += session.blocks ?? 0;
        return sum;
      })();
      const workspaceSessions = workspaceNow?.sessions?.length ?? 0;

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

        /* ── 顶部：三句话 ─────────────────────────────────────────────
         * 界面只回答三个问题：它做什么 / 花不花 token（含边界声明）/ 我该做什么。
         * 原理与依据（L1/L2、注入预算、指纹去重、阈值标定）一律不放界面，写进 README。 */
        h(Card, {
          title: '超级记忆',
          extra: h('button', {
            className: 'dsm-adv-toggle',
            type: 'button',
            onClick: () => setOpenAdvanced((v) => !v),
          }, openAdvanced ? '收起参数设置' : '参数设置'),
        },
        h('div', { className: 'dsm-hint' },
          '超长会话被压缩几次后，你早先定过的事就从上下文里消失了。'
          + '这个插件在压缩那一刻把被压掉的内容存到你本机，之后只把相关的那几段递回给模型，'
          + `让它在需要时重新想起来。最多占 ${turnCap} token/轮，挑不出相关的就一点都不注入。`),
        h('div', { className: 'dsm-hint' },
          '本插件可以选择调用辅助大模型增加检索历史记忆的命中率。'
          + '调用辅助大模型需提前在 DSH 官方模型接口接入对应模型，'
          + '本插件不存密钥、不改写你的对话；只读 DSH 的会话日志。'
          + '平时不用管它 —— 觉得它忘了本应提到过的历史内容，就点回答下面的 ✕ 让它再找一遍。'),
        h('div', { className: 'dsm-sec' },
          h(SwitchRow, {
            label: '启用「超级记忆」',
            hint: '总开关：关掉 = 不写入本地、不注入任何内容（本地已有的记忆不会被删）。',
            checked: enabled,
            onChange: (value) => patch({ enabled: value }),
          })),

        /* ── 参数设置（默认折叠）───────────────────────────────────────
         * 面向调参的项全部集中在这里：普通用户不展开也完全不影响使用，
         * 想抠成本/命中率的人展开就能逐项调（**没有任何设置项被删除**）。 */
        !openAdvanced ? null : h('div', { className: 'dsm-advanced' },
          h('div', { className: 'dsm-totals' },
            h('span', null, `记忆库占用：${bytes(totals.libraryBytes)}`),
            h('span', null, `回收站占用：${bytes(totals.trashBytes)}`),
            h('span', null, `本进程命中 ${hits} 次 / 估算注入 ${injected} token`),
            h('span', null, `工作区 ${workspaces.length} 个`)),
          h('div', { className: 'dsm-sec' },
            h('div', { className: 'dsm-label' }, '检索参数'),
            h(AuditedNumberRow, {
              label: '命中阈值', suffix: '', value: effective('minScore', 0.28), min: 0, max: 1, step: 0.01,
              auditLabel: '命中阈值', auditValue: effective('minScore', 0.28),
              hint: '低于它一个字都不注入。调高更保守（更省、可能漏），调低更容易命中。',
              onCommit: (value) => patch({ minScore: value }),
            }),
            h(NumberRow, {
              label: '单轮注入上限', suffix: 'token', value: turnCap, min: 0, max: 4000,
              hint: '一轮里递回去的历史最多占多少上下文。0 = 命中也不注入。',
              onCommit: (value) => patch({ maxTokensPerTurn: value }),
            }),
            h(NumberRow, {
              label: '单轮最多条数', suffix: '条', value: itemsCap, min: 0, max: 5,
              // 判据在 lib/retrieval.js 的 `pick()`：第二条必须 ≥ 最高分 × 0.72 才一起注入。
              // 早先这句写成"最高分明显高于第二条时才取 2 条"——**条件写反了**（那正是只取 1 条
              // 的情形），会让用户以为"分数高就该多注入"。照实写。
              hint: '一般只取 1 条；第二条分数接近最高分（≥72%）时才一起注入。0 = 不注入。',
              onCommit: (value) => patch({ maxItems: value }),
            }),
            h(NumberRow, {
              label: '总量上限', suffix: 'token', value: recapCap, min: 0, max: 2000,
              hint: '压缩后那份脉络总览最多占多少。0 = 不注入总览（仍照常入库）。',
              onCommit: (value) => patch({ compactionRecapMaxTokens: value }),
            }),
            h(NumberRow, {
              label: '每条最大字符', suffix: '字符', value: charsCap, min: 50, max: 1000,
              hint: '超出会在句子边界截断，最小 50。',
              onCommit: (value) => patch({ maxCharsPerItem: value }),
            })),
          h('div', { className: 'dsm-sec' },
            h('div', { className: 'dsm-label' }, '检索与注入方式'),
            h(AuditedNumberRow, {
              label: '查询携带最近几条提问', suffix: '条', value: effective('observationTurns', 3), min: 1, max: 8,
              auditLabel: '查询携带最近几条提问', auditValue: effective('observationTurns', 3),
              hint: '像「那这个呢」这种短问句，要带上前面几轮的话题词才检索得到。',
              onCommit: (value) => patch({ observationTurns: value }),
            }),
            h(NumberRow, {
              label: '入库冷却', suffix: '轮', value: effective('cooldownTurns', 1), min: 0, max: 20,
              hint: '刚注入过之后的几轮不再重复评分。0 = 每轮都评分。',
              onCommit: (value) => patch({ cooldownTurns: value }),
            }),
            h(AuditedNumberRow, {
              label: '单次压缩原文上限', suffix: '字符', value: effective('maxRawCharsPerCompaction', 400000), min: 0, max: 4000000,
              auditLabel: '单次压缩原文上限', auditValue: effective('maxRawCharsPerCompaction', 400000),
              hint: '一次压缩最多存多少原文，防超大压缩把磁盘写爆。0 = 不限。',
              onCommit: (value) => patch({ maxRawCharsPerCompaction: value }),
            }),
            h(SwitchRow, {
              label: '先查摘要，再用原文兜底',
              hint: '开（推荐）：摘要短而准，不够再用原文补。关：两层一起比分数。',
              checked: effective('preferSummaryChunks', true),
              onChange: (value) => patch({ preferSummaryChunks: value }),
              disabled: !enabled,
            }),
            h(SwitchRow, {
              label: '总览在本窗口内保持稳定',
              hint: '开（推荐，更省）：文本保持不变，不用反复追加。关：压缩后只注入一轮。',
              checked: effective('recapPersist', true),
              onChange: (value) => patch({ recapPersist: value }),
              disabled: !enabled,
            }),
            h(SwitchRow, {
              label: '参考块命中后一直显示',
              hint: '开（推荐，更省）：本窗口内不再撤掉，不会让上下文快照反复变化。',
              checked: effective('stickyRecall', true),
              onChange: (value) => patch({ stickyRecall: value }),
              disabled: !enabled,
            }),
            h(SwitchRow, {
              label: '同一段不重复塞',
              hint: '同一个块永不重复注入。',
              checked: effective('dedupe', true),
              onChange: (value) => patch({ dedupe: value }),
              disabled: !enabled,
            })),
          h('div', { className: 'dsm-sec' },
            h('div', { className: 'dsm-label' }, '工具结果'),
            h(SwitchRow, {
              label: '入库模型读过的文件/检索结果',
              hint: '只收只读类工具的结果原文，shell 之类的高噪声输出不收。',
              checked: effective('includeToolResults', true),
              onChange: (value) => patch({ includeToolResults: value }),
              disabled: !enabled,
            }),
            h(AuditedTextRow, {
              label: '收哪些工具',
              auditLabel: '收哪些工具', auditValue: effective('toolResultNames', 'read, grep, glob, web_fetch, history_read'),
              hint: '逗号分隔的工具名白名单。',
              value: effective('toolResultNames', 'read, grep, glob, web_fetch, history_read'),
              placeholder: 'read, grep, glob, web_fetch, history_read',
              onCommit: (value) => patch({ toolResultNames: value }),
            }),
            h(NumberRow, {
              label: '单条工具结果上限', suffix: '字符', value: effective('toolResultMaxChars', 4000), min: 200, max: 20000,
              hint: '单条结果最多存多少字符，超出截断。',
              onCommit: (value) => patch({ toolResultMaxChars: value }),
            }),
            h(NumberRow, {
              label: '工具结果总量上限', suffix: '字符', value: effective('toolResultBudgetChars', 120000), min: 0, max: 2000000,
              hint: '一次压缩里所有工具结果合计上限。0 = 不限。',
              onCommit: (value) => patch({ toolResultBudgetChars: value }),
            }),
            h(SwitchRow, {
              label: '也收录被压缩掉的历史片段',
              hint: '关（默认）：只收本次压缩范围内的内容。',
              checked: effective('includePrune', false),
              onChange: (value) => patch({ includePrune: value }),
              disabled: !enabled,
            })),
          h('div', { className: 'dsm-sec' },
            h('div', { className: 'dsm-label' }, '记忆管理与回收站'),
            h(NumberRow, {
              label: '删除保护期', suffix: '天', value: effective('protectRecentDays', 7), min: 0, max: 365,
              hint: '最近这几天用过的工作区，整会话记忆删不掉（单条仍可删）。0 = 不保护。',
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
              hint: '仅在上面的自动清空打开时生效，最少 1 天。',
              onCommit: (value) => patch({ trashAutoPurgeDays: value }),
            }))),

        /* ── ① 压缩时：入库 ──────────────────────────────────────────── */
        h(Board, {
          no: '①',
          title: '压缩时：把被压掉的内容存到本地',
          subtitle: '压缩一发生就自动存下来，不需要你做任何事，也不花 token。',
          cost: '0 token',
          costKind: 'free',
          dim: !enabled,
          extra: h('span', { className: 'dsm-badge' }, workspaceSessions === 0
            ? '本工作区 暂无数据'
            : `本工作区 ${workspaceSessions} 个会话 · 共 ${workspaceBlocks} 条`),
        },
        h(SwitchRow, {
          label: '存摘要',
          auditLabel: '存摘要', auditValue: effective('ingestSummary', true),
          hint: '压缩时 DSH 已经写好的那份摘要，按小节切开存下来（短、准、结论级）。',
          checked: effective('ingestSummary', true),
          onChange: (value) => patch({ ingestSummary: value }),
          disabled: !enabled,
        }),
        h(SwitchRow, {
          label: '存原文',
          auditLabel: '存原文', auditValue: effective('ingestRawText', true),
          hint: '被压掉那段的对话原文，以及模型读过的文件/检索结果；摘要没写到的细节靠它兜底。',
          checked: effective('ingestRawText', true),
          onChange: (value) => patch({ ingestRawText: value }),
          disabled: !enabled,
        }),
        h('div', { className: 'dsm-hint' },
          '只占本地磁盘。关掉哪一项就只跳过哪一项，已有内容仍可检索，但关着的那段时间补不回来。'),
        latestSession
          ? h('div', { className: 'dsm-hint' },
            `最近入库：${latestSession.title || '(无主题)'} · ${latestSession.blocks} 条（摘要 ${latestSession.summaryBlocks} / 原文 ${latestSession.rawBlocks}）· ${bytes(latestSession.bytes)} · ${shortTime(latestSession.updatedAt)}`)
          : h('div', { className: 'dsm-hint' }, '这个工作区还没有压缩记忆：等这个会话第一次被压缩，这里就会显示入库情况。')),

        /* ── ② 压缩后：总览 ──────────────────────────────────────────── */
        h(Board, {
          no: '②',
          title: '压缩后：塞回一份脉络总览',
          subtitle: '压缩把上下文换成了摘要；这一步顺手塞回一张"目录"，让新窗口知道此前聊过什么。',
          cost: `≤ ${recapCap} token / 次压缩`,
          costKind: recapCap > 0 ? 'capped' : 'free',
          dim: !enabled,
          extra: h('button', { className: 'dsm-btn dsm-btn-sm', onClick: runRecapPreview }, '预览它会注入什么'),
        },
        h(SwitchRow, {
          label: '压缩后注入总览',
          auditLabel: '压缩后注入总览', auditValue: effective('injectRecap', true),
          hint: `开场带一份「本会话此前脉络」；上限 ${recapCap} token，挑不出值得留的就完全不注入。`,
          checked: effective('injectRecap', true),
          onChange: (value) => patch({ injectRecap: value }),
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
          hint: `命中才注入「参考」块（最多 ${itemsCap} 条、每条 ${charsCap} 字符、合计 ${turnCap} token）；未命中连上下文快照都不变。`,
          checked: effective('injectRecall', true),
          onChange: (value) => patch({ injectRecall: value }),
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
          subtitle: '被压掉的那段就存在这里（同一个会话内，换会话不共享）；标题与 DSH 左侧会话列表一致。',
          // 一个最常见的理解坑：界面能看到 ≠ 模型记得。
          // 注意：这段必须放在 `extra` 里 —— `Board` 只渲染 extra，自定义 prop 会被静默忽略。
          extra: h('div', null,
            h('div', { className: 'dsm-inline' },
              h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenLibrary((v) => !v) }, openLibrary ? '收起' : '展开'),
              h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => { refresh(); workspaces.forEach((w) => loadTrash(w.workspace)); } }, '刷新')),
            h('div', { className: 'dsm-hint' },
              '会话窗口里能翻到最早的问题，那是 DSH 自己留的完整轨迹；但模型看不到超出上下文窗口的部分 —— '
              + '它只拿到压缩后的摘要。所以"界面上能看到"不等于"模型记得"。')),
          cost: '只占本地磁盘',
        },
        !openLibrary ? null : h(React.Fragment, null,
          gitWarn === null ? null : h('div', { className: 'dsm-warn' },
            `这个工作区是 git 仓库，而 ${gitWarn.git?.rule ?? '.dsh-compaction-memory/'} 还没被忽略：`
            + '记忆里存的是对话原文，一旦提交上去就收不回来。'),
          gitWarn === null ? null : h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => doAddIgnoreRule(gitWarn.workspace) }, '帮我加忽略规则'),
            h('span', { className: 'dsm-mono' }, gitWarn.workspace)),
          h('div', { className: 'dsm-hint' },
            `存在会话所属工作区的 ${current?.storeDir ?? '.dsh-compaction-memory'} 目录里；换工作区互不可见，也绝不会碰 DSH 原始会话日志。「浏览」会在文件管理器里定位记忆文件。`),

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
                      row.summaryBlocks > 0 ? `摘要 ${row.summaryBlocks} 块` : '',
                      row.rawBlocks > 0 ? `原文 ${row.rawBlocks} 块` : '',
                    ].filter(Boolean).join(' + ') || '无分层信息'} · ${bytes(row.bytes)}`)),
                  h('span', { className: 'dsm-inline' },
                    h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => doReveal(row.workspace, row.sessionId) }, '浏览'),
                    h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => loadBlocks(row.workspace, row.sessionId, row.title) }, '明细'),
                    h('button', {
                      className: 'dsm-btn dsm-btn-sm dsm-btn-danger',
                      disabled: row.protected,
                      title: row.protected ? '在保护期内，先把「参数设置 → 删除保护期」改成 0' : '',
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
              '这些是插件存下来的检索单元（标题来自压缩摘要的小节名），平时不用看；想看原始文件请用上面的「浏览」。删除单条只影响这一块，下次提问就检索不到它了。'),
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
          subtitle: '删掉的记忆先放这里，可以还原；确认不要了再清空，清空才真正释放磁盘空间。',
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
          ? h('div', { className: 'dsm-hint' }, '回收站是空的。删除的会话会先来这里，默认保留 7 天。')
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
        confirmTrashDelete !== null
          ? h('div', { className: 'dsm-card' },
            h('div', { className: 'dsm-card-body' },
              h('div', { className: 'dsm-warn' }, `彻底删除「${confirmTrashDelete.title || confirmTrashDelete.sessionId}」在回收站里的内容？这是永久删除、不能还原（DSH 原始会话日志不受影响）。`),
              h('div', { className: 'dsm-inline' },
                h('button', { className: 'dsm-btn dsm-btn-danger', onClick: () => doTrashDelete(confirmTrashDelete) }, '确认彻底删除'),
                h('button', { className: 'dsm-btn', onClick: () => setConfirmTrashDelete(null) }, '取消'))))
          : null,

        /* ── ⑥ 诊断与路径（默认折叠；**自己一个开关**，与「参数设置」互不影响） ─── */
        h(Card, {
          title: '⑥ 诊断与路径（一般不用动）',
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: refreshDiag }, '读取打分日志'),
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenDiag((v) => !v) }, openDiag ? '收起' : '展开')),
        },
        h('div', { className: 'dsm-hint' },
          '排障看这里：命中了什么、为什么没命中、注入了多少 token。'),
        !openDiag ? null : h(React.Fragment, null,
          h('div', { className: 'dsm-hint' },
            `本进程：命中 ${hits} 次 / 未命中 ${runtime.reduce((s, r) => s + r.misses, 0)} 次 / 估算注入 ${injected} token`),
          /* 注入量只是**计数展示**：2026-10-07 起不再有"会话累计上限"这道闸门
             （用户实测：一天 19 次调用、整场超长会话约 6 万 token ≈ 主模型的 0.01%，
             而闸门达到上限后会静默停止注入，用户只会觉得"这插件后来就不灵了"）。 */
          runtime.length > 0
            ? h('pre', { className: 'dsm-pre', style: { maxHeight: 140 } },
              runtime.map((r) => {
                const injected = Number(r.injectedTokens ?? r.injectedTokensEst ?? 0);
                return `${r.sessionId}  命中 ${r.hits} / 未命中 ${r.misses} / 本会话已注入 ≈${injected} token（不设上限）/ 已知压缩 ${r.knownCompactions} 次`;
              }).join('\n'))
            : null,
          h(SwitchRow, {
            label: '写打分日志',
            hint: `每次提问写一行本地日志（不是记忆内容）：命中与否、分数、估算 token。文件：${diag?.diagPath ?? '（点上面的"读取打分日志"后显示）'}`,
            checked: effective('logScores', true),
            onChange: (value) => patch({ logScores: value }),
          }),
          h(SwitchRow, {
            label: '启动时回填本会话已有的压缩',
            hint: '插件在会话中途才装上时，把已经发生过的压缩摘要补进本地库（0 token）。',
            checked: effective('backfillOnStart', true),
            onChange: (value) => patch({ backfillOnStart: value }),
          }),
          /* 这里原来还有一行「会话累计上限」（sessionBudgetRatio）：累计用尽后会静默停止注入，
             用户完全看不出是自己点了几次 ✕ 花掉了额度。2026-10-07 按用户实测决定**删除**，
             成本改用单次口径控制（总览上限 / 单轮注入上限 / 单次输出上限 / 每批块数 / 每块字符数）。 */
          diag === null
            ? null
            : h('pre', { className: 'dsm-pre' }, (diag.recent ?? []).slice(-24).reverse()
              .map((entry) => JSON.stringify(entry)).join('\n') || '（暂无日志）'),
            h('div', { className: 'dsm-sec' },
              h(TextRow, {
                label: '记忆目录',
                hint: '相对路径 = 每个工作区各自一份（默认）；绝对路径 = 所有工作区集中存到一个目录。不能包含 ..；改完对新写入生效，已有记忆不会自己搬家。',
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
              }, '恢复默认设置'),
              // 按钮 hint（2026-10-08）：这句话是给"点之前"看的 —— 原先这里只是删掉整个设置文件，
              // 模型档位会跟着一起没（用户今天就是这么丢的）。现在逐键重置、保留模型选择，
              // 界面上必须写明，否则用户还是不敢点 / 点了才发现差别。
              h('div', { className: 'dsm-hint' }, '会重置所有参数，但保留模型选择（模型档位是你显式配置的，不会被清掉）。'))))),

        /* ── ⑦ 模型辅助（可选；默认全关） ────────────────────────────── */
        h(Board, {
          no: '⑦',
          title: '模型辅助（可选）：换个说法也能被想起',
          subtitle: '默认不调用任何模型、纯本地。想让命中率更高，再在下面三选一；提问本身永远是本地检索。',
          cost: '默认 0；开了按次计费',
          costKind: 'capped',
          dim: !enabled,
          extra: h('div', { className: 'dsm-inline' },
            h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => setOpenLlm((v) => !v) }, openLlm ? '收起' : '展开')),
        }),
        !openLlm ? h('div', { className: 'dsm-hint' }, llmStatsLine())
          : h(React.Fragment, null,
            h('div', { className: 'dsm-warn' },
              '选了模型档位后，这些内容会被发送到你选的那个模型服务：'
              + '① 压缩入库时，每块正文的前 600 字符（可在顶部「参数设置」里调）；'
              + '② 你点 ✕ 时，你的提问原文与候选段落的前 100 字符。'
              + '插件不访问互联网、不自己连网、不存密钥；想一步都不出本机，可在 DSH 侧把提供方指向本地 Ollama / LM Studio。'),
            // ── 只需要回答一个问题：要不要额外调用大模型来提高命中率 ──
            h(AuditedSelectRow, {
              label: '使用方式',
              auditLabel: '使用方式', auditValue: llmMode,
              hint: '入库时补问法、点 ✕ 时再搜一遍并判定是否真相关。',
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
                ? '当前：纯本地。提问零延迟、零 token；压缩后仍会注入总览与命中的参考。'
                : (llmMode === 'main'
                  ? '当前：用你的主模型补问法、换关键词。提问本身仍是本地检索，不会因此变慢。'
                  : '当前：这两处改用你指定的模型（例如主对话用 pro、这里用更便宜的 flash）。')),
            /* 调用统计（一行，紧邻「使用方式」）：**首屏就必须看得见** —— 收起 ⑦ 时同一行
               由 `llmStatsLine()` 补在板块下方，展开时就是这一行。 */
            h('div', { className: 'dsm-hint' }, llmStatsLine()),
            llmMode !== 'custom' ? null : h(React.Fragment, null,
              h(AuditedSelectRow, {
                label: '提供方',
                auditLabel: '提供方', auditValue: effective('llmProvider', ''),
                hint: '下拉里是你在「设置 → 模型」里配好的提供方。',
                value: effective('llmProvider', ''),
                options: providerNames,
                /* 2026-10-08：提供方下拉**不再**提供空选项。修 bug 时它还是 `SelectRow` 的默认
                 * 第一项「（跟随主模型）」（值 = 空串）—— 于是"提供方已选定"时，模型下拉的
                 * 断言里仍会读到这四个字（那句文案其实长在**提供方**那一行上，实测定位）。
                 * 而且"跟随主模型"的语义本来就由**模型**下拉承担：提供方留空 = 不指定这一对，
                 * 由 `resolveRoute` 回落到主模型。 */
                hideEmpty: true,
                emptyHint: '（读不到提供方清单：重启 DSH 后可点选）',
                onCommit: (value) => patch(providerChangePatch(value)),
              }),
              h(AuditedSelectRow, {
                label: '模型',
                auditLabel: '模型', auditValue: effective('llmModel', ''),
                /* 作用域与文案都来自 `selectModelScope`：**一个来源**，所以
                 * "下拉里有什么" 与 "什么时候清空" 不可能各说各话。 */
                hint: modelHintFor(scope),
                value: effective('llmModel', ''),
                options: scope.options,
                keepUnknown: scope.keepUnknown,
                firstLabel: scope.firstLabel,
                emptyHint: '（该提供方未公布型号清单）',
                onCommit: (value) => patch({ llmModel: value }),
              }),
              h('div', { className: 'dsm-inline' },
                h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => runLlmTest('ingest'), disabled: llmTestBusy || !llmEnabled }, llmTestBusy ? '测试中…' : '测试连接')),
              renderLlmTest('ingest')),
            llmProviders.length > 0
              ? h('div', { className: 'dsm-hint' }, `可点选的提供方（来自「设置 → 模型」）：${providerNames.join(' / ') || '（无）'}`)
              : null,
            /* 更全的排障行（模型服务可用性 / 冷却 / 上次失败）：只随⑥「诊断与路径」展开显示。
               今日调用次数与 token 估算**不在这里** —— 那两笔账已经搬到上面那一行了。 */
            !openDiag ? null : h('div', { className: 'dsm-hint' },
              llmStatus === null
                ? '（读不到模型服务状态）'
                : `模型服务：${llmStatus.serviceAvailable ? '可用' : '不可用（DSH 没提供 llm 服务）'}`
                  + (llmStatus.cooldownUntil === null ? '' : ` · 暂停中至 ${new Date(llmStatus.cooldownUntil).toLocaleTimeString()}`)
                  + (llmStatus.lastFailure === null ? '' : ` · 上次失败：${llmStatus.lastFailure.code}`)),
            h('div', { className: 'dsm-sec' },
              h('div', { className: 'dsm-label' }, '调用参数（一般不用改）'),
              h(NumberRow, {
                label: '入库调用超时', suffix: 'ms', value: effective('llmIngestTimeoutMs', 8000), min: 1, max: 300000,
                hint: '超过就主动放弃这一次，原有词频照旧。',
                onCommit: (value) => patch({ llmIngestTimeoutMs: value }),
              }),
              h(NumberRow, {
                label: '每批块数', suffix: '块', value: effective('llmIngestBatchBlocks', 8), min: 1, max: 50,
                hint: '一次调用处理几块，省调用次数。一次压缩 15 块 ≈ 2 次调用。',
                onCommit: (value) => patch({ llmIngestBatchBlocks: value }),
              }),
              h(NumberRow, {
                label: '每块送多少字符', suffix: '字符', value: effective('llmIngestBlockChars', 600), min: 100, max: 4000,
                hint: '每块送多少字符去补问法；越小越省。',
                onCommit: (value) => patch({ llmIngestBlockChars: value }),
              }),
              h(NumberRow, {
                label: '检索调用超时', suffix: 'ms', value: effective('llmRecallTimeoutMs', 8000), min: 1, max: 300000,
                hint: '点 ✕ 之后等辅助模型的上限：8 秒是上限而不是每次都要等满；真超时意味着这次白点一次。',
                onCommit: (value) => patch({ llmRecallTimeoutMs: value }),
              })),
            h('div', { className: 'dsm-sec' },
              h('div', { className: 'dsm-label' }, '成本与缓存'),
              h(NumberRow, {
                label: '每日调用上限', suffix: '次', value: effective('llmDailyCallCap', 0), min: 0, max: 100000,
                hint: '0 = 不限（默认）。填了才启用：到上限就停用到次日，面板会显示原因。',
                onCommit: (value) => patch({ llmDailyCallCap: value }),
              }),
              h(SwitchRow, {
                label: '相同输入不重复调用',
                hint: '改写结果按提问缓存（30 天有效，最多 200 条）。',
                checked: effective('llmCacheEnabled', true) === true,
                onChange: (value) => patch({ llmCacheEnabled: value }),
                disabled: !llmEnabled,
              }),
              h(NumberRow, {
                label: '单次输出上限（扩写）', suffix: 'token', value: effective('llmIngestMaxTokens', 240), min: 1, max: 8000,
                hint: '一批 8 块的短 JSON 用不到 240；格式不对会整批丢弃、保留原词。',
                onCommit: (value) => patch({ llmIngestMaxTokens: value }),
              }),
              h(NumberRow, {
                label: '单次输出上限（查询改写）', suffix: 'token', value: effective('llmRewriteMaxTokens', 120), min: 1, max: 4000,
                hint: '改写只要几个关键词，120 足够；给多了模型反而容易写出格式不对的内容。',
                onCommit: (value) => patch({ llmRewriteMaxTokens: value }),
              }),
              h('div', { className: 'dsm-hint' },
                '思考强度 / 是否推理不在这里设 —— 到「设置 → 模型」里对该型号设置。'),
              h('div', { className: 'dsm-hint' },
                '插件不自己连网、不自己存密钥：提供方都在 DSH 侧登记，这里只填两个名字。调用留痕（只有元数据）写在全局数据目录的 dsh-super-memory.llm.jsonl。'))))));
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
    /**
     * 每个会话**当前这一轮**的轮次身份。
     *
     * 轮次只有 `conversation.chat.turnTail` 槽位给（`turn`/`seq`），而"点 ✕"发生在
     * `assistant-actions` 里 —— 于是 `run()` 发布结果时手上没有轮次。让渲染中的结果块
     * 把自己那一轮的 turn 登记进来，`publishMiss` 就能在落笔时补上（见下）。
     * @type {Map<string, number|string>}
     */
    const MISS_TURNS = new Map();
    /** 发布序号：给每个结果打一个**单调递增**的序号，用于判断"陈旧"。 */
    let MISS_SEQ = 0;
    /**
     * 发布一个 ✕ 结果（`null` = 撤掉）。
     *
     * `turn` 是**轮次身份**（`conversation.chat.turnTail` 槽位给的，见 DSH 侧
     * `renderSlot('conversation.chat.turnTail', { turn, seq, openFile })`）。
     * 结果必须记住它属于哪一轮 —— 否则就只能靠"提问文本变了没有"来猜（下一节那个回归的根因）。
     * @param {string} sessionId - 会话 id。
     * @param {object|null} value - 结果对象；`null` 表示清除。
     * @param {number|string} [turn] - 该结果所属的轮次（拿不到就不打轮次标记）。
     */
    function publishMiss(sessionId, value, turn) {
      MISS_SEQ += 1;
      // 序号是"陈旧判定"的依据之一（见 MissTail）：挂载序号 < 结果序号 = 这个结果属于本轮。
      // 以前用 `Date.now()` 比较挂载时刻与结果时刻 —— 两者都是毫秒级，点击与挂载落在
      // 同一毫秒里时，新结果会被误判成"上一轮留下的"而**整块消失**（用户可见的症状）。
      //
      // 轮次：优先用调用方给的；没给就借 `MISS_TURNS` 里"当前这一轮"的值（点 ✕ 的
      // `run()` 就是这种情况）。两个都没有才留空 —— 留空时读取侧退回序号判定。
      const owner = turn === undefined ? MISS_TURNS.get(sessionId) : turn;
      const stamped = value === null ? null : { ...value, seq: MISS_SEQ, ...(owner === undefined ? {} : { turn: owner }) };
      MISS_RESULTS.set(sessionId, stamped);
      for (const listener of MISS_LISTENERS.get(sessionId) ?? []) {
        try { listener(stamped); } catch { /* 单个订阅者出错不影响别人 */ }
      }
    }
    function subscribeMiss(sessionId, listener) {
      if (!MISS_LISTENERS.has(sessionId)) MISS_LISTENERS.set(sessionId, new Set());
      MISS_LISTENERS.get(sessionId).add(listener);
      return () => { MISS_LISTENERS.get(sessionId)?.delete(listener); };
    }
    /**
     * 取"**这一轮**该显示的结果"（2026-10-08 回归修复）。
     *
     * 为什么必须按轮次取，而不是"谁发布得晚就听谁的"（旧写法）：
     *   结果块挂在 `conversation.chat.turnTail` 上，**每一轮都是一个新的槽位实例**；
     *   但结果仓库是按会话存的。旧写法里 `MissTail` 直接收下仓库里的最后一条，
     *   于是上一轮的结果（含"检索中"）会**跟到下一轮回答下面** —— 用户实测回归的正是这个。
     *
     * 旧代码用"提问文本变了没有"当替身判据（`ready.lastQuery` 变化才清）：
     * 用户连问两次**同一句话**时文本不变 → 清不掉 → 结果块继续挂着（✕ 的文案还叫他
     * "直接继续提问即可"，说明重复同一句话是预期用法，这个洞一定会被踩到）。
     * 现在以**轮次身份**为准：轮次不同 = 上一轮的，直接不显示。
     * 拿不到 `turn`（旧宿主/桩）时退回序号判定，行为与修复前一致。
     * @param {string} sessionId - 会话 id。
     * @param {number|string|undefined} turn - 当前轮次。
     * @param {number} [mountedSeq] - 调用方挂载时的发布序号（轮次缺失时的兜底判据）。
     * @returns {object|null} 属于本轮的已发布结果。
     */
    function missResultFor(sessionId, turn, mountedSeq) {
      const stored = MISS_RESULTS.get(sessionId) ?? null;
      if (stored === null) return null;
      if (turn === undefined || turn === null) return stored;
      // ⚠️ 读取侧**不能**把"结果没打轮次标记"一律当成陈旧：那正好会把"点 ✕ → 立刻在会话里
      // 长出结果"这条路径整块吞掉（结果由 `run()` 发布，而 `run()` 只能从下面的
      // `MISS_TURNS` 借轮次；宿主还没渲染出 turnTail 时它就是空的）。
      // 该由**写入侧**保证打上轮次标记 —— 见 `publishMiss` 的"落笔时补轮次"。
      if (stored.turn === undefined || stored.turn === null) {
        // 结果没打轮次标记（它由"点 ✕"那次 `run()` 发布，而轮次只有 `turnTail` 槽位知道；
        // 发布时没借到就留空）：用**序号**兜底 —— 序号等于本组件挂载时的全局序号，
        // 说明它就是本实例自己那一轮发布的（比它早的都已经被后来的发布顶掉了）。
        // ⚠️ 这里比较的是**挂载序号**，不是全局 `MISS_SEQ`（后者会被后续发布抬高，
        // 拿它比会把"正要显示"的结果判成陈旧）。
        return Number.isSafeInteger(stored.seq) && stored.seq < mountedSeq ? null : stored;
      }
      return String(stored.turn) === String(turn) ? stored : null;
    }

    /**
     * 测试钩子（2026-10-08）：把"结果按轮次取"这条判据与发布/订阅口交给
     * `scripts/panel-render.mjs`，让"上一轮的结果块不得出现在新一轮"这类
     * 跨轮回归断言不必依赖浏览器。真机 `window.__dsmTestHooks` 上是别的字段，
     * 这里只做**追加**（保留已存在的键）。
     */
    if (typeof window !== 'undefined') {
      window.__dsmTestHooks = {
        ...(window.__dsmTestHooks ?? {}),
        missResultFor,
        publishMiss,
        resetMiss: (sessionId) => { MISS_RESULTS.delete(sessionId); },
        missSeq: () => MISS_SEQ,
      };
    }

    /**
     * 会话内那一块：**点 ✕ 之后直接在对话里出现**（用户要求：不要弹窗，就在会话窗口里回答）。
     *
     * 插件无法往会话里"发一条消息"（已实测：会话句柄没有 append 能力），
     * 但可以在**这一轮末尾**渲染一块内容 —— 用户看到的效果与"点完就得到回应"一致。
     *
     * 两种状态（2026-10-07 新增进行中态，用户要求：点了要立刻有反馈）：
     *   · `pending === true` → 只有一行「xxx（辅助模型）检索中，请稍后…」，**没有按钮**；
     *   · 否则 → 原来的两种结果文案（找到 = 绿字 + 「打开原文」+「知道了」；没找到 = 黄字 + 仅「知道了」）。
     */
    function MissTail({ sessionId, turn, seq }) {
      const [result, setResult] = React.useState(() => missResultFor(sessionId, turn));
      const [expanded, setExpanded] = React.useState(false);
      /* 登记"当前这一轮"，供 `publishMiss` 给点 ✕ 发布的结果补上轮次归属。
       * ⚠️ 必须在 effect 里登记（渲染期间写外部 Map 是副作用；这一块每次渲染都会写一次，
       * 写在渲染体里等于"渲染即改全局状态"）。登记是幂等的：同一轮写同一个值。
       * 只依赖 `turn`：不能依赖 `sessionId` 之外的每帧变化，否则会和订阅 effect 抢顺序。 */
      React.useEffect(() => {
        if (turn === undefined || turn === null) return;
        MISS_TURNS.set(sessionId, turn);
      }, [sessionId, turn]);
      // 这一块只属于**点 ✕ 的那一轮**：轮次身份来自槽位（`turnTail` 给 `turn`/`seq`），
      // 结果在发布时也记下了轮次（`publishMiss(sessionId, value, turn)`），两边对不上就不显示。
      // （用户实测回归的现象：上一个问题点 ✕，那块却跟到了下一个问题下面。）
      //
      // 序号判定仍然保留，做**第二道**防线（轮次拿不到时的兜底，行为与修复前一致）：
      // 毫秒级时间戳在"挂载与点击同一毫秒"时会把刚发布的新结果误判成陈旧
      //（新块整块不显示），所以这里用发布序号。
      const mountedSeq = React.useRef(MISS_SEQ);
      // 结果必须与**本轮的 turn** 一致；轮次对不上 = 上一轮留下的，直接当没有。
      // 第三个参数是"挂载时的发布序号"快照：轮次缺失时用它兜底（见 `missResultFor`）。
      const scoped = missResultFor(sessionId, turn, mountedSeq.current);
      /* 陈旧判定：
       *   · 轮次"明确对不上"→ 陈旧（这就是用户实测的那个回归）；
       *   · 轮次缺失（老宿主 / 结果没打轮次）→ 用发布序号兜底：序号小于本实例挂载时的
       *     全局序号 = 本实例挂载前就有的旧结果。
       * ⚠️ 轮次**对得上**时一律不判陈旧 —— 否则"序号已被后来的发布抬高"会把本轮结果误杀
       *（实测：同一轮的断言因此变红）。 */
      const turnMismatch = turn !== undefined && scoped !== null && String(scoped.turn) !== String(turn);
      const seqStale = (turn === undefined || scoped === null || scoped.turn === undefined || scoped.turn === null)
        && Number.isSafeInteger(scoped?.seq) && scoped.seq < mountedSeq.current;
      const stale = scoped === null ? result !== null : (turnMismatch || seqStale);
      /* 订阅：只收"属于本轮的"结果 —— 跨轮的结果连状态都不进，新一帧立刻是干净的，
       * 不会出现"先渲染上一轮、effect 里再清掉"的那一闪。 */
      React.useEffect(() => subscribeMiss(sessionId, (value) => {
        if (value === null) { setResult(null); return; }
        if (turn !== undefined && String(value.turn) !== String(turn)) { setResult(null); return; }
        setResult(value);
      }), [sessionId, turn]);
      // （这里早先还有一条 `useEffect(() => setResult(missResultFor(...)), [sessionId, turn])`。
      //  2026-10-08 实测确认它是**多余的**：初值由 `useState` 的惰性初始化取的就是同一份作用域，
      //  之后的更新全由上面的订阅送达 —— 它反而多一条风险：第三个参数（挂载序号）没传，
      //  会在"轮次缺失 + 序号已被抬高"时把本轮结果误清。删掉后 146 条断言仍全绿，
      //  所以不保留"看着有用"的死代码。）
      // 陈旧结果必须清掉（不只是不显示），但**不能写在 render 主体里**：
      // 渲染期间调 publishMiss 会去 setState 另一个组件，React 会告警
      // "Cannot update a component while rendering a different component"。
      // 改成派生标记 + 副作用：渲染这一帧先不显示，effect 里再发清除通知。
      React.useEffect(() => {
        if (stale) publishMiss(sessionId, null);
      }, [stale, sessionId]);
      // ⚠️ **所有 Hook 必须在这两个提前 return 之前**（同上：Hook 数量变化会让 React 抛错，
      // 表现就是这一块整个不渲染）。下面只做纯计算与 JSX，不再新增任何 React.use*。
      if (result === null || stale) return null;
      if (result.pending === true) {
        // 进行中：只有一行字，不显示任何按钮（用户要求：等结果出来再给操作）
        return h('div', { className: 'dsm-miss-tail' },
          h('div', { className: 'dsm-inline' },
            h('strong', null, '超级记忆'),
            h('span', { className: 'dsm-hint' }, `${String(result.model || '主模型')}（辅助模型）检索中，请稍后…`)));
      }
      const excerpt = String(result.excerpt ?? '');
      return h('div', { className: 'dsm-miss-tail' },
        h('div', { className: 'dsm-inline' },
          h('strong', null, '超级记忆'),
          result.found
            ? h('span', { className: 'dsm-ok' }, `已用 ${result.model || '主模型'}（辅助模型）搜索已压缩的历史：找到相关内容`)
            : h('span', { className: 'dsm-warn' }, `已用 ${result.model || '主模型'}（辅助模型）搜索已压缩的历史：未搜索到强相关内容`),
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
          h('button', { className: 'dsm-btn dsm-btn-sm', onClick: () => publishMiss(sessionId, null, turn) }, '知道了')),
        result.found && expanded && excerpt !== '' ? h('pre', { className: 'dsm-pre' }, excerpt) : null,
        result.found
          // **不要用 `**加粗**`**：这段文字是普通文本节点，Markdown 不会渲染，
          // 用户看到的就是两个星号（只读审查报告 6 的第 2 条）。用 <strong> 才是真的加粗。
          ? h('div', { className: 'dsm-hint' }, '资料已备好 —— ', h('strong', null, '直接继续提问即可'), '（随口说一句也行），主模型会带着它重新回答。')
          : null,
        // 本地已经强命中时**没花这一次改写钱**：如实说明，用户才知道省在哪
        // （这只在点了 ✕ 的这一次请求里成立；"检索中"那一行已经先给过反馈）。
        result.found && result.skipped === true
          ? h('div', { className: 'dsm-hint' }, '这次本地已经直接找到内容，跳过了辅助模型的查询改写（省一次调用）。')
          : null,
        result.file ? h('div', { className: 'dsm-mono' }, `原始记忆文件：${result.file}`) : null);
    }

    /**
     * 会话内「没想起来？」按钮。
     *
     * 三条设计约束（都是用户明确要求的）：
     *   1. **只在会话发生过压缩后出现** —— 没压缩过的会话记忆库还是空的，
     *      按钮既没用又打扰；所以 `knownCompactions === 0` 时直接不渲染。
     *   2. **不点就等于没有这个插件** —— 渲染按钮只读本地状态（0 token、0 模型调用）；
     *      点 ✕ 才会调用一次辅助模型（选"不调用大模型"档位时连这一次也不调，退回本地粗筛）。
     *   3. **图标不与官方点赞/点踩重复** —— 用 ✕，并带 aria-label 与 title。
     */
    function MissAction({ sessionId, messageId }) {
      const [ready, setReady] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
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
        // `/diagnostics` 现在要求来源标记 + **点名 session**（2026-10-08 审查 P2-1）：
        // 它只回这一个会话的"上一个问题"，别的会话的提问原文一律不回（早先无条件全回，
        // 而 DSH 的 web server 不做鉴权 → 本机任意进程一个 GET 就能读到用户问过什么）。
        // 少了这个自定义头宿主会回 403，✕ 就会"点了没反应"。
        const diagnostics = fetch(`${API}/diagnostics?session=${encodeURIComponent(sessionId)}&limit=1`, {
          headers: { 'x-dsh-super-memory': '1' },
        }).then((r) => r.json()).catch(() => null);
        // 同一个 effect 里把"实际会用哪个模型"也读回来（只读本地设置）：点 ✕ 之后那一行
        // 「xxx（辅助模型）检索中」要用它。读不到就回落成"主模型"（见下面的 resolveModelName）。
        const settings = fetch(`${API}/settings`).then((r) => r.json()).catch(() => null);
        Promise.all([diagnostics, settings]).then(([diagBody, settingsBody]) => {
          if (!alive || diagBody?.ok !== true) return;
          const row = (diagBody.value.runtime ?? []).find((item) => item.sessionId === sessionId) ?? null;
          // `/settings` 的形状是 `{ settings: {...}, source, defaults, … }`（见 SettingsStore.get）
          const llm = settingsBody?.value?.settings ?? null;
          setReady(row === null ? null : {
            compactions: Number(row.knownCompactions ?? 0),
            workspace: row.workspace ?? '',
            lastQuery: row.lastQuery ?? '',
            hits: row.hits ?? 0,
            misses: row.misses ?? 0,
            model: resolveModelName(llm),
          });
        }).catch(() => { /* 宿主没起来就不显示按钮 */ });
        return () => { alive = false; };
      }, [sessionId]);

      // ⚠️ **所有 Hook 必须在提前 return 之前**：本组件有两个提前 return
      // （`ready === null` 的占位、`compactions <= 0` 时不渲染），而 `ready` 会在数据
      // 到达后从 null 变成对象 —— Hook 若放在 return 之后，两次渲染的 Hook 数量不一致，
      // React 抛 "Rendered more hooks than during the previous render"，组件整个崩掉
      // （实测现象：**✕ 按钮直接消失**）。
      /**
       * 清掉**别的轮次**留下的 ✕ 结果（2026-10-08 回归修复）。
       *
       * ⚠️ 这一条**不能**再拿 `ready.lastQuery` 当轮次判据。旧写法是"探测到的提问文本与
       * 记下来的不一样才清"（`if (now !== <记下的那一句>)`）——
       * 用户连问两次**同一句话**时文本不变 → 永远不触发 → 上一轮的结果块（含"检索中"）
       * 挂到下一轮回答后面（用户实测回归的症状）。而且 ✕ 的文案本身就叫用户
       * "直接继续提问即可"，重复同一句话是预期用法，这个洞必然被踩到。
       *
       * 现在改成**每个动作栏实例只判一次**（一个动作栏 = 一条助手消息 = 一轮）：
       *   · 挂载时把"当时仓库里那条结果"视为**自己这一轮的**（点 ✕ 就发生在这一刻）；
       *   · 之后轮询到的 `lastQuery` 只要与挂载时不同，就说明新问题已经到了 →
       *     清掉那个结果（不论新问题是不是同一句话）。
       * 幂等：清完之后 `cleared` 为 true，不再重复发布。
       * （轮次侧另有一道更硬的判据：结果块按 `turn` 取，见 `missResultFor`。）
       */
      const mountedQuery = React.useRef(null);
      const cleared = React.useRef(false);
      /**
       * 本轮该不该清掉上一轮的 ✕ 结果（`null` = 还没认清"这一轮问的是什么"，先不动）。
       *
       * 判据**不含"文本变没变"这一条硬条件**：同一句话重复提问时文本不变，
       * 但动作栏实例已经换了一个（又答了一轮）—— 那一次仍然算"新问题已到"。
       * 抽成纯函数是为了让 `scripts/panel-render.mjs` 能直接断言这条判据
       * （桩渲染里异步回来的 `ready` 不会自动重渲染，effect 的第二次执行测不到）。
       * @param {string} lastQuery - 这一次探测到的"上一个提问"。
       * @param {string|null} mounted - 本实例挂载时探测到的提问（`null` = 还没探到）。
       * @param {number} obs - 本实例"探测到非空提问"的次数（≥2 = 已经见过下一轮）。
       * @returns {boolean|null} 是否清除。
       */
      const missActionDecide = (lastQuery, mounted, obs) => {
        const now = String(lastQuery ?? '');
        if (now === '') return null;
        if (mounted === null || mounted === undefined) return false;
        if (now !== String(mounted)) return true;
        // 文本没变也可能是"又答了一轮"（同一句话重复提问）——那时本实例会再探测到一次。
        return Number(obs) >= 2;
      };
      if (typeof window !== 'undefined') {
        window.__dsmTestHooks = { ...(window.__dsmTestHooks ?? {}), missActionDecide };
      }
      /** 本实例"探测到非空提问"的次数（effect 每次执行 +1；见 `missActionDecide` 的第 3 个参数）。 */
      const observed = React.useRef(0);
      React.useEffect(() => {
        const now = String(ready?.lastQuery ?? '');
        if (now === '') return;
        observed.current += 1;
        if (mountedQuery.current === null) {
          mountedQuery.current = now;
          // 挂载那一刻仓库里已有结果 = 它属于刚刚过去的那一轮（用户刚点的 ✕）；
          // 等"新问题到达"再清（判据见 `missActionDecide`）。
          cleared.current = (MISS_RESULTS.get(sessionId) ?? null) === null;
          return;
        }
        if (missActionDecide(now, mountedQuery.current, observed.current) === true && !cleared.current) {
          mountedQuery.current = now;
          cleared.current = true;
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
        // **先立刻在会话里放一行"检索中"**（用户要求：点了要马上有反馈），
        // 检索完成后再用下面的最终结果**替换**它（同一块，不追加第二条）。
        // 只有真去调模型那条路径才显示"（辅助模型）检索中"；纯本地那条不会让用户白等。
        if (allowModel === true) publishMiss(sessionId, { pending: true, model: String(ready?.model ?? '') || '主模型', at: Date.now() });
        try {
          const response = await fetch(`${API}/diagnose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-super-memory': '1' },
            body: JSON.stringify({ workspace, session: sessionId, query, limit: 8, rewrite: allowModel === true, boost: allowModel === true }),
          });
          const body = await response.json();
          if (body?.ok !== true) {
            // 失败：把"检索中"那一行收掉，否则它会一直挂在会话里（这是**只读**状态，
            // 失败原因走按钮旁那行轻提示，不写进会话）。
            publishMiss(sessionId, null);
            setNote(`查找失败：${String(body?.error?.message ?? response.status)} —— 若提示"未知工作区"，先随便发一条消息（让插件见到本会话）再点 ✕`);
            return;
          }
          // boost：资料已排进"下一轮注入"。
          // **成功时不给任何面板提示** —— 用户明确要求：找没找到由主模型在会话窗口里回答。
          if (body.value?.boosting !== undefined) {
            setNote('');
            // 结果直接放到**会话里**那一块（本轮末尾），不再弹面板提示
            const material = String(body.value.material ?? '');
            publishMiss(sessionId, {
              found: body.value.found === true,
              model: String(body.value.model || '').trim() || '主模型',
              excerpt: material,
              file: String(body.value.file ?? ''),
              // 宿主告诉我们"本地已经强命中、这次没花钱改写"（用户看不到提示词，只有这个标记）
              skipped: body.value.rewriteSkipped === true,
              at: Date.now(),
            });
            return;
          }
          // 旧宿主（还没重启）不认 boost：必须说清楚，否则点了像"没反应"（用户就是这么遇到的）
          if (allowModel === true && body.value?.material !== undefined) {
            publishMiss(sessionId, null);
            setNote('宿主还是旧代码：请重启 DSH，之后点 ✕ 才会把资料排进下一轮');
            return;
          }
          if (allowModel === true && body.value?.assist?.rewrite != null && body.value.assist.rewrite.ok !== true) {
            // 改写失败：宿主仍然会把本地粗筛结果排进下一轮（`boost` 路径不依赖改写），
            // 所以这里只是把"检索中"换成"模型没帮上忙"的提示，会话里那块由下一次结果覆盖。
            publishMiss(sessionId, null);
            setNote(`模型没帮上忙：${body.value.assist.rewrite.code} —— ${body.value.assist.rewrite.hint}`);
          }
        } catch (e) { publishMiss(sessionId, null); setNote(String(e?.message ?? e)); } finally { setBusy(false); }
      };

      return h('div', { className: 'dsm-miss-wrap' },
        h('button', {
          className: 'dsm-miss-btn',
          // 真实行为：找到的资料被**排进下一轮注入**（宿主 boostFor → state.nextTurnBoost），
          // 用户不需要复制粘贴任何东西。旧文案写的是"会自动复制，粘贴发送即可" ——
          // 全仓根本没有 clipboard 调用（只读审查报告 6 的第 1 条），照着做只会困惑。
          title: '没想起来？让辅助大模型在已压缩的内容里再找一遍（找到的内容会排进你的下一轮提问）',
          'aria-label': '未命中：再查一遍',
          // 一次点击就开查（用户明确要求：不要"弹窗 + 再点一次"）
          onClick: () => { if (busy !== true) run(true); },
        }, busy ? '…' : '✕'),
        // 一行轻提示（不需要用户操作）：模型有没有帮上忙 / 失败原因
        note === '' ? null : h('div', { className: 'dsm-miss-pop', style: { width: 'min(360px, 70vw)' } },
          h('div', { className: 'dsm-hint' }, note)));
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
