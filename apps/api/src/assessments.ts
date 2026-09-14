import { randomUUID } from 'node:crypto';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { AssessmentService, PrincipalContext } from '@accremind/domain';
import { allowedScopesInTransaction, allowedScopesSql } from './authorization.js';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { ContributionError, conflict, invalidInput } from './contribution-errors.js';
import { assertSelectedInputSafe, canonicalJson } from './contribution-input.js';
import { sha256 } from './evidence-store.js';
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
import type { ResolvedMaterial } from './assessment-evidence.js';
import { assessmentBlockers, routeHumanAssessment } from './assessment-rules.js';
import {
  assessmentRecord,
  findCandidate,
  hiddenCandidate,
  historicalCandidate,
  hydrateCandidate,
} from './candidate-state.js';
import type { AssessmentRow, CandidateRow } from './candidate-state.js';
import { lockCandidate as governanceLock } from './governance-state.js';
import { AssessmentCursor } from './assessment-cursor.js';

const scopeFilterSql = `($5::uuid IS NULL OR s.id=$5 OR EXISTS(
 SELECT 1 FROM akb.scopes f LEFT JOIN akb.repos r ON r.tenant_id=s.tenant_id AND r.id=s.repo_id
 WHERE f.tenant_id=$1 AND f.id=$5 AND (f.kind='team' OR (f.kind='domain' AND (s.domain_id=f.domain_id OR r.domain_id=f.domain_id)))))`;

function snapshot<T>(name: 'AssessmentWrite' | 'CandidatePatch', value: unknown): T {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 256 * 1024)
    throw new ContributionError('PAYLOAD_TOO_LARGE', 413, 'Mutation exceeds 256KB');
  try {
    assertSchema(name, value);
  } catch {
    invalidInput('Mutation does not match the shared contract');
  }
  const input = JSON.parse(serialized) as T;
  assertSelectedInputSafe(input);
  return input;
}

export class PostgresAssessmentService implements AssessmentService {
  private readonly cursor = new AssessmentCursor();
  private readonly materials = new PostgresBaselineMaterialResolver();
  constructor(
    private readonly pool: TransactionPool,
    private readonly store: EvidenceStore,
  ) {}

  private async lockCandidate(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    capability: string,
  ): Promise<CandidateRow> {
    return governanceLock(client, ctx, id, capability);
  }

  private async operation(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    route: string,
    hash: string,
  ): Promise<string | undefined> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${ctx.tenantId}:operation:${id}`,
    ]);
    const result = await client.query<{
      actor_id: string;
      route: string;
      payload_hash: string;
      result_ref: string;
    }>(
      'SELECT actor_id,route,payload_hash,result_ref FROM akb.operations WHERE tenant_id=$1 AND id=$2',
      [ctx.tenantId, id],
    );
    const row = result.rows[0];
    if (!row) return;
    if (row.actor_id !== ctx.actorId || row.route !== route || row.payload_hash !== hash)
      conflict();
    return row.result_ref;
  }

  private async finishOperation(
    client: TransactionClient,
    ctx: PrincipalContext,
    key: string,
    route: string,
    hash: string,
    ref: string,
  ) {
    await client.query(
      `INSERT INTO akb.operations(tenant_id,id,actor_id,route,payload_hash,status,result_ref,expires_at)
      VALUES($1,$2,$3,$4,$5,'completed',$6,now()+interval '8 days')`,
      [ctx.tenantId, key, ctx.actorId, route, hash, ref],
    );
  }

  private async snapshotCandidate(
    client: TransactionClient,
    ctx: PrincipalContext,
    row: CandidateRow,
    body: SchemaTypes['CandidateBody'],
    status: SchemaTypes['Publication'],
  ): Promise<CandidateRow> {
    const updated = await client.query<{ revision: string }>(
      `UPDATE akb.candidates SET revision=revision+1,body=$3::jsonb,owner_id=$4,knowledge_role=$5,publication_status=$6
      WHERE tenant_id=$1 AND id=$2 RETURNING revision`,
      [ctx.tenantId, row.id, JSON.stringify(body), body.owner_id, body.knowledge_role, status],
    );
    const revision = updated.rows[0]!.revision;
    await client.query(
      `INSERT INTO akb.candidate_revisions(tenant_id,candidate_id,revision,body,actor_id,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [
        ctx.tenantId,
        row.id,
        revision,
        JSON.stringify(body),
        ctx.actorId,
        row.creation_kind,
        row.target_knowledge_id,
        row.base_content_revision,
        row.base_aggregate_revision,
      ],
    );
    return { ...row, body, owner_id: body.owner_id, revision, publication_status: status };
  }

  private checkRevision(row: CandidateRow, expected: number) {
    if (!Number.isSafeInteger(expected) || Number(row.revision) !== expected)
      throw new ContributionError(
        'REVISION_CONFLICT',
        409,
        'Candidate changed; reload before saving',
      );
    if (
      row.publication_status === 'published' ||
      row.publication_status === 'withdrawn' ||
      row.publication_status === 'rejected'
    )
      throw new ContributionError('PUBLICATION_BLOCKED', 422, 'Candidate is not editable');
  }

  private validateBaseline(
    assessment: SchemaTypes['Assessment'],
    materials: readonly ResolvedMaterial[],
  ) {
    if (
      materials.some(
        (material) =>
          (material.material_kind === 'code' || material.material_kind === 'test') &&
          material.source_revision !== assessment.checked_context.commit,
      )
    )
      invalidInput('Code and test materials must match the checked commit');
    const byRef = new Map(
      materials.map((material) => [canonicalJson(material.evidenceRef), material]),
    );
    for (const ref of assessment.baseline_answer.evidence_refs)
      if (!byRef.has(canonicalJson(ref)))
        invalidInput('Baseline answers must cite actually checked registered materials');
    const kinds = assessment.baseline_answer.evidence_refs.map(
      (ref) => byRef.get(canonicalJson(ref))!.material_kind,
    );
    if (
      assessment.disposition === 'index_only' &&
      !kinds.some((kind) => kind === 'code' || kind === 'test')
    )
      invalidInput('Code recovery needs code or test citations');
    if (assessment.disposition === 'link_existing' && !kinds.includes('authoritative_doc'))
      invalidInput('Authority links need a registered authoritative document citation');
    for (const delta of assessment.knowledge_delta) {
      if (
        delta.support === 'confirmed_decision' &&
        delta.evidence_refs.every((ref) => {
          const kind = byRef.get(canonicalJson(ref))?.material_kind;
          return kind === 'code' || kind === 'test';
        })
      )
        invalidInput('Code behavior alone cannot confirm a historical decision');
    }
  }

  private async aggregate(
    client: TransactionClient,
    ctx: PrincipalContext,
    contributionId: string,
    key: string,
  ) {
    const result = await client.query<{
      total: string;
      assessed: string;
      needs_confirmation: string;
      pending_review: string;
    }>(
      `SELECT count(*) AS total,count(a.id) AS assessed,
       count(*) FILTER(WHERE a.disposition='needs_confirmation') AS needs_confirmation,
       count(*) FILTER(WHERE a.disposition='knowledge_candidate' OR (a.disposition='link_existing' AND c.knowledge_role='authoritative_mirror')) AS pending_review
       FROM akb.candidates c LEFT JOIN LATERAL (SELECT id,disposition FROM akb.assessments
       WHERE tenant_id=c.tenant_id AND candidate_id=c.id AND candidate_revision=c.revision ORDER BY revision DESC LIMIT 1) a ON true
       WHERE c.tenant_id=$1 AND c.contribution_id=$2`,
      [ctx.tenantId, contributionId],
    );
    const counts = result.rows[0]!;
    const allChecked = Number(counts.total) > 0 && counts.total === counts.assessed;
    const status: SchemaTypes['Contribution']['processing_status'] = !allChecked
      ? 'accepted'
      : Number(counts.needs_confirmation) > 0
        ? 'waiting_confirmation'
        : Number(counts.pending_review) > 0
          ? 'waiting_review'
          : 'completed';
    const updated = await client.query<{ revision: string }>(
      'UPDATE akb.contributions SET revision=revision+1,processing_status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING revision',
      [ctx.tenantId, contributionId, status],
    );
    await client.query(
      `UPDATE akb.jobs SET status=$3,checkpoint=$4::jsonb WHERE tenant_id=$1 AND kind='human_assessment' AND dedupe_key=$2`,
      [
        ctx.tenantId,
        contributionId,
        allChecked ? 'succeeded' : 'queued',
        JSON.stringify({ stage: 'human_assessment', processing_status: status }),
      ],
    );
    await client.query(
      `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload)
      VALUES($1,$2,$3,'contribution.assessed',$4,$5,$6::jsonb)`,
      [
        ctx.tenantId,
        randomUUID(),
        `assessment:${key}`,
        contributionId,
        updated.rows[0]!.revision,
        JSON.stringify({ contribution_id: contributionId, processing_status: status }),
      ],
    );
  }

  private async audit(
    client: TransactionClient,
    ctx: PrincipalContext,
    row: CandidateRow,
    key: string,
    action: string,
  ) {
    await client.query(
      `INSERT INTO akb.audit(tenant_id,id,actor_id,action,object_id,object_revision,reason,request_id)
      VALUES($1,$2,$3,$4,$5,$6,'Explicit human mutation',$7)`,
      [ctx.tenantId, randomUUID(), ctx.actorId, action, row.id, row.revision, key],
    );
  }

  async saveHumanCheck(
    ctx: PrincipalContext,
    candidateId: string,
    value: SchemaTypes['AssessmentWrite'],
  ): Promise<SchemaTypes['AssessmentRecord']> {
    const input = snapshot<SchemaTypes['AssessmentWrite']>('AssessmentWrite', value);
    const identity = { ...ctx };
    const route = `writeAssessment:${candidateId}`;
    const hash = sha256(
      canonicalJson({ expected_revision: input.expected_revision, assessment: input.assessment }),
    );
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await this.lockCandidate(client, identity, candidateId, 'knowledge:assess');
      const previous = await this.operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const [assessmentId, revision] = previous.split(':');
        const saved = await client.query<
          AssessmentRow & { candidate_revision: string; body: SchemaTypes['CandidateBody'] }
        >(
          `SELECT a.*,r.body FROM akb.assessments a JOIN akb.candidate_revisions r ON r.tenant_id=a.tenant_id AND r.candidate_id=a.candidate_id AND r.revision=a.candidate_revision
           WHERE a.tenant_id=$1 AND a.candidate_id=$2 AND a.id=$3 AND a.revision=$4`,
          [identity.tenantId, candidateId, assessmentId, revision],
        );
        const record = saved.rows[0];
        if (!record) throw new AccessDeniedError();
        const restored = await hydrateCandidate(
          client,
          identity,
          await historicalCandidate(client, identity, row, Number(record.candidate_revision)),
          this.store,
          'knowledge:assess',
        );
        if (!restored.assessment) throw new AccessDeniedError();
        return restored.assessment;
      }
      this.checkRevision(row, input.expected_revision);
      if (
        input.assessment.checked_context.repo_id !== row.repo_id ||
        input.assessment.checked_context.commit !== row.environment.commit
      )
        invalidInput('Check repository and commit must match the contribution snapshot');
      const disposition = routeHumanAssessment(row.body, input.assessment);
      if (disposition !== input.assessment.disposition)
        invalidInput('Requested disposition does not match supported routing rules');
      const materials = await this.materials.resolve(
        client,
        identity,
        row.repo_id,
        input.assessment.checked_context.materials,
        assessmentEvidence(input.assessment),
      );
      this.validateBaseline(input.assessment, materials);
      if (
        row.body.knowledge_role === 'authoritative_mirror' &&
        disposition === 'link_existing' &&
        !materials.some(
          (material) =>
            material.material_kind === 'authoritative_doc' &&
            canonicalJson(material.evidenceRef) === canonicalJson(row.body.mirror!.authority_ref),
        )
      )
        invalidInput('Mirror authority must match a checked registered authoritative document');
      const refs = uniqueRefs([
        ...allCandidateRefs(row.body, input.assessment),
        ...materials.map((material) => material.evidenceRef),
      ]);
      if (refs.length > 100) invalidInput('Assessment evidence set exceeds 100 references');
      const metadata = await evidenceMetadata(client, identity, refs);
      for (const delta of input.assessment.knowledge_delta.filter(
        (claim) => claim.support === 'confirmed_decision',
      )) {
        const classified = await client.query<{
          evidence_id: string;
          evidence_revision: string;
          material_kind: string;
        }>(
          `SELECT ref.id AS evidence_id,ref.revision AS evidence_revision,b.material_kind FROM jsonb_to_recordset($3::jsonb) AS ref(id uuid,revision bigint)
           LEFT JOIN akb.retained_evidence_sources lineage ON lineage.tenant_id=$1 AND lineage.evidence_id=ref.id AND lineage.evidence_revision=ref.revision
           JOIN akb.baseline_materials b ON ((ref.id=b.evidence_id AND ref.revision=b.evidence_revision) OR (lineage.source_id=b.evidence_id AND lineage.source_revision=b.evidence_revision))
           WHERE b.tenant_id=$1 AND b.repo_id=$2`,
          [identity.tenantId, row.repo_id, JSON.stringify(uniqueRefs(delta.evidence_refs))],
        );
        if (
          delta.evidence_refs.every((ref) => {
            const kinds = classified.rows
              .filter(
                (item) =>
                  item.evidence_id === ref.id && Number(item.evidence_revision) === ref.revision,
              )
              .map((item) => item.material_kind);
            return kinds.length > 0 && kinds.every((kind) => kind === 'code' || kind === 'test');
          })
        )
          invalidInput('Registered code behavior alone cannot confirm a historical decision');
      }
      await checkEvidenceFiles(this.store, identity, metadata);
      // Final scope/source check after storage I/O, before activating the append-only record.
      await findCandidate(client, identity, candidateId, 'knowledge:assess');
      await evidenceMetadata(client, identity, refs);
      await this.materials.resolve(
        client,
        identity,
        row.repo_id,
        input.assessment.checked_context.materials,
        assessmentEvidence(input.assessment),
      );
      const latest = await client.query<{ id: string; revision: string }>(
        'SELECT id,revision FROM akb.assessments WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY revision DESC LIMIT 1',
        [identity.tenantId, candidateId],
      );
      const assessmentId = latest.rows[0]?.id ?? randomUUID();
      const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
      const status: SchemaTypes['Publication'] =
        disposition === 'knowledge_candidate' ||
        (disposition === 'link_existing' && row.body.knowledge_role === 'authoritative_mirror')
          ? 'in_review'
          : disposition === 'needs_confirmation'
            ? 'candidate'
            : 'archived';
      const updated = await this.snapshotCandidate(client, identity, row, row.body, status);
      const inserted = await client.query<AssessmentRow>(
        `INSERT INTO akb.assessments(tenant_id,id,revision,candidate_id,candidate_revision,checked_by,assessment_method,discoverability,disposition,priority,document,evidence_set_hash)
        VALUES($1,$2,$3,$4,$5,$6,'human_review',$7,$8,$9,$10::jsonb,$11) RETURNING *`,
        [
          identity.tenantId,
          assessmentId,
          revision,
          candidateId,
          updated.revision,
          identity.actorId,
          input.assessment.discoverability,
          disposition,
          input.assessment.priority,
          JSON.stringify(input.assessment),
          evidenceFingerprint(row.body, input.assessment, metadata),
        ],
      );
      for (const delta of input.assessment.knowledge_delta) {
        await client.query(
          `INSERT INTO akb.assessment_claims(tenant_id,assessment_id,assessment_revision,claim_id,text,support)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [identity.tenantId, assessmentId, revision, delta.claim_id, delta.text, delta.support],
        );
        for (const ref of uniqueRefs(delta.evidence_refs))
          await client.query(
            `INSERT INTO akb.claim_evidence(tenant_id,assessment_id,assessment_revision,claim_id,evidence_id,evidence_revision,locator)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              identity.tenantId,
              assessmentId,
              revision,
              delta.claim_id,
              ref.id,
              ref.revision,
              ref.locator,
            ],
          );
      }
      if (disposition === 'index_only' || disposition === 'link_existing') {
        const supporting = new Set(
          input.assessment.baseline_answer.evidence_refs.map(canonicalJson),
        );
        for (const material of materials.filter(
          (m) =>
            supporting.has(canonicalJson(m.evidenceRef)) &&
            (disposition === 'link_existing'
              ? m.material_kind === 'authoritative_doc'
              : m.material_kind === 'code' || m.material_kind === 'test'),
        ))
          await client.query(
            `INSERT INTO akb.navigation_items(tenant_id,id,scope_id,assessment_id,assessment_revision,kind,source_ref,source_revision,title,locator)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              identity.tenantId,
              randomUUID(),
              row.scope_id,
              assessmentId,
              revision,
              disposition,
              material.source_ref,
              material.source_revision,
              row.body.title,
              material.locator,
            ],
          );
      }
      await this.aggregate(client, identity, row.contribution_id, input.operation_id);
      await this.audit(client, identity, updated, input.operation_id, 'assessment.saved');
      await this.finishOperation(
        client,
        identity,
        input.operation_id,
        route,
        hash,
        `${assessmentId}:${revision}`,
      );
      const result = assessmentRecord(inserted.rows[0]!);
      assertSchema('AssessmentRecord', result);
      return result;
    });
  }

  async updateCandidate(
    ctx: PrincipalContext,
    candidateId: string,
    value: SchemaTypes['CandidatePatch'],
  ): Promise<SchemaTypes['Candidate']> {
    const input = snapshot<SchemaTypes['CandidatePatch']>('CandidatePatch', value);
    const identity = { ...ctx };
    const route = `updateCandidate:${candidateId}`;
    const hash = sha256(
      canonicalJson({ expected_revision: input.expected_revision, body: input.body }),
    );
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await this.lockCandidate(client, identity, candidateId, 'knowledge:contribute');
      if (row.contributor_id !== identity.actorId) throw new AccessDeniedError();
      const previous = await this.operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const historical = {
          ...(await historicalCandidate(client, identity, row, Number(previous))),
          publication_status: 'candidate' as const,
        };
        return (
          await hydrateCandidate(client, identity, historical, this.store, 'knowledge:contribute')
        ).candidate;
      }
      this.checkRevision(row, input.expected_revision);
      if (canonicalJson(input.body.scope) !== canonicalJson(row.body.scope))
        invalidInput('Scope changes require a separate disclosure workflow');
      const owner = await client.query(
        'SELECT id FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
        [identity.tenantId, input.body.owner_id],
      );
      if (owner.rowCount !== 1) throw new AccessDeniedError();
      const updated = await this.snapshotCandidate(client, identity, row, input.body, 'candidate');
      const hydrated = await hydrateCandidate(
        client,
        identity,
        updated,
        this.store,
        'knowledge:contribute',
      );
      await this.aggregate(client, identity, row.contribution_id, input.operation_id);
      await this.audit(client, identity, updated, input.operation_id, 'candidate.updated');
      await this.finishOperation(
        client,
        identity,
        input.operation_id,
        route,
        hash,
        updated.revision,
      );
      assertSchema('Candidate', hydrated.candidate);
      return hydrated.candidate;
    });
  }

  async getReview(ctx: PrincipalContext, candidateId: string): Promise<SchemaTypes['ReviewView']> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await findCandidate(client, identity, candidateId, 'knowledge:review');
      try {
        const state = await hydrateCandidate(client, identity, row, this.store, 'knowledge:review');
        const data: SchemaTypes['ReviewView'] = {
          candidate: state.candidate,
          assessment: state.assessment,
          blocking_reasons: assessmentBlockers(row.body, state.assessment?.assessment ?? null),
          allowed_actions: [],
          evidence_refs: state.refs,
          related_entries: [],
          current_approval: null,
          latest_review: null,
          current_publication: null,
        };
        assertSchema('ReviewView', data);
        return data;
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;
        await findCandidate(client, identity, candidateId, 'knowledge:review');
        const data: SchemaTypes['ReviewView'] = {
          candidate: hiddenCandidate(row),
          assessment: null,
          blocking_reasons: [
            {
              code: 'EVIDENCE_UNAVAILABLE',
              field: 'evidence_refs',
              message: '所需证据或材料不可访问',
            },
          ],
          allowed_actions: [],
          evidence_refs: [],
          related_entries: [],
          current_approval: null,
          latest_review: null,
          current_publication: null,
        };
        assertSchema('ReviewView', data);
        return data;
      }
    });
  }

  async listReviews(
    ctx: PrincipalContext,
    options: { scope_id?: string; limit?: number; cursor?: string } = {},
  ): Promise<SchemaTypes['CandidatePage']> {
    const identity = { ...ctx };
    const { scope_id: scope, limit = 20, cursor } = { ...options };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalidInput('Invalid page limit');
    const filter = { kind: 'reviews', scope: scope ?? '' };
    const position = cursor ? this.cursor.decode(identity, filter, cursor) : undefined;
    const rows = await withPrincipalTransaction(this.pool, identity, async (client) => {
      if (
        scope &&
        !(await allowedScopesInTransaction(client, identity, 'knowledge:review')).has(scope)
      )
        return [];
      const result = await client.query<{ id: string; rank: number; date: string }>(
        `WITH allowed AS (${allowedScopesSql}), queue AS (SELECT c.id,c.created_at,
         CASE a.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END AS rank
         FROM akb.candidates c JOIN akb.scopes s ON s.tenant_id=c.tenant_id AND s.id=c.scope_id JOIN allowed ON allowed.id=s.id
         LEFT JOIN LATERAL (SELECT priority FROM akb.assessments WHERE tenant_id=c.tenant_id AND candidate_id=c.id AND candidate_revision=c.revision ORDER BY revision DESC LIMIT 1) a ON true
         WHERE c.tenant_id=$1 AND c.publication_status IN ('candidate','in_review') AND ${scopeFilterSql})
         SELECT id,rank,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date FROM queue
         WHERE ($6::integer IS NULL OR (rank,created_at,id)>($6::integer,$7::timestamptz,$8::uuid)) ORDER BY rank,created_at,id LIMIT $9`,
        [
          identity.tenantId,
          identity.actorId,
          identity.authzVersion,
          'knowledge:review',
          scope ?? null,
          position?.rank ?? null,
          position?.date ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });
    const items: SchemaTypes['Candidate'][] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        items.push((await this.getReview(identity, row.id)).candidate);
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;
      }
    }
    const last = rows.slice(0, limit).at(-1);
    const data = {
      items,
      next_cursor: rows.length > limit && last ? this.cursor.encode(identity, filter, last) : '',
    };
    assertSchema('CandidatePage', data);
    return data;
  }

  async listNavigation(
    ctx: PrincipalContext,
    options: { scope_id: string; query?: string; limit?: number; cursor?: string },
  ): Promise<SchemaTypes['NavigationPage']> {
    const identity = { ...ctx };
    const { scope_id: scope, query = '', limit = 20, cursor } = { ...options };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalidInput('Invalid page limit');
    const filter = { kind: 'navigation', scope, query };
    const position = cursor ? this.cursor.decode(identity, filter, cursor) : undefined;
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      if (!(await allowedScopesInTransaction(client, identity, 'knowledge:read')).has(scope))
        return { items: [], next_cursor: '' };
      const result = await client.query<{
        id: string;
        rank: number;
        date: string;
        document: SchemaTypes['Assessment'];
        repo_id: string;
        body: SchemaTypes['CandidateBody'];
        scope_kind: 'team' | 'domain' | 'repo';
        scope_id: string;
        assessment_id: string;
        assessment_revision: string;
        kind: 'index_only' | 'link_existing';
        title: string;
        source_ref: string;
        source_revision: string;
        locator: string;
        evidence_set_hash: string;
      }>(
        `WITH allowed AS (${allowedScopesSql}) SELECT n.*,s.kind AS scope_kind,0 AS rank,
         to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date,a.document,a.evidence_set_hash,c.body,contribution.repo_id
         FROM akb.navigation_items n JOIN akb.assessments a ON a.tenant_id=n.tenant_id AND a.id=n.assessment_id AND a.revision=n.assessment_revision
         JOIN akb.candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.revision=a.candidate_revision
         JOIN akb.contributions contribution ON contribution.tenant_id=c.tenant_id AND contribution.id=c.contribution_id
         JOIN akb.scopes s ON s.tenant_id=n.tenant_id AND s.id=n.scope_id JOIN allowed ON allowed.id=s.id
         WHERE n.tenant_id=$1 AND a.disposition=n.kind AND ${scopeFilterSql}
         AND ($6='' OR strpos(lower(n.title),lower($6))>0 OR strpos(lower(n.source_ref),lower($6))>0)
         AND ($7::timestamptz IS NULL OR (n.created_at,n.id)<($7::timestamptz,$8::uuid)) ORDER BY n.created_at DESC,n.id DESC LIMIT $9`,
        [
          identity.tenantId,
          identity.actorId,
          identity.authzVersion,
          'knowledge:read',
          scope,
          query,
          position?.date ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const items: SchemaTypes['NavigationItem'][] = [];
      for (const row of result.rows.slice(0, limit)) {
        try {
          const materials = await this.materials.resolve(
            client,
            identity,
            row.repo_id,
            row.document.checked_context.materials,
            assessmentEvidence(row.document),
          );
          const refs = uniqueRefs([
            ...allCandidateRefs(row.body, row.document),
            ...materials.map((m) => m.evidenceRef),
          ]);
          const metadata = await evidenceMetadata(client, identity, refs);
          await checkEvidenceFiles(this.store, identity, metadata);
          await evidenceMetadata(client, identity, refs);
          if (evidenceFingerprint(row.body, row.document, metadata) !== row.evidence_set_hash)
            continue;
          await this.materials.resolve(
            client,
            identity,
            row.repo_id,
            row.document.checked_context.materials,
            assessmentEvidence(row.document),
          );
          const current = await client.query(
            `WITH allowed AS (${allowedScopesSql}) SELECT n.id FROM akb.navigation_items n
            JOIN allowed ON allowed.id=n.scope_id JOIN akb.assessments a ON a.tenant_id=n.tenant_id AND a.id=n.assessment_id AND a.revision=n.assessment_revision
            JOIN akb.candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id AND c.revision=a.candidate_revision
            WHERE n.tenant_id=$1 AND n.id=$5 AND a.evidence_set_hash=$6 AND a.disposition=n.kind`,
            [
              identity.tenantId,
              identity.actorId,
              identity.authzVersion,
              'knowledge:read',
              row.id,
              row.evidence_set_hash,
            ],
          );
          if (current.rowCount !== 1) continue;
          items.push({
            id: row.id,
            scope: { id: row.scope_id, kind: row.scope_kind },
            kind: row.kind,
            title: row.title,
            source_ref: row.source_ref,
            source_revision: row.source_revision,
            locator: row.locator,
            assessment_id: row.assessment_id,
            assessment_revision: Number(row.assessment_revision),
          });
        } catch (error) {
          if (!(error instanceof AccessDeniedError)) throw error;
        }
      }
      const last = result.rows.slice(0, limit).at(-1);
      const data = {
        items,
        next_cursor:
          result.rows.length > limit && last ? this.cursor.encode(identity, filter, last) : '',
      };
      assertSchema('NavigationPage', data);
      return data;
    });
  }
}
