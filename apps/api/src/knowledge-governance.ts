import { randomUUID } from 'node:crypto';
import type { SchemaTypes } from '@accremind/contracts';
import { assertSchema } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import type { EvidenceStore } from './evidence-store.js';
import { sha256 } from './evidence-store.js';
import type { ContentStore } from './content-store.js';
import { canonicalJson } from './contribution-input.js';
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
import { findCandidate, historicalCandidate, hydrateCandidate } from './candidate-state.js';
import { evidenceMetadata, checkEvidenceFiles } from './assessment-evidence.js';
import { AssessmentCursor } from './assessment-cursor.js';
import { allowedScopesSql } from './authorization.js';
import { invalidInput } from './contribution-errors.js';

export class PostgresKnowledgeGovernance {
  private readonly cursor = new AssessmentCursor(Number.MAX_SAFE_INTEGER);
  constructor(
    private readonly pool: TransactionPool,
    private readonly evidence: EvidenceStore,
    private readonly content: ContentStore,
  ) {}
  async createRevision(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['RevisionCreate'],
  ): Promise<SchemaTypes['Candidate']> {
    const input = governanceInput<SchemaTypes['RevisionCreate']>('RevisionCreate', value);
    const identity = { ...ctx };
    const route = `createKnowledgeRevision:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const target = await knowledge(client, identity, id, 'knowledge:contribute', true);
      await assertCapability(client, identity, target.scope_id, 'knowledge:read');
      const contribution = await client.query<{ repo_id: string; actor_id: string }>(
        'SELECT repo_id,actor_id FROM akb.contributions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [identity.tenantId, input.contribution_id],
      );
      if (contribution.rows[0]?.actor_id !== identity.actorId) throw new AccessDeniedError();
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const saved = previous.response as SchemaTypes['Candidate'];
        await hydrateCandidate(
          client,
          identity,
          await historicalCandidate(
            client,
            identity,
            await findCandidate(client, identity, saved.id, 'knowledge:contribute'),
            saved.revision,
          ),
          this.evidence,
          'knowledge:contribute',
        );
        return saved;
      }
      if (
        target.revision !== String(input.expected_revision) ||
        target.active_content_revision !== String(input.base_content_revision)
      )
        stale('Target version changed');
      if (target.publication_status !== 'published') blocked('Target is not published');
      if (input.body.scope.id !== target.scope_id)
        blocked('Scope changes need a separate disclosure workflow');
      const scope = await client.query<{ kind: string; repo_id: string | null }>(
        'SELECT kind,repo_id FROM akb.scopes WHERE tenant_id=$1 AND id=$2',
        [identity.tenantId, target.scope_id],
      );
      if (
        scope.rows[0]?.kind !== input.body.scope.kind ||
        (scope.rows[0].repo_id && scope.rows[0].repo_id !== contribution.rows[0].repo_id)
      )
        blocked('Contribution repository and target scope differ');
      const owner = await client.query(
        'SELECT id FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
        [identity.tenantId, input.body.owner_id],
      );
      if (owner.rowCount !== 1) throw new AccessDeniedError();
      const candidateId = randomUUID();
      await client.query(
        `INSERT INTO akb.candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision,body,knowledge_role) VALUES($1,$2,$3,$4,$5,$6,'revision',$7,$8,$9,$10::jsonb,$11)`,
        [
          identity.tenantId,
          candidateId,
          input.contribution_id,
          identity.actorId,
          target.scope_id,
          input.body.owner_id,
          id,
          input.base_content_revision,
          input.expected_revision,
          JSON.stringify(input.body),
          input.body.knowledge_role,
        ],
      );
      await this.saveSnapshot(client, identity, candidateId);
      const result = (
        await hydrateCandidate(
          client,
          identity,
          await findCandidate(client, identity, candidateId, 'knowledge:contribute'),
          this.evidence,
          'knowledge:contribute',
        )
      ).candidate;
      await aggregate(client, identity, input.contribution_id, input.operation_id);
      await finish(client, identity, input.operation_id, route, hash, result);
      await audit(
        client,
        identity,
        candidateId,
        1,
        'candidate.revision_created',
        input.operation_id,
      );
      return result;
    });
  }
  private async saveSnapshot(client: TransactionClient, ctx: PrincipalContext, id: string) {
    await client.query(
      `INSERT INTO akb.candidate_revisions(tenant_id,candidate_id,revision,body,actor_id,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision) SELECT tenant_id,id,revision,body,$3,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision FROM akb.candidates WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, id, ctx.actorId],
    );
  }
  async rebase(
    ctx: PrincipalContext,
    id: string,
    value: SchemaTypes['RevisionRebase'],
  ): Promise<SchemaTypes['Candidate']> {
    const input = governanceInput<SchemaTypes['RevisionRebase']>('RevisionRebase', value);
    const identity = { ...ctx };
    const route = `rebaseRevisionCandidate:${id}`;
    const hash = sha256(canonicalJson(input));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await lockCandidate(client, identity, id, 'knowledge:contribute');
      if (row.contributor_id !== identity.actorId) throw new AccessDeniedError();
      if (!row.target_knowledge_id) blocked('Only revision candidates can rebase');
      const previous = await operation(client, identity, input.operation_id, route, hash);
      if (previous) {
        const saved = previous.response as SchemaTypes['Candidate'];
        await hydrateCandidate(
          client,
          identity,
          await historicalCandidate(client, identity, row, saved.revision),
          this.evidence,
          'knowledge:contribute',
        );
        return saved;
      }
      if (row.revision !== String(input.expected_revision)) stale('Candidate changed');
      if (['published', 'rejected', 'withdrawn'].includes(row.publication_status))
        blocked('Candidate is closed');
      const target = await knowledge(
        client,
        identity,
        row.target_knowledge_id,
        'knowledge:contribute',
      );
      if (
        target.revision !== String(input.expected_target_revision) ||
        target.active_content_revision !== String(input.base_content_revision)
      )
        stale('Target changed');
      if (
        target.publication_status !== 'published' ||
        !sameScope(row.body.scope, input.body.scope) ||
        target.scope_id !== input.body.scope.id
      )
        blocked('Target state or scope is unsuitable');
      const owner = await client.query(
        'SELECT id FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
        [identity.tenantId, input.body.owner_id],
      );
      if (owner.rowCount !== 1) throw new AccessDeniedError();
      await client.query(
        `UPDATE akb.candidates SET revision=revision+1,base_content_revision=$3,base_aggregate_revision=$4,body=$5::jsonb,owner_id=$6,knowledge_role=$7,publication_status='candidate' WHERE tenant_id=$1 AND id=$2`,
        [
          identity.tenantId,
          id,
          input.base_content_revision,
          input.expected_target_revision,
          JSON.stringify(input.body),
          input.body.owner_id,
          input.body.knowledge_role,
        ],
      );
      await this.saveSnapshot(client, identity, id);
      const result = (
        await hydrateCandidate(
          client,
          identity,
          await findCandidate(client, identity, id, 'knowledge:contribute'),
          this.evidence,
          'knowledge:contribute',
        )
      ).candidate;
      await aggregate(client, identity, row.contribution_id, input.operation_id);
      await finish(client, identity, input.operation_id, route, hash, result);
      await audit(client, identity, id, result.revision, 'candidate.rebased', input.operation_id);
      return result;
    });
  }
  async detail(
    ctx: PrincipalContext,
    id: string,
    revision?: number,
  ): Promise<SchemaTypes['KnowledgeDetail']> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, (client) =>
      this.detailInTransaction(client, identity, id, revision),
    );
  }
  private async detailInTransaction(
    client: TransactionClient,
    identity: PrincipalContext,
    id: string,
    revision?: number,
  ): Promise<SchemaTypes['KnowledgeDetail']> {
    const target = await knowledge(client, identity, id, 'knowledge:read');
    if (revision !== undefined) {
      if (!Number.isSafeInteger(revision) || revision < 1) blocked('Invalid content revision');
      await assertCapability(client, identity, target.scope_id, 'knowledge:history');
    }
    if (target.publication_status !== 'published' || target.serving_status !== 'enabled')
      await assertCapability(client, identity, target.scope_id, 'knowledge:review');
    const result = await client.query<{
      revision: string;
      content_ref: string;
      content_hash: string;
      created_at: Date;
      maturity: SchemaTypes['Maturity'];
      freshness: SchemaTypes['Freshness'];
      review_due_at: Date | null;
      last_validated_at: Date | null;
    }>(
      'SELECT * FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2 AND revision=$3',
      [identity.tenantId, id, revision ?? Number(target.active_content_revision)],
    );
    const row = result.rows[0];
    if (!row) throw new AccessDeniedError();
    const content = JSON.parse(
      await this.content.read(identity.tenantId, row.content_ref, row.content_hash),
    ) as {
      body: SchemaTypes['CandidateBody'];
      assessment: SchemaTypes['Assessment'];
      assessment_id: string;
      assessment_revision: number;
      source_refs: SchemaTypes['EvidenceRef'][];
    };
    assertSchema('CandidateBody', content.body);
    assertSchema('Assessment', content.assessment);
    const metadata = await evidenceMetadata(client, identity, content.source_refs);
    await checkEvidenceFiles(this.evidence, identity, metadata);
    const latest = await knowledge(client, identity, id, 'knowledge:read');
    if (latest.publication_status !== 'published' || latest.serving_status !== 'enabled')
      await assertCapability(client, identity, target.scope_id, 'knowledge:review');
    if (revision !== undefined)
      await assertCapability(client, identity, target.scope_id, 'knowledge:history');
    await evidenceMetadata(client, identity, content.source_refs);
    const isCurrent = latest.active_content_revision === row.revision;
    const data: SchemaTypes['KnowledgeDetail'] = {
      id,
      aggregate_revision: Number(latest.revision),
      content_revision: Number(row.revision),
      body: content.body,
      capture_assessment_id: content.assessment_id,
      capture_assessment_revision: content.assessment_revision,
      knowledge_delta: content.assessment.knowledge_delta,
      source_refs: content.source_refs,
      publication_status: latest.publication_status,
      serving_status: latest.serving_status,
      maturity: row.maturity,
      freshness: row.freshness,
      created_at: row.created_at.toISOString(),
      review_due_at: row.review_due_at?.toISOString() ?? null,
      last_validated_at: row.last_validated_at?.toISOString() ?? null,
      is_current: isCurrent,
      usage_mode:
        isCurrent &&
        latest.publication_status === 'published' &&
        latest.serving_status === 'enabled'
          ? 'current_guidance'
          : 'historical_reference',
    };
    assertSchema('KnowledgeDetail', data);
    return data;
  }

  async list(
    ctx: PrincipalContext,
    query: { scope_id?: string; cursor?: string; limit?: number },
  ): Promise<SchemaTypes['KnowledgeSummaryPage']> {
    const identity = { ...ctx },
      limit = query.limit ?? 20,
      filter = { endpoint: 'knowledge-list', scope: query.scope_id ?? null };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalidInput('Invalid knowledge page limit');
    const position = query.cursor ? this.cursor.decode(identity, filter, query.cursor) : undefined;
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      if (query.scope_id)
        await assertCapability(client, identity, query.scope_id, 'knowledge:read');
      const rows = (
        await client.query<{ id: string; date: string }>(
          `WITH allowed AS (${allowedScopesSql}) SELECT k.id,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') date FROM akb.knowledge_entries k JOIN allowed a ON a.id=k.scope_id JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision WHERE k.tenant_id=$1 AND k.publication_status='published' AND k.serving_status='enabled' AND ($5::uuid IS NULL OR k.scope_id=$5) AND ($6::timestamptz IS NULL OR (r.created_at,k.id)<($6,$7::uuid)) ORDER BY r.created_at DESC,k.id DESC LIMIT $8`,
          [
            identity.tenantId,
            identity.actorId,
            identity.authzVersion,
            'knowledge:read',
            query.scope_id ?? null,
            position?.date ?? null,
            position?.id ?? null,
            limit + 1,
          ],
        )
      ).rows;
      const details: SchemaTypes['KnowledgeDetail'][] = [];
      for (const row of rows.slice(0, limit))
        details.push(await this.detailInTransaction(client, identity, row.id));
      for (const detail of details) {
        const latest = await knowledge(client, identity, detail.id, 'knowledge:read');
        if (
          latest.publication_status !== 'published' ||
          latest.serving_status !== 'enabled' ||
          Number(latest.active_content_revision) !== detail.content_revision
        )
          throw new AccessDeniedError();
        await evidenceMetadata(client, identity, detail.source_refs);
      }
      const last = rows.slice(0, limit).at(-1);
      const result = {
        items: details.map((d) => ({
          id: d.id,
          aggregate_revision: d.aggregate_revision,
          content_revision: d.content_revision,
          title: d.body.title,
          type: d.body.type,
          knowledge_role: d.body.knowledge_role,
          scope: d.body.scope,
          owner_id: d.body.owner_id,
          publication_status: d.publication_status,
          serving_status: d.serving_status,
          maturity: d.maturity,
          freshness: d.freshness,
        })),
        next_cursor:
          rows.length > limit && last
            ? this.cursor.encode(identity, filter, { rank: 0, date: last.date, id: last.id })
            : '',
      };
      assertSchema('KnowledgeSummaryPage', result);
      return result;
    });
  }
  async history(
    ctx: PrincipalContext,
    id: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<SchemaTypes['KnowledgeRevisionPage']> {
    const identity = { ...ctx };
    const { limit = 20, cursor } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) blocked('Invalid page size');
    const filter = { kind: 'history', scope: id };
    const position = cursor ? this.cursor.decode(identity, filter, cursor) : undefined;
    const rows = await withPrincipalTransaction(this.pool, identity, async (client) => {
      const target = await knowledge(client, identity, id, 'knowledge:history');
      await assertCapability(client, identity, target.scope_id, 'knowledge:read');
      const result = await client.query<{ revision: string; date: string }>(
        `SELECT revision,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') date FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2 AND ($3::bigint IS NULL OR revision>$3) ORDER BY revision LIMIT $4`,
        [identity.tenantId, id, position?.rank ?? null, limit + 1],
      );
      return result.rows;
    });
    const items: SchemaTypes['KnowledgeRevisionSummary'][] = [];
    for (const row of rows.slice(0, limit)) {
      const detail = await this.detail(identity, id, Number(row.revision));
      items.push({
        id,
        aggregate_revision: detail.aggregate_revision,
        content_revision: detail.content_revision,
        title: detail.body.title,
        created_at: detail.created_at,
        is_current: detail.is_current,
        revision_status: detail.is_current ? 'current' : 'superseded',
        publication_status: detail.publication_status,
        serving_status: detail.serving_status,
      });
    }
    const last = rows.slice(0, limit).at(-1);
    const data = {
      items,
      next_cursor:
        rows.length > limit && last
          ? this.cursor.encode(identity, filter, {
              rank: Number(last.revision),
              date: last.date,
              id,
            })
          : '',
    };
    assertSchema('KnowledgeRevisionPage', data);
    return data;
  }
}
