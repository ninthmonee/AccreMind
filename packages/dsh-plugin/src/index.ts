import {
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  TriageEngine,
  ViewCompiler,
  type AccreMindConfig,
  type CompiledTurnView,
} from '@accremind/core';
import type {
  CordisContext,
  DshToolAfterHookPayload,
  DshToolDefinition,
  DshTurnHookPayload,
} from './cordis-types.ts';
import { createWebuiRpcHandlers, type RpcHandlerMap } from './rpc-handlers.ts';
import { interceptFileToolResult } from './tool-guard.ts';
import { createAccreMindTools } from './tools.ts';

export * from './cordis-types.ts';
export * from './tool-guard.ts';
export * from './tools.ts';
export * from './rpc-handlers.ts';

export const name = 'accremind';
export const inject = ['tools'];

export interface DshPluginRuntimeOptions extends Partial<AccreMindConfig> {
  projectRoot?: string;
  workspaceId?: string;
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
  readonly tools: DshToolDefinition<any>[];
  readonly rpcHandlers: RpcHandlerMap;
  compileBeforeTurn(payload: DshTurnHookPayload): CompiledTurnView;
  handleAfterTool(payload: DshToolAfterHookPayload): DshToolAfterHookPayload['result'];
  dispose(): void;
}

export function createAccreMindRuntime(
  rawOptions: DshPluginRuntimeOptions = {},
): AccreMindPluginInstance {
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

  const viewCompiler = new ViewCompiler(store, {
    residentRulesTokens: config.budgets.residentRulesTokens,
    turnRadarTokens: config.budgets.turnRadarTokens,
    toolGuardTokens: config.budgets.toolGuardTokens,
  });

  const triageEngine = new TriageEngine(store, config.writeGate);
  const tools = createAccreMindTools({
    store,
    triageEngine,
    maxReadTokens: config.budgets.toolReadMaxTokens,
  });
  const rpcHandlers = createWebuiRpcHandlers({ store, stalenessScanner });

  // Track surfaced entry IDs per session so JIT Tool Guard never nags repeatedly
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
    tools,
    rpcHandlers,

    compileBeforeTurn(payload: DshTurnHookPayload): CompiledTurnView {
      const surfaced = getSessionSet(payload.sessionId);
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
      if (compiled.radarBlock && payload.injectTurnEphemeralContext) {
        payload.injectTurnEphemeralContext(compiled.radarBlock);
      }
      return compiled;
    },

    handleAfterTool(payload: DshToolAfterHookPayload) {
      const surfaced = getSessionSet(payload.sessionId);
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

    dispose() {
      if (disposed) return;
      disposed = true;
      sessionSurfacedMap.clear();
      store.close();
    },
  };
}

/**
 * Native DeepSeek Harness (Cordis) plugin entry:
 * Mounts tools, turn hooks, JIT file tool guard, and WebUI RPC handlers reversibly via `ctx.effect`.
 */
export function apply(ctx: CordisContext, rawOptions: DshPluginRuntimeOptions = {}): void {
  ctx.effect(() => {
    const runtime = createAccreMindRuntime(rawOptions);
    const disposers: Array<() => void> = [];

    if (ctx.tools) {
      for (const tool of runtime.tools) {
        const off = ctx.tools.register(tool);
        if (typeof off === 'function') disposers.push(off);
      }
    }

    if (ctx.on) {
      disposers.push(
        ctx.on('dsh/before-turn', (payload) => {
          runtime.compileBeforeTurn(payload as DshTurnHookPayload);
        }),
      );
      disposers.push(
        ctx.on('dsh/after-tool', (payload) => {
          const typed = payload as DshToolAfterHookPayload;
          typed.result = runtime.handleAfterTool(typed);
        }),
      );
    }

    if (ctx.webui?.registerRpc) {
      for (const [method, handler] of Object.entries(runtime.rpcHandlers)) {
        const off = ctx.webui.registerRpc(method, handler);
        if (typeof off === 'function') disposers.push(off);
      }
    }

    return () => {
      for (const off of disposers.reverse()) {
        off();
      }
      runtime.dispose();
    };
  });
}
