import {
  scanGitHistorySignals,
  type GitStalenessScanner,
  type KnowledgeLayer,
  type KnowledgeType,
  type LocalMarkdownSqliteStore,
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

/**
 * Safe Host RPC Router for the 4 DSH WebUI Embedded Views.
 * Adheres strictly to the `dsh-mnemon` WebUI boundary: browser views NEVER access SQLite
 * or raw filesystem paths directly.
 */
export function createWebuiRpcHandlers(deps: {
  store: LocalMarkdownSqliteStore;
  stalenessScanner: GitStalenessScanner;
}): RpcHandlerMap {
  const { store, stalenessScanner } = deps;

  return {
    'accremind.kb.list': (params) => {
      return store.search({
        workspaceId: store.workspaceId,
        query: typeof params.query === 'string' ? params.query : undefined,
        type: params.type as KnowledgeType | undefined,
        layer: params.layer as KnowledgeLayer | undefined,
        includeProbation: params.includeProbation !== false,
        limit: typeof params.limit === 'number' ? params.limit : 20,
      });
    },

    'accremind.kb.get': (params) => {
      const id = String(params.id ?? '');
      return store.getEntry(id, {
        recordUsage: false,
        includeHistoryOrSuspended: Boolean(params.includeHistoryOrSuspended),
      });
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
          taskFingerprint: `feedback-${Date.now()}`,
          outcome: 'failure',
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

    'accremind.gov.scanStaleness': () => {
      return stalenessScanner.scanWorkspace();
    },

    'accremind.gov.bootstrapHistory': (params) => {
      const maxCommits = typeof params.maxCommits === 'number' ? params.maxCommits : 150;
      const topK = typeof params.topK === 'number' ? params.topK : 15;
      return scanGitHistorySignals({
        repoRoot: store.paths.projectRoot,
        maxCommitsToScan: maxCommits,
        topK,
      });
    },

    'accremind.gov.rebuildIndex': () => {
      const stats = store.rebuildIndexFromScratch();
      return {
        ...stats,
        corruptedFiles: store.listCorruptedFiles(),
      };
    },
  };
}
