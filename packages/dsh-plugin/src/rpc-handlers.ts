import {
  exportEntryToDshSkill,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
  type AutoCaptureCoordinator,
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
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

/**
 * Complete Host RPC Router for the 4 DSH WebUI Embedded Views (and standalone local UI server).
 * Browser views NEVER touch `node:sqlite`, `fs`, or OS processes directly.
 */
export function createWebuiRpcHandlers(deps: {
  store: LocalMarkdownSqliteStore;
  stalenessScanner: GitStalenessScanner;
  triageEngine: TriageEngine;
  autoCapture: AutoCaptureCoordinator;
  getLlmAdapter: () => LlmInferenceAdapter | null;
}): RpcHandlerMap {
  const { store, stalenessScanner, triageEngine, autoCapture, getLlmAdapter } = deps;

  return {
    'accremind.dashboard.overview': () => {
      const all = store.listEntriesForAdmin();
      const pendingAssessments = store.listAssessments({ reviewState: 'pending' });
      const corrupted = store.listCorruptedFiles();
      const queuedJobs = autoCapture.listQueuedJobs();

      let activeCount = 0;
      let probationCount = 0;
      let reviewDueCount = 0;
      let suspendedCount = 0;
      let verifiedOrProvenCount = 0;

      for (const { entry } of all) {
        if (entry.status === 'active') activeCount += 1;
        if (entry.status === 'probation') probationCount += 1;
        if (entry.freshness === 'review_due' || entry.freshness === 'stale') reviewDueCount += 1;
        if (entry.serving === 'suspended') suspendedCount += 1;
        if (entry.maturity === 'verified' || entry.maturity === 'proven') {
          verifiedOrProvenCount += 1;
        }
      }

      return {
        workspaceId: store.workspaceId,
        projectDir: store.paths.projectAccreMindDir,
        counts: {
          totalEntries: all.length,
          activeCount,
          probationCount,
          reviewDueCount,
          suspendedCount,
          verifiedOrProvenCount,
          pendingReviewCount: pendingAssessments.length,
          corruptedCount: corrupted.length,
          queuedCaptureJobs: queuedJobs.length,
        },
        navigationItemsCount: store.listNavigationItems().length,
      };
    },

    'accremind.kb.list': (params) => {
      // Admin table mode vs Agent semantic search mode
      if (params.adminView === true) {
        const items = store.listEntriesForAdmin({
          status: (params.status as EntryStatus | undefined) || undefined,
          freshness: (params.freshness as Freshness | undefined) || undefined,
          serving: (params.serving as ServingStatus | undefined) || undefined,
          layer: (params.layer as KnowledgeLayer | undefined) || undefined,
          type: (params.type as KnowledgeType | undefined) || undefined,
          query: typeof params.query === 'string' ? params.query : undefined,
        });
        return {
          items: items.map((i) => ({
            entry: i.entry,
            storageZone: i.storageZone,
            probationExposures: i.probationExposures,
            score: 1,
            matchReasons: [],
            truncated: false,
          })),
          zeroReason: items.length === 0 ? 'no_applicable_entry' : 'none',
          tokenUsed: 0,
        };
      }

      return store.search({
        workspaceId: store.workspaceId,
        query: typeof params.query === 'string' ? params.query : undefined,
        type: (params.type as KnowledgeType | undefined) || undefined,
        layer: (params.layer as KnowledgeLayer | undefined) || undefined,
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
      return {
        ...outcome,
        assessment,
        validations,
      };
    },

    'accremind.kb.saveRevision': (params) => {
      const id = String(params.id ?? '');
      const patch = (params.patch ?? {}) as Partial<KnowledgeEntry>;
      const revisionImpact =
        params.revisionImpact === 'editorial' ? 'editorial' : 'substantive';
      return store.saveRevision({ id, patch, revisionImpact });
    },

    'accremind.kb.withdraw': (params) => {
      const id = String(params.id ?? '');
      const reason = String(params.reason ?? '').trim();
      if (!reason) {
        throw new Error('S01 高危操作校验失败：撤回知识必须填写明确原因');
      }
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) {
        throw new Error(`未找到条目: ${id}`);
      }
      const withdrawn: KnowledgeEntry = {
        ...found.entry,
        status: 'withdrawn',
        serving: 'suspended',
        supersedes: typeof params.supersedes === 'string' ? params.supersedes : found.entry.supersedes,
        updated_at: new Date().toISOString(),
      };
      return { entry: store.updateExistingEntryDirect(withdrawn), reason };
    },

    'accremind.probation.decide': (params) => {
      const id = String(params.id ?? '');
      const action = String(params.action ?? '');
      if (action === 'promote') {
        return store.promoteProbationToActive(id);
      }
      if (action === 'dismiss') {
        return store.dismissProbation(id);
      }
      throw new Error(`未知试用裁决动作: ${action}`);
    },

    'accremind.feedback.submit': (params) => {
      const id = String(params.id ?? '');
      const kind = String(params.kind ?? '');
      const detail = String(params.detail ?? '');
      if (!detail.trim()) {
        throw new Error('反馈说明与依据不能为空');
      }

      if (kind === 'suspected_error') {
        return store.submitValidation({
          entryId: id,
          sessionId: 'webui-feedback',
          taskFingerprint: `feedback-err-${Date.now()}`,
          outcome: 'failure',
          evidenceNote: detail,
        });
      }

      if (kind === 'verified_effective') {
        return store.submitValidation({
          entryId: id,
          sessionId: 'webui-validation',
          taskFingerprint: String(params.taskFingerprint || `manual-val-${Date.now()}`),
          outcome: 'success',
          evidenceNote: detail,
        });
      }

      const current = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (current.found && current.servable) {
        store.recordUsage({
          workspace_id: store.workspaceId,
          session_id: 'webui-feedback',
          entry_id: id,
          revision: current.entry.revision,
          event_type: 'feedback_inapplicable',
          detail,
        });
      }
      return { recorded: true };
    },

    'accremind.review.listQueue': (params) => {
      const reviewState =
        (params.reviewState as 'pending' | 'decided' | 'all' | undefined) ?? 'all';
      return {
        items: store.listAssessments({ reviewState, limit: 50 }),
        navigationItems: store.listNavigationItems(),
      };
    },

    'accremind.review.decide': (params) => {
      const assessmentId = String(params.assessmentId ?? '');
      const decision = params.decision as
        | 'approve_active'
        | 'approve_probation'
        | 'index_only'
        | 'link_existing'
        | 'discard';
      const editedEntry = params.editedEntry as KnowledgeEntry | undefined;
      return store.decideAssessment({ assessmentId, decision, editedEntry });
    },

    'accremind.gov.scanStaleness': () => {
      const scan = stalenessScanner.scanWorkspace();
      const staleEntries = store
        .listEntriesForAdmin()
        .filter((i) => i.entry.freshness === 'review_due' || i.entry.freshness === 'stale');
      return {
        scan,
        staleEntries: staleEntries.map((s) => s.entry),
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.gov.confirmFresh': (params) => {
      const id = String(params.id ?? '');
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) {
        throw new Error(`未找到条目: ${id}`);
      }
      const now = new Date().toISOString();
      const nextDue = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
      const refreshed: KnowledgeEntry = {
        ...found.entry,
        freshness: 'current',
        serving: 'enabled',
        last_validated_at: now,
        review_due_at: nextDue,
        updated_at: now,
      };
      return store.updateExistingEntryDirect(refreshed);
    },

    'accremind.gov.bootstrapHistory': async (params) => {
      const maxCommits = typeof params.maxCommits === 'number' ? params.maxCommits : 150;
      const topK = typeof params.topK === 'number' ? params.topK : 10;
      const extractWithLlm = Boolean(params.extractWithLlm);
      const llm = getLlmAdapter();

      if (extractWithLlm && llm) {
        return runArchaeologyBootstrap({
          store,
          triageEngine,
          llm,
          maxCommitsToScan: maxCommits,
          topK,
        });
      }

      const minedCommits = scanGitHistorySignals({
        repoRoot: store.paths.projectRoot,
        maxCommitsToScan: maxCommits,
        topK,
      });
      return {
        minedCommits,
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
  };
}
