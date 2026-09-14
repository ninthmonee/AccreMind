import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { allowedScopesSql } from './authorization.js';
import { AccessDeniedError } from './database.js';
import type { TransactionClient } from './database.js';
import type { EvidenceStore } from './evidence-store.js';
import {
  allCandidateRefs,
  assessmentEvidence,
  checkEvidenceFiles,
  evidenceFingerprint,
  evidenceMetadata,
  PostgresBaselineMaterialResolver,
  uniqueRefs,
} from './assessment-evidence.js';

export type CandidateRow = {
  id: string;
  contribution_id: string;
  contributor_id: string;
  scope_id: string;
  owner_id: string;
  revision: string;
  body: SchemaTypes['CandidateBody'];
  created_at: Date;
  publication_status: SchemaTypes['Publication'];
  creation_kind: 'new' | 'revision';
  target_knowledge_id: string | null;
  base_content_revision: string | null;
  base_aggregate_revision: string | null;
  repo_id: string;
  environment: SchemaTypes['Environment'];
};
export type AssessmentRow = {
  id: string;
  revision: string;
  document: SchemaTypes['Assessment'];
  checked_by: string;
  created_at: Date;
  evidence_set_hash: string;
};

export async function findCandidate(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  capability: string,
  lock = false,
): Promise<CandidateRow> {
  const result = await client.query<CandidateRow>(
    `WITH allowed AS (${allowedScopesSql}) SELECT c.*,contribution.repo_id,contribution.environment FROM akb.candidates c
     JOIN allowed ON allowed.id=c.scope_id JOIN akb.contributions contribution ON contribution.tenant_id=c.tenant_id AND contribution.id=c.contribution_id
     WHERE c.tenant_id=$1 AND c.id=$5 ${lock ? 'FOR UPDATE OF c' : ''}`,
    [ctx.tenantId, ctx.actorId, ctx.authzVersion, capability, id],
  );
  if (!result.rows[0]) throw new AccessDeniedError();
  return result.rows[0];
}

export async function currentAssessment(
  client: TransactionClient,
  ctx: PrincipalContext,
  row: CandidateRow,
): Promise<AssessmentRow | null> {
  const result = await client.query<AssessmentRow>(
    'SELECT id,revision,document,checked_by,created_at,evidence_set_hash FROM akb.assessments WHERE tenant_id=$1 AND candidate_id=$2 AND candidate_revision=$3 ORDER BY revision DESC LIMIT 1',
    [ctx.tenantId, row.id, row.revision],
  );
  return result.rows[0] ?? null;
}

export const assessmentRecord = (row: AssessmentRow): SchemaTypes['AssessmentRecord'] => ({
  id: row.id,
  revision: Number(row.revision),
  assessment: row.document,
  checked_by: row.checked_by,
  created_at: row.created_at.toISOString(),
});

export async function historicalCandidate(
  client: TransactionClient,
  ctx: PrincipalContext,
  row: CandidateRow,
  revision: number,
): Promise<CandidateRow> {
  const result = await client.query<
    Pick<
      CandidateRow,
      | 'revision'
      | 'body'
      | 'creation_kind'
      | 'target_knowledge_id'
      | 'base_content_revision'
      | 'base_aggregate_revision'
    >
  >(
    'SELECT revision,body,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision FROM akb.candidate_revisions WHERE tenant_id=$1 AND candidate_id=$2 AND revision=$3',
    [ctx.tenantId, row.id, revision],
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw new AccessDeniedError();
  return { ...row, ...snapshot, owner_id: snapshot.body.owner_id };
}

export function candidateRecord(
  row: CandidateRow,
  assessment: AssessmentRow | null,
  hash: string,
): SchemaTypes['Candidate'] {
  return {
    id: row.id,
    revision: Number(row.revision),
    body: row.body,
    ...(assessment
      ? { assessment_id: assessment.id, assessment_revision: Number(assessment.revision) }
      : { assessment_id: null, assessment_revision: null }),
    evidence_set_hash: hash,
    publication_status: row.publication_status,
    contributor_id: row.contributor_id,
    created_at: row.created_at.toISOString(),
    ...(row.creation_kind === 'revision'
      ? {
          creation_kind: 'revision' as const,
          revision_binding: {
            target_knowledge_id: row.target_knowledge_id!,
            base_content_revision: Number(row.base_content_revision),
            base_aggregate_revision: Number(row.base_aggregate_revision),
          },
        }
      : { creation_kind: 'new' as const, revision_binding: null }),
  };
}

export async function hydrateCandidate(
  client: TransactionClient,
  ctx: PrincipalContext,
  row: CandidateRow,
  store: EvidenceStore,
  capability: string,
) {
  const assessment = await currentAssessment(client, ctx, row);
  const materials = assessment
    ? await new PostgresBaselineMaterialResolver().resolve(
        client,
        ctx,
        row.repo_id,
        assessment.document.checked_context.materials,
        assessmentEvidence(assessment.document),
      )
    : [];
  const refs = uniqueRefs([
    ...allCandidateRefs(row.body, assessment?.document ?? null),
    ...materials.map((material) => material.evidenceRef),
  ]);
  const metadata = await evidenceMetadata(client, ctx, refs);
  await checkEvidenceFiles(store, ctx, metadata);
  const hash = evidenceFingerprint(row.body, assessment?.document ?? null, metadata);
  if (assessment && hash !== assessment.evidence_set_hash) throw new AccessDeniedError();
  await evidenceMetadata(client, ctx, refs);
  await findCandidate(client, ctx, row.id, capability);
  return {
    candidate: candidateRecord(row, assessment, hash),
    assessment: assessment ? assessmentRecord(assessment) : null,
    refs,
    metadata,
    materials,
  };
}

export function hiddenCandidate(row: CandidateRow): SchemaTypes['Candidate'] {
  const body: SchemaTypes['CandidateBody'] = {
    type: 'process',
    presentation: 'article',
    title: '内容不可访问',
    claim: '当前主体无权查看所需证据。',
    scope: row.body.scope,
    owner_id: row.owner_id,
    knowledge_role: 'experience',
    context: {
      preconditions: ['证据不可访问'],
      exclusions: [],
      dependency_constraints: [],
      verification_method: '恢复权限后重新检查',
    },
    rationale: { text: '受权限保护的安全占位', evidence_refs: [] },
    invalidation_triggers: ['证据权限变更'],
    alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', artifact_refs: [] },
  };
  return { ...candidateRecord(row, null, '0'.repeat(64)), body };
}
