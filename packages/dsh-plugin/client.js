// DSH loads client contributions through its browser module registry.
window.__ModuleLoader__.load({
  id: '@accremind/dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const labels = { rule: '常驻规范', radar: '回合前命中', jit: '文件提醒' };

    function stateLabel(hit) {
      if (hit.currentRevision == null) return '条目已移除';
      if (hit.currentRevision !== hit.revision) return '引用版本已有修订';
      if (hit.currentStatus === 'withdrawn') return '已撤回';
      if (hit.currentStatus === 'archived') return '已归档';
      if (hit.currentServing === 'suspended') return '已暂停检索';
      if (hit.status === 'probation' && hit.currentStatus === 'active') return '已转正';
      if (hit.feedback === 'success') return '本任务已验证';
      return '';
    }

    function availableActions(hit) {
      if (hit.currentRevision !== hit.revision || hit.currentServing !== 'enabled' ||
          !['active', 'probation'].includes(hit.currentStatus)) return [];
      if (hit.feedback === 'success') return [['suspected_error', '补充反证']];
      if (stateLabel(hit)) return [];
      return hit.status === 'probation'
        ? [['promote', '有效转正'], ['dismiss', '淘汰']]
        : [['verified_effective', '验证有效'], ['suspected_error', '疑似错误']];
    }

    function TurnFooter({ sessionId, turn, call }) {
      const [hits, setHits] = React.useState([]);
      const [active, setActive] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const turnId = String(turn.turn);
      React.useEffect(() => {
        let live = true;
        setHits([]); setActive(null); setMessage('');
        if (turn.end) call('accremind.turn.list', { turnId }).then(data => {
          if (live) setHits(data.receipts[0]?.hits || []);
        }).catch(error => { if (live) setMessage(error.message); });
        return () => { live = false; };
      }, [sessionId, turnId, turn.end]);
      async function submit(hit, action, detail) {
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
          if (action === 'dismiss') await call('accremind.probation.decide', { ...ref, action });
          else await call('accremind.feedback.submit', { ...ref, kind: action === 'promote' ? 'verified_effective' : action, detail });
          setMessage(({ promote: '已转正并记录本任务的验证', dismiss: '已淘汰', verified_effective: '已记录本任务的验证', suspected_error: '已暂停检索' })[action]);
          setActive(null); setNote('');
          const updated = await call('accremind.turn.list', { turnId });
          setHits(updated.receipts[0]?.hits || []);
        } catch (error) { setMessage(error.message); }
        finally { setBusy(false); }
      }
      if (!hits.length && !message) return null;
      return h('section', { 'aria-label': '本轮经验回执', style: { fontSize: '0.88em', marginBlock: 8 } },
        h('details', null, h('summary', null, '本轮使用的经验 · ' + hits.length + ' 条'),
          hits.map(hit => h('div', { key: [hit.id, hit.source, hit.filePath].join('|'), style: { marginBlock: 6 } },
            h('span', null, labels[hit.source] + ' · ' + hit.id + '@r' + hit.revision + ' ' + hit.title + (hit.filePath ? ' · ' + hit.filePath : '') + ' '),
            stateLabel(hit),
            availableActions(hit).map(([kind, label]) => h('button', { key: kind, type: 'button', disabled: busy,
              onClick: () => {
                if (kind === 'dismiss') return submit(hit, kind);
                setActive({ hit, kind }); setNote('');
              } }, label)))),
          active && h('form', { onSubmit: event => { event.preventDefault(); submit(active.hit, active.kind, note.trim()); } },
            h('label', null, active.kind === 'suspected_error' ? '本次反证及复现结果 ' : '本次验证依据（测试结果或工单） ',
              h('input', { value: note, required: true, onChange: event => setNote(event.target.value) })),
            h('button', { type: 'submit', disabled: busy || !note.trim() }, '提交')),
        ), h('div', { role: 'status' }, message));
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

    function Workbench({ call, sessionId }) {
      const frame = React.useRef(null);
      const dialog = React.useRef(null);
      const [html, setHtml] = React.useState('');
      const [error, setError] = React.useState('');
      React.useEffect(() => {
        setHtml(''); setError(''); dialog.current?.close();
        function onMessage(event) {
          if (!frame.current || event.source !== frame.current.contentWindow || event.data?.channel !== 'accremind-call') return;
          const { id, method, params } = event.data;
          const target = event.source;
          const reply = data => target.postMessage({ channel: 'accremind-reply', id, ...data }, '*');
          call(method, params).then(value => reply({ value }), error => reply({ error: error.message }));
        }
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
      }, [sessionId]);
      async function open() {
        dialog.current?.showModal();
        try {
          const source = await call('workbench', {});
          setHtml(source.replace('<head>', () => '<head><script>(' + frameBridge.toString() + ')()<\/script>'));
        } catch (failure) { setError(failure.message); }
      }
      return h(React.Fragment, null,
        h('button', { type: 'button', onClick: open }, 'AccreMind 经验工作台'),
        h('dialog', { ref: dialog, onClose: () => { setHtml(''); setError(''); }, 'aria-label': 'AccreMind 经验工作台',
          style: { width: '94vw', maxWidth: 1440, height: '92vh', padding: 8, borderRadius: 8 } },
          h('button', { type: 'button', onClick: () => dialog.current?.close() }, '关闭工作台'),
          error ? h('p', { role: 'alert' }, error) : html
            ? h('iframe', { ref: frame, srcDoc: html, sandbox: 'allow-scripts', title: 'AccreMind 工作台',
                style: { display: 'block', width: '100%', height: 'calc(100% - 2em)', border: 0 } })
            : h('p', null, '正在打开工作台…')));
    }

    return { inject: ['slots', 'connection'], apply(ctx) {
      function register(name, id, component) {
        ctx.slots.inject(name, () => ctx.slots.register({
          name, id, order: 60,
          inject: sessionId => ({ sessionId, call: async (method, params) => {
            const response = await ctx.connection.rpc.call('/api', 'accremind/invoke', { sessionId, method, params });
            if (!response.ok) throw new Error(response.error.message);
            return response.value;
          } }),
        }, component));
      }
      register('conversation.chat.turnTail', 'accremind-receipt', TurnFooter);
      register('conversation.composer.dock', 'accremind-workbench', Workbench);
    } };
  },
});
