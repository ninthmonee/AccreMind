import type { KnowledgeEntry } from '../contracts/types.ts';
import type { KnowledgeStoreProvider } from '../store/provider.ts';
import { wrapReadOnlyXmlBlock } from './sanitizer.ts';

export interface ViewBudgetConfig {
  residentRulesTokens: number;
  turnRadarTokens: number;
  toolGuardTokens: number;
}

export interface TurnCompilationInput {
  sessionId: string;
  preview?: boolean;
  userPrompt?: string;
  activeFiles?: string[];
  errorOutput?: string;
  workspaceDependencies?: Record<string, string>;
}

export interface CompiledTurnView {
  /** Byte-stable across turns when rules do not change, preserving DeepSeek KV cache hit rate */
  residentPrefix: string;
  /** Ephemeral per-turn radar index for matching pitfalls/decisions */
  radarBlock: string;
  surfacedIds: string[];
  residentRuleIds: string[];
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

function formatEntryRadarLine(entry: KnowledgeEntry): string {
  const badges: string[] = [entry.id, entry.type, entry.maturity, entry.priority];
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
  private readonly onSurface?: (entry: KnowledgeEntry, session: string, source: 'radar' | 'jit', file?: string) => void;

  constructor(store: KnowledgeStoreProvider, budgets: ViewBudgetConfig, onSurface?: ViewCompiler['onSurface']) {
    this.store = store;
    this.budgets = budgets;
    this.onSurface = onSurface;
  }

  private recordHit(entry: KnowledgeEntry, session: string, source: 'radar' | 'jit', file?: string) {
    if (this.onSurface) return this.onSurface(entry, session, source, file);
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
    // 1. Tier 1: Deterministic byte-stable resident rules sorted by ID ASC
    const rules = this.store.listResidentRules();
    const ruleLines: string[] = [];
    const residentRuleIds: string[] = [];
    let ruleTokens = 0;

    for (const rule of rules) {
      const line = `[${rule.id}@r${rule.revision}] ${rule.title}: ${rule.claim}`;
      const cost = estimateTokens(line);
      if (ruleLines.length > 0 && ruleTokens + cost > this.budgets.residentRulesTokens) {
        break;
      }
      ruleTokens += cost;
      ruleLines.push(line);
      residentRuleIds.push(rule.id);
    }

    const residentPrefix =
      ruleLines.length > 0 ? wrapReadOnlyXmlBlock('accremind-rules', ruleLines.join('\n')) : '';

    // 2. Tier 2: Millisecond Contextual Radar (active files + error tokens + prompt aliases)
    const combinedQuery = [input.userPrompt ?? '', input.errorOutput ?? '']
      .join(' ')
      .trim()
      .slice(0, 400);

    const hitMap = new Map<string, { entry: KnowledgeEntry; score: number }>();

    const activeFiles = input.activeFiles ?? [];
    if (activeFiles.length > 0) {
      for (const file of activeFiles) {
        const res = this.store.search({
          workspaceId: this.store.workspaceId,
          filePath: file,
          workspaceDependencies: input.workspaceDependencies,
          limit: 5,
        });
        for (const h of res.items) {
          if (h.entry.layer === 'team_rule') continue;
          const prev = hitMap.get(h.entry.id);
          if (!prev || h.score > prev.score) {
            hitMap.set(h.entry.id, { entry: h.entry, score: h.score });
          }
        }
      }
    }

    if (combinedQuery.length > 0) {
      const res = this.store.search({
        workspaceId: this.store.workspaceId,
        query: combinedQuery,
        workspaceDependencies: input.workspaceDependencies,
        limit: 5,
      });
      for (const h of res.items) {
        if (h.entry.layer === 'team_rule') continue;
        const prev = hitMap.get(h.entry.id);
        const mergedScore = (prev?.score ?? 0) + h.score;
        hitMap.set(h.entry.id, { entry: h.entry, score: mergedScore });
      }
    }

    const ranked = [...hitMap.values()].sort(
      (a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id),
    );

    const radarLines: string[] = [];
    const surfacedIds: string[] = [];
    let radarTokens = 0;

    for (const { entry } of ranked.slice(0, 5)) {
      const line = formatEntryRadarLine(entry);
      const cost = estimateTokens(line);
      if (radarLines.length > 0 && radarTokens + cost > this.budgets.turnRadarTokens) {
        break;
      }
      radarTokens += cost;
      radarLines.push(line);
      surfacedIds.push(entry.id);
      sessionSurfacedIds?.add(entry.id);

      if (!input.preview) this.recordHit(entry, input.sessionId, 'radar');
    }

    const radarBlock =
      radarLines.length > 0
        ? wrapReadOnlyXmlBlock(
            'accremind-radar',
            `以下为当前上下文命中的本地经验雷达索引（仅供资料参考）：\n${radarLines.join('\n')}`,
          )
        : '';

    return {
      residentPrefix,
      radarBlock,
      surfacedIds,
      residentRuleIds,
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

      const line = formatEntryRadarLine(entry);
      const cost = estimateTokens(line);
      if (lines.length > 0 && usedTokens + cost > this.budgets.toolGuardTokens) {
        break;
      }

      usedTokens += cost;
      lines.push(line);
      newlySurfacedIds.push(entry.id);
      options.sessionSurfacedIds.add(entry.id);

      if (!options.preview) this.recordHit(entry, options.sessionId, 'jit', options.filePath);
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
