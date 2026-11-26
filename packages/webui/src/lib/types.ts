/** 与 packages/core/src/contracts/types.ts 对齐的前端只读视图类型（仅保留界面用到的字段）。 */
export type KnowledgeType = 'model' | 'decision' | 'guideline' | 'pitfall' | 'process';
export type EntryStatus = 'candidate' | 'probation' | 'active' | 'withdrawn' | 'archived';
export type Maturity = 'draft' | 'verified' | 'proven';
export type Freshness = 'current' | 'review_due' | 'stale';
export type Serving = 'enabled' | 'suspended';
export type KnowledgeLayer = 'personal' | 'team_rule' | 'shared_tech' | 'domain' | 'project';
export type Priority = 'P0' | 'P1' | 'P2';
export type StorageZone = 'project' | 'rules' | 'probation' | 'personal' | 'shared_tech' | 'domain';
export type CapturableLayer = 'project' | 'domain' | 'shared_tech' | 'personal';
/** How an entry relates to the current repository (server-side applicability verdict). */
export type ScopeVerdict = 'own_repo' | 'domain_match' | 'stack_match' | 'owner_match' | 'cross_ref';
export type Disposition = 'index_only' | 'link_existing' | 'knowledge_candidate' | 'needs_confirmation' | 'discard';

export interface Evidence {
  id: string;
  source_type: 'git_commit' | 'file_lines' | 'test_run' | 'doc_ref' | 'session_turn';
  source_ref: string;
  locator: string;
  summary: string;
}

export interface SymbolAnchor {
  file_path: string;
  symbol_name: string;
  normalized_sha256: string;
  start_line: number;
  end_line: number;
}

export interface KnowledgeEntry {
  id: string;
  revision: number;
  type: KnowledgeType;
  polarity?: 'recommend' | 'avoid';
  knowledge_role: 'experience' | 'authoritative_mirror';
  layer: KnowledgeLayer;
  title: string;
  search_aliases: string[];
  claim: string;
  knowledge_delta: string;
  rationale: string;
  preconditions: string[];
  exclusions: string[];
  dependency_constraints: { name: string; range: string }[];
  watch_paths: string[];
  symbol_anchors: SymbolAnchor[];
  invalidation_triggers: string[];
  verification_method: string;
  alternatives: { option: string; rejected_because: string; evidence_id: string }[];
  enforcement: { kind: string; status: 'proposed' | 'implemented' | 'verified'; ref: string | null };
  status: EntryStatus;
  maturity: Maturity;
  freshness: Freshness;
  serving: Serving;
  priority: Priority;
  capture_assessment_id: string | null;
  supersedes: string | null;
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  review_due_at: string;
  // format v2 (optional)
  origin_repo?: string | null;
  domains?: string[];
  applies_to?: { languages?: string[]; dependencies?: { name: string; range: string }[]; repos?: string[]; exclude_repos?: string[] };
  portable_patterns?: string[];
  owner?: string | null;
  visibility?: 'private' | 'team' | 'org';
  overrides?: { rule_id: string; reason: string; approver: string; expires_at: string }[];
  specializes?: string | null;
}

/** `accremind.repo.profile`: this repository's identity, business domains and the repositories it shares with. */
export interface RepoProfile {
  repoId: string;
  idSource: 'repo.json' | 'remote' | 'path';
  name: string;
  remote: string | null;
  org: string | null;
  domains: string[];
  languages: string[];
  dependencies: number;
  profileFile: string;
  /** 项目级开关：false = 不沉淀 / 不与其它仓库共享经验（写进 .accremind/repo.json）。 */
  capture: boolean;
  share: boolean;
  knownRepositories: { repoId: string; name: string; domains: string[]; lastSeen: string }[];
}

export interface ListItem {
  entry: KnowledgeEntry;
  storageZone: StorageZone;
  probationExposures?: number;
}

export interface KbListResult {
  scopeCounts: Record<KnowledgeLayer, number>;
  items: ListItem[];
  zeroReason: string;
}

export interface Overview {
  workspaceId: string;
  projectName: string;
  maxProbationExposures: number;
  hasDemoSeeded: boolean;
  counts: {
    totalEntries: number;
    byScope: Record<KnowledgeLayer, number>;
    byCategory: Record<KnowledgeType, number>;
    activeCount: number;
    projectActiveCount: number;
    rulesCount: number;
    probationCount: number;
    reviewDueCount: number;
    suspendedCount: number;
    governanceQueueCount: number;
    verifiedOrProvenCount: number;
    pendingReviewCount: number;
    corruptedCount: number;
    queuedCaptureJobs: number;
    navigationItemsCount: number;
  };
}

export interface Assessment {
  id: string;
  question: string;
  checked_context: {
    head_commit: string;
    checked_files: string[];
    checked_docs: string[];
    method: 'human_review' | 'single_pass_check' | 'isolated_check';
    token_used: number;
    duration_ms: number;
  };
  discoverability: 'code_recoverable' | 'authoritative_source' | 'missing_context' | 'inconclusive';
  baseline_answer: string;
  knowledge_delta: string;
  claim_evidence_map: { assertion: string; evidence_locator: string | null; verified_fact: boolean }[];
  omission_consequence: string;
  priority: Priority;
  disposition: Disposition;
  created_at: string;
}

export interface Validation {
  id: string;
  outcome: 'success' | 'failure' | 'inconclusive';
  evidence_note: string;
  session_id: string;
  created_at: string;
}

export type KbGetResult =
  | { found: false }
  | { found: true; servable: false; reason: 'withdrawn' | 'archived' | 'suspended'; supersedes: string | null }
  | {
      found: true;
      servable: true;
      entry: KnowledgeEntry;
      storageZone: StorageZone;
      assessment: Assessment | null;
      validations: Validation[];
      rawMarkdown: string;
      snapshots: EvidenceSnapshot[];
      ledger: { shared: boolean; standing: LedgerStanding; records: LedgerRecord[] };
    };

export interface CaptureResult {
  assessmentId: string;
  finalDisposition: Disposition;
  persistedZone?: StorageZone;
  downgradedReason?: string;
  duplicate?: boolean;
}

/* ---------- 总览 / 审核 / 治理 / 回合记录 / Git 雷达 ---------- */
/** reminders = 按需提醒（提问雷达 + 文件护栏）；ruleTurns = 带上常驻团队规范的回合数。 */
export interface InsightsDay { date: string; reminders: number; helpful: number; inapplicable: number; wrong: number; ruleTurns: number }
export interface Insights {
  days: number;
  daily: InsightsDay[];
  totals: { reminders: number; remindersLast7: number; remindersPrev7: number; helpful: number; inapplicable: number; wrong: number; ruleTurns: number };
  tzOffsetMinutes: number;
  byType: Partial<Record<KnowledgeType, number>>;
  byHealth: { usable: number; verified: number; trial: number; attention: number; stopped: number };
  lifecycle: { candidates: number; trial: number; active: number; verified: number };
  topEntries: { id: string; title: string; type: KnowledgeType; reminders: number; helpful: number }[];
  attention: number;
}

export type AttentionKind = 'probation_silent' | 'inapplicable' | 'rule_conflict' | 'auto_demoted';
export interface AttentionItem { entry_id: string; kind: AttentionKind; reason: string; revision: number; created_at: string; title: string; type: KnowledgeType | null; owners?: string[]; assignedToMe?: boolean }

export interface ReviewItem {
  assessment: Assessment;
  reviewState: 'pending' | 'decided' | string;
  candidateDraft: KnowledgeEntry | null;
  missingFields: string[];
}
export interface ReviewQueue { offset: number; limit: number; total: number; hasMore: boolean; items: ReviewItem[] }
export type ReviewDecision = 'approve_active' | 'approve_probation' | 'supplement' | 'needs_confirmation' | 'index_only' | 'link_existing' | 'discard';

export interface ReviewDetails {
  /** 每条证据：上次批准或确认时的快照，与现在同一位置的内容。 */
  evidence: EvidenceCompare[];
  reason: string;
  previousHead: string | null;
  currentHead: string | null;
  diff: string;
  truncated: boolean;
  anchorIssues: string[];
  reviewToken: string;
}
export interface GovernanceQueue {
  staleEntries: KnowledgeEntry[];
  suspendedEntries: KnowledgeEntry[];
  corruptedFiles: { file_path: string; reason: string; detected_at: string }[];
  attentionItems: (Omit<AttentionItem, 'title' | 'type'> & { entry: KnowledgeEntry | null })[];
  /** Shared entries to re-check in this repository (never rewritten from here). */
  sharedReviews?: { entryId: string; revision: number; reason: string; createdAt: string; entry: KnowledgeEntry }[];
}
export interface StalenessScan extends GovernanceQueue {
  scan: { skippedUnchanged: boolean; previousHead: string | null; currentHead: string | null; relocatedEntries: string[]; markedReviewDue: { entryId: string; reason: string }[] };
}

export interface Settings { writeGate: string; modelEndpoint: string; modelAvailable: boolean; autoCapture: boolean; modelUpload: boolean; shareLedger: boolean }

export interface ReceiptHit {
  id: string;
  revision: number;
  title: string;
  status: EntryStatus;
  source: 'rule' | 'radar' | 'jit';
  filePath?: string | null;
  currentStatus: EntryStatus | null;
  currentRevision: number | null;
  currentServing: Serving | null;
  feedback: 'success' | 'failure' | 'inconclusive' | null;
  /** Why it was shown: same domain, path anchor, topic tags… */
  reasons?: string[];
}
export interface TurnReceipt { sessionId: string; turnId: string; createdAt: string; hits: ReceiptHit[] }

export interface SimResult {
  residentPrefix: string;
  residentRuleIds: string[];
  /** 因常驻预算放不下、只在提示里列出编号的团队规范。 */
  residentDroppedIds: string[];
  residentTokens: number;
  radarBlock: string;
  radarTokens: number;
  radarSurfacedIds: string[];
  guardBlock: string;
  guardTokens: number;
  guardSurfacedIds: string[];
  budgets: Record<string, number>;
}

export interface MinedCommit {
  commitSha: string;
  committedAtIso: string;
  subject: string;
  body: string;
  touchedFiles: string[];
  hasCoModifiedTest: boolean;
  rapidFixClusterFiles: string[];
  signalScore: number;
  signalReasons: string[];
  diffPreview: string;
}
export interface RadarResult {
  minedCommits: MinedCommit[];
  modelAvailable: boolean;
  message?: string;
  triageReport: { dispositionCounts: Partial<Record<Disposition, number>> } | null;
}

/* ---------- 证据快照与验证账本 ---------- */
export interface EvidenceSnapshot {
  entryId: string;
  revision: number;
  evidenceId: string;
  sourceType: Evidence['source_type'];
  locator: string;
  commit: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  sourceSha256: string;
  excerpt: string;
  redacted: number;
  truncated: boolean;
  capturedAt: string;
  capturedBy: string;
}
export interface SnapshotVerification { status: 'verified' | 'mismatch' | 'unavailable'; detail: string }
export interface EvidenceCompare {
  evidenceId: string;
  locator: string;
  summary: string;
  then: EvidenceSnapshot | null;
  now: { excerpt: string; sourceSha256: string; commit: string | null; truncated: boolean };
  changed: boolean | null;
  verification: SnapshotVerification | null;
}
export type LedgerKind = 'validated' | 'counterexample' | 'inapplicable' | 'decision';
export interface LedgerRecord {
  v: number;
  id: string;
  entryId: string;
  revision: number;
  contentSha256: string;
  kind: LedgerKind;
  action?: string;
  task?: string;
  actor: string;
  at: string;
  note: string;
  tool: string;
}
export interface LedgerStanding {
  maturity: Maturity;
  unresolvedCounterexample: boolean;
  successTasks: number;
  confirmers: string[];
  inapplicableReporters: number;
  author: string | null;
  lastValidatedAt: string | null;
  counted: number;
}
export interface LedgerStatus { shared: boolean; sharedFile: string; pendingCount: number; preview: LedgerRecord[] }

// ---- rule document sets ----
export type DocCategory = 'domain' | 'business_rules' | 'project_norms' | 'project_profile' | 'personal_preferences';
/** Where a document applies: one project, every project of its domains, or only the person who imported it. */
export type DocScope = 'project' | 'domain' | 'personal';
export interface DocListItem {
  docId: string; title: string; category: DocCategory; domains: string[]; tags: string[]; version: number; sections: number; file: string; originRepo: string | null;
  scope?: DocScope; audience?: 'core' | 'all'; subproject?: string | null;
  /** `repo` (this repository) · `kb` (team knowledge base) · `personal` · another repository's ID */
  home?: string;
}
export interface DocSection { id: string; heading: string; body: string; sha: string }
export interface DocChange {
  id: string; at: string; actor: string; docId: string; docTitle: string; category: DocCategory;
  op: 'create_doc' | 'add_section' | 'update_section' | 'delete_section' | 'import' | 'manual_edit' | 'delete_doc';
  section: string | null; before: string | null; after: string | null; rationale: string; proposalId: string | null; version: number;
  home?: string;
}
export interface DocDetail {
  meta: { id: string; title: string; category: DocCategory; domains: string[]; tags: string[]; version: number; updated_at: string };
  intro: string; sections: DocSection[]; file: string; originRepo: string | null; changes: DocChange[];
}
export interface DocProposal {
  id: string; docId: string | null; category: DocCategory; docTitle: string | null; sectionHeading: string;
  op: 'create_doc' | 'add_section' | 'update_section' | 'delete_section'; content: string; baseSha: string | null;
  rationale: string; evidence: string | null; source: string; sessionId: string | null; status: 'pending' | 'accepted' | 'rejected';
  createdAt: string; decidedAt: string | null; decidedBy: string | null; decisionNote: string | null;
  owners?: string[]; assignedToMe?: boolean;
}
export interface TagProposal { id: string; label: string; kind: string; count: number; example: string | null; status: string; createdAt: string }

export type DomainRole = 'core' | 'consumer';
export interface DomainInfo {
  id: string; name: string; aliases: string[]; parent?: string | null; owners: string[]; description?: string;
  members: Array<{ repo: string; role: DomainRole; subproject?: string; name: string; isThisRepo: boolean }>;
  myRole: DomainRole | null;
}
export interface KnowledgeBaseInfo { root: string; kind: 'team' | 'local' }
export interface DomainsOverview {
  catalogFile: string; knowledgeBase: KnowledgeBaseInfo; domains: DomainInfo[];
  mine: Array<{ id: string; name: string; role: DomainRole; known: boolean }>; unknown: string[];
}
export interface SubprojectDef { id: string; name?: string; paths: string[]; domains?: string[]; owners?: string[] }
export interface Digest {
  repo: string; since: string; until: string; user: string;
  pending: { candidates: number; attention: number; attentionMine: number; docProposals: number; docProposalsMine: number; reviewDue: number };
  happened: {
    autoDemotions: Array<{ entryId: string; title: string | null; step: string; reason: string; at: string }>;
    docChanges: Array<{ doc: string; section: string | null; op: string; actor: string; at: string; home?: string }>;
    tuning: Array<{ action: string; reason: string; at: string }>;
  };
  usage: { reminders: number; helpful: number; inapplicable: number; wrong: number; helpfulRate: number | null; inapplicableRate: number | null };
  /** Model calls this window: auto-capture extraction and topic tagging, in calls and reported tokens. */
  models: { calls: number; tokens: number; byKind: Record<string, { calls: number; tokens: number }> };
  markdown: string;
}
