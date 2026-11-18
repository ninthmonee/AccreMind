import { createDemoSessions } from './demo-workspace.ts';
import { workspaceGate } from './workspace-settings.ts';
import {
  AutoCaptureCoordinator,
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  OpenAiCompatibleLlmClient,
  TriageEngine,
  ViewCompiler,
  type AccreMindConfig,
  type CompiledTurnView,
  type LlmInferenceAdapter,
} from '@accremind/core';
import type {
  CordisContext,
  DshNativeToolPostExecuteContext,
  DshToolAfterHookPayload,
  DshToolDefinition,
  DshTurnHookPayload,
} from './cordis-types.ts';
import { TurnReceipts } from './turn-receipts.ts';
import { mountNativeHost } from './native-host.ts';
import { createWebuiRpcHandlers, type RpcHandlerMap } from './rpc-handlers.ts';
import { extractTargetRelativePath, interceptFileToolResult } from './tool-guard.ts';
import { createAccreMindTools } from './tools.ts';

export * from './cordis-types.ts';
export * from './tool-guard.ts';
export * from './tools.ts';
export * from './rpc-handlers.ts';
export * from './webui/ui-bundle.ts';
export * from './webui/local-server.ts';

export const name = 'accremind';
export const inject = ['tools', 'agents', 'systemPrompt'];

export interface DshPluginRuntimeOptions extends Partial<AccreMindConfig> {
  projectRoot?: string;
  workspaceId?: string;
  llmAdapter?: LlmInferenceAdapter | null;
}

export const DEFAULT_ACCREMIND_CONFIG: AccreMindConfig = {
  globalDir: '~/.dsh/accremind',
  projectDirName: '.accremind',
  writeGate: 'probation',
  maxProbationExposures: 3,
  assessmentMode: 'single_pass',
  budgets: {
    residentRulesTokens: 500,
    turnRadarTokens: 300,
    toolGuardTokens: 240,
    toolReadMaxTokens: 1500,
  },
  autoCapture: {
    enabled: true,
  },
};

export interface AccreMindPluginInstance {
  readonly store: LocalMarkdownSqliteStore;
  readonly viewCompiler: ViewCompiler;
  readonly triageEngine: TriageEngine;
  readonly stalenessScanner: GitStalenessScanner;
  readonly autoCapture: AutoCaptureCoordinator;
  readonly tools: DshToolDefinition<any>[];
  readonly rpcHandlers: RpcHandlerMap;
  compileResidentSystemSection(): string;
  compileBeforeTurn(payload: DshTurnHookPayload): CompiledTurnView;
  handleAfterTool(payload: DshToolAfterHookPayload): DshToolAfterHookPayload['result'];
  handleTurnCompleted(payload: {
    sessionId: string;
    userPrompt?: string;
    assistantReply?: string;
  }): Promise<void>;
  dispose(): void;
}

const COMMAND_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'shell',
  'exec_command',
  'terminal',
]);

function resolveDefaultLlmAdapter(explicit?: LlmInferenceAdapter | null): LlmInferenceAdapter | null {
  if (explicit !== undefined) return explicit;
  const hasKeyOrLocalEndpoint = Boolean(
    process.env.ACCREMIND_LLM_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ACCREMIND_LLM_BASE_URL,
  );
  return hasKeyOrLocalEndpoint ? new OpenAiCompatibleLlmClient() : null;
}

export function createAccreMindRuntime(
  rawOptions: DshPluginRuntimeOptions = {},
): AccreMindPluginInstance {
  return createWorkspaceRuntime(rawOptions, false);
}

function createWorkspaceRuntime(rawOptions: DshPluginRuntimeOptions, demoMode: boolean): AccreMindPluginInstance {
  const config: AccreMindConfig = {
    ...DEFAULT_ACCREMIND_CONFIG,
    ...rawOptions,
    budgets: {
      ...DEFAULT_ACCREMIND_CONFIG.budgets,
      ...(rawOptions.budgets ?? {}),
    },
    autoCapture: {
      ...DEFAULT_ACCREMIND_CONFIG.autoCapture,
      ...(rawOptions.autoCapture ?? {}),
    },
  };

  const projectRoot = rawOptions.projectRoot ?? process.cwd();
  const store = new LocalMarkdownSqliteStore({
    projectRoot,
    globalDir: config.globalDir,
    projectDirName: config.projectDirName,
    workspaceId: rawOptions.workspaceId,
    maxProbationExposures: config.maxProbationExposures,
  });

  store.initializeAndReconcile();
  const stalenessScanner = new GitStalenessScanner(store);
  stalenessScanner.scanWorkspace();

  const receipts = new TurnReceipts(store);
  const viewCompiler = new ViewCompiler(store, {
    residentRulesTokens: config.budgets.residentRulesTokens,
    turnRadarTokens: config.budgets.turnRadarTokens,
    toolGuardTokens: config.budgets.toolGuardTokens,
  }, (entry, session, source, file) => receipts.record(entry, session, source, file));

  const gate = workspaceGate(store.paths, config.writeGate);
  const triageEngine = new TriageEngine(store, gate.read);
  const llmAdapter = resolveDefaultLlmAdapter(rawOptions.llmAdapter);

  const autoCapture = new AutoCaptureCoordinator({
    store,
    triageEngine,
    llm: llmAdapter,
    assessmentMode: config.assessmentMode,
  });

  const tools = createAccreMindTools({
    store,
    triageEngine,
    maxReadTokens: config.budgets.toolReadMaxTokens,
  });
  const rpcHandlers = createWebuiRpcHandlers({
    receipts,
    tools,
    demoMode,
    store,
    viewCompiler,
    budgets: config.budgets,
    stalenessScanner,
    triageEngine,
    autoCapture,
    getLlmAdapter: () => llmAdapter,
  });

  const demoSessions = demoMode ? null : createDemoSessions((projectRoot, globalDir) =>
    createWorkspaceRuntime({ projectRoot, globalDir, llmAdapter: null, autoCapture: { enabled: false } }, true),
  );
  Object.assign(rpcHandlers, demoSessions?.handlers);
  const modelEndpoint = () => {
    if (!llmAdapter) return '未配置模型';
    if (rawOptions.llmAdapter) return '宿主模型适配器';
    try { return new URL(process.env.ACCREMIND_LLM_BASE_URL || 'https://api.deepseek.com/v1').origin; }
    catch { return '自定义推理端点'; }
  };
  rpcHandlers['accremind.settings.get'] = () => ({
    writeGate: gate.read(), modelEndpoint: modelEndpoint(), modelAvailable: Boolean(llmAdapter),
    autoCapture: config.autoCapture.enabled,
  });
  rpcHandlers['accremind.settings.setGate'] = ({ writeGate }) => {
    gate.save(writeGate);
    return { writeGate: gate.read() };
  };

  const sessionSurfacedMap = new Map<string, Set<string>>();
  const getSessionSet = (sessionId: string): Set<string> => {
    let set = sessionSurfacedMap.get(sessionId);
    if (!set) {
      set = new Set<string>();
      sessionSurfacedMap.set(sessionId, set);
    }
    return set;
  };

  let disposed = false;

  return {
    store,
    viewCompiler,
    triageEngine,
    stalenessScanner,
    autoCapture,
    tools,
    rpcHandlers,

    compileResidentSystemSection(): string {
      return viewCompiler.compileTurnView({ sessionId: 'system-prefix' }).residentPrefix;
    },

    compileBeforeTurn(payload: DshTurnHookPayload): CompiledTurnView {
      receipts.begin(payload.sessionId, payload.turnId);
      const surfaced = getSessionSet(payload.sessionId);
      if (payload.userPrompt) {
        autoCapture.recordTurnConversation(payload.sessionId, payload.userPrompt, undefined);
      }
      const compiled = viewCompiler.compileTurnView(
        {
          sessionId: payload.sessionId,
          userPrompt: payload.userPrompt,
          activeFiles: payload.activeFiles,
          errorOutput: payload.errorOutput,
        },
        surfaced,
      );
      if (compiled.residentPrefix && payload.injectSystemStablePrefix) {
        payload.injectSystemStablePrefix(compiled.residentPrefix);
      }
      for (const id of compiled.residentRuleIds) {
        const item = store.getEntry(id, { recordUsage: false });
        if (item.found && item.servable) receipts.record(item.entry, payload.sessionId, 'rule');
      }
      if (compiled.radarBlock && payload.injectTurnEphemeralContext) {
        payload.injectTurnEphemeralContext(compiled.radarBlock);
      }
      return compiled;
    },

    handleAfterTool(payload: DshToolAfterHookPayload) {
      receipts.begin(payload.sessionId, payload.turnId);
      const surfaced = getSessionSet(payload.sessionId);
      const editedRelPath =
        payload.toolName === 'read_file'
          ? null
          : extractTargetRelativePath(projectRoot, payload.toolName, payload.args);

      const isCmd = COMMAND_TOOL_NAMES.has(payload.toolName);
      const outputJoined = payload.result.content.map((c) => c.text).join('\n');
      const cmdFailed =
        Boolean(payload.result.isError) ||
        /\b(?:FAIL|AssertionError|Error:|Command exited with code [1-9])\b/.test(outputJoined);

      if (config.autoCapture.enabled) {
        autoCapture.recordToolActivity({
          sessionId: payload.sessionId,
          toolName: payload.toolName,
          editedRelPath,
          isCommandOrTest: isCmd,
          failed: cmdFailed,
        });
      }

      const intercepted = interceptFileToolResult({
        projectRoot,
        viewCompiler,
        sessionId: payload.sessionId,
        sessionSurfacedIds: surfaced,
        toolName: payload.toolName,
        args: payload.args,
        result: payload.result,
      });
      return intercepted.result;
    },

    async handleTurnCompleted(payload) {
      receipts.finish(payload.sessionId);
      if (!config.autoCapture.enabled) return;
      autoCapture.recordTurnConversation(
        payload.sessionId,
        payload.userPrompt,
        payload.assistantReply,
      );
      const { enqueuedJob } = autoCapture.checkAndEnqueueSession(payload.sessionId);
      if (enqueuedJob && llmAdapter) {
        // Non-blocking background drain (L2 Iron Law)
        queueMicrotask(() => {
          void autoCapture.processPendingQueue();
        });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      demoSessions?.dispose();
      sessionSurfacedMap.clear();
      store.close();
    },
  };
}

/**
 * Native DeepSeek Harness (`@deepseek-ai/dsh` / Cordis) plugin entry:
 * Wires `ctx.tools`, `ctx.systemPrompt.section`, `ctx.sessions.registerMessageProjection`,
 * `tools/post-execute` waterfall JIT guard, `ctx.provide('accremind')`, and WebUI RPC handlers.
 */
export function apply(ctx: CordisContext, rawOptions: DshPluginRuntimeOptions = {}): void {
  if (ctx.get && ctx.reflect) {
    mountNativeHost(ctx, rawOptions, createAccreMindRuntime);
    return;
  }
  ctx.effect(() => {
    const runtime = createAccreMindRuntime({
      ...rawOptions,
      llmAdapter: rawOptions.llmAdapter ?? ctx.llm ?? undefined,
    });
    const disposers: Array<() => void> = [];

    ctx.provide?.('accremind', runtime);

    // 1. Register the 5 model-facing tools (`@deepseek-ai/dsh-tools`)
    if (ctx.tools) {
      for (const tool of runtime.tools) {
        const off = ctx.tools.register(tool);
        if (typeof off === 'function') disposers.push(off);
      }
    }

    // 2. Mount KV-cache-stable Tier 1 Resident Rules into `@deepseek-ai/dsh-system-prompt`
    if (ctx.systemPrompt?.section) {
      const offPrompt = ctx.systemPrompt.section({
        name: 'accremind-resident-rules',
        order: 80,
        text: () => runtime.compileResidentSystemSection(),
      });
      if (typeof offPrompt === 'function') disposers.push(offPrompt);
    }

    // 3. Project dynamic Tier 2 Contextual Radar into turn messages without mutating raw history
    if (ctx.sessions?.registerMessageProjection) {
      const offProj = ctx.sessions.registerMessageProjection(({ sessionId, messages }) => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        if (!lastUser) return messages;
        const compiled = runtime.compileBeforeTurn({
          sessionId,
          userPrompt: lastUser.content,
        });
        if (!compiled.radarBlock) return messages;
        const next = [...messages];
        const lastIdx = next.lastIndexOf(lastUser);
        next[lastIdx] = {
          ...lastUser,
          content: `${lastUser.content}\n\n${compiled.radarBlock}`,
        };
        return next;
      });
      if (typeof offProj === 'function') disposers.push(offProj);
    }

    // 4. Register DSH waterfall & lifecycle hooks
    if (ctx.on) {
      // Native `@deepseek-ai/dsh` tool post-execute waterfall
      disposers.push(
        ctx.on(
          'tools/post-execute',
          async (execCtx: DshNativeToolPostExecuteContext, next?: () => Promise<unknown>) => {
            if (execCtx?.output) {
              execCtx.output = runtime.handleAfterTool({
                sessionId: execCtx.sessionId ?? 'dsh-session',
                toolName: execCtx.tool,
                args: execCtx.args ?? {},
                result: execCtx.output,
              });
            }
            return typeof next === 'function' ? next() : execCtx?.output;
          },
        ),
      );

      // Explicit turn & tool lifecycle events
      disposers.push(
        ctx.on('dsh/before-turn', (payload: DshTurnHookPayload) => {
          runtime.compileBeforeTurn(payload);
        }),
      );
      disposers.push(
        ctx.on('dsh/after-tool', (payload: DshToolAfterHookPayload) => {
          payload.result = runtime.handleAfterTool(payload);
        }),
      );
      disposers.push(
        ctx.on(
          'dsh/after-turn',
          (payload: { sessionId: string; userPrompt?: string; assistantReply?: string }) => {
            void runtime.handleTurnCompleted(payload);
          },
        ),
      );
    }

    // 5. Register safe Host RPC endpoints & embedded sidebar slot for DSH WebUI
    if (ctx.webui?.registerRpc) {
      for (const [method, handler] of Object.entries(runtime.rpcHandlers)) {
        const off = ctx.webui.registerRpc(method, handler);
        if (typeof off === 'function') disposers.push(off);
      }
    }
    if (ctx.webui?.registerSlot) {
      const footer = ctx.webui.registerSlot({
        slot: 'turn-footer', id: 'accremind-turn-receipt', title: '本轮使用的经验',
        renderHtml: (owner) => {
          if (!owner?.sessionId || !owner.turnId) return '';
          const data = runtime.rpcHandlers['accremind.turn.list']!({ sessionId: owner.sessionId, turnId: owner.turnId }) as { receipts: { hits: { id: string; revision: number }[] }[] };
          const refs = data.receipts[0]?.hits.map(hit => hit.id + '@r' + hit.revision).join('、') ?? '';
          return refs ? '本轮使用的经验 · ' + refs.replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';') : '';
        },
      });
      if (typeof footer === 'function') disposers.push(footer);
      const offSlot = ctx.webui.registerSlot({
        slot: 'sidebar-panel',
        id: 'accremind-workbench',
        title: 'AccreMind 经验基座',
      });
      if (typeof offSlot === 'function') disposers.push(offSlot);
    }

    return () => {
      for (const off of disposers.reverse()) {
        off();
      }
      runtime.dispose();
    };
  });
}
