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
  close(): void;
}
