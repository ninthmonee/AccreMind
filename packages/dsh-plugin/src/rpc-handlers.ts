import * as fs from 'node:fs';
import type { TurnReceipts } from './turn-receipts.ts';
import type { DshToolDefinition } from './cordis-types.ts';
import { createDemoHandlers, DEMO_ENTRY_IDS } from './demo-seed.ts';
import { decideReview, reviewMissingFields } from './candidate-review.ts';
import * as path from 'node:path';
import {
  GovernanceService,
  KNOWLEDGE_LAYERS,
  isRepositoryKnowledgeLayer,
  exportEntryToDshSkill,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
  serializeEntryMarkdown,
  sha256Hex,
  type AccreMindConfig,
  type AutoCaptureCoordinator,
  type CaptureAssessment,
  type Disposition,
  type EntryStatus,
  type Freshness,
  type GitStalenessScanner,
  type KnowledgeEntry,
  type KnowledgeLayer,
  type KnowledgeType,
  type LlmInferenceAdapter,
  type LocalMarkdownSqliteStore,
  type ServingStatus,
  type TriageEngine,
  type ViewCompiler,
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

function emptyScopeCounts(): Record<KnowledgeLayer, number> {
  return Object.fromEntries(KNOWLEDGE_LAYERS.map(layer => [layer, 0])) as Record<KnowledgeLayer, number>;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}


/**
 * Complete Host RPC Router for the AccreMind V3.1 Creative Observatory WebUI.
 * Browser views NEVER touch `node:sqlite`, `fs`, or OS processes directly.
 */
export function createWebuiRpcHandlers(deps: {
  receipts: TurnReceipts;
  tools: DshToolDefinition<any>[];
  demoMode?: boolean;
  store: LocalMarkdownSqliteStore;
  viewCompiler: ViewCompiler;
  budgets: AccreMindConfig['budgets'];
  stalenessScanner: GitStalenessScanner;
  triageEngine: TriageEngine;
  autoCapture: AutoCaptureCoordinator;
  getLlmAdapter: () => LlmInferenceAdapter | null;
}): RpcHandlerMap {
  const {
    store,
    viewCompiler,
    budgets,
    stalenessScanner,
    triageEngine,
    autoCapture,
    getLlmAdapter,
  } = deps;

  function currentEntry(params: Record<string, unknown>) {
    const found = store.getEntry(String(params.id ?? ''), { recordUsage: false, includeHistoryOrSuspended: true });
    if (!found.found || !found.servable) throw new Error('未找到条目');
    deps.receipts.checkReference(params, found.entry);
    return found.entry;
  }

  const governance = new GovernanceService(store);

  function governanceQueue() {
    const entries = store.listEntriesForAdmin().map(item => item.entry);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    return {
      staleEntries: entries.filter(entry => entry.freshness !== 'current' && (entry.status === 'active' || entry.status === 'probation')),
      suspendedEntries: entries.filter(entry => entry.serving === 'suspended' && (entry.status === 'active' || entry.status === 'probation')),
      corruptedFiles: store.listCorruptedFiles(),
      attentionItems: store.listAttentionItems().map(item => ({ ...item, entry: byId.get(item.entry_id) ?? null })),
    };
  }

  return {
    'accremind.gov.markStale': (params) => governance.markStale(currentEntry(params), String(params.reason ?? '')),
    'accremind.gov.resolveConflict': (params) => governance.resolveConflict(currentEntry(params), String(params.reason ?? '')),
    'accremind.turn.list': (params) => ({
      receipts: deps.receipts.list(typeof params.sessionId === 'string' ? params.sessionId : undefined,
        typeof params.turnId === 'string' ? params.turnId : undefined, Number(params.limit ?? 20)),
    }),
    'accremind.capture.manual': async (params) => {
      const capture = deps.tools.find((tool) => tool.name === 'accremind_capture')!;
      const out = await capture.execute(params, { sessionId: 'webui-manual' });
      if (out.isError) throw new Error(out.content[0]?.text ?? '捕获失败');
      return JSON.parse(out.content[0]!.text);
    },
    'accremind.attention.list': () => {
      const items = store.listAttentionItems();
      const byId = new Map(items.length ? store.listEntriesForAdmin().map(hit => [hit.entry.id, hit]) : []);
      return { items: items.map(item => {
        const found = byId.get(item.entry_id);
        return { ...item, title: found?.entry.title ?? item.entry_id, type: found?.entry.type ?? null };
      }) };
    },
    'accremind.insights.overview': (params) => store.insights(
      Math.min(90, Math.max(7, Number(params.days ?? 28))),
      new Date(),
      typeof params.tzOffsetMinutes === 'number' ? params.tzOffsetMinutes : undefined,
    ),

    'accremind.dashboard.overview': () => {
      const all = store.listEntriesForAdmin();
      const pendingCount = store.countAssessments('pending');
      const corrupted = store.listCorruptedFiles();
      const queuedJobs = autoCapture.listQueuedJobs();

      let activeCount = 0;
      let rulesCount = 0;
      let projectActiveCount = 0;
      let probationCount = 0;
      let reviewDueCount = 0;
      let suspendedCount = 0;
      let governanceQueueCount = 0;
      let verifiedOrProvenCount = 0;
      const byScope = emptyScopeCounts();
      const byType: Record<string, number> = {
        pitfall: 0,
        decision: 0,
        guideline: 0,
        model: 0,
        process: 0,
      };

      for (const { entry, storageZone } of all) {
        if (storageZone === 'project' && entry.status === 'active') projectActiveCount += 1;
        if (storageZone === 'rules') rulesCount += 1;
        if (entry.status === 'active') activeCount += 1;
        if (entry.status === 'probation') probationCount += 1;
        if (entry.freshness === 'review_due') reviewDueCount += 1;
        if (entry.serving === 'suspended') suspendedCount += 1;
        if (entry.freshness !== 'current' || (entry.serving === 'suspended' &&
            (entry.status === 'active' || entry.status === 'probation'))) governanceQueueCount += 1;
        if (entry.maturity === 'verified' || entry.maturity === 'proven') {
          verifiedOrProvenCount += 1;
        }
        byScope[entry.layer] = (byScope[entry.layer] ?? 0) + 1;
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      }

      const hasDemoSeeded = deps.demoMode === true && all.some((i) => DEMO_ENTRY_IDS.includes(i.entry.id));

      return {
        workspaceId: store.workspaceId,
        projectName: path.basename(store.paths.projectRoot),
        projectDir: store.paths.projectAccreMindDir,
        globalDir: store.paths.globalRoot,
        maxProbationExposures: store.maxProbationExposures,
        budgets,
        hasDemoSeeded,
        counts: {
          totalEntries: all.length,
          byScope,
          byCategory: byType,
          activeCount,
          projectActiveCount,
          rulesCount,
          probationCount,
          reviewDueCount,
          suspendedCount,
          // Inapplicable reports already suspend the entry (counted above); silent trials are new work.
          governanceQueueCount: governanceQueueCount + corrupted.length +
            store.listAttentionItems().filter(item => item.kind === 'probation_silent').length,
          verifiedOrProvenCount,
          pendingReviewCount: pendingCount,
          corruptedCount: corrupted.length,
          queuedCaptureJobs: queuedJobs.length,
          navigationItemsCount: store.listNavigationItems().length,
        },
        byType,
      };
    },

    'accremind.kb.list': (params) => {
      if (params.adminView === true) {
        const items = store.listEntriesForAdmin({
          status: (params.status as EntryStatus | undefined) || undefined,
          freshness: (params.freshness as Freshness | undefined) || undefined,
          serving: (params.serving as ServingStatus | undefined) || undefined,
          type: (params.type as KnowledgeType | undefined) || undefined,
          query: typeof params.query === 'string' ? params.query : undefined,
        });
        const matching = items.filter(({ entry, storageZone }) =>
          (!params.storageZone || storageZone === params.storageZone) &&
          (!params.maturity || (params.maturity === 'verified_or_proven'
            ? entry.maturity === 'verified' || entry.maturity === 'proven'
            : entry.maturity === params.maturity)),
        );
        const scopeCounts = emptyScopeCounts();
        for (const {entry} of matching) {
          scopeCounts[entry.layer] = (scopeCounts[entry.layer] ?? 0) + 1;
        }
        const filtered = params.layer ? matching.filter(({entry}) => entry.layer === params.layer) : matching;
        return {
          scopeCounts,
          items: filtered.map((i) => ({
            entry: i.entry,
            storageZone: i.storageZone,
            probationExposures: i.probationExposures,
            score: 1,
            matchReasons: [],
            truncated: false,
          })),
          zeroReason: filtered.length === 0 ? 'no_applicable_entry' : 'none',
          tokenUsed: 0,
        };
      }

      return store.search({
        workspaceId: store.workspaceId,
        query: typeof params.query === 'string' ? params.query : undefined,
        type: (params.type as KnowledgeType | undefined) || undefined,
        layer: (params.layer as KnowledgeLayer | undefined) || undefined,
        filePath: typeof params.filePath === 'string' ? params.filePath : undefined,
        includeProbation: params.includeProbation !== false,
        limit: typeof params.limit === 'number' ? params.limit : 20,
      });
    },

    'accremind.kb.get': (params) => {
      const id = String(params.id ?? '');
      const outcome = store.getEntry(id, {
        recordUsage: false,
        includeHistoryOrSuspended: true,
      });
      if (!outcome.found || !outcome.servable) {
        return outcome;
      }
      const assessment = outcome.entry.capture_assessment_id
        ? store.getAssessment(outcome.entry.capture_assessment_id)
        : null;
      const validations = store.listValidations(id);
      const rawMarkdown = serializeEntryMarkdown(outcome.entry);
      const records = store.ledger.read(id);
      return {
        ...outcome,
        assessment,
        validations,
        rawMarkdown,
        // Snapshot per piece of evidence (newest first) and the ledger as the shared rules read it.
        snapshots: store.snapshots.list(outcome.entry),
        ledger: { shared: store.ledger.isShared, standing: store.ledgerStanding(outcome.entry), records: records.slice(-50).reverse() },
      };
    },

    'accremind.kb.saveRevision': (params) => {
      const id = String(params.id ?? '');
      if (params.expectedRevision !== undefined) currentEntry({ id, revision: params.expectedRevision });
      const patch = (params.patch ?? {}) as Partial<KnowledgeEntry>;
      const editableStrings = ['title', 'claim', 'rationale', 'knowledge_delta'];
      const editableLists = ['search_aliases', 'invalidation_triggers', 'preconditions'];
      for (const [name, value] of Object.entries(patch)) {
        if (name === 'layer' && isRepositoryKnowledgeLayer(value)) continue;
        if (editableStrings.includes(name) && typeof value === 'string') continue;
        if (editableLists.includes(name) && Array.isArray(value) && value.every(v => typeof v === 'string')) continue;
        throw new Error(`无法通过正文修订修改字段 ${name}`);
      }
      const revisionImpact =
        params.revisionImpact === 'editorial' ? 'editorial' : 'substantive';
      return store.saveRevision({ id, patch, revisionImpact });
    },

    'accremind.kb.withdraw': (params) => {
      const entry = currentEntry(params);
      const reason = String(params.reason ?? '');
      const supersedes = typeof params.supersedes === 'string' ? params.supersedes : null;
      return { entry: governance.withdraw(entry, reason, supersedes), reason: reason.trim() };
    },

    'accremind.probation.decide': (params) => governance.decideProbation(currentEntry(params), String(params.action ?? '')),

    'accremind.feedback.submit': (params) => governance.submitFeedback(currentEntry(params), {
      kind: String(params.kind ?? ''),
      detail: typeof params.detail === 'string' ? params.detail : '',
      sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
      turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
      taskFingerprint: typeof params.taskFingerprint === 'string' ? params.taskFingerprint : undefined,
    }),

    'accremind.sim.compile': (params) => {
      const userPrompt = typeof params.userPrompt === 'string' ? params.userPrompt : '';
      const errorOutput = typeof params.errorOutput === 'string' ? params.errorOutput : '';
      const activeFile = typeof params.activeFile === 'string' ? params.activeFile.trim() : '';
      const midTurnToolFile =
        typeof params.midTurnToolFile === 'string' ? params.midTurnToolFile.trim() : '';

      const simSurfaced = new Set<string>();
      const turnView = viewCompiler.compileTurnView(
        {
          sessionId: 'webui-simulator',
          preview: true,
          userPrompt,
          errorOutput,
          activeFiles: activeFile ? [activeFile] : [],
        },
        simSurfaced,
      );

      const jitOut = midTurnToolFile
        ? viewCompiler.compileFileToolGuard({
            sessionId: 'webui-simulator',
            preview: true,
            filePath: midTurnToolFile,
            sessionSurfacedIds: simSurfaced,
          })
        : { guardBlock: '', newlySurfacedIds: [] };

      return {
        residentPrefix: turnView.residentPrefix,
        residentRuleIds: turnView.residentRuleIds,
        residentDroppedIds: turnView.residentDroppedIds,
        residentSha256: turnView.residentPrefix
          ? sha256Hex(turnView.residentPrefix).slice(0, 16)
          : 'empty',
        residentTokens: estimateTokens(turnView.residentPrefix),
        radarBlock: turnView.radarBlock,
        radarTokens: estimateTokens(turnView.radarBlock),
        radarSurfacedIds: turnView.surfacedIds,
        guardBlock: jitOut.guardBlock,
        guardTokens: estimateTokens(jitOut.guardBlock),
        guardSurfacedIds: jitOut.newlySurfacedIds,
        budgets,
      };
    },

    'accremind.review.listQueue': (params) => {
      const reviewState =
        (params.reviewState as 'pending' | 'decided' | 'all' | undefined) ?? 'all';
      const limit = typeof params.limit === 'number' && Number.isInteger(params.limit)
        ? Math.max(1, Math.min(200, params.limit)) : 50;
      const offset = typeof params.offset === 'number' && Number.isInteger(params.offset)
        ? Math.max(0, params.offset) : 0;
      const total = store.countAssessments(reviewState);
      return {
        offset, limit, total, hasMore: offset + limit < total,
        items: store.listAssessments({reviewState, limit, offset}).map(item => ({
          ...item, missingFields: reviewMissingFields(item),
        })),
        navigationItems: store.listNavigationItems(),
      };
    },

    'accremind.review.decide': (params) => decideReview(store, params),

    // Checking the code (git) is a write and can be slow; reading the queue is cheap. Diffs are fetched
    // one entry at a time, only when someone opens it.
    'accremind.gov.scanStaleness': () => ({ scan: stalenessScanner.scanWorkspace(), ...governanceQueue() }),

    'accremind.gov.reviewQueue': () => governanceQueue(),

    // Diff plus, per piece of evidence, what it said when last approved/confirmed vs what it says now.
    'accremind.gov.reviewDetails': (params) => {
      const entry = currentEntry(params);
      const latest = store.snapshots.latest(entry);
      const evidence = entry.evidence.map((ev) => {
        const then = latest.get(ev.id) ?? null;
        const now = store.snapshots.read(ev);
        return {
          evidenceId: ev.id,
          locator: ev.locator,
          summary: ev.summary,
          then,
          now: { excerpt: now.excerpt, sourceSha256: now.sourceSha256, commit: now.commit, truncated: now.truncated },
          changed: then ? then.sourceSha256 !== now.sourceSha256 : null,
          verification: then ? store.snapshots.verify(then) : null,
        };
      });
      return { ...stalenessScanner.reviewDetails(entry), evidence };
    },

    'accremind.evidence.capture': (params) => {
      const entry = currentEntry(params);
      return { snapshots: store.snapshots.capture(entry) };
    },

    'accremind.gov.requestReview': (params) => governance.requestReview(currentEntry(params), String(params.reason ?? '')),

    'accremind.gov.readAnchor': (params) => {
      const entry = currentEntry(params);
      return stalenessScanner.readAnchor(entry, String(params.filePath ?? ''), String(params.symbolName ?? ''));
    },

    'accremind.gov.rebindAnchor': (params) => {
      const entry = currentEntry(params);
      if (params.revision !== entry.revision) throw new Error('条目版本已经变更，请刷新并重新核对');
      return {entry:stalenessScanner.rebindAnchor(entry, String(params.oldFilePath ?? ''), String(params.oldSymbolName ?? ''),
        String(params.filePath ?? '').trim(), String(params.symbolName ?? '').trim())};
    },

    'accremind.gov.confirmFresh': (params) => {
      const id = String(params.id ?? '');
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) throw new Error(`未找到条目: ${id}`);
      if (params.revision !== undefined && params.revision !== found.entry.revision) {
        throw new Error('条目版本已经变更，请刷新后重新核对');
      }
      if (typeof params.reviewToken === 'string' && params.reviewToken !== stalenessScanner.reviewDetails(found.entry).reviewToken) {
        throw new Error('对照代码已经变化，请刷新差异后再次核对');
      }
      return stalenessScanner.confirmFresh(found.entry);
    },

    'accremind.gov.bootstrapHistory': async (params) => {
      const maxCommits = typeof params.maxCommits === 'number' ? params.maxCommits : 150;
      const topK = typeof params.topK === 'number' ? params.topK : 10;
      const extractWithLlm = Boolean(params.extractWithLlm);
      const llm = getLlmAdapter();

      if (extractWithLlm && llm) {
        const result = await runArchaeologyBootstrap({
          store,
          triageEngine,
          llm,
          maxCommitsToScan: maxCommits, topK,
          commitShas: Array.isArray(params.commitShas) ? params.commitShas.map(String) : undefined,
        });
        return {...result, modelAvailable:true};
      }

      const minedCommits = scanGitHistorySignals({
        repoRoot: store.paths.projectRoot,
        maxCommitsToScan: maxCommits,
        topK,
      });
      return {
        minedCommits, modelAvailable: Boolean(llm),
        message: extractWithLlm && !llm ? '当前未连接提炼模型，仅扫描提交；尚未生成候选。' : undefined,
        triageReport: null as null | { dispositionCounts: Record<Disposition, number> },
      };
    },

    'accremind.gov.exportSkill': (params) => {
      const id = String(params.id ?? '');
      const skillSlug = String(params.skillSlug ?? '');
      return exportEntryToDshSkill({ store, entryId: id, skillSlug });
    },

    'accremind.gov.rebuildIndex': () => {
      const stats = store.rebuildIndexFromScratch();
      return {
        ...stats,
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.queue.list': () => {
      return { jobs: autoCapture.listQueuedJobs() };
    },

    'accremind.queue.drain': async () => {
      const outcomes = await autoCapture.processPendingQueue();
      return { processed: outcomes.length, outcomes };
    },

    ...createDemoHandlers({ store, stalenessScanner, demoMode: deps.demoMode === true }),
  };
}
