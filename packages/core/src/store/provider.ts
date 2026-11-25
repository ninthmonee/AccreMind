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

/**
 * Optional semantic reranking slot (e.g. local quantized ONNX / Ollama RRF fusion)
 * without forcing any vector database dependency on the default core runtime.
 */
export interface SemanticReranker {
  rerank(query: string, candidates: SearchHit[]): Promise<SearchHit[]> | SearchHit[];
}

export interface DocHitLike {
  ref: string;
  docTitle: string;
  heading: string;
  category: string;
  snippet: string;
  score: number;
  originRepo: string | null;
  matchedTags: string[];
  /** Where the document is mounted: project · domain · personal. */
  scope?: string;
}

export type GetEntryOutcome =
  | { found: true; servable: true; entry: KnowledgeEntry; storageZone: StorageZone }
  | {
      found: true;
      servable: false;
      reason: 'withdrawn' | 'suspended' | 'archived';
      supersedes: string | null;
    }
  | { found: false };

export interface KnowledgeStoreProvider {
  /** Records that an entry went live (ledger) and snapshots its evidence. Optional for other providers. */
  recordPublication?(entry: KnowledgeEntry, note?: string): void;
  readonly workspaceId: string;
  initializeAndReconcile(): { syncedCount: number; corruptedCount: number };
  rebuildIndexFromScratch(): { syncedCount: number; corruptedCount: number };
  upsertEntry(
    entry: KnowledgeEntry,
    zone: StorageZone,
    assessment: CaptureAssessment | null,
  ): KnowledgeEntry;
  getEntry(
    id: string,
    options?: { sessionId?: string; recordUsage?: boolean; includeHistoryOrSuspended?: boolean },
  ): GetEntryOutcome;
  listResidentRules(): KnowledgeEntry[];
  search(query: SearchQuery): SearchResult;
  recordAssessment(assessment: CaptureAssessment, candidateDraft?: KnowledgeEntry | null): void;
  getAssessment(id: string): CaptureAssessment | null;
  findAssessmentByFingerprint(fingerprint: string): CaptureAssessment | null;
  appendNavigationItem(item: NavigationItem): void;
  listNavigationItems(): NavigationItem[];
  recordUsage(event: Omit<UsageEvent, 'event_id' | 'created_at'>): void;
  submitValidation(input: {
    entryId: string;
    sessionId: string;
    taskFingerprint: string;
    outcome: 'success' | 'failure' | 'inconclusive';
    evidenceNote: string;
  }): { record: ValidationRecord; updatedEntry: KnowledgeEntry };
  recordProbationExposure(entryId: string): { autoArchived: boolean; exposures: number };
  promoteProbationToActive(entryId: string): KnowledgeEntry;
  dismissProbation(entryId: string, reason?: string): KnowledgeEntry;
  listCorruptedFiles(): CorruptedFileRecord[];
  /** Near-identical entries anywhere in the index (other layers and repositories included). */
  findSimilarEntries?(entry: KnowledgeEntry): Array<{ id: string; layer: KnowledgeEntry['layer']; originRepo: string | null; similarity: number }>;
  /** Rule-document sections relevant to a question (see DocLibrary.search). */
  searchDocs?(input: { query: string; tags?: string[]; activeFiles?: string[]; errorText?: string; limit?: number }): DocHitLike[];
  /** The project profile (basic business attributes) as resident context. */
  residentProfile?(maxTokens?: number): string;
  /** The person's own preferences (personal documents) as resident context. */
  residentPreferences?(maxTokens?: number): string;
  /** This repository's documented exceptions to team rules. */
  listRuleWaivers?(): Map<string, { entryId: string; reason: string; expiresAt: string }>;
  /** Project knowledge contradicting a team rule without an exception is taken out of reminders and flagged. */
  reportRuleConflict?(entry: KnowledgeEntry, rule: KnowledgeEntry): void;
  close(): void;
}
