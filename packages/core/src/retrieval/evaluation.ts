import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { ViewCompiler } from '../view/view-compiler.ts';
import { mergeTuning, type RetrievalTuning } from './applicability.ts';
import { recordManualApply } from './auto-tuning.ts';

/** One replayable question with what should and should not be shown for it. */
export interface EvalCase {
  id: string;
  source: 'receipt' | 'hand';
  query: string;
  activeFiles?: string[];
  errorText?: string;
  tags?: string[];
  /** Entries that helped (or should be found). Empty = an unrelated question: nothing should be shown. */
  expect: string[];
  /** Entries people said do not apply / were wrong for this question. */
  forbid: string[];
}

export interface EvalMetrics {
  cases: number;
  /** Share of expected entries that were shown (cases with expectations). */
  recall: number;
  /** Share of forbidden entries that were shown anyway. */
  forbiddenShown: number;
  /** Share of unrelated questions that still got reminders. */
  noise: number;
  /** recall − forbiddenShown − 0.5 × noise; higher is better. */
  score: number;
  misses: Array<{ id: string; query: string; missing: string[]; unwanted: string[] }>;
}

/**
 * Turns recorded with their question become cases: entries confirmed helpful in that session are expected,
 * entries reported "does not apply" or wrong are forbidden. Turns without such feedback carry no label.
 */
export function collectReceiptCases(store: LocalMarkdownSqliteStore, limit = 2000, since?: string): EvalCase[] {
  const turns = store.rawDb.prepare(`SELECT session_id, turn_id, query_text, query_tags, active_files FROM turn_receipts
    WHERE workspace_id = ? AND query_text IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT ?`)
    .all(store.workspaceId, since ?? '', limit) as Array<{ session_id: string; turn_id: string; query_text: string; query_tags: string | null; active_files: string | null }>;
  const hitsOf = store.rawDb.prepare(`SELECT entry_id, revision FROM turn_hits WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`);
  const positive = store.rawDb.prepare(`SELECT 1 FROM validation_records WHERE entry_id = ? AND outcome = 'success'
    AND (task_fingerprint = ? OR session_id = ?) LIMIT 1`);
  const cited = store.rawDb.prepare(`SELECT 1 FROM usage_events WHERE entry_id = ? AND session_id = ? AND event_type = 'cited' LIMIT 1`);
  const negative = store.rawDb.prepare(`SELECT 1 FROM usage_events WHERE entry_id = ? AND session_id = ? AND event_type = 'feedback_inapplicable'
    UNION SELECT 1 FROM validation_records WHERE entry_id = ? AND outcome = 'failure' AND (task_fingerprint = ? OR session_id = ?) LIMIT 1`);
  const out: EvalCase[] = [];
  for (const t of turns) {
    const expect: string[] = [];
    const forbid: string[] = [];
    for (const h of hitsOf.all(store.workspaceId, t.session_id, t.turn_id) as Array<{ entry_id: string }>) {
      const task = `session:${t.session_id}`;
      if (negative.get(h.entry_id, t.session_id, h.entry_id, task, t.session_id)) forbid.push(h.entry_id);
      else if (positive.get(h.entry_id, task, t.session_id) || cited.get(h.entry_id, t.session_id)) expect.push(h.entry_id);
    }
    if (!expect.length && !forbid.length) continue;
    out.push({
      id: `${t.session_id}/${t.turn_id}`, source: 'receipt', query: t.query_text, expect, forbid,
      ...(t.query_tags ? { tags: JSON.parse(t.query_tags) as string[] } : {}),
      ...(t.active_files ? { activeFiles: JSON.parse(t.active_files) as string[] } : {}),
    });
  }
  return out;
}

/**
 * Hand-written cases, one JSON object per line (`.accremind/eval/cases.jsonl`):
 * `{"query":"…","expect":["K-…"],"forbid":["K-…"],"files":["src/…"],"error":"…"}`. An empty `expect`
 * marks an unrelated question that should get no reminders.
 */
export function loadHandCases(file: string): EvalCase[] {
  if (!fs.existsSync(file)) return [];
  const out: EvalCase[] = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('//')) return;
    const c = JSON.parse(line) as { query?: string; expect?: string[]; forbid?: string[]; files?: string[]; error?: string; tags?: string[] };
    if (!c.query) throw new Error(`${path.basename(file)} 第 ${i + 1} 行缺少 query`);
    out.push({ id: `hand#${i + 1}`, source: 'hand', query: c.query, expect: c.expect ?? [], forbid: c.forbid ?? [],
      ...(c.files ? { activeFiles: c.files } : {}), ...(c.error ? { errorText: c.error } : {}), ...(c.tags ? { tags: c.tags } : {}) });
  });
  return out;
}

class Tally {
  expected = 0;
  found = 0;
  forbidden = 0;
  forbiddenShown = 0;
  unrelated = 0;
  noisy = 0;
  misses: EvalMetrics['misses'] = [];
  readonly cases: number;
  constructor(cases: number) {
    this.cases = cases;
  }

  add(c: EvalCase, shown: Set<string>): void {
    const missing = c.expect.filter((id) => !shown.has(id));
    const unwanted = c.forbid.filter((id) => shown.has(id));
    this.expected += c.expect.length;
    this.found += c.expect.length - missing.length;
    this.forbidden += c.forbid.length;
    this.forbiddenShown += unwanted.length;
    const unrelated = !c.expect.length && !c.forbid.length;
    if (unrelated) {
      this.unrelated += 1;
      if (shown.size) this.noisy += 1;
    }
    if (missing.length || unwanted.length || (unrelated && shown.size)) {
      this.misses.push({ id: c.id, query: c.query.slice(0, 80), missing, unwanted: unwanted.length ? unwanted : (!c.expect.length ? [...shown] : []) });
    }
  }

  metrics(): EvalMetrics {
    const recall = this.expected ? this.found / this.expected : 1;
    const fShown = this.forbidden ? this.forbiddenShown / this.forbidden : 0;
    const noise = this.unrelated ? this.noisy / this.unrelated : 0;
    return { cases: this.cases, recall, forbiddenShown: fShown, noise, score: recall - fShown - 0.5 * noise, misses: this.misses.slice(0, 50) };
  }
}

/** What AccreMind actually shows: the control arm is "no reminders at all", the middle arm "resident rules only". */
export type ReplayMode = 'full' | 'rules-only' | 'off';

/** Replays `cases[from, to)` with `tuning` swapped in only for the duration of this synchronous call. */
function replay(store: LocalMarkdownSqliteStore, vc: ViewCompiler, cases: EvalCase[], from: number, to: number, tuning: RetrievalTuning, tally: Tally, mode: ReplayMode = 'full'): void {
  const previous = store.tuning;
  store.setTuning(tuning);
  try {
    for (let i = from; i < to; i++) {
      const c = cases[i]!;
      const compiled = vc.compileTurnView({
        sessionId: `eval:${c.id}`, preview: true, userPrompt: c.query, activeFiles: c.activeFiles, errorOutput: c.errorText,
        ...(c.tags ? { tags: c.tags } : {}),
      });
      const shown = mode === 'off' ? new Set<string>()
        : mode === 'rules-only' ? new Set(compiled.residentRuleIds)
          : new Set(compiled.surfacedIds);
      tally.add(c, shown);
    }
  } finally {
    store.setTuning(previous);
  }
}

function evalCompiler(store: LocalMarkdownSqliteStore): ViewCompiler {
  return new ViewCompiler(store, { residentRulesTokens: 500, turnRadarTokens: 300, toolGuardTokens: 240 });
}

/** Replays every case through the real per-turn reminder path (preview: nothing is recorded). */
export function evaluate(store: LocalMarkdownSqliteStore, cases: EvalCase[], tuning: RetrievalTuning, mode: ReplayMode = 'full'): EvalMetrics {
  const tally = new Tally(cases.length);
  replay(store, evalCompiler(store), cases, 0, cases.length, tuning, tally, mode);
  return tally.metrics();
}

/**
 * Same as {@link evaluate}, but yields to the event loop every `chunk` cases (default 4) so a running session is never held
 * up. The trial tuning is only in effect inside each synchronous chunk, so real turns in between use the live one.
 */
export async function evaluateAsync(
  store: LocalMarkdownSqliteStore, cases: EvalCase[], tuning: RetrievalTuning,
  options: { chunk?: number; isCancelled?: () => boolean; mode?: ReplayMode } = {},
): Promise<EvalMetrics> {
  const chunk = options.chunk ?? 4;
  const tally = new Tally(cases.length);
  const vc = evalCompiler(store);
  for (let i = 0; i < cases.length; i += chunk) {
    if (options.isCancelled?.()) break; // the store may be closing: stop before touching it
    replay(store, vc, cases, i, Math.min(cases.length, i + chunk), tuning, tally, options.mode ?? 'full');
    await new Promise<void>((r) => setImmediate(r));
  }
  return tally.metrics();
}

/** Variations around a tuning: stricter/looser thresholds, text saturation, tag weight, reference evidence. */
export function tuningGrid(base: RetrievalTuning): Array<{ label: string; tuning: RetrievalTuning }> {
  const out: Array<{ label: string; tuning: RetrievalTuning }> = [];
  for (const scale of [0.7, 1, 1.3]) {
    for (const sat of [8, 12, 16]) {
      for (const tag of [0.2, 0.3, 0.45]) {
        for (const refs of [2, 3]) {
          const t = mergeTuning({
            ...base,
            minRelevance: Object.fromEntries(Object.entries(base.minRelevance).map(([k, v]) => [k, Math.min(0.95, Number((v * scale).toFixed(3)))])),
            textSaturation: sat,
            weights: { ...base.weights, tag },
            crossRefSignals: refs,
          }, base);
          out.push({ label: `门槛×${scale} 文本饱和${sat} 标签${tag} 参考信号${refs}`, tuning: t });
        }
      }
    }
  }
  return out;
}

export interface EvalReport {
  cases: { receipt: number; hand: number };
  current: EvalMetrics;
  /**
   * The control arms the raw rates cannot show: nothing shown at all (no AccreMind) and resident rules only
   * (rules already in the repository's instructions). `lift` is what the radar and the tool guard add on top.
   */
  baseline: {
    off: EvalMetrics;
    rulesOnly: EvalMetrics;
    lift: { recall: number; noise: number; score: number };
  };
  best?: { label: string; metrics: EvalMetrics; tuning: RetrievalTuning };
  ranking?: Array<{ label: string; score: number; recall: number; forbiddenShown: number; noise: number }>;
  appliedTo?: string;
  notApplied?: string;
}

/**
 * Measures the current retrieval settings on recorded feedback and hand-written cases; with `grid`, tries
 * variations and reports the best; with `apply`, writes the best to `~/.dsh/accremind/tuning.json` (only if it
 * beats the current settings).
 */
export function runEvaluation(store: LocalMarkdownSqliteStore, options: { casesFile?: string; grid?: boolean; apply?: boolean } = {}): EvalReport {
  const receipt = collectReceiptCases(store);
  const hand = loadHandCases(options.casesFile ?? path.join(store.paths.projectAccreMindDir, 'eval', 'cases.jsonl'));
  const cases = [...receipt, ...hand];
  const current = evaluate(store, cases, store.tuning);
  const off = evaluate(store, cases, store.tuning, 'off');
  const rulesOnly = evaluate(store, cases, store.tuning, 'rules-only');
  const baseline = {
    off,
    rulesOnly,
    // Recall gained over the rules-only arm, noise it removes, and the resulting score difference.
    lift: {
      recall: Number((current.recall - rulesOnly.recall).toFixed(3)),
      noise: Number((rulesOnly.noise - current.noise).toFixed(3)),
      score: Number((current.score - rulesOnly.score).toFixed(3)),
    },
  };
  const report: EvalReport = { cases: { receipt: receipt.length, hand: hand.length }, current, baseline };
  if (!options.grid || !cases.length) return report;
  const ranking = tuningGrid(store.tuning).map((v) => ({ ...v, metrics: evaluate(store, cases, v.tuning) }))
    .sort((a, b) => b.metrics.score - a.metrics.score || b.metrics.recall - a.metrics.recall);
  const best = ranking[0]!;
  report.best = { label: best.label, metrics: best.metrics, tuning: best.tuning };
  report.ranking = ranking.slice(0, 10).map((r) => ({ label: r.label, score: r.metrics.score, recall: r.metrics.recall,
    forbiddenShown: r.metrics.forbiddenShown, noise: r.metrics.noise }));
  if (options.apply && store.hasProjectTuning()) {
    report.notApplied = '本项目在 repo.json 中自定义了检索参数：请把更优的参数写进 repo.json 的 settings.tuning，而不是全机参数';
  } else if (options.apply && best.metrics.score > current.score) {
    recordManualApply(store, store.globalTuning, best.tuning, best.label, current, best.metrics);
    report.appliedTo = path.join(store.paths.globalRoot, 'tuning.json');
  }
  return report;
}
