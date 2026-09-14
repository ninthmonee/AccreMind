import assert from 'node:assert/strict';
import test from 'node:test';
import type { SchemaTypes } from '@accremind/contracts';
import { routeHumanAssessment, assessmentBlockers } from '../../apps/api/src/assessment-rules.js';
import { evidenceFingerprint } from '../../apps/api/src/assessment-evidence.js';
import { AssessmentCursor } from '../../apps/api/src/assessment-cursor.js';

const id = '00000000-0000-4000-8000-000000000001';
const body: SchemaTypes['CandidateBody'] = {
  type: 'decision',
  presentation: 'article',
  title: '合成候选',
  claim: '人工增量',
  scope: { id, kind: 'repo' },
  owner_id: id,
  knowledge_role: 'experience',
  context: {
    preconditions: ['合成'],
    exclusions: [],
    dependency_constraints: [],
    verification_method: '人工检查',
  },
  rationale: { text: '合成原因', evidence_refs: [] },
  invalidation_triggers: ['来源改变'],
  alternatives: [],
  enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
};
const assessment = (): SchemaTypes['Assessment'] => ({
  question: '当前材料可以恢复什么？',
  assessment_method: 'human_review',
  rule_version: 'human-v1',
  checked_context: {
    repo_id: id,
    commit: '1',
    materials: [
      {
        source_ref: 'synthetic:code',
        source_revision: '1',
        locator: 'line:1',
        content_hash: 'a'.repeat(64),
        material_kind: 'code',
      },
    ],
    queries: [],
    completed: true,
    incomplete_reason: 'none',
    elapsed_ms: 1,
    input_tokens: 0,
    output_tokens: 0,
    tool_calls: 1,
  },
  baseline_answer: { text: '代码行为', evidence_refs: [{ id, revision: 1, locator: 'line:1' }] },
  knowledge_delta: [],
  discoverability: 'code_recoverable',
  omission_consequence: '无需重复记录',
  priority: 'P0',
  disposition: 'index_only',
  reason: '基线已覆盖',
  confirmation_questions: [],
});

test('human routing covers all five outcomes and priority never upgrades unsupported claims', () => {
  const a = assessment();
  assert.equal(routeHumanAssessment(body, a), 'index_only');
  a.discoverability = 'authoritative_source';
  assert.equal(routeHumanAssessment(body, a), 'link_existing');
  a.discoverability = 'missing_context';
  a.knowledge_delta = [
    {
      claim_id: id,
      text: '增量',
      evidence_refs: [{ id, revision: 1, locator: 'line:1' }],
      support: 'confirmed_decision',
    },
  ];
  assert.equal(routeHumanAssessment(body, a), 'knowledge_candidate');
  for (const support of ['inference', 'unconfirmed'] as const) {
    a.knowledge_delta[0]!.support = support;
    assert.equal(routeHumanAssessment(body, a), 'needs_confirmation');
  }
  a.disposition = 'discard';
  assert.equal(routeHumanAssessment(body, a), 'discard');
});

test('incomplete, missing baseline support, conflicting claims and fake isolated checks cannot pass', () => {
  const a = assessment();
  a.checked_context.completed = false;
  a.checked_context.incomplete_reason = 'not_checked';
  assert.throws(() => routeHumanAssessment(body, a));
  a.discoverability = 'inconclusive';
  assert.equal(routeHumanAssessment(body, a), 'needs_confirmation');
  const empty = assessment();
  empty.baseline_answer.evidence_refs = [];
  assert.equal(routeHumanAssessment(body, empty), 'needs_confirmation');
  const conflict = assessment();
  conflict.confirmation_questions = ['冲突未确认'];
  assert.equal(routeHumanAssessment(body, conflict), 'needs_confirmation');
  const fake = assessment();
  fake.assessment_method = 'isolated_check';
  assert.throws(() => routeHumanAssessment(body, fake));
  const duplicate = assessment();
  duplicate.knowledge_delta = [
    {
      claim_id: id,
      text: 'a',
      evidence_refs: [{ id, revision: 1, locator: 'line:1' }],
      support: 'observed',
    },
  ];
  duplicate.knowledge_delta.push({ ...duplicate.knowledge_delta[0]! });
  assert.throws(() => routeHumanAssessment(body, duplicate));
});

test('unassessed candidates remain null and approval readiness is never fabricated', () => {
  const blockers = assessmentBlockers(body, null);
  assert.ok(blockers.some((b) => b.code === 'BASELINE_INCOMPLETE'));
  assert.ok(blockers.some((b) => b.code === 'CAPABILITY_NOT_READY'));
});

test('fingerprints include candidate content, checked materials and assertion mapping', () => {
  const a = assessment();
  const original = evidenceFingerprint(body, a, []);
  assert.notEqual(evidenceFingerprint({ ...body, claim: 'changed' }, a, []), original);
  a.baseline_answer.evidence_refs[0]!.locator = 'line:2';
  assert.notEqual(evidenceFingerprint(body, a, []), original);
});

test('signed assessment cursors bind principal, scope, query and endpoint', () => {
  const cursor = new AssessmentCursor();
  const ctx = { tenantId: id, actorId: id, authzVersion: 1 };
  const filter = { kind: 'navigation', scope: id, query: 'x' };
  const position = { rank: 0, date: '2026-09-14T00:00:00.000001Z', id };
  const token = cursor.encode(ctx, filter, position);
  const internalRow = { ...position, document: 'internal-query-field'.repeat(1000) };
  assert.ok(cursor.encode(ctx, filter, internalRow).length < 1024);
  assert.deepEqual(cursor.decode(ctx, filter, token), position);
  assert.throws(() => cursor.decode(ctx, { ...filter, query: 'y' }, token));
  assert.throws(() => cursor.decode({ ...ctx, authzVersion: 2 }, filter, token));
  assert.throws(() => cursor.decode(ctx, { ...filter, kind: 'reviews' }, token));
  assert.throws(() => cursor.decode(ctx, filter, `${token}x`));
});
