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
          await call('accremind.feedback.submit', { ...ref, kind: action, detail: detail || '' });
          setMessage(({ verified_effective: hit.status === 'probation' ? '已转为正式经验' : '已记录：有用', inapplicable: '已记录：这次不适用', suspected_error: '已暂停推荐，等待复核' })[action]);
          setActive(null); setNote('');
          const updated = await call('accremind.turn.list', { turnId });
          setHits(updated.receipts[0]?.hits || []);
        } catch (error) { setMessage(error.message); }
        finally { setBusy(false); }
      }
      if (!hits.length && !message) return null;
      return h('section', { 'aria-label': '本轮经验回执', style: { fontSize: '0.88em', marginBlock: 8 } },
        h('details', null, h('summary', null, 'AI 这次参考了 ' + hits.length + ' 条经验'),
          hits.map(hit => h('div', { key: [hit.id, hit.source, hit.filePath].join('|'), style: { marginBlock: 6 } },
            h('span', null, labels[hit.source] + ' · ' + hit.id + '@r' + hit.revision + ' ' + hit.title + (hit.filePath ? ' · ' + hit.filePath : '') + ' '),
            stateLabel(hit),
            availableActions(hit).map(([kind, label]) => h('button', { key: kind, type: 'button', disabled: busy,
              onClick: () => {
                if (kind !== 'suspected_error') return submit(hit, kind);
                setActive({ hit, kind }); setNote('');
              } }, label)))),
          active && h('form', { onSubmit: event => { event.preventDefault(); submit(active.hit, active.kind, note.trim()); } },
            h('label', null, '哪里不对？怎么发现的 ',
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
