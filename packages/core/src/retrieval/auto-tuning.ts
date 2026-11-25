import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomicSync } from '../codec/atomic-fs.ts';
import { withFileLock } from '../codec/file-lock.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { loadTuning, mergeTuning, type RetrievalTuning } from './applicability.ts';
import { collectReceiptCases, evaluateAsync, loadHandCases, type EvalCase, type EvalMetrics } from './evaluation.ts';

/**
 * Automatic retrieval tuning with guardrails and rollback.
 *
 * Every `intervalDays` a repository replays its labelled turns ("helpful" / "doesn't apply" feedback, plus the
 * hand-written cases) against the current settings and a few small variations of them. A variation is applied
 * only if there are enough cases, it clearly scores better, and it neither loses recall nor shows more entries
 * people rejected. After applying, the change is on watch: once enough new feedback has come in, the new and
 * previous settings are compared on the turns recorded *since* the change, and the live "doesn't apply" rate
 * before and after is compared too. If either got worse, the previous settings come back and that variation is
 * not tried again for `cooldownDays`. Every step is written to `tuning-history.jsonl`; any of them can be undone.
 */
export interface AutoTunePolicy {
  enabled: boolean;
  intervalDays: number;
  /** Labelled cases needed before anything is changed. */
  minCases: number;
  /** Most recent labelled turns replayed per run (bounds the work). */
  maxCases: number;
  /** Required score improvement (score = recall − rejected shown − ½ noise). */
  minGain: number;
  /** Recall may drop by at most this much. */
  maxRecallDrop: number;
  /** Days after a change before it is judged… */
  watchDays: number;
  /** …and labelled turns recorded since the change needed to judge it. */
  watchMinCases: number;
  /** Give up waiting for enough feedback after this many days (the change is kept). */
  watchMaxDays: number;
  /** Previous settings must beat the new ones by this much on post-change turns to roll back. */
  rollbackMargin: number;
  /** Live check: sessions shown reminders since the change needed… */
  liveMinShownSessions: number;
  /** …and the "doesn't apply" rate rising above before × this (plus 2 points) rolls back. */
  liveInapplicableRise: number;
  /** A rolled-back variation is not tried again for this long. */
  cooldownDays: number;
}

export const DEFAULT_AUTO_TUNE: AutoTunePolicy = {
  enabled: true,
  intervalDays: 7,
  minCases: 30,
  maxCases: 300,
  minGain: 0.03,
  maxRecallDrop: 0.02,
  watchDays: 3,
  watchMinCases: 15,
  watchMaxDays: 30,
  rollbackMargin: 0.02,
  liveMinShownSessions: 50,
  liveInapplicableRise: 1.5,
  cooldownDays: 30,
};

export function mergeAutoTunePolicy(partial: Partial<AutoTunePolicy> | boolean | undefined): AutoTunePolicy {
  if (partial === false) return { ...DEFAULT_AUTO_TUNE, enabled: false };
  if (partial === true || partial === undefined) return { ...DEFAULT_AUTO_TUNE };
  const out = { ...DEFAULT_AUTO_TUNE };
  for (const [k, v] of Object.entries(partial)) {
    if (k === 'enabled' && typeof v === 'boolean') out.enabled = v;
    else if (k in out && typeof v === 'number' && Number.isFinite(v) && v >= 0) (out as unknown as Record<string, number>)[k] = v;
  }
  return out;
}

export type TuningAction = 'apply' | 'rollback' | 'kept' | 'manual_apply' | 'manual_rollback';

interface MetricsSummary { cases: number; score: number; recall: number; forbiddenShown: number; noise: number }

export interface TuningHistoryRecord {
  at: string;
  repo: string;
  action: TuningAction;
  reason: string;
  label?: string;
  from: RetrievalTuning;
  to: RetrievalTuning;
  before?: MetricsSummary;
  after?: MetricsSummary;
}

interface AutoTuneState {
  lastRunAt: Record<string, string>;
  /** The change currently on watch. */
  watching?: { appliedAt: string; repo: string; label: string; previous: RetrievalTuning; applied: RetrievalTuning };
  /** Variations rolled back, by hash, with when they may be tried again. */
  rejected: Record<string, string>;
}

export interface AutoTuneOutcome {
  action: TuningAction | 'skipped' | 'watching';
  reason: string;
  record?: TuningHistoryRecord;
}

const DAY = 86_400_000;

function files(store: LocalMarkdownSqliteStore) {
  const root = store.paths.globalRoot;
  return {
    tuning: path.join(root, 'tuning.json'),
    history: path.join(root, 'tuning-history.jsonl'),
    state: path.join(root, 'tuning-auto.json'),
    lock: path.join(root, 'locks', 'tuning.lock'),
  };
}

export function tuningHash(t: RetrievalTuning): string {
  return createHash('sha256').update(JSON.stringify(mergeTuning(t))).digest('hex').slice(0, 16);
}

function summary(m: EvalMetrics): MetricsSummary {
  const r = (n: number) => Number(n.toFixed(4));
  return { cases: m.cases, score: r(m.score), recall: r(m.recall), forbiddenShown: r(m.forbiddenShown), noise: r(m.noise) };
}

function readState(file: string): AutoTuneState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutoTuneState>;
    return { lastRunAt: s.lastRunAt ?? {}, rejected: s.rejected ?? {}, ...(s.watching ? { watching: s.watching } : {}) };
  } catch {
    return { lastRunAt: {}, rejected: {} };
  }
}

function writeState(file: string, state: AutoTuneState): void {
  writeFileAtomicSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Tuning history, newest first. */
export function readTuningHistory(store: LocalMarkdownSqliteStore, limit = 50): TuningHistoryRecord[] {
  const file = files(store).history;
  if (!fs.existsSync(file)) return [];
  const out: TuningHistoryRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TuningHistoryRecord);
    } catch {
      // a torn line from a crash: skip
    }
  }
  return out.reverse().slice(0, limit);
}

function commit(store: LocalMarkdownSqliteStore, record: TuningHistoryRecord): void {
  const f = files(store);
  writeFileAtomicSync(f.tuning, `${JSON.stringify(record.to, null, 2)}\n`);
  fs.mkdirSync(path.dirname(f.history), { recursive: true });
  fs.appendFileSync(f.history, `${JSON.stringify(record)}\n`, 'utf8');
  store.setTuning(record.to);
}

function log(store: LocalMarkdownSqliteStore, record: TuningHistoryRecord): void {
  const f = files(store);
  fs.mkdirSync(path.dirname(f.history), { recursive: true });
  fs.appendFileSync(f.history, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Small steps around the current settings, one knob at a time (cheap enough to run unattended). */
export function neighbourTunings(base: RetrievalTuning): Array<{ label: string; tuning: RetrievalTuning }> {
  const out: Array<{ label: string; tuning: RetrievalTuning }> = [];
  const add = (label: string, patch: Partial<RetrievalTuning>) => out.push({ label, tuning: mergeTuning({ ...base, ...patch }, base) });
  for (const scale of [0.85, 1.15]) {
    add(`跨仓库门槛×${scale}`, {
      minRelevance: Object.fromEntries(Object.entries(base.minRelevance).map(([k, v]) => [k, Math.min(0.95, Number((v * scale).toFixed(3)))])) as RetrievalTuning['minRelevance'],
    });
  }
  for (const d of [-4, 4]) {
    if (base.textSaturation + d >= 4) add(`文本饱和 ${base.textSaturation} → ${base.textSaturation + d}`, { textSaturation: base.textSaturation + d });
  }
  for (const d of [-0.1, 0.1]) {
    const tag = Number((base.weights.tag + d).toFixed(2));
    if (tag >= 0.05 && tag <= 0.8) add(`标签权重 ${base.weights.tag} → ${tag}`, { weights: { ...base.weights, tag } });
  }
  for (const d of [-0.1, 0.1]) {
    const text = Number((base.weights.text + d).toFixed(2));
    if (text >= 0.15 && text <= 0.8) add(`文本权重 ${base.weights.text} → ${text}`, { weights: { ...base.weights, text } });
  }
  for (const d of [-1, 1]) {
    const refs = base.crossRefSignals + d;
    if (refs >= 1 && refs <= 4) add(`参考信号 ${base.crossRefSignals} → ${refs}`, { crossRefSignals: refs });
  }
  return out;
}

/** "Doesn't apply" sessions per session shown reminders, in this repository, within [from, to). */
function inapplicableRate(store: LocalMarkdownSqliteStore, from: string, to: string): { shown: number; rate: number } {
  const r = store.rawDb.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN event_type IN ('radar_shown', 'guard_shown') THEN session_id END) AS shown,
      COUNT(DISTINCT CASE WHEN event_type = 'feedback_inapplicable' THEN session_id || '/' || entry_id END) AS bad
    FROM usage_events WHERE created_at >= ? AND created_at < ? AND session_id NOT LIKE 'eval:%'`).get(from, to) as { shown: number; bad: number };
  const shown = Number(r.shown);
  return { shown, rate: shown ? Number(r.bad) / shown : 0 };
}

/**
 * One unattended round: judge the change on watch (keep or roll back), otherwise — at most every
 * `intervalDays` — look for a clearly better setting and apply it. Safe to call often; does nothing when not due.
 */
export async function runAutoTune(
  store: LocalMarkdownSqliteStore,
  options: {
    policy?: Partial<AutoTunePolicy> | AutoTunePolicy; now?: Date; force?: boolean; casesFile?: string; isCancelled?: () => boolean;
    /** Replaces the replay (tests, or a host with its own evaluator). */
    evaluator?: (cases: EvalCase[], tuning: RetrievalTuning) => Promise<EvalMetrics>;
    /** Replaces where labelled cases come from (`since`: only turns recorded after it). */
    cases?: (since?: string) => EvalCase[];
  } = {},
): Promise<AutoTuneOutcome> {
  const policy = mergeAutoTunePolicy(options.policy);
  const score = options.evaluator ?? ((cases: EvalCase[], tuning: RetrievalTuning) => evaluateAsync(store, cases, tuning, { isCancelled: options.isCancelled }));
  if (!policy.enabled) return { action: 'skipped', reason: '自动调参已关闭' };
  const now = options.now ?? new Date();
  const f = files(store);
  const repo = store.workspaceId;
  const state = readState(f.state);
  // Another window may have changed the settings since this one started.
  const live = loadTuning(f.tuning);
  if (tuningHash(live) !== tuningHash(store.tuning)) store.setTuning(live);

  if (state.watching) {
    const w = state.watching;
    const age = (now.getTime() - Date.parse(w.appliedAt)) / DAY;
    if (tuningHash(live) !== tuningHash(w.applied)) {
      // changed by hand (or another rule) meanwhile: nothing left to judge
      withFileLock(f.lock, () => { const s = readState(f.state); delete s.watching; writeState(f.state, s); });
      return { action: 'skipped', reason: '观察中的调整已被手动替换' };
    }
    if (age < policy.watchDays) return { action: 'watching', reason: `调整后观察期未满（${age.toFixed(1)}/${policy.watchDays} 天）` };
    const since = options.cases ? options.cases(w.appliedAt) : collectReceiptCases(store, policy.maxCases, w.appliedAt);
    const before = inapplicableRate(store, new Date(Date.parse(w.appliedAt) - (now.getTime() - Date.parse(w.appliedAt))).toISOString(), w.appliedAt);
    const after = inapplicableRate(store, w.appliedAt, new Date(now.getTime() + 1).toISOString());
    const liveWorse = after.shown >= policy.liveMinShownSessions && after.rate > before.rate * policy.liveInapplicableRise + 0.02;
    if (since.length < policy.watchMinCases && !liveWorse) {
      if (age < policy.watchMaxDays) return { action: 'watching', reason: `调整后的新反馈不足（${since.length}/${policy.watchMinCases}）` };
      const record: TuningHistoryRecord = { at: now.toISOString(), repo, action: 'kept', label: w.label, from: w.previous, to: w.applied,
        reason: `${policy.watchMaxDays} 天内新反馈不足以判断，保留调整` };
      withFileLock(f.lock, () => { log(store, record); const s = readState(f.state); delete s.watching; writeState(f.state, s); });
      return { action: 'kept', reason: record.reason, record };
    }
    const cur = since.length ? await score(since, w.applied) : undefined;
    const prev = since.length ? await score(since, w.previous) : undefined;
    if (options.isCancelled?.()) return { action: 'skipped', reason: '已取消' };
    const replayWorse = Boolean(cur && prev && since.length >= policy.watchMinCases && prev.score - cur.score >= policy.rollbackMargin);
    if (replayWorse || liveWorse) {
      const reason = replayWorse
        ? `调整后的 ${since.length} 轮回放：原参数得分 ${prev!.score.toFixed(3)}，新参数 ${cur!.score.toFixed(3)}，已回滚`
        : `调整后“不适用”比例从 ${(before.rate * 100).toFixed(1)}% 升到 ${(after.rate * 100).toFixed(1)}%，已回滚`;
      const record: TuningHistoryRecord = { at: now.toISOString(), repo, action: 'rollback', label: w.label, from: w.applied, to: w.previous, reason,
        ...(cur ? { before: summary(cur) } : {}), ...(prev ? { after: summary(prev) } : {}) };
      withFileLock(f.lock, () => {
        if (tuningHash(loadTuning(f.tuning)) !== tuningHash(w.applied)) return;
        commit(store, record);
        const s = readState(f.state);
        delete s.watching;
        s.rejected[tuningHash(w.applied)] = new Date(now.getTime() + policy.cooldownDays * DAY).toISOString();
        writeState(f.state, s);
      });
      return { action: 'rollback', reason, record };
    }
    const record: TuningHistoryRecord = { at: now.toISOString(), repo, action: 'kept', label: w.label, from: w.previous, to: w.applied,
      reason: cur && prev ? `调整后的 ${since.length} 轮回放：新参数 ${cur.score.toFixed(3)} ≥ 原参数 ${prev.score.toFixed(3)}，保留` : '实际“不适用”比例未上升，保留',
      ...(prev ? { before: summary(prev) } : {}), ...(cur ? { after: summary(cur) } : {}) };
    withFileLock(f.lock, () => { log(store, record); const s = readState(f.state); delete s.watching; writeState(f.state, s); });
    return { action: 'kept', reason: record.reason, record };
  }

  const last = state.lastRunAt[repo];
  if (!options.force && last && now.getTime() - Date.parse(last) < policy.intervalDays * DAY) {
    return { action: 'skipped', reason: `距上次自动调参不足 ${policy.intervalDays} 天` };
  }
  const markRun = () => withFileLock(f.lock, () => { const s = readState(f.state); s.lastRunAt[repo] = now.toISOString(); writeState(f.state, s); });
  const cases: EvalCase[] = options.cases ? options.cases() : [
    ...collectReceiptCases(store, policy.maxCases),
    ...loadHandCases(options.casesFile ?? path.join(store.paths.projectAccreMindDir, 'eval', 'cases.jsonl')),
  ];
  if (cases.length < policy.minCases) {
    markRun();
    return { action: 'skipped', reason: `有标注的样本不足（${cases.length}/${policy.minCases}），不调整` };
  }
  const base = store.tuning;
  const current = await score(cases, base);
  if (options.isCancelled?.()) return { action: 'skipped', reason: '已取消' };
  let best: { label: string; tuning: RetrievalTuning; metrics: EvalMetrics } | null = null;
  for (const v of neighbourTunings(base)) {
    if (options.isCancelled?.()) return { action: 'skipped', reason: '已取消' };
    const until = state.rejected[tuningHash(v.tuning)];
    if (until && Date.parse(until) > now.getTime()) continue;
    const m = await score(cases, v.tuning);
    if (options.isCancelled?.()) return { action: 'skipped', reason: '已取消' };
    const safe = m.recall >= current.recall - policy.maxRecallDrop && m.forbiddenShown <= current.forbiddenShown + 1e-9;
    if (safe && m.score - current.score >= policy.minGain && (!best || m.score > best.metrics.score)) best = { ...v, metrics: m };
  }
  if (!best) {
    markRun();
    return { action: 'skipped', reason: `${cases.length} 个样本上没有明显更好且安全的参数（当前得分 ${current.score.toFixed(3)}）` };
  }
  const record: TuningHistoryRecord = {
    at: now.toISOString(), repo, action: 'apply', label: best.label, from: base, to: best.tuning,
    reason: `${cases.length} 个样本：得分 ${current.score.toFixed(3)} → ${best.metrics.score.toFixed(3)}（召回 ${current.recall.toFixed(2)} → ${best.metrics.recall.toFixed(2)}）`,
    before: summary(current), after: summary(best.metrics),
  };
  let applied = false;
  withFileLock(f.lock, () => {
    if (tuningHash(loadTuning(f.tuning)) !== tuningHash(base)) return; // another window changed it meanwhile
    commit(store, record);
    const s = readState(f.state);
    s.lastRunAt[repo] = now.toISOString();
    s.watching = { appliedAt: now.toISOString(), repo, label: best!.label, previous: base, applied: best!.tuning };
    writeState(f.state, s);
    applied = true;
  });
  if (!applied) return { action: 'skipped', reason: '另一个窗口刚调整过参数，本次放弃' };
  return { action: 'apply', reason: record.reason, record };
}

/** Records a manual `eval --apply` so it shows in the history and can be rolled back the same way. */
export function recordManualApply(store: LocalMarkdownSqliteStore, from: RetrievalTuning, to: RetrievalTuning, label: string, before: EvalMetrics, after: EvalMetrics): TuningHistoryRecord {
  const f = files(store);
  const record: TuningHistoryRecord = { at: new Date().toISOString(), repo: store.workspaceId, action: 'manual_apply', label, from, to,
    reason: `手动应用：得分 ${before.score.toFixed(3)} → ${after.score.toFixed(3)}`, before: summary(before), after: summary(after) };
  withFileLock(f.lock, () => {
    commit(store, record);
    const s = readState(f.state);
    delete s.watching;
    writeState(f.state, s);
  });
  return record;
}

/**
 * Undoes the most recent change (automatic or manual) that is still in effect: the settings it replaced come
 * back. Without any recorded change it restores the defaults.
 */
export function rollbackTuning(store: LocalMarkdownSqliteStore, note = ''): TuningHistoryRecord {
  const f = files(store);
  return withFileLock(f.lock, () => {
    const live = loadTuning(f.tuning);
    const last = readTuningHistory(store, 500).find((r) => (r.action === 'apply' || r.action === 'manual_apply' || r.action === 'rollback' || r.action === 'manual_rollback')
      && tuningHash(r.to) === tuningHash(live));
    const target = last ? last.from : mergeTuning({});
    const record: TuningHistoryRecord = { at: new Date().toISOString(), repo: store.workspaceId, action: 'manual_rollback', from: live, to: target,
      ...(last?.label ? { label: last.label } : {}), reason: note || (last ? `手动撤销 ${last.at.slice(0, 10)} 的调整` : '恢复默认参数') };
    commit(store, record);
    const s = readState(f.state);
    if (s.watching) s.rejected[tuningHash(s.watching.applied)] = new Date(Date.now() + DEFAULT_AUTO_TUNE.cooldownDays * DAY).toISOString();
    delete s.watching;
    writeState(f.state, s);
    return record;
  });
}

/** What the automatic tuning is doing right now, for the workbench. */
export function autoTuneStatus(store: LocalMarkdownSqliteStore): { lastRunAt: string | null; watching: AutoTuneState['watching'] | null; current: RetrievalTuning; history: TuningHistoryRecord[] } {
  const f = files(store);
  const s = readState(f.state);
  return { lastRunAt: s.lastRunAt[store.workspaceId] ?? null, watching: s.watching ?? null, current: store.tuning, history: readTuningHistory(store, 20) };
}
