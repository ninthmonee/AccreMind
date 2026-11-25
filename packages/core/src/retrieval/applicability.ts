import * as fs from 'node:fs';
import type { KnowledgeEntry, ScopeVerdict, SessionContext, StorageZone } from '../contracts/types.ts';

/**
 * Every knob of cross-repository relevance in one place. Defaults are starting values; `accremind eval`
 * measures them against recorded feedback and hand-written cases and can write a tuned
 * `~/.dsh/accremind/tuning.json`, which overrides any subset of these values.
 */
export interface RetrievalTuning {
  verdictFactor: Record<ScopeVerdict, number>;
  minRelevance: Record<ScopeVerdict, number>;
  quota: Record<ScopeVerdict, number>;
  weights: { text: number; alias: number; symbol: number; path: number; tag: number };
  /** Raw keyword score at which text strength reaches ~63%. */
  textSaturation: number;
  /** Independent signals a cross-repository reference needs. */
  crossRefSignals: number;
}

export const DEFAULT_TUNING: RetrievalTuning = {
  verdictFactor: { own_repo: 1.0, domain_match: 0.9, stack_match: 0.85, owner_match: 0.8, cross_ref: 0.5 },
  minRelevance: { own_repo: 0, domain_match: 0.3, stack_match: 0.35, owner_match: 0.35, cross_ref: 0.6 },
  quota: { own_repo: 3, domain_match: 2, stack_match: 2, owner_match: 1, cross_ref: 1 },
  weights: { text: 0.45, alias: 0.2, symbol: 0.2, path: 0.4, tag: 0.3 },
  textSaturation: 12,
  crossRefSignals: 2,
};

/** Merges a partial tuning over the defaults (unknown keys and non-numbers are ignored). */
export function mergeTuning(partial: unknown, base: RetrievalTuning = DEFAULT_TUNING): RetrievalTuning {
  const out: RetrievalTuning = JSON.parse(JSON.stringify(base));
  if (!partial || typeof partial !== 'object') return out;
  const p = partial as Record<string, unknown>;
  for (const group of ['verdictFactor', 'minRelevance', 'quota', 'weights'] as const) {
    const src = p[group];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (k in out[group] && typeof v === 'number' && Number.isFinite(v)) (out[group] as Record<string, number>)[k] = v;
    }
  }
  if (typeof p.textSaturation === 'number' && p.textSaturation > 0) out.textSaturation = p.textSaturation;
  if (typeof p.crossRefSignals === 'number' && p.crossRefSignals >= 1) out.crossRefSignals = Math.round(p.crossRefSignals);
  return out;
}

export function loadTuning(file: string): RetrievalTuning {
  try {
    return mergeTuning(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return mergeTuning(null);
  }
}

/** Multiplier on the ranking score: the further an entry is from this repository, the more it must earn its place. */
export const VERDICT_FACTOR = DEFAULT_TUNING.verdictFactor;
/**
 * Minimum absolute relevance (0..1) per verdict. Own-repository entries keep the historic behaviour
 * (any keyword or path hit); broader scopes need stronger evidence.
 */
export const VERDICT_MIN_RELEVANCE = DEFAULT_TUNING.minRelevance;
/** Per-verdict share of a result list; leftover slots are back-filled with own-repository hits. */
export const VERDICT_QUOTA = DEFAULT_TUNING.quota;

export const VERDICT_LABEL: Record<ScopeVerdict, string> = {
  own_repo: '本仓库',
  domain_match: '同领域',
  stack_match: '同技术栈',
  owner_match: '个人经验',
  cross_ref: '跨仓库参考',
};

export interface ApplicabilityInput {
  entry: KnowledgeEntry;
  /** Index source the row came from: the current repository, `__global__`, or another repository's ID. */
  sourceId: string;
  zone: StorageZone;
}

export type ApplicabilityOutcome =
  | { ok: true; verdict: ScopeVerdict; originRepo: string | null; reasons: string[] }
  | { ok: false; reason: string };

/**
 * Decides whether an entry may be served in this session and on which footing, before any scoring.
 * `scope: 'repo'` keeps only own-repository entries; `scope: 'all'` also lets other repositories'
 * project knowledge through as labelled references.
 */
export function judgeApplicability(
  input: ApplicabilityInput,
  ctx: SessionContext,
  globalSourceId: string,
  scope: 'auto' | 'repo' | 'all' = 'auto',
): ApplicabilityOutcome {
  const { entry, sourceId } = input;
  const here = ctx.repoId;
  const fromHere = sourceId === here;
  const originRepo = entry.origin_repo ?? (sourceId === globalSourceId ? null : sourceId);
  const applies = entry.applies_to ?? {};

  if (applies.exclude_repos?.includes(here)) return { ok: false, reason: 'excluded_repo' };
  // A trial is only ever served in the repository that produced it.
  if (entry.status === 'probation' && !fromHere && (entry.origin_repo ?? sourceId) !== here) {
    return { ok: false, reason: 'foreign_trial' };
  }
  if (applies.repos?.includes(here)) return { ok: true, verdict: 'own_repo', originRepo, reasons: ['已声明适用于本仓库'] };
  // A sub-project entry is served when the work touches that sub-project (or when it is not known which one).
  if (entry.subproject && (fromHere || originRepo === here) && ctx.subprojects?.length && !ctx.subprojects.includes(entry.subproject)) {
    return { ok: false, reason: 'other_subproject' };
  }

  const outcome = ((): ApplicabilityOutcome => {
    switch (entry.layer) {
      case 'team_rule':
      case 'project':
        if (fromHere) return { ok: true, verdict: 'own_repo', originRepo, reasons: [] };
        return scope === 'all'
          ? { ok: true, verdict: 'cross_ref', originRepo, reasons: [`来自其他仓库 ${originRepo ?? sourceId} 的项目知识`] }
          : { ok: false, reason: 'foreign_project' };
      case 'domain': {
        if (fromHere) return { ok: true, verdict: 'own_repo', originRepo, reasons: [] };
        const keys = new Set(ctx.domains.map((d) => d.toLowerCase()));
        const shared = (entry.domains ?? []).filter((d) => keys.has(d.toLowerCase()));
        if (shared.length) {
          // Knowledge meant for the domain's core projects is not served where the domain is only used.
          const consumer = new Set((ctx.consumerDomains ?? []).map((d) => d.toLowerCase()));
          if (entry.audience === 'core' && shared.every((d) => consumer.has(d.toLowerCase()))) return { ok: false, reason: 'audience_core' };
          return { ok: true, verdict: 'domain_match', originRepo, reasons: [`同属业务领域 ${shared.join('、')}`] };
        }
        return { ok: true, verdict: 'cross_ref', originRepo, reasons: ['领域不同，仅作参考'] };
      }
      case 'shared_tech': {
        const langs = applies.languages ?? [];
        const deps = applies.dependencies ?? [];
        if (langs.length && ctx.languages.length && !langs.some((l) => ctx.languages.includes(l))) {
          return { ok: false, reason: 'language_mismatch' };
        }
        const presentDeps = deps.filter((d) => ctx.dependencies[d.name] !== undefined);
        if (deps.length && Object.keys(ctx.dependencies).length && !presentDeps.length) {
          return { ok: false, reason: 'dependency_absent' };
        }
        const reasons: string[] = [];
        if (presentDeps.length) reasons.push(`本仓库依赖 ${presentDeps.map((d) => d.name).join('、')}`);
        if (langs.length && langs.some((l) => ctx.languages.includes(l))) reasons.push(`语言 ${langs.filter((l) => ctx.languages.includes(l)).join('、')}`);
        if (reasons.length) return { ok: true, verdict: 'stack_match', originRepo, reasons };
        if (fromHere || originRepo === here) return { ok: true, verdict: 'own_repo', originRepo, reasons: [] };
        return { ok: true, verdict: 'cross_ref', originRepo, reasons: ['未声明适用技术栈，仅作参考'] };
      }
      case 'personal':
        if (entry.owner && ctx.userId && entry.owner !== ctx.userId && !(ctx.userAliases ?? []).includes(entry.owner)) {
          return { ok: false, reason: 'other_owner' };
        }
        return { ok: true, verdict: 'owner_match', originRepo, reasons: ['你的个人经验'] };
    }
  })();
  if (!outcome.ok) return outcome;
  if (scope === 'repo' && outcome.verdict !== 'own_repo') return { ok: false, reason: 'scope_repo' };
  return outcome;
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|_)[A-Za-z0-9_$]+)+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|\b[A-Z]{2,}[-_]?\d{2,}\b|\bE[A-Z]{3,}\b/g;

/** Code identifiers and error codes worth exact matching (`OrderService.create`, `ECONNRESET`, `ORA-00001`). */
export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) {
    const t = m[0];
    if (t.length >= 4) out.add(t.toLowerCase());
  }
  return [...out].slice(0, 40);
}

/** Saturating 0..1 transform of the raw keyword score (the raw score is unbounded and only meaningful relatively). */
export function textStrength(rawTextScore: number, saturation = DEFAULT_TUNING.textSaturation): number {
  return rawTextScore <= 0 ? 0 : 1 - Math.exp(-rawTextScore / saturation);
}

export interface RelevanceSignals {
  text: number;
  alias: boolean;
  symbol: boolean;
  path: boolean;
  dependency: boolean;
  /** 0..1 share of the question's topic tags the entry carries. */
  tag?: number;
}

export function relevanceOf(s: RelevanceSignals, w: RetrievalTuning['weights'] = DEFAULT_TUNING.weights): number {
  return Math.min(1, w.text * s.text + w.alias * (s.alias ? 1 : 0) + w.symbol * (s.symbol ? 1 : 0) +
    w.path * (s.path ? 1 : 0) + w.tag * (s.tag ?? 0));
}

/** Independent pieces of evidence; a bare reference from far away needs at least two. */
export function signalCount(s: RelevanceSignals): number {
  return (s.text >= 0.3 ? 1 : 0) + (s.alias ? 1 : 0) + (s.symbol ? 1 : 0) + (s.path ? 1 : 0) + (s.dependency ? 1 : 0) +
    ((s.tag ?? 0) > 0 ? 1 : 0);
}

function trigrams(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i += 1) out.add(norm.slice(i, i + 3));
  return out;
}

/** Similarity of two claims (trigram Jaccard on the normalized text). */
const trigramCache = new WeakMap<KnowledgeEntry, { text: string; grams: Set<string> }>();
function claimTrigrams(e: KnowledgeEntry): Set<string> {
  const text = `${e.claim} ${e.knowledge_delta}`;
  const hit = trigramCache.get(e);
  if (hit && hit.text === text) return hit.grams;
  const grams = trigrams(text);
  trigramCache.set(e, { text, grams });
  return grams;
}

export function claimSimilarity(a: KnowledgeEntry, b: KnowledgeEntry): number {
  const ta = claimTrigrams(a);
  const tb = claimTrigrams(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export const DUPLICATE_SIMILARITY = 0.8;

const SPECIFICITY: Record<ScopeVerdict, number> = { own_repo: 0, domain_match: 1, stack_match: 2, owner_match: 3, cross_ref: 4 };
const LAYER_SPECIFICITY: Record<KnowledgeEntry['layer'], number> = { team_rule: 0, project: 1, domain: 2, shared_tech: 3, personal: 4 };

/**
 * Keeps one entry per cluster of near-identical claims (and drops a shared-tech entry that a served
 * domain entry `specializes`): the more specific scope wins, then the higher score.
 */
export function dedupeByCluster<T extends { entry: KnowledgeEntry; score: number; scopeVerdict?: ScopeVerdict }>(hits: T[]): T[] {
  // Only an entry that actually applies here can stand in for the general one it refines.
  const specialized = new Set(hits.filter((h) => (h.scopeVerdict ?? 'own_repo') === 'own_repo' || h.scopeVerdict === 'domain_match')
    .map((h) => h.entry.specializes).filter(Boolean) as string[]);
  const kept: T[] = [];
  const ordered = [...hits].filter((h) => !specialized.has(h.entry.id)).sort((a, b) =>
    (SPECIFICITY[a.scopeVerdict ?? 'own_repo'] - SPECIFICITY[b.scopeVerdict ?? 'own_repo']) ||
    (LAYER_SPECIFICITY[a.entry.layer] - LAYER_SPECIFICITY[b.entry.layer]) || (b.score - a.score));
  for (const h of ordered) {
    if (kept.some((k) => k.entry.id === h.entry.id || claimSimilarity(k.entry, h.entry) >= DUPLICATE_SIMILARITY)) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/** Fills `limit` slots by score while respecting per-verdict quotas, then back-fills from what is left. */
export function applyQuotas<T extends { scopeVerdict?: ScopeVerdict }>(sorted: T[], limit: number, quota: Record<ScopeVerdict, number> = VERDICT_QUOTA): T[] {
  const used: Partial<Record<ScopeVerdict, number>> = {};
  const picked: T[] = [];
  const rest: T[] = [];
  for (const h of sorted) {
    const v = h.scopeVerdict ?? 'own_repo';
    if (picked.length < limit && (used[v] ?? 0) < quota[v]) {
      used[v] = (used[v] ?? 0) + 1;
      picked.push(h);
    } else rest.push(h);
  }
  // Leftover room goes to own-repository knowledge only: broad scopes never exceed their share.
  for (const h of rest) {
    if (picked.length >= limit) break;
    if ((h.scopeVerdict ?? 'own_repo') === 'own_repo') picked.push(h);
  }
  const order = new Map(sorted.map((h, i) => [h, i]));
  return picked.sort((a, b) => order.get(a)! - order.get(b)!);
}
