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

CREATE TABLE IF NOT EXISTS entries (
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
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_entries_lookup
  ON entries (workspace_id, status, serving, freshness, layer, priority);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
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

CREATE TABLE IF NOT EXISTS entry_symbol_anchors (
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

export interface SemverTuple {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemverTuple(raw: string): SemverTuple | null {
  const cleaned = raw.trim().replace(/^[v=^~]+/, '');
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(cleaned);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
    patch: Number.parseInt(match[3] ?? '0', 10),
  };
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Zero-dependency semver range evaluator supporting `*`, exact `1.2.3`, caret `^1.2.3`,
 * tilde `~1.2.3`, and comparator tokens `>=`, `<=`, `>`, `<`.
 */
export function satisfiesSemverRange(actualVersion: string, rangeExpr: string): boolean {
  const trimmedRange = rangeExpr.trim();
  if (!trimmedRange || trimmedRange === '*') return true;

  const actual = parseSemverTuple(actualVersion);
  if (!actual) return true;

  if (trimmedRange.startsWith('^')) {
    const base = parseSemverTuple(trimmedRange.slice(1));
    if (!base) return true;
    if (compareSemver(actual, base) < 0) return false;
    if (base.major > 0) return actual.major === base.major;
    if (base.minor > 0) return actual.major === 0 && actual.minor === base.minor;
    return actual.major === 0 && actual.minor === 0 && actual.patch === base.patch;
  }

  if (trimmedRange.startsWith('~')) {
    const base = parseSemverTuple(trimmedRange.slice(1));
    if (!base) return true;
    return (
      compareSemver(actual, base) >= 0 &&
      actual.major === base.major &&
      actual.minor === base.minor
    );
  }

  const tokens = trimmedRange.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
    if (!opMatch) continue;
    const op = opMatch[1] ?? '=';
    const target = parseSemverTuple(opMatch[2]!);
    if (!target) continue;
    const cmp = compareSemver(actual, target);
    if (op === '>=' && cmp < 0) return false;
    if (op === '<=' && cmp > 0) return false;
    if (op === '>' && cmp <= 0) return false;
    if (op === '<' && cmp >= 0) return false;
    if (op === '=' && cmp !== 0) return false;
  }

  return true;
}
