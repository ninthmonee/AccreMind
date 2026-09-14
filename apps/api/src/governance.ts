import { randomUUID } from 'node:crypto';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { PublicationService, PrincipalContext } from '@accremind/domain';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { sha256 } from './evidence-store.js';
import type { EvidenceStore } from './evidence-store.js';
import { canonicalJson } from './contribution-input.js';
import { hydrateCandidate, historicalCandidate, findCandidate } from './candidate-state.js';
import type { CandidateRow } from './candidate-state.js';
import { evidenceMetadata } from './assessment-evidence.js';
import { routeHumanAssessment } from './assessment-rules.js';
import {
  aggregate,
  assertCapability,
  audit,
  blocked,
  finish,
  governanceInput,
  knowledge,
  lockCandidate,
  operation,
  sameScope,
  stale,
} from './governance-state.js';
import { enqueueIndex } from './search-index.js';
import { invalidInput } from './contribution-errors.js';

export type ReviewRow = {
  id: string;
  candidate_id: string;
  candidate_revision: string;
  assessment_id: string;
  assessment_revision: string;
  evidence_set_hash: string;
  scope_id: string;
  reviewer_id: string;
  action: SchemaTypes['ReviewRequest']['action'];
  disposition: SchemaTypes['Disposition'];
  mirror_approval: boolean;
  reason: string;
  created_at: Date;
};
export type PublicationRow = {
  id: string;
  candidate_id: string;
  candidate_revision: string;
  actor_id: string;
  authz_version: string;
  review_id: string;
  status: SchemaTypes['PublishResult']['status'];
  result: SchemaTypes['PublishResult'];
  target_knowledge_id: string | null;
  base_content_revision: string | null;
  expected_target_revision: string | null;
  knowledge_id: string | null;
  operation_id: string;
};

export const reviewRecord = (
  row: ReviewRow,
  scope: SchemaTypes['Scope'],
  reasons: string[] = [],
): SchemaTypes['ReviewRecord'] => ({
  review_id: row.id,
  candidate_id: row.candidate_id,
  candidate_revision: Number(row.candidate_revision),
  assessment_id: row.assessment_id,
  assessment_revision: Number(row.assessment_revision),
  evidence_set_hash: row.evidence_set_hash,
  scope,
  reviewer_id: row.reviewer_id,
  action: row.action,
  disposition: row.disposition,
  reason: row.reason,
  mirror_approval: row.mirror_approval,
  created_at: row.created_at.toISOString(),
  validity: reasons.length ? 'stale' : 'valid',
  stale_reasons: reasons,
});

/** Gate is invoked both on request and after Git, using current scoped authorization. */
export async function publicationGate(
  client: TransactionClient,
  ctx: PrincipalContext,
  row: CandidateRow,
  store: EvidenceStore,
  reviewId?: string,
) {
  const state = await hydrateCandidate(client, ctx, row, store, 'knowledge:publish');
  const assessment = state.assessment;
  if (!assessment) blocked('A current assessment is required');
  const owner = await client.query(
    'SELECT id FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
    [ctx.tenantId, row.owner_id],
  );
  if (owner.rowCount !== 1) blocked('Knowledge owner is unavailable');
  const a = assessment.assessment;
  if (
    !a.checked_context.completed ||
    a.discoverability === 'inconclusive' ||
    a.confirmation_questions.length ||
    a.knowledge_delta.some((d) => d.support === 'inference' || d.support === 'unconfirmed')
  )
    blocked('Baseline or claims are not confirmed');
  const route = routeHumanAssessment(row.body, a);
  const mirror = row.body.knowledge_role === 'authoritative_mirror';
  if (
    route !== a.disposition ||
    (!mirror && route !== 'knowledge_candidate') ||
    (mirror && route !== 'link_existing')
  )
    blocked('Assessment cannot publish this knowledge role');
  if (!state.metadata.length || state.metadata.some((e) => e.evidence_kind !== 'retained'))
    blocked('EVIDENCE_NOT_RETAINED: freeze and rebind all assessment and body sources');
  if (row.publication_status !== 'in_review') blocked('Candidate is not awaiting publication');
  if (row.target_knowledge_id) {
    const target = await knowledge(client, ctx, row.target_knowledge_id, 'knowledge:publish');
    if (
      target.revision !== row.base_aggregate_revision ||
      target.active_content_revision !== row.base_content_revision ||
      target.publication_status !== 'published'
    )
      stale('Target knowledge changed; explicit rebase and reassessment required');
    if (target.scope_id !== row.scope_id) blocked('Target disclosure scope differs');
  }
  let review: ReviewRow | undefined;
  if (reviewId) {
    const latest = await client.query<ReviewRow>(
      'SELECT * FROM akb.reviews WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [ctx.tenantId, row.id],
    );
    review = latest.rows[0];
    if (
      !review ||
      review.id !== reviewId ||
      review.action !== 'approve' ||
      review.candidate_revision !== row.revision ||
      review.assessment_id !== assessment.id ||
      Number(review.assessment_revision) !== assessment.revision ||
      review.evidence_set_hash !== state.candidate.evidence_set_hash ||
      review.scope_id !== row.scope_id ||
      review.disposition !== a.disposition ||
      review.mirror_approval !== mirror ||
      review.reviewer_id === row.contributor_id
    )
      blocked('Named approval is absent, superseded or stale');
    const reviewer = await client.query<{ authz_version: string }>(
      'SELECT authz_version FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
      [ctx.tenantId, review.reviewer_id],
    );
    if (!reviewer.rows[0]) blocked('Reviewer is no longer authorized');
    const reviewerCtx = {
      ...ctx,
      actorId: review.reviewer_id,
      authzVersion: Number(reviewer.rows[0].authz_version),
    };
    await assertCapability(client, reviewerCtx, row.scope_id, 'knowledge:review');
    await hydrateCandidate(client, reviewerCtx, row, store, 'knowledge:review');
  }
  return { ...state, review };
}

export class PostgresGovernanceService implements PublicationService {
  constructor(
    private readonly pool: TransactionPool,
    private readonly store: EvidenceStore,
  ) {}
  async retain(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['RetainRequest'],
  ): Promise<SchemaTypes['Evidence']> {
    const input = governanceInput<SchemaTypes['RetainRequest']>('RetainRequest', value);
    const identity = { ...ctx };
    const route = `retainEvidence:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const result = previous.response as SchemaTypes['Evidence'];
        const [saved] = await evidenceMetadata(client, identity, [
          { id: result.id, revision: result.revision, locator: result.locator },
        ]);
        if (!saved) throw new AccessDeniedError();
        await assertCapability(client, identity, saved.scope_id, 'knowledge:review');
        await this.store.read(identity.tenantId, saved.object_key, saved.sha256);
        return result;
      }
      const [source] = await evidenceMetadata(client, identity, [
        { id, revision: input.source_evidence_revision, locator: input.locator },
      ]);
      if (!source) throw new AccessDeniedError();
      await assertCapability(client, identity, source.scope_id, 'knowledge:review');
      if (source.evidence_kind !== 'raw')
        invalidInput('Only raw selected evidence may be retained');
      // Uploaded objects are already explicit selected fragments. Only their exact registered locator is supported.
      const content = await this.store.read(identity.tenantId, source.object_key, source.sha256);
      const retainedId = randomUUID();
      const key = await this.store.write(identity.tenantId, retainedId, content);
      await evidenceMetadata(client, identity, [
        { id, revision: input.source_evidence_revision, locator: input.locator },
      ]);
      await assertCapability(client, identity, source.scope_id, 'knowledge:review');
      const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      await client.query(
        `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,contribution_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'retained','available',$10)`,
        [
          identity.tenantId,
          retainedId,
          source.scope_id,
          source.contribution_id,
          source.source_ref,
          source.source_revision,
          input.locator,
          key,
          source.sha256,
          expires,
        ],
      );
      await client.query(
        'INSERT INTO akb.retained_evidence_sources(tenant_id,evidence_id,evidence_revision,source_id,source_revision,locator) VALUES($1,$2,1,$3,$4,$5)',
        [identity.tenantId, retainedId, id, input.source_evidence_revision, input.locator],
      );
      const result: SchemaTypes['Evidence'] = {
        id: retainedId,
        revision: 1,
        source_ref: source.source_ref,
        source_revision: source.source_revision,
        locator: input.locator,
        content,
        sha256: source.sha256,
        expires_at: expires,
        evidence_kind: 'retained',
        status: 'available',
      };
      assertSchema('Evidence', result);
      await finish(client, identity, input.operation_id, route, hash, result);
      await audit(client, identity, retainedId, 1, 'evidence.retained', input.operation_id);
      return result;
    });
  }
  async review(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['ReviewRequest'],
  ): Promise<SchemaTypes['ReviewRecord']> {
    const input = governanceInput<SchemaTypes['ReviewRequest']>('ReviewRequest', value);
    const identity = { ...ctx };
    const route = `reviewCandidate:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await lockCandidate(client, identity, id, 'knowledge:review');
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const record = previous.response as SchemaTypes['ReviewRecord'];
        await hydrateCandidate(
          client,
          identity,
          await historicalCandidate(client, identity, row, record.candidate_revision),
          this.store,
          'knowledge:review',
        );
        return record;
      }
      if (Number(row.revision) !== input.expected_revision) stale('Candidate changed');
      if (['published', 'withdrawn', 'rejected'].includes(row.publication_status))
        blocked('Candidate is closed');
      const state = await hydrateCandidate(client, identity, row, this.store, 'knowledge:review');
      const assessment = state.assessment;
      if (
        !assessment ||
        assessment.revision !== input.assessment_revision ||
        state.candidate.evidence_set_hash !== input.evidence_set_hash ||
        !sameScope(row.body.scope, input.scope)
      )
        stale('Assessment, evidence or scope changed');
      if (input.action === 'approve') {
        if (row.contributor_id === identity.actorId) blocked('Self approval is forbidden');
        // Publication authorization belongs to the publisher; review has an equivalent content gate.
        const a = assessment.assessment;
        const mirror = row.body.knowledge_role === 'authoritative_mirror';
        if (
          row.publication_status !== 'in_review' ||
          routeHumanAssessment(row.body, a) !== a.disposition ||
          input.disposition !== a.disposition ||
          (!mirror && a.disposition !== 'knowledge_candidate') ||
          (mirror && (a.disposition !== 'link_existing' || input.mirror_approval !== true))
        )
          blocked('Route or mirror approval does not satisfy publication gate');
        if (
          !a.checked_context.completed ||
          a.confirmation_questions.length ||
          a.knowledge_delta.some((d) => d.support === 'inference' || d.support === 'unconfirmed')
        )
          blocked('Unsupported assessment');
        if (!state.metadata.length || state.metadata.some((e) => e.evidence_kind !== 'retained'))
          blocked('EVIDENCE_NOT_RETAINED');
        if (row.target_knowledge_id) {
          const target = await knowledge(
            client,
            identity,
            row.target_knowledge_id,
            'knowledge:review',
          );
          if (
            target.revision !== row.base_aggregate_revision ||
            target.active_content_revision !== row.base_content_revision
          )
            stale('Target knowledge changed');
        }
      } else if (input.disposition !== assessment.assessment.disposition) {
        blocked('Changing routing requires saving a new assessment');
      }
      const reviewId = randomUUID();
      const saved = await client.query<ReviewRow>(
        `INSERT INTO akb.reviews(tenant_id,id,candidate_id,candidate_revision,assessment_id,assessment_revision,reviewer_id,evidence_set_hash,scope_id,action,disposition,mirror_approval,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          identity.tenantId,
          reviewId,
          id,
          row.revision,
          assessment.id,
          assessment.revision,
          identity.actorId,
          input.evidence_set_hash,
          row.scope_id,
          input.action,
          input.disposition,
          input.mirror_approval ?? false,
          input.reason,
        ],
      );
      if (input.action !== 'approve')
        await client.query(
          'UPDATE akb.candidates SET publication_status=$3 WHERE tenant_id=$1 AND id=$2',
          [identity.tenantId, id, input.action === 'reject' ? 'rejected' : 'candidate'],
        );
      await assertCapability(client, identity, row.scope_id, 'knowledge:review');
      await evidenceMetadata(client, identity, state.refs);
      const result = reviewRecord(saved.rows[0]!, row.body.scope);
      assertSchema('ReviewRecord', result);
      await aggregate(client, identity, row.contribution_id, input.operation_id);
      await audit(
        client,
        identity,
        id,
        Number(row.revision),
        `review.${input.action}`,
        input.operation_id,
      );
      await finish(client, identity, input.operation_id, route, hash, result);
      return result;
    });
  }
  async request(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['PublishRequest'],
  ): Promise<SchemaTypes['PublishResult']> {
    const input = governanceInput<SchemaTypes['PublishRequest']>('PublishRequest', value);
    const identity = { ...ctx };
    const route = `publishCandidate:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await lockCandidate(client, identity, id, 'knowledge:publish');
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous)
        return this.publicationInTransaction(
          client,
          identity,
          (previous.response as SchemaTypes['PublishResult']).publication_id,
        );
      if (Number(row.revision) !== input.expected_revision) stale('Candidate changed');
      const state = await publicationGate(client, identity, row, this.store, input.review_id);
      if (
        state.assessment!.revision !== input.assessment_revision ||
        state.candidate.evidence_set_hash !== input.evidence_set_hash
      )
        stale('Assessment or evidence changed');
      if (
        row.creation_kind === 'revision'
          ? input.expected_target_revision !== Number(row.base_aggregate_revision)
          : input.expected_target_revision !== undefined
      )
        stale('Target version binding differs');
      const existing = await client.query(
        "SELECT id FROM akb.publications WHERE tenant_id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND status IN ('pending','published')",
        [identity.tenantId, id, row.revision],
      );
      if (existing.rowCount) blocked('A publication already exists for this candidate revision');
      const publicationId = randomUUID();
      const result: SchemaTypes['PublishResult'] = {
        publication_id: publicationId,
        status: 'pending',
      };
      await client.query(
        `INSERT INTO akb.publications(tenant_id,id,candidate_id,candidate_revision,operation_id,actor_id,review_id,target_knowledge_id,base_content_revision,expected_target_revision,status,result,authz_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11::jsonb,$12)`,
        [
          identity.tenantId,
          publicationId,
          id,
          row.revision,
          input.operation_id,
          identity.actorId,
          input.review_id,
          row.target_knowledge_id,
          row.base_content_revision,
          row.base_aggregate_revision,
          JSON.stringify(result),
          identity.authzVersion,
        ],
      );
      await client.query(
        `INSERT INTO akb.jobs(tenant_id,id,actor_id,scope_id,kind,dedupe_key,status,payload) VALUES($1,$2,$3,$4,'publication',$5,'queued',$6::jsonb)`,
        [
          identity.tenantId,
          randomUUID(),
          identity.actorId,
          row.scope_id,
          publicationId,
          JSON.stringify({ publication_id: publicationId }),
        ],
      );
      await assertCapability(client, identity, row.scope_id, 'knowledge:publish');
      await evidenceMetadata(client, identity, state.refs);
      await finish(client, identity, input.operation_id, route, hash, result);
      await audit(
        client,
        identity,
        id,
        Number(row.revision),
        'publication.requested',
        input.operation_id,
      );
      return result;
    });
  }
  private async publicationInTransaction(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
  ) {
    const saved = await client.query<PublicationRow>(
      'SELECT * FROM akb.publications WHERE tenant_id=$1 AND id=$2',
      [ctx.tenantId, id],
    );
    const row = saved.rows[0];
    if (!row) throw new AccessDeniedError();
    const candidate = await findCandidate(client, ctx, row.candidate_id, 'knowledge:publish');
    // Historical request polling reveals status only, never candidate body or source locators.
    await assertCapability(client, ctx, candidate.scope_id, 'knowledge:publish');
    const result = { ...row.result, publication_id: id, status: row.status };
    assertSchema('PublishResult', result);
    return result;
  }
  getPublication(ctx: PrincipalContext, id: string) {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, (client) =>
      this.publicationInTransaction(client, identity, id),
    );
  }
  async decorateReview(
    ctx: PrincipalContext,
    view: SchemaTypes['ReviewView'],
  ): Promise<SchemaTypes['ReviewView']> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await findCandidate(client, identity, view.candidate.id, 'knowledge:review');
      const state = await hydrateCandidate(client, identity, row, this.store, 'knowledge:review');
      const latest = await client.query<ReviewRow>(
        'SELECT * FROM akb.reviews WHERE tenant_id=$1 AND candidate_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [identity.tenantId, row.id],
      );
      let record: SchemaTypes['ReviewRecord'] | null = null;
      if (latest.rows[0]) {
        const r = latest.rows[0];
        const reasons: string[] = [];
        if (r.candidate_revision !== row.revision) reasons.push('CANDIDATE_CHANGED');
        if (
          r.assessment_id !== state.assessment?.id ||
          Number(r.assessment_revision) !== state.assessment?.revision
        )
          reasons.push('ASSESSMENT_CHANGED');
        if (r.evidence_set_hash !== state.candidate.evidence_set_hash)
          reasons.push('EVIDENCE_CHANGED');
        if (row.target_knowledge_id) {
          const target = await knowledge(
            client,
            identity,
            row.target_knowledge_id,
            'knowledge:review',
          );
          if (
            target.revision !== row.base_aggregate_revision ||
            target.active_content_revision !== row.base_content_revision
          )
            reasons.push('TARGET_CHANGED');
        }
        const p = await client.query<{ authz_version: string }>(
          'SELECT authz_version FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
          [identity.tenantId, r.reviewer_id],
        );
        if (!p.rows[0]) reasons.push('REVIEWER_UNAUTHORIZED');
        else {
          try {
            const reviewer = {
              ...identity,
              actorId: r.reviewer_id,
              authzVersion: Number(p.rows[0].authz_version),
            };
            await assertCapability(client, reviewer, row.scope_id, 'knowledge:review');
            await hydrateCandidate(client, reviewer, row, this.store, 'knowledge:review');
          } catch (error) {
            if (!(error instanceof AccessDeniedError)) throw error;
            reasons.push('REVIEWER_UNAUTHORIZED');
          }
        }
        record = reviewRecord(r, row.body.scope, reasons);
      }
      const approved = record?.action === 'approve' && record.validity === 'valid' ? record : null;
      const publications = await client.query<PublicationRow>(
        'SELECT * FROM akb.publications WHERE tenant_id=$1 AND candidate_id=$2 AND candidate_revision=$3 ORDER BY created_at DESC LIMIT 1',
        [identity.tenantId, row.id, row.revision],
      );
      const blockers = view.blocking_reasons.filter(
        (b) =>
          b.code !== 'CAPABILITY_NOT_READY' && !(approved && b.code === 'MIRROR_APPROVAL_REQUIRED'),
      );
      if (state.metadata.some((e) => e.evidence_kind !== 'retained'))
        blockers.push({
          code: 'EVIDENCE_NOT_RETAINED',
          field: 'evidence_refs',
          message: '先冻结证据并重新绑定判定',
        });
      if (!approved)
        blockers.push({
          code: 'APPROVAL_REQUIRED',
          field: 'review',
          message: '尚无当前版本的独立批准',
        });
      const actions: string[] = [];
      if (
        row.publication_status === 'in_review' &&
        identity.actorId !== row.contributor_id &&
        !blockers.some((b) => !['APPROVAL_REQUIRED', 'MIRROR_APPROVAL_REQUIRED'].includes(b.code))
      )
        actions.push('approve');
      if (row.publication_status === 'in_review' && approved) {
        try {
          await assertCapability(client, identity, row.scope_id, 'knowledge:publish');
          if (!blockers.length) actions.push('publish');
        } catch (error) {
          if (!(error instanceof AccessDeniedError)) throw error;
        }
      }
      const result: SchemaTypes['ReviewView'] = {
        ...view,
        candidate: state.candidate,
        assessment: state.assessment,
        evidence_refs: state.refs,
        blocking_reasons: blockers,
        latest_review: record,
        current_approval: approved as SchemaTypes['ReviewView']['current_approval'],
        current_publication: publications.rows[0]?.result ?? null,
        allowed_actions: actions,
      };
      assertSchema('ReviewView', result);
      return result;
    });
  }
  async mutateKnowledge(
    ctx: PrincipalContext,
    id: string,
    action: 'suspend' | 'withdraw' | 'archive',
    value: SchemaTypes['Mutation'],
  ): Promise<SchemaTypes['MutationResult']> {
    const input = governanceInput<SchemaTypes['Mutation']>('Mutation', value);
    const identity = { ...ctx };
    const route = `${action}Knowledge:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await knowledge(client, identity, id, 'knowledge:publish', true);
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) return previous.response as SchemaTypes['MutationResult'];
      if (Number(row.revision) !== input.expected_revision) stale('Knowledge aggregate changed');
      if (action === 'suspend' && row.publication_status !== 'published')
        blocked('Only published knowledge can be suspended');
      const updated = await client.query<{ revision: string }>(
        `UPDATE akb.knowledge_entries SET revision=revision+1,serving_status='suspended',publication_status=CASE WHEN $3='suspend' THEN publication_status WHEN $3='withdraw' THEN 'withdrawn' ELSE 'archived' END WHERE tenant_id=$1 AND id=$2 RETURNING revision`,
        [identity.tenantId, id, action],
      );
      const result = {
        id,
        revision: Number(updated.rows[0]!.revision),
        status:
          action === 'suspend' ? 'suspended' : action === 'withdraw' ? 'withdrawn' : 'archived',
      };
      await assertCapability(client, identity, row.scope_id, 'knowledge:publish');
      await finish(client, identity, input.operation_id, route, hash, result);
      await audit(client, identity, id, result.revision, `knowledge.${action}`, input.operation_id);
      await client.query(
        `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          identity.tenantId,
          randomUUID(),
          `knowledge:${input.operation_id}`,
          `knowledge.${action}`,
          id,
          result.revision,
          JSON.stringify({ knowledge_id: id, status: result.status }),
        ],
      );
      await enqueueIndex(
        client,
        identity.tenantId,
        identity.actorId,
        row.scope_id,
        id,
        result.revision,
      );
      assertSchema('MutationResult', result);
      return result;
    });
  }
}
