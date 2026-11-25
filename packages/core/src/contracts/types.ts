export const KNOWLEDGE_TYPES = ['model', 'decision', 'guideline', 'pitfall', 'process'] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export const ENTRY_STATUSES = [
  'candidate',
  'probation',
  'active',
  'withdrawn',
  'archived',
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const MATURITY_LEVELS = ['draft', 'verified', 'proven'] as const;
export type Maturity = (typeof MATURITY_LEVELS)[number];

export const FRESHNESS_STATES = ['current', 'review_due', 'stale'] as const;
export type Freshness = (typeof FRESHNESS_STATES)[number];

export const SERVING_STATUSES = ['enabled', 'suspended'] as const;
export type ServingStatus = (typeof SERVING_STATUSES)[number];

export const REPOSITORY_KNOWLEDGE_LAYERS = ['domain', 'project'] as const;
export const KNOWLEDGE_LAYERS = ['personal', 'team_rule', 'shared_tech', ...REPOSITORY_KNOWLEDGE_LAYERS] as const;
export function isRepositoryKnowledgeLayer(value: unknown): value is (typeof REPOSITORY_KNOWLEDGE_LAYERS)[number] {
  return value === 'domain' || value === 'project';
}
export type KnowledgeLayer = (typeof KNOWLEDGE_LAYERS)[number];

/**
 * Layers a capture (tool, auto-capture, review) may write directly. Team rules are normative and are
 * only ever proposed for a human decision, never written by capture.
 */
export const CAPTURABLE_LAYERS = ['project', 'domain', 'shared_tech', 'personal'] as const;
export type CapturableLayer = (typeof CAPTURABLE_LAYERS)[number];
export function isCapturableLayer(value: unknown): value is CapturableLayer {
  return value === 'project' || value === 'domain' || value === 'shared_tech' || value === 'personal';
}

/** Where a layer is shared and served: one repository, an organisation, a business domain, every repository, one person. */
export type KnowledgeScope = 'repo' | 'org' | 'domain' | 'global' | 'user';
export const LAYER_SCOPE: Record<KnowledgeLayer, KnowledgeScope> = {
  team_rule: 'org',
  project: 'repo',
  domain: 'domain',
  shared_tech: 'global',
  personal: 'user',
};
/** Layers that may be served outside the repository they were captured in. */
export function isCrossRepoLayer(layer: KnowledgeLayer): boolean {
  return layer === 'domain' || layer === 'shared_tech' || layer === 'personal';
}

export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const DISCOVERABILITY_STATES = [
  'code_recoverable',
  'authoritative_source',
  'missing_context',
  'inconclusive',
] as const;
export type Discoverability = (typeof DISCOVERABILITY_STATES)[number];

export const DISPOSITIONS = [
  'index_only',
  'link_existing',
  'knowledge_candidate',
  'needs_confirmation',
  'discard',
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const STORAGE_ZONES = [
  'project',
  'rules',
  'probation',
  'personal',
  'shared_tech',
  /** Domain knowledge without a home repository (`~/.dsh/accremind/domain/`). */
  'domain',
] as const;
export type StorageZone = (typeof STORAGE_ZONES)[number];

export interface Evidence {
  id: string;
  source_type: 'git_commit' | 'file_lines' | 'test_run' | 'doc_ref' | 'session_turn';
  source_ref: string;
  locator: string;
  summary: string;
}

export interface DependencyConstraint {
  name: string;
  range: string;
}

export interface SymbolAnchor {
  file_path: string;
  symbol_name: string;
  normalized_sha256: string;
  start_line: number;
  end_line: number;
}

export interface AlternativeOption {
  option: string;
  rejected_because: string;
  evidence_id: string;
}

export interface EnforcementSpec {
  kind: 'test' | 'lint' | 'contract' | 'pipeline' | 'skill' | 'none';
  status: 'proposed' | 'implemented' | 'verified';
  ref: string | null;
}

/** Technology-stack conditions under which a cross-repository entry applies. Empty means "not stated". */
export interface ApplicabilitySpec {
  languages?: string[];
  dependencies?: DependencyConstraint[];
  /** Explicit allow-list of repository IDs. */
  repos?: string[];
  /** Repositories where the entry must never be served. */
  exclude_repos?: string[];
}

/** A repository's documented exception to a team rule. */
export interface RuleOverride {
  rule_id: string;
  reason: string;
  approver: string;
  expires_at: string;
}

export type Visibility = 'private' | 'team' | 'org';

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
  dependency_constraints: DependencyConstraint[];
  watch_paths: string[];
  symbol_anchors: SymbolAnchor[];
  invalidation_triggers: string[];
  verification_method: string;
  alternatives: AlternativeOption[];
  enforcement: EnforcementSpec;
  status: EntryStatus;
  maturity: Maturity;
  freshness: Freshness;
  serving: ServingStatus;
  priority: Priority;
  capture_assessment_id: string | null;
  supersedes: string | null;
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
  last_validated_at: string | null;
  review_due_at: string;
  // ---- format v2 (all optional; absent on v1 cards) ----
  /** Repository the entry was captured in; its paths and anchors only mean something there. */
  origin_repo?: string | null;
  /** Business domains (domain layer). */
  domains?: string[];
  applies_to?: ApplicabilitySpec;
  /** Path patterns that stay meaningful in other repositories (e.g. `**\/migrations/*.sql`). */
  portable_patterns?: string[];
  /** Owner of a personal entry (hashed Git e-mail). */
  owner?: string | null;
  visibility?: Visibility;
  /** Team rules this (project) entry is a documented exception to. */
  overrides?: RuleOverride[];
  /** Shared-tech entry this domain entry refines; the two are never served together. */
  specializes?: string | null;
  /** Topic tags (controlled vocabulary IDs) set by people; derived tags are added at index time. */
  tags?: string[];
  /**
   * Domain entries: who in the domain gets it. `core` = only projects that are core members of the domain;
   * `all` (default) = also projects that only use the domain (consumers).
   */
  audience?: 'core' | 'all';
  /** Sub-project (monorepo package) this entry belongs to; only served when work touches that sub-project. */
  subproject?: string;
}

export interface ClaimEvidenceMapping {
  assertion: string;
  evidence_locator: string | null;
  verified_fact: boolean;
}

export interface CheckedContext {
  head_commit: string;
  checked_files: string[];
  checked_docs: string[];
  method: 'human_review' | 'single_pass_check' | 'isolated_check';
  token_used: number;
  duration_ms: number;
}

export interface CaptureAssessment {
  id: string;
  workspace_id: string;
  source_fingerprint: string;
  question: string;
  checked_context: CheckedContext;
  discoverability: Discoverability;
  baseline_answer: string;
  knowledge_delta: string;
  claim_evidence_map: ClaimEvidenceMapping[];
  omission_consequence: string;
  priority: Priority;
  disposition: Disposition;
  created_at: string;
}

export interface NavigationItem {
  id: string;
  kind: 'code_index' | 'authoritative_link';
  title: string;
  locator: string;
  summary: string;
  assessment_id: string;
  created_at: string;
}

export interface ValidationRecord {
  id: string;
  workspace_id: string;
  entry_id: string;
  revision: number;
  session_id: string;
  task_fingerprint: string;
  outcome: 'success' | 'failure' | 'inconclusive';
  evidence_note: string;
  created_at: string;
}

export interface UsageEvent {
  event_id: string;
  workspace_id: string;
  session_id: string;
  entry_id: string;
  revision: number;
  event_type: 'radar_shown' | 'guard_shown' | 'retrieved' | 'cited' | 'feedback_inapplicable';
  detail?: string;
  created_at: string;
}

export interface CorruptedFileRecord {
  file_path: string;
  workspace_id: string;
  reason: string;
  detected_at: string;
}

export type ZeroResultReason =
  | 'none'
  | 'no_applicable_entry'
  | 'version_excluded'
  | 'suspended_conflict'
  | 'insufficient_query';

/** Who is asking, in which repository, about what: the signals cross-repository relevance is judged on. */
export interface SessionContext {
  repoId: string;
  orgId?: string | null;
  userId?: string | null;
  /** Other owner IDs of the same person (linked accounts, legacy e-mail hashes). */
  userAliases?: string[];
  /** Topic tags of the question (controlled vocabulary IDs). */
  tags?: string[];
  /**
   * Business-domain match keys: every domain this repository (or the active sub-project) belongs to, with its
   * catalog ID, name, aliases and ancestor domains, so entries tagged with any spelling of them match.
   */
  domains: string[];
  /** Domain IDs as declared / resolved through the domain catalog (for display). */
  declaredDomains?: string[];
  /** Match keys of domains where this repository is only a consumer (it gets `audience: all` knowledge only). */
  consumerDomains?: string[];
  /** Sub-projects the current work touches (from the active files); empty = unknown. */
  subprojects?: string[];
  languages: string[];
  dependencies: Record<string, string>;
  activeFiles?: string[];
  errorText?: string;
}

/**
 * How an entry relates to the current session:
 * own_repo — captured here (or explicitly allowed here); domain_match — shares a business domain;
 * stack_match — its stack conditions hold here; owner_match — the asker's own personal entry;
 * cross_ref — none of the above, shown only on strong evidence and labelled as a reference.
 */
export type ScopeVerdict = 'own_repo' | 'domain_match' | 'stack_match' | 'owner_match' | 'cross_ref';

export interface SearchQuery {
  /** @deprecated alias of `context.repoId`; still honoured. */
  workspaceId: string;
  context?: Partial<SessionContext>;
  /** auto (default): applicability gates; repo: this repository only; all: also other repositories' project knowledge. */
  scope?: 'auto' | 'repo' | 'all';
  query?: string;
  type?: KnowledgeType;
  layer?: KnowledgeLayer;
  filePath?: string;
  includeProbation?: boolean;
  workspaceDependencies?: Record<string, string>;
  limit?: number;
  tokenBudget?: number;
}

export interface SearchHit {
  entry: KnowledgeEntry;
  storageZone: StorageZone;
  probationExposures: number;
  score: number;
  matchReasons: string[];
  truncated: boolean;
  /** Repository the entry comes from (null for machine-wide layers). */
  originRepo?: string | null;
  scopeVerdict?: ScopeVerdict;
}

export interface SearchResult {
  items: SearchHit[];
  zeroReason: ZeroResultReason;
  tokenUsed: number;
}

export interface AccreMindConfig {
  globalDir: string;
  projectDirName: string;
  writeGate: 'probation' | 'review' | 'off';
  maxProbationExposures: number;
  assessmentMode: 'single_pass' | 'isolated_p0';
  budgets: {
    residentRulesTokens: number;
    turnRadarTokens: number;
    toolGuardTokens: number;
    toolReadMaxTokens: number;
  };
  autoCapture: {
    enabled: boolean;
    /**
     * Whether queued conversation excerpts may be sent to the configured model in the background.
     * Off by default: the user turns it on per workspace in settings (or the host passes its own adapter).
     */
    modelUpload?: boolean;
  };
  /**
   * Self-improvement that runs unattended. `demote`: confirmed entries feedback shows rarely fit go back to trial,
   * and low-value paused entries nobody decided on are archived (both reversible). `tune`: retrieval settings are
   * tuned on recorded feedback with guardrails, watched, and rolled back if they make things worse.
   */
  autoEvolve?: { demote?: boolean; tune?: boolean; teamFeedback?: boolean };
}
