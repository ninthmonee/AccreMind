import * as path from 'node:path';
import { createDemoSessions } from './demo-workspace.ts';
import { repositoryLedgerSharing, workspaceGate, workspaceModelConsent } from './workspace-settings.ts';
import {
  QueryTagger,
  WorkspaceSignalReader,
  detectLanguages,
  AutoCaptureCoordinator,
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  OpenAiCompatibleLlmClient,
  resolveLlmEndpoint,
  TriageEngine,
  ViewCompiler,
  runAutoTune,
  isExcludedPath,
  isProjectDisabled,
  normalizeExcludePaths,
  LlmUsageMeter,
  meterLlm,
  wrapReadOnlyXmlBlock,
  type AccreMindConfig,
  type CompiledTurnView,
  type LlmCallKind,
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
import { createHostLlmAdapter, describeModelChannel, isHostLlmAdapter } from './host-llm-adapter.ts';
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
  autoEvolve: { demote: true, tune: true, teamFeedback: true },
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
  /**
   * Gathers what the host does not send — the working tree's changed files and branch, and the question's topic
   * tags (vocabulary terms it names; a model on the first turn and on topic changes) — then compiles the turn.
   */
  compileBeforeTurnAsync(payload: DshTurnHookPayload): Promise<CompiledTurnView>;
  handleAfterTool(payload: DshToolAfterHookPayload): DshToolAfterHookPayload['result'];
  handleTurnCompleted(payload: {
    sessionId: string;
    userPrompt?: string;
    assistantReply?: string;
  }): Promise<void>;
  dispose(): void;
}

/** Automatic tuning starts this long after a session opens, so it never competes with the first turns. */
const AUTO_TUNE_DELAY_MS = 60_000;

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
    autoEvolve: {
      ...DEFAULT_ACCREMIND_CONFIG.autoEvolve,
      ...(rawOptions.autoEvolve ?? {}),
    },
  };

  const projectRoot = rawOptions.projectRoot ?? process.cwd();
  const store = new LocalMarkdownSqliteStore({
    projectRoot,
    globalDir: config.globalDir,
    projectDirName: config.projectDirName,
    workspaceId: rawOptions.workspaceId,
    maxProbationExposures: config.maxProbationExposures,
    autoDemotion: config.autoEvolve?.demote !== false && !demoMode,
    teamFeedback: config.autoEvolve?.teamFeedback !== false && !demoMode,
  });
  const ledgerSharing = repositoryLedgerSharing(store.paths);
  store.setShareLedger(() => ledgerSharing.read());

  store.initializeAndReconcile();
  const stalenessScanner = new GitStalenessScanner(store);
  // The Git freshness scan shells out to git and can take seconds on large repositories. It runs
  // after the current host callback returns so opening a session is never blocked by it.
  let autoTuneTimer: ReturnType<typeof setTimeout> | null = null;
  let startupScan: Promise<void> | null = new Promise<void>((resolve) => {
    setImmediate(() => {
      try {
        if (!disposed) stalenessScanner.scanWorkspace();
      } catch (error) {
        console.warn(`[accremind] freshness scan skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        // Languages feed cross-repository relevance (stack match); detecting them lists tracked files, so it
        // runs here, off the session's critical path. Until then the last known languages are used.
        if (!disposed) store.updateRepoProfile({ languages: detectLanguages(projectRoot) });
      } catch (error) {
        console.warn(`[accremind] language detection skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        // Capture jobs queued before a restart are picked up again (in the background, never blocking the session).
        if (!disposed && llmAdapter && consent.read() && config.autoCapture.enabled && autoCapture.hasRunnableJobs() && !scope().paused) {
          void autoCapture.processPendingQueue().catch(() => undefined);
        }
      } catch (error) {
        console.warn(`[accremind] queued captures not resumed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (!disposed) store.runMaintenance();
      } catch (error) {
        console.warn(`[accremind] maintenance skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        startupScan = null;
        resolve();
      }
      // Automatic tuning replays recorded turns, so it waits until the session has settled and yields often.
      if (config.autoEvolve?.tune !== false && !demoMode && !disposed && !scope().paused) {
        autoTuneTimer = setTimeout(() => {
          autoTuneTimer = null;
          if (disposed) return;
          runAutoTune(store, { isCancelled: () => disposed }).then((out) => {
            if (out.action === 'apply' || out.action === 'rollback') console.info(`[accremind] retrieval tuning ${out.action}: ${out.reason}`);
          }).catch((error: unknown) => {
            if (!disposed) console.warn(`[accremind] automatic tuning skipped: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, AUTO_TUNE_DELAY_MS);
        autoTuneTimer.unref?.();
      }
    });
  });

  const receipts = new TurnReceipts(store);
  // repo.json `settings.budgets` lets one project give more (or less) room than the plugin default.
  const projectBudgets = store.projectSettings().budgets ?? {};
  const budgetFor = (key: 'residentRulesTokens' | 'turnRadarTokens' | 'toolGuardTokens') => {
    const v = Number(projectBudgets[key]);
    return Number.isFinite(v) && v >= 0 ? v : config.budgets[key];
  };
  const viewCompiler = new ViewCompiler(store, {
    residentRulesTokens: budgetFor('residentRulesTokens'),
    turnRadarTokens: budgetFor('turnRadarTokens'),
    toolGuardTokens: budgetFor('toolGuardTokens'),
  }, (entry, session, source, file, reasons) => receipts.record(entry, session, source, file, reasons));

  const gate = workspaceGate(store.paths, config.writeGate);
  // A host-provided adapter is the host's own model service; env keys still need the user's opt-in.
  const consent = workspaceModelConsent(store.paths, Boolean(config.autoCapture.modelUpload || rawOptions.llmAdapter));
  const triageEngine = new TriageEngine(store, gate.read);
  const llmAdapter = resolveDefaultLlmAdapter(rawOptions.llmAdapter);
  // Every call the product makes on its own is counted here (calls + tokens), so a personal trial can see its cost.
  const llmUsage = new LlmUsageMeter(path.join(store.paths.globalRoot, 'usage', 'llm-usage.jsonl'));
  const meteredFor = (kind: LlmCallKind): LlmInferenceAdapter | null =>
    llmAdapter ? meterLlm(llmAdapter, llmUsage, kind) : null;

  const autoCapture = new AutoCaptureCoordinator({
    store,
    triageEngine,
    llm: meteredFor('capture'),
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
  // Three distinct model sources must stay distinguishable in the workbench: the host's own model
  // service (no key needed), an adapter injected by the caller, and a self-configured HTTP endpoint.
  const modelChannel = (): 'host' | 'injected' | 'env' | 'none' => {
    if (isHostLlmAdapter(llmAdapter)) return 'host';
    if (llmAdapter) return 'injected';
    return 'none';
  };
  const modelEndpoint = () => {
    if (!llmAdapter) return '未配置模型';
    if (modelChannel() !== 'env') return describeModelChannel(llmAdapter);
    const resolved = resolveLlmEndpoint(process.env);
    try { return new URL(resolved.baseUrl).origin; }
    catch { return '自定义推理端点'; }
  };
  // Repository scope is committed in `.accremind/repo.json`, so it is read live: pausing a repository from the
  // settings page (or from a CLI) takes effect on the next turn without restarting the host.
  const scope = () => {
    const settings = store.projectSettings();
    return { paused: isProjectDisabled(settings), excludePaths: normalizeExcludePaths(settings.excludePaths) };
  };
  rpcHandlers['accremind.settings.get'] = () => ({
    writeGate: gate.read(), modelEndpoint: modelEndpoint(), modelAvailable: Boolean(llmAdapter),
    modelChannel: modelChannel(),
    autoCapture: config.autoCapture.enabled, modelUpload: consent.read(), shareLedger: ledgerSharing.read(),
    paused: scope().paused, excludePaths: scope().excludePaths,
  });
  rpcHandlers['accremind.settings.setPaused'] = ({ paused }) => {
    store.setProjectSettings({ enabled: paused !== true });
    return { paused: scope().paused };
  };
  rpcHandlers['accremind.settings.setExcludePaths'] = ({ excludePaths }) => {
    store.setProjectSettings({ excludePaths: normalizeExcludePaths(excludePaths) });
    return { excludePaths: scope().excludePaths };
  };
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

  // Per-session relevance signals the host does not send on each turn: files the agent touched and the
  // last failing command output. They let the next turn's reminders match the actual work, not only the prompt.
  const sessionSignals = new Map<string, { files: string[]; lastError: string | null }>();
  const signalsFor = (sessionId: string) => {
    let sig = sessionSignals.get(sessionId);
    if (!sig) {
      sig = { files: [], lastError: null };
      sessionSignals.set(sessionId, sig);
      if (sessionSignals.size > 200) sessionSignals.delete(sessionSignals.keys().next().value!);
    }
    return sig;
  };
  const workspaceSignals = new WorkspaceSignalReader(projectRoot);
  const tagger = new QueryTagger({
    vocabulary: () => store.docs.vocabulary(),
    llm: () => meteredFor('tag'),
    consent: () => consent.read(),
    onProposals: (items) => {
      try {
        store.docs.proposeTags(items);
      } catch {
        // proposals are best-effort
      }
    },
  });
  const sessionSurfacedMap = new Map<string, Set<string>>();
  const MAX_TRACKED_SESSIONS = 200;
  /**
   * The system prefix is what the model caches. A rule accepted mid-conversation used to rewrite it and pay one
   * cache rebuild. The prefix is pinned per session instead: the change is delivered as an ephemeral note in the
   * turn that needs it and the pinned prefix is refreshed when a new session starts.
   */
  const sessionPrefixPins = new Map<string, { text: string; ids: string[] }>();
  const pinPrefix = (sessionId: string, text: string, ids: string[]): void => {
    sessionPrefixPins.set(sessionId, { text, ids: [...ids] });
    while (sessionPrefixPins.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessionPrefixPins.keys().next().value;
      if (oldest === undefined) break;
      sessionPrefixPins.delete(oldest);
    }
  };
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
      if (scope().paused) return '';
      return viewCompiler.compileTurnView({ sessionId: 'system-prefix' }).residentPrefix;
    },

    compileBeforeTurn(payload: DshTurnHookPayload): CompiledTurnView {
      if (scope().paused) {
        return { residentPrefix: '', radarBlock: '', surfacedIds: [], residentRuleIds: [], residentDroppedIds: [], docRefs: [] };
      }
      receipts.begin(payload.sessionId, payload.turnId);
      const surfaced = getSessionSet(payload.sessionId);
      if (payload.userPrompt) {
        autoCapture.recordTurnConversation(payload.sessionId, payload.userPrompt, undefined);
      }
      const sig = signalsFor(payload.sessionId);
      // Files: what the host says, else what the agent touched this session, else the working tree's changes
      // (the first turn of a session has nothing else to go on).
      let activeFiles = payload.activeFiles ?? (sig.files.length ? sig.files.slice(-3) : undefined);
      let contextHint = payload.contextHint;
      if (!activeFiles || contextHint === undefined) {
        try {
          const ws = workspaceSignals.read();
          if (!activeFiles && ws.changedFiles.length) activeFiles = ws.changedFiles.slice(0, 5);
          if (contextHint === undefined && ws.branchHint) contextHint = ws.branchHint;
        } catch {
          // not a Git repository
        }
      }
      const tags = payload.tags ?? (payload.userPrompt ? tagger.lexical([payload.userPrompt, contextHint ?? '', ...(activeFiles ?? [])].join(' ')) : []);
      const compiled = viewCompiler.compileTurnView(
        {
          sessionId: payload.sessionId,
          userPrompt: payload.userPrompt,
          activeFiles,
          errorOutput: payload.errorOutput ?? sig.lastError ?? undefined,
          ...(tags.length ? { tags } : {}),
          ...(contextHint ? { contextHint } : {}),
        },
        surfaced,
      );
      receipts.setQuery(payload.sessionId, { text: payload.userPrompt, tags, activeFiles });
      // An error is relevant to the turn right after it, not forever.
      sig.lastError = null;

      // Keep the cached system prefix stable; rules that changed since it was pinned travel once, ephemerally.
      const pin = sessionPrefixPins.get(payload.sessionId);
      let injectedPrefix = compiled.residentPrefix;
      let ruleUpdateBlock = '';
      if (pin) {
        injectedPrefix = pin.text;
        if (pin.text !== compiled.residentPrefix) {
          const before = new Set(pin.ids);
          const after = new Set(compiled.residentRuleIds);
          const added = compiled.residentRuleIds.filter((id) => !before.has(id));
          const removed = pin.ids.filter((id) => !after.has(id));
          const lines = [
            ...added.map((id) => `新增规范 ${id}：本回合起适用，调 accremind_get("${id}") 查看依据`),
            ...removed.map((id) => `规范 ${id} 已撤回或不适用于本仓库`),
            ...(!added.length && !removed.length ? ['已有规范的内容有更新（编号未变）：需要最新措辞时调 accremind_get 查看'] : []),
          ];
          ruleUpdateBlock = wrapReadOnlyXmlBlock(
            'accremind-rule-update',
            `规则在本回合开始时发生变化。系统前缀为复用模型缓存保持原样，以下变更立即生效：\n${lines.join('\n')}`,
          );
        }
      } else if (compiled.residentPrefix) {
        pinPrefix(payload.sessionId, compiled.residentPrefix, compiled.residentRuleIds);
      }
      if (injectedPrefix && payload.injectSystemStablePrefix) {
        payload.injectSystemStablePrefix(injectedPrefix);
      }
      for (const id of compiled.residentRuleIds) {
        const item = store.getEntry(id, { recordUsage: false });
        if (item.found && item.servable) receipts.record(item.entry, payload.sessionId, 'rule');
      }
      const ephemeral = [compiled.radarBlock, ruleUpdateBlock].filter(Boolean).join('\n');
      if (ephemeral && payload.injectTurnEphemeralContext) {
        payload.injectTurnEphemeralContext(ephemeral);
      }
      return compiled;
    },

    async compileBeforeTurnAsync(payload: DshTurnHookPayload): Promise<CompiledTurnView> {
      if (payload.tags || !payload.userPrompt || scope().paused) return this.compileBeforeTurn(payload);
      let files = payload.activeFiles;
      let hint = payload.contextHint;
      try {
        const ws = workspaceSignals.read();
        files ??= signalsFor(payload.sessionId).files.length ? signalsFor(payload.sessionId).files.slice(-3) : ws.changedFiles.slice(0, 5);
        hint ??= ws.branchHint || undefined;
      } catch {
        // not a Git repository
      }
      let tags: string[] | undefined;
      try {
        tags = (await tagger.tagTurn(payload.sessionId, payload.userPrompt, { files, branchHint: hint })).tags;
      } catch {
        tags = undefined;
      }
      return this.compileBeforeTurn({ ...payload, ...(files ? { activeFiles: files } : {}), ...(hint ? { contextHint: hint } : {}), ...(tags ? { tags } : {}) });
    },

    handleAfterTool(payload: DshToolAfterHookPayload) {
      const current = scope();
      if (current.paused) return payload.result;
      const excluded = (relPath: string | null): boolean => Boolean(relPath) && isExcludedPath(relPath!, current.excludePaths);
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

      const sig = signalsFor(payload.sessionId);
      const quietPath = excluded(editedRelPath);
      if (editedRelPath && !quietPath) sig.files = [...sig.files.filter((f) => f !== editedRelPath), editedRelPath].slice(-10);
      if (cmdFailed && outputJoined.trim()) sig.lastError = outputJoined.trim().slice(-600);

      if (config.autoCapture.enabled && !quietPath) {
        autoCapture.recordToolActivity({
          sessionId: payload.sessionId,
          toolName: payload.toolName,
          editedRelPath,
          isCommandOrTest: isCmd,
          failed: cmdFailed,
        });
      }

      // An excluded prefix gets no file guard: the agent reads and edits vendored code untouched.
      if (quietPath) return payload.result;
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
      if (scope().paused) return;
      receipts.finish(payload.sessionId);
      if (!config.autoCapture.enabled) return;
      autoCapture.recordTurnConversation(
        payload.sessionId,
        payload.userPrompt,
        payload.assistantReply,
      );
      const { enqueuedJob } = autoCapture.checkAndEnqueueSession(payload.sessionId);
      // Also jobs left from earlier turns (a model error, a restart): otherwise they wait for the next new signal.
      if ((enqueuedJob || autoCapture.hasRunnableJobs()) && llmAdapter && consent.read()) {
        // Non-blocking background drain (L2 Iron Law)
        queueMicrotask(() => {
          void autoCapture.processPendingQueue();
        });
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (autoTuneTimer) clearTimeout(autoTuneTimer);
      demoSessions?.dispose();
      sessionSurfacedMap.clear();
      sessionSignals.clear();
      sessionPrefixPins.clear();
      for (const id of sessionSurfacedMap.keys()) tagger.forget(id);
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
  // Prefer the host's own model service: it needs no API key, and every per-repository runtime
  // inherits it because `mountNativeHost` spreads these options into each workspace runtime.
  // An explicit `llmAdapter: null` still means "no model", and an injected adapter always wins.
  const hostAdapter = rawOptions.llmAdapter === undefined ? createHostLlmAdapter(ctx) : null;
  if (hostAdapter) {
    mountNativeHost(ctx, { ...rawOptions, llmAdapter: hostAdapter }, createAccreMindRuntime);
    return;
  }
  mountNativeHost(ctx, rawOptions, createAccreMindRuntime);
}
