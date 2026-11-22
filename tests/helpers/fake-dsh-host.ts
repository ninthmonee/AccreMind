/**
 * Minimal in-memory stand-in for the DeepSeek Harness (Cordis) host, modelling only the surface
 * `native-host.ts` relies on: agents service, agent-scoped tool/systemPrompt injection,
 * `agent/pre-step` and `tools/post-execute` waterfalls, `session/event`, and the authenticated
 * connection route. Contract tests against a real `@deepseek-ai/dsh` build should mirror these cases.
 */
import { apply as applyAccreMindPlugin, type DshPluginRuntimeOptions } from '@accremind/dsh-plugin';

type Listener = (...args: any[]) => any;

export interface FakeTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface FakeSection {
  name: string;
  order?: number;
  text: () => string | Promise<string>;
}

export interface FakeAgent {
  id: string;
  session: { id: string; header: { cwd?: string } };
  ctx: any;
  tools: Map<string, FakeTool>;
  sections: FakeSection[];
  disposed: boolean;
}

export interface HostMessage {
  id?: string;
  role: string;
  source?: { kind: string; form?: string; summary?: string };
  content: Array<{ type: string; text?: string }>;
}

export class FakeDshHost {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly agentsById = new Map<string, FakeAgent>();
  private readonly turns = new Map<string, number>();
  private readonly effects: Array<() => void> = [];
  private route: { path: string; fetch: (req: Request) => Promise<Response> } | null = null;

  /** The root plugin context handed to `apply()`. */
  readonly ctx: any;

  constructor(options: { llm?: unknown } = {}) {
    const agentsService = {
      list: () => [...this.agentsById.values()].filter((a) => !a.disposed),
      get: (id: string) => this.agentsById.get(id),
      turnBoundaryOf: (session: { id: string }) => ({ lastTurn: this.turns.get(session.id) ?? 0 }),
    };
    this.ctx = {
      reflect: { provide() {} },
      get: (name: string) => (name === 'agents' ? agentsService : name === 'llm' ? options.llm : undefined),
      on: (event: string, listener: Listener) => {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return () => list.splice(list.indexOf(listener), 1);
      },
      inject: (names: string[], install: (inner: any) => void) => {
        if (names.includes('connection')) {
          install({
            get: () => ({ fetch: { register: (spec: any) => { this.route = spec; } } }),
          });
        }
        return { dispose: async () => {} };
      },
      effect: (setup: () => () => void) => {
        this.effects.push(setup());
      },
    };
  }

  mount(options: DshPluginRuntimeOptions): void {
    applyAccreMindPlugin(this.ctx, options);
  }

  /** Simulates the host creating an agent for a session opened in `cwd`. */
  createAgent(sessionId: string, cwd: string): FakeAgent {
    const agent: FakeAgent = {
      id: `agent-${sessionId}`,
      session: { id: sessionId, header: { cwd } },
      tools: new Map(),
      sections: [],
      disposed: false,
      ctx: null,
    };
    agent.ctx = {
      inject: (_names: string[], install: (inner: any) => void) => {
        const ownTools: string[] = [];
        install({
          get: (name: string) =>
            name === 'tools'
              ? { register: (tool: FakeTool) => { agent.tools.set(tool.name, tool); ownTools.push(tool.name); } }
              : { section: (spec: FakeSection) => { agent.sections.push(spec); } },
        });
        return {
          dispose: async () => {
            for (const n of ownTools) agent.tools.delete(n);
            agent.sections.length = 0;
          },
        };
      },
    };
    this.agentsById.set(sessionId, agent);
    this.emit('agent/created', { agent });
    return agent;
  }

  disposeAgent(agent: FakeAgent): void {
    agent.disposed = true;
    this.emit('agent/disposed', { agent });
    this.agentsById.delete(agent.session.id);
  }

  /** Runs the pre-step waterfall for a new user message and returns the admitted messages. */
  async preStep(agent: FakeAgent, userText: string): Promise<HostMessage[]> {
    const turn = (this.turns.get(agent.session.id) ?? 0) + 1;
    this.turns.set(agent.session.id, turn);
    const messages: HostMessage[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }];
    const base = async () => ({ kind: 'enter', messages: [...messages] });
    const decision = await this.waterfall('agent/pre-step', base, {
      agent, messages, turn, signal: new AbortController().signal,
    });
    return decision.messages as HostMessage[];
  }

  /** Runs the post-execute waterfall for a finished tool call and returns extra contexts. */
  async afterTool(agent: FakeAgent, name: string, args: Record<string, unknown>, text: string, isError = false): Promise<HostMessage[]> {
    const base = async () => ({ kind: 'accept' });
    const decision = await this.waterfall('tools/post-execute', base,
      { agent, name, arguments: args }, { isError, content: [{ type: 'text', text }] });
    return (decision.additionalContexts ?? []) as HostMessage[];
  }

  endTurn(agent: FakeAgent, assistantText: string): void {
    for (const fn of this.listeners.get('session/event') ?? []) {
      fn(agent.session, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } } });
      fn(agent.session, { type: 'turn/end' });
    }
  }

  /** Calls the workbench route the way the DSH web client does. */
  async invoke(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; value?: any; error?: { message: string } }> {
    if (!this.route) throw new Error('route not registered');
    const res = await this.route.fetch(new Request('http://dsh.local' + this.route.path, {
      method: 'POST',
      body: JSON.stringify({ rpcId: 1, method: 'accremind/invoke', payload: { sessionId, method, params } }),
    }));
    return ((await res.json()) as { result: any }).result;
  }

  get routePath(): string | null {
    return this.route?.path ?? null;
  }

  dispose(): void {
    for (const cleanup of this.effects.splice(0)) cleanup();
  }

  private emit(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
  }

  /** Cordis waterfall: each listener receives `next`, which calls the following listener or the base. */
  private async waterfall(event: string, base: () => Promise<any>, ...args: unknown[]): Promise<any> {
    const list = [...(this.listeners.get(event) ?? [])];
    const run = (i: number): Promise<any> => (i >= list.length ? base() : list[i]!(...args, () => run(i + 1)));
    return run(0);
  }
}
