import { randomUUID } from 'node:crypto';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { withPrincipalTransaction, AccessDeniedError } from './database.js';
import type { TransactionPool, TransactionClient } from './database.js';
import {
  governanceInput,
  knowledge,
  assertCapability,
  operation,
  finish,
  audit,
  blocked,
  stale,
} from './governance-state.js';
import { canonicalJson } from './contribution-input.js';
import { sha256 } from './evidence-store.js';
import type { EvidenceStore } from './evidence-store.js';
import { evidenceMetadata, checkEvidenceFiles } from './assessment-evidence.js';
import { readTask } from './read-budget.js';
import { applicability } from './retrieval-rules.js';
import { PostgresKnowledgeGovernance } from './knowledge-governance.js';
import { genericMethod, validationMaturity } from './validation-rules.js';
import { serverUsage } from './usage-events.js';
import { AssessmentCursor } from './assessment-cursor.js';
import { allowedScopesSql } from './authorization.js';
import { conflict, invalidInput } from './contribution-errors.js';

type ValidationRow = {
  id: string;
  revision: string;
  submitter_id: string;
  reviewer_id: string | null;
  task_id: string;
  knowledge_id: string;
  knowledge_revision: string;
  document: SchemaTypes['ValidationRequest'];
  request_hash: string | null;
  proof_fingerprint: string | null;
  review_status: SchemaTypes['Validation']['review_status'];
  created_at: Date;
};
const view = (row: ValidationRow): SchemaTypes['Validation'] => ({
  id: row.id,
  revision: Number(row.revision),
  submitted_by: row.submitter_id,
  data: row.document,
  review_status: row.review_status,
});

export class PostgresValidationService {
  private readonly cursor = new AssessmentCursor();
  constructor(
    private readonly pool: TransactionPool,
    private readonly evidence: EvidenceStore,
    private readonly details: PostgresKnowledgeGovernance,
  ) {}

  private async readable(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    revision: number,
    capability: string,
    active = true,
    lock = false,
  ) {
    const target = await knowledge(client, ctx, id, 'knowledge:read', lock);
    await assertCapability(client, ctx, target.scope_id, capability);
    if (
      active &&
      (target.publication_status !== 'published' || target.serving_status !== 'enabled')
    )
      throw new AccessDeniedError();
    if (Number(target.active_content_revision) !== revision)
      await assertCapability(client, ctx, target.scope_id, 'knowledge:history');
    const row = await client.query(
      'SELECT revision FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2 AND revision=$3',
      [ctx.tenantId, id, revision],
    );
    if (!row.rowCount) throw new AccessDeniedError();
    return target;
  }
  private async taskScope(
    client: TransactionClient,
    ctx: PrincipalContext,
    task: string,
    scope: string,
  ) {
    const t = await readTask(client, ctx, task, undefined, true);
    const match = await client.query(
      `SELECT s.id FROM akb.scopes s JOIN akb.repos r ON r.tenant_id=s.tenant_id AND r.id=$3 WHERE s.tenant_id=$1 AND s.id=$2 AND (s.kind='team' OR s.repo_id=r.id OR s.domain_id=r.domain_id)`,
      [ctx.tenantId, scope, t.repo_id],
    );
    if (!match.rowCount) throw new AccessDeniedError();
    return t;
  }
  private async refs(
    client: TransactionClient,
    ctx: PrincipalContext,
    data: SchemaTypes['ValidationRequest'],
    scope: string,
  ) {
    const metadata = await evidenceMetadata(client, ctx, data.evidence_refs);
    if (metadata.some((m) => m.scope_id !== scope))
      blocked('Validation evidence must be shareable in the knowledge scope');
    return metadata;
  }
  private async checked(
    ctx: PrincipalContext,
    data: SchemaTypes['ValidationRequest'],
    scope: string,
  ) {
    const metadata = await withPrincipalTransaction(this.pool, ctx, (c) =>
      this.refs(c, ctx, data, scope),
    );
    await checkEvidenceFiles(this.evidence, ctx, metadata);
    return metadata;
  }
  async usage(
    ctx: PrincipalContext,
    value: SchemaTypes['UsageRequest'],
  ): Promise<SchemaTypes['EventResult']> {
    const data = governanceInput<SchemaTypes['UsageRequest']>('UsageRequest', value),
      identity = { ...ctx };
    const hash = sha256(canonicalJson(data));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const k = await this.readable(
        client,
        identity,
        data.knowledge_id,
        data.revision,
        'knowledge:read',
      );
      await this.taskScope(client, identity, data.task_id, k.scope_id);
      const previous = await operation(client, identity, data.event_id, 'recordUsage', hash);
      if (previous)
        return { ...(previous.response as SchemaTypes['EventResult']), result: 'duplicate' };
      const old = await client.query<{ id: string; payload_hash: string }>(
        'SELECT id,payload_hash FROM akb.usage_events WHERE tenant_id=$1 AND actor_id=$2 AND event_id=$3',
        [identity.tenantId, identity.actorId, data.event_id],
      );
      if (old.rows[0]) {
        if (old.rows[0].payload_hash !== hash) conflict();
        return { id: old.rows[0].id, result: 'duplicate' };
      }
      const result: SchemaTypes['EventResult'] = { id: randomUUID(), result: 'recorded' };
      await client.query(
        `INSERT INTO akb.usage_events(tenant_id,id,event_id,actor_id,task_id,knowledge_id,knowledge_revision,event_type,used_in,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          identity.tenantId,
          result.id,
          data.event_id,
          identity.actorId,
          data.task_id,
          data.knowledge_id,
          data.revision,
          data.event_type,
          data.used_in,
          hash,
        ],
      );
      await finish(client, identity, data.event_id, 'recordUsage', hash, result);
      return result;
    });
  }
  async feedback(
    ctx: PrincipalContext,
    value: SchemaTypes['FeedbackRequest'],
  ): Promise<SchemaTypes['EventResult']> {
    const data = governanceInput<SchemaTypes['FeedbackRequest']>('FeedbackRequest', value),
      identity = { ...ctx };
    const hash = sha256(canonicalJson(data));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      await this.readable(
        client,
        identity,
        data.knowledge_id,
        data.revision,
        'knowledge:contribute',
      );
      const previous = await operation(client, identity, data.event_id, 'submitFeedback', hash);
      if (previous)
        return { ...(previous.response as SchemaTypes['EventResult']), result: 'duplicate' };
      const old = await client.query<{ id: string; payload_hash: string }>(
        'SELECT id,payload_hash FROM akb.feedback WHERE tenant_id=$1 AND actor_id=$2 AND event_id=$3',
        [identity.tenantId, identity.actorId, data.event_id],
      );
      if (old.rows[0]) {
        if (old.rows[0].payload_hash !== hash) conflict();
        return { id: old.rows[0].id, result: 'duplicate' };
      }
      const result: SchemaTypes['EventResult'] = { id: randomUUID(), result: 'recorded' };
      await client.query(
        `INSERT INTO akb.feedback(tenant_id,id,actor_id,knowledge_id,knowledge_revision,category,description,event_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          identity.tenantId,
          result.id,
          identity.actorId,
          data.knowledge_id,
          data.revision,
          data.category,
          data.description,
          data.event_id,
          hash,
        ],
      );
      await finish(client, identity, data.event_id, 'submitFeedback', hash, result);
      await audit(
        client,
        identity,
        data.knowledge_id,
        data.revision,
        'feedback.recorded',
        data.event_id,
      );
      return result;
    });
  }
  async submit(
    ctx: PrincipalContext,
    value: SchemaTypes['ValidationRequest'],
  ): Promise<SchemaTypes['Validation']> {
    const data = governanceInput<SchemaTypes['ValidationRequest']>('ValidationRequest', value),
      identity = { ...ctx };
    const hash = sha256(canonicalJson(data));
    const prepared = await withPrincipalTransaction(this.pool, identity, async (client) => {
      const k = await this.readable(
        client,
        identity,
        data.knowledge_id,
        data.revision,
        'knowledge:contribute',
      );
      await this.taskScope(client, identity, data.task_id, k.scope_id);
      return k;
    });
    const metadata = await this.checked(identity, data, prepared.scope_id);
    const fingerprint = sha256(
      canonicalJson({
        method: data.method.normalize('NFKC').trim(),
        expected: data.expected_result,
        actual: data.actual_result,
        outcome: data.outcome,
        environment: data.environment,
        evidence: metadata
          .map((m) => ({ hash: m.sha256, locator: m.locator }))
          .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
      }),
    );
    const proof = sha256(canonicalJson([...new Set(metadata.map((m) => m.sha256))].sort()));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const k = await this.readable(
        client,
        identity,
        data.knowledge_id,
        data.revision,
        'knowledge:contribute',
        true,
        true,
      );
      const t = await this.taskScope(client, identity, data.task_id, k.scope_id);
      if (t.environment && canonicalJson(t.environment) !== canonicalJson(data.environment))
        invalidInput('Validation environment must match its immutable task environment');
      if (!t.environment)
        await client.query(
          'UPDATE akb.tasks SET environment=$3::jsonb WHERE tenant_id=$1 AND id=$2',
          [identity.tenantId, data.task_id, JSON.stringify(data.environment)],
        );
      await this.refs(client, identity, data, k.scope_id);
      await operation(client, identity, data.event_id, 'submitValidation', hash);
      const old = await client.query<ValidationRow>(
        'SELECT * FROM akb.validations WHERE tenant_id=$1 AND submitter_id=$2 AND event_id=$3',
        [identity.tenantId, identity.actorId, data.event_id],
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) conflict();
        return view(old.rows[0]);
      }
      const duplicate = await client.query<ValidationRow>(
        'SELECT * FROM akb.validations WHERE tenant_id=$1 AND task_id=$2 AND knowledge_id=$3 AND knowledge_revision=$4 AND evidence_method_hash=$5',
        [identity.tenantId, data.task_id, data.knowledge_id, data.revision, fingerprint],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].submitter_id !== identity.actorId) throw new AccessDeniedError();
        const result = view(duplicate.rows[0]);
        await finish(client, identity, data.event_id, 'submitValidation', hash, result);
        return result;
      }
      const row = await client.query<ValidationRow>(
        `INSERT INTO akb.validations(tenant_id,id,submitter_id,task_id,knowledge_id,knowledge_revision,evidence_method_hash,outcome,review_status,document,event_id,request_hash,proof_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb,$10,$11,$12) RETURNING *`,
        [
          identity.tenantId,
          randomUUID(),
          identity.actorId,
          data.task_id,
          data.knowledge_id,
          data.revision,
          fingerprint,
          data.outcome,
          JSON.stringify(data),
          data.event_id,
          hash,
          proof,
        ],
      );
      const result = view(row.rows[0]!);
      await finish(client, identity, data.event_id, 'submitValidation', hash, result);
      await serverUsage(
        client,
        identity,
        data.task_id,
        data.knowledge_id,
        data.revision,
        'validation_submitted',
        result.id,
      );
      await audit(client, identity, result.id, 1, 'validation.submitted', data.event_id);
      return result;
    });
  }
  private async find(client: TransactionClient, ctx: PrincipalContext, id: string, lock = false) {
    const row = await client.query<ValidationRow>(
      `WITH allowed AS (${allowedScopesSql}) SELECT v.* FROM akb.validations v JOIN akb.knowledge_entries k ON k.tenant_id=v.tenant_id AND k.id=v.knowledge_id JOIN allowed ON allowed.id=k.scope_id WHERE v.tenant_id=$1 AND v.id=$5 ${lock ? 'FOR UPDATE OF v' : ''}`,
      [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'knowledge:validation-review', id],
    );
    if (!row.rows[0]) throw new AccessDeniedError();
    return row.rows[0];
  }
  async review(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['ValidationReview'],
  ): Promise<SchemaTypes['Validation']> {
    const input = governanceInput<SchemaTypes['ValidationReview']>('ValidationReview', value),
      identity = { ...ctx };
    const prepared = await withPrincipalTransaction(this.pool, identity, (c) =>
      this.find(c, identity, id),
    );
    const current = await this.details.detail(identity, prepared.knowledge_id);
    const detail =
      current.content_revision === Number(prepared.knowledge_revision)
        ? current
        : await this.details.detail(
            identity,
            prepared.knowledge_id,
            Number(prepared.knowledge_revision),
          );
    const metadata = await this.checked(identity, prepared.document, detail.body.scope.id);
    const hash = sha256(canonicalJson({ id, ...input }));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const k = await this.readable(
        client,
        identity,
        prepared.knowledge_id,
        Number(prepared.knowledge_revision),
        'knowledge:validation-review',
        false,
        true,
      );
      const row = await this.find(client, identity, id, true);
      const finalRefs = await this.refs(client, identity, row.document, k.scope_id);
      const previous = await operation(
        client,
        identity,
        input.operation_id,
        'reviewValidation',
        hash,
      );
      if (previous) return previous.response as SchemaTypes['Validation'];
      if (row.submitter_id === identity.actorId)
        blocked('Validation requires a reviewer different from its submitter');
      if (Number(row.revision) !== input.expected_revision || row.review_status !== 'pending')
        stale('Validation revision or review state changed');
      if (input.action === 'accept') {
        if (!row.proof_fingerprint || finalRefs.some((m) => m.evidence_kind !== 'retained'))
          blocked('Accepted verification requires retained evidence and a B08 proof binding');
        if (genericMethod(row.document.method))
          blocked('A whole build or test suite is not a conclusion-specific verification');
        if (!applicability(detail.body, row.document.environment).matches)
          blocked('Validation does not establish the knowledge dependency conditions');
        const binding = (refs: typeof metadata) =>
          canonicalJson(
            refs
              .map((m) => ({ id: m.id, revision: m.revision, locator: m.locator, hash: m.sha256 }))
              .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
          );
        if (binding(metadata) !== binding(finalRefs))
          blocked('Validation evidence changed during review');
        if (detail.body.knowledge_role === 'authoritative_mirror') {
          const authority = detail.body.mirror!.authority_ref;
          if (
            !row.document.evidence_refs.some((r) => canonicalJson(r) === canonicalJson(authority))
          )
            blocked('Authority confirmation must include the registered authority reference');
          const source = finalRefs.find(
            (m) => m.id === authority.id && Number(m.revision) === authority.revision,
          )!;
          const registered = await client.query(
            `SELECT id FROM akb.baseline_materials WHERE tenant_id=$1 AND material_kind='authoritative_doc' AND source_ref=$2 AND source_revision=$3 AND locator=$4 AND content_hash=$5`,
            [
              identity.tenantId,
              source.source_ref,
              source.source_revision,
              source.locator,
              source.sha256,
            ],
          );
          if (!registered.rowCount)
            blocked('Authority confirmation needs an owner-registered current source');
        }
      }
      const updated = await client.query<ValidationRow>(
        `UPDATE akb.validations SET revision=revision+1,reviewer_id=$3,review_status=$4 WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [
          identity.tenantId,
          id,
          identity.actorId,
          input.action === 'accept' ? 'accepted' : 'rejected',
        ],
      );
      const result = view(updated.rows[0]!);
      await client.query(
        `INSERT INTO akb.validation_reviews(tenant_id,id,validation_id,validation_revision,operation_id,submitter_id,reviewer_id,action,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          identity.tenantId,
          randomUUID(),
          id,
          result.revision,
          input.operation_id,
          row.submitter_id,
          identity.actorId,
          input.action,
          input.reason,
        ],
      );
      if (input.action === 'accept') {
        await this.recompute(
          client,
          identity,
          row.knowledge_id,
          Number(row.knowledge_revision),
          detail.body.scope.kind !== 'repo',
        );
        await serverUsage(
          client,
          identity,
          row.task_id,
          row.knowledge_id,
          Number(row.knowledge_revision),
          'validation_accepted',
          id,
        );
        await client.query(
          `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload) VALUES($1,$2,$3,'validation.accepted',$4,$5,$6::jsonb)`,
          [
            identity.tenantId,
            randomUUID(),
            `validation:${input.operation_id}`,
            id,
            result.revision,
            JSON.stringify({
              knowledge_id: row.knowledge_id,
              knowledge_revision: Number(row.knowledge_revision),
              outcome: row.document.outcome,
            }),
          ],
        );
      }
      await finish(client, identity, input.operation_id, 'reviewValidation', hash, result);
      await audit(
        client,
        identity,
        id,
        result.revision,
        `validation.${result.review_status}`,
        input.operation_id,
      );
      return result;
    });
  }
  private async recompute(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    revision: number,
    crossProject: boolean,
  ) {
    const proofs = await client.query<{
      task: string;
      actor: string;
      repo: string;
      proof: string;
      outcome: string;
      accepted_at: Date;
    }>(
      `SELECT v.task_id task,v.submitter_id actor,t.repo_id repo,v.proof_fingerprint proof,v.outcome,h.created_at accepted_at FROM akb.validations v JOIN akb.tasks t ON t.tenant_id=v.tenant_id AND t.id=v.task_id JOIN akb.validation_reviews h ON h.tenant_id=v.tenant_id AND h.validation_id=v.id AND h.action='accept' WHERE v.tenant_id=$1 AND v.knowledge_id=$2 AND v.knowledge_revision=$3 AND v.review_status='accepted' AND v.proof_fingerprint IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(v.document->'evidence_refs') AS ref(id uuid,revision bigint,locator text) LEFT JOIN akb.evidence e ON e.tenant_id=v.tenant_id AND e.id=ref.id AND e.revision=ref.revision AND e.locator=ref.locator WHERE e.id IS NULL OR e.status<>'available' OR e.expires_at<=now())`,
      [ctx.tenantId, id, revision],
    );
    const success = proofs.rows.filter((p) => p.outcome === 'success');
    const maturity = validationMaturity(success, crossProject);
    const failed = proofs.rows.some((p) => p.outcome === 'failure');
    const lastSuccess = success.length
      ? new Date(Math.max(...success.map((p) => p.accepted_at.getTime())))
      : null;
    const updated = await client.query<{
      maturity: string;
      freshness: string;
      review_due_at: Date | null;
    }>(
      `UPDATE akb.knowledge_revisions SET maturity=$4,freshness=CASE WHEN $5 THEN 'review_due' WHEN $6 THEN 'current' ELSE freshness END,last_validated_at=$7,review_due_at=CASE WHEN $5 THEN now() WHEN $6 THEN $7::timestamptz+interval '90 days' ELSE review_due_at END WHERE tenant_id=$1 AND knowledge_id=$2 AND revision=$3 RETURNING *`,
      [ctx.tenantId, id, revision, maturity, failed, success.length > 0, lastSuccess],
    );
    const row = updated.rows[0]!;
    await client.query(
      `UPDATE akb.knowledge_entries SET revision=revision+1,maturity=$4,freshness=$5,review_due_at=$6 WHERE tenant_id=$1 AND id=$2 AND active_content_revision=$3`,
      [ctx.tenantId, id, revision, row.maturity, row.freshness, row.review_due_at],
    );
    if (failed) {
      const target = await knowledge(client, ctx, id, 'knowledge:read');
      await client.query(
        `INSERT INTO akb.jobs(tenant_id,id,actor_id,scope_id,kind,dedupe_key,status,payload) VALUES($1,$2,$3,$4,'counterevidence_review',$5,'queued',$6::jsonb) ON CONFLICT(tenant_id,kind,dedupe_key) DO NOTHING`,
        [
          ctx.tenantId,
          randomUUID(),
          ctx.actorId,
          target.scope_id,
          `${id}:${revision}`,
          JSON.stringify({ knowledge_id: id, knowledge_revision: revision }),
        ],
      );
    }
  }
  async list(
    ctx: PrincipalContext,
    query: { scope_id?: string; limit?: number; cursor?: string },
  ): Promise<SchemaTypes['ValidationPage']> {
    const identity = { ...ctx },
      limit = query.limit ?? 20,
      filter = { route: 'validations', scope: query.scope_id ?? null, limit };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalidInput('Invalid validation page limit');
    const position = query.cursor ? this.cursor.decode(identity, filter, query.cursor) : undefined;
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const rows = await client.query<ValidationRow>(
        `WITH allowed AS (${allowedScopesSql}) SELECT v.* FROM akb.validations v JOIN akb.knowledge_entries k ON k.tenant_id=v.tenant_id AND k.id=v.knowledge_id JOIN allowed ON allowed.id=k.scope_id WHERE v.tenant_id=$1 AND ($5::uuid IS NULL OR k.scope_id=$5) AND ($6::timestamptz IS NULL OR (v.created_at,v.id)<($6::timestamptz,$7::uuid)) ORDER BY v.created_at DESC,v.id DESC LIMIT $8`,
        [
          identity.tenantId,
          identity.actorId,
          identity.authzVersion,
          'knowledge:validation-review',
          query.scope_id ?? null,
          position?.date ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const items: SchemaTypes['Validation'][] = [];
      for (const row of rows.rows.slice(0, limit)) {
        await this.readable(
          client,
          identity,
          row.knowledge_id,
          Number(row.knowledge_revision),
          'knowledge:validation-review',
          false,
        );
        await this.refs(
          client,
          identity,
          row.document,
          (await knowledge(client, identity, row.knowledge_id, 'knowledge:read')).scope_id,
        );
        items.push(view(row));
      }
      const last = rows.rows[limit - 1];
      return {
        items,
        next_cursor:
          rows.rows.length > limit && last
            ? this.cursor.encode(identity, filter, {
                rank: 0,
                date: last.created_at.toISOString(),
                id: last.id,
              })
            : '',
      };
    });
  }
}
