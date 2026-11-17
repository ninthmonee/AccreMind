import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  directoryForZone,
  ensureStoreDirectoriesSync,
  resolveStorePaths,
  sha256Hex,
  writeFileAtomicSync,
  type StoreLayoutPaths,
} from '../codec/atomic-fs.ts';
import {
  MergeConflictError,
  parseEntryMarkdown,
  serializeEntryMarkdown,
} from '../codec/frontmatter.ts';
import type {
  CaptureAssessment,
  CorruptedFileRecord,
  KnowledgeEntry,
  NavigationItem,
  SearchHit,
  SearchQuery,
  SearchResult,
  StorageZone,
  UsageEvent,
  ValidationRecord,
} from '../contracts/types.ts';
import { enforceHardPublishGate, validateCaptureAssessment } from '../contracts/validator.ts';
import type { GetEntryOutcome, KnowledgeStoreProvider } from './provider.ts';
import { ACCREMIND_SQLITE_DDL, satisfiesSemverRange } from './sqlite-schema.ts';

export const GLOBAL_WORKSPACE_ID = '__global__';

export interface LocalStoreOptions {
  projectRoot: string;
  globalDir?: string;
  projectDirName?: string;
  workspaceId?: string;
  maxProbationExposures?: number;
}

interface EntryRow {
  id: string;
  workspace_id: string;
  revision: number;
  storage_zone: StorageZone;
  file_path: string;
  content_sha256: string;
  type: KnowledgeEntry['type'];
  polarity: 'recommend' | 'avoid' | null;
  knowledge_role: KnowledgeEntry['knowledge_role'];
  layer: KnowledgeEntry['layer'];
  title: string;
  search_aliases_json: string;
  claim: string;
  knowledge_delta: string;
  rationale: string;
  preconditions_json: string;
  exclusions_json: string;
  dependency_constraints_json: string;
  watch_paths_json: string;
  symbol_anchors_json: string;
  invalidation_triggers_json: string;
  verification_method: string;
  alternatives_json: string;
  evidence_json: string;
  enforcement_json: string;
  status: KnowledgeEntry['status'];
  maturity: KnowledgeEntry['maturity'];
  freshness: KnowledgeEntry['freshness'];
  serving: KnowledgeEntry['serving'];
  priority: KnowledgeEntry['priority'];
  probation_exposures: number;
  capture_assessment_id: string | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  review_due_at: string;
}

function rowToEntry(row: EntryRow): KnowledgeEntry {
  return {
    id: row.id,
    revision: row.revision,
    type: row.type,
    ...(row.polarity ? { polarity: row.polarity } : {}),
    knowledge_role: row.knowledge_role,
    layer: row.layer,
    title: row.title,
    search_aliases: JSON.parse(row.search_aliases_json) as string[],
    claim: row.claim,
    knowledge_delta: row.knowledge_delta,
    rationale: row.rationale,
    preconditions: JSON.parse(row.preconditions_json) as string[],
    exclusions: JSON.parse(row.exclusions_json) as string[],
    dependency_constraints: JSON.parse(
      row.dependency_constraints_json,
    ) as KnowledgeEntry['dependency_constraints'],
    watch_paths: JSON.parse(row.watch_paths_json) as string[],
    symbol_anchors: JSON.parse(row.symbol_anchors_json) as KnowledgeEntry['symbol_anchors'],
    invalidation_triggers: JSON.parse(row.invalidation_triggers_json) as string[],
    verification_method: row.verification_method,
    alternatives: JSON.parse(row.alternatives_json) as KnowledgeEntry['alternatives'],
    evidence: JSON.parse(row.evidence_json) as KnowledgeEntry['evidence'],
    enforcement: JSON.parse(row.enforcement_json) as KnowledgeEntry['enforcement'],
    status: row.status,
    maturity: row.maturity,
    freshness: row.freshness,
    serving: row.serving,
    priority: row.priority,
    capture_assessment_id: row.capture_assessment_id,
    supersedes: row.supersedes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_validated_at: row.last_validated_at,
    review_due_at: row.review_due_at,
  };
}

function extractSearchTokens(rawQuery: string): { ftsTerms: string[]; shortTerms: string[] } {
  const ftsSet = new Set<string>();
  const shortSet = new Set<string>();

  // 1. Extract ASCII / code identifier tokens (e.g. `idempotency_key`, `afterCommit`, `pg`)
  const asciiMatches = rawQuery.match(/[A-Za-z0-9_.-]{2,}/g) ?? [];
  for (const word of asciiMatches) {
    if (word.length >= 3) {
      ftsSet.add(word);
    } else {
      shortSet.add(word);
    }
  }

  // 2. Extract CJK contiguous segments and generate sliding 3-grams (for FTS5 trigram) + 2-grams
  const cjkSegments = rawQuery.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const seg of cjkSegments) {
    if (seg.length === 2) {
      shortSet.add(seg);
      continue;
    }
    if (seg.length <= 4) {
      ftsSet.add(seg);
    }
    for (let i = 0; i <= seg.length - 3; i += 1) {
      ftsSet.add(seg.slice(i, i + 3));
    }
    for (let i = 0; i <= seg.length - 2; i += 1) {
      shortSet.add(seg.slice(i, i + 2));
    }
  }

  return {
    ftsTerms: [...ftsSet].slice(0, 24),
    shortTerms: [...shortSet].slice(0, 24),
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

export class LocalMarkdownSqliteStore implements KnowledgeStoreProvider {
  readonly paths: StoreLayoutPaths;
  readonly workspaceId: string;
  readonly maxProbationExposures: number;
  private db: DatabaseSync;

  constructor(options: LocalStoreOptions) {
    this.paths = resolveStorePaths(options);
    this.workspaceId = this.paths.workspaceId;
    this.maxProbationExposures = options.maxProbationExposures ?? 3;
    ensureStoreDirectoriesSync(this.paths);
    this.db = this.openDatabaseWithSelfHeal();
  }

  private openDatabaseWithSelfHeal(): DatabaseSync {
    try {
      const db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      return db;
    } catch {
      if (fs.existsSync(this.paths.sqlitePath)) {
        const backupPath = `${this.paths.sqlitePath}.corrupt.${Date.now()}.bak`;
        fs.renameSync(this.paths.sqlitePath, backupPath);
      }
      const db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      return db;
    }
  }

  get rawDb(): DatabaseSync {
    return this.db;
  }

  private ownerWorkspaceForZone(zone: StorageZone): string {
    return zone === 'personal' || zone === 'shared_tech' ? GLOBAL_WORKSPACE_ID : this.workspaceId;
  }

  initializeAndReconcile(): { syncedCount: number; corruptedCount: number } {
    ensureStoreDirectoriesSync(this.paths);
    const zoneScans: Array<{ zone: StorageZone; dir: string; wsId: string }> = [
      { zone: 'rules', dir: this.paths.projectRulesDir, wsId: this.workspaceId },
      { zone: 'project', dir: this.paths.projectEntriesDir, wsId: this.workspaceId },
      { zone: 'probation', dir: this.paths.probationDir, wsId: this.workspaceId },
      { zone: 'personal', dir: this.paths.personalDir, wsId: GLOBAL_WORKSPACE_ID },
      { zone: 'shared_tech', dir: this.paths.sharedTechDir, wsId: GLOBAL_WORKSPACE_ID },
    ];

    let syncedCount = 0;
    let corruptedCount = 0;
    const seenKeys = new Set<string>();

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM corrupted_files WHERE workspace_id IN (?, ?)')
        .run(this.workspaceId, GLOBAL_WORKSPACE_ID);

      for (const { zone, dir, wsId } of zoneScans) {
        if (!fs.existsSync(dir)) continue;
        const files = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
          .sort();

        for (const fileName of files) {
          const fullPath = path.join(dir, fileName);
          const rawMd = fs.readFileSync(fullPath, 'utf8');
          const contentHash = sha256Hex(rawMd);

          try {
            const parsed = parseEntryMarkdown(rawMd, fullPath);
            seenKeys.add(`${wsId}::${parsed.id}`);

            const existing = this.db
              .prepare(
                'SELECT content_sha256, probation_exposures FROM entries WHERE workspace_id = ? AND id = ?',
              )
              .get(wsId, parsed.id) as
              | { content_sha256: string; probation_exposures: number }
              | undefined;

            if (!existing || existing.content_sha256 !== contentHash) {
              this.indexEntryRow(
                wsId,
                zone,
                fullPath,
                contentHash,
                parsed,
                existing?.probation_exposures ?? 0,
              );
            }
            syncedCount += 1;
          } catch (err) {
            corruptedCount += 1;
            const reason =
              err instanceof MergeConflictError
                ? `Git 合并冲突未解决: ${err.message}`
                : err instanceof Error
                  ? err.message
                  : String(err);
            this.db
              .prepare(
                'INSERT OR REPLACE INTO corrupted_files (file_path, workspace_id, reason, detected_at) VALUES (?, ?, ?, ?)',
              )
              .run(fullPath, wsId, reason, new Date().toISOString());
          }
        }
      }

      // Prune stale rows whose Markdown files were removed on disk
      const existingRows = this.db
        .prepare('SELECT workspace_id, id FROM entries WHERE workspace_id IN (?, ?)')
        .all(this.workspaceId, GLOBAL_WORKSPACE_ID) as Array<{ workspace_id: string; id: string }>;

      for (const r of existingRows) {
        if (!seenKeys.has(`${r.workspace_id}::${r.id}`)) {
          this.deleteIndexedEntry(r.workspace_id, r.id);
        }
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { syncedCount, corruptedCount };
  }

  rebuildIndexFromScratch(): { syncedCount: number; corruptedCount: number } {
    if (!fs.existsSync(this.paths.sqlitePath)) {
      try {
        this.db.close();
      } catch {
        // ignore close on unlinked db
      }
      this.db = this.openDatabaseWithSelfHeal();
    } else {
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM entry_symbol_anchors;');
        this.db.exec('DELETE FROM entries_fts;');
        this.db.exec('DELETE FROM entries;');
        this.db.exec('DELETE FROM corrupted_files;');
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return this.initializeAndReconcile();
  }

  private deleteIndexedEntry(wsId: string, id: string): void {
    this.db.prepare('DELETE FROM entries WHERE workspace_id = ? AND id = ?').run(wsId, id);
    this.db.prepare('DELETE FROM entries_fts WHERE workspace_id = ? AND id = ?').run(wsId, id);
  }

  private indexEntryRow(
    wsId: string,
    zone: StorageZone,
    filePath: string,
    contentHash: string,
    entry: KnowledgeEntry,
    probationExposures: number,
  ): void {
    this.db
      .prepare('DELETE FROM entries_fts WHERE workspace_id = ? AND id = ?')
      .run(wsId, entry.id);
    this.db
      .prepare('DELETE FROM entry_symbol_anchors WHERE workspace_id = ? AND entry_id = ?')
      .run(wsId, entry.id);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO entries (
          id, workspace_id, revision, storage_zone, file_path, content_sha256,
          type, polarity, knowledge_role, layer, title, search_aliases_json,
          claim, knowledge_delta, rationale, preconditions_json, exclusions_json,
          dependency_constraints_json, watch_paths_json, symbol_anchors_json,
          invalidation_triggers_json, verification_method, alternatives_json,
          evidence_json, enforcement_json, status, maturity, freshness, serving,
          priority, probation_exposures, capture_assessment_id, supersedes,
          created_at, updated_at, last_validated_at, review_due_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )`,
      )
      .run(
        entry.id,
        wsId,
        entry.revision,
        zone,
        filePath,
        contentHash,
        entry.type,
        entry.polarity ?? null,
        entry.knowledge_role,
        entry.layer,
        entry.title,
        JSON.stringify(entry.search_aliases),
        entry.claim,
        entry.knowledge_delta,
        entry.rationale,
        JSON.stringify(entry.preconditions),
        JSON.stringify(entry.exclusions),
        JSON.stringify(entry.dependency_constraints),
        JSON.stringify(entry.watch_paths),
        JSON.stringify(entry.symbol_anchors),
        JSON.stringify(entry.invalidation_triggers),
        entry.verification_method,
        JSON.stringify(entry.alternatives),
        JSON.stringify(entry.evidence),
        JSON.stringify(entry.enforcement),
        entry.status,
        entry.maturity,
        entry.freshness,
        entry.serving,
        entry.priority,
        probationExposures,
        entry.capture_assessment_id,
        entry.supersedes,
        entry.created_at,
        entry.updated_at,
        entry.last_validated_at,
        entry.review_due_at,
      );

    this.db
      .prepare(
        `INSERT INTO entries_fts (
          workspace_id, id, title, aliases_text, claim, knowledge_delta, rationale, watch_paths_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wsId,
        entry.id,
        entry.title,
        entry.search_aliases.join(' '),
        entry.claim,
        entry.knowledge_delta,
        entry.rationale,
        entry.watch_paths.join(' '),
      );

    const anchorStmt = this.db.prepare(
      `INSERT OR REPLACE INTO entry_symbol_anchors (
        workspace_id, entry_id, file_path, symbol_name, normalized_sha256, start_line, end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const anchor of entry.symbol_anchors) {
      anchorStmt.run(
        wsId,
        entry.id,
        anchor.file_path,
        anchor.symbol_name,
        anchor.normalized_sha256,
        anchor.start_line,
        anchor.end_line,
      );
    }
  }

  upsertEntry(
    entry: KnowledgeEntry,
    zone: StorageZone,
    assessment: CaptureAssessment | null,
  ): KnowledgeEntry {
    const resolvedAssessment =
      assessment ??
      (entry.capture_assessment_id ? this.getAssessment(entry.capture_assessment_id) : null);

    if (entry.status === 'active' || entry.status === 'probation') {
      const gate = enforceHardPublishGate(entry, resolvedAssessment);
      if (!gate.ok) {
        throw new Error(`S03 硬发布门禁拦截 (${entry.id}): ${gate.missingFields.join('; ')}`);
      }
    }

    const wsId = this.ownerWorkspaceForZone(zone);
    const targetDir = directoryForZone(this.paths, zone);
    const filePath = path.join(targetDir, `${entry.id}.md`);
    const markdown = serializeEntryMarkdown(entry);
    const contentHash = sha256Hex(markdown);

    // Consistency rule (ADR-02): write immutable/atomic Markdown SoT first, then activate SQLite tx
    writeFileAtomicSync(filePath, markdown);

    const existing = this.db
      .prepare('SELECT probation_exposures FROM entries WHERE workspace_id = ? AND id = ?')
      .get(wsId, entry.id) as { probation_exposures: number } | undefined;

    this.db.exec('BEGIN');
    try {
      if (resolvedAssessment) {
        this.recordAssessmentInTx(resolvedAssessment, entry);
      }
      this.indexEntryRow(
        wsId,
        zone,
        filePath,
        contentHash,
        entry,
        existing?.probation_exposures ?? 0,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return entry;
  }

  /**
   * Internal mutation helper used by governance / validation state transitions
   * when updating metadata of an already-existing persisted entry.
   */
  updateExistingEntryDirect(entry: KnowledgeEntry): KnowledgeEntry {
    const row = this.findRawEntryRow(entry.id);
    if (!row) {
      throw new Error(`未找到条目: ${entry.id}`);
    }
    const markdown = serializeEntryMarkdown(entry);
    const contentHash = sha256Hex(markdown);
    writeFileAtomicSync(row.file_path, markdown);

    this.db.exec('BEGIN');
    try {
      this.indexEntryRow(
        row.workspace_id,
        row.storage_zone,
        row.file_path,
        contentHash,
        entry,
        row.probation_exposures,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return entry;
  }

  private findRawEntryRow(id: string): EntryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM entries
         WHERE id = ? AND workspace_id IN (?, ?)
         ORDER BY CASE WHEN workspace_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(id, this.workspaceId, GLOBAL_WORKSPACE_ID, this.workspaceId) as EntryRow | undefined;
  }

  getEntry(
    id: string,
    options: {
      sessionId?: string;
      recordUsage?: boolean;
      includeHistoryOrSuspended?: boolean;
    } = {},
  ): GetEntryOutcome {
    const row = this.findRawEntryRow(id);
    if (!row) return { found: false };

    const entry = rowToEntry(row);

    if (!options.includeHistoryOrSuspended) {
      if (entry.status === 'withdrawn') {
        return { found: true, servable: false, reason: 'withdrawn', supersedes: entry.supersedes };
      }
      if (entry.status === 'archived') {
        return { found: true, servable: false, reason: 'archived', supersedes: entry.supersedes };
      }
      if (entry.serving === 'suspended') {
        return { found: true, servable: false, reason: 'suspended', supersedes: entry.supersedes };
      }
    }

    if (options.recordUsage !== false) {
      this.recordUsage({
        workspace_id: row.workspace_id,
        session_id: options.sessionId ?? 'local-session',
        entry_id: entry.id,
        revision: entry.revision,
        event_type: 'retrieved',
      });
    }

    return { found: true, servable: true, entry, storageZone: row.storage_zone };
  }

  listResidentRules(): KnowledgeEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE workspace_id = ?
           AND (layer = 'team_rule' OR storage_zone = 'rules')
           AND status = 'active'
           AND serving = 'enabled'
           AND freshness != 'stale'
         ORDER BY id ASC`,
      )
      .all(this.workspaceId) as unknown as EntryRow[];

    return rows.map(rowToEntry);
  }

  search(params: SearchQuery): SearchResult {
    const wsId = params.workspaceId || this.workspaceId;
    const includeProbation = params.includeProbation ?? true;
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    const tokenBudget = params.tokenBudget ?? 4000;

    const rawTextQuery = params.query?.trim() ?? '';
    const ftsScores = new Map<string, number>();

    if (rawTextQuery.length > 0) {
      const { ftsTerms, shortTerms } = extractSearchTokens(rawTextQuery);

      if (ftsTerms.length > 0) {
        const matchExpr = ftsTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        const ftsRows = this.db
          .prepare(
            `SELECT workspace_id, id, bm25(entries_fts, 0.0, 0.0, 8.0, 10.0, 4.0, 3.0, 2.0, 1.0) AS rank_score
             FROM entries_fts
             WHERE entries_fts MATCH ?
               AND workspace_id IN (?, ?)`,
          )
          .all(matchExpr, wsId, GLOBAL_WORKSPACE_ID) as Array<{
          workspace_id: string;
          id: string;
          rank_score: number;
        }>;

        for (const r of ftsRows) {
          const key = `${r.workspace_id}::${r.id}`;
          const positiveScore = Math.max(0.5, -r.rank_score * 10);
          ftsScores.set(key, (ftsScores.get(key) ?? 0) + positiveScore);
        }
      }

      // Exact 2-char CJK bigram boost (e.g. "防重", "丢单", "幂等") where trigram needs >=3 chars
      for (const tok of shortTerms) {
        const likePattern = `%${tok}%`;
        const subRows = this.db
          .prepare(
            `SELECT workspace_id, id,
                    CASE
                      WHEN search_aliases_json LIKE ? THEN 6.0
                      WHEN title LIKE ? THEN 5.0
                      ELSE 2.0
                    END AS bonus
             FROM entries
             WHERE workspace_id IN (?, ?)
               AND (search_aliases_json LIKE ? OR title LIKE ? OR claim LIKE ? OR knowledge_delta LIKE ?)`,
          )
          .all(
            likePattern,
            likePattern,
            wsId,
            GLOBAL_WORKSPACE_ID,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
          ) as Array<{ workspace_id: string; id: string; bonus: number }>;

        for (const sr of subRows) {
          const key = `${sr.workspace_id}::${sr.id}`;
          ftsScores.set(key, (ftsScores.get(key) ?? 0) + sr.bonus);
        }
      }
    }

    const candidateRows = this.db
      .prepare(`SELECT * FROM entries WHERE workspace_id IN (?, ?)`)
      .all(wsId, GLOBAL_WORKSPACE_ID) as unknown as EntryRow[];

    let hadVersionExcluded = false;
    let hadSuspendedConflict = false;
    const scoredHits: SearchHit[] = [];

    for (const row of candidateRows) {
      const entry = rowToEntry(row);
      if (params.type && entry.type !== params.type) continue;
      if (params.layer && entry.layer !== params.layer) continue;

      const key = `${row.workspace_id}::${row.id}`;
      const textScore = ftsScores.get(key) ?? 0;

      let pathMatched = false;
      if (params.filePath) {
        const relTarget = params.filePath.replace(/\\/g, '/');
        pathMatched =
          entry.symbol_anchors.some((a) => a.file_path === relTarget) ||
          entry.watch_paths.some((glob) => path.matchesGlob(relTarget, glob));
      }

      if (rawTextQuery.length > 0 && textScore === 0 && !pathMatched) {
        continue;
      }
      if (!rawTextQuery && params.filePath && !pathMatched) {
        continue;
      }

      if (entry.serving === 'suspended') {
        hadSuspendedConflict = true;
        continue;
      }

      const allowedStatus =
        entry.status === 'active' || (includeProbation && entry.status === 'probation');
      if (!allowedStatus || entry.freshness === 'stale') {
        continue;
      }

      if (params.workspaceDependencies && entry.dependency_constraints.length > 0) {
        let versionCompatible = true;
        for (const dep of entry.dependency_constraints) {
          const installed = params.workspaceDependencies[dep.name];
          if (installed && !satisfiesSemverRange(installed, dep.range)) {
            versionCompatible = false;
            break;
          }
        }
        if (!versionCompatible) {
          hadVersionExcluded = true;
          continue;
        }
      }

      const matchReasons: string[] = [];
      let totalScore = textScore;
      if (pathMatched) {
        totalScore += 8.0;
        matchReasons.push(`匹配路径锚点: ${params.filePath}`);
      }
      if (textScore > 0) {
        matchReasons.push('命中关键词或双语检索别名');
      }
      if (row.workspace_id === wsId) {
        totalScore += 1.5;
      }
      if (entry.priority === 'P0') totalScore += 2.0;
      else if (entry.priority === 'P1') totalScore += 1.0;

      if (entry.maturity === 'proven') totalScore += 1.5;
      else if (entry.maturity === 'verified') totalScore += 0.8;

      // Probation items are weighted slightly lower than confirmed active entries
      if (entry.status === 'probation') {
        totalScore *= 0.75;
        matchReasons.push('影子试用草稿');
      }

      scoredHits.push({
        entry,
        storageZone: row.storage_zone,
        probationExposures: row.probation_exposures,
        score: Number(totalScore.toFixed(3)),
        matchReasons,
        truncated: false,
      });
    }

    scoredHits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

    const finalItems: SearchHit[] = [];
    let tokenUsed = 0;

    for (const hit of scoredHits.slice(0, limit)) {
      const cardSummaryText = `${hit.entry.id} ${hit.entry.title} ${hit.entry.claim} ${hit.entry.preconditions.join('; ')}`;
      const neededTokens = estimateTokens(cardSummaryText);
      if (finalItems.length > 0 && tokenUsed + neededTokens > tokenBudget) {
        break;
      }
      tokenUsed += neededTokens;
      finalItems.push(hit);
    }

    if (finalItems.length === 0) {
      const zeroReason = hadVersionExcluded
        ? 'version_excluded'
        : hadSuspendedConflict
          ? 'suspended_conflict'
          : 'no_applicable_entry';
      return { items: [], zeroReason, tokenUsed: 0 };
    }

    return { items: finalItems, zeroReason: 'none', tokenUsed };
  }

  private recordAssessmentInTx(
    assessment: CaptureAssessment,
    candidateDraft?: KnowledgeEntry | null,
  ): void {
    const issues = validateCaptureAssessment(assessment);
    if (issues.length > 0) {
      throw new Error(
        `CaptureAssessment 校验失败: ${issues.map((i) => `${i.field}:${i.message}`).join('; ')}`,
      );
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO capture_assessments (
          id, workspace_id, source_fingerprint, question, checked_context_json,
          discoverability, baseline_answer, knowledge_delta, claim_evidence_map_json,
          omission_consequence, priority, disposition, candidate_entry_json,
          review_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assessment.id,
        assessment.workspace_id,
        assessment.source_fingerprint,
        assessment.question,
        JSON.stringify(assessment.checked_context),
        assessment.discoverability,
        assessment.baseline_answer,
        assessment.knowledge_delta,
        JSON.stringify(assessment.claim_evidence_map),
        assessment.omission_consequence,
        assessment.priority,
        assessment.disposition,
        candidateDraft ? JSON.stringify(candidateDraft) : null,
        assessment.disposition === 'knowledge_candidate' ? 'pending' : 'decided',
        assessment.created_at,
      );
  }

  recordAssessment(assessment: CaptureAssessment, candidateDraft?: KnowledgeEntry | null): void {
    this.db.exec('BEGIN');
    try {
      this.recordAssessmentInTx(assessment, candidateDraft);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getAssessment(id: string): CaptureAssessment | null {
    const row = this.db.prepare('SELECT * FROM capture_assessments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAssessmentRow(row) : null;
  }

  findAssessmentByFingerprint(fingerprint: string): CaptureAssessment | null {
    const row = this.db
      .prepare('SELECT * FROM capture_assessments WHERE source_fingerprint = ?')
      .get(fingerprint) as Record<string, unknown> | undefined;
    return row ? this.mapAssessmentRow(row) : null;
  }

  private mapAssessmentRow(row: Record<string, unknown>): CaptureAssessment {
    return {
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      source_fingerprint: String(row.source_fingerprint),
      question: String(row.question),
      checked_context: JSON.parse(String(row.checked_context_json)),
      discoverability: row.discoverability as CaptureAssessment['discoverability'],
      baseline_answer: String(row.baseline_answer),
      knowledge_delta: String(row.knowledge_delta),
      claim_evidence_map: JSON.parse(String(row.claim_evidence_map_json)),
      omission_consequence: String(row.omission_consequence),
      priority: row.priority as CaptureAssessment['priority'],
      disposition: row.disposition as CaptureAssessment['disposition'],
      created_at: String(row.created_at),
    };
  }

  appendNavigationItem(item: NavigationItem): void {
    const current = this.listNavigationItems();
    const deduped = current.filter(
      (existing) => !(existing.kind === item.kind && existing.locator === item.locator),
    );
    deduped.push(item);
    writeFileAtomicSync(this.paths.navigationFilePath, `${JSON.stringify(deduped, null, 2)}\n`);
  }

  listNavigationItems(): NavigationItem[] {
    if (!fs.existsSync(this.paths.navigationFilePath)) return [];
    const content = fs.readFileSync(this.paths.navigationFilePath, 'utf8');
    return JSON.parse(content) as NavigationItem[];
  }

  recordUsage(event: Omit<UsageEvent, 'event_id' | 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (
          event_id, workspace_id, session_id, entry_id, revision, event_type, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `EVU-${randomUUID()}`,
        event.workspace_id,
        event.session_id,
        event.entry_id,
        event.revision,
        event.event_type,
        event.detail ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Independent task validation & circuit-breaker:
   * - `retrieved` / `cited` NEVER change maturity; ONLY independent `submitValidation` does.
   * - `failure` immediately suspends serving (`serving = 'suspended'`).
   * - `success` across >=1 independent task upgrades `draft -> verified`; >=2 independent tasks -> `proven`.
   *   If the entry was in `probation`, positive validation also promotes it directly to `active`!
   */
  submitValidation(input: {
    entryId: string;
    sessionId: string;
    taskFingerprint: string;
    outcome: 'success' | 'failure' | 'inconclusive';
    evidenceNote: string;
  }): { record: ValidationRecord; updatedEntry: KnowledgeEntry } {
    const row = this.findRawEntryRow(input.entryId);
    if (!row) {
      throw new Error(`验证目标条目不存在: ${input.entryId}`);
    }

    const entry = rowToEntry(row);
    const now = new Date().toISOString();
    const record: ValidationRecord = {
      id: `VAL-${randomUUID().slice(0, 8)}`,
      workspace_id: row.workspace_id,
      entry_id: entry.id,
      revision: entry.revision,
      session_id: input.sessionId,
      task_fingerprint: input.taskFingerprint,
      outcome: input.outcome,
      evidence_note: input.evidenceNote,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT OR IGNORE INTO validation_records (
          id, workspace_id, entry_id, revision, session_id, task_fingerprint, outcome, evidence_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.workspace_id,
        record.entry_id,
        record.revision,
        record.session_id,
        record.task_fingerprint,
        record.outcome,
        record.evidence_note,
        record.created_at,
      );

    if (input.outcome === 'failure') {
      const suspendedEntry: KnowledgeEntry = {
        ...entry,
        serving: 'suspended',
        updated_at: now,
      };
      return { record, updatedEntry: this.updateExistingEntryDirect(suspendedEntry) };
    }

    if (input.outcome === 'success') {
      const successCountRow = this.db
        .prepare(
          `SELECT COUNT(DISTINCT task_fingerprint) AS cnt
           FROM validation_records
           WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND outcome = 'success'`,
        )
        .get(row.workspace_id, entry.id, entry.revision) as { cnt: number };

      const independentSuccesses = Number(successCountRow.cnt ?? 0);
      const nextMaturity: KnowledgeEntry['maturity'] =
        independentSuccesses >= 2
          ? 'proven'
          : independentSuccesses >= 1
            ? 'verified'
            : entry.maturity;

      if (row.storage_zone === 'probation') {
        const promoted = this.promoteProbationToActive(entry.id, {
          maturity: nextMaturity,
          last_validated_at: now,
        });
        return { record, updatedEntry: promoted };
      }

      const verifiedEntry: KnowledgeEntry = {
        ...entry,
        maturity: nextMaturity,
        last_validated_at: now,
        updated_at: now,
      };
      return { record, updatedEntry: this.updateExistingEntryDirect(verifiedEntry) };
    }

    return { record, updatedEntry: entry };
  }

  recordProbationExposure(entryId: string): { autoArchived: boolean; exposures: number } {
    const row = this.findRawEntryRow(entryId);
    if (!row || row.status !== 'probation') {
      return { autoArchived: false, exposures: row?.probation_exposures ?? 0 };
    }

    const nextExposures = row.probation_exposures + 1;
    if (nextExposures >= this.maxProbationExposures) {
      const entry = rowToEntry(row);
      const archived: KnowledgeEntry = {
        ...entry,
        status: 'archived',
        serving: 'suspended',
        updated_at: new Date().toISOString(),
      };
      const md = serializeEntryMarkdown(archived);
      writeFileAtomicSync(row.file_path, md);
      this.db.exec('BEGIN');
      try {
        this.indexEntryRow(
          row.workspace_id,
          row.storage_zone,
          row.file_path,
          sha256Hex(md),
          archived,
          nextExposures,
        );
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      return { autoArchived: true, exposures: nextExposures };
    }

    this.db
      .prepare('UPDATE entries SET probation_exposures = ? WHERE workspace_id = ? AND id = ?')
      .run(nextExposures, row.workspace_id, row.id);
    return { autoArchived: false, exposures: nextExposures };
  }

  promoteProbationToActive(
    entryId: string,
    overrides: Partial<Pick<KnowledgeEntry, 'maturity' | 'last_validated_at'>> = {},
  ): KnowledgeEntry {
    const row = this.findRawEntryRow(entryId);
    if (!row) {
      throw new Error(`未找到待转正条目: ${entryId}`);
    }

    const current = rowToEntry(row);
    const now = new Date().toISOString();
    const targetZone: StorageZone =
      current.layer === 'shared_tech'
        ? 'shared_tech'
        : current.layer === 'personal'
          ? 'personal'
          : 'project';
    const targetWsId = this.ownerWorkspaceForZone(targetZone);
    const targetPath = path.join(directoryForZone(this.paths, targetZone), `${current.id}.md`);

    const promoted: KnowledgeEntry = {
      ...current,
      status: 'active',
      maturity: overrides.maturity ?? current.maturity,
      last_validated_at: overrides.last_validated_at ?? current.last_validated_at,
      updated_at: now,
    };

    const md = serializeEntryMarkdown(promoted);
    writeFileAtomicSync(targetPath, md);
    if (row.file_path !== targetPath && fs.existsSync(row.file_path)) {
      fs.unlinkSync(row.file_path);
    }

    this.db.exec('BEGIN');
    try {
      if (row.workspace_id !== targetWsId) {
        this.deleteIndexedEntry(row.workspace_id, current.id);
      }
      this.indexEntryRow(targetWsId, targetZone, targetPath, sha256Hex(md), promoted, 0);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return promoted;
  }

  dismissProbation(entryId: string): KnowledgeEntry {
    const row = this.findRawEntryRow(entryId);
    if (!row) {
      throw new Error(`未找到试用条目: ${entryId}`);
    }
    const entry = rowToEntry(row);
    const archived: KnowledgeEntry = {
      ...entry,
      status: 'archived',
      serving: 'suspended',
      updated_at: new Date().toISOString(),
    };
    return this.updateExistingEntryDirect(archived);
  }

  listCorruptedFiles(): CorruptedFileRecord[] {
    return this.db
      .prepare('SELECT * FROM corrupted_files WHERE workspace_id IN (?, ?) ORDER BY detected_at DESC')
      .all(this.workspaceId, GLOBAL_WORKSPACE_ID) as unknown as CorruptedFileRecord[];
  }

  listEntriesForAdmin(filter: {
    status?: KnowledgeEntry['status'];
    freshness?: KnowledgeEntry['freshness'];
    serving?: KnowledgeEntry['serving'];
    layer?: KnowledgeEntry['layer'];
    type?: KnowledgeEntry['type'];
    query?: string;
  } = {}): Array<{ entry: KnowledgeEntry; storageZone: StorageZone; probationExposures: number }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE workspace_id IN (?, ?)
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(this.workspaceId, GLOBAL_WORKSPACE_ID) as unknown as EntryRow[];

    const q = filter.query?.trim().toLowerCase() ?? '';
    const out: Array<{
      entry: KnowledgeEntry;
      storageZone: StorageZone;
      probationExposures: number;
    }> = [];

    for (const row of rows) {
      const entry = rowToEntry(row);
      if (filter.status && entry.status !== filter.status) continue;
      if (filter.freshness && entry.freshness !== filter.freshness) continue;
      if (filter.serving && entry.serving !== filter.serving) continue;
      if (filter.layer && entry.layer !== filter.layer) continue;
      if (filter.type && entry.type !== filter.type) continue;
      if (q) {
        const hay = [
          entry.id,
          entry.title,
          entry.claim,
          entry.knowledge_delta,
          entry.search_aliases.join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) continue;
      }
      out.push({
        entry,
        storageZone: row.storage_zone,
        probationExposures: row.probation_exposures,
      });
    }

    return out;
  }

  listAssessments(options: {
    reviewState?: 'pending' | 'decided' | 'all';
    limit?: number;
  } = {}): Array<{
    assessment: CaptureAssessment;
    reviewState: string;
    candidateDraft: KnowledgeEntry | null;
  }> {
    const state = options.reviewState ?? 'all';
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

    const rows =
      state === 'all'
        ? (this.db
            .prepare(
              `SELECT * FROM capture_assessments
               WHERE workspace_id = ?
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(this.workspaceId, limit) as Array<Record<string, unknown>>)
        : (this.db
            .prepare(
              `SELECT * FROM capture_assessments
               WHERE workspace_id = ? AND review_state = ?
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(this.workspaceId, state, limit) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      assessment: this.mapAssessmentRow(row),
      reviewState: String(row.review_state ?? 'pending'),
      candidateDraft: row.candidate_entry_json
        ? (JSON.parse(String(row.candidate_entry_json)) as KnowledgeEntry)
        : null,
    }));
  }

  decideAssessment(input: {
    assessmentId: string;
    decision: 'approve_active' | 'approve_probation' | 'index_only' | 'link_existing' | 'discard';
    editedEntry?: KnowledgeEntry;
  }): {
    ok: boolean;
    missingFields?: string[];
    persistedEntry?: KnowledgeEntry;
  } {
    const rawRow = this.db
      .prepare('SELECT * FROM capture_assessments WHERE id = ?')
      .get(input.assessmentId) as Record<string, unknown> | undefined;
    if (!rawRow) {
      throw new Error(`未找到判定记录: ${input.assessmentId}`);
    }

    const assessment = this.mapAssessmentRow(rawRow);
    const storedDraft = rawRow.candidate_entry_json
      ? (JSON.parse(String(rawRow.candidate_entry_json)) as KnowledgeEntry)
      : null;
    const now = new Date().toISOString();

    if (input.decision === 'discard') {
      this.db
        .prepare(
          `UPDATE capture_assessments
           SET disposition = 'discard', review_state = 'decided', decided_at = ?
           WHERE id = ?`,
        )
        .run(now, assessment.id);
      return { ok: true };
    }

    if (input.decision === 'index_only' || input.decision === 'link_existing') {
      const locator =
        assessment.checked_context.checked_files[0] ??
        assessment.checked_context.checked_docs[0] ??
        'README.md';
      this.appendNavigationItem({
        id: `NAV-${randomUUID().slice(0, 8)}`,
        kind: input.decision === 'index_only' ? 'code_index' : 'authoritative_link',
        title: storedDraft?.title ?? assessment.question,
        locator,
        summary: assessment.baseline_answer || assessment.question,
        assessment_id: assessment.id,
        created_at: now,
      });
      this.db
        .prepare(
          `UPDATE capture_assessments
           SET disposition = ?, review_state = 'decided', decided_at = ?
           WHERE id = ?`,
        )
        .run(input.decision, now, assessment.id);
      return { ok: true };
    }

    const draft = input.editedEntry ?? storedDraft;
    if (!draft) {
      return { ok: false, missingFields: ['candidateEntry: 缺少候选卡片数据'] };
    }

    const targetStatus: KnowledgeEntry['status'] =
      input.decision === 'approve_active' ? 'active' : 'probation';
    const targetZone: StorageZone =
      input.decision === 'approve_probation'
        ? 'probation'
        : draft.layer === 'shared_tech'
          ? 'shared_tech'
          : draft.layer === 'personal'
            ? 'personal'
            : 'project';

    const approvedAssessment: CaptureAssessment = {
      ...assessment,
      discoverability: 'missing_context',
      disposition: 'knowledge_candidate',
    };
    const finalEntry: KnowledgeEntry = {
      ...draft,
      capture_assessment_id: approvedAssessment.id,
      status: targetStatus,
      updated_at: now,
    };

    const gate = enforceHardPublishGate(finalEntry, approvedAssessment);
    if (!gate.ok) {
      return { ok: false, missingFields: gate.missingFields };
    }

    const saved = this.upsertEntry(finalEntry, targetZone, approvedAssessment);
    this.db
      .prepare(`UPDATE capture_assessments SET review_state = 'decided', decided_at = ? WHERE id = ?`)
      .run(now, approvedAssessment.id);

    return { ok: true, persistedEntry: saved };
  }

  /**
   * Saves a new revision of an existing entry (PRD §5.2 & §5.3):
   * - `substantive` edits increment `revision` and reset `maturity` to `'draft'`!
   * - `editorial` edits increment `revision` while preserving `maturity`.
   */
  saveRevision(input: {
    id: string;
    patch: Partial<KnowledgeEntry>;
    revisionImpact: 'substantive' | 'editorial';
  }): { ok: true; entry: KnowledgeEntry } | { ok: false; missingFields: string[] } {
    const row = this.findRawEntryRow(input.id);
    if (!row) {
      throw new Error(`未找到待编辑条目: ${input.id}`);
    }
    const existing = rowToEntry(row);
    const now = new Date().toISOString();
    const reviewDue = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

    const nextEntry: KnowledgeEntry = {
      ...existing,
      ...input.patch,
      id: existing.id,
      revision: existing.revision + 1,
      maturity: input.revisionImpact === 'substantive' ? 'draft' : existing.maturity,
      freshness: 'current',
      updated_at: now,
      review_due_at: input.patch.review_due_at ?? reviewDue,
    };

    const assessment = nextEntry.capture_assessment_id
      ? this.getAssessment(nextEntry.capture_assessment_id)
      : null;

    if (nextEntry.status === 'active' || nextEntry.status === 'probation') {
      const gate = enforceHardPublishGate(nextEntry, assessment);
      if (!gate.ok) {
        return { ok: false, missingFields: gate.missingFields };
      }
    }

    return { ok: true, entry: this.updateExistingEntryDirect(nextEntry) };
  }

  listValidations(entryId: string): ValidationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM validation_records
         WHERE entry_id = ? AND workspace_id IN (?, ?)
         ORDER BY created_at DESC`,
      )
      .all(entryId, this.workspaceId, GLOBAL_WORKSPACE_ID) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      workspace_id: String(r.workspace_id),
      entry_id: String(r.entry_id),
      revision: Number(r.revision),
      session_id: String(r.session_id),
      task_fingerprint: String(r.task_fingerprint),
      outcome: r.outcome as ValidationRecord['outcome'],
      evidence_note: String(r.evidence_note),
      created_at: String(r.created_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}
