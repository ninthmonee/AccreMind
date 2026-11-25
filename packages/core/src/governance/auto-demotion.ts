import type { KnowledgeEntry } from '../contracts/types.ts';

/**
 * Automatic, reversible demotion of entries that feedback shows are rarely worth showing. Only two steps are
 * automatic and both can be undone in one click:
 *
 *   1. demote   a confirmed entry that keeps being reported "doesn't apply", or that has been shown in many
 *               sessions over weeks and never used, goes back to trial (it still serves, with the trial
 *               exposure limit, and lands in the review queue);
 *   2. archive  an entry that was paused for low value (repeated "doesn't apply", an expired trial, or step 1)
 *               and that nobody decided on for a long time is archived, clearing the queue.
 *
 * Never automatic: team rules, entries with a confirmation (or a counterexample, which is a person's call) on
 * their current wording, entries shared across repositories (their cross-repository feedback decides), and an
 * entry revision a person already restored.
 */
export interface AutoDemotionPolicy {
  enabled: boolean;
  /** Step 1: sessions on the current revision that said "doesn't apply"… */
  demoteInapplicableSessions: number;
  /** …and at least this share of the sessions it was shown in. */
  demoteInapplicableRate: number;
  /** Step 1: shown in at least this many sessions and never opened, cited or confirmed… */
  demoteUnusedShownSessions: number;
  /** …over at least this many days since it was first shown on this revision. */
  demoteUnusedMinDays: number;
  /** Step 2: paused for repeated "doesn't apply" (or after step 1) and undecided for this many days. */
  archiveAfterDays: number;
  /** Step 2: a trial paused only because nobody decided — silence is weak evidence, so it waits longer. */
  archiveSilentAfterDays: number;
}

export const DEFAULT_AUTO_DEMOTION: AutoDemotionPolicy = {
  enabled: true,
  demoteInapplicableSessions: 2,
  demoteInapplicableRate: 0.25,
  demoteUnusedShownSessions: 40,
  demoteUnusedMinDays: 30,
  archiveAfterDays: 30,
  archiveSilentAfterDays: 60,
};

export function mergeAutoDemotionPolicy(partial: Partial<AutoDemotionPolicy> | boolean | undefined): AutoDemotionPolicy {
  if (partial === false) return { ...DEFAULT_AUTO_DEMOTION, enabled: false };
  if (partial === true || partial === undefined) return { ...DEFAULT_AUTO_DEMOTION };
  const out = { ...DEFAULT_AUTO_DEMOTION };
  for (const [k, v] of Object.entries(partial)) {
    if (k === 'enabled' && typeof v === 'boolean') out.enabled = v;
    else if (k in out && typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as unknown as Record<string, number>)[k] = v;
  }
  return out;
}

/** What this repository's sessions did with one entry revision. */
export interface EntrySignals {
  shownSessions: number;
  usedSessions: number;
  inapplicableSessions: number;
  successes: number;
  failures: number;
  /** When it was first shown on this revision (ISO), if ever. */
  firstShownAt: string | null;
}

export interface DemotionVerdict {
  step: 'demote' | 'archive';
  reason: string;
}

const DAY = 86_400_000;

/** Step 1 decision for a confirmed entry. Pure. */
export function demoteVerdict(entry: KnowledgeEntry, s: EntrySignals, policy: AutoDemotionPolicy, now: Date): DemotionVerdict | null {
  if (!policy.enabled || entry.status !== 'active' || entry.serving !== 'enabled' || entry.layer === 'team_rule') return null;
  if (s.successes > 0 || s.failures > 0) return null;
  const rate = s.shownSessions ? s.inapplicableSessions / s.shownSessions : s.inapplicableSessions ? 1 : 0;
  if (s.inapplicableSessions >= policy.demoteInapplicableSessions && rate >= policy.demoteInapplicableRate) {
    return {
      step: 'demote',
      reason: `当前版本被 ${s.inapplicableSessions} 个会话反馈“不适用”（占提醒会话的 ${Math.round(rate * 100)}%），且没有任何确认，已自动降为试用。`,
    };
  }
  const days = s.firstShownAt ? (now.getTime() - Date.parse(s.firstShownAt)) / DAY : 0;
  if (s.shownSessions >= policy.demoteUnusedShownSessions && s.usedSessions === 0 && days >= policy.demoteUnusedMinDays) {
    return {
      step: 'demote',
      reason: `${Math.floor(days)} 天里在 ${s.shownSessions} 个会话中提醒过，从未被打开、引用或确认，已自动降为试用。`,
    };
  }
  return null;
}

/**
 * Step 2 decision for a paused entry. `pausedFor` is the oldest open reason it is paused for, with when it was
 * raised; `decidedSince` is whether a person made any decision on it after that.
 */
export function archiveVerdict(
  entry: KnowledgeEntry,
  s: EntrySignals,
  paused: { kind: 'inapplicable' | 'probation_silent' | 'auto_demoted'; since: string } | null,
  decidedSince: boolean,
  policy: AutoDemotionPolicy,
  now: Date,
): DemotionVerdict | null {
  if (!policy.enabled || !paused || decidedSince) return null;
  if (entry.layer === 'team_rule' || entry.serving !== 'suspended') return null;
  if (entry.status !== 'active' && entry.status !== 'probation') return null;
  if (s.successes > 0 || s.failures > 0) return null;
  const wait = paused.kind === 'probation_silent' ? policy.archiveSilentAfterDays : policy.archiveAfterDays;
  const days = (now.getTime() - Date.parse(paused.since)) / DAY;
  if (days < wait) return null;
  const why = paused.kind === 'probation_silent' ? '试用期满后一直无人决定' : '因多次“不适用”暂停后';
  return { step: 'archive', reason: `${why}，${Math.floor(days)} 天内没有人处理，已自动归档。可以一键恢复。` };
}
