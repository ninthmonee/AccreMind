import { randomUUID } from 'node:crypto';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { allowedScopesInTransaction, allowedScopesSql } from './authorization.js';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { ContributionError, conflict, invalidInput } from './contribution-errors.js';
import { candidateEvidence, canonicalJson, validateContribution } from './contribution-input.js';
import { sha256 } from './evidence-store.js';
import type { EvidenceStore } from './evidence-store.js';
import { ContributionCursor } from './contribution-cursor.js';
import { findCandidate, hydrateCandidate } from './candidate-state.js';

type ContributionRow = {
  id: string;
  revision: string;
  processing_status: SchemaTypes['Contribution']['processing_status'];
  actor_id: string;
  payload_hash: string;
};

type EvidenceRow = {
  id: string;
  revision: string;
  source_ref: string;
  source_revision: string;
  locator: string;
  sha256: string;
  object_key: string;
  evidence_kind: 'raw' | 'retained';
  expires_at: Date;
};

export class PostgresContributionService {
  private readonly cursor = new ContributionCursor();
  constructor(
    private readonly pool: TransactionPool,
    private readonly store: EvidenceStore,
  ) {}

  private async lock(client: TransactionClient, tenant: string, key: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${tenant}:${key}`,
    ]);
  }

  private async operation(
    client: TransactionClient,
    ctx: PrincipalContext,
    key: string,
    route: string,
    hash: string,
  ): Promise<string | undefined> {
    await this.lock(client, ctx.tenantId, `operation:${key}`);
    const result = await client.query<{
      actor_id: string;
      route: string;
      payload_hash: string;
      result_ref: string;
    }>(
      'SELECT actor_id, route, payload_hash, result_ref FROM akb.operations WHERE tenant_id=$1 AND id=$2',
      [ctx.tenantId, key],
    );
    const row = result.rows[0];
    if (!row) return;
    if (row.actor_id !== ctx.actorId || row.route !== route || row.payload_hash !== hash)
      conflict();
    return row.result_ref;
  }

  private async saveOperation(
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

  private async repoScope(
    client: TransactionClient,
    ctx: PrincipalContext,
    repo: string,
    capability: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `WITH allowed AS (${allowedScopesSql})
       SELECT scope.id FROM akb.scopes scope JOIN allowed ON allowed.id=scope.id
       WHERE scope.tenant_id=$1 AND scope.kind='repo' AND scope.repo_id=$5`,
      [ctx.tenantId, ctx.actorId, ctx.authzVersion, capability, repo],
    );
    const scope = result.rows[0]?.id;
    if (!scope) throw new AccessDeniedError();
    return scope;
  }

  async createTask(
    ctx: PrincipalContext,
    value: SchemaTypes['TaskCreate'],
  ): Promise<SchemaTypes['Task']> {
    try {
      assertSchema('TaskCreate', value);
    } catch {
      invalidInput('Invalid task request');
    }
    const input = structuredClone(value);
    const identity = { ...ctx };
    const hash = sha256(
      canonicalJson({ repo_id: input.repo_id, client_session_id: input.client_session_id }),
    );
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      await this.repoScope(client, identity, input.repo_id, 'knowledge:read');
      const previous = await this.operation(
        client,
        identity,
        input.operation_id,
        'createTask',
        hash,
      );
      let taskId = previous ?? randomUUID();
      if (!previous) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${identity.tenantId}:task-create:${identity.actorId}`,
        ]);
        const live = await client.query<{ id: string }>(
          'SELECT id FROM akb.tasks WHERE tenant_id=$1 AND principal_id=$2 AND repo_id=$3 AND client_session_id=$4 AND expires_at>now() ORDER BY expires_at DESC LIMIT 1',
          [identity.tenantId, identity.actorId, input.repo_id, input.client_session_id],
        );
        if (live.rows[0]) taskId = live.rows[0].id;
        else {
          const count = await client.query<{ count: string }>(
            "SELECT count(*) FROM akb.tasks WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>now()+interval '7 hours'",
            [identity.tenantId, identity.actorId],
          );
          if (Number(count.rows[0]!.count) >= 10)
            throw new ContributionError(
              'RATE_LIMITED',
              429,
              'Task session creation exceeds the hourly policy',
            );
          await client.query(
            `INSERT INTO akb.tasks(tenant_id,id,principal_id,repo_id,client_session_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '8 hours')`,
            [identity.tenantId, taskId, identity.actorId, input.repo_id, input.client_session_id],
          );
        }
        await this.saveOperation(client, identity, input.operation_id, 'createTask', hash, taskId);
      }
      const result = await client.query<{
        expires_at: Date;
        limit_reads: number;
        used_reads: number;
        reserved_reads: number;
      }>(
        'SELECT expires_at,limit_reads,used_reads,reserved_reads FROM akb.tasks WHERE tenant_id=$1 AND id=$2 AND principal_id=$3',
        [identity.tenantId, taskId, identity.actorId],
      );
      const row = result.rows[0];
      if (!row) throw new AccessDeniedError();
      const task: SchemaTypes['Task'] = {
        id: taskId,
        repo_id: input.repo_id,
        expires_at: row.expires_at.toISOString(),
        budget: {
          limit: row.limit_reads,
          used: row.used_reads,
          reserved: row.reserved_reads,
          remaining: row.limit_reads - row.used_reads - row.reserved_reads,
          returned_tokens: 0,
        },
      };
      assertSchema('Task', task);
      return task;
    });
  }

  async ingest(ctx: PrincipalContext, value: unknown): Promise<SchemaTypes['IngestResult']> {
    const input = validateContribution(value);
    const identity = { ...ctx };
    const { idempotency_key: key, ...payload } = input;
    const hash = sha256(canonicalJson(payload));
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const scopeId = await this.repoScope(client, identity, input.repo_id, 'knowledge:contribute');
      const previous = await this.operation(client, identity, key, 'ingestContribution', hash);
      if (previous) return this.ingestResult(client, identity, previous, 'duplicate');

      // Stable event ordering prevents concurrent overlapping bundles from deadlocking.
      for (const event of [...input.source_event_ids].sort())
        await this.lock(client, identity.tenantId, `manual:${event}`);
      const events = await client.query<{ contribution_id: string }>(
        `SELECT contribution_id FROM akb.source_events WHERE tenant_id=$1 AND source='manual' AND external_event_id=ANY($2::uuid[])`,
        [identity.tenantId, input.source_event_ids],
      );
      if (events.rowCount) {
        if (
          events.rowCount !== input.source_event_ids.length ||
          new Set(events.rows.map((row) => row.contribution_id)).size !== 1
        )
          conflict();
        const existingId = events.rows[0]!.contribution_id;
        const existing = await client.query<ContributionRow>(
          'SELECT * FROM akb.contributions WHERE tenant_id=$1 AND id=$2',
          [identity.tenantId, existingId],
        );
        if (
          existing.rows[0]?.actor_id !== identity.actorId ||
          existing.rows[0]?.payload_hash !== hash
        )
          conflict();
        await this.saveOperation(client, identity, key, 'ingestContribution', hash, existingId);
        return this.ingestResult(client, identity, existingId, 'duplicate');
      }

      const task = await client.query(
        `SELECT id FROM akb.tasks WHERE tenant_id=$1 AND id=$2 AND principal_id=$3 AND repo_id=$4 AND expires_at>now()`,
        [identity.tenantId, input.task_id, identity.actorId, input.repo_id],
      );
      if (task.rowCount !== 1) throw new AccessDeniedError();
      const allowed = await allowedScopesInTransaction(client, identity, 'knowledge:contribute');
      for (const body of input.candidates ?? []) {
        if (!allowed.has(body.scope.id)) throw new AccessDeniedError();
        const valid = await client.query(
          `SELECT scope.id FROM akb.scopes scope JOIN akb.principals owner ON owner.tenant_id=scope.tenant_id AND owner.id=$4 AND owner.active
           WHERE scope.tenant_id=$1 AND scope.id=$2 AND scope.kind=$3`,
          [identity.tenantId, body.scope.id, body.scope.kind, body.owner_id],
        );
        if (valid.rowCount !== 1) throw new AccessDeniedError();
        await this.evidenceRows(client, identity, candidateEvidence(body));
      }

      const contributionId = randomUUID();
      await client.query(
        `INSERT INTO akb.contributions(tenant_id,id,actor_id,repo_id,task_id,idempotency_key,payload_hash,processing_status,environment)
         VALUES($1,$2,$3,$4,$5,$6,$7,'accepted',$8::jsonb)`,
        [
          identity.tenantId,
          contributionId,
          identity.actorId,
          input.repo_id,
          input.task_id,
          key,
          hash,
          JSON.stringify(input.environment),
        ],
      );
      for (const event of input.source_event_ids)
        await client.query(
          `INSERT INTO akb.source_events(tenant_id,id,contribution_id,source,external_event_id,content_hash) VALUES($1,$2,$3,'manual',$4,$5)`,
          [identity.tenantId, randomUUID(), contributionId, event, hash],
        );
      for (const evidence of input.evidence) {
        const evidenceId = randomUUID();
        const objectKey = await this.store.write(identity.tenantId, evidenceId, evidence.content);
        await client.query(
          `INSERT INTO akb.evidence(tenant_id,id,revision,scope_id,contribution_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at)
           VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'raw','available',now()+interval '30 days')`,
          [
            identity.tenantId,
            evidenceId,
            scopeId,
            contributionId,
            evidence.source_ref,
            evidence.source_revision,
            evidence.locator,
            objectKey,
            evidence.sha256,
          ],
        );
        await client.query(
          `INSERT INTO akb.contribution_evidence(tenant_id,contribution_id,client_evidence_id,evidence_id,evidence_revision) VALUES($1,$2,$3,$4,1)`,
          [identity.tenantId, contributionId, evidence.client_evidence_id, evidenceId],
        );
      }
      for (const body of input.candidates ?? []) {
        const candidateId = randomUUID();
        await client.query(
          `INSERT INTO akb.candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,body,knowledge_role)
           VALUES($1,$2,$3,$4,$5,$6,'new',$7::jsonb,$8)`,
          [
            identity.tenantId,
            candidateId,
            contributionId,
            identity.actorId,
            body.scope.id,
            body.owner_id,
            JSON.stringify(body),
            body.knowledge_role,
          ],
        );
        await client.query(
          `INSERT INTO akb.candidate_revisions(tenant_id,candidate_id,revision,body,actor_id,creation_kind) VALUES($1,$2,1,$3::jsonb,$4,'new')`,
          [identity.tenantId, candidateId, JSON.stringify(body), identity.actorId],
        );
      }
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO akb.jobs(tenant_id,id,actor_id,scope_id,kind,dedupe_key,status,payload)
         VALUES($1,$2,$3,$4,'human_assessment',$5,'queued',$6::jsonb)`,
        [
          identity.tenantId,
          jobId,
          identity.actorId,
          scopeId,
          contributionId,
          JSON.stringify({ contribution_id: contributionId }),
        ],
      );
      await client.query(
        `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload)
         VALUES($1,$2,$3,'contribution.accepted',$4,1,$5::jsonb)`,
        [
          identity.tenantId,
          randomUUID(),
          `contribution:${contributionId}:1`,
          contributionId,
          JSON.stringify({ contribution_id: contributionId, job_id: jobId }),
        ],
      );
      await client.query(
        `INSERT INTO akb.audit(tenant_id,id,actor_id,action,object_id,object_revision,reason,request_id) VALUES($1,$2,$3,'contribution.accepted',$4,1,'Explicit manual contribution',$5)`,
        [identity.tenantId, randomUUID(), identity.actorId, contributionId, key],
      );
      await this.repoScope(client, identity, input.repo_id, 'knowledge:contribute');
      const currentScopes = await allowedScopesInTransaction(
        client,
        identity,
        'knowledge:contribute',
      );
      for (const body of input.candidates ?? []) {
        if (!currentScopes.has(body.scope.id)) throw new AccessDeniedError();
        await this.evidenceRows(client, identity, candidateEvidence(body));
      }
      await this.saveOperation(client, identity, key, 'ingestContribution', hash, contributionId);
      return this.ingestResult(client, identity, contributionId, 'accepted');
    });
  }

  private async evidenceRows(
    client: TransactionClient,
    ctx: PrincipalContext,
    refs: readonly SchemaTypes['EvidenceRef'][],
  ): Promise<EvidenceRow[]> {
    if (!refs.length) return [];
    const result = await client.query<EvidenceRow>(
      `WITH allowed AS (${allowedScopesSql}), requested AS (
         SELECT DISTINCT id,revision,locator FROM jsonb_to_recordset($5::jsonb) AS ref(id uuid,revision bigint,locator text))
       SELECT e.* FROM requested ref JOIN akb.evidence e ON e.tenant_id=$1 AND e.id=ref.id AND e.revision=ref.revision AND e.locator=ref.locator
       JOIN allowed ON allowed.id=e.scope_id WHERE e.status='available' AND e.expires_at>now()`,
      [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'evidence:read', JSON.stringify(refs)],
    );
    if (result.rows.length !== new Set(refs.map(canonicalJson)).size) throw new AccessDeniedError();
    return result.rows;
  }

  private async mappings(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
  ): Promise<SchemaTypes['EvidenceMapping'][]> {
    const result = await client.query<{
      client_evidence_id: string;
      id: string;
      revision: string;
      locator: string;
    }>(
      `WITH allowed AS (${allowedScopesSql}) SELECT m.client_evidence_id,e.id,e.revision,e.locator
       FROM akb.contribution_evidence m JOIN akb.evidence e ON e.tenant_id=m.tenant_id AND e.id=m.evidence_id AND e.revision=m.evidence_revision
       JOIN allowed ON allowed.id=e.scope_id WHERE m.tenant_id=$1 AND m.contribution_id=$5 AND e.status='available' AND e.expires_at>now()
       ORDER BY m.client_evidence_id`,
      [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'evidence:read', id],
    );
    return result.rows.map((row) => ({
      client_evidence_id: row.client_evidence_id,
      evidence_ref: { id: row.id, revision: Number(row.revision), locator: row.locator },
    }));
  }

  private async contributionRow(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
  ): Promise<ContributionRow> {
    const result = await client.query<ContributionRow>(
      `WITH allowed AS (${allowedScopesSql}) SELECT c.* FROM akb.contributions c
       JOIN akb.scopes s ON s.tenant_id=c.tenant_id AND s.repo_id=c.repo_id AND s.kind='repo'
       JOIN allowed ON allowed.id=s.id WHERE c.tenant_id=$1 AND c.actor_id=$2 AND c.id=$5`,
      [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'knowledge:contribute', id],
    );
    if (!result.rows[0]) throw new AccessDeniedError();
    return result.rows[0];
  }

  private async ingestResult(
    client: TransactionClient,
    ctx: PrincipalContext,
    id: string,
    result: 'accepted' | 'duplicate',
  ): Promise<SchemaTypes['IngestResult']> {
    const row = await this.contributionRow(client, ctx, id);
    const data = {
      contribution_id: id,
      result,
      processing_status: row.processing_status,
      evidence_mappings: await this.mappings(client, ctx, id),
    };
    assertSchema('IngestResult', data);
    return data;
  }

  async get(ctx: PrincipalContext, id: string): Promise<SchemaTypes['Contribution']> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const row = await this.contributionRow(client, identity, id);
      const allowed = await allowedScopesInTransaction(client, identity, 'knowledge:contribute');
      const candidates = await client.query<{
        id: string;
        revision: string;
        scope_id: string;
        body: SchemaTypes['CandidateBody'];
        created_at: Date;
      }>(
        'SELECT id,revision,scope_id,body,created_at FROM akb.candidates WHERE tenant_id=$1 AND contribution_id=$2 ORDER BY created_at,id',
        [identity.tenantId, id],
      );
      const visible: SchemaTypes['Candidate'][] = [];
      for (const candidate of candidates.rows) {
        if (!allowed.has(candidate.scope_id)) continue;
        try {
          const row = await findCandidate(client, identity, candidate.id, 'knowledge:contribute');
          visible.push(
            (await hydrateCandidate(client, identity, row, this.store, 'knowledge:contribute'))
              .candidate,
          );
        } catch (error) {
          if (error instanceof AccessDeniedError) continue;
          throw error;
        }
      }
      const jobs = await client.query<{ id: string }>(
        `SELECT id FROM akb.jobs WHERE tenant_id=$1 AND kind='human_assessment' AND dedupe_key=$2 ORDER BY id`,
        [identity.tenantId, id],
      );
      const data: SchemaTypes['Contribution'] = {
        id,
        revision: Number(row.revision),
        processing_status: row.processing_status,
        route_counts: {
          index_only: 0,
          link_existing: 0,
          knowledge_candidate: 0,
          needs_confirmation: 0,
          discard: 0,
        },
        candidates: visible,
        published_ids: [],
        job_ids: jobs.rows.map((job) => job.id),
        evidence_mappings: await this.mappings(client, identity, id),
      };
      const counts = await client.query<{ disposition: SchemaTypes['Disposition']; count: string }>(
        `SELECT a.disposition,count(*) FROM akb.candidates c JOIN akb.assessments a ON a.tenant_id=c.tenant_id AND a.candidate_id=c.id AND a.candidate_revision=c.revision
         WHERE c.tenant_id=$1 AND c.contribution_id=$2 GROUP BY a.disposition`,
        [identity.tenantId, id],
      );
      for (const count of counts.rows) data.route_counts[count.disposition] = Number(count.count);
      assertSchema('Contribution', data);
      return data;
    });
  }

  async getEvidence(
    ctx: PrincipalContext,
    id: string,
    revision: number,
  ): Promise<SchemaTypes['Evidence']> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const result = await client.query<EvidenceRow>(
        `WITH allowed AS (${allowedScopesSql}) SELECT e.* FROM akb.evidence e JOIN allowed ON allowed.id=e.scope_id
         WHERE e.tenant_id=$1 AND e.id=$5 AND e.revision=$6 AND e.status='available' AND e.expires_at>now()`,
        [identity.tenantId, identity.actorId, identity.authzVersion, 'evidence:read', id, revision],
      );
      const row = result.rows[0];
      if (!row) throw new AccessDeniedError();
      const content = await this.store.read(identity.tenantId, row.object_key, row.sha256);
      // Recheck after file I/O so revocation during a slow storage read is not ignored.
      await this.evidenceRows(client, identity, [{ id, revision, locator: row.locator }]);
      const data: SchemaTypes['Evidence'] = {
        id,
        revision,
        source_ref: row.source_ref,
        source_revision: row.source_revision,
        locator: row.locator,
        content,
        sha256: row.sha256,
        expires_at: row.expires_at.toISOString(),
        evidence_kind: row.evidence_kind,
        status: 'available',
      };
      assertSchema('Evidence', data);
      return data;
    });
  }

  async list(
    ctx: PrincipalContext,
    options: { cursor?: string; limit?: number; scope_id?: string } = {},
  ): Promise<SchemaTypes['ContributionPage']> {
    const identity = { ...ctx };
    const { scope_id: scope, limit = 20, cursor } = { ...options };
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalidInput('Invalid page limit');
    const position = cursor ? this.cursor.decode(identity, scope, cursor) : undefined;
    const rows = await withPrincipalTransaction(this.pool, identity, async (client) => {
      if (
        scope &&
        !(await allowedScopesInTransaction(client, identity, 'knowledge:contribute')).has(scope)
      )
        return [];
      const result = await client.query<{ id: string; date: string }>(
        `WITH allowed AS (${allowedScopesSql}) SELECT c.id,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date
         FROM akb.contributions c JOIN akb.scopes s ON s.tenant_id=c.tenant_id AND s.kind='repo' AND s.repo_id=c.repo_id
         JOIN allowed ON allowed.id=s.id
         WHERE c.tenant_id=$1 AND c.actor_id=$2 AND ($5::uuid IS NULL OR s.id=$5 OR EXISTS(
           SELECT 1 FROM akb.scopes f JOIN akb.repos r ON r.tenant_id=f.tenant_id AND r.id=c.repo_id
           WHERE f.tenant_id=$1 AND f.id=$5 AND (f.kind='team' OR (f.kind='domain' AND f.domain_id=r.domain_id))))
         AND ($6::timestamptz IS NULL OR (c.created_at,c.id)<($6::timestamptz,$7::uuid))
         ORDER BY c.created_at DESC,c.id DESC LIMIT $8`,
        [
          identity.tenantId,
          identity.actorId,
          identity.authzVersion,
          'knowledge:contribute',
          scope ?? null,
          position?.date ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      return result.rows;
    });
    const page = rows.slice(0, limit);
    const items: SchemaTypes['Contribution'][] = [];
    for (const row of page) {
      try {
        items.push(await this.get(identity, row.id));
      } catch (error) {
        if (!(error instanceof AccessDeniedError)) throw error;
      }
    }
    const last = page.at(-1);
    const data = {
      items,
      next_cursor: rows.length > limit && last ? this.cursor.encode(identity, scope, last) : '',
    };
    assertSchema('ContributionPage', data);
    return data;
  }
}
