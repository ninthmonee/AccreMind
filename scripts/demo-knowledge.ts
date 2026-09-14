import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDevelopmentConfig } from '@accremind/domain';
import type { SchemaTypes } from '@accremind/contracts';
import { createDatabasePool } from '../apps/api/src/database.js';
import {
  syntheticContributionsEnabled,
  syntheticRepoId as repo,
  syntheticScopeId as scopeId,
  syntheticReviewerId,
} from '../apps/api/src/synthetic-contributions.js';
import {
  syntheticMaterials,
  syntheticBaselineCommit,
} from '../apps/api/src/synthetic-materials.js';
import { FileEvidenceStore, sha256 } from '../apps/api/src/evidence-store.js';
import { PostgresContributionService } from '../apps/api/src/contributions.js';
import { PostgresAssessmentService } from '../apps/api/src/assessments.js';
import { PostgresGovernanceService } from '../apps/api/src/governance.js';

// Explicit local fixture exercise through real application services; not an actual team review.
const config = loadDevelopmentConfig(process.env);
if (!syntheticContributionsEnabled(process.env, config))
  throw new Error('Enable the fixed synthetic development identity first');
const contributor = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000002',
  authzVersion: 1,
};
const reviewer = { ...contributor, actorId: syntheticReviewerId },
  scope = { kind: 'repo' as const, id: scopeId };
const pool = createDatabasePool(config.databaseUrl!, 2);
const evidence = new FileEvidenceStore(
  process.env.AKB_SYNTHETIC_EVIDENCE_DIR ??
    fileURLToPath(new URL('../.local/evidence/', import.meta.url)),
);
const contributions = new PostgresContributionService(pool, evidence),
  assessments = new PostgresAssessmentService(pool, evidence),
  governance = new PostgresGovernanceService(pool, evidence);
try {
  const refs = new Map<string, SchemaTypes['EvidenceRef']>();
  for (const fixture of syntheticMaterials) {
    const saved = await governance.retain(reviewer, fixture.evidenceId, {
      operation_id: randomUUID(),
      source_evidence_revision: 1,
      locator: fixture.material.locator,
    });
    refs.set(fixture.material.material_kind, {
      id: saved.id,
      revision: saved.revision,
      locator: saved.locator,
    });
  }
  const task = await contributions.createTask(contributor, {
    operation_id: randomUUID(),
    repo_id: repo,
    client_session_id: 'web-published-fixture-v1',
  });
  for (const mirror of [false, true]) {
    const baseline = syntheticMaterials.find(
        (f) => f.material.material_kind === (mirror ? 'authoritative_doc' : 'code'),
      )!,
      ref = refs.get(mirror ? 'authoritative_doc' : 'code')!,
      history = refs.get('history')!;
    const body: SchemaTypes['CandidateBody'] = {
      type: mirror ? 'guideline' : 'decision',
      presentation: 'article',
      title: mirror ? '合成示例：接收、审核与发布的区别' : '合成示例：为什么保留独立人工审核',
      claim: mirror
        ? '接收贡献不等于审核通过，审核通过也需完成异步发布。'
        : '团队因独立审核要求保留人工判定，不自动发布。',
      scope,
      owner_id: contributor.actorId,
      knowledge_role: mirror ? 'authoritative_mirror' : 'experience',
      context: {
        preconditions: ['仅用于本地合成开发演练'],
        exclusions: ['不能作为真实团队已批准的规范'],
        dependency_constraints: [],
        verification_method: '核对已登记的合成基线与讨论记录',
      },
      rationale: {
        text: '来自合成讨论或合成权威材料；不代表真实组织审核。',
        evidence_refs: [mirror ? ref : history],
      },
      invalidation_triggers: ['来源版本或审核要求改变'],
      alternatives: [],
      enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
      ...(mirror
        ? {
            mirror: {
              authority_ref: ref,
              sync_owner_id: contributor.actorId,
              reason: '演示合成权威规范镜像，零经验增量',
            },
          }
        : {}),
    };
    const content = '合成页面示例材料';
    const packet = await contributions.ingest(contributor, {
      idempotency_key: randomUUID(),
      repo_id: repo,
      task_id: task.id,
      source_event_ids: [randomUUID()],
      environment: { commit: syntheticBaselineCommit, dependencies: {} },
      evidence: [
        {
          client_evidence_id: randomUUID(),
          source_kind: 'selected_text',
          source_ref: 'synthetic:web-fixture',
          source_revision: 'v1',
          locator: 'line:1',
          content,
          sha256: sha256(content),
        },
      ],
      candidates: [body],
    } satisfies SchemaTypes['IngestRequest']);
    const candidate = (await contributions.get(contributor, packet.contribution_id)).candidates[0]!;
    await assessments.saveHumanCheck(contributor, candidate.id, {
      operation_id: randomUUID(),
      expected_revision: candidate.revision,
      assessment: {
        question: '合成基线能否恢复独立审核的历史动机？',
        assessment_method: 'human_review',
        rule_version: 'human-v1',
        checked_context: {
          repo_id: repo,
          commit: syntheticBaselineCommit,
          materials: [baseline.material],
          queries: ['核对已登记合成材料'],
          completed: true,
          incomplete_reason: 'none',
          elapsed_ms: 1,
          input_tokens: 0,
          output_tokens: 0,
          tool_calls: 1,
        },
        baseline_answer: { text: '基线记录行为或规范，不额外虚构历史动机。', evidence_refs: [ref] },
        discoverability: mirror ? 'authoritative_source' : 'missing_context',
        knowledge_delta: mirror
          ? []
          : [
              {
                claim_id: randomUUID(),
                text: '保留人工判定的独立审核动机。',
                evidence_refs: [history],
                support: 'confirmed_decision',
              },
            ],
        omission_consequence: '可能混淆接收与发布，遗漏历史动机。',
        priority: 'P1',
        disposition: mirror ? 'link_existing' : 'knowledge_candidate',
        reason: '固定合成材料演练，不是实际组织审核',
        confirmation_questions: [],
      },
    });
    const view = await assessments.getReview(reviewer, candidate.id);
    const approval = await governance.review(reviewer, candidate.id, {
      operation_id: randomUUID(),
      expected_revision: view.candidate.revision,
      assessment_revision: view.assessment!.revision,
      evidence_set_hash: view.candidate.evidence_set_hash,
      scope,
      action: 'approve',
      disposition: view.assessment!.assessment.disposition,
      reason: '独立固定合成主体演练，非真实人工验收',
      ...(mirror ? { mirror_approval: true } : {}),
    });
    const current = await assessments.getReview(contributor, candidate.id);
    const publication = await governance.request(contributor, candidate.id, {
      operation_id: randomUUID(),
      expected_revision: current.candidate.revision,
      assessment_revision: current.assessment!.revision,
      review_id: approval.review_id,
      evidence_set_hash: current.candidate.evidence_set_hash,
    } satisfies SchemaTypes['PublishRequest']);
    console.log(
      JSON.stringify({
        synthetic: true,
        title: body.title,
        publication_id: publication.publication_id,
        status: publication.status,
      }),
    );
  }
} finally {
  await pool.end();
}
