import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { CordisContext, DshToolResult } from './cordis-types.ts';
import type { AccreMindPluginInstance, DshPluginRuntimeOptions } from './index.ts';
import { renderAccreMindWebuiHtml } from './webui/ui-bundle.ts';

interface HostAgent {
  id: string;
  session: { id: string; header: { cwd?: string } };
  ctx: CordisContext;
}
interface HostMessage { role: string; content: Array<{ type: string; text?: string }> }
interface Decision { kind: string; messages: HostMessage[] }

function plainText(message?: HostMessage): string {
  return (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
}

/** Cordis/DSH uses scoped tools, pre-step admission and its authenticated Connection RPC carrier. */
export function mountNativeHost(ctx: CordisContext, options: DshPluginRuntimeOptions,
  makeRuntime: (config: DshPluginRuntimeOptions) => AccreMindPluginInstance) {
  const runtimes = new Map<string, AccreMindPluginInstance>();
  const sessions = new Map<string, AccreMindPluginInstance>();
  const mounted = new Map<HostAgent, { dispose(): Promise<void> }>();
  const prompts = new Map<string, string>();
  const replies = new Map<string, string>();
  const agents = ctx.get!('agents');
  const runtimeFor = (agent: HostAgent) => {
    const cwd = options.projectRoot || agent.session.header.cwd;
    if (!cwd || !path.isAbsolute(cwd)) return;
    const root = path.resolve(cwd);
    let runtime = runtimes.get(root);
    if (!runtime) {
      runtime = makeRuntime({ ...options, projectRoot: root });
      runtimes.set(root, runtime);
    }
    sessions.set(agent.session.id, runtime);
    return runtime;
  };

  function attach(agent: HostAgent) {
    if (mounted.has(agent)) return;
    const runtime = runtimeFor(agent);
    if (!runtime) return;
    const binding = agent.ctx.inject!(['tools', 'systemPrompt'], inner => {
      for (const tool of runtime.tools) {
        inner.get!('tools').register({
          name: tool.name, parameters: tool.parameters, description: tool.description,
          output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
          execute: async (args: Record<string, unknown>) => {
            const result = await tool.execute(args, { sessionId: agent.session.id });
            const text = result.content.map(block => block.text).join('\n');
            if (result.isError) throw new Error(text);
            return text;
          },
        });
      }
      inner.get!('systemPrompt').section({
        name: 'accremind-resident-rules', order: 80, interpolate: false, text: () => runtime.compileResidentSystemSection(),
      });
    }) as { dispose(): Promise<void> };
    mounted.set(agent, binding);
  }
  function detach(agent: HostAgent) {
    const binding = mounted.get(agent);
    if (binding) void binding.dispose();
    mounted.delete(agent);
    prompts.delete(agent.session.id);
    replies.delete(agent.session.id);
  }

  ctx.on!('agent/created', ({ agent }) => attach(agent));
  ctx.on!('agent/disposed', ({ agent }) => detach(agent));
  for (const agent of agents?.list() ?? []) attach(agent);

  ctx.on!('agent/pre-step', async (event: { agent: HostAgent; messages: HostMessage[]; turn: number; signal: AbortSignal }, next: () => Promise<Decision>) => {
    const decision = await next();
    if (decision.kind !== 'enter' || event.signal.aborted) return decision;
    const runtime = runtimeFor(event.agent);
    if (!runtime) return decision;
    const sessionId = event.agent.session.id;
    const prompt = plainText(event.messages.filter(m => m.role === 'user').at(-1));
    if (prompt) prompts.set(sessionId, prompt);
    const view = runtime.compileBeforeTurn({ sessionId, turnId: String(event.turn), userPrompt: prompt });
    if (!view.radarBlock) return decision;
    // The native pre-step waterfall admits immutable, identified user context messages.
    const context = { id: randomUUID(), role: 'user', source: { kind: 'accremind', form: 'notice', summary: '本轮经验' },
      content: [{ type: 'text', text: view.radarBlock }] };
    return { ...decision, messages: [...decision.messages, context] };
  });

  ctx.on!('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (!exec.agent || decision.kind !== 'accept') return decision;
    const runtime = runtimeFor(exec.agent);
    if (!runtime) return decision;
    const sessionId = exec.agent.session.id;
    const names: Record<string, string> = { read: 'read_file', edit: 'edit_file', write: 'write_file' };
    const input: DshToolResult = { isError: result.isError, content: (result.content ?? []).filter((b: { type: string }) => b.type === 'text') };
    const guarded = runtime.handleAfterTool({
      sessionId, turnId: String(agents.turnBoundaryOf(exec.agent.session).lastTurn),
      toolName: names[exec.name] ?? exec.name, args: exec.arguments ?? {}, result: input,
    });
    const extra = guarded.content.slice(input.content.length);
    if (!extra.length) return decision;
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), {
      id: randomUUID(), role: 'user', source: { kind: 'accremind', form: 'notice', summary: '文件经验提醒' }, content: extra,
    }] };
  });
  ctx.on!('session/event', (session, event) => {
    if (event.type === 'assistant/message') replies.set(session.id, plainText(event.data.message));
    if (event.type !== 'turn/end') return;
    const runtime = sessions.get(session.id);
    void runtime?.handleTurnCompleted({ sessionId: session.id, userPrompt: prompts.get(session.id), assistantReply: replies.get(session.id) });
    prompts.delete(session.id);
    replies.delete(session.id);
  });
  ctx.inject!(['connection'], (inner) => {
    // Exact routes on the host's shared /api carrier are authenticated and owner-only.
    inner.get!('connection').fetch.register({
      path: '/api/accremind/invoke', methods: ['POST'], requestBody: 'buffered',
      fetch: async (request: Request) => {
        const body = await request.json();
        const { method, sessionId, params = {} } = body.payload ?? {};
        const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId: body.rpcId, result });
        try {
          if (body.method !== 'accremind/invoke' || typeof sessionId !== 'string' || !sessionId) throw new Error('请选择会话');
          const agent = agents?.get(sessionId);
          const runtime = agent ? runtimeFor(agent) : sessions.get(sessionId);
          if (!runtime) throw new Error('请先在此项目中打开 DSH 会话');
          if (method === 'workbench') return reply({ ok: true, value: renderAccreMindWebuiHtml({ embedded: true }) });
          if (typeof method !== 'string' || !Object.hasOwn(runtime.rpcHandlers, method)) throw new Error('未知工作台操作');
          if (params.sessionId !== undefined && params.sessionId !== sessionId) throw new Error('会话已切换');
          const scoped = method === 'accremind.turn.list' ? { ...params, sessionId } : params;
          return reply({ ok: true, value: await runtime.rpcHandlers[method]!(scoped) });
        } catch (error) {
          return reply({ ok: false, error: { code: 'ACCREMIND', message: error instanceof Error ? error.message : String(error), details: {} } });
        }
      },
    });
  });
  ctx.effect(() => () => {
    for (const agent of mounted.keys()) detach(agent);
    for (const runtime of runtimes.values()) runtime.dispose();
    sessions.clear(); runtimes.clear();
  });
}
