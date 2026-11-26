import { randomUUID } from 'node:crypto';
import type {
  CaptureAssessment,
  Disposition,
  KnowledgeEntry,
  NavigationItem,
  StorageZone,
} from '../contracts/types.ts';
import { enforceHardPublishGate, validateCaptureAssessment } from '../contracts/validator.ts';
import type { KnowledgeStoreProvider } from '../store/provider.ts';
import { targetZoneForLayer } from '../store/local-store.ts';
import { isSensitiveFilePath, redactSensitiveText } from './secret-redactor.ts';

export interface TriageCandidateInput {
  assessment: CaptureAssessment;
  candidateEntry?: KnowledgeEntry | null;
  navigationTarget?: {
    title: string;
    locator: string;
    summary: string;
  };
}

export interface SingleTriageOutcome {
  assessmentId: string;
  duplicate: boolean;
  finalDisposition: Disposition;
  persistedEntry: KnowledgeEntry | null;
  persistedZone: StorageZone | null;
  navigationItem: NavigationItem | null;
  downgradedReason?: string;
  /** Near-identical entries already known on this machine (any repository or layer): link or generalize instead of duplicating. */
  similarExisting?: Array<{ id: string; layer: KnowledgeEntry['layer']; originRepo: string | null; similarity: number }>;
  /** Set when the candidate was a team-rule proposal: it waits for a human decision and is never written directly. */
  proposedTeamRule?: boolean;
}

export interface BatchTriageReport {
  outcomes: SingleTriageOutcome[];
  dispositionCounts: Record<Disposition, number>;
  persistedExperienceEntries: KnowledgeEntry[];
}

export class TriageEngine {
  private readonly store: KnowledgeStoreProvider;
  private readonly readGate: () => 'probation' | 'review' | 'off';

  constructor(store: KnowledgeStoreProvider, writeGate: 'probation' | 'review' | 'off' | (() => 'probation' | 'review' | 'off')) {
    this.store = store;
    this.readGate = typeof writeGate === 'function' ? writeGate : () => writeGate;
  }

  processCandidate(input: TriageCandidateInput): SingleTriageOutcome {
    if (this.store.repoSettings?.().capture === false) {
      throw new Error('本项目已排除沉淀（settings.enabled: false），没有写入评估或候选。');
    }
    // 1. Idempotency check by source_fingerprint (PRD §3.4 / §6.6)
    const existing = this.store.findAssessmentByFingerprint(input.assessment.source_fingerprint);
    if (existing) {
      return {
        assessmentId: existing.id,
        duplicate: true,
        finalDisposition: existing.disposition,
        persistedEntry: null,
        persistedZone: null,
        navigationItem: null,
      };
    }

    // 2. Scrub any accidental secrets inside assessment text fields
    const sanitizedAssessment: CaptureAssessment = {
      ...input.assessment,
      question: redactSensitiveText(input.assessment.question).redactedText,
      baseline_answer: redactSensitiveText(input.assessment.baseline_answer).redactedText,
      knowledge_delta: redactSensitiveText(input.assessment.knowledge_delta).redactedText,
      omission_consequence: redactSensitiveText(input.assessment.omission_consequence).redactedText,
      checked_context: {
        ...input.assessment.checked_context,
        checked_files: input.assessment.checked_context.checked_files.filter(
          (f) => !isSensitiveFilePath(f),
        ),
      },
    };

    // 3. Auto-downgrade invalid `knowledge_candidate` attempts (e.g. P0 without evidence,
    //    unverified guesses, inconclusive baseline check, or empty delta -> `needs_confirmation` / `index_only`)
    let effectiveAssessment = sanitizedAssessment;
    let downgradedReason: string | undefined;

    const assessmentIssues = validateCaptureAssessment(effectiveAssessment);
    if (assessmentIssues.length > 0) {
      if (effectiveAssessment.discoverability === 'code_recoverable') {
        effectiveAssessment = { ...effectiveAssessment, disposition: 'index_only' };
        downgradedReason = assessmentIssues.map((i) => i.message).join('; ');
      } else if (effectiveAssessment.discoverability === 'authoritative_source') {
        effectiveAssessment = { ...effectiveAssessment, disposition: 'link_existing' };
        downgradedReason = assessmentIssues.map((i) => i.message).join('; ');
      } else {
        effectiveAssessment = {
          ...effectiveAssessment,
          discoverability:
            effectiveAssessment.discoverability === 'missing_context'
              ? 'missing_context'
              : 'inconclusive',
          disposition: 'needs_confirmation',
        };
        downgradedReason = assessmentIssues.map((i) => i.message).join('; ');
      }
    }

    // 4. Execute Five-Way Disposition Routing
    switch (effectiveAssessment.disposition) {
      case 'index_only':
      case 'link_existing': {
        this.store.recordAssessment(effectiveAssessment, null);
        const navLocator =
          input.navigationTarget?.locator ??
          effectiveAssessment.checked_context.checked_files[0] ??
          effectiveAssessment.checked_context.checked_docs[0] ??
          'README.md';
        const navItem: NavigationItem = {
          id: `NAV-${randomUUID().slice(0, 8)}`,
          kind:
            effectiveAssessment.disposition === 'index_only' ? 'code_index' : 'authoritative_link',
          title: input.navigationTarget?.title ?? effectiveAssessment.question,
          locator: navLocator,
          summary:
            input.navigationTarget?.summary ??
            (effectiveAssessment.baseline_answer || '当前代码或权威文档已包含完整依据'),
          assessment_id: effectiveAssessment.id,
          created_at: new Date().toISOString(),
        };
        this.store.appendNavigationItem(navItem);
        return {
          assessmentId: effectiveAssessment.id,
          duplicate: false,
          finalDisposition: effectiveAssessment.disposition,
          persistedEntry: null,
          persistedZone: null,
          navigationItem: navItem,
          downgradedReason,
        };
      }

      case 'needs_confirmation':
      case 'discard': {
        this.store.recordAssessment(effectiveAssessment, input.candidateEntry ?? null);
        return {
          assessmentId: effectiveAssessment.id,
          duplicate: false,
          finalDisposition: effectiveAssessment.disposition,
          persistedEntry: null,
          persistedZone: null,
          navigationItem: null,
          downgradedReason,
        };
      }

      case 'knowledge_candidate': {
        if (!input.candidateEntry) {
          const fallback: CaptureAssessment = {
            ...effectiveAssessment,
            disposition: 'needs_confirmation',
          };
          this.store.recordAssessment(fallback, null);
          return {
            assessmentId: fallback.id,
            duplicate: false,
            finalDisposition: 'needs_confirmation',
            persistedEntry: null,
            persistedZone: null,
            navigationItem: null,
            downgradedReason: '缺少候选条目结构 candidateEntry',
          };
        }

        const sanitizedEntry: KnowledgeEntry = {
          ...input.candidateEntry,
          capture_assessment_id: effectiveAssessment.id,
          claim: redactSensitiveText(input.candidateEntry.claim).redactedText,
          knowledge_delta: redactSensitiveText(input.candidateEntry.knowledge_delta).redactedText,
          rationale: redactSensitiveText(input.candidateEntry.rationale).redactedText,
        };

        // share:false 只挡机器级层（domain / shared_tech）：它们写进全机共享的目录，等于把本仓经验发给所有仓库。
        // 试用区也是机器级的，所以判定要在写 probation 之前，不能只靠 upsertEntry 兜底。
        if (
          this.store.repoSettings?.().share === false &&
          (sanitizedEntry.layer === 'domain' || sanitizedEntry.layer === 'shared_tech')
        ) {
          throw new Error('本项目已关闭共享（share: false），领域与通用技术经验不会写进机器级目录。');
        }

        // Team rules are normative: a capture can only propose one for a human decision.
        if (sanitizedEntry.layer === 'team_rule') {
          const proposal: CaptureAssessment = { ...effectiveAssessment, disposition: 'needs_confirmation' };
          this.store.recordAssessment(proposal, { ...sanitizedEntry, status: 'candidate' });
          return {
            assessmentId: proposal.id, duplicate: false, finalDisposition: 'needs_confirmation',
            persistedEntry: null, persistedZone: null, navigationItem: null, proposedTeamRule: true,
            downgradedReason: '团队规范需要人工审核后才会生效',
          };
        }
        const similarExisting = this.store.findSimilarEntries?.(sanitizedEntry) ?? [];
        const withSimilar = <T extends SingleTriageOutcome>(o: T): T => (similarExisting.length ? { ...o, similarExisting } : o);

        const gate = enforceHardPublishGate(sanitizedEntry, effectiveAssessment);
        if (!gate.ok) {
          const downgraded: CaptureAssessment = {
            ...effectiveAssessment,
            disposition: 'needs_confirmation',
          };
          this.store.recordAssessment(downgraded, sanitizedEntry);
          return {
            assessmentId: downgraded.id,
            duplicate: false,
            finalDisposition: 'needs_confirmation',
            persistedEntry: null,
            persistedZone: null,
            navigationItem: null,
            downgradedReason: gate.missingFields.join('; '),
          };
        }

        const writeGate = this.readGate();
        if (writeGate === 'review') {
          const candidateOnly: KnowledgeEntry = { ...sanitizedEntry, status: 'candidate' };
          this.store.recordAssessment(effectiveAssessment, candidateOnly);
          return withSimilar({
            assessmentId: effectiveAssessment.id,
            duplicate: false,
            finalDisposition: 'knowledge_candidate',
            persistedEntry: null,
            persistedZone: null,
            navigationItem: null,
          });
        }

        // Default V3.1 `probation` mode: enters ~/.dsh/accremind/probation/ for zero-friction trial
        if (writeGate === 'probation') {
          const probationEntry: KnowledgeEntry = {
            ...sanitizedEntry,
            status: 'probation',
            maturity: 'draft',
          };
          const saved = this.store.upsertEntry(probationEntry, 'probation', effectiveAssessment);
          this.store.recordPublication?.(saved, 'AI 总结后自动进入本机试用');
          return withSimilar({
            assessmentId: effectiveAssessment.id,
            duplicate: false,
            finalDisposition: 'knowledge_candidate',
            persistedEntry: saved,
            persistedZone: 'probation',
            navigationItem: null,
          });
        }

        // `off` mode: writes directly to target active zone (still strictly gated by S03 above!)
        const targetZone: StorageZone = targetZoneForLayer(sanitizedEntry.layer);
        const activeEntry: KnowledgeEntry = { ...sanitizedEntry, status: 'active' };
        const saved = this.store.upsertEntry(activeEntry, targetZone, effectiveAssessment);
        this.store.recordPublication?.(saved, 'AI 总结后直接入库（未开启审核）');
        return withSimilar({
          assessmentId: effectiveAssessment.id,
          duplicate: false,
          finalDisposition: 'knowledge_candidate',
          persistedEntry: saved,
          persistedZone: targetZone,
          navigationItem: null,
        });
      }
    }
  }

  /**
   * Processes a batch of candidates; explicitly allows returning 0 experience entries
   * when none qualify (PRD §1.4 & §6.8.5 Rule 7).
   */
  processBatch(inputs: TriageCandidateInput[]): BatchTriageReport {
    const counts: Record<Disposition, number> = {
      index_only: 0,
      link_existing: 0,
      knowledge_candidate: 0,
      needs_confirmation: 0,
      discard: 0,
    };
    const outcomes: SingleTriageOutcome[] = [];
    const persistedExperienceEntries: KnowledgeEntry[] = [];

    for (const item of inputs) {
      const out = this.processCandidate(item);
      outcomes.push(out);
      counts[out.finalDisposition] += 1;
      if (out.persistedEntry && out.persistedEntry.knowledge_role === 'experience') {
        persistedExperienceEntries.push(out.persistedEntry);
      }
    }

    return {
      outcomes,
      dispositionCounts: counts,
      persistedExperienceEntries,
    };
  }
}
