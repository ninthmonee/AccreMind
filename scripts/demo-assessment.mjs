import { randomUUID, createHash } from 'node:crypto';
import { createApiClient } from '@accremind/contracts';
import {
  syntheticMaterials,
  syntheticBaselineCommit,
} from '../apps/api/src/synthetic-materials.ts';

// Synthetic fixtures only. This does not assert a real repository check or independent approval.
const endpointValue = process.env.AKB_ENDPOINT ?? 'http://127.0.0.1:3100';
if (!URL.canParse(endpointValue)) throw new Error('Invalid synthetic demo endpoint');
const endpoint = new URL(endpointValue);
if (
  !['http:', 'https:'].includes(endpoint.protocol) ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.pathname !== '/'
)
  throw new Error('Synthetic demo requires a credential-free loopback endpoint');
const api = createApiClient({ baseUrl: new URL('/api/v1', endpoint).href });
const repo = '00000000-0000-4000-8000-000000000004';
const scope = '00000000-0000-4000-8000-000000000005';
const actor = '00000000-0000-4000-8000-000000000002';
const fixtures = new Map();
for (const fixture of syntheticMaterials) {
  const evidence = await api.request('getEvidence', {
    path: { id: fixture.evidenceId },
    query: { revision: 1 },
  });
  if (evidence.sha256 !== fixture.material.content_hash)
    throw new Error('Synthetic baseline has changed');
  fixtures.set(fixture.material.material_kind, {
    material: fixture.material,
    ref: { id: evidence.id, revision: evidence.revision, locator: evidence.locator },
  });
}
const code = fixtures.get('code');
const doc = fixtures.get('authoritative_doc');
const history = fixtures.get('history');
const task = await api.request('createTask', {
  body: {
    operation_id: randomUUID(),
    repo_id: repo,
    client_session_id: `synthetic-assessment-${randomUUID()}`,
  },
});
const outcomes = [];
for (const disposition of [
  'index_only',
  'link_existing',
  'knowledge_candidate',
  'needs_confirmation',
  'discard',
]) {
  const content = `合成贡献演练：${disposition}`;
  const baseline = disposition === 'link_existing' ? doc : code;
  const body = {
    type: 'decision',
    presentation: 'article',
    title: `合成分流：${disposition}`,
    claim:
      disposition === 'knowledge_candidate'
        ? '讨论记录中的历史动机不能由代码行为恢复。'
        : '合成基线中的行为或规范。',
    scope: { kind: 'repo', id: scope },
    owner_id: actor,
    knowledge_role: 'experience',
    context: {
      preconditions: ['合成开发环境'],
      exclusions: [],
      dependency_constraints: [],
      verification_method: '查阅已登记合成材料',
    },
    rationale: {
      text: '引用授权合成来源',
      evidence_refs: [disposition === 'knowledge_candidate' ? history.ref : baseline.ref],
    },
    invalidation_triggers: ['来源版本改变'],
    alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
  };
  const receive = await api.request('ingestContribution', {
    body: {
      idempotency_key: randomUUID(),
      repo_id: repo,
      task_id: task.id,
      source_event_ids: [randomUUID()],
      environment: { commit: syntheticBaselineCommit, dependencies: {} },
      candidates: [body],
      evidence: [
        {
          client_evidence_id: randomUUID(),
          source_kind: 'selected_text',
          source_ref: 'synthetic:assessment-demo',
          source_revision: '1',
          locator: 'line:1',
          content,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    },
  });
  const candidate = (
    await api.request('getContribution', { path: { id: receive.contribution_id } })
  ).candidates[0];
  const complete = disposition !== 'needs_confirmation' && disposition !== 'discard';
  const assessment = {
    question: '当前基线能够恢复哪些行为、规范与动机？',
    assessment_method: 'human_review',
    rule_version: 'human-v1',
    checked_context: {
      repo_id: repo,
      commit: syntheticBaselineCommit,
      materials: complete ? [baseline.material] : [],
      queries: complete ? ['查阅登记的合成材料'] : [],
      completed: complete,
      incomplete_reason: complete ? 'none' : 'not_checked',
      elapsed_ms: 10,
      input_tokens: 0,
      output_tokens: 0,
      tool_calls: complete ? 1 : 0,
    },
    baseline_answer: {
      text: complete ? '合成材料已覆盖行为或规范，不推断历史原因。' : '尚未执行检查。',
      evidence_refs: complete ? [baseline.ref] : [],
    },
    discoverability: !complete
      ? 'inconclusive'
      : disposition === 'index_only'
        ? 'code_recoverable'
        : disposition === 'link_existing'
          ? 'authoritative_source'
          : 'missing_context',
    knowledge_delta:
      disposition === 'knowledge_candidate'
        ? [
            {
              claim_id: randomUUID(),
              text: '历史讨论确认了保留人工审核的动机。',
              evidence_refs: [history.ref],
              support: 'confirmed_decision',
            },
          ]
        : [],
    omission_consequence: '合成演练记录遗漏必要上下文的后果。',
    priority: 'P1',
    disposition,
    reason:
      disposition === 'discard'
        ? '显式人工判定：合成重复条目无复用价值。'
        : '按登记材料与证据进行合成分流。',
    confirmation_questions: disposition === 'needs_confirmation' ? ['补充实际基线检查。'] : [],
  };
  const input = { operation_id: randomUUID(), expected_revision: candidate.revision, assessment };
  const saved = await api.request('writeAssessment', { path: { id: candidate.id }, body: input });
  const retry = await api.request('writeAssessment', { path: { id: candidate.id }, body: input });
  const state = await api.request('getContribution', { path: { id: receive.contribution_id } });
  const view = await api.request('getCandidateReview', { path: { id: candidate.id } });
  outcomes.push({
    disposition: saved.assessment.disposition,
    contribution_id: state.id,
    processing_status: state.processing_status,
    route_counts: state.route_counts,
    candidate_revision: view.candidate.revision,
    assessment_id: saved.id,
    assessment_revision: saved.revision,
    idempotent: retry.id === saved.id && retry.revision === saved.revision,
    published_ids: state.published_ids,
  });
}
const navigation = await api.request('listNavigation', {
  query: { scope_id: scope, query: '合成分流：' },
});
console.log(
  JSON.stringify(
    {
      mode: 'synthetic',
      outcomes,
      navigation,
      real_repository_check: false,
      independent_approval: false,
    },
    null,
    2,
  ),
);
