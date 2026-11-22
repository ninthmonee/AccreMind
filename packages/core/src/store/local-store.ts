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
import { isRepositoryKnowledgeLayer } from '../contracts/types.ts';
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
import { enforceHardPublishGate, isAbsoluteMachinePath, validateCaptureAssessment } from '../contracts/validator.ts';
import type { GetEntryOutcome, KnowledgeStoreProvider } from './provider.ts';
import { ACCREMIND_SQLITE_DDL, evaluateSemverRange, migrateSchema } from './sqlite-schema.ts';
import { transition, transitionBlocker } from '../governance/lifecycle.ts';
import { EventLog, type AccreMindEvent } from './event-log.ts';
import { EvidenceSnapshots } from '../evidence/snapshots.ts';
import { deriveStanding, ValidationLedger, type LedgerDecision, type LedgerStanding } from '../ledger/ledger.ts';
import { resolveLocalActor } from '../governance/actor.ts';

function checkDomainStorage(layer: KnowledgeEntry['layer'], zone: StorageZone): void {
  if (layer === 'domain' && zone !== 'project' && zone !== 'probation') {
    throw new Error('领域知识只能放入当前仓库的项目库或本地试用池');
  }
}

export const GLOBAL_WORKSPACE_ID = '__global__';

export class EntryIdCollisionError extends Error {
  readonly entryId: string;
  readonly existingPath: string;
  constructor(entryId: string, existingPath: string) {
    super(`条目编号 ${entryId} 已被另一条经验使用（${path.basename(existingPath)}），未写入以免覆盖。请重新生成编号后再保存。`);
    this.name = 'EntryIdCollisionError';
    this.entryId = entryId;
    this.existingPath = existingPath;
  }
}

/** The entry file changed on disk (another window, the CLI, a Git pull or a manual edit) since it was read. */
export class ConcurrentModificationError extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`条目 ${entryId} 刚被其他窗口或命令修改过，已重新载入最新内容。请刷新后再操作。`);
    this.name = 'ConcurrentModificationError';
    this.entryId = entryId;
  }
}

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SQLite errors that mean the file itself is unusable, as opposed to busy/locked/permission problems. */
export function isSqliteCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err);
  return /SQLITE_CORRUPT|SQLITE_NOTADB|malformed|file is not a database|file is encrypted/i.test(msg);
}

export interface LocalStoreOptions {
  projectRoot: string;
  globalDir?: string;
  projectDirName?: string;
  workspaceId?: string;
  maxProbationExposures?: number;
  /** Identity recorded on decisions and in the activity log; defaults to the repository's Git user. */
  actor?: string;
  /** Whether the validation ledger is written into the repository (team sharing). Default: off. */
  shareLedger?: () => boolean;
}

export type AttentionKind = 'probation_silent' | 'inapplicable';

export interface WorkspaceInsights {
  days: number;
  /** reminders = on-demand reminders (radar + file guard); ruleTurns = turns that carried the resident team rules. */
  daily: Array<{ date: string; reminders: number; helpful: number; inapplicable: number; wrong: number; ruleTurns: number }>;
  totals: { reminders: number; remindersLast7: number; remindersPrev7: number; helpful: number; inapplicable: number; wrong: number; ruleTurns: number };
  /** Minutes east of UTC the days were cut at. */
  tzOffsetMinutes: number;
  byType: Record<string, number>;
  /** usable: confirmed, no task check yet · verified: confirmed and checked · trial · attention: needs review · stopped */
  byHealth: { usable: number; verified: number; trial: number; attention: number; stopped: number };
  lifecycle: { candidates: number; trial: number; active: number; verified: number };
  topEntries: Array<{ id: string; title: string; type: string; reminders: number; helpful: number }>;
  attention: number;
}

export interface AttentionItem {
  entry_id: string;
  kind: AttentionKind;
  reason: string;
  revision: number;
  created_at: string;
}

/** How many “doesn't apply here” reports on one revision, without any success, pause an entry. */
export const INAPPLICABLE_SUSPEND_THRESHOLD = 3;

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

/**
 * Earlier versions kept every repository in one shared `accremind.sqlite`; a fault in one repository
 * could then reset all of them. Each workspace now has its own index file, seeded once from the legacy one.
 */
function migrateLegacySharedDatabase(paths: StoreLayoutPaths): void {
  if (fs.existsSync(paths.sqlitePath) || !fs.existsSync(paths.legacySqlitePath)) return;
  fs.mkdirSync(path.dirname(paths.sqlitePath), { recursive: true });
  try {
    const legacy = new DatabaseSync(paths.legacySqlitePath, { readOnly: true });
    try {
      legacy.prepare('VACUUM INTO ?').run(paths.sqlitePath);
    } finally {
      legacy.close();
    }
  } catch {
    // An unreadable legacy file is left untouched; the new index is rebuilt from Markdown.
    if (fs.existsSync(paths.sqlitePath)) fs.rmSync(paths.sqlitePath, { force: true });
  }
}

interface SnapshotItem {
  key: string;
  workspaceId: string;
  zone: StorageZone;
  exposures: number;
  entry: KnowledgeEntry;
  aliasesLc: string;
  titleLc: string;
  bodyLc: string;
  anchorFiles: Set<string>;
  globs: Array<{ glob: string; prefix: string }>;
}

interface ServingSnapshot {
  dataVersion: number;
  items: SnapshotItem[];
}

/** The part of a glob before its first wildcard; a cheap filter before running the real matcher. */
function globLiteralPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i < 0 ? glob : glob.slice(0, i);
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
  readonly events: EventLog;
  private db: DatabaseSync;
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private snapshot: ServingSnapshot | null = null;
  private lockDepth = 0;
  private actorOverride: string | undefined;
  private resolvedActor: string | undefined;

  constructor(options: LocalStoreOptions) {
    this.paths = resolveStorePaths(options);
    this.workspaceId = this.paths.workspaceId;
    this.maxProbationExposures = options.maxProbationExposures ?? 3;
    this.actorOverride = options.actor;
    this.events = new EventLog(this.paths.eventsDir);
    ensureStoreDirectoriesSync(this.paths);
    this.db = this.openDatabaseWithSelfHeal();
    this.shareLedger = options.shareLedger ?? (() => false);
    this.snapshots = new EvidenceSnapshots({
      projectRoot: this.paths.projectRoot, repoDir: this.paths.evidenceDir, localDir: this.paths.localEvidenceDir, actor: () => this.actor,
    });
    this.ledger = new ValidationLedger({
      repoDir: this.paths.ledgerDir, localDir: this.paths.localLedgerDir, shared: () => this.shareLedger(), actor: () => this.actor,
    });
  }

  /** Evidence snapshots (pointer + redacted excerpt per piece of evidence). */
  readonly snapshots: EvidenceSnapshots;
  /** Validation ledger: confirmations, counterexamples and decisions per revision. */
  readonly ledger: ValidationLedger;
  private shareLedger: () => boolean;

  /** Switches ledger sharing for this store (the host persists the setting). */
  setShareLedger(fn: () => boolean): void {
    this.shareLedger = fn;
  }

  /** Ledger standing of an entry: maturity and pause state as the shared rules compute them. */
  ledgerStanding(entry: KnowledgeEntry): LedgerStanding {
    return deriveStanding(entry, this.ledger.read(entry.id), { requireSecondPerson: this.shareLedger() });
  }

  /** Records that an entry went live and captures its evidence as it stands now. */
  recordPublication(entry: KnowledgeEntry, note = ''): void {
    try {
      this.ledger.append(entry, { kind: 'decision', action: 'publish', note });
      this.snapshots.capture(entry);
    } catch (err) {
      // Snapshots and the ledger are supporting records: never block publishing on them.
      console.warn(`[accremind] could not record publication of ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private openDatabaseWithSelfHeal(): DatabaseSync {
    migrateLegacySharedDatabase(this.paths);
    try {
      const db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      migrateSchema(db as never);
      return db;
    } catch (err) {
      // Busy, locked or permission errors are transient or environmental: surface them, never discard data.
      if (!isSqliteCorruptionError(err)) throw err;
      // Only a genuinely corrupt file is moved aside (kept for recovery) and rebuilt from the Markdown source.
      for (const suffix of ['', '-wal', '-shm']) {
        const file = this.paths.sqlitePath + suffix;
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt.${Date.now()}.bak`);
      }
      const db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      migrateSchema(db as never);
      return db;
    }
  }

  get rawDb(): DatabaseSync {
    return this.db;
  }

  /** Prepared statements are compiled once per connection and reused (reconcile runs thousands). */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

  /**
   * In-memory view of every indexed entry for the hot path (pre-step radar, per-tool file reminder).
   * Rebuilt lazily after our own writes, and when another process commits (SQLite `data_version`).
   */
  private servingSnapshot(): ServingSnapshot {
    const dataVersion = Number((this.stmt('PRAGMA data_version').get() as { data_version: number }).data_version);
    if (this.snapshot && this.snapshot.dataVersion === dataVersion) return this.snapshot;
    const rows = this.stmt('SELECT * FROM entries WHERE workspace_id IN (?, ?)').all(this.workspaceId, GLOBAL_WORKSPACE_ID) as unknown as EntryRow[];
    const items: SnapshotItem[] = rows.map((row) => {
      const entry = rowToEntry(row);
      return {
        key: `${row.workspace_id}::${row.id}`,
        workspaceId: row.workspace_id,
        zone: row.storage_zone,
        exposures: row.probation_exposures,
        entry,
        aliasesLc: entry.search_aliases.join(' ').toLowerCase(),
        titleLc: entry.title.toLowerCase(),
        bodyLc: `${entry.claim} ${entry.knowledge_delta}`.toLowerCase(),
        anchorFiles: new Set(entry.symbol_anchors.map((a) => a.file_path)),
        globs: entry.watch_paths.map((glob) => ({ glob, prefix: globLiteralPrefix(glob) })),
      };
    });
    this.snapshot = { dataVersion, items };
    return this.snapshot;
  }

  private invalidateSnapshot(): void {
    this.snapshot = null;
  }

  /**
   * Serialises writes to this workspace across processes (DSH, the standalone workbench, the CLI).
   * A lock file older than 30 s is treated as left behind by a crashed process and taken over.
   */
  private withWriteLock<T>(fn: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return fn();
      } finally {
        this.lockDepth -= 1;
      }
    }
    const lockPath = path.join(path.dirname(this.paths.sqlitePath), 'write.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error('另一个 AccreMind 窗口正在写入，请稍后重试');
        sleepSync(25);
      }
    }
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      fs.rmSync(lockPath, { force: true });
    }
  }

  /** Refuses to overwrite an entry file that changed on disk since it was indexed. */
  private assertUnchangedOnDisk(row: EntryRow): void {
    if (!row.content_sha256 || !fs.existsSync(row.file_path)) return;
    const onDisk = fs.readFileSync(row.file_path, 'utf8');
    if (sha256Hex(onDisk) === row.content_sha256) return;
    // Pick up the newer content so the next attempt works from it.
    try {
      const parsed = parseEntryMarkdown(onDisk, row.file_path);
      this.indexEntryRow(row.workspace_id, row.storage_zone, row.file_path, sha256Hex(onDisk), parsed, row.probation_exposures);
    } catch {
      // unreadable now (e.g. merge conflict); reconcile will report it
    }
    throw new ConcurrentModificationError(row.id);
  }

  /** Who is acting in this process (Git identity unless the host supplied one). */
  get actor(): string {
    if (this.actorOverride) return this.actorOverride;
    this.resolvedActor ??= resolveLocalActor(this.paths.projectRoot);
    return this.resolvedActor;
  }

  /** Lets a host attribute subsequent actions to an authenticated identity. */
  setActor(actor: string | undefined): void {
    this.actorOverride = actor?.trim() || undefined;
  }

  /** Appends to the activity log; logging must never block the action it records. */
  emit(type: AccreMindEvent['type'], entry: Pick<KnowledgeEntry, 'id' | 'revision'>, detail?: Record<string, unknown>): void {
    try {
      this.events.append({ actor: this.actor, type, entryId: entry.id, revision: entry.revision, ...(detail ? { detail } : {}) });
    } catch {
      // disk full or read-only: the decision itself is already persisted
    }
  }

  // ---------- governance & attention ----------

  recordGovernanceDecision(entry: Pick<KnowledgeEntry, 'id' | 'revision'>, action: string, reason: string): void {
    const now = new Date().toISOString();
    this.stmt(
        'INSERT INTO governance_decisions (workspace_id, entry_id, revision, action, reason, created_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(this.workspaceId, entry.id, entry.revision, action, reason, now, this.actor);
    this.emit('governance.decided', entry, { action, reason });
    const ledgerAction = ({ stale: 'stale', resolve: 'resume', request_review: 'request_review', promote: 'promote',
      dismiss: 'dismiss', withdraw: 'withdraw', confirm_fresh: 'confirm_fresh' } as Record<string, LedgerDecision>)[action];
    const full = ledgerAction ? this.findRawEntryRow(entry.id) : undefined;
    if (ledgerAction && full) {
      try {
        this.ledger.append(rowToEntry(full), { kind: 'decision', action: ledgerAction, note: reason, at: now });
      } catch (err) {
        console.warn(`[accremind] ledger write skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  listGovernanceDecisions(entryId: string): Array<{ revision: number; action: string; reason: string; created_at: string; actor: string | null }> {
    return this.stmt('SELECT revision, action, reason, created_at, actor FROM governance_decisions WHERE workspace_id = ? AND entry_id = ? ORDER BY created_at DESC')
      .all(this.workspaceId, entryId) as never;
  }

  raiseAttention(entry: Pick<KnowledgeEntry, 'id' | 'revision'>, kind: AttentionKind, reason: string): void {
    const res = this.stmt('INSERT OR IGNORE INTO attention_items (workspace_id, entry_id, kind, reason, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.workspaceId, entry.id, kind, reason, entry.revision, new Date().toISOString());
    if (res.changes) this.emit('attention.raised', entry, { kind, reason });
  }

  clearAttention(entryId: string, kind?: AttentionKind): void {
    if (kind) {
      this.stmt('DELETE FROM attention_items WHERE workspace_id = ? AND entry_id = ? AND kind = ?').run(this.workspaceId, entryId, kind);
    } else {
      this.stmt('DELETE FROM attention_items WHERE workspace_id = ? AND entry_id = ?').run(this.workspaceId, entryId);
    }
  }

  /** Items that need a human decision; entries that were archived or withdrawn since drop out. */
  listAttentionItems(): AttentionItem[] {
    return this.stmt(
        `SELECT a.entry_id, a.kind, a.reason, a.revision, a.created_at FROM attention_items a
         JOIN entries e ON e.id = a.entry_id AND e.workspace_id IN (?, ?)
         WHERE a.workspace_id = ? AND e.status IN ('active', 'probation')
         ORDER BY a.created_at`,
      )
      .all(this.workspaceId, GLOBAL_WORKSPACE_ID, this.workspaceId) as unknown as AttentionItem[];
  }

  /**
   * Aggregates for the overview: what the agent was reminded of, what people found useful,
   * and where entries are in their lifecycle. Counts only; nothing here is a model score.
   */
  /**
   * Housekeeping, safe to run at every start (idempotent, bounded work):
   * - usage detail older than `retentionDays` is rolled up into `usage_daily` and deleted, and turn
   *   records (which turn saw which entry) older than that are removed;
   * - a trial that has waited for a decision longer than `attentionGraceDays` stops being shown to the
   *   agent (it stays in the inbox), so an unattended queue cannot keep injecting unconfirmed entries.
   */
  runMaintenance(options: { now?: Date; retentionDays?: number; attentionGraceDays?: number } = {}): { rolledUp: number; turnsRemoved: number; paused: string[]; ledgerUpdated: string[] } {
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - (options.retentionDays ?? 90) * 86_400_000).toISOString();
    let rolledUp = 0;
    let turnsRemoved = 0;
    this.db.exec('BEGIN');
    try {
      this.stmt(
        `INSERT INTO usage_daily (workspace_id, entry_id, day, event_type, n)
         SELECT workspace_id, entry_id, substr(created_at, 1, 10), event_type, COUNT(*) FROM usage_events
         WHERE created_at < ? GROUP BY workspace_id, entry_id, substr(created_at, 1, 10), event_type
         ON CONFLICT (workspace_id, entry_id, day, event_type) DO UPDATE SET n = n + excluded.n`,
      ).run(cutoff);
      rolledUp = Number(this.stmt('DELETE FROM usage_events WHERE created_at < ?').run(cutoff).changes);
      // Turn records past the window can no longer receive feedback, so they go too.
      this.stmt(`DELETE FROM turn_hits WHERE EXISTS (SELECT 1 FROM turn_receipts r WHERE r.workspace_id = turn_hits.workspace_id
        AND r.session_id = turn_hits.session_id AND r.turn_id = turn_hits.turn_id AND r.created_at < ?)`).run(cutoff);
      turnsRemoved = Number(this.stmt('DELETE FROM turn_receipts WHERE created_at < ?').run(cutoff).changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const graceCutoff = new Date(now.getTime() - (options.attentionGraceDays ?? 14) * 86_400_000).toISOString();
    const overdue = this.stmt(
      `SELECT entry_id FROM attention_items WHERE workspace_id = ? AND kind = 'probation_silent' AND created_at < ?`,
    ).all(this.workspaceId, graceCutoff) as Array<{ entry_id: string }>;
    const paused: string[] = [];
    for (const { entry_id } of overdue) {
      const row = this.findRawEntryRow(entry_id);
      if (!row) continue;
      const entry = rowToEntry(row);
      if (transitionBlocker(entry, 'suspend')) continue;
      this.updateExistingEntryDirect(transition(entry, 'suspend', { now: now.toISOString() }));
      this.stmt('UPDATE attention_items SET reason = ? WHERE workspace_id = ? AND entry_id = ? AND kind = ?').run(
        `试用期满超过 ${options.attentionGraceDays ?? 14} 天仍未决定，已暂停提醒 AI。转正会自动恢复，也可以淘汰。`,
        this.workspaceId, entry_id, 'probation_silent',
      );
      this.emit('entry.suspended', entry, { reason: 'decision_overdue' });
      paused.push(entry_id);
    }
    let ledgerUpdated: string[] = [];
    if (this.shareLedger()) ledgerUpdated = this.syncFromLedger().updated;
    return { rolledUp, turnsRemoved, paused, ledgerUpdated };
  }

  /**
   * Team mode: teammates' confirmations and counterexamples arrive through Git as ledger files. This
   * applies them to the local index with the same rule used everywhere (`deriveStanding`). Entries
   * with no confirmation or counterexample on their current wording are left as they are.
   */
  syncFromLedger(): { updated: string[] } {
    const updated: string[] = [];
    for (const id of this.ledger.entryIds()) {
      const row = this.findRawEntryRow(id);
      if (!row) continue;
      const entry = rowToEntry(row);
      if (entry.status !== 'active' && entry.status !== 'probation') continue;
      const standing = this.ledgerStanding(entry);
      if (standing.unresolvedCounterexample) {
        if (!transitionBlocker(entry, 'suspend')) {
          this.updateExistingEntryDirect(transition(entry, 'suspend'));
          this.emit('entry.suspended', entry, { reason: 'ledger_counterexample' });
          updated.push(id);
        }
        continue;
      }
      if (standing.successTasks > 0 && standing.maturity !== entry.maturity) {
        this.updateExistingEntryDirect({ ...entry, maturity: standing.maturity, last_validated_at: standing.lastValidatedAt ?? entry.last_validated_at });
        this.emit('entry.ledger_synced', entry, { maturity: standing.maturity });
        updated.push(id);
      }
    }
    return { updated };
  }

  /** True when a trial is paused only because nobody decided in time (no counterexample, no “doesn't apply” pause). */
  pausedOnlyForOverdueDecision(entryId: string): boolean {
    const row = this.findRawEntryRow(entryId);
    if (!row) return false;
    const entry = rowToEntry(row);
    if (entry.status !== 'probation' || entry.serving !== 'suspended') return false;
    const kinds = new Set((this.stmt('SELECT kind FROM attention_items WHERE workspace_id = ? AND entry_id = ?')
      .all(this.workspaceId, entryId) as Array<{ kind: string }>).map((r) => r.kind));
    if (!kinds.has('probation_silent') || kinds.has('inapplicable')) return false;
    const failures = Number((this.stmt(`SELECT COUNT(*) AS n FROM validation_records
      WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND outcome = 'failure'`)
      .get(row.workspace_id, entryId, entry.revision) as { n: number }).n);
    return failures === 0;
  }

  /**
   * Dashboard numbers. Days are the reader's calendar days: `tzOffsetMinutes` is minutes east of UTC
   * (UTC+8 → 480) and defaults to this machine's zone, which is the user's for the local plugin.
   *
   * One definition for every page: “reminders” are on-demand reminders (question radar + file guard);
   * resident team rules ride along every turn and are counted separately as `ruleTurns`.
   */
  insights(requestedDays = 28, now = new Date(), tzOffsetMinutes = -now.getTimezoneOffset()): WorkspaceInsights {
    const outDays = Math.max(1, Math.round(requestedDays));
    // The week-over-week comparison always needs 14 days, whatever range is displayed.
    const days = Math.max(outDays, 14);
    const offset = Math.max(-840, Math.min(840, Math.round(Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0)));
    const shiftMs = offset * 60_000;
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    // Work in "shifted" time, where UTC midnight is the reader's local midnight.
    const localStart = new Date(now.getTime() + shiftMs - (days - 1) * 86_400_000);
    localStart.setUTCHours(0, 0, 0, 0);
    const series: WorkspaceInsights['daily'] = [];
    const index = new Map<string, WorkspaceInsights['daily'][number]>();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(localStart.getTime() + i * 86_400_000);
      const point = { date: dayKey(d), reminders: 0, helpful: 0, inapplicable: 0, wrong: 0, ruleTurns: 0 };
      series.push(point);
      index.set(point.date, point);
    }
    const since = new Date(localStart.getTime() - shiftMs).toISOString();
    const shift = `${offset >= 0 ? '+' : ''}${offset} minutes`;
    const usage = this.stmt(
      `SELECT substr(datetime(created_at, ?), 1, 10) AS day, event_type, COUNT(*) AS n FROM usage_events
       WHERE workspace_id IN (?, ?) AND created_at >= ? GROUP BY day, event_type`,
    ).all(shift, this.workspaceId, GLOBAL_WORKSPACE_ID, since) as Array<{ day: string; event_type: string; n: number }>;
    for (const u of usage) {
      const point = index.get(u.day);
      if (!point) continue;
      if (u.event_type === 'radar_shown' || u.event_type === 'guard_shown') point.reminders += Number(u.n);
      if (u.event_type === 'feedback_inapplicable') point.inapplicable += Number(u.n);
    }
    const validations = this.stmt(
      `SELECT substr(datetime(created_at, ?), 1, 10) AS day, outcome, COUNT(*) AS n FROM validation_records
       WHERE workspace_id IN (?, ?) AND created_at >= ? GROUP BY day, outcome`,
    ).all(shift, this.workspaceId, GLOBAL_WORKSPACE_ID, since) as Array<{ day: string; outcome: string; n: number }>;
    for (const v of validations) {
      const point = index.get(v.day);
      if (!point) continue;
      if (v.outcome === 'success') point.helpful += Number(v.n);
      if (v.outcome === 'failure') point.wrong += Number(v.n);
    }
    const ruleTurns = this.stmt(
      `SELECT substr(datetime(r.created_at, ?), 1, 10) AS day, COUNT(DISTINCT r.session_id || '/' || r.turn_id) AS n
       FROM turn_receipts r JOIN turn_hits h ON h.workspace_id = r.workspace_id AND h.session_id = r.session_id
         AND h.turn_id = r.turn_id AND h.source = 'rule'
       WHERE r.workspace_id = ? AND r.created_at >= ? GROUP BY day`,
    ).all(shift, this.workspaceId, since) as Array<{ day: string; n: number }>;
    for (const r of ruleTurns) {
      const point = index.get(r.day);
      if (point) point.ruleTurns += Number(r.n);
    }

    const items = this.servingSnapshot().items;
    const byType: Record<string, number> = {};
    const byHealth = { usable: 0, verified: 0, trial: 0, attention: 0, stopped: 0 };
    let active = 0;
    let trial = 0;
    let verified = 0;
    for (const { entry } of items) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      if (entry.status === 'withdrawn' || entry.status === 'archived' || entry.serving === 'suspended') byHealth.stopped += 1;
      else if (entry.status === 'candidate') continue;
      else if (entry.freshness !== 'current') byHealth.attention += 1;
      else if (entry.status === 'probation') byHealth.trial += 1;
      else if (entry.maturity !== 'draft') byHealth.verified += 1;
      else byHealth.usable += 1;
      if (entry.status === 'active') active += 1;
      if (entry.status === 'probation') trial += 1;
      if (entry.status === 'active' && entry.maturity !== 'draft') verified += 1;
    }
    const candidates = Number((this.stmt(
      'SELECT COUNT(*) AS n FROM capture_assessments WHERE workspace_id = ?',
    ).get(this.workspaceId) as { n: number }).n);

    const shownSince = new Date(localStart.getTime() + (days - outDays) * 86_400_000 - shiftMs).toISOString();
    const top = this.stmt(
      `SELECT entry_id, COUNT(*) AS n FROM usage_events
       WHERE workspace_id IN (?, ?) AND created_at >= ? AND event_type IN ('radar_shown', 'guard_shown')
       GROUP BY entry_id ORDER BY n DESC LIMIT 5`,
    ).all(this.workspaceId, GLOBAL_WORKSPACE_ID, shownSince) as Array<{ entry_id: string; n: number }>;
    const helpfulBy = new Map((this.stmt(
      `SELECT entry_id, COUNT(*) AS n FROM validation_records
       WHERE workspace_id IN (?, ?) AND outcome = 'success' AND created_at >= ? GROUP BY entry_id`,
    ).all(this.workspaceId, GLOBAL_WORKSPACE_ID, shownSince) as Array<{ entry_id: string; n: number }>).map((r) => [r.entry_id, Number(r.n)]));
    const byId = new Map(items.map((i) => [i.entry.id, i.entry]));
    const topEntries = top.flatMap((t) => {
      const e = byId.get(t.entry_id);
      return e ? [{ id: e.id, title: e.title, type: e.type, reminders: Number(t.n), helpful: helpfulBy.get(e.id) ?? 0 }] : [];
    });

    type Metric = 'reminders' | 'helpful' | 'inapplicable' | 'wrong' | 'ruleTurns';
    const sum = (rows: typeof series, key: Metric) => rows.reduce((acc, p) => acc + p[key], 0);
    const shown = series.slice(-outDays);
    return {
      days: outDays,
      tzOffsetMinutes: offset,
      daily: shown,
      totals: {
        reminders: sum(shown, 'reminders'),
        remindersLast7: sum(series.slice(-7), 'reminders'),
        remindersPrev7: sum(series.slice(-14, -7), 'reminders'),
        helpful: sum(shown, 'helpful'),
        inapplicable: sum(shown, 'inapplicable'),
        wrong: sum(shown, 'wrong'),
        ruleTurns: sum(shown, 'ruleTurns'),
      },
      byType,
      byHealth,
      lifecycle: { candidates, trial, active, verified },
      topEntries,
      attention: this.listAttentionItems().length,
    };
  }

  /** True when an ID is used by an indexed entry or by a pending candidate draft. */
  isEntryIdTaken(id: string): boolean {
    if (this.findRawEntryRow(id)) return true;
    return Boolean(
      this.stmt("SELECT 1 FROM capture_assessments WHERE json_extract(candidate_entry_json, '$.id') = ? LIMIT 1")
        .get(id),
    );
  }

  deleteAssessment(id: string): void {
    this.stmt('DELETE FROM capture_assessments WHERE id = ?').run(id);
  }

  /**
   * A developer said the entry did not fit their task. Repeated reports on the same revision with no
   * success pause it and ask for a decision; a single report never does.
   */
  recordInapplicable(entryId: string, sessionId: string, detail: string): { suspended: boolean; reports: number } {
    const row = this.findRawEntryRow(entryId);
    if (!row) throw new Error(`未找到条目: ${entryId}`);
    const entry = rowToEntry(row);
    this.recordUsage({ workspace_id: row.workspace_id, session_id: sessionId, entry_id: entry.id, revision: entry.revision, event_type: 'feedback_inapplicable', detail });
    try {
      this.ledger.append(entry, { kind: 'inapplicable', task: `session:${sessionId}`, note: detail });
    } catch (err) {
      console.warn(`[accremind] ledger write skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit('entry.feedback_inapplicable', entry, detail ? { detail } : undefined);
    const counts = this.stmt(
        `SELECT
           (SELECT COUNT(DISTINCT session_id) FROM usage_events WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND event_type = 'feedback_inapplicable') AS reports,
           (SELECT COUNT(*) FROM validation_records WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND outcome = 'success') AS successes`,
      )
      .get(row.workspace_id, entry.id, entry.revision, row.workspace_id, entry.id, entry.revision) as { reports: number; successes: number };
    const reports = Number(counts.reports);
    if (reports >= INAPPLICABLE_SUSPEND_THRESHOLD && Number(counts.successes) === 0 && entry.serving === 'enabled') {
      this.updateExistingEntryDirect(transition(entry, 'suspend'));
      this.emit('entry.suspended', entry, { reason: 'inapplicable_reports', reports });
      this.raiseAttention(entry, 'inapplicable', `已有 ${reports} 次反馈“不适用”，已暂停推荐。请收窄适用条件、修订或下线。`);
      return { suspended: true, reports };
    }
    return { suspended: false, reports };
  }

  private ownerWorkspaceForZone(zone: StorageZone): string {
    return zone === 'personal' || zone === 'shared_tech' ? GLOBAL_WORKSPACE_ID : this.workspaceId;
  }

  initializeAndReconcile(): { syncedCount: number; corruptedCount: number } {
    this.stmt(`UPDATE capture_assessments SET review_state = 'pending'
      WHERE workspace_id = ? AND disposition = 'needs_confirmation'
      AND review_state = 'decided' AND decided_at IS NULL`).run(this.workspaceId);
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
    const seenPaths = new Map<string, string>();

    this.db.exec('BEGIN');
    try {
      this.stmt('DELETE FROM corrupted_files WHERE workspace_id IN (?, ?)')
        .run(this.workspaceId, GLOBAL_WORKSPACE_ID);

      for (const { zone, dir, wsId } of zoneScans) {
        if (!fs.existsSync(dir)) continue;
        const files = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
          .sort();

        for (const fileName of files) {
          const fullPath = path.join(dir, fileName);
          // Fast path: an indexed file whose size and mtime are unchanged is not re-read.
          const stat = fs.statSync(fullPath);
          const known = this.stmt('SELECT id, workspace_id, file_mtime_ms, file_size FROM entries WHERE file_path = ?')
            .get(fullPath) as { id: string; workspace_id: string; file_mtime_ms: number | null; file_size: number | null } | undefined;
          if (known && known.workspace_id === wsId && known.file_mtime_ms === Math.trunc(stat.mtimeMs) && known.file_size === stat.size) {
            const knownKey = `${wsId}::${known.id}`;
            if (!seenKeys.has(knownKey)) {
              seenKeys.add(knownKey);
              seenPaths.set(knownKey, path.relative(this.paths.projectRoot, fullPath) || fullPath);
              syncedCount += 1;
              continue;
            }
          }
          const rawMd = fs.readFileSync(fullPath, 'utf8');
          const contentHash = sha256Hex(rawMd);

          try {
            const parsed = parseEntryMarkdown(rawMd, fullPath);
            checkDomainStorage(parsed.layer, zone);
            const seenKey = `${wsId}::${parsed.id}`;
            if (seenKeys.has(seenKey)) {
              // Zones are scanned rules → project → probation: the confirmed copy wins and the stale one is reported.
              throw new Error(`编号 ${parsed.id} 与 ${seenPaths.get(seenKey) ?? '另一文件'} 重复，已忽略此副本，请在治理中删除或重新编号`);
            }
            seenKeys.add(seenKey);
            seenPaths.set(seenKey, path.relative(this.paths.projectRoot, fullPath) || fullPath);

            const existing = this.stmt(
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
            } else {
              this.stmt('UPDATE entries SET file_path = ?, file_mtime_ms = ?, file_size = ? WHERE workspace_id = ? AND id = ?')
                .run(fullPath, Math.trunc(stat.mtimeMs), stat.size, wsId, parsed.id);
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
            this.stmt(
                'INSERT OR REPLACE INTO corrupted_files (file_path, workspace_id, reason, detected_at) VALUES (?, ?, ?, ?)',
              )
              .run(fullPath, wsId, reason, new Date().toISOString());
          }
        }
      }

      // Prune stale rows whose Markdown files were removed on disk
      const existingRows = this.stmt('SELECT workspace_id, id FROM entries WHERE workspace_id IN (?, ?)')
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
      this.statements.clear();
      this.invalidateSnapshot();
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

  /** FTS rows share the entry's rowid, so they are found by key instead of scanning the FTS table. */
  private entryRowid(wsId: string, id: string): number | bigint | undefined {
    return (this.stmt('SELECT rowid FROM entries WHERE workspace_id = ? AND id = ?').get(wsId, id) as { rowid: number | bigint } | undefined)?.rowid;
  }

  private deleteIndexedEntry(wsId: string, id: string): void {
    this.invalidateSnapshot();
    const rowid = this.entryRowid(wsId, id);
    if (rowid !== undefined) this.stmt('DELETE FROM entries_fts WHERE rowid = ?').run(rowid);
    this.stmt('DELETE FROM entries WHERE workspace_id = ? AND id = ?').run(wsId, id);
  }

  private indexEntryRow(
    wsId: string,
    zone: StorageZone,
    filePath: string,
    contentHash: string,
    entry: KnowledgeEntry,
    probationExposures: number,
  ): void {
    this.invalidateSnapshot();
    const previousRowid = this.entryRowid(wsId, entry.id);
    if (previousRowid !== undefined) this.stmt('DELETE FROM entries_fts WHERE rowid = ?').run(previousRowid);
    this.stmt('DELETE FROM entry_symbol_anchors WHERE workspace_id = ? AND entry_id = ?')
      .run(wsId, entry.id);

    const inserted = this.stmt(
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

    this.stmt(
        `INSERT INTO entries_fts (
          rowid, workspace_id, id, title, aliases_text, claim, knowledge_delta, rationale, watch_paths_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inserted.lastInsertRowid,
        wsId,
        entry.id,
        entry.title,
        entry.search_aliases.join(' '),
        entry.claim,
        entry.knowledge_delta,
        entry.rationale,
        entry.watch_paths.join(' '),
      );

    try {
      const st = fs.statSync(filePath);
      this.stmt('UPDATE entries SET file_mtime_ms = ?, file_size = ? WHERE workspace_id = ? AND id = ?')
        .run(Math.trunc(st.mtimeMs), st.size, wsId, entry.id);
    } catch {
      // file may be written after indexing in some flows; the next reconcile reads it again
    }

    const anchorStmt = this.stmt(
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
    return this.withWriteLock(() => this.upsertEntryLocked(entry, zone, assessment));
  }

  private upsertEntryLocked(
    entry: KnowledgeEntry,
    zone: StorageZone,
    assessment: CaptureAssessment | null,
  ): KnowledgeEntry {
    checkDomainStorage(entry.layer, zone);
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

    // Never let a new entry silently replace a different one that happens to share its ID.
    const sameIdRows = this.stmt('SELECT workspace_id, file_path, created_at FROM entries WHERE id = ? AND workspace_id IN (?, ?)')
      .all(entry.id, this.workspaceId, GLOBAL_WORKSPACE_ID) as Array<{ workspace_id: string; file_path: string; created_at: string }>;
    const foreign = sameIdRows.find((r) => r.created_at !== entry.created_at);
    if (foreign) {
      throw new EntryIdCollisionError(entry.id, foreign.file_path);
    }
    if (sameIdRows.length === 0 && fs.existsSync(filePath)) {
      const onDisk = fs.readFileSync(filePath, 'utf8');
      if (onDisk !== markdown) throw new EntryIdCollisionError(entry.id, filePath);
    }

    // Consistency rule (ADR-02): write immutable/atomic Markdown SoT first, then activate SQLite tx
    writeFileAtomicSync(filePath, markdown);
    // Moving an entry between zones must not leave a stale copy that could shadow it later.
    for (const r of sameIdRows) {
      if (r.file_path !== filePath && fs.existsSync(r.file_path)) {
        fs.unlinkSync(r.file_path);
        if (r.workspace_id !== wsId) this.deleteIndexedEntry(r.workspace_id, entry.id);
      }
    }

    const existing = this.stmt('SELECT probation_exposures FROM entries WHERE workspace_id = ? AND id = ?')
      .get(wsId, entry.id) as { probation_exposures: number } | undefined;

    this.db.exec('BEGIN');
    try {
      if (resolvedAssessment) {
        this.recordAssessmentInTx(resolvedAssessment, entry, 'decided');
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
    this.emit('entry.saved', entry, { zone, status: entry.status });
    return entry;
  }

  /**
   * Internal mutation helper used by governance / validation state transitions
   * when updating metadata of an already-existing persisted entry.
   */
  updateExistingEntryDirect(entry: KnowledgeEntry): KnowledgeEntry {
    return this.withWriteLock(() => this.updateExistingEntryLocked(entry));
  }

  private updateExistingEntryLocked(entry: KnowledgeEntry): KnowledgeEntry {
    const row = this.findRawEntryRow(entry.id);
    if (!row) {
      throw new Error(`未找到条目: ${entry.id}`);
    }
    this.assertUnchangedOnDisk(row);
    checkDomainStorage(entry.layer, row.storage_zone);
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
    return this.stmt(
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
    const rows = this.stmt(
        `SELECT * FROM entries
         WHERE workspace_id = ?
           AND (layer = 'team_rule' OR storage_zone = 'rules')
           AND status = 'active'
           AND serving = 'enabled'
           AND freshness != 'stale'
         ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, id ASC`,
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
        const ftsRows = this.stmt(
            `SELECT workspace_id, id, bm25(entries_fts, 0.0, 0.0, 8.0, 10.0, 4.0, 3.0, 2.0, 1.0) AS rank_score
             FROM entries_fts
             WHERE entries_fts MATCH ?
               AND workspace_id IN (?, ?)
             ORDER BY rank_score
             LIMIT 400`,
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

      // Exact 2-char CJK bigram boost (e.g. "防重", "丢单", "幂等") where trigram needs >=3 chars.
      // Done in memory over the snapshot instead of one LIKE table scan per token.
      if (shortTerms.length > 0) {
        const terms = shortTerms.map((t) => t.toLowerCase());
        for (const item of this.servingSnapshot().items) {
          if (item.workspaceId !== wsId && item.workspaceId !== GLOBAL_WORKSPACE_ID) continue;
          let bonus = 0;
          for (const tok of terms) {
            if (item.aliasesLc.includes(tok)) bonus += 6.0;
            else if (item.titleLc.includes(tok)) bonus += 5.0;
            else if (item.bodyLc.includes(tok)) bonus += 2.0;
          }
          if (bonus > 0) ftsScores.set(item.key, (ftsScores.get(item.key) ?? 0) + bonus);
        }
      }
    }

    const relTarget = params.filePath ? params.filePath.replace(/\\/g, '/') : null;
    let hadVersionExcluded = false;
    let hadSuspendedConflict = false;
    const scoredHits: SearchHit[] = [];

    for (const item of this.servingSnapshot().items) {
      if (item.workspaceId !== wsId && item.workspaceId !== GLOBAL_WORKSPACE_ID) continue;
      const entry = item.entry;
      const row = { workspace_id: item.workspaceId, storage_zone: item.zone, probation_exposures: item.exposures };
      if (params.type && entry.type !== params.type) continue;
      if (params.layer && entry.layer !== params.layer) continue;

      const key = item.key;
      const textScore = ftsScores.get(key) ?? 0;

      let pathMatched = false;
      if (relTarget) {
        pathMatched =
          item.anchorFiles.has(relTarget) ||
          item.globs.some(({ glob, prefix }) => relTarget.startsWith(prefix) && path.matchesGlob(relTarget, glob));
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

      let versionUnknown = false;
      if (params.workspaceDependencies && entry.dependency_constraints.length > 0) {
        let versionCompatible = true;
        for (const dep of entry.dependency_constraints) {
          const installed = params.workspaceDependencies[dep.name];
          if (!installed) continue;
          const verdict = evaluateSemverRange(installed, dep.range);
          if (verdict === 'mismatch') {
            versionCompatible = false;
            break;
          }
          if (verdict === 'unknown') versionUnknown = true;
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
      if (versionUnknown) {
        matchReasons.push('无法判断当前依赖版本是否在适用范围内，请核对');
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
    reviewStateOverride?: 'pending' | 'decided',
  ): void {
    const issues = validateCaptureAssessment(assessment);
    if (issues.length > 0) {
      throw new Error(
        `CaptureAssessment 校验失败: ${issues.map((i) => `${i.field}:${i.message}`).join('; ')}`,
      );
    }

    const reviewState =
      reviewStateOverride ??
      (assessment.disposition === 'knowledge_candidate' || assessment.disposition === 'needs_confirmation' ? 'pending' : 'decided');

    this.stmt(
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
        JSON.stringify([assessment.workspace_id, assessment.source_fingerprint]),
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
        reviewState,
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
    const row = this.stmt('SELECT * FROM capture_assessments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapAssessmentRow(row) : null;
  }

  findAssessmentByFingerprint(fingerprint: string): CaptureAssessment | null {
    const row = this.stmt('SELECT * FROM capture_assessments WHERE workspace_id = ? AND source_fingerprint IN (?, ?)')
      .get(this.workspaceId, JSON.stringify([this.workspaceId, fingerprint]), fingerprint) as Record<string, unknown> | undefined;
    return row ? this.mapAssessmentRow(row) : null;
  }

  private mapAssessmentRow(row: Record<string, unknown>): CaptureAssessment {
    const storedFingerprint = String(row.source_fingerprint);
    const prefix = '[' + JSON.stringify(row.workspace_id) + ',';
    // Older databases stored the fingerprint directly in a globally unique column.
    const fingerprint = storedFingerprint.startsWith(prefix)
      ? JSON.parse(storedFingerprint)[1] as string : storedFingerprint;
    return {
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      source_fingerprint: fingerprint,
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

  /**
   * Demo-only: writes backdated usage and validation rows so the overview charts have history.
   * Does not touch entry state, maturity or the event log.
   */
  importDemoActivity(rows: Array<
    | { kind: 'usage'; entryId: string; revision: number; eventType: UsageEvent['event_type']; at: string }
    | { kind: 'validation'; entryId: string; revision: number; outcome: 'success' | 'failure'; at: string; sessionId?: string }
    | { kind: 'turn'; sessionId: string; turnId: string; at: string;
        hits: Array<{ entryId: string; revision: number; title: string; status: string; source: 'rule' | 'radar' | 'jit'; filePath?: string }> }
  >): void {
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        if (row.kind === 'usage') {
          this.stmt(
            `INSERT INTO usage_events (event_id, workspace_id, session_id, entry_id, revision, event_type, detail, created_at)
             VALUES (?, ?, 'demo', ?, ?, ?, NULL, ?)`,
          ).run(`EVU-${randomUUID()}`, this.workspaceId, row.entryId, row.revision, row.eventType, row.at);
        } else if (row.kind === 'validation') {
          this.stmt(
            `INSERT OR IGNORE INTO validation_records (id, workspace_id, entry_id, revision, session_id, task_fingerprint, outcome, evidence_note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '示例数据', ?)`,
          ).run(`VR-${randomUUID()}`, this.workspaceId, row.entryId, row.revision, row.sessionId ?? 'demo',
            row.sessionId ? `session:${row.sessionId}` : `demo-${randomUUID()}`, row.outcome, row.at);
        } else {
          this.stmt(`INSERT OR IGNORE INTO turn_receipts (workspace_id, session_id, turn_id, created_at) VALUES (?, ?, ?, ?)`)
            .run(this.workspaceId, row.sessionId, row.turnId, row.at);
          for (const hit of row.hits) {
            this.stmt(`INSERT OR IGNORE INTO turn_hits (workspace_id, session_id, turn_id, entry_id, revision, title, status, source, file_path)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.workspaceId, row.sessionId, row.turnId, hit.entryId, hit.revision,
              hit.title, hit.status, hit.source, hit.filePath ?? null);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordUsage(event: Omit<UsageEvent, 'event_id' | 'created_at'>): void {
    this.stmt(
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
    if (!input.evidenceNote?.trim() || !input.taskFingerprint?.trim()) {
      throw new Error('验证需要真实任务标识与本次验证依据');
    }
    const row = this.findRawEntryRow(input.entryId);
    if (!row) {
      throw new Error(`验证目标条目不存在: ${input.entryId}`);
    }

    const entry = rowToEntry(row);
    if (entry.status !== 'active' && entry.status !== 'probation') {
      throw new Error('仅能验证正式或试用中的经验');
    }
    const blocked = input.outcome === 'success' ? transitionBlocker(entry, 'record_success') : null;
    if (blocked) throw new Error(blocked);
    if (input.outcome === 'success' && entry.evidence.some(ev =>
      ev.source_type === 'session_turn' && ev.source_ref === input.sessionId)) {
      throw new Error('请在产生该经验的会话之外验证');
    }
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

    const saved = this.stmt(
        `INSERT OR IGNORE INTO validation_records (
          id, workspace_id, entry_id, revision, session_id, task_fingerprint, outcome, evidence_note, created_at, actor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        this.actor,
      );
    this.emit('entry.validated', entry, { outcome: input.outcome, task: input.taskFingerprint, note: input.evidenceNote });

    if (!saved.changes) {
      const prior = this.stmt(`SELECT * FROM validation_records
        WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND task_fingerprint = ?`)
        .get(row.workspace_id, entry.id, entry.revision, input.taskFingerprint) as unknown as ValidationRecord;
      if (prior.outcome === input.outcome) return { record: prior, updatedEntry: entry };
      // A later counterexample in the same task supersedes its earlier positive vote.
      if (input.outcome !== 'failure') throw new Error('本任务已有不同的验证结论，请先复核证据');
      this.stmt('UPDATE validation_records SET outcome = ?, evidence_note = ?, created_at = ? WHERE id = ?')
        .run('failure', input.evidenceNote, now, prior.id);
      record.id = prior.id;
    }

    if (input.outcome === 'success' || input.outcome === 'failure') {
      this.backfillLedgerFromLocal(entry, row.workspace_id, record.id);
      try {
        this.ledger.append(entry, {
          kind: input.outcome === 'success' ? 'validated' : 'counterexample', task: input.taskFingerprint, note: input.evidenceNote, at: now,
        });
      } catch (err) {
        console.warn(`[accremind] ledger write skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (input.outcome === 'failure') {
      // Already paused (an earlier counterexample): the record stands, the state does not change again.
      if (transitionBlocker(entry, 'suspend')) return { record, updatedEntry: entry };
      return { record, updatedEntry: this.updateExistingEntryDirect(transition(entry, 'suspend', { now })) };
    }

    if (input.outcome === 'success') {
      // Maturity comes from the ledger rule: distinct tasks on this exact wording, at least one
      // confirmer other than the author for “proven”, and no unresolved counterexample.
      const rank = { draft: 0, verified: 1, proven: 2 } as const;
      const derived = this.ledgerStanding(entry).maturity;
      // Never lowers maturity earned before the ledger existed (e.g. imported entries).
      const nextMaturity = rank[derived] >= rank[entry.maturity] ? derived : entry.maturity;

      if (entry.status === 'probation') {
        const promoted = this.promoteProbationToActive(entry.id, {
          maturity: nextMaturity,
          last_validated_at: now,
        });
        return { record, updatedEntry: promoted };
      }

      const verifiedEntry = transition(entry, 'record_success', { now, maturity: nextMaturity });
      return { record, updatedEntry: this.updateExistingEntryDirect(verifiedEntry) };
    }

    return { record, updatedEntry: entry };
  }

  /**
   * Validations recorded before the ledger existed are copied into it once, so upgrading never
   * resets an entry's maturity.
   */
  private backfillLedgerFromLocal(entry: KnowledgeEntry, workspaceId: string, excludeId: string): void {
    const existing = this.ledger.read(entry.id).some((r) => r.revision === entry.revision && (r.kind === 'validated' || r.kind === 'counterexample'));
    if (existing) return;
    const rows = this.stmt(`SELECT * FROM validation_records WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND id != ?
      AND outcome IN ('success', 'failure') ORDER BY created_at`).all(workspaceId, entry.id, entry.revision, excludeId) as Array<Record<string, unknown>>;
    for (const r of rows) {
      this.ledger.append(entry, {
        kind: r.outcome === 'success' ? 'validated' : 'counterexample', task: String(r.task_fingerprint), note: String(r.evidence_note ?? ''),
        at: String(r.created_at), actor: r.actor ? String(r.actor) : undefined,
      });
    }
  }

  /**
   * Counts a real exposure of a trial entry. Silence is not evidence against an entry, so reaching the
   * limit never archives it: the entry keeps serving and is put in front of the user to decide.
   */
  recordProbationExposure(entryId: string, _legacyWaitForFeedback = false): { autoArchived: false; exposures: number; needsDecision: boolean } {
    const row = this.findRawEntryRow(entryId);
    if (!row || row.status !== 'probation') {
      return { autoArchived: false, exposures: row?.probation_exposures ?? 0, needsDecision: false };
    }
    const nextExposures = Math.min(this.maxProbationExposures, row.probation_exposures + 1);
    this.stmt('UPDATE entries SET probation_exposures = ? WHERE workspace_id = ? AND id = ?')
      .run(nextExposures, row.workspace_id, row.id);
    this.invalidateSnapshot();
    const needsDecision = nextExposures >= this.maxProbationExposures;
    if (needsDecision) {
      this.raiseAttention(rowToEntry(row), 'probation_silent',
        `试用中已提醒 ${nextExposures} 次，还没有人反馈是否有用。请决定转为正式或淘汰。`);
    }
    return { autoArchived: false, exposures: nextExposures, needsDecision };
  }

  promoteProbationToActive(
    entryId: string,
    overrides: Partial<Pick<KnowledgeEntry, 'maturity' | 'last_validated_at'>> = {},
  ): KnowledgeEntry {
    return this.withWriteLock(() => this.promoteLocked(entryId, overrides));
  }

  private promoteLocked(
    entryId: string,
    overrides: Partial<Pick<KnowledgeEntry, 'maturity' | 'last_validated_at'>>,
  ): KnowledgeEntry {
    const row = this.findRawEntryRow(entryId);
    if (!row) {
      throw new Error(`未找到待转正条目: ${entryId}`);
    }
    this.assertUnchangedOnDisk(row);

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
      ...transition(current, 'promote', { now }),
      maturity: overrides.maturity ?? current.maturity,
      last_validated_at: overrides.last_validated_at ?? current.last_validated_at,
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
    this.clearAttention(current.id, 'probation_silent');
    this.emit('entry.promoted', promoted, { from: row.storage_zone, to: targetZone });
    // Trial records and snapshots were kept on this machine; a repository entry takes them along.
    try {
      this.snapshots.relocate(current, promoted);
      if (this.shareLedger() && targetZone === 'project') this.ledger.exportToRepository((id) => id !== promoted.id);
    } catch (err) {
      console.warn(`[accremind] could not move trial records of ${promoted.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return promoted;
  }

  dismissProbation(entryId: string): KnowledgeEntry {
    const row = this.findRawEntryRow(entryId);
    if (!row) {
      throw new Error(`未找到试用条目: ${entryId}`);
    }
    const entry = rowToEntry(row);
    const saved = this.updateExistingEntryDirect(transition(entry, 'dismiss'));
    this.clearAttention(entry.id);
    this.emit('entry.dismissed', saved);
    return saved;
  }

  listCorruptedFiles(): CorruptedFileRecord[] {
    return this.stmt('SELECT * FROM corrupted_files WHERE workspace_id IN (?, ?) ORDER BY detected_at DESC')
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
    const rows = this.stmt(
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

  getReviewItem(id: string) {
    const row = this.stmt('SELECT * FROM capture_assessments WHERE workspace_id = ? AND id = ?')
      .get(this.workspaceId, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      assessment: this.mapAssessmentRow(row),
      reviewState: String(row.review_state),
      candidateDraft: row.candidate_entry_json ? JSON.parse(String(row.candidate_entry_json)) as KnowledgeEntry : null,
    };
  }

  countAssessments(reviewState: 'pending' | 'decided' | 'all' = 'all'): number {
    const filter = reviewState === 'all' ? '' : ' AND review_state = ?';
    const args = reviewState === 'all' ? [this.workspaceId] : [this.workspaceId, reviewState];
    const row = this.stmt(`SELECT COUNT(*) AS count FROM capture_assessments WHERE workspace_id = ?${filter}`)
      .get(...args) as {count:number};
    return row.count;
  }

  listAssessments(options: {
    reviewState?: 'pending' | 'decided' | 'all';
    limit?: number;
    offset?: number;
  } = {}): Array<{
    assessment: CaptureAssessment;
    reviewState: string;
    candidateDraft: KnowledgeEntry | null;
  }> {
    const state = options.reviewState ?? 'all';
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, options.offset ?? 0);
    const stateFilter = state === 'all' ? '' : ' AND review_state = ?';
    const args = state === 'all' ? [this.workspaceId] : [this.workspaceId, state];
    const rows = this.stmt(`SELECT * FROM capture_assessments WHERE workspace_id = ?${stateFilter}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<Record<string, unknown>>;

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
    navigationLocator?: string;
  }): {
    ok: boolean;
    missingFields?: string[];
    persistedEntry?: KnowledgeEntry;
  } {
    const rawRow = this.stmt('SELECT * FROM capture_assessments WHERE id = ?')
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
      this.stmt(
          `UPDATE capture_assessments
           SET disposition = 'discard', review_state = 'decided', decided_at = ?
           WHERE id = ?`,
        )
        .run(now, assessment.id);
      return { ok: true };
    }

    if (input.decision === 'index_only' || input.decision === 'link_existing') {
      const defaults = input.decision === 'index_only' ? assessment.checked_context.checked_files : assessment.checked_context.checked_docs;
      const locator = input.navigationLocator?.trim() || defaults[0]?.trim();
      if (!locator || isAbsoluteMachinePath(locator)) {
        return {ok:false, missingFields:['navigationLocator: 请填写可核查的仓库相对位置或稳定文档引用']};
      }
      this.appendNavigationItem({
        id: `NAV-${randomUUID().slice(0, 8)}`,
        kind: input.decision === 'index_only' ? 'code_index' : 'authoritative_link',
        title: storedDraft?.title ?? assessment.question,
        locator,
        summary: assessment.baseline_answer || assessment.question,
        assessment_id: assessment.id,
        created_at: now,
      });
      this.stmt(
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
    this.stmt(`UPDATE capture_assessments SET review_state = 'decided', decided_at = ? WHERE id = ?`)
      .run(now, approvedAssessment.id);
    this.recordPublication(saved, input.decision === 'approve_active' ? '人工审核批准入库' : '人工审核送入试用');

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
    const layerChanged = input.patch.layer !== undefined && input.patch.layer !== existing.layer;
    if (layerChanged && (!isRepositoryKnowledgeLayer(existing.layer) || !isRepositoryKnowledgeLayer(input.patch.layer) ||
        (row.storage_zone !== 'project' && row.storage_zone !== 'probation'))) {
      return { ok: false, missingFields: ['layer: 仅可在本仓库的业务领域知识和项目知识之间调整分类'] };
    }
    const now = new Date().toISOString();

    // Only content fields come from the patch; every lifecycle field is decided by the `revise` rule.
    const nextEntry = transition(
      {
        ...existing,
        ...input.patch,
        id: existing.id,
        revision: existing.revision,
        maturity: existing.maturity,
        freshness: existing.freshness,
        serving: existing.serving,
        status: existing.status,
        review_due_at: existing.review_due_at,
      },
      'revise',
      { now, impact: layerChanged ? 'substantive' : input.revisionImpact },
    );

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
    const rows = this.stmt(
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
