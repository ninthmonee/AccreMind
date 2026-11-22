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

export interface SearchQuery {
  workspaceId: string;
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
}
