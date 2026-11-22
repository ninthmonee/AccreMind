import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  directoryForZone,
  ensureStoreDirectoriesSync,
  resolveRepoIdentity,
  resolveStorePaths,
  sha256Hex,
  writeFileAtomicSync,
  type RepoIdentity,
  type StoreLayoutPaths,
} from '../codec/atomic-fs.ts';
import { withFileLock } from '../codec/file-lock.ts';
import {
  MergeConflictError,
  parseEntryMarkdown,
  serializeEntryMarkdown,
} from '../codec/frontmatter.ts';
import { isCapturableLayer, isCrossRepoLayer } from '../contracts/types.ts';
import type {
  CaptureAssessment,
  CorruptedFileRecord,
  KnowledgeEntry,
  NavigationItem,
  SearchHit,
  SearchQuery,
  SearchResult,
  ScopeVerdict,
  SessionContext,
  StorageZone,
  UsageEvent,
  ValidationRecord,
} from '../contracts/types.ts';
import { enforceHardPublishGate, isAbsoluteMachinePath, validateCaptureAssessment } from '../contracts/validator.ts';
import type { GetEntryOutcome, KnowledgeStoreProvider } from './provider.ts';
import {
  ACCREMIND_INDEX_DDL,
  ACCREMIND_INDEX_DROP,
  ACCREMIND_INDEX_SCHEMA_VERSION,
  ACCREMIND_SQLITE_DDL,
  evaluateSemverRange,
  migrateSchema,
} from './sqlite-schema.ts';
import { transition, transitionBlocker } from '../governance/lifecycle.ts';
import { EventLog, type AccreMindEvent } from './event-log.ts';
import { EvidenceSnapshots } from '../evidence/snapshots.ts';
import { deriveStanding, ValidationLedger, type LedgerDecision, type LedgerStanding } from '../ledger/ledger.ts';
import { resolveLocalActor } from '../governance/actor.ts';
import { HostIdentityProvider, LocalIdentityProvider, type IdentityProvider, type UserIdentity } from '../identity/user-identity.ts';
import { DocLibrary } from '../docs/doc-library.ts';
import { RepoRegistry, readRepoDependencies, registryRecordFor, type RegistryRecord } from '../registry/repo-registry.ts';
import { CrossRepoFeedback, REPO_SUPPRESS_SESSIONS } from '../retrieval/cross-repo-feedback.ts';
import {
  applyQuotas,
  claimSimilarity,
  dedupeByCluster,
  DUPLICATE_SIMILARITY,
  extractIdentifiers,
  judgeApplicability,
  relevanceOf,
  signalCount,
  textStrength,
  DEFAULT_TUNING,
  loadTuning,
  VERDICT_LABEL,
  type RetrievalTuning,
} from '../retrieval/applicability.ts';

/**
 * Which storage zones a layer may live in. Machine-private layers never enter a repository folder
 * (that would publish them through Git), and repository layers never enter the machine-wide folders.
 */
const LAYER_ZONES: Record<KnowledgeEntry['layer'], StorageZone[]> = {
  // `project` is accepted for team rules promoted by older versions, which put them next to project entries.
  team_rule: ['rules', 'project', 'probation'],
  project: ['project', 'rules', 'probation'],
  domain: ['project', 'domain', 'probation'],
  shared_tech: ['shared_tech', 'probation'],
  personal: ['personal', 'probation'],
};
const LAYER_ZONE_MESSAGE: Record<KnowledgeEntry['layer'], string> = {
  team_rule: '团队规范只能放入仓库规范库或本地试用池',
  project: '项目知识只能放入当前仓库的项目库或本地试用池',
  domain: '领域知识只能放入仓库项目库、本机领域库或本地试用池',
  shared_tech: '通用技术经验只能放入本机共享技术库或本地试用池',
  personal: '个人经验只能放入本机个人库或本地试用池，不能进入仓库',
};

export function checkLayerStorage(layer: KnowledgeEntry['layer'], zone: StorageZone): void {
  if (!(LAYER_ZONES[layer] ?? []).includes(zone)) throw new Error(LAYER_ZONE_MESSAGE[layer] ?? `非法知识层级: ${String(layer)}`);
}

/** Where a confirmed entry of a layer is kept. Domain knowledge stays in its home repository (Git-shared). */
export function targetZoneForLayer(layer: KnowledgeEntry['layer']): StorageZone {
  switch (layer) {
    case 'team_rule':
      return 'rules';
    case 'shared_tech':
      return 'shared_tech';
    case 'personal':
      return 'personal';
    default:
      return 'project';
  }
}

const MACHINE_WIDE_ZONES = new Set<StorageZone>(['personal', 'shared_tech', 'domain']);
export function isMachineWideZone(zone: StorageZone): boolean {
  return MACHINE_WIDE_ZONES.has(zone);
}

/** Owner id recorded on personal entries: a hash, so the address itself is never written into a card. */
export function ownerIdForActor(actor: string): string {
  return `u-${sha256Hex(actor.trim().toLowerCase()).slice(0, 16)}`;
}

export const GLOBAL_WORKSPACE_ID = '__global__';

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

export type AttentionKind = 'probation_silent' | 'inapplicable' | 'rule_conflict';

/** What this repository's own sessions said about one entry revision. */
interface LocalFeedback {
  inapplicableSessions: number;
  shown: number;
  used: number;
  failures: number;
}

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
  scope_meta_json?: string | null;
}

const V2_KEYS = ['origin_repo', 'domains', 'applies_to', 'portable_patterns', 'owner', 'visibility', 'overrides', 'specializes', 'tags'] as const;

function scopeMetaOf(entry: KnowledgeEntry): string | null {
  const meta: Record<string, unknown> = {};
  for (const k of V2_KEYS) if (entry[k] !== undefined && entry[k] !== null) meta[k] = entry[k];
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
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

/** Tables keyed by the repository ID; rows are re-keyed when a repository adopts its stable ID. */
const WORKSPACE_KEYED_TABLES = [
  'entries', 'entries_fts', 'entry_symbol_anchors', 'capture_assessments', 'validation_records', 'usage_events',
  'turn_receipts', 'turn_hits', 'probation_grace', 'governance_decisions', 'workspace_checkpoints', 'corrupted_files',
  'freshness_reviews', 'attention_items', 'usage_daily',
];

/**
 * Repository IDs used to be a hash of the folder path, so a moved folder or a second clone started from
 * nothing. When a repository first opens under its stable ID, the per-repository folders of the old ID are
 * copied (never moved: the old ones stay as the rollback) and the copied index is re-keyed.
 */
export function adoptLegacyWorkspace(paths: StoreLayoutPaths): { adopted: string[] } {
  const legacy = paths.legacyWorkspaceId;
  const current = paths.workspaceId;
  const adopted: string[] = [];
  if (!legacy || legacy === current) return { adopted };
  const g = paths.globalRoot;
  const pairs: Array<[string, string]> = [
    ['events', 'events'], ['probation', 'probation'], ['queue', 'queue'], ['evidence', 'evidence'], ['ledger', 'ledger'],
  ].map(([a, b]) => [path.join(g, a!, legacy), path.join(g, b!, current)]);
  pairs.push([path.join(g, 'workspaces', sha256Hex(legacy)), path.join(g, 'workspaces', sha256Hex(current))]);
  for (const [from, to] of pairs) {
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.cpSync(from, to, { recursive: true, errorOnExist: false });
      adopted.push(path.relative(g, to));
    }
  }
  const legacyDb = path.join(g, 'workspaces', legacy, 'index.sqlite');
  if (fs.existsSync(legacyDb) && !fs.existsSync(paths.sqlitePath)) {
    fs.mkdirSync(path.dirname(paths.sqlitePath), { recursive: true });
    try {
      const db = new DatabaseSync(legacyDb, { readOnly: true });
      try {
        db.prepare('VACUUM INTO ?').run(paths.sqlitePath);
      } finally {
        db.close();
      }
      adopted.push(path.relative(g, paths.sqlitePath));
    } catch {
      if (fs.existsSync(paths.sqlitePath)) fs.rmSync(paths.sqlitePath, { force: true });
    }
  }
  if (adopted.length) {
    try {
      writeFileAtomicSync(path.join(paths.migrationsDir, `adopt-${current}.json`), `${JSON.stringify({
        kind: 'adopt_repo_id', from: legacy, to: current, root: paths.projectRoot, copied: adopted, at: new Date().toISOString(),
        rollback: '删除 copied 中列出的新目录即可回到旧标识；旧目录未改动。',
      }, null, 2)}\n`);
    } catch {
      // the manifest is informational; the copy itself already succeeded
    }
  }
  return { adopted };
}

function moveAsideCorrupt(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = file + suffix;
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.corrupt.${Date.now()}.bak`);
  }
}

function rekeyWorkspaceRows(db: DatabaseSync, from: string, to: string): void {
  if (!from || from === to) return;
  const has = db.prepare("SELECT 1 FROM entries WHERE workspace_id = ? LIMIT 1").get(from)
    ?? db.prepare("SELECT 1 FROM capture_assessments WHERE workspace_id = ? LIMIT 1").get(from)
    ?? db.prepare("SELECT 1 FROM usage_events WHERE workspace_id = ? LIMIT 1").get(from);
  if (!has) return;
  db.exec('BEGIN');
  try {
    for (const table of WORKSPACE_KEYED_TABLES) {
      try {
        db.prepare(`UPDATE OR REPLACE ${table} SET workspace_id = ? WHERE workspace_id = ?`).run(to, from);
      } catch {
        // table absent in this schema version
      }
    }
    db.prepare(`UPDATE capture_assessments SET source_fingerprint = ? || substr(source_fingerprint, ?)
      WHERE source_fingerprint LIKE ?`).run(`[${JSON.stringify(to)},`, `[${JSON.stringify(from)},`.length + 1, `[${JSON.stringify(from)},%`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
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
  tags: string[];
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
    ...(row.scope_meta_json ? (JSON.parse(row.scope_meta_json) as Partial<KnowledgeEntry>) : {}),
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
  private actorOverride: string | undefined;
  private resolvedActor: string | undefined;

  /** Stable identity of this repository (repo.json → Git remote → folder path). */
  identity: RepoIdentity;
  readonly registry: RepoRegistry;
  readonly feedback: CrossRepoFeedback;
  private readonly projectDirName: string;
  private contextProvider: (() => Partial<SessionContext>) | null = null;
  private repoDependencies: Record<string, string>;
  /** Index sources other than this repository and `__global__`: other repositories' committed entries. */
  private foreignSources: Array<{ repoId: string; dir: string }> = [];
  private sourceMtimes = new Map<string, number>();
  private lastSourceCheck = 0;
  private feedbackCache: { at: number; map: Map<string, LocalFeedback> } | null = null;

  constructor(options: LocalStoreOptions) {
    this.projectDirName = options.projectDirName ?? '.accremind';
    this.identity = resolveRepoIdentity(options.projectRoot, this.projectDirName);
    this.paths = resolveStorePaths({ ...options, workspaceId: options.workspaceId ?? this.identity.repoId });
    if (options.workspaceId && options.workspaceId !== this.identity.repoId) {
      this.identity = { ...this.identity, repoId: options.workspaceId };
    }
    this.workspaceId = this.paths.workspaceId;
    this.maxProbationExposures = options.maxProbationExposures ?? 3;
    this.actorOverride = options.actor;
    if (!options.workspaceId) adoptLegacyWorkspace(this.paths);
    this.events = new EventLog(this.paths.eventsDir);
    ensureStoreDirectoriesSync(this.paths);
    this.db = this.openDatabaseWithSelfHeal();
    if (!options.workspaceId) rekeyWorkspaceRows(this.db, this.paths.legacyWorkspaceId, this.workspaceId);
    this.shareLedger = options.shareLedger ?? (() => false);
    this.snapshots = new EvidenceSnapshots({
      projectRoot: this.paths.projectRoot, repoDir: this.paths.evidenceDir, localDir: this.paths.localEvidenceDir,
      globalDir: this.paths.globalEvidenceDir, actor: () => this.actor,
    });
    this.ledger = new ValidationLedger({
      repoDir: this.paths.ledgerDir, localDir: this.paths.localLedgerDir, globalDir: this.paths.globalLedgerDir,
      shared: () => this.shareLedger(), actor: () => this.actor,
    });
    this.registry = new RepoRegistry(this.paths.registryFile, this.paths.locksDir);
    this.feedback = new CrossRepoFeedback(this.paths.feedbackDir, this.paths.locksDir);
    this.repoDependencies = readRepoDependencies(this.paths.projectRoot);
    this.tuning = loadTuning(path.join(this.paths.globalRoot, 'tuning.json'));
    this.docs = new DocLibrary(this);
    const previous = this.registry.get(this.workspaceId);
    if (!this.identity.domains.length && previous?.domains?.length) this.identity = { ...this.identity, domains: previous.domains };
    try {
      this.registry.upsert({ ...registryRecordFor(this.identity, this.paths.projectRoot, previous?.languages ?? []) });
    } catch (err) {
      console.warn(`[accremind] repository registry not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-reads this repository's dependency manifests (they change with upgrades during a session). */
  refreshRepoDependencies(): Record<string, string> {
    this.repoDependencies = readRepoDependencies(this.paths.projectRoot);
    return this.repoDependencies;
  }

  /**
   * Flags shared entries for a fresh look in this repository when a dependency they depend on changed major
   * version (or was removed) here since the last check. Nothing is written to the shared cards.
   */
  reviewSharedEntriesForDependencyChanges(): Array<{ entryId: string; reason: string }> {
    const deps = this.refreshRepoDependencies();
    const previous = new Map((this.stmt('SELECT name, version FROM dependency_snapshot').all() as Array<{ name: string; version: string }>)
      .map((r) => [r.name, r.version]));
    const major = (v: string) => /(\d+)/.exec(v)?.[1] ?? v;
    const changed = new Map<string, string>();
    if (previous.size) {
      for (const [name, before] of previous) {
        const now = deps[name];
        if (now === undefined) changed.set(name, `本仓库已移除依赖 ${name}`);
        else if (major(now) !== major(before)) changed.set(name, `本仓库依赖 ${name} 从 ${before} 变为 ${now}`);
      }
    }
    const flagged: Array<{ entryId: string; reason: string }> = [];
    if (changed.size) {
      const now = new Date().toISOString();
      for (const item of this.servingSnapshot().items) {
        if (item.workspaceId === this.workspaceId || item.entry.status !== 'active') continue;
        const names = [...item.entry.dependency_constraints, ...(item.entry.applies_to?.dependencies ?? [])].map((d) => d.name);
        const hit = names.find((n) => changed.has(n));
        if (!hit) continue;
        const reason = `${changed.get(hit)}，请核对这条共享经验是否仍然适用`;
        this.stmt(`INSERT OR REPLACE INTO shared_reviews (entry_id, revision, reason, created_at) VALUES (?, ?, ?, ?)`)
          .run(item.entry.id, item.entry.revision, reason, now);
        flagged.push({ entryId: item.entry.id, reason });
      }
    }
    this.beginWrite();
    try {
      this.stmt('DELETE FROM dependency_snapshot').run();
      const ins = this.stmt('INSERT INTO dependency_snapshot (name, version) VALUES (?, ?)');
      for (const [name, version] of Object.entries(deps)) ins.run(name, String(version));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return flagged;
  }

  /** Shared entries this repository should re-check (current revision only). */
  listSharedReviews(): Array<{ entryId: string; revision: number; reason: string; createdAt: string }> {
    return (this.stmt('SELECT entry_id, revision, reason, created_at FROM shared_reviews ORDER BY created_at DESC').all() as
      Array<{ entry_id: string; revision: number; reason: string; created_at: string }>)
      .map((r) => ({ entryId: r.entry_id, revision: Number(r.revision), reason: r.reason, createdAt: r.created_at }));
  }

  clearSharedReview(entryId: string): void {
    this.stmt('DELETE FROM shared_reviews WHERE entry_id = ?').run(entryId);
  }

  private identityProvider: IdentityProvider | null = null;
  private localIdentity: LocalIdentityProvider | null = null;

  /** The person using this store: a signed-in identity from the host, otherwise this machine's local user. */
  currentUser(): UserIdentity {
    if (this.identityProvider) return this.identityProvider.current();
    if (!this.localIdentity) {
      this.localIdentity = new LocalIdentityProvider(path.join(this.paths.globalRoot, 'users'));
      if (!this.actor.startsWith('local:')) this.localIdentity.addEmail(this.actor);
    }
    return this.localIdentity.current();
  }

  /**
   * Lets a host with real sign-in supply the user (e.g. a DSH account). The local user is linked to it, so
   * personal entries written before sign-in still belong to the same person.
   */
  setUserIdentity(input: { provider: string; id: string; displayName?: string; emails?: string[] } | null): UserIdentity {
    if (!input) {
      this.identityProvider = null;
      return this.currentUser();
    }
    this.currentUser();
    this.identityProvider = new HostIdentityProvider(input, this.localIdentity ?? undefined);
    return this.identityProvider.current();
  }

  /** Lets the host supply per-turn signals (languages, active files, error text) for relevance. */
  setSessionContextProvider(provider: (() => Partial<SessionContext>) | null): void {
    this.contextProvider = provider;
  }

  /** Updates this repository's languages (detected in the background) in the registry and the default context. */
  updateRepoProfile(update: { languages?: string[]; domains?: string[] }): void {
    if (update.domains) this.identity = { ...this.identity, domains: [...new Set(update.domains)] };
    const prev = this.registry.get(this.workspaceId);
    this.registry.upsert({
      ...registryRecordFor(this.identity, this.paths.projectRoot, update.languages ?? prev?.languages ?? []),
      domains: this.identity.domains,
    });
  }

  /** The signals relevance is judged on for this session; host-supplied values override the defaults. */
  sessionContext(override: Partial<SessionContext> = {}): SessionContext {
    const host = this.contextProvider?.() ?? {};
    const rec = this.registry.get(this.workspaceId);
    return {
      repoId: this.workspaceId,
      orgId: this.identity.org,
      userId: this.currentUser().userId,
      userAliases: this.currentUser().aliases,
      domains: this.identity.domains,
      languages: rec?.languages ?? [],
      dependencies: this.repoDependencies,
      ...host,
      ...override,
    };
  }

  /** Index sources whose rows this repository may write (its own and the machine-wide folders). */
  isOwnedSource(sourceId: string): boolean {
    return sourceId === this.workspaceId || sourceId === GLOBAL_WORKSPACE_ID;
  }

  /** Index source an entry is read from (this repository, `__global__`, or another repository's ID). */
  findOwner(entryId: string): string | null {
    return this.findRawEntryRow(entryId)?.workspace_id ?? null;
  }

  private assertOwnedRow(row: { workspace_id: string; id: string }): void {
    if (!this.isOwnedSource(row.workspace_id)) {
      throw new Error(`条目 ${row.id} 属于仓库 ${row.workspace_id}，只能在该仓库中修改；在这里可以反馈“不适用”或验证结果。`);
    }
  }

  private globalLockPath(): string {
    return path.join(this.paths.locksDir, 'machine-wide.lock');
  }

  /** Writes to machine-wide folders are serialised across every repository's process, not just this one's. */
  private withMachineWideLock<T>(needed: boolean, fn: () => T): T {
    return needed ? withFileLock(this.globalLockPath(), fn) : fn();
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
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      migrateSchema(db as never);
    } catch (err) {
      // Busy, locked or permission errors are transient or environmental: surface them, never discard data.
      if (!isSqliteCorruptionError(err)) throw err;
      // Only a genuinely corrupt file is moved aside (kept for recovery) and rebuilt from the Markdown source.
      moveAsideCorrupt(this.paths.sqlitePath);
      db = new DatabaseSync(this.paths.sqlitePath);
      db.exec(ACCREMIND_SQLITE_DDL);
      migrateSchema(db as never);
    }
    try {
      this.attachGlobalIndex(db);
    } catch (err) {
      if (!isSqliteCorruptionError(err)) {
        db.close();
        throw err;
      }
      // The shared index is derived from the cards: a corrupt copy is set aside and rebuilt.
      try {
        db.exec('DETACH DATABASE g');
      } catch {
        // not attached
      }
      moveAsideCorrupt(this.paths.globalIndexPath);
      this.attachGlobalIndex(db);
    }
    return db;
  }

  /** Attaches `index/global.sqlite` as schema `g`, creating or (on a version change) rebuilding its tables. */
  private attachGlobalIndex(db: DatabaseSync): void {
    fs.mkdirSync(path.dirname(this.paths.globalIndexPath), { recursive: true });
    db.prepare('ATTACH DATABASE ? AS g').run(this.paths.globalIndexPath);
    const version = Number((db.prepare('PRAGMA g.user_version').get() as { user_version: number }).user_version) || 0;
    if (version !== 0 && version !== ACCREMIND_INDEX_SCHEMA_VERSION) db.exec(ACCREMIND_INDEX_DROP);
    db.exec(ACCREMIND_INDEX_DDL);
    if (version !== ACCREMIND_INDEX_SCHEMA_VERSION) db.exec(`PRAGMA g.user_version = ${ACCREMIND_INDEX_SCHEMA_VERSION}`);
    // A query against the shared index surfaces a corrupt file here rather than mid-session.
    db.prepare('SELECT COUNT(*) FROM g.entries').get();
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
    // Other repositories' processes commit to the shared index; its data_version tells this connection.
    const dataVersion = Number((this.stmt('PRAGMA g.data_version').get() as { data_version: number }).data_version);
    if (this.snapshot && this.snapshot.dataVersion === dataVersion) return this.snapshot;
    // Every indexed source: this repository, the machine-wide folders and other repositories' shareable entries.
    const rows = this.stmt('SELECT * FROM entries').all() as unknown as EntryRow[];
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
        tags: entry.tags ?? [],
      };
    });
    this.snapshot = { dataVersion, items };
    return this.snapshot;
  }

  private invalidateSnapshot(): void {
    this.snapshot = null;
    this.candidateCache = null;
    this.localIndexVersion += 1;
  }

  /** Parsed rows, reused while the card content (hash) and the vocabulary are unchanged. */
  private parseCache = new Map<string, { sha: string; vocab: number; item: SnapshotItem }>();

  private itemFromRow(row: EntryRow): SnapshotItem {
    const key = `${row.workspace_id}::${row.id}`;
    const vocab = this.vocabularyVersion();
    const cached = this.parseCache.get(key);
    if (cached && cached.sha === row.content_sha256 && cached.vocab === vocab &&
        cached.item.exposures === row.probation_exposures && cached.item.zone === row.storage_zone) return cached.item;
    const entry = rowToEntry(row);
    const item: SnapshotItem = {
      key,
      workspaceId: row.workspace_id,
      zone: row.storage_zone,
      exposures: row.probation_exposures,
      entry,
      aliasesLc: entry.search_aliases.join(' ').toLowerCase(),
      titleLc: entry.title.toLowerCase(),
      bodyLc: `${entry.claim} ${entry.knowledge_delta}`.toLowerCase(),
      anchorFiles: new Set(entry.symbol_anchors.map((a) => a.file_path)),
      globs: entry.watch_paths.map((glob) => ({ glob, prefix: globLiteralPrefix(glob) })),
      tags: this.tagsForEntry(entry),
    };
    if (this.parseCache.size > 50_000) this.parseCache.clear();
    this.parseCache.set(key, { sha: row.content_sha256, vocab, item });
    return item;
  }

  /**
   * Applicability pre-filter in SQL: only rows that may be served in this session (plus keyword hits) are read.
   * Language/dependency conditions and relevance thresholds are then checked on this small set.
   */
  private candidateItems(ctx: SessionContext, scope: 'auto' | 'repo' | 'all', extraRowids: number[]): SnapshotItem[] {
    const owners = JSON.stringify([ctx.userId ?? '', ...(ctx.userAliases ?? [])]);
    const domains = JSON.stringify(ctx.domains ?? []);
    // The scoped set only changes when the index does: cached per scope and shared-index data_version
    // (our own writes reset it through invalidateSnapshot()).
    const dataVersion = Number((this.stmt('PRAGMA g.data_version').get() as { data_version: number }).data_version);
    const cacheKey = `${dataVersion}|${this.localIndexVersion}|${scope}|${ctx.repoId}|${owners}|${domains}|${this.vocabularyVersion()}`;
    let base = this.candidateCache?.key === cacheKey ? this.candidateCache.items : null;
    if (!base) {
      base = this.scopedRows(ctx.repoId, scope, owners, domains);
      this.candidateCache = { key: cacheKey, items: base };
    }
    const out = new Map<string, SnapshotItem>(base.map((i) => [i.key, i]));
    if (extraRowids.length) {
      const extra = this.stmt(`SELECT * FROM entries WHERE rowid IN (SELECT value FROM json_each(?)) AND status IN ('active', 'probation')`)
        .all(JSON.stringify([...new Set(extraRowids)])) as unknown as EntryRow[];
      for (const row of extra) {
        const key = `${row.workspace_id}::${row.id}`;
        if (!out.has(key)) out.set(key, this.itemFromRow(row));
      }
    }
    return [...out.values()];
  }

  private candidateCache: { key: string; items: SnapshotItem[] } | null = null;
  /** Bumped on every write through this connection (data_version only reports other connections). */
  private localIndexVersion = 0;

  private scopedRows(repoId: string, scope: 'auto' | 'repo' | 'all', owners: string, domains: string): SnapshotItem[] {
    const rows = this.stmt(
      `SELECT * FROM entries
       WHERE status IN ('active', 'probation') AND (
         workspace_id = ?
         OR (? != 'repo' AND workspace_id = ? AND (layer != 'personal' OR owner IS NULL OR owner IN (SELECT value FROM json_each(?))))
         OR (? = 'repo' AND workspace_id = ? AND layer != 'personal' AND json_extract(scope_meta_json, '$.origin_repo') = ?)
         OR (? != 'repo' AND workspace_id NOT IN (?, ?) AND status = 'active' AND layer = 'domain'
             AND EXISTS (SELECT 1 FROM json_each(?) d WHERE entries.domains_csv LIKE '%,' || d.value || ',%'))
         OR (? = 'all' AND workspace_id NOT IN (?, ?) AND status = 'active' AND layer IN ('project', 'team_rule'))
       )`,
    ).all(
      repoId,
      scope, GLOBAL_WORKSPACE_ID, owners,
      scope, GLOBAL_WORKSPACE_ID, repoId,
      scope, repoId, GLOBAL_WORKSPACE_ID, domains,
      scope, repoId, GLOBAL_WORKSPACE_ID,
    ) as unknown as EntryRow[];
    return rows.map((row) => this.itemFromRow(row));
  }

  /** Retrieval knobs (`~/.dsh/accremind/tuning.json` over the defaults); `accremind eval` replaces them in memory. */
  tuning: RetrievalTuning = DEFAULT_TUNING;

  setTuning(tuning: RetrievalTuning): void {
    this.tuning = tuning;
  }

  // ---- topic tags (controlled vocabulary; see `vocabulary.ts`) ----
  private vocabularyVersion(): number {
    return this.vocabulary?.version ?? 0;
  }

  /** Vocabulary tags named by a piece of text (lexical, always available). */
  tagsForText(text: string): string[] {
    return this.vocabulary ? this.vocabulary.tagText(text) : [];
  }

  /** An entry's tags: those set on the card plus the vocabulary terms it names. */
  tagsForEntry(entry: KnowledgeEntry): string[] {
    const own = entry.tags ?? [];
    if (!this.vocabulary) return own;
    return [...new Set([...own, ...this.vocabulary.tagText(`${entry.title} ${entry.search_aliases.join(' ')} ${entry.claim} ${(entry.domains ?? []).join(' ')}`)])];
  }

  tagLabel(tagId: string): string {
    return this.vocabulary?.label(tagId) ?? tagId;
  }

  /** Controlled vocabulary of topic tags (built by the document library; refreshed at the start of each search). */
  vocabulary: { version: number; tagText(text: string): string[]; label(id: string): string } | null = null;

  /** Rule document sets of this repository (and shareable ones of repositories in the same domain). */
  docs!: DocLibrary;

  searchDocs(input: { query: string; tags?: string[]; activeFiles?: string[]; errorText?: string; limit?: number }) {
    const ctx = this.sessionContext({ ...(input.activeFiles ? { activeFiles: input.activeFiles } : {}), ...(input.errorText ? { errorText: input.errorText } : {}) });
    return this.docs.search({ query: `${input.query} ${input.errorText ?? ''}`.trim(), ctx, tags: input.tags, limit: input.limit });
  }

  residentProfile(maxTokens = 300): string {
    try {
      return this.docs.residentProfile(maxTokens);
    } catch {
      return '';
    }
  }

  private refreshVocabulary(): void {
    try {
      this.vocabulary = this.docs.vocabulary();
    } catch {
      // keep the previous vocabulary
    }
  }

  /**
   * Serialises writes to this workspace across processes (DSH, the standalone workbench, the CLI).
   * A lock file older than 30 s is treated as left behind by a crashed process and taken over.
   */
  private withWriteLock<T>(fn: () => T): T {
    return withFileLock(path.join(path.dirname(this.paths.sqlitePath), 'write.lock'), fn, {
      waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS,
    });
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
    this.beginWrite();
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
    try {
      paused.push(...this.applyCrossRepoFeedback());
    } catch (err) {
      console.warn(`[accremind] cross-repository feedback skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
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

    // Dashboard numbers are about this repository and this machine's own library, not other repositories'.
    const items = this.servingSnapshot().items.filter((i) => this.isOwnedSource(i.workspaceId));
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
  recordInapplicable(entryId: string, sessionId: string, detail: string): { suspended: boolean; reports: number; suppressedHere?: boolean } {
    const row = this.findRawEntryRow(entryId);
    if (!row) throw new Error(`未找到条目: ${entryId}`);
    const entry = rowToEntry(row);
    this.recordUsage({ workspace_id: row.workspace_id, session_id: sessionId, entry_id: entry.id, revision: entry.revision, event_type: 'feedback_inapplicable', detail });
    this.feedbackCache = null;
    const owned = this.isOwnedSource(row.workspace_id);
    if (owned) {
      try {
        this.ledger.append(entry, { kind: 'inapplicable', task: `session:${sessionId}`, note: detail });
      } catch (err) {
        console.warn(`[accremind] ledger write skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.emit('entry.feedback_inapplicable', entry, detail ? { detail } : undefined);

    // Shared entries: "doesn't apply" is first a statement about this repository. It stops the entry here;
    // only several repositories agreeing (with no confirmation anywhere) pauses it everywhere.
    if (isCrossRepoLayer(entry.layer)) {
      try {
        this.feedback.append(entry.id, { repo: this.workspaceId, revision: entry.revision, kind: 'inapplicable', session: sessionId });
      } catch (err) {
        console.warn(`[accremind] cross-repository feedback not written: ${err instanceof Error ? err.message : String(err)}`);
      }
      const standing = this.feedback.standing(entry.id, entry.revision);
      const reports = standing.inapplicableSessionsByRepo[this.workspaceId] ?? 0;
      const suppressedHere = reports >= REPO_SUPPRESS_SESSIONS;
      if (owned && standing.shouldSuspendGlobally && entry.serving === 'enabled' && !transitionBlocker(entry, 'suspend')) {
        this.updateExistingEntryDirect(transition(entry, 'suspend'));
        this.emit('entry.suspended', entry, { reason: 'inapplicable_reports', repos: standing.suppressedRepos });
        this.raiseAttention(entry, 'inapplicable', `已有 ${standing.suppressedRepos.length} 个仓库反馈“不适用”，已在所有仓库暂停推荐。请收窄适用条件（技术栈、领域）、修订或下线。`);
        return { suspended: true, reports, suppressedHere };
      }
      return { suspended: false, reports, suppressedHere };
    }

    const counts = this.stmt(
        `SELECT
           (SELECT COUNT(DISTINCT session_id) FROM usage_events WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND event_type = 'feedback_inapplicable') AS reports,
           (SELECT COUNT(*) FROM validation_records WHERE workspace_id = ? AND entry_id = ? AND revision = ? AND outcome = 'success') AS successes`,
      )
      .get(row.workspace_id, entry.id, entry.revision, row.workspace_id, entry.id, entry.revision) as { reports: number; successes: number };
    const reports = Number(counts.reports);
    if (owned && reports >= INAPPLICABLE_SUSPEND_THRESHOLD && Number(counts.successes) === 0 && entry.serving === 'enabled') {
      this.updateExistingEntryDirect(transition(entry, 'suspend'));
      this.emit('entry.suspended', entry, { reason: 'inapplicable_reports', reports });
      this.raiseAttention(entry, 'inapplicable', `已有 ${reports} 次反馈“不适用”，已暂停推荐。请收窄适用条件、修订或下线。`);
      return { suspended: true, reports };
    }
    return { suspended: false, reports };
  }

  /**
   * Applies what other repositories reported about shared entries this repository (or this machine) owns:
   * a counterexample anywhere, or "doesn't apply" from several repositories with no confirmation, pauses it.
   */
  applyCrossRepoFeedback(): string[] {
    const paused: string[] = [];
    for (const fileId of this.feedback.entryIds()) {
      const row = this.findRawEntryRow(fileId);
      if (!row || !this.isOwnedSource(row.workspace_id)) continue;
      const entry = rowToEntry(row);
      // Signals about earlier wording no longer count; keep the file small.
      try {
        this.feedback.compact(fileId, entry.revision);
      } catch {
        // another process holds the file; next maintenance compacts it
      }
      if (!isCrossRepoLayer(entry.layer) || entry.serving !== 'enabled') continue;
      if (entry.status !== 'active' && entry.status !== 'probation') continue;
      const standing = this.feedback.standing(entry.id, entry.revision);
      if (!standing.shouldSuspendGlobally || transitionBlocker(entry, 'suspend')) continue;
      this.updateExistingEntryDirect(transition(entry, 'suspend'));
      const why = standing.failureRepos.length
        ? `仓库 ${standing.failureRepos.join('、')} 报告了反例`
        : `${standing.suppressedRepos.length} 个仓库反馈“不适用”`;
      this.emit('entry.suspended', entry, { reason: 'cross_repo_feedback', repos: standing.suppressedRepos, failures: standing.failureRepos });
      this.raiseAttention(entry, 'inapplicable', `${why}，已在所有仓库暂停推荐。请复核后修订、收窄适用条件或恢复。`);
      paused.push(entry.id);
    }
    return paused;
  }

  private ownerWorkspaceForZone(zone: StorageZone): string {
    return isMachineWideZone(zone) ? GLOBAL_WORKSPACE_ID : this.workspaceId;
  }

  /** Every folder the index is built from: this repository, the machine-wide folders, then other repositories. */
  private sourceScans(): Array<{ zone: StorageZone; dir: string; wsId: string; foreign: boolean }> {
    return [
      { zone: 'rules', dir: this.paths.projectRulesDir, wsId: this.workspaceId, foreign: false },
      { zone: 'project', dir: this.paths.projectEntriesDir, wsId: this.workspaceId, foreign: false },
      { zone: 'probation', dir: this.paths.probationDir, wsId: this.workspaceId, foreign: false },
      { zone: 'personal', dir: this.paths.personalDir, wsId: GLOBAL_WORKSPACE_ID, foreign: false },
      { zone: 'shared_tech', dir: this.paths.sharedTechDir, wsId: GLOBAL_WORKSPACE_ID, foreign: false },
      { zone: 'domain', dir: this.paths.domainDir, wsId: GLOBAL_WORKSPACE_ID, foreign: false },
      ...this.foreignSources.map((f) => ({ zone: 'project' as StorageZone, dir: f.dir, wsId: f.repoId, foreign: true })),
    ];
  }

  /** Other registered repositories whose committed entries may be served here (domain knowledge, `scope: all`). */
  private discoverForeignSources(): void {
    const me = path.resolve(this.paths.projectRoot);
    const seen = new Set<string>();
    const out: Array<{ repoId: string; dir: string }> = [];
    for (const rec of this.registry.list()) {
      if (rec.repo_id === this.workspaceId || rec.repo_id === GLOBAL_WORKSPACE_ID || path.resolve(rec.root) === me) continue;
      if (seen.has(rec.repo_id)) continue;
      const dir = path.join(rec.root, this.projectDirName, 'entries');
      if (!fs.existsSync(dir)) continue;
      seen.add(rec.repo_id);
      out.push({ repoId: rec.repo_id, dir });
    }
    this.foreignSources = out;
  }

  // ---- short write transactions on the shared index ----
  /**
   * The index is shared by every repository's process, and SQLite allows one writer at a time. Long scans are
   * therefore committed in small batches (the write lock is held for one batch, not the whole scan), and taking
   * the lock retries with back-off on top of the busy timeout.
   */
  private batchOpen = false;
  private batchFiles = 0;
  /** Batches committed by the last reconcile (exposed for diagnostics and tests). */
  lastReconcileBatches = 0;
  static readonly BATCH_FILES = 200;

  private beginWrite(): void {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        return;
      } catch (err) {
        const busy = /SQLITE_BUSY|database is locked/i.test(err instanceof Error ? err.message : String(err));
        if (!busy || attempt >= 4) throw err;
        sleepMs(50 * 2 ** attempt);
      }
    }
  }

  private beginBatch(): void {
    this.beginWrite();
    this.batchOpen = true;
    this.batchFiles = 0;
    this.lastReconcileBatches = 1;
  }

  private batchTick(): void {
    if (!this.batchOpen) return;
    this.batchFiles += 1;
    if (this.batchFiles < LocalMarkdownSqliteStore.BATCH_FILES) return;
    this.db.exec('COMMIT');
    this.beginWrite();
    this.batchFiles = 0;
    this.lastReconcileBatches += 1;
  }

  private endBatch(ok: boolean): void {
    this.batchOpen = false;
    this.db.exec(ok ? 'COMMIT' : 'ROLLBACK');
  }

  /** Indexes one folder. Returns the keys it saw. Foreign folders are read-only and only contribute shareable layers. */
  private scanSource(
    source: { zone: StorageZone; dir: string; wsId: string; foreign: boolean },
    counters: { synced: number; corrupted: number },
    seenKeys: Set<string>,
    seenPaths: Map<string, string>,
  ): void {
    const { zone, dir, wsId, foreign } = source;
    try {
      this.sourceMtimes.set(`${wsId}::${dir}`, fs.statSync(dir).mtimeMs);
    } catch {
      return;
    }
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && !name.startsWith('.')).sort();
    for (const fileName of files) {
      this.batchTick();
      const fullPath = path.join(dir, fileName);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      // Fast path: an indexed file whose size and mtime are unchanged is not re-read.
      const known = this.stmt('SELECT id, workspace_id, file_mtime_ms, file_size FROM entries WHERE file_path = ?')
        .get(fullPath) as { id: string; workspace_id: string; file_mtime_ms: number | null; file_size: number | null } | undefined;
      if (known && known.workspace_id === wsId && known.file_mtime_ms === Math.trunc(stat.mtimeMs) && known.file_size === stat.size) {
        const knownKey = `${wsId}::${known.id}`;
        if (!seenKeys.has(knownKey)) {
          seenKeys.add(knownKey);
          seenPaths.set(knownKey, path.relative(this.paths.projectRoot, fullPath) || fullPath);
          counters.synced += 1;
          continue;
        }
      }
      const rawMd = fs.readFileSync(fullPath, 'utf8');
      const contentHash = sha256Hex(rawMd);
      try {
        const parsed = parseEntryMarkdown(rawMd, fullPath);
        if (foreign) {
          // Another repository's project knowledge is indexed for explicit `scope: all` searches only; its trials,
          // rules and anything misfiled stay out.
          if ((parsed.layer !== 'domain' && parsed.layer !== 'project') || parsed.status === 'probation' || parsed.status === 'candidate') continue;
        } else {
          checkLayerStorage(parsed.layer, zone);
        }
        const seenKey = `${wsId}::${parsed.id}`;
        if (seenKeys.has(seenKey)) {
          if (foreign) continue;
          // Zones are scanned rules → project → probation: the confirmed copy wins and the stale one is reported.
          throw new Error(`编号 ${parsed.id} 与 ${seenPaths.get(seenKey) ?? '另一文件'} 重复，已忽略此副本，请在治理中删除或重新编号`);
        }
        seenKeys.add(seenKey);
        seenPaths.set(seenKey, path.relative(this.paths.projectRoot, fullPath) || fullPath);
        const existing = this.stmt('SELECT content_sha256, probation_exposures FROM entries WHERE workspace_id = ? AND id = ?')
          .get(wsId, parsed.id) as { content_sha256: string; probation_exposures: number } | undefined;
        if (!existing || existing.content_sha256 !== contentHash) {
          this.indexEntryRow(wsId, zone, fullPath, contentHash, parsed, existing?.probation_exposures ?? 0);
        } else {
          this.stmt('UPDATE entries SET file_path = ?, file_mtime_ms = ?, file_size = ? WHERE workspace_id = ? AND id = ?')
            .run(fullPath, Math.trunc(stat.mtimeMs), stat.size, wsId, parsed.id);
        }
        counters.synced += 1;
      } catch (err) {
        // Problems in another repository's files are that repository's to fix; they are not listed here.
        if (foreign) continue;
        counters.corrupted += 1;
        const reason =
          err instanceof MergeConflictError
            ? `Git 合并冲突未解决: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        this.stmt('INSERT OR REPLACE INTO corrupted_files (file_path, workspace_id, reason, detected_at) VALUES (?, ?, ?, ?)')
          .run(fullPath, wsId, reason, new Date().toISOString());
      }
    }
  }

  /**
   * The index is shared: only rows from folders this repository just scanned are pruned (a file that is
   * gone), plus rows of repositories no longer registered on this machine. Other repositories' trials and
   * rows stay for their own processes.
   */
  private pruneIndex(scanned: Array<{ dir: string; wsId: string }>, seenKeys: Set<string>): void {
    const dirs = new Set(scanned.map((s) => `${s.wsId}::${path.resolve(s.dir)}`));
    const known = new Set([this.workspaceId, GLOBAL_WORKSPACE_ID, ...this.registry.list().map((r) => r.repo_id)]);
    const rows = this.stmt('SELECT workspace_id, id, file_path FROM entries').all() as Array<{ workspace_id: string; id: string; file_path: string }>;
    for (const r of rows) {
      if (seenKeys.has(`${r.workspace_id}::${r.id}`)) continue;
      if (!known.has(r.workspace_id) || dirs.has(`${r.workspace_id}::${path.dirname(path.resolve(r.file_path))}`)) {
        this.deleteIndexedEntry(r.workspace_id, r.id);
      }
    }
  }

  initializeAndReconcile(): { syncedCount: number; corruptedCount: number } {
    this.stmt(`UPDATE capture_assessments SET review_state = 'pending'
      WHERE workspace_id = ? AND disposition = 'needs_confirmation'
      AND review_state = 'decided' AND decided_at IS NULL`).run(this.workspaceId);
    ensureStoreDirectoriesSync(this.paths);
    this.discoverForeignSources();
    const counters = { synced: 0, corrupted: 0 };
    const seenKeys = new Set<string>();
    const seenPaths = new Map<string, string>();

    this.beginBatch();
    try {
      this.stmt('DELETE FROM corrupted_files WHERE workspace_id IN (?, ?)').run(this.workspaceId, GLOBAL_WORKSPACE_ID);
      const scanned = this.sourceScans();
      for (const source of scanned) {
        if (fs.existsSync(source.dir)) this.scanSource(source, counters, seenKeys, seenPaths);
      }
      this.pruneIndex(scanned, seenKeys);
      this.endBatch(true);
    } catch (err) {
      this.endBatch(false);
      throw err;
    }
    try {
      this.sourceMtimes.set('registry', fs.statSync(this.paths.registryFile).mtimeMs);
    } catch {
      // no registry file
    }
    this.lastSourceCheck = Date.now();
    this.feedbackCache = null;
    try {
      this.docs.reconcile();
      this.refreshVocabulary();
      this.candidateCache = null;
    } catch (err) {
      console.warn(`[accremind] rule documents not indexed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { syncedCount: counters.synced, corruptedCount: counters.corrupted };
  }

  /**
   * Other processes (another repository's session writing a shared entry, a `git pull` in a repository
   * whose domain knowledge is served here) change folders this index does not own. Folder mtimes are
   * compared on each search and lookup; a changed folder is re-scanned on its own.
   */
  refreshSourcesIfChanged(force = false): boolean {
    // Only folder `stat`s on the hot path: cheap enough to run on every search.
    void force;
    this.lastSourceCheck = Date.now();
    let registryChanged = false;
    try {
      const m = fs.statSync(this.paths.registryFile).mtimeMs;
      registryChanged = this.sourceMtimes.get('registry') !== m;
      this.sourceMtimes.set('registry', m);
    } catch {
      // no registry yet
    }
    if (registryChanged) {
      const before = new Set(this.foreignSources.map((f) => f.repoId));
      this.discoverForeignSources();
      const after = new Set(this.foreignSources.map((f) => f.repoId));
      const removed = [...before].filter((id) => !after.has(id));
      if (removed.length) {
        for (const id of removed) {
          for (const r of this.stmt('SELECT id FROM entries WHERE workspace_id = ?').all(id) as Array<{ id: string }>) this.deleteIndexedEntry(id, r.id);
        }
      }
    }
    const changed = this.sourceScans().filter((src) => {
      if (src.wsId === this.workspaceId) return false; // own folders are written through this store
      try {
        return this.sourceMtimes.get(`${src.wsId}::${src.dir}`) !== fs.statSync(src.dir).mtimeMs;
      } catch {
        return this.sourceMtimes.has(`${src.wsId}::${src.dir}`);
      }
    });
    if (!changed.length) return false;
    this.beginBatch();
    try {
      for (const src of changed) {
        const seenKeys = new Set<string>();
        const counters = { synced: 0, corrupted: 0 };
        if (fs.existsSync(src.dir)) this.scanSource(src, counters, seenKeys, new Map());
        else this.sourceMtimes.delete(`${src.wsId}::${src.dir}`);
        const rows = this.stmt('SELECT id, file_path FROM entries WHERE workspace_id = ? AND storage_zone = ?')
          .all(src.wsId, src.zone) as Array<{ id: string; file_path: string }>;
        for (const r of rows) {
          if (path.dirname(r.file_path) === src.dir && !seenKeys.has(`${src.wsId}::${r.id}`)) this.deleteIndexedEntry(src.wsId, r.id);
        }
      }
      this.endBatch(true);
    } catch (err) {
      this.endBatch(false);
      throw err;
    }
    this.invalidateSnapshot();
    return true;
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
      // The shared index also holds other repositories' trials: only the sources this repository reads are cleared.
      this.discoverForeignSources();
      const owned = [...new Set(this.sourceScans().map((src) => src.wsId))];
      this.beginWrite();
      try {
        for (const wsId of owned) {
          const zones = wsId === this.workspaceId || wsId === GLOBAL_WORKSPACE_ID ? null : ['project'];
          const rows = this.stmt('SELECT id, storage_zone FROM entries WHERE workspace_id = ?').all(wsId) as Array<{ id: string; storage_zone: string }>;
          for (const r of rows) if (!zones || zones.includes(r.storage_zone)) this.deleteIndexedEntry(wsId, r.id);
        }
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
          created_at, updated_at, last_validated_at, review_due_at, scope_meta_json,
          owner, domains_csv, tags_csv
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?
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
        scopeMetaOf(entry),
        entry.layer === 'personal' ? entry.owner ?? null : null,
        entry.domains?.length ? `,${entry.domains.join(',')},` : '',
        entry.tags?.length ? `,${entry.tags.join(',')},` : '',
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
    return this.withWriteLock(() => this.withMachineWideLock(isMachineWideZone(zone), () => this.upsertEntryLocked(entry, zone, assessment)));
  }

  private upsertEntryLocked(
    entry: KnowledgeEntry,
    zone: StorageZone,
    assessment: CaptureAssessment | null,
  ): KnowledgeEntry {
    checkLayerStorage(entry.layer, zone);
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

    this.beginWrite();
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
    const row = this.findRawEntryRow(entry.id);
    return this.withWriteLock(() => this.withMachineWideLock(Boolean(row && isMachineWideZone(row.storage_zone)),
      () => this.updateExistingEntryLocked(entry)));
  }

  private updateExistingEntryLocked(entry: KnowledgeEntry): KnowledgeEntry {
    const row = this.findRawEntryRow(entry.id);
    if (!row) {
      throw new Error(`未找到条目: ${entry.id}`);
    }
    this.assertOwnedRow(row);
    this.assertUnchangedOnDisk(row);
    if (entry.overrides?.length) this.clearAttention(entry.id, 'rule_conflict');
    // The index is shared across repositories (and windows): an edit based on an older revision than the
    // one now on disk would silently undo someone else's change.
    if (entry.revision < row.revision) throw new ConcurrentModificationError(entry.id);
    checkLayerStorage(entry.layer, row.storage_zone);
    const markdown = serializeEntryMarkdown(entry);
    const contentHash = sha256Hex(markdown);
    writeFileAtomicSync(row.file_path, markdown);

    this.beginWrite();
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
         WHERE id = ?
         ORDER BY CASE workspace_id WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, workspace_id
         LIMIT 1`,
      )
      .get(id, this.workspaceId, GLOBAL_WORKSPACE_ID) as EntryRow | undefined;
  }

  getEntry(
    id: string,
    options: {
      sessionId?: string;
      recordUsage?: boolean;
      includeHistoryOrSuspended?: boolean;
    } = {},
  ): GetEntryOutcome {
    try {
      this.refreshSourcesIfChanged();
    } catch {
      // a shared folder that cannot be read right now: serve what is indexed
    }
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

  /**
   * This repository's documented exceptions to team rules: active project entries with an unexpired
   * `overrides` record. A rule without one always wins over project knowledge.
   */
  listRuleWaivers(now = new Date()): Map<string, { entryId: string; reason: string; expiresAt: string }> {
    const out = new Map<string, { entryId: string; reason: string; expiresAt: string }>();
    for (const item of this.servingSnapshot().items) {
      if (item.workspaceId !== this.workspaceId) continue;
      const e = item.entry;
      if (e.status !== 'active' || e.serving !== 'enabled' || !e.overrides?.length) continue;
      for (const o of e.overrides) {
        const exp = Date.parse(o.expires_at);
        if (!o.rule_id || !Number.isFinite(exp) || exp <= now.getTime() || !o.approver?.trim()) continue;
        out.set(o.rule_id, { entryId: e.id, reason: o.reason, expiresAt: o.expires_at });
      }
    }
    return out;
  }

  findSimilarEntries(entry: KnowledgeEntry): Array<{ id: string; layer: KnowledgeEntry['layer']; originRepo: string | null; similarity: number }> {
    const out: Array<{ id: string; layer: KnowledgeEntry['layer']; originRepo: string | null; similarity: number }> = [];
    for (const item of this.servingSnapshot().items) {
      if (item.entry.id === entry.id || item.entry.status === 'withdrawn' || item.entry.status === 'archived') continue;
      const similarity = claimSimilarity(item.entry, entry);
      if (similarity >= DUPLICATE_SIMILARITY) {
        out.push({ id: item.entry.id, layer: item.entry.layer, similarity: Number(similarity.toFixed(2)),
          originRepo: item.entry.origin_repo ?? (item.workspaceId === GLOBAL_WORKSPACE_ID ? null : item.workspaceId) });
      }
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  /** Records that project knowledge contradicts a team rule without a documented exception. */
  reportRuleConflict(entry: KnowledgeEntry, rule: KnowledgeEntry): void {
    if (!this.isOwnedSource(this.findRawEntryRow(entry.id)?.workspace_id ?? '')) return;
    this.raiseAttention(entry, 'rule_conflict',
      `疑似与团队规范 ${rule.id}「${rule.title}」相反，且没有登记豁免。提醒时已注明“以规范为准”。请确认：修订条目、登记豁免（理由、批准人、到期日），或判定不冲突。`);
  }

  /** This repository's own feedback per entry revision (cached briefly; usage rows are written on every turn). */
  private localFeedback(): Map<string, LocalFeedback> {
    if (this.feedbackCache && Date.now() - this.feedbackCache.at < 15_000) return this.feedbackCache.map;
    const map = new Map<string, LocalFeedback>();
    const get = (id: string, rev: number) => {
      const k = `${id}@${rev}`;
      let f = map.get(k);
      if (!f) map.set(k, (f = { inapplicableSessions: 0, shown: 0, used: 0, failures: 0 }));
      return f;
    };
    const usage = this.stmt(`SELECT entry_id, revision, event_type, COUNT(*) AS n, COUNT(DISTINCT session_id) AS s FROM usage_events
      WHERE event_type IN ('feedback_inapplicable', 'radar_shown', 'guard_shown', 'retrieved', 'cited')
      GROUP BY entry_id, revision, event_type`).all() as Array<{ entry_id: string; revision: number; event_type: string; n: number; s: number }>;
    for (const u of usage) {
      const f = get(u.entry_id, Number(u.revision));
      if (u.event_type === 'feedback_inapplicable') f.inapplicableSessions += Number(u.s);
      else if (u.event_type === 'radar_shown' || u.event_type === 'guard_shown') f.shown += Number(u.n);
      else f.used += Number(u.n);
    }
    const vals = this.stmt(`SELECT entry_id, revision, outcome, COUNT(*) AS n FROM validation_records GROUP BY entry_id, revision, outcome`)
      .all() as Array<{ entry_id: string; revision: number; outcome: string; n: number }>;
    for (const v of vals) {
      const f = get(v.entry_id, Number(v.revision));
      if (v.outcome === 'success') f.used += Number(v.n);
      if (v.outcome === 'failure') f.failures += Number(v.n);
    }
    this.feedbackCache = { at: Date.now(), map };
    return map;
  }

  search(params: SearchQuery): SearchResult {
    try {
      this.refreshSourcesIfChanged();
    } catch (err) {
      console.warn(`[accremind] shared folders not refreshed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.refreshVocabulary();
    const wsId = params.workspaceId || this.workspaceId;
    const ctx = this.sessionContext({ ...(params.context ?? {}), repoId: params.context?.repoId ?? wsId });
    const scope = params.scope ?? 'auto';
    const includeProbation = params.includeProbation ?? true;
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    const tokenBudget = params.tokenBudget ?? 4000;
    const dependencies = params.workspaceDependencies ?? ctx.dependencies;
    const feedback = this.localFeedback();
    const nowMs = Date.now();
    const sharedReviews = new Map(this.listSharedReviews().map((r) => [r.entryId, r]));

    const rawTextQuery = params.query?.trim() ?? '';
    const queryLc = `${rawTextQuery} ${ctx.errorText ?? ''}`.toLowerCase();
    const queryIdents = extractIdentifiers(`${rawTextQuery} ${ctx.errorText ?? ''}`);
    const ftsScores = new Map<string, number>();
    const ftsRowids: number[] = [];
    // Topic tags of the question: given by the host (model tagging) plus the vocabulary terms the text names.
    const queryTags = new Set([...(ctx.tags ?? []), ...this.tagsForText(`${rawTextQuery} ${ctx.errorText ?? ''} ${(ctx.activeFiles ?? []).join(' ')}`)]);

    if (rawTextQuery.length > 0) {
      const { ftsTerms } = extractSearchTokens(rawTextQuery);
      if (ftsTerms.length > 0) {
        const matchExpr = ftsTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        // Two buckets so a large shared corpus can never push this repository's own hits out of the cap.
        const buckets = [
          { sql: 'workspace_id = ?', arg: wsId },
          { sql: 'workspace_id != ?', arg: wsId },
        ];
        for (const b of buckets) {
          const ftsRows = this.stmt(
              `SELECT rowid AS rid, workspace_id, id, bm25(entries_fts, 0.0, 0.0, 8.0, 10.0, 4.0, 3.0, 2.0, 1.0) AS rank_score
               FROM entries_fts
               WHERE entries_fts MATCH ?
                 AND ${b.sql}
               ORDER BY rank_score
               LIMIT 400`,
            )
            .all(matchExpr, b.arg) as Array<{ rid: number; workspace_id: string; id: string; rank_score: number }>;
          for (const r of ftsRows) {
            const key = `${r.workspace_id}::${r.id}`;
            const positiveScore = Math.max(0.5, -r.rank_score * 10);
            ftsScores.set(key, (ftsScores.get(key) ?? 0) + positiveScore);
            ftsRowids.push(Number(r.rid));
          }
        }
      }
    }

    // Candidates come from SQL: applicability conditions (this repository, machine-wide layers the asker may
    // see, other repositories' domain knowledge of a shared domain, other repositories' project knowledge only
    // for scope "all") plus every keyword hit. Nothing else is loaded or scored.
    const candidates = this.candidateItems(ctx, scope, ftsRowids);

    if (rawTextQuery.length > 0) {
      const { shortTerms } = extractSearchTokens(rawTextQuery);
      // Exact 2-char CJK bigram boost (e.g. "防重", "丢单", "幂等") where trigram needs >=3 chars.
      if (shortTerms.length > 0) {
        const terms = shortTerms.map((t) => t.toLowerCase());
        for (const item of candidates) {
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
    const tuning = this.tuning;

    for (const item of candidates) {
      const entry = item.entry;
      const row = { workspace_id: item.workspaceId, storage_zone: item.zone, probation_exposures: item.exposures };
      if (params.type && entry.type !== params.type) continue;
      if (params.layer && entry.layer !== params.layer) continue;

      const key = item.key;
      const textScore = ftsScores.get(key) ?? 0;
      const fromHere = item.workspaceId === wsId;

      // Repository-relative paths and symbol anchors only mean something in the repository they came from;
      // elsewhere only declared portable patterns count.
      let pathMatched = false;
      if (relTarget) {
        pathMatched = fromHere
          ? item.anchorFiles.has(relTarget) ||
            item.globs.some(({ glob, prefix }) => relTarget.startsWith(prefix) && path.matchesGlob(relTarget, glob))
          : (entry.portable_patterns ?? []).some((glob) => path.matchesGlob(relTarget, glob));
      }

      const tagOverlap = queryTags.size ? item.tags.filter((t) => queryTags.has(t)).length : 0;
      const tagMatched = tagOverlap > 0;
      if (rawTextQuery.length > 0 && textScore === 0 && !pathMatched && !tagMatched) {
        continue;
      }
      if (!rawTextQuery && params.filePath && !pathMatched) {
        continue;
      }
      if (!rawTextQuery && !params.filePath && !fromHere && item.workspaceId !== GLOBAL_WORKSPACE_ID) {
        continue;
      }

      const applicability = judgeApplicability({ entry, sourceId: item.workspaceId, zone: item.zone }, ctx, GLOBAL_WORKSPACE_ID, scope);
      if (!applicability.ok) continue;
      const verdict: ScopeVerdict = applicability.verdict;

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
      if (dependencies && entry.dependency_constraints.length > 0) {
        let versionCompatible = true;
        for (const dep of entry.dependency_constraints) {
          const installed = dependencies[dep.name];
          if (!installed) continue;
          const verdictV = evaluateSemverRange(installed, dep.range);
          if (verdictV === 'mismatch') {
            versionCompatible = false;
            break;
          }
          if (verdictV === 'unknown') versionUnknown = true;
        }
        if (!versionCompatible) {
          hadVersionExcluded = true;
          continue;
        }
      }
      const stackMismatch = (entry.applies_to?.dependencies ?? []).some((d) => {
        const installed = dependencies?.[d.name];
        return Boolean(installed) && evaluateSemverRange(installed!, d.range) === 'mismatch';
      });
      if (stackMismatch) {
        hadVersionExcluded = true;
        continue;
      }

      // Relevance gate: the broader the scope, the stronger the evidence must be.
      const signals = {
        text: textStrength(textScore, tuning.textSaturation),
        alias: entry.search_aliases.some((a) => a.length >= 2 && queryLc.includes(a.toLowerCase())),
        symbol: queryIdents.some((id) => item.aliasesLc.includes(id) || item.titleLc.includes(id) || item.bodyLc.includes(id)),
        path: pathMatched,
        dependency: [...entry.dependency_constraints, ...(entry.applies_to?.dependencies ?? [])].some((d) => dependencies?.[d.name] !== undefined),
        tag: queryTags.size ? Math.min(1, tagOverlap / Math.min(2, queryTags.size)) : 0,
      };
      const relevance = relevanceOf(signals, tuning.weights);
      // An explicit `scope: all` asks for other repositories' project knowledge: any keyword hit qualifies.
      const explicitlyRequested = scope === 'all' && verdict === 'cross_ref' && (entry.layer === 'project' || entry.layer === 'team_rule');
      if (verdict !== 'own_repo' && !explicitlyRequested) {
        if (relevance < tuning.minRelevance[verdict]) continue;
        if (verdict === 'cross_ref' && signalCount(signals) < tuning.crossRefSignals) continue;
      }

      // This repository's own experience with the entry.
      const fb = feedback.get(`${entry.id}@${entry.revision}`);
      let penalty = 1;
      if (fb && verdict !== 'own_repo' && fb.failures > 0) continue;
      if (fb && isCrossRepoLayer(entry.layer)) {
        if (fb.inapplicableSessions >= REPO_SUPPRESS_SESSIONS) continue;
        if (fb.inapplicableSessions === 1) penalty *= 0.85;
      }
      if (fb && verdict !== 'own_repo' && fb.shown >= 5 && fb.used === 0) penalty *= 0.8;

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
      const localReview = !fromHere ? sharedReviews.get(entry.id) : undefined;
      if (entry.freshness === 'review_due') totalScore *= 0.9;
      else if (localReview && localReview.revision === entry.revision) {
        totalScore *= 0.9;
        matchReasons.push(localReview.reason);
      } else if (!fromHere && Date.parse(entry.review_due_at) < nowMs) {
        // Machine-wide and other repositories' entries are not scanned against this repository's Git history,
        // so an overdue review date is the signal that they need a fresh look.
        totalScore *= 0.9;
        matchReasons.push('已到复核期，请留意是否仍然适用');
      }
      if (tagMatched) {
        // Topic tags are evidence of their own: an entry about the same subject scores even without shared words.
        totalScore += 3.0 * Math.min(1, tagOverlap / Math.min(2, queryTags.size));
        matchReasons.push(`主题标签：${item.tags.filter((t) => queryTags.has(t)).map((t) => this.tagLabel(t)).join('、')}`);
      }
      totalScore *= tuning.verdictFactor[verdict] * penalty;
      if (verdict !== 'own_repo') matchReasons.push(`${VERDICT_LABEL[verdict]}：${applicability.reasons.join('；')}`);

      scoredHits.push({
        entry,
        storageZone: row.storage_zone,
        probationExposures: row.probation_exposures,
        score: Number(totalScore.toFixed(3)),
        matchReasons,
        truncated: false,
        originRepo: applicability.originRepo,
        scopeVerdict: verdict,
      });
    }

    scoredHits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    const deduped = dedupeByCluster(scoredHits.slice(0, 60));
    const ranked = applyQuotas(deduped, limit, tuning.quota);

    const finalItems: SearchHit[] = [];
    let tokenUsed = 0;

    for (const hit of ranked) {
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
    this.beginWrite();
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
    this.beginWrite();
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

    this.feedbackCache = null;
    if (isCrossRepoLayer(entry.layer) && (input.outcome === 'success' || input.outcome === 'failure')) {
      try {
        this.feedback.append(entry.id, { repo: this.workspaceId, revision: entry.revision, kind: input.outcome, session: input.sessionId });
      } catch (err) {
        console.warn(`[accremind] cross-repository feedback not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A confirmation in this repository settles a local re-check of a shared entry.
    if (input.outcome === 'success') this.clearSharedReview(entry.id);
    // Another repository's entry: the result is recorded here (a counterexample stops it here at once) and
    // handed to its home repository through the shared feedback; its card is never written from here.
    if (!this.isOwnedSource(row.workspace_id)) return { record, updatedEntry: entry };

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
    if (!row || row.status !== 'probation' || !this.isOwnedSource(row.workspace_id)) {
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
    const row = this.findRawEntryRow(entryId);
    const target = row ? targetZoneForLayer(row.layer) : 'project';
    return this.withWriteLock(() => this.withMachineWideLock(isMachineWideZone(target), () => this.promoteLocked(entryId, overrides)));
  }

  private promoteLocked(
    entryId: string,
    overrides: Partial<Pick<KnowledgeEntry, 'maturity' | 'last_validated_at'>>,
  ): KnowledgeEntry {
    const row = this.findRawEntryRow(entryId);
    if (!row) {
      throw new Error(`未找到待转正条目: ${entryId}`);
    }
    this.assertOwnedRow(row);
    this.assertUnchangedOnDisk(row);

    const current = rowToEntry(row);
    const now = new Date().toISOString();
    // Team rules go to the rules folder (resident), not next to project knowledge.
    const targetZone: StorageZone = targetZoneForLayer(current.layer);
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

    this.beginWrite();
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
      if (this.shareLedger() && (targetZone === 'project' || targetZone === 'rules')) this.ledger.exportToRepository((id) => id !== promoted.id);
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
    this.assertOwnedRow(row);
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
      input.decision === 'approve_probation' ? 'probation' : targetZoneForLayer(draft.layer);

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
    this.assertOwnedRow(row);
    const existing = rowToEntry(row);
    const layerChanged = input.patch.layer !== undefined && input.patch.layer !== existing.layer;
    if (layerChanged && (!isCapturableLayer(existing.layer) || !isCapturableLayer(input.patch.layer))) {
      return { ok: false, missingFields: ['layer: 团队规范只能经治理提案产生或撤销；其余可在项目、领域、通用技术和个人之间调整'] };
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

    // A revised entry is judged against the team rules afresh (the radar raises the conflict again if it remains).
    this.clearAttention(existing.id, 'rule_conflict');
    if (layerChanged) {
      const targetZone = row.storage_zone === 'probation' ? 'probation' : targetZoneForLayer(nextEntry.layer);
      if (targetZone !== row.storage_zone) return { ok: true, entry: this.relocateEntry(row, nextEntry, targetZone) };
    }
    return { ok: true, entry: this.updateExistingEntryDirect(nextEntry) };
  }

  /**
   * Moves an entry to another storage zone (reclassification across scopes). Leaving the repository
   * drops symbol anchors (they can only be checked in that repository) and records where it came from.
   */
  private relocateEntry(row: EntryRow, entry: KnowledgeEntry, targetZone: StorageZone): KnowledgeEntry {
    const leavingRepo = !isMachineWideZone(row.storage_zone) && isMachineWideZone(targetZone);
    const moved: KnowledgeEntry = leavingRepo
      ? { ...entry, symbol_anchors: [], origin_repo: entry.origin_repo ?? this.workspaceId,
          ...(entry.layer === 'personal' ? { owner: entry.owner ?? this.currentUser().userId, visibility: 'private' as const } : {}) }
      : entry;
    checkLayerStorage(moved.layer, targetZone);
    return this.withWriteLock(() => this.withMachineWideLock(isMachineWideZone(targetZone) || isMachineWideZone(row.storage_zone), () => {
      this.assertUnchangedOnDisk(row);
      const targetWsId = this.ownerWorkspaceForZone(targetZone);
      const targetPath = path.join(directoryForZone(this.paths, targetZone), `${moved.id}.md`);
      if (fs.existsSync(targetPath)) throw new EntryIdCollisionError(moved.id, targetPath);
      const md = serializeEntryMarkdown(moved);
      writeFileAtomicSync(targetPath, md);
      if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path);
      this.beginWrite();
      try {
        this.deleteIndexedEntry(row.workspace_id, moved.id);
        this.indexEntryRow(targetWsId, targetZone, targetPath, sha256Hex(md), moved, row.probation_exposures);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      this.emit('entry.saved', moved, { zone: targetZone, from: row.storage_zone, reclassified: true });
      try {
        this.snapshots.relocate(rowToEntry(row), moved);
      } catch {
        // snapshots are supporting records
      }
      return moved;
    }));
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
