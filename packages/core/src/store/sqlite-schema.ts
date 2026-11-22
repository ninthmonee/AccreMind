export const ACCREMIND_SQLITE_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS freshness_reviews (
  workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, reason TEXT NOT NULL,
  previous_head TEXT, affected_paths TEXT NOT NULL,
  PRIMARY KEY (workspace_id, entry_id)
);

CREATE TABLE IF NOT EXISTS capture_assessments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  checked_context_json TEXT NOT NULL,
  discoverability TEXT NOT NULL,
  baseline_answer TEXT NOT NULL,
  knowledge_delta TEXT NOT NULL,
  claim_evidence_map_json TEXT NOT NULL,
  omission_consequence TEXT NOT NULL,
  priority TEXT NOT NULL,
  disposition TEXT NOT NULL,
  candidate_entry_json TEXT,
  review_state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS validation_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  task_fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, entry_id, revision, task_fingerprint)
);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_receipts (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, turn_id)
);
CREATE TABLE IF NOT EXISTS turn_hits (
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  entry_id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, source TEXT NOT NULL, file_path TEXT,
  PRIMARY KEY (workspace_id, session_id, turn_id, entry_id, revision, source)
);
CREATE TABLE IF NOT EXISTS probation_grace (
  workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL,
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, turn_completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, entry_id)
);
CREATE TABLE IF NOT EXISTS governance_decisions (
  workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_checkpoints (
  workspace_id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  last_checked_head TEXT NOT NULL,
  package_deps_sha256 TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrupted_files (
  file_path TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL
);
`;

/**
 * The entry index (cards, full-text, symbol anchors) is derived from the Markdown cards and shared by every
 * repository on this machine: `~/.dsh/accremind/index/global.sqlite`, attached to each repository's state
 * database as schema `g`. Unqualified `entries` / `entries_fts` / `entry_symbol_anchors` resolve to it.
 * It carries its own version; a mismatch rebuilds it (it can always be rebuilt from the cards).
 */
export const ACCREMIND_INDEX_SCHEMA_VERSION = 3;
export const ACCREMIND_INDEX_DDL = `
PRAGMA g.journal_mode = WAL;
PRAGMA g.synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS g.entries (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  storage_zone TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  type TEXT NOT NULL,
  polarity TEXT,
  knowledge_role TEXT NOT NULL,
  layer TEXT NOT NULL,
  title TEXT NOT NULL,
  search_aliases_json TEXT NOT NULL,
  claim TEXT NOT NULL,
  knowledge_delta TEXT NOT NULL,
  rationale TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL,
  dependency_constraints_json TEXT NOT NULL,
  watch_paths_json TEXT NOT NULL,
  symbol_anchors_json TEXT NOT NULL,
  invalidation_triggers_json TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  alternatives_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  enforcement_json TEXT NOT NULL,
  status TEXT NOT NULL,
  maturity TEXT NOT NULL,
  freshness TEXT NOT NULL,
  serving TEXT NOT NULL,
  priority TEXT NOT NULL,
  probation_exposures INTEGER NOT NULL DEFAULT 0,
  capture_assessment_id TEXT,
  supersedes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_validated_at TEXT,
  review_due_at TEXT NOT NULL,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  scope_meta_json TEXT,
  -- Applicability columns for SQL pre-filtering (v2): owner of a personal entry, ",a,b," lists.
  owner TEXT,
  domains_csv TEXT NOT NULL DEFAULT '',
  tags_csv TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS g.idx_entries_lookup
  ON entries (workspace_id, status, serving, freshness, layer, priority);

CREATE VIRTUAL TABLE IF NOT EXISTS g.entries_fts USING fts5(
  workspace_id UNINDEXED,
  id UNINDEXED,
  title,
  aliases_text,
  claim,
  knowledge_delta,
  rationale,
  watch_paths_text,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS g.entry_symbol_anchors (
  workspace_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  normalized_sha256 TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, entry_id, file_path, symbol_name),
  FOREIGN KEY (workspace_id, entry_id) REFERENCES entries(workspace_id, id) ON DELETE CASCADE
);


CREATE INDEX IF NOT EXISTS g.idx_entries_file_path ON entries (file_path);
CREATE INDEX IF NOT EXISTS g.idx_entries_source ON entries (workspace_id, storage_zone);
CREATE INDEX IF NOT EXISTS g.idx_entries_scope ON entries (layer, status, workspace_id);

-- Rule document sets (v3): one row per \`##\` section, full-text over title/heading/body (rowid shared).
CREATE TABLE IF NOT EXISTS g.doc_sections (
  workspace_id TEXT NOT NULL, doc_id TEXT NOT NULL, section_id TEXT NOT NULL,
  category TEXT NOT NULL, doc_title TEXT NOT NULL, heading TEXT NOT NULL, body TEXT NOT NULL,
  domains_csv TEXT NOT NULL DEFAULT '', tags_csv TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL, section_sha TEXT NOT NULL, doc_version INTEGER NOT NULL, ord INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, doc_id, section_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS g.doc_fts USING fts5(doc_title, heading, body, tokenize = 'trigram');
CREATE TABLE IF NOT EXISTS g.doc_files (
  workspace_id TEXT NOT NULL, doc_id TEXT NOT NULL, file_path TEXT NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, domains_csv TEXT NOT NULL DEFAULT '', tags_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL, file_sha TEXT NOT NULL, mtime_ms INTEGER, size INTEGER,
  PRIMARY KEY (workspace_id, doc_id)
);
`;

/** Drops the shared index's tables (used when its version does not match; it is rebuilt from the cards). */
export const ACCREMIND_INDEX_DROP = `
DROP TABLE IF EXISTS g.doc_fts;
DROP TABLE IF EXISTS g.doc_sections;
DROP TABLE IF EXISTS g.doc_files;
DROP TABLE IF EXISTS g.entry_symbol_anchors;
DROP TABLE IF EXISTS g.entries_fts;
DROP TABLE IF EXISTS g.entries;
`;

/**
 * Versioned schema changes applied after the base DDL. `PRAGMA user_version` records how far a
 * database has been migrated; each step runs once, in order, inside a transaction.
 */
export const ACCREMIND_SCHEMA_MIGRATIONS: ReadonlyArray<{ version: number; sql: string; requiresTable?: string }> = [
  {
    version: 2,
    sql: `
      ALTER TABLE governance_decisions ADD COLUMN actor TEXT;
      ALTER TABLE validation_records ADD COLUMN actor TEXT;
      CREATE TABLE IF NOT EXISTS attention_items (
        workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, kind TEXT NOT NULL,
        reason TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, entry_id, kind)
      );
    `,
  },
  {
    // Lets startup skip unchanged Markdown files by (path, mtime, size) instead of reading and hashing all.
    version: 3,
    requiresTable: 'entries',
    sql: `
      ALTER TABLE entries ADD COLUMN file_mtime_ms INTEGER;
      ALTER TABLE entries ADD COLUMN file_size INTEGER;
      CREATE INDEX IF NOT EXISTS idx_entries_file_path ON entries (file_path);
    `,
  },
  {
    // Full-text rows now share the entry rowid (keyed deletes instead of scans). Older rows used
    // independent rowids, so the full-text table is cleared and every file is re-indexed once.
    version: 4,
    requiresTable: 'entries',
    sql: `
      DELETE FROM entries_fts;
      UPDATE entries SET content_sha256 = '', file_mtime_ms = NULL, file_size = NULL;
    `,
  },
  {
    // Usage detail older than the retention window is rolled up per entry and day, then deleted.
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS usage_daily (
        workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, day TEXT NOT NULL, event_type TEXT NOT NULL,
        n INTEGER NOT NULL, PRIMARY KEY (workspace_id, entry_id, day, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events (workspace_id, created_at);
    `,
  },
  {
    // Entry format v2 metadata (origin repository, domains, stack conditions, owner, exceptions) as one JSON
    // column. Existing rows are re-read from their cards once so the column is filled.
    version: 6,
    requiresTable: 'entries',
    sql: `
      ALTER TABLE entries ADD COLUMN scope_meta_json TEXT;
      UPDATE entries SET content_sha256 = '', file_mtime_ms = NULL, file_size = NULL;
    `,
  },
  {
    // The entry index moved to the machine-wide `index/global.sqlite` (schema `g`): one copy for every
    // repository instead of one per repository. The per-repository copies are dropped; the cards are
    // re-indexed into the shared index on the next start.
    version: 7,
    sql: `
      DROP TABLE IF EXISTS main.entry_symbol_anchors;
      DROP TABLE IF EXISTS main.entries_fts;
      DROP TABLE IF EXISTS main.entries;
      CREATE INDEX IF NOT EXISTS idx_usage_entry_rev ON usage_events (entry_id, revision, event_type);
    `,
  },
  {
    // Shared entries (machine-wide or another repository's) are never rewritten from here, so a reason to
    // re-check one in this repository (its dependency had a major upgrade here) is kept locally, per revision.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS shared_reviews (
        entry_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dependency_snapshot (name TEXT PRIMARY KEY, version TEXT NOT NULL);
    `,
  },
  {
    // What each turn asked (redacted, truncated) and its topic tags, so recorded feedback can be replayed
    // by `accremind eval` to measure and tune retrieval.
    version: 9,
    sql: `
      ALTER TABLE turn_receipts ADD COLUMN query_text TEXT;
      ALTER TABLE turn_receipts ADD COLUMN query_tags TEXT;
      ALTER TABLE turn_receipts ADD COLUMN active_files TEXT;
    `,
  },
  {
    // Proposed changes to the rule documents (a person accepts or rejects them) and proposed vocabulary terms.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS doc_proposals (
        id TEXT PRIMARY KEY, doc_id TEXT, category TEXT NOT NULL, doc_title TEXT, section_heading TEXT NOT NULL,
        op TEXT NOT NULL, content TEXT NOT NULL, base_sha TEXT, rationale TEXT NOT NULL, evidence TEXT,
        source TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
        decided_at TEXT, decided_by TEXT, decision_note TEXT
      );
      CREATE TABLE IF NOT EXISTS vocab_proposals (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT, aliases TEXT, count INTEGER NOT NULL,
        example TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
      );
    `,
  },
];

export const ACCREMIND_SCHEMA_VERSION = ACCREMIND_SCHEMA_MIGRATIONS.at(-1)?.version ?? 1;

export interface SqlExecutor {
  exec(sql: string): void;
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export function migrateSchema(db: SqlExecutor): number {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) || 1;
  let version = current;
  for (const step of ACCREMIND_SCHEMA_MIGRATIONS) {
    if (step.version <= version) continue;
    // Steps that reshaped the old per-repository entry tables are moot once those tables are gone.
    const skip = step.requiresTable !== undefined &&
      !db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(step.requiresTable);
    db.exec('BEGIN');
    try {
      // Statements run one by one; re-adding a column or object that already exists (a database restored
      // from a copy, or a step interrupted after its DDL) is not an error.
      if (!skip) {
        for (const stmt of step.sql.split(';').map((x) => x.trim()).filter(Boolean)) {
          try {
            db.exec(stmt);
          } catch (err) {
            if (!/duplicate column name|already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
          }
        }
      }
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = step.version;
  }
  return version;
}

export interface SemverTuple {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemverTuple(raw: string): SemverTuple | null {
  const cleaned = raw.trim().replace(/^[v=]+/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePre(a.prerelease, b.prerelease);
}

type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; v: SemverTuple };

/** A partial version such as `1`, `1.2`, `1.x`, `1.2.*`; missing parts are wildcards. */
function parsePartial(raw: string): { parts: (number | null)[]; pre: string[] } | null {
  const m = /^[v=]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  // Anything after a wildcard is a wildcard too.
  for (let i = 1; i < 3; i += 1) if (parts[i - 1] === null) parts[i] = null;
  return { parts, pre: m[4] ? m[4].split('.') : [] };
}

const tuple = (ma: number, mi: number, pa: number, pre: string[] = []): SemverTuple => ({ major: ma, minor: mi, patch: pa, prerelease: pre });

/** Expands one range token (caret, tilde, x-range, comparator) into plain comparators. */
function expandToken(op: string, raw: string): Comparator[] | null {
  const p = parsePartial(raw);
  if (!p) return null;
  const [ma, mi, pa] = p.parts as [number | null, number | null, number | null];
  if (ma === null) return op === '<' || op === '>' ? [{ op: '<', v: tuple(0, 0, 0) }] : [];
  const lo = tuple(ma, mi ?? 0, pa ?? 0, p.pre);
  if (op === '^') {
    let hi: SemverTuple;
    if (ma > 0 || mi === null) hi = tuple(ma + 1, 0, 0, ['0']);
    else if ((mi ?? 0) > 0 || pa === null) hi = tuple(0, (mi ?? 0) + 1, 0, ['0']);
    else hi = tuple(0, 0, (pa ?? 0) + 1, ['0']);
    return [{ op: '>=', v: lo }, { op: '<', v: hi }];
  }
  if (op === '~') {
    const hi = mi === null ? tuple(ma + 1, 0, 0, ['0']) : tuple(ma, mi + 1, 0, ['0']);
    return [{ op: '>=', v: lo }, { op: '<', v: hi }];
  }
  const partialHi = mi === null ? tuple(ma + 1, 0, 0, ['0']) : pa === null ? tuple(ma, mi + 1, 0, ['0']) : null;
  switch (op) {
    case '':
    case '=':
      return partialHi ? [{ op: '>=', v: lo }, { op: '<', v: partialHi }] : [{ op: '=', v: lo }];
    case '>':
      return partialHi ? [{ op: '>=', v: partialHi }] : [{ op: '>', v: lo }];
    case '>=':
      return [{ op: '>=', v: lo }];
    case '<':
      return [{ op: '<', v: lo }];
    case '<=':
      return partialHi ? [{ op: '<', v: partialHi }] : [{ op: '<=', v: lo }];
    default:
      return null;
  }
}

function satisfiesComparators(v: SemverTuple, set: Comparator[]): boolean {
  for (const c of set) {
    const cmp = compareSemver(v, c.v);
    if (c.op === '=' && cmp !== 0) return false;
    if (c.op === '>' && cmp <= 0) return false;
    if (c.op === '>=' && cmp < 0) return false;
    if (c.op === '<' && cmp >= 0) return false;
    if (c.op === '<=' && cmp > 0) return false;
  }
  // As in npm: a prerelease only matches when a comparator names a prerelease of the same version.
  if (v.prerelease.length) {
    return set.some(
      (c) => c.v.prerelease.length && c.v.prerelease[0] !== '0' && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch,
    );
  }
  return true;
}

/**
 * Outcome of checking an installed version against an entry's dependency range.
 * `unknown` means one side could not be read (e.g. `workspace:*`, a git URL): callers must not treat it as a match.
 */
export function evaluateSemverRange(actualVersion: string, rangeExpr: string): 'match' | 'mismatch' | 'unknown' {
  const range = rangeExpr.trim();
  if (!range || range === '*' || range.toLowerCase() === 'x' || range === 'latest') return 'match';
  const actual = parseSemverTuple(actualVersion.trim().replace(/^[\^~]/, ''));
  if (!actual) return 'unknown';
  let anyParsed = false;
  for (const alternative of range.split('||')) {
    const alt = alternative.trim();
    if (!alt) continue;
    let set: Comparator[] | null = [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
    if (hyphen) {
      const lo = expandToken('>=', hyphen[1]!);
      const hi = expandToken('<=', hyphen[2]!);
      set = lo && hi ? [...lo, ...hi] : null;
    } else {
      const tokens = alt.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const m = /^(>=|<=|>|<|=|\^|~>?|)(.+)$/.exec(token);
        const expanded = m ? expandToken(m[1] === '~>' ? '~' : m[1]!, m[2]!) : null;
        if (!expanded) {
          set = null;
          break;
        }
        set.push(...expanded);
      }
    }
    if (!set) continue;
    anyParsed = true;
    if (satisfiesComparators(actual, set)) return 'match';
  }
  return anyParsed ? 'mismatch' : 'unknown';
}

/**
 * Backwards-compatible boolean form: only a definite mismatch excludes an entry.
 * Supports `||`, hyphen ranges, x-ranges, caret, tilde, comparators and prereleases.
 */
export function satisfiesSemverRange(actualVersion: string, rangeExpr: string): boolean {
  return evaluateSemverRange(actualVersion, rangeExpr) !== 'mismatch';
}
