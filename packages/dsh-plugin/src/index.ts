import { createDemoSessions } from './demo-workspace.ts';
import { repositoryLedgerSharing, workspaceGate, workspaceModelConsent } from './workspace-settings.ts';
import {
  AutoCaptureCoordinator,
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  OpenAiCompatibleLlmClient,
  resolveLlmEndpoint,
  TriageEngine,
  ViewCompiler,
  type AccreMindConfig,
  type CompiledTurnView,
  type LlmInferenceAdapter,
} from '@accremind/core';
import type {
  CordisContext,
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
    modelUpload: false,
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
  /** Resolves once background startup work (the Git freshness scan) has finished. */
  whenReady(): Promise<void>;
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
  return resolveLlmEndpoint(process.env).configured ? new OpenAiCompatibleLlmClient() : null;
}

export function createAccreMindRuntime(
  rawOptions: DshPluginRuntimeOptions = {},
): AccreMindPluginInstance {
  return createWorkspaceRuntime(rawOptions, false);
}

function createWorkspaceRuntime(rawOptions: DshPluginRuntimeOptions, demoMode: boolean): AccreMindPluginInstance {
  let disposed = false;
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
  const ledgerSharing = repositoryLedgerSharing(store.paths);
  store.setShareLedger(() => ledgerSharing.read());

  store.initializeAndReconcile();
  const stalenessScanner = new GitStalenessScanner(store);
  // The Git freshness scan shells out to git and can take seconds on large repositories. It runs
  // after the current host callback returns so opening a session is never blocked by it.
  let startupScan: Promise<void> | null = new Promise<void>((resolve) => {
    setImmediate(() => {
      try {
        if (!disposed) stalenessScanner.scanWorkspace();
      } catch (error) {
        console.warn(`[accremind] freshness scan skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (!disposed) store.runMaintenance();
      } catch (error) {
        console.warn(`[accremind] maintenance skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        startupScan = null;
        resolve();
      }
    });
  });

  const receipts = new TurnReceipts(store);
  const viewCompiler = new ViewCompiler(store, {
    residentRulesTokens: config.budgets.residentRulesTokens,
    turnRadarTokens: config.budgets.turnRadarTokens,
    toolGuardTokens: config.budgets.toolGuardTokens,
  }, (entry, session, source, file) => receipts.record(entry, session, source, file));

  const gate = workspaceGate(store.paths, config.writeGate);
  // A host-provided adapter is the host's own model service; env keys still need the user's opt-in.
  const consent = workspaceModelConsent(store.paths, Boolean(config.autoCapture.modelUpload || rawOptions.llmAdapter));
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
    const resolved = resolveLlmEndpoint(process.env);
    try { return new URL(resolved.baseUrl).origin; }
    catch { return '自定义推理端点'; }
  };
  rpcHandlers['accremind.settings.get'] = () => ({
    writeGate: gate.read(), modelEndpoint: modelEndpoint(), modelAvailable: Boolean(llmAdapter),
    autoCapture: config.autoCapture.enabled, modelUpload: consent.read(), shareLedger: ledgerSharing.read(),
  });
  // Turning sharing on moves this machine's records of repository entries into `.accremind/ledger`
  // (preview them first with accremind.ledger.status); turning it off only stops new writes there.
  rpcHandlers['accremind.settings.setShareLedger'] = ({ shareLedger }) => {
    ledgerSharing.save(shareLedger);
    const moved = shareLedger === true ? store.ledger.exportToRepository((id) => isLocalOnlyEntry(id)) : 0;
    if (shareLedger === true) store.syncFromLedger();
    return { shareLedger: ledgerSharing.read(), moved };
  };
  const isLocalOnlyEntry = (id: string): boolean => {
    const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
    if (!found.found || !found.servable) return true;
    const e = found.entry;
    return e.status === 'probation' || e.layer === 'personal' || e.layer === 'shared_tech';
  };
  rpcHandlers['accremind.ledger.status'] = () => {
    const pending = store.ledger.pendingExport(isLocalOnlyEntry);
    return {
      shared: ledgerSharing.read(),
      sharedFile: ledgerSharing.file,
      pendingCount: pending.length,
      // Exactly what would be committed: no sessions, prompts or usage, notes already redacted.
      preview: pending.slice(0, 20),
    };
  };
  rpcHandlers['accremind.settings.setModelUpload'] = ({ modelUpload }) => {
    consent.save(modelUpload);
    return { modelUpload: consent.read() };
  };
  rpcHandlers['accremind.settings.setGate'] = ({ writeGate }) => {
    gate.save(writeGate);
    return { writeGate: gate.read() };
  };

  const sessionSurfacedMap = new Map<string, Set<string>>();
  const MAX_TRACKED_SESSIONS = 200;
  const getSessionSet = (sessionId: string): Set<string> => {
    let set = sessionSurfacedMap.get(sessionId);
    if (set) {
      // Refresh recency so long-running sessions are not evicted.
      sessionSurfacedMap.delete(sessionId);
    } else {
      set = new Set<string>();
    }
    sessionSurfacedMap.set(sessionId, set);
    while (sessionSurfacedMap.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessionSurfacedMap.keys().next().value;
      if (oldest === undefined) break;
      sessionSurfacedMap.delete(oldest);
    }
    return set;
  };


  return {
    store,
    viewCompiler,
    triageEngine,
    stalenessScanner,
    autoCapture,
    tools,
    rpcHandlers,

    whenReady(): Promise<void> {
      return startupScan ?? Promise.resolve();
    },

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
      // Rely on the host's error flag and explicit exit codes; matching words like "Error:" in output
      // flagged ordinary logs and greps as failures.
      const cmdFailed =
        Boolean(payload.result.isError) ||
        /(?:Command exited with code|exit(?:ed)? (?:with )?code|exit status)[:\s]+[1-9]\d*/i.test(outputJoined) ||
        (isCmd && /^\s*(?:FAIL|✗|not ok)\b/m.test(outputJoined));

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
      if (enqueuedJob && llmAdapter && consent.read()) {
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
 * DeepSeek Harness (`@deepseek-ai/dsh` / Cordis) plugin entry.
 * There is exactly one integration path: agent-scoped tools and rules section, the `agent/pre-step`
 * and `tools/post-execute` waterfalls, `session/event`, and the authenticated connection route
 * (see `native-host.ts`). Hosts without the agents service are not supported.
 */
export function apply(ctx: CordisContext, rawOptions: DshPluginRuntimeOptions = {}): void {
  if (!ctx.get || !ctx.reflect || !ctx.on || !ctx.inject) {
    throw new Error('AccreMind 需要支持 agents 服务的 DeepSeek Harness 版本，请升级 dsh 后重试。');
  }
  mountNativeHost(ctx, rawOptions, createAccreMindRuntime);
}
