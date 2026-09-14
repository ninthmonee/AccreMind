import { randomUUID, createHash } from 'node:crypto';
import { createApiClient } from '@accremind/contracts';

// Entire fixture is generated here; no workspace files or real source materials are read.
const endpoint = new URL(process.env.AKB_ENDPOINT ?? 'http://127.0.0.1:3100');
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
const task = await api.request('createTask', {
  body: {
    operation_id: randomUUID(),
    repo_id: repo,
    client_session_id: `synthetic-demo-${randomUUID()}`,
  },
});
const content = '合成演练记录：接收贡献不等于审核通过或知识发布。';
const bundle = () => ({
  idempotency_key: randomUUID(),
  repo_id: repo,
  task_id: task.id,
  source_event_ids: [randomUUID()],
  environment: { commit: 'synthetic-demo', dependencies: {} },
  evidence: [
    {
      client_evidence_id: randomUUID(),
      source_kind: 'selected_text',
      source_ref: 'synthetic:manual-demo',
      source_revision: '1',
      locator: 'line:1',
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  ],
});
const first = bundle();
const receive = await api.request('ingestContribution', { body: first });
const retry = await api.request('ingestContribution', { body: first });
const ref = receive.evidence_mappings[0]?.evidence_ref;
if (!ref) throw new Error('Synthetic evidence read grant is missing');
const manual = bundle();
manual.candidates = [
  {
    type: 'guideline',
    presentation: 'article',
    title: '合成候选：区分接收和发布',
    claim: '贡献接收成功后，仍须完成增量判定与独立审核。',
    scope: { kind: 'repo', id: scope },
    owner_id: actor,
    knowledge_role: 'experience',
    context: {
      preconditions: ['合成开发环境'],
      exclusions: [],
      dependency_constraints: [],
      verification_method: '检查接收记录与候选状态',
    },
    rationale: { text: '引用合成演练记录', evidence_refs: [ref] },
    invalidation_triggers: ['处理状态契约改变'],
    alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
  },
];
const candidateReceive = await api.request('ingestContribution', { body: manual });
const state = await api.request('getContribution', {
  path: { id: candidateReceive.contribution_id },
});
const evidence = await api.request('getEvidence', {
  path: { id: ref.id },
  query: { revision: ref.revision },
});
console.log(
  JSON.stringify(
    {
      mode: 'synthetic',
      task_id: task.id,
      initial: receive,
      retry: retry.result,
      manual_contribution: state,
      evidence_integrity: evidence.sha256 === first.evidence[0].sha256,
      real_login: false,
    },
    null,
    2,
  ),
);
