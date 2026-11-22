import { sha256Hex } from '../codec/atomic-fs.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { transition, transitionBlocker } from './lifecycle.ts';

export type FeedbackKind = 'verified_effective' | 'suspected_error' | 'inapplicable';

export interface FeedbackInput {
  kind: FeedbackKind | string;
  /** Required only for `suspected_error`; optional context otherwise. */
  detail?: string;
  sessionId?: string;
  turnId?: string;
  taskFingerprint?: string;
}

/**
 * Every human decision about an entry's lifecycle lives here, so hosts (DSH today, a server later)
 * only translate requests and never re-implement the rules. Each decision is attributed to the
 * store's actor and written to the activity log.
 */
export class GovernanceService {
  private readonly store: LocalMarkdownSqliteStore;

  constructor(store: LocalMarkdownSqliteStore) {
    this.store = store;
  }

  /** Marks an entry as no longer valid for the current code. */
  markStale(entry: KnowledgeEntry, reason: string): KnowledgeEntry {
    const why = this.requireReason(reason, '请填写本次裁决的依据');
    const next = this.store.updateExistingEntryDirect(transition(entry, 'mark_stale'));
    this.store.recordGovernanceDecision(entry, 'stale', why);
    return next;
  }

  /** Lifts a suspension after the counterexample was checked and found not to hold. */
  resolveConflict(entry: KnowledgeEntry, reason: string): KnowledgeEntry {
    const why = this.requireReason(reason, '请填写本次裁决的依据');
    const next = this.store.updateExistingEntryDirect(transition(entry, 'resume'));
    this.store.clearAttention(entry.id, 'inapplicable');
    this.store.recordGovernanceDecision(entry, 'resolve', why);
    return next;
  }

  /** Re-opens a stale entry for review instead of retiring it. */
  requestReview(entry: KnowledgeEntry, reason: string): KnowledgeEntry {
    const why = this.requireReason(reason, '请填写重新评估的具体依据');
    const updated = this.store.updateExistingEntryDirect(transition(entry, 'request_review'));
    this.store.rawDb.prepare('UPDATE freshness_reviews SET reason = ? WHERE workspace_id = ? AND entry_id = ?')
      .run(why, this.store.workspaceId, entry.id);
    this.store.recordGovernanceDecision(entry, 'request_review', why);
    return updated;
  }

  /** Ends a trial: promote to a confirmed entry, or dismiss it. */
  decideProbation(entry: KnowledgeEntry, action: 'promote' | 'dismiss' | string): KnowledgeEntry {
    if (action !== 'promote' && action !== 'dismiss') throw new Error(`未知试用裁决动作: ${action}`);
    // A trial paused only because the decision was overdue can still be promoted: the pause was about
    // attention, not about the content.
    if (action === 'promote' && entry.status === 'probation' && entry.serving === 'suspended'
      && entry.freshness === 'current' && this.store.pausedOnlyForOverdueDecision(entry.id)) {
      entry = this.store.updateExistingEntryDirect(transition(entry, 'resume'));
    }
    const blocked = transitionBlocker(entry, action);
    if (blocked) throw new Error(`试用状态已变化，请刷新后重新核对：${blocked}`);
    if (action === 'promote') {
      const promoted = this.store.promoteProbationToActive(entry.id);
      this.store.recordGovernanceDecision(promoted, 'promote', '人工确认转正');
      return promoted;
    }
    if (action === 'dismiss') {
      const dismissed = this.store.dismissProbation(entry.id);
      this.store.recordGovernanceDecision(dismissed, 'dismiss', '人工淘汰试用经验');
      return dismissed;
    }
    throw new Error(`未知试用裁决动作: ${action}`);
  }

  /** Takes an entry out of service for good, optionally pointing to the entry that replaces it. */
  withdraw(entry: KnowledgeEntry, reason: string, supersedes?: string | null): KnowledgeEntry {
    const why = this.requireReason(reason, '撤回经验必须填写明确原因');
    const next = this.store.updateExistingEntryDirect(transition(entry, 'withdraw', { supersedes: supersedes ?? undefined }));
    this.store.clearAttention(entry.id);
    this.store.recordGovernanceDecision(entry, 'withdraw', why);
    return next;
  }

  /**
   * Feedback from a real task. "Helpful" and "doesn't apply" are one click; only "wrong" asks for an
   * explanation, because it pauses the entry for everyone.
   */
  submitFeedback(entry: KnowledgeEntry, input: FeedbackInput): unknown {
    const detail = String(input.detail ?? '').trim();
    const sessionId = input.sessionId || 'webui-manual';

    if (input.kind === 'inapplicable') {
      return { recorded: true, ...this.store.recordInapplicable(entry.id, sessionId, detail) };
    }
    if (input.kind !== 'verified_effective' && input.kind !== 'suspected_error') {
      throw new Error(`未知反馈类型: ${input.kind}`);
    }
    if (input.kind === 'suspected_error' && !detail) {
      throw new Error('请写下哪里不对，以及你是怎么发现的');
    }
    let task = input.turnId ? `session:${sessionId}` : String(input.taskFingerprint ?? '').trim();
    if (!task && input.kind === 'suspected_error') task = `report:${sha256Hex(detail)}`;
    if (!task) throw new Error('请填写独立任务、工单或测试运行标识');
    if (input.kind === 'verified_effective' && input.turnId && entry.evidence.some((ev) =>
      ev.source_type === 'session_turn' && ev.source_ref === sessionId)) {
      throw new Error('请在产生该经验的会话之外验证');
    }
    return this.store.submitValidation({
      entryId: entry.id,
      sessionId,
      taskFingerprint: task,
      outcome: input.kind === 'verified_effective' ? 'success' : 'failure',
      evidenceNote: detail || '在真实任务中确认有用',
    });
  }

  private requireReason(reason: string, message: string): string {
    const why = String(reason ?? '').trim();
    if (!why) throw new Error(message);
    return why;
  }
}
