import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../capture/secret-redactor.ts';
import { generateEntryId } from '../contracts/ids.ts';
import { isRepositoryKnowledgeLayer, type CaptureAssessment, type KnowledgeEntry } from '../contracts/types.ts';
import { enforceHardPublishGate, isAbsoluteMachinePath } from '../contracts/validator.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';

/**
 * Human review of captured candidates: the decision rules live in the core so that the local plugin,
 * a team repository bot and a server apply exactly the same gate.
 */

type ReviewItem = NonNullable<ReturnType<LocalMarkdownSqliteStore['getReviewItem']>>;

function publishAssessment(assessment: CaptureAssessment): CaptureAssessment {
  return { ...assessment, discoverability: 'missing_context', disposition: 'knowledge_candidate' };
}

export function reviewMissingFields(item: ReviewItem): string[] {
  if (item.reviewState !== 'pending') return [];
  if (!item.candidateDraft) return ['candidateEntry: 待补条目正文及可定位证据'];
  const gate = enforceHardPublishGate(item.candidateDraft, publishAssessment(item.assessment));
  return gate.ok ? [] : gate.missingFields;
}

function createReviewDraft(store: LocalMarkdownSqliteStore, a: CaptureAssessment): KnowledgeEntry {
  let id: string;
  do {
    id = generateEntryId('K');
  } while (store.isEntryIdTaken(id));
  const now = new Date().toISOString();
  return {
    id,
    revision: 1,
    type: 'pitfall',
    layer: 'project',
    knowledge_role: 'experience',
    title: '',
    claim: '',
    rationale: '',
    knowledge_delta: a.knowledge_delta,
    preconditions: [],
    exclusions: [],
    invalidation_triggers: [],
    verification_method: '',
    search_aliases: [],
    watch_paths: [],
    symbol_anchors: [],
    dependency_constraints: [],
    evidence: [],
    alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', ref: null },
    status: 'candidate',
    maturity: 'draft',
    freshness: 'current',
    serving: 'enabled',
    priority: a.priority,
    capture_assessment_id: a.id,
    supersedes: null,
    created_at: now,
    updated_at: now,
    last_validated_at: null,
    review_due_at: new Date(Date.now() + 90 * 86400000).toISOString(),
  };
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? redactSensitiveText(value.trim()).redactedText : '';
}

export function decideReview(store: LocalMarkdownSqliteStore, params: Record<string, unknown>) {
  const assessmentId = String(params.assessmentId ?? '');
  const item = store.getReviewItem(assessmentId);
  if (!item) throw new Error('当前工作区找不到该候选');
  if (item.reviewState !== 'pending') throw new Error('这条候选已由其他操作处理，请刷新队列');
  const decision = params.decision;
  if (decision === 'index_only' || decision === 'link_existing' || decision === 'discard') {
    return store.decideAssessment({
      assessmentId,
      decision,
      navigationLocator: textValue(params.navigationLocator),
    });
  }
  if (
    decision !== 'approve_active' &&
    decision !== 'approve_probation' &&
    decision !== 'supplement' &&
    decision !== 'needs_confirmation'
  ) {
    throw new Error('请选择有效的审核操作');
  }
  let assessment = item.assessment;
  if (decision === 'needs_confirmation') {
    store.recordAssessment(
      { ...assessment, discoverability: 'inconclusive', disposition: 'needs_confirmation' },
      item.candidateDraft,
    );
    return { ok: true };
  }

  let draft = item.candidateDraft;
  const patch = params.editedEntry as Partial<KnowledgeEntry> | undefined;
  const locator = textValue(params.evidenceLocator);
  const note = textValue(params.evidenceNote);
  const delta = textValue(params.knowledgeDelta ?? patch?.knowledge_delta);
  if (locator || note) {
    if (!locator || !note || !delta)
      return { ok: false, missingFields: ['evidence: 请同时填写证据位置、核实说明和对应增量'] };
    if (isAbsoluteMachinePath(locator))
      return {
        ok: false,
        missingFields: ['evidence.locator: 请使用仓库相对路径、提交或稳定文档引用'],
      };
  }
  if (patch || delta || locator) {
    draft = { ...(draft ?? createReviewDraft(store, assessment)) };
    if (patch?.layer !== undefined) {
      if (!isRepositoryKnowledgeLayer(patch.layer) || !isRepositoryKnowledgeLayer(draft.layer)) {
        return {ok:false, missingFields:['layer: 仅可在本仓库的领域知识和项目知识之间调整归属']};
      }
      draft.layer = patch.layer;
    }
    for (const key of ['title', 'claim', 'rationale', 'verification_method'] as const) {
      if (patch && key in patch) draft[key] = textValue(patch[key]);
    }
    for (const key of ['preconditions', 'invalidation_triggers'] as const) {
      if (patch && Array.isArray(patch[key]))
        draft[key] = patch[key]!.map(textValue).filter(Boolean);
    }
    if (delta) {
      draft.knowledge_delta = delta;
      assessment = { ...assessment, knowledge_delta: delta };
    }
    if (locator) {
      const evidence = {
        id: 'EV-' + randomUUID().slice(0, 8),
        source_type: 'doc_ref' as const,
        source_ref: locator.split('#')[0] || locator,
        locator,
        summary: note,
      };
      draft.evidence = [...draft.evidence.filter((e) => e.locator !== locator), evidence];
      const mapping = { assertion: delta, evidence_locator: locator, verified_fact: true };
      assessment = {
        ...assessment,
        claim_evidence_map: [
          ...assessment.claim_evidence_map.filter((m) => m.assertion !== delta),
          mapping,
        ],
      };
    }
  }
  if (decision === 'supplement' || patch || delta || locator) {
    if (!draft) return { ok: false, missingFields: ['candidateEntry: 请补充候选内容'] };
    const proposed = publishAssessment(assessment);
    const complete =
      (assessment.disposition === 'knowledge_candidate' ||
        assessment.claim_evidence_map.some(
          (m) =>
            m.verified_fact && m.evidence_locator && m.assertion === assessment.knowledge_delta,
        )) &&
      enforceHardPublishGate(draft, proposed).ok;
    assessment = complete
      ? proposed
      : { ...assessment, discoverability: 'inconclusive', disposition: 'needs_confirmation' };
    store.recordAssessment(assessment, draft);
    if (decision === 'supplement')
      return {
        ok: true,
        missingFields: reviewMissingFields({
          assessment,
          candidateDraft: draft,
          reviewState: 'pending',
        }),
      };
  }
  if (assessment.disposition === 'needs_confirmation') {
    const missing = reviewMissingFields({
      assessment,
      candidateDraft: draft,
      reviewState: 'pending',
    });
    return {
      ok: false,
      missingFields: missing.length ? missing : ['evidence: 请核实并补充证据后批准'],
    };
  }
  return store.decideAssessment({ assessmentId, decision });
}
