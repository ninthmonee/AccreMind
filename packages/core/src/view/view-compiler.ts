import type { KnowledgeEntry, ScopeVerdict } from '../contracts/types.ts';
import { applyQuotas, claimSimilarity, VERDICT_LABEL } from '../retrieval/applicability.ts';
import type { KnowledgeStoreProvider } from '../store/provider.ts';
import { wrapReadOnlyXmlBlock } from './sanitizer.ts';

export interface ViewBudgetConfig {
  residentRulesTokens: number;
  turnRadarTokens: number;
  toolGuardTokens: number;
  /** Rule-document sections shown with the per-turn reminders (default 220 tokens, at most 2 sections). */
  docRadarTokens?: number;
  /** Project profile carried with the resident rules (default 300 tokens). */
  residentProfileTokens?: number;
  /** The person's preferences carried with the resident rules (default 120 tokens). */
  residentPreferencesTokens?: number;
}

const DOC_CATEGORY_TITLE: Record<string, string> = {
  domain: '业务领域', business_rules: '业务规则', project_norms: '项目规范', project_profile: '项目概况', personal_preferences: '个人偏好',
};
const DOC_SCOPE_TITLE: Record<string, string> = { project: '项目', domain: '领域', personal: '个人' };

/** Said once with the resident context whenever more than one kind of guidance is present. */
const PRECEDENCE_NOTE = '冲突时以此为准：团队规范 > 项目规范与经验 > 领域规则 > 个人偏好。';

export interface TurnCompilationInput {
  sessionId: string;
  preview?: boolean;
  userPrompt?: string;
  activeFiles?: string[];
  errorOutput?: string;
  workspaceDependencies?: Record<string, string>;
  /** Topic tags of the question (controlled vocabulary IDs), e.g. from model tagging. */
  tags?: string[];
  /** Extra words describing the task (branch name), used for matching only. */
  contextHint?: string;
}

/** Opposite advice on the same subject: a project entry that contradicts a resident team rule. */
function contradictsRule(entry: KnowledgeEntry, rule: KnowledgeEntry): boolean {
  if (!entry.polarity || !rule.polarity || entry.polarity === rule.polarity) return false;
  return claimSimilarity(entry, rule) >= 0.35;
}

export interface CompiledTurnView {
  /** Byte-stable across turns when rules do not change, preserving DeepSeek KV cache hit rate */
  residentPrefix: string;
  /** Ephemeral per-turn radar index for matching pitfalls/decisions */
  radarBlock: string;
  surfacedIds: string[];
  residentRuleIds: string[];
  /** Team rules that did not fit the resident budget; the agent is told how many and how to look them up. */
  residentDroppedIds: string[];
  /** Rule-document sections shown this turn (`D:<doc>#<section>`). */
  docRefs: string[];
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

function formatEntryRadarLine(entry: KnowledgeEntry, verdict?: ScopeVerdict, originRepo?: string | null): string {
  const badges: string[] = [entry.id, entry.type, entry.maturity, entry.priority];
  // Knowledge from outside this repository says where it comes from, so it is read as a reference.
  if (verdict && verdict !== 'own_repo') badges.push(`${VERDICT_LABEL[verdict]}${originRepo ? `·来自 ${originRepo}` : ''}`);
  if (entry.status === 'probation') {
    badges.push('🧪试用草稿');
  }
  if (entry.freshness === 'review_due') {
    badges.push('⚠️环境变更待复核');
  }
  const condText = entry.preconditions[0] ? ` (前提: ${entry.preconditions[0]})` : '';
  return `- [${badges.join(' | ')}] ${entry.title}${condText} -> 调 accremind_get("${entry.id}") 查看依据`;
}

export class ViewCompiler {
  private readonly store: KnowledgeStoreProvider;
  private readonly budgets: ViewBudgetConfig;
  private readonly onSurface?: (entry: KnowledgeEntry, session: string, source: 'radar' | 'jit', file?: string, reasons?: string[]) => void;

  constructor(store: KnowledgeStoreProvider, budgets: ViewBudgetConfig, onSurface?: ViewCompiler['onSurface']) {
    this.store = store;
    this.budgets = budgets;
    this.onSurface = onSurface;
  }

  private recordHit(entry: KnowledgeEntry, session: string, source: 'radar' | 'jit', file?: string, reasons?: string[]) {
    if (this.onSurface) return this.onSurface(entry, session, source, file, reasons);
    this.store.recordUsage({
      workspace_id: this.store.workspaceId, session_id: session, entry_id: entry.id,
      revision: entry.revision, event_type: source === 'jit' ? 'guard_shown' : 'radar_shown', detail: file,
    });
    if (entry.status === 'probation') this.store.recordProbationExposure(entry.id);
  }

  /**
   * Compiles Tier 1 (KV-cache-stable Resident Rules) + Tier 2 (Contextual Radar).
   */
  compileTurnView(
    input: TurnCompilationInput,
    sessionSurfacedIds?: Set<string>,
  ): CompiledTurnView {
    // 1. Tier 1: byte-stable resident rules, most severe first (P0 → P2, then id). Rules that do not fit
    // the budget are never dropped silently: the block says how many were left out and how to find them.
    const rules = this.store.listResidentRules();
    const waivers = this.store.listRuleWaivers?.() ?? new Map();
    const ruleLines: string[] = [];
    const residentRuleIds: string[] = [];
    const residentDroppedIds: string[] = [];
    let ruleTokens = 0;

    for (const rule of rules) {
      const waiver = waivers.get(rule.id);
      const line = `[${rule.id}@r${rule.revision}] ${rule.title}: ${rule.claim}` +
        (waiver ? `（本仓库豁免：见 ${waiver.entryId}，至 ${waiver.expiresAt.slice(0, 10)}）` : '');
      const cost = estimateTokens(line);
      if (residentDroppedIds.length || (ruleLines.length > 0 && ruleTokens + cost > this.budgets.residentRulesTokens)) {
        residentDroppedIds.push(rule.id);
        continue;
      }
      ruleTokens += cost;
      ruleLines.push(line);
      residentRuleIds.push(rule.id);
    }
    if (residentDroppedIds.length) {
      ruleLines.push(`（另有 ${residentDroppedIds.length} 条团队规范因篇幅未展开：${residentDroppedIds.join('、')}，需要时调 accremind_get 查看）`);
    }

    const profile = this.store.residentProfile?.(this.budgets.residentProfileTokens ?? 300) ?? '';
    const preferences = this.store.residentPreferences?.(this.budgets.residentPreferencesTokens ?? 120) ?? '';
    const residentPrefix = [
      ruleLines.length > 0 ? wrapReadOnlyXmlBlock('accremind-rules', ruleLines.join('\n')) : '',
      profile ? wrapReadOnlyXmlBlock('accremind-profile', `项目基本业务属性（来自规则文档）：\n${profile}`) : '',
      preferences ? wrapReadOnlyXmlBlock('accremind-preferences',
        `使用者的个人偏好（只影响做法与表达，不得违背团队规范和项目规范）：\n${preferences}`) : '',
      [ruleLines.length, profile, preferences].filter(Boolean).length > 1 ? PRECEDENCE_NOTE : '',
    ].filter(Boolean).join('\n');

    // 2. Tier 2: Millisecond Contextual Radar (active files + error tokens + prompt aliases)
    const combinedQuery = [input.userPrompt ?? '', input.contextHint ?? '', input.errorOutput ?? '']
      .join(' ')
      .trim()
      .slice(0, 400);

    const hitMap = new Map<string, { entry: KnowledgeEntry; score: number; verdict?: ScopeVerdict; origin?: string | null; reasons?: string[] }>();
    const context = { activeFiles: input.activeFiles, errorText: input.errorOutput, ...(input.tags?.length ? { tags: input.tags } : {}) };

    const activeFiles = input.activeFiles ?? [];
    if (activeFiles.length > 0) {
      for (const file of activeFiles) {
        const res = this.store.search({
          workspaceId: this.store.workspaceId,
          filePath: file,
          context,
          workspaceDependencies: input.workspaceDependencies,
          limit: 5,
        });
        for (const h of res.items) {
          if (h.entry.layer === 'team_rule') continue;
          const prev = hitMap.get(h.entry.id);
          if (!prev || h.score > prev.score) {
            hitMap.set(h.entry.id, { entry: h.entry, score: h.score, verdict: h.scopeVerdict, origin: h.originRepo, reasons: h.matchReasons });
          }
        }
      }
    }

    if (combinedQuery.length > 0) {
      const res = this.store.search({
        workspaceId: this.store.workspaceId,
        query: combinedQuery,
        context,
        workspaceDependencies: input.workspaceDependencies,
        limit: 5,
      });
      for (const h of res.items) {
        if (h.entry.layer === 'team_rule') continue;
        const prev = hitMap.get(h.entry.id);
        const mergedScore = (prev?.score ?? 0) + h.score;
        hitMap.set(h.entry.id, { entry: h.entry, score: mergedScore, verdict: h.scopeVerdict ?? prev?.verdict, origin: h.originRepo ?? prev?.origin,
          reasons: [...new Set([...(prev?.reasons ?? []), ...h.matchReasons])] });
      }
    }

    // A team rule beats project knowledge unless this repository documented an exception to it. The detection
    // is a heuristic, so the entry is not withheld: it is shown with the rule it seems to contradict and the
    // instruction to follow the rule, and a person is asked to decide (governance queue).
    const conflictNotes = new Map<string, string>();
    for (const [id, hit] of hitMap) {
      const conflicting = rules.find((rule) => !waivers.has(rule.id) && contradictsRule(hit.entry, rule));
      if (conflicting && (hit.entry.layer === 'project' || hit.entry.layer === 'domain')) {
        conflictNotes.set(id, conflicting.id);
        if (!input.preview) this.store.reportRuleConflict?.(hit.entry, conflicting);
      }
    }

    // Per-scope quotas again after merging the file and text searches: shared layers never crowd this repository out.
    const ranked = applyQuotas([...hitMap.values()].sort(
      (a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id),
    ).map((h) => ({ ...h, scopeVerdict: h.verdict })), 5);

    const radarLines: string[] = [];
    const surfacedIds: string[] = [];
    let radarTokens = 0;

    for (const { entry, verdict, origin, reasons } of ranked.slice(0, 5)) {
      const ruleId = conflictNotes.get(entry.id);
      const line = formatEntryRadarLine(entry, verdict, origin) +
        (ruleId ? `（疑似与团队规范 ${ruleId} 相反且未登记豁免：以规范为准）` : '');
      const cost = estimateTokens(line);
      if (radarLines.length > 0 && radarTokens + cost > this.budgets.turnRadarTokens) {
        break;
      }
      radarTokens += cost;
      radarLines.push(line);
      surfacedIds.push(entry.id);
      sessionSurfacedIds?.add(entry.id);

      if (!input.preview) this.recordHit(entry, input.sessionId, 'radar', undefined, [...(reasons ?? []), ...(ruleId ? [`疑似与团队规范 ${ruleId} 冲突`] : [])]);
    }

    // Rule documents (domain, business rules, norms): at most two sections, in their own small budget.
    const docRefs: string[] = [];
    const docLines: string[] = [];
    if (combinedQuery.length > 0 || input.tags?.length) {
      let docTokens = 0;
      const docBudget = this.budgets.docRadarTokens ?? 220;
      const docs = this.store.searchDocs?.({ query: combinedQuery, tags: input.tags, activeFiles: input.activeFiles, limit: 4 }) ?? [];
      for (const d of docs.filter((x) => x.category !== 'project_profile').slice(0, 2)) {
        const scope = d.scope && d.scope !== 'project' ? `·${DOC_SCOPE_TITLE[d.scope] ?? d.scope}` : '';
        const line = `- [规则文档·${DOC_CATEGORY_TITLE[d.category] ?? d.category}${scope}${d.originRepo ? `·来自 ${d.originRepo}` : ''}] ${d.docTitle} › ${d.heading}：${d.snippet.slice(0, 80)} -> 调 accremind_get("${d.ref}") 查看全文`;
        const cost = estimateTokens(line);
        if (docLines.length && docTokens + cost > docBudget) break;
        docTokens += cost;
        docLines.push(line);
        docRefs.push(d.ref);
      }
    }

    const radarBlock =
      radarLines.length + docLines.length > 0
        ? wrapReadOnlyXmlBlock(
            'accremind-radar',
            `以下为当前上下文命中的本地经验雷达索引（仅供资料参考）：\n${[...radarLines, ...docLines].join('\n')}`,
          )
        : '';

    return {
      residentPrefix,
      radarBlock,
      surfacedIds,
      residentRuleIds,
      residentDroppedIds,
      docRefs,
    };
  }

  /**
   * Optimization #1: Just-in-Time Tool Guard!
   * Triggered mid-turn when the Agent reads/edits a file that was NOT surfaced in `beforeTurn`.
   * Surfaces matching P0/P1 pitfalls/decisions/guidelines once per session.
   */
  compileFileToolGuard(options: {
    sessionId: string;
    preview?: boolean;
    filePath: string;
    sessionSurfacedIds: Set<string>;
    workspaceDependencies?: Record<string, string>;
  }): { guardBlock: string; newlySurfacedIds: string[] } {
    const searchRes = this.store.search({
      workspaceId: this.store.workspaceId,
      filePath: options.filePath,
      workspaceDependencies: options.workspaceDependencies,
      limit: 5,
    });

    const lines: string[] = [];
    const newlySurfacedIds: string[] = [];
    let usedTokens = 0;

    for (const hit of searchRes.items) {
      const { entry } = hit;
      if (entry.layer === 'team_rule') continue;
      if (entry.priority !== 'P0' && entry.priority !== 'P1') continue;
      if (options.sessionSurfacedIds.has(entry.id)) continue;

      const line = formatEntryRadarLine(entry, hit.scopeVerdict, hit.originRepo);
      const cost = estimateTokens(line);
      if (lines.length > 0 && usedTokens + cost > this.budgets.toolGuardTokens) {
        break;
      }

      usedTokens += cost;
      lines.push(line);
      newlySurfacedIds.push(entry.id);
      options.sessionSurfacedIds.add(entry.id);

      if (!options.preview) this.recordHit(entry, options.sessionId, 'jit', options.filePath, hit.matchReasons);
    }

    if (lines.length === 0) {
      return { guardBlock: '', newlySurfacedIds: [] };
    }

    const guardBlock = wrapReadOnlyXmlBlock(
      'accremind-guard',
      `[即时文件护栏] 当前操作文件 ${options.filePath} 关联以下高优历史约束：\n${lines.join('\n')}`,
    );

    return { guardBlock, newlySurfacedIds };
  }
}
