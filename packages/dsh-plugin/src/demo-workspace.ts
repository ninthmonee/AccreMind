import { initializeDemoProject } from './demo-fixture.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccreMindPluginInstance } from './index.ts';
import type { RpcHandlerMap } from './rpc-handlers.ts';

/** Each browser session gets a disposable project and an independent global index. */
export function createDemoSessions(create: (project: string, global: string) => AccreMindPluginInstance) {
  const sessions = new Map<string, {
    runtime: AccreMindPluginInstance; directory: string; lastUsed: number; pending: number; closing: boolean;
  }>();

  function close(token: string) {
    const session = sessions.get(token);
    if (!session) return;
    session.closing = true;
    if (session.pending) return;
    sessions.delete(token);
    try {
      session.runtime.dispose();
    } finally {
      rmSync(session.directory, { recursive: true, force: true });
    }
  }

  const handlers: RpcHandlerMap = {
    'accremind.demo.open': async () => {
      const directory = mkdtempSync(join(tmpdir(), 'accremind-playground-'));
      const token = randomUUID();
      try {
        const project = join(directory, '示例项目');
        initializeDemoProject(project);
        const runtime = create(project, join(directory, 'global'));
        sessions.set(token, { runtime, directory, lastUsed: Date.now(), pending: 0, closing: false });
        await runtime.rpcHandlers['accremind.demo.seed']!({});
        return { token };
      } catch (error) {
        if (sessions.has(token)) close(token);
        else rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
    'accremind.demo.call': async (params) => {
      const token = String(params.token ?? '');
      const session = sessions.get(token);
      if (!session || session.closing) throw new Error('演示已结束，请返回工作区后重新打开。');
      const method = String(params.method ?? '');
      if (!method.startsWith('accremind.') || method.startsWith('accremind.demo.') ||
          !Object.hasOwn(session.runtime.rpcHandlers, method)) throw new Error('演示空间不支持此操作。');
      session.lastUsed = Date.now();
      session.pending++;
      try {
        return await session.runtime.rpcHandlers[method]!(params.params as Record<string, unknown> ?? {});
      } finally {
        session.pending--;
        if (session.closing) close(token);
      }
    },
    'accremind.demo.close': ({ token }) => { close(String(token ?? '')); return { closed: true }; },
  };

  const timer = setInterval(() => {
    for (const [token, session] of sessions) {
      if (!session.pending && Date.now() - session.lastUsed > 30 * 60_000) close(token);
    }
  }, 60_000);
  timer.unref();
  return { handlers, dispose() { clearInterval(timer); for (const token of sessions.keys()) close(token); } };
}
