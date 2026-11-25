// DSH loads client contributions through its browser module registry.
window.__ModuleLoader__.load({
  id: '@accremind/dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const labels = { rule: '团队规范', radar: '按提问提醒', jit: '按文件提醒' };

    function stateLabel(hit) {
      if (hit.currentRevision == null) return '已移除';
      if (hit.currentRevision !== hit.revision) return '已有新版本';
      if (hit.currentStatus === 'withdrawn') return '已撤回';
      if (hit.currentStatus === 'archived') return '已归档';
      if (hit.currentServing === 'suspended') return '已暂停推荐';
      if (hit.status === 'probation' && hit.currentStatus === 'active') return '已转为正式';
      if (hit.feedback === 'success') return '你已确认有用';
      if (hit.feedback === 'failure') return '你已报告有误';
      return '';
    }

    // Three one-tap answers; only "有错" asks for a sentence, because it pauses the entry for everyone.
    function availableActions(hit) {
      if (hit.currentRevision !== hit.revision || hit.currentServing !== 'enabled' ||
          !['active', 'probation'].includes(hit.currentStatus)) return [];
      if (hit.feedback === 'success') return [['suspected_error', '其实有错']];
      if (stateLabel(hit)) return [];
      return [['verified_effective', hit.status === 'probation' ? '有用，转为正式' : '有用'], ['inapplicable', '不适用'], ['suspected_error', '有错']];
    }

    // Why a reminder did not fit; the reason travels with the feedback so the owner knows what to fix.
    const inapplicableReasons = [['wrong_domain', '领域不对'], ['wrong_project', '不是这个项目或子项目'], ['wrong_version', '版本不对'],
      ['outdated', '已过时'], ['unrelated', '和这次问题无关']];

    // At most once a day, the footer says (to the person, never to the model) that decisions are waiting.
    const today = () => new Date().toISOString().slice(0, 10);
    function shouldRemind() {
      try { return localStorage.getItem('accremind_reminded') !== today(); } catch { return true; }
    }
    // Only a reminder actually shown uses up the day; an empty inbox is checked again next turn.
    function markReminded() {
      try { localStorage.setItem('accremind_reminded', today()); } catch { /* no storage */ }
    }

    function TurnFooter({ sessionId, turn, call }) {
      const [hits, setHits] = React.useState([]);
      const [active, setActive] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const turnId = String(turn.turn);
      React.useEffect(() => {
        if (!turn.end || !shouldRemind()) return undefined;
        let live = true;
        call('accremind.inbox.summary', {}).then(data => { if (live && data?.count) { setNotice(data.text); markReminded(); } }).catch(() => {});
        return () => { live = false; };
      }, [sessionId, turnId, turn.end]);
      React.useEffect(() => {
        let live = true;
        setHits([]); setActive(null); setMessage('');
        if (turn.end) call('accremind.turn.list', { turnId }).then(data => {
          if (live) setHits(data.receipts[0]?.hits || []);
        }).catch(error => { if (live) setMessage(error.message); });
        return () => { live = false; };
      }, [sessionId, turnId, turn.end]);
      async function submit(hit, action, detail, reason) {
        setBusy(true); setMessage('');
        try {
          const current = await call('accremind.turn.list', { turnId });
          const currentHits = current.receipts[0]?.hits || [];
          setHits(currentHits);
          const latest = currentHits.find(item => item.id === hit.id && item.revision === hit.revision);
          if (!latest || !availableActions(latest).some(([kind]) => kind === action)) {
            setActive(null);
            throw new Error('条目状态已更新，请重新核对本轮回执');
          }
          const ref = { id: hit.id, revision: hit.revision, sessionId, turnId };
          await call('accremind.feedback.submit', { ...ref, kind: action, detail: detail || '', ...(reason ? { reason } : {}) });
          setMessage(({ verified_effective: hit.status === 'probation' ? '已转为正式经验' : '已记录：有用', inapplicable: '已记录：这次不适用', suspected_error: '已暂停推荐，等待复核' })[action]);
          setActive(null); setNote('');
          const updated = await call('accremind.turn.list', { turnId });
          setHits(updated.receipts[0]?.hits || []);
        } catch (error) { setMessage(error.message); }
        finally { setBusy(false); }
      }
      if (!hits.length && !message && !notice) return null;
      return h('section', { 'aria-label': '本轮经验回执', style: { fontSize: '0.88em', marginBlock: 8 } },
        hits.length > 0 && h('details', null, h('summary', null, 'AI 这次参考了 ' + hits.length + ' 条经验'),
          hits.map(hit => h('div', { key: [hit.id, hit.source, hit.filePath].join('|'), style: { marginBlock: 6 } },
            h('span', null, labels[hit.source] + ' · ' + hit.id + '@r' + hit.revision + ' ' + hit.title + (hit.filePath ? ' · ' + hit.filePath : '') + ' '),
            stateLabel(hit),
            availableActions(hit).map(([kind, label]) => h('button', { key: kind, type: 'button', disabled: busy,
              onClick: () => {
                if (kind === 'verified_effective') return submit(hit, kind);
                setActive({ hit, kind }); setNote('');
              } }, label)),
            hit.reasons?.length ? h('div', { style: { opacity: 0.75 } }, '为什么提醒：' + hit.reasons.join('；')) : null)),
          active?.kind === 'inapplicable' && h('div', { role: 'group', 'aria-label': '为什么不适用' }, '为什么不适用？ ',
            inapplicableReasons.map(([reason, label]) => h('button', { key: reason, type: 'button', disabled: busy,
              onClick: () => submit(active.hit, 'inapplicable', '', reason) }, label)),
            h('button', { type: 'button', disabled: busy, onClick: () => submit(active.hit, 'inapplicable', '') }, '不说明')),
          active?.kind === 'suspected_error' && h('form', { onSubmit: event => { event.preventDefault(); submit(active.hit, active.kind, note.trim()); } },
            h('label', null, '哪里不对？怎么发现的 ',
              h('input', { value: note, required: true, onChange: event => setNote(event.target.value) })),
            h('button', { type: 'submit', disabled: busy || !note.trim() }, '提交')),
        ), h('div', { role: 'status' }, message), notice ? h('div', { role: 'note', style: { opacity: 0.8 } }, notice) : null);
    }

    // The sandboxed workbench has no filesystem, Node APIs or access to the host document.
    function frameBridge() {
      const pending = new Map();
      let serial = 0;
      window.addEventListener('message', event => {
        if (event.source !== parent || event.data?.channel !== 'accremind-reply') return;
        const handler = pending.get(event.data.id);
        if (!handler) return;
        pending.delete(event.data.id);
        if (event.data.error) handler.reject(new Error(event.data.error)); else handler.resolve(event.data.value);
      });
      window.__DSH_ACCREMIND_RPC__ = (method, params) => new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        parent.postMessage({ channel: 'accremind-call', id, method, params }, '*');
      });
      try { localStorage.getItem('accremind_theme'); } catch {
        const prefs = new Map();
        Object.defineProperty(window, 'localStorage', { value: { getItem: k => prefs.get(k) || null, setItem: (k, v) => prefs.set(k, v) } });
      }
    }

    // The sandboxed workbench has no filesystem, Node APIs or access to the host document.

    const PANEL_ID = 'accremind';
    const PANEL_TITLE = 'AccreMind';
    const NS = 'accremind';
    // Slots under conversation.* hand us their session; the main panel is workspace-wide, so it
    // remembers the most recent conversation and falls back to the host's session list.
    let lastSessionId = null;
    function rememberSession(sessionId) {
      if (typeof sessionId === 'string' && sessionId) lastSessionId = sessionId;
      return sessionId;
    }

    function useSessionSnapshot(sessions) {
      const read = () => sessions?.list?.getSnapshot?.() ?? { ids: [], byId: {} };
      const [snapshot, setSnapshot] = React.useState(read);
      React.useEffect(() => {
        const store = sessions?.list;
        if (typeof store?.subscribe !== 'function') return undefined;
        const sync = () => setSnapshot(store.getSnapshot());
        sync();
        return store.subscribe(sync);
      }, [sessions]);
      return snapshot ?? { ids: [], byId: {} };
    }

    // The sidebar renders panellist entries through renderSlot, so size/active arrive as props.
    function PanelIcon({ size = 18, active = false }) {
      return h('svg', { viewBox: '64 64 384 384', width: size, height: size, fill: 'currentColor',
          opacity: active ? 1 : 0.9, 'aria-hidden': true },
        h('path', { d: 'M234 132Q256 94 278 132L342 244H284L256 195L228 244H170Z' }),
        h('path', { d: 'M159 268H353L378 310Q382 316 374 316H138Q130 316 134 310Z' }),
        h('path', { d: 'M116 340H174L146 389Q142 396 134 396H104Q90 396 96 385ZM396 340H338L366 389Q370 396 378 396H408Q422 396 416 385Z' }));
    }

    // The knowledge base is scoped to the repository, never to one conversation, so the panel does
    // not ask which session to use: it follows the session the host has open in the main view, then
    // the conversation that just talked to us, then any session of the same repository.
    function openSessionId(snapshot) {
      for (const id of snapshot?.ids ?? []) {
        if ((snapshot.byId?.[id]?.retainedBy?.mainView ?? 0) > 0) return id;
      }
      return '';
    }

    function WorkbenchPanel({ sessions, rpcFor }) {
      const frame = React.useRef(null);
      const [html, setHtml] = React.useState('');
      const [error, setError] = React.useState('');
      const snapshot = useSessionSnapshot(sessions);
      const sessionId = openSessionId(snapshot) || lastSessionId || snapshot.ids?.[0] || '';

      React.useEffect(() => {
        function onMessage(event) {
          if (!frame.current || event.source !== frame.current.contentWindow) return;
          if (event.data?.channel !== 'accremind-call') return;
          const { id, method, params } = event.data;
          const target = event.source;
          const reply = data => target.postMessage({ channel: 'accremind-reply', id, ...data }, '*');
          rpcFor(sessionId)(method, params).then(value => reply({ value }), failure => reply({ error: failure.message }));
        }
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [sessionId, rpcFor]);

      React.useEffect(() => {
        let live = true;
        setError('');
        if (!sessionId) { setHtml(''); return undefined; }
        rpcFor(sessionId)('workbench', {}).then(source => {
          if (live) setHtml(source.replace('<head>', () => '<head><script>(' + frameBridge.toString() + ')()<\/script>'));
        }).catch(failure => { if (live) setError(failure.message); });
        return () => { live = false; };
      }, [sessionId, rpcFor]);

      return h('section', { 'aria-label': PANEL_TITLE,
          style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '70vh', boxSizing: 'border-box', gap: 8 } },
        !sessionId
          ? h('p', { role: 'alert' }, '请先在对话中打开一个会话，工作台需要会话上下文来定位项目知识库。')
          : html
            ? h('iframe', { ref: frame, srcDoc: html, sandbox: 'allow-scripts', title: PANEL_TITLE,
                style: { flex: 1, minHeight: 0, width: '100%', border: 0, borderRadius: 8, background: '#fff' } })
            : h('p', null, error || '正在载入经验工作台…'));
    }

    return { inject: ['slots', 'connection', 'sessions', 'locale'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: { panel: PANEL_TITLE }, en: { panel: PANEL_TITLE } }), 'accremind: dictionaries');
      const t = ctx.locale.bind(NS);
      const callFor = sessionId => async (method, params) => {
        const response = await ctx.connection.rpc.call('/api', 'accremind/invoke', { sessionId, method, params });
        if (!response.ok) throw new Error(response.error.message);
        return response.value;
      };
      // Sidebar entry plus the main-area page it selects: the host keys the "main" slot by the
      // panellist id, so both registrations must share PANEL_ID.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
        inject: () => ({ sessions: ctx.sessions, rpcFor: sessionId => callFor(sessionId) }),
      }, WorkbenchPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel'),
      }, PanelIcon));
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: 'accremind-receipt', order: 60,
        inject: sessionId => ({ sessionId: rememberSession(sessionId), call: callFor(sessionId) }),
      }, TurnFooter));
    } };
  },
});
