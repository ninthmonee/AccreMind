import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { allowedScopesSql } from './authorization.js';
import { AccessDeniedError } from './database.js';
import type { TransactionClient } from './database.js';
import { canonicalJson, candidateEvidence } from './contribution-input.js';
import type { EvidenceStore } from './evidence-store.js';
import { sha256 } from './evidence-store.js';

export type EvidenceMetadata = {
  id: string;
  revision: string;
  locator: string;
  sha256: string;
  object_key: string;
  scope_id: string;
  contribution_id: string | null;
  source_ref: string;
  source_revision: string;
  evidence_kind: 'raw' | 'retained';
  expires_at: Date;
};

export function assessmentEvidence(
  assessment: SchemaTypes['Assessment'],
): SchemaTypes['EvidenceRef'][] {
  return [
    ...assessment.baseline_answer.evidence_refs,
    ...assessment.knowledge_delta.flatMap((delta) => delta.evidence_refs),
  ];
}

export function uniqueRefs(
  refs: readonly SchemaTypes['EvidenceRef'][],
): SchemaTypes['EvidenceRef'][] {
  return [...new Map(refs.map((ref) => [canonicalJson(ref), ref])).values()];
}

export async function evidenceMetadata(
  client: TransactionClient,
  ctx: PrincipalContext,
  refs: readonly SchemaTypes['EvidenceRef'][],
): Promise<EvidenceMetadata[]> {
  const distinct = uniqueRefs(refs);
  if (!distinct.length) return [];
  const result = await client.query<EvidenceMetadata>(
    `WITH allowed AS (${allowedScopesSql}), requested AS (
      SELECT id,revision,locator FROM jsonb_to_recordset($5::jsonb) AS ref(id uuid,revision bigint,locator text))
     SELECT e.* FROM requested ref JOIN akb.evidence e ON e.tenant_id=$1 AND e.id=ref.id AND e.revision=ref.revision AND e.locator=ref.locator
     JOIN allowed ON allowed.id=e.scope_id WHERE e.status='available' AND e.expires_at>now()`,
    [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'evidence:read', JSON.stringify(distinct)],
  );
  if (result.rows.length !== distinct.length) throw new AccessDeniedError();
  return result.rows;
}

export type ResolvedMaterial = SchemaTypes['Material'] & {
  evidenceRef: SchemaTypes['EvidenceRef'];
  scopeId: string;
};
export interface BaselineMaterialResolver {
  resolve(
    client: TransactionClient,
    ctx: PrincipalContext,
    repoId: string,
    materials: readonly SchemaTypes['Material'][],
    preferredRefs?: readonly SchemaTypes['EvidenceRef'][],
  ): Promise<ResolvedMaterial[]>;
}

/** Registry is owner-provisioned. Request JSON cannot register authority or invent a read/hash. */
export class PostgresBaselineMaterialResolver implements BaselineMaterialResolver {
  async resolve(
    client: TransactionClient,
    ctx: PrincipalContext,
    repoId: string,
    materials: readonly SchemaTypes['Material'][],
    preferredRefs?: readonly SchemaTypes['EvidenceRef'][],
  ): Promise<ResolvedMaterial[]> {
    if (!materials.length) return [];
    const distinct = [
      ...new Map(materials.map((material) => [canonicalJson(material), material])).values(),
    ];
    const result = await client.query<
      SchemaTypes['Material'] & { evidence_id: string; evidence_revision: string; scope_id: string }
    >(
      `WITH allowed AS (${allowedScopesSql}), requested AS (
       SELECT * FROM jsonb_to_recordset($6::jsonb) AS m(source_ref text,source_revision text,locator text,content_hash text,material_kind text))
       SELECT b.source_ref,b.source_revision,b.locator,b.content_hash,b.material_kind,e.id AS evidence_id,e.revision AS evidence_revision,e.scope_id
       FROM requested m JOIN akb.baseline_materials b ON b.tenant_id=$1 AND b.repo_id=$5 AND b.source_ref=m.source_ref
       AND b.source_revision=m.source_revision AND b.locator=m.locator AND b.content_hash=m.content_hash AND b.material_kind=m.material_kind
       JOIN LATERAL (SELECT candidate.* FROM akb.evidence candidate
         LEFT JOIN akb.retained_evidence_sources lineage ON lineage.tenant_id=candidate.tenant_id AND lineage.evidence_id=candidate.id AND lineage.evidence_revision=candidate.revision
         WHERE candidate.tenant_id=b.tenant_id AND ((candidate.id=b.evidence_id AND candidate.revision=b.evidence_revision)
           OR (lineage.source_id=b.evidence_id AND lineage.source_revision=b.evidence_revision AND EXISTS(SELECT 1 FROM jsonb_to_recordset($7::jsonb) AS ref(id uuid,revision bigint,locator text) WHERE ref.id=candidate.id AND ref.revision=candidate.revision AND ref.locator=candidate.locator)))
         ORDER BY (candidate.evidence_kind='retained') DESC,candidate.created_at DESC LIMIT 1) e ON true
       AND e.source_ref=b.source_ref AND e.source_revision=b.source_revision AND e.locator=b.locator AND e.sha256=b.content_hash
       JOIN allowed ON allowed.id=e.scope_id WHERE e.status='available' AND e.expires_at>now()`,
      [
        ctx.tenantId,
        ctx.actorId,
        ctx.authzVersion,
        'knowledge:read',
        repoId,
        JSON.stringify(distinct),
        JSON.stringify(preferredRefs ?? []),
      ],
    );
    if (result.rows.length !== distinct.length) throw new AccessDeniedError();
    const resolved = result.rows.map((row) => ({
      source_ref: row.source_ref,
      source_revision: row.source_revision,
      locator: row.locator,
      content_hash: row.content_hash,
      material_kind: row.material_kind,
      scopeId: row.scope_id,
      evidenceRef: {
        id: row.evidence_id,
        revision: Number(row.evidence_revision),
        locator: row.locator,
      },
    }));
    await evidenceMetadata(
      client,
      ctx,
      resolved.map((row) => row.evidenceRef),
    );
    return resolved;
  }
}

export function evidenceFingerprint(
  body: SchemaTypes['CandidateBody'],
  assessment: SchemaTypes['Assessment'] | null,
  metadata: readonly EvidenceMetadata[],
): string {
  return sha256(
    canonicalJson({
      body,
      assessment,
      refs: [...metadata]
        .map((e) => ({
          id: e.id,
          revision: Number(e.revision),
          sha256: e.sha256,
          locator: e.locator,
          scope_id: e.scope_id,
          evidence_kind: e.evidence_kind,
        }))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b), 'en')),
    }),
  );
}

export async function checkEvidenceFiles(
  store: EvidenceStore,
  ctx: PrincipalContext,
  metadata: readonly EvidenceMetadata[],
): Promise<void> {
  // Bounded immutable reads, no network requests, execution or model inference.
  for (const item of metadata) await store.read(ctx.tenantId, item.object_key, item.sha256);
}

export const allCandidateRefs = (
  body: SchemaTypes['CandidateBody'],
  assessment: SchemaTypes['Assessment'] | null,
) => [...candidateEvidence(body), ...(assessment ? assessmentEvidence(assessment) : [])];
