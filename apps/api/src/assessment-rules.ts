import type { SchemaTypes } from '@accremind/contracts';
import { invalidInput } from './contribution-errors.js';

export const humanRuleVersion = 'human-v1';

export function routeHumanAssessment(
  body: SchemaTypes['CandidateBody'],
  assessment: SchemaTypes['Assessment'],
): SchemaTypes['Disposition'] {
  const check = assessment.checked_context;
  if (
    assessment.assessment_method !== 'human_review' ||
    assessment.model_version !== undefined ||
    assessment.rule_version !== humanRuleVersion
  )
    invalidInput('Only the registered human-v1 manual assessment path is implemented');
  if (
    new Set(assessment.knowledge_delta.map((delta) => delta.claim_id)).size !==
    assessment.knowledge_delta.length
  )
    invalidInput('Claim identities must be unique');
  if (check.completed !== (check.incomplete_reason === 'none'))
    invalidInput('Completion and incomplete reason conflict');
  if (!check.completed && assessment.discoverability !== 'inconclusive')
    invalidInput('Incomplete checks must remain inconclusive');
  if (assessment.disposition === 'discard') return 'discard'; // Explicit human decision; reason is schema-required.
  if (
    !check.completed ||
    assessment.discoverability === 'inconclusive' ||
    assessment.confirmation_questions.length > 0 ||
    assessment.knowledge_delta.some(
      (delta) => delta.support === 'inference' || delta.support === 'unconfirmed',
    )
  )
    return 'needs_confirmation';
  if (
    !check.materials.some((material) => material.material_kind !== 'history') ||
    !assessment.baseline_answer.evidence_refs.length
  )
    return 'needs_confirmation';
  if (!assessment.knowledge_delta.length) {
    if (assessment.discoverability === 'authoritative_source') return 'link_existing';
    if (assessment.discoverability === 'code_recoverable') return 'index_only';
    return 'needs_confirmation';
  }
  if (assessment.discoverability === 'missing_context' && body.knowledge_role === 'experience')
    return 'knowledge_candidate';
  return 'needs_confirmation';
}

export function assessmentBlockers(
  body: SchemaTypes['CandidateBody'],
  assessment: SchemaTypes['Assessment'] | null,
): SchemaTypes['Blocker'][] {
  const blockers: SchemaTypes['Blocker'][] = [];
  const add = (code: string, field: string, message: string) =>
    blockers.push({ code, field, message });
  if (!assessment || !assessment.checked_context.completed)
    add('BASELINE_INCOMPLETE', 'assessment.checked_context', '基线检查尚未完成');
  if (assessment && !assessment.knowledge_delta.length && body.knowledge_role === 'experience')
    add('DELTA_EMPTY', 'assessment.knowledge_delta', '没有独立知识增量');
  if (
    assessment?.knowledge_delta.some(
      (delta) => delta.support === 'inference' || delta.support === 'unconfirmed',
    )
  )
    add('CLAIM_UNSUPPORTED', 'assessment.knowledge_delta', '存在未确认断言');
  if (assessment?.disposition === 'needs_confirmation')
    add('CONFIRMATION_REQUIRED', 'assessment.confirmation_questions', '仍需补充或确认');
  if (body.knowledge_role === 'authoritative_mirror')
    add('MIRROR_APPROVAL_REQUIRED', 'body.mirror', '权威镜像仍需独立显式批准');
  add('CAPABILITY_NOT_READY', 'review', '独立审核与发布尚未实现');
  return blockers;
}
