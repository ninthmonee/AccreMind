import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const clientPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'dsh-plugin', 'client.js');

interface SlotRegistration {
  spec: Record<string, any>;
  component: unknown;
}

interface FakeHost {
  ctx: Record<string, any>;
  registrations: SlotRegistration[];
  rpcCalls: Array<{ sessionId: string; method: string; params: unknown }>;
  selected: string[];
}

function loadContribution() {
  const source = fs.readFileSync(clientPath, 'utf8');
  let contribution: { id: string; factory: (req: (id: string) => unknown) => any } | undefined;
  const sandbox = { __ModuleLoader__: { load: (value: typeof contribution) => { contribution = value; } } };
  new Function('window', source)(sandbox);
  assert.ok(contribution, 'client bundle must register itself through window.__ModuleLoader__');
  const factory = (request: (id: string) => unknown) => contribution!.factory(request);
  return { contribution: contribution!, factory };
}

const pendingEffects: Array<() => void> = [];

function fakeReact(): unknown {
  return {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type, props: props ?? {}, children,
    }),
    Fragment: Symbol('fragment'),
    useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
    useEffect: (fn: () => void) => { pendingEffects.push(fn); },
    useRef: () => ({ current: null }),
  };
}

function fakeHost(options: { ok?: boolean; message?: string; sessionSnapshot?: unknown } = {}): FakeHost {
  const registrations: SlotRegistration[] = [];
  const rpcCalls: FakeHost['rpcCalls'] = [];
  const selected: string[] = [];
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    locale: { register: () => () => {}, bind: () => (key: string) => (key === 'panel' ? 'AccreMind' : key) },
    slots: {
      inject: (_name: string, factory: () => unknown) => { factory(); },
      register: (spec: Record<string, any>, component: unknown) => {
        registrations.push({ spec, component });
        return () => {};
      },
    },
    connection: {
      rpc: {
        call: async (_route: string, _method: string, payload: { sessionId: string; method: string; params: unknown }) => {
          rpcCalls.push({ sessionId: payload.sessionId, method: payload.method, params: payload.params });
          if (options.ok === false) return { ok: false, error: { message: options.message ?? 'rpc failed' } };
          return { ok: true, value: '<html></html>' };
        },
      },
    },
    sessions: {
      list: {
        getSnapshot: () => options.sessionSnapshot ?? { ids: [], byId: {} },
        subscribe: () => () => {},
      },
    },
    layout: { selectPanel: (id: string) => { selected.push(id); } },
  };
  return { ctx, registrations, rpcCalls, selected };
}

function applyClient(host: FakeHost) {
  const { factory } = loadContribution();
  const contribution = factory((id: string) => {
    if (id === 'react') return fakeReact();
    throw new Error('unexpected require: ' + id);
  });
  contribution.apply(host.ctx);
  return contribution;
}

function renderTree(node: any): any {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (Array.isArray(node)) return node.map(renderTree).filter(child => child !== null);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return renderTree(node.type({ ...node.props, children: node.children }));
  return { type: node.type, props: node.props, children: node.children.map(renderTree).filter((c: unknown) => c !== null) };
}

function typesOf(node: any, acc: any[] = []): any[] {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return acc;
  if (Array.isArray(node)) { for (const child of node) typesOf(child, acc); return acc; }
  if (typeof node !== 'object') return acc;
  acc.push(node.type);
  typesOf(node.children, acc);
  return acc;
}

function textOf(node: any): string {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  return textOf(node.children);
}

function renderPanel(host: FakeHost, rpcFor?: (sessionId: string) => unknown): any {
  const entry = host.registrations.find(item => item.spec.name === 'main')!;
  const props = entry.spec.inject();
  pendingEffects.length = 0;
  const tree = renderTree({ type: entry.component, props: { ...props, ...(rpcFor ? { rpcFor } : {}) }, children: [] });
  const load = pendingEffects.at(-1);
  pendingEffects.length = 0;
  load?.();
  return tree;
}

function specOf(host: FakeHost, name: string): Record<string, any> {
  const found = host.registrations.find(entry => entry.spec.name === name);
  assert.ok(found, 'expected a registration for slot ' + name);
  return found!.spec;
}

describe('client contribution: sidebar panel entry', () => {
  it('declares the services it borrows from the host', () => {
    const host = fakeHost();
    const contribution = applyClient(host);
    for (const service of ['slots', 'connection', 'sessions', 'locale']) {
      assert.ok(contribution.inject.includes(service), 'missing service ' + service);
    }
  });

  it('registers a sidebar entry and the main page it selects under one id', () => {
    const host = fakeHost();
    applyClient(host);
    const names = host.registrations.map(entry => entry.spec.name).sort();
    assert.deepEqual(names, ['conversation.chat.turnTail', 'main', 'sidebar.panellist']);
    const entry = specOf(host, 'sidebar.panellist');
    assert.equal(entry.id, 'accremind');
    assert.equal(entry.order, 40);
    assert.equal(entry.locale, 'accremind');
    assert.equal(entry.label(), 'AccreMind');
    const page = specOf(host, 'main');
    assert.equal(page.key, entry.id, 'the main slot must be keyed by the panellist id');
  });

  it('follows the conversation open in the main view and never asks which session to use', () => {
    const host = fakeHost({ sessionSnapshot: {
      ids: ['s-old', 's-open'],
      byId: {
        's-old': { id: 's-old', title: '旧会话' },
        's-open': { id: 's-open', title: '当前会话', retainedBy: { mainView: 1 } },
      },
    } });
    applyClient(host);
    const calls: string[] = [];
    const tree = renderPanel(host, (sessionId: string) => { calls.push(sessionId); return async () => '<html></html>'; });
    assert.equal(typesOf(tree).includes('select'), false, 'the header must not offer a session picker');
    assert.deepEqual(calls, ['s-open'], 'the panel reads the knowledge base through the open conversation');
  });

  it('falls back to any session of the same repository when no main view is marked', () => {
    const host = fakeHost({ sessionSnapshot: { ids: ['s-only'], byId: { 's-only': { id: 's-only', title: '会话' } } } });
    applyClient(host);
    const calls: string[] = [];
    renderPanel(host, (sessionId: string) => { calls.push(sessionId); return async () => '<html></html>'; });
    assert.deepEqual(calls, ['s-only']);
  });

  it('routes panel RPC through the host connection with the resolved session', async () => {
    const host = fakeHost();
    applyClient(host);
    const injected = specOf(host, 'main').inject();
    await injected.rpcFor('session-1')('accremind.settings.get', {});
    assert.deepEqual(host.rpcCalls, [{ sessionId: 'session-1', method: 'accremind.settings.get', params: {} }]);
  });

  it('surfaces a failed host reply as an error message', async () => {
    const host = fakeHost({ ok: false, message: '请先在此项目中打开 DSH 会话' });
    applyClient(host);
    const call = specOf(host, 'conversation.chat.turnTail').inject('session-2').call;
    await assert.rejects(() => call('accremind.turn.list', {}), /请先在此项目中打开 DSH 会话/);
  });

  it('leaves the composer untouched so the sidebar entry is the only entry point', () => {
    const host = fakeHost();
    applyClient(host);
    assert.equal(host.registrations.some(entry => entry.spec.name === 'conversation.composer.dock'), false,
      'composer dock must stay free of AccreMind buttons');
    assert.deepEqual(host.selected, [], 'nothing may switch panels on its own');
  });
});
