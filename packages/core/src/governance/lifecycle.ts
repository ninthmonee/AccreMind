import type { KnowledgeEntry } from '../contracts/types.ts';

/**
 * The single lifecycle table. Every change to an entry's status / serving / freshness / maturity goes
 * through `transition()`, whoever asks for it (governance decisions, feedback, the staleness scanner,
 * the host). Hosts never set these fields themselves, so the rules stay identical for the local plugin,
 * a team repository and a server.
 *
 * Four independent dimensions:
 *   status     candidate → probation → active, and archived / withdrawn as ends
 *   serving    enabled | suspended   (whether the entry may be shown to the agent)
 *   freshness  current | review_due | stale
 *   maturity   draft → verified → proven
 */
export type LifecycleAction =
  | 'promote'          // trial → confirmed
  | 'dismiss'          // trial → archived
  | 'withdraw'         // any live entry → withdrawn
  | 'mark_stale'       // a person confirms it no longer holds
  | 'request_review'   // stale → back in the review queue, paused meanwhile
  | 'flag_review_due'  // the code it depends on changed
  | 'confirm_fresh'    // a person checked the changed code: still holds
  | 'suspend'          // counterexample or repeated "doesn't apply"
  | 'resume'           // the counterexample was checked and does not hold
  | 'record_success'   // an independent task confirmed it
  | 'revise';          // content edited: new revision; confirmations of the old wording no longer count

export interface TransitionContext {
  now?: string;
  /** For `record_success`: the maturity earned by the independent confirmations so far. */
  maturity?: KnowledgeEntry['maturity'];
  /** For `withdraw`: the entry that replaces this one. */
  supersedes?: string | null;
  /** For `confirm_fresh`: when the next scheduled review is due. */
  reviewDueAt?: string;
  /**
   * For `revise`: `substantive` changes what the entry claims, so earned maturity resets to draft;
   * `editorial` (wording, typos) keeps it. A changed knowledge layer is always substantive.
   */
  impact?: 'substantive' | 'editorial';
  /** For `revise`: the edit came from the code moving (anchor rebinding) and must be checked again. */
  needsReview?: boolean;
}

export class LifecycleError extends Error {
  readonly action: LifecycleAction;
  constructor(action: LifecycleAction, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.action = action;
  }
}

type Guard = (e: KnowledgeEntry) => string | null;
interface Rule {
  /** Plain-language summary, also used in the design doc and tests. */
  summary: string;
  /** Returns why the action is not allowed, or null. */
  guard: Guard;
  apply: (e: KnowledgeEntry, ctx: Required<Pick<TransitionContext, 'now'>> & TransitionContext) => Partial<KnowledgeEntry>;
  /** Activity-log event name. */
  event: string;
}

const live: Guard = (e) => (e.status === 'active' || e.status === 'probation' ? null : '归档或撤回的经验不能再更改');

export const LIFECYCLE: Record<LifecycleAction, Rule> = {
  promote: {
    summary: '试用 → 正式（需检索启用）',
    guard: (e) => (e.status !== 'probation' ? '只有试用中的经验可以转正' : e.serving !== 'enabled' ? '暂停中的试用经验需先处理反证才能转正' : null),
    apply: (_e, c) => ({ status: 'active', updated_at: c.now }),
    event: 'entry.promoted',
  },
  dismiss: {
    summary: '试用 → 归档（停止提醒）',
    guard: (e) => (e.status !== 'probation' ? '只有试用中的经验可以淘汰' : null),
    apply: (_e, c) => ({ status: 'archived', serving: 'suspended', updated_at: c.now }),
    event: 'entry.dismissed',
  },
  withdraw: {
    summary: '候选 / 试用 / 正式 → 撤回（停止提醒，可指向替代经验）',
    guard: (e) => (e.status === 'withdrawn' || e.status === 'archived' ? '这条经验已经下线' : null),
    apply: (e, c) => ({ status: 'withdrawn', serving: 'suspended', supersedes: c.supersedes ?? e.supersedes, updated_at: c.now }),
    event: 'entry.withdrawn',
  },
  mark_stale: {
    summary: '在用经验 → 时效：已失效',
    guard: (e) => live(e) ?? (e.freshness === 'stale' ? '已经标记为失效' : null),
    apply: (_e, c) => ({ freshness: 'stale', updated_at: c.now }),
    event: 'entry.marked_stale',
  },
  request_review: {
    summary: '已失效 → 待复核，复核前暂停提醒',
    guard: (e) => live(e) ?? (e.freshness !== 'stale' ? '只能重新评估已标为失效的经验' : null),
    apply: (_e, c) => ({ freshness: 'review_due', serving: 'suspended', updated_at: c.now }),
    event: 'entry.review_requested',
  },
  flag_review_due: {
    summary: '关联代码变化 → 待复核（不改变是否提醒）',
    guard: (e) => live(e) ?? (e.freshness !== 'current' ? '已在复核队列中' : null),
    apply: (_e, c) => ({ freshness: 'review_due', updated_at: c.now }),
    event: 'entry.review_due',
  },
  confirm_fresh: {
    summary: '待复核 → 当前适用，重置下次复核时间',
    guard: (e) => live(e) ?? (e.freshness === 'stale' ? '已明确失效的经验须先提交依据并重新评估' : e.freshness === 'current' ? '已经是当前适用' : null),
    apply: (_e, c) => ({ freshness: 'current', updated_at: c.now, ...(c.reviewDueAt ? { review_due_at: c.reviewDueAt } : {}) }),
    event: 'entry.confirmed_fresh',
  },
  suspend: {
    summary: '反证或多次“不适用” → 暂停提醒',
    guard: (e) => live(e) ?? (e.serving === 'suspended' ? '已经暂停提醒' : null),
    apply: (_e, c) => ({ serving: 'suspended', updated_at: c.now }),
    event: 'entry.suspended',
  },
  resume: {
    summary: '暂停 → 恢复提醒（时效须为当前适用）',
    guard: (e) => live(e) ?? (e.serving !== 'suspended' || e.freshness !== 'current' ? '仅能对时效已核对、检索已暂停的经验解除反证' : null),
    apply: (_e, c) => ({ serving: 'enabled', updated_at: c.now }),
    event: 'entry.resumed',
  },
  record_success: {
    summary: '独立任务确认有效 → 成熟度上升；试用中则同时转正',
    guard: (e) => live(e) ?? (e.serving !== 'enabled' ? '存在未处理的反证，暂不能登记有效' : null),
    apply: (e, c) => ({
      status: e.status === 'probation' ? 'active' : e.status,
      maturity: c.maturity ?? e.maturity,
      last_validated_at: c.now,
      updated_at: c.now,
    }),
    event: 'entry.validated',
  },
  revise: {
    summary: '修改正文或锚点 → 版本 +1；实质修改时成熟度回到草稿；因代码移动而改的进入待复核',
    guard: (e) => (e.status === 'withdrawn' || e.status === 'archived' ? '已下线的经验不能修订，请新建一条' : null),
    apply: (e, c) => ({
      revision: e.revision + 1,
      maturity: c.impact === 'editorial' ? e.maturity : 'draft',
      ...(c.needsReview ? { freshness: 'review_due' as const, serving: e.freshness === 'stale' ? 'suspended' as const : e.serving } : {}),
      updated_at: c.now,
    }),
    event: 'entry.revised',
  },
};

/** Why `action` is not allowed on this entry right now, or null when it is. */
export function transitionBlocker(entry: KnowledgeEntry, action: LifecycleAction): string | null {
  return LIFECYCLE[action].guard(entry);
}

/** Returns the entry after `action`, or throws a LifecycleError with a plain-language reason. Pure. */
export function transition(entry: KnowledgeEntry, action: LifecycleAction, ctx: TransitionContext = {}): KnowledgeEntry {
  const rule = LIFECYCLE[action];
  const blocked = rule.guard(entry);
  if (blocked) throw new LifecycleError(action, blocked);
  return { ...entry, ...rule.apply(entry, { ...ctx, now: ctx.now ?? new Date().toISOString() }) };
}

/** Actions currently available for an entry, for hosts that render buttons. */
export function availableActions(entry: KnowledgeEntry): LifecycleAction[] {
  return (Object.keys(LIFECYCLE) as LifecycleAction[]).filter((a) => LIFECYCLE[a].guard(entry) === null);
}
