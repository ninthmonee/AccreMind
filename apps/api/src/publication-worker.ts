import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SchemaTypes } from '@accremind/contracts';
import { assertSchema } from '@accremind/contracts';
import { AccessDeniedError, tenantTransaction, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import type { EvidenceStore } from './evidence-store.js';
import { sha256 } from './evidence-store.js';
import type { ContentStore } from './content-store.js';
import { aggregate, assertCapability, audit, lockCandidate, stale } from './governance-state.js';
import { publicationGate } from './governance.js';
import type { PublicationRow } from './governance.js';
import { enqueueIndex } from './search-index.js';
import { evidenceMetadata } from './assessment-evidence.js';
import { canonicalJson } from './contribution-input.js';
import { ContributionError } from './contribution-errors.js';

type Lease = {
  id: string;
  dedupe_key: string;
  generation: string;
  attempts: number;
  actor_id: string;
  scope_id: string;
};
/** Worker operates on an operator-selected tenant, never discovers all tenants with elevated SQL. */
export class PublicationWorker {
  private readonly owner = randomUUID();
  constructor(
    private readonly pool: TransactionPool,
    private readonly evidence: EvidenceStore,
    private readonly content: ContentStore,
  ) {}
  async runOnce(tenant: string): Promise<boolean> {
    const lease = await tenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<Lease>(
        `WITH next AS (SELECT id FROM akb.jobs WHERE tenant_id=$1 AND kind='publication'
        AND ((status='queued' AND next_run_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE akb.jobs j SET status='running',attempts=attempts+1,generation=generation+1,lease_owner=$2,lease_until=now()+interval '60 seconds'
        FROM next WHERE j.tenant_id=$1 AND j.id=next.id RETURNING j.*`,
        [tenant, this.owner],
      );
      return result.rows[0];
    });
    if (!lease) return false;
    const abort = new AbortController();
    let renewal: Promise<unknown> = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal
        .then(async () => {
          const result = await tenantTransaction(this.pool, tenant, (client) =>
            client.query(
              `UPDATE akb.jobs SET lease_until=now()+interval '60 seconds' WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND lease_owner=$4 AND status='running' AND lease_until>now()`,
              [tenant, lease.id, lease.generation, this.owner],
            ),
          );
          if (result.rowCount !== 1) abort.abort();
        })
        .catch(() => {
          abort.abort();
        });
    }, 20000);
    let session: TransactionClient | undefined;
    let lock = false;
    let sessionDiscard = false;
    const lost = () => {
      sessionDiscard = true;
      abort.abort();
    };
    try {
      const prepared = await tenantTransaction(this.pool, tenant, async (client) => {
        const result = await client.query<PublicationRow>(
          'SELECT * FROM akb.publications WHERE tenant_id=$1 AND id=$2',
          [tenant, lease.dedupe_key],
        );
        if (!result.rows[0]) throw new AccessDeniedError();
        return result.rows[0];
      });
      const ctx = {
        tenantId: tenant,
        actorId: prepared.actor_id,
        authzVersion: Number(prepared.authz_version),
      };
      if (lease.attempts > 3 || lease.actor_id !== prepared.actor_id)
        stale('Publication lease budget or actor binding differs');
      const frozen = await withPrincipalTransaction(this.pool, ctx, async (client) => {
        const row = await lockCandidate(client, ctx, prepared.candidate_id, 'knowledge:publish');
        if (
          row.revision !== prepared.candidate_revision ||
          prepared.status !== 'pending' ||
          row.scope_id !== lease.scope_id ||
          row.target_knowledge_id !== prepared.target_knowledge_id ||
          row.base_content_revision !== prepared.base_content_revision ||
          row.base_aggregate_revision !== prepared.expected_target_revision
        )
          stale('Publication binding changed');
        const state = await publicationGate(client, ctx, row, this.evidence, prepared.review_id);
        return canonicalJson({
          body: row.body,
          assessment: state.assessment!.assessment,
          assessment_id: state.assessment!.id,
          assessment_revision: state.assessment!.revision,
          source_refs: state.refs,
        });
      });
      session = await this.pool.connect();
      (session as pg.PoolClient).on('error', lost);
      await session.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        `${tenant}:git-publications`,
      ]);
      lock = true;
      if (abort.signal.aborted) throw new Error('Lease lost');
      const ref = await this.content.write(tenant, prepared.id, frozen, abort.signal);
      if (abort.signal.aborted) throw new Error('Lease lost');
      // SQL CAS, generation and authorization are rechecked after the external Git write.
      await withPrincipalTransaction(this.pool, ctx, async (client) => {
        const row = await lockCandidate(client, ctx, prepared.candidate_id, 'knowledge:publish');
        const job = await client.query(
          `SELECT id FROM akb.jobs WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND lease_owner=$4 AND status='running' AND lease_until>now() FOR UPDATE`,
          [tenant, lease.id, lease.generation, this.owner],
        );
        if (job.rowCount !== 1 || abort.signal.aborted) stale('Worker lease changed');
        const publication = await client.query<PublicationRow>(
          'SELECT * FROM akb.publications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenant, prepared.id],
        );
        if (
          publication.rows[0]?.status !== 'pending' ||
          row.revision !== prepared.candidate_revision
        )
          stale('Publication changed');
        const state = await publicationGate(client, ctx, row, this.evidence, prepared.review_id);
        const current = canonicalJson({
          body: row.body,
          assessment: state.assessment!.assessment,
          assessment_id: state.assessment!.id,
          assessment_revision: state.assessment!.revision,
          source_refs: state.refs,
        });
        if (current !== frozen) stale('Content changed after Git');
        const knowledgeId = row.target_knowledge_id ?? randomUUID();
        const contentRevision = row.target_knowledge_id ? Number(row.base_content_revision) + 1 : 1;
        const aggregateRevision = row.target_knowledge_id
          ? Number(row.base_aggregate_revision) + 1
          : 1;
        if (!row.target_knowledge_id)
          await client.query(
            `INSERT INTO akb.knowledge_entries(tenant_id,id,scope_id,owner_id,publication_status) VALUES($1,$2,$3,$4,'in_review')`,
            [tenant, knowledgeId, row.scope_id, row.owner_id],
          );
        await client.query(
          `INSERT INTO akb.knowledge_revisions(tenant_id,knowledge_id,revision,candidate_id,candidate_revision,review_id,content_ref,content_hash,maturity,freshness) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft','unknown')`,
          [
            tenant,
            knowledgeId,
            contentRevision,
            row.id,
            row.revision,
            prepared.review_id,
            ref,
            sha256(frozen),
          ],
        );
        const updated = await client.query(
          `UPDATE akb.knowledge_entries SET active_content_revision=$3,revision=$4,owner_id=$5,publication_status='published',serving_status='enabled',maturity='draft',freshness='unknown' WHERE tenant_id=$1 AND id=$2 AND revision=$6`,
          [
            tenant,
            knowledgeId,
            contentRevision,
            aggregateRevision,
            row.owner_id,
            row.target_knowledge_id ? row.base_aggregate_revision : 1,
          ],
        );
        if (updated.rowCount !== 1) stale('Target CAS failed');
        const result: SchemaTypes['PublishResult'] = {
          publication_id: prepared.id,
          status: 'published',
          knowledge_id: knowledgeId,
          knowledge_revision: contentRevision,
          aggregate_revision: aggregateRevision,
          index_status: 'pending',
        };
        assertSchema('PublishResult', result);
        await client.query(
          `UPDATE akb.publications SET status='published',knowledge_id=$3,content_ref=$4,result=$5::jsonb WHERE tenant_id=$1 AND id=$2`,
          [tenant, prepared.id, knowledgeId, ref, JSON.stringify(result)],
        );
        await client.query(
          "UPDATE akb.candidates SET publication_status='published' WHERE tenant_id=$1 AND id=$2",
          [tenant, row.id],
        );
        await client.query(
          "UPDATE akb.jobs SET status='succeeded',checkpoint=$3::jsonb,lease_owner=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, lease.id, JSON.stringify({ content_ref: ref, knowledge_id: knowledgeId })],
        );
        await client.query(
          `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload) VALUES($1,$2,$3,'knowledge.published',$4,$5,$6::jsonb)`,
          [
            tenant,
            randomUUID(),
            `publication:${prepared.id}`,
            knowledgeId,
            aggregateRevision,
            JSON.stringify({
              knowledge_id: knowledgeId,
              knowledge_revision: contentRevision,
              index_status: 'pending',
            }),
          ],
        );
        await enqueueIndex(
          client,
          tenant,
          ctx.actorId,
          row.scope_id,
          knowledgeId,
          aggregateRevision,
        );
        await aggregate(client, ctx, row.contribution_id, prepared.id);
        await audit(
          client,
          ctx,
          knowledgeId,
          aggregateRevision,
          'knowledge.published',
          prepared.operation_id,
        );
        // Prevent revocation during the last I/O window from authorizing activation.
        await assertCapability(client, ctx, row.scope_id, 'knowledge:publish');
        await evidenceMetadata(client, ctx, state.refs);
        const reviewer = await client.query<{ authz_version: string }>(
          'SELECT authz_version FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
          [tenant, state.review!.reviewer_id],
        );
        if (!reviewer.rows[0]) throw new AccessDeniedError();
        const reviewerCtx = {
          ...ctx,
          actorId: state.review!.reviewer_id,
          authzVersion: Number(reviewer.rows[0].authz_version),
        };
        await assertCapability(client, reviewerCtx, row.scope_id, 'knowledge:review');
        await evidenceMetadata(client, reviewerCtx, state.refs);
      });
    } catch (error) {
      const permanent = error instanceof AccessDeniedError || error instanceof ContributionError;
      const terminal = permanent || lease.attempts >= 3;
      await tenantTransaction(this.pool, tenant, async (client) => {
        const changed = await client.query(
          `UPDATE akb.jobs SET status=$5,last_error_code=$6,lease_owner=NULL,lease_until=NULL,next_run_at=now()+interval '5 seconds' WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND lease_owner=$4 AND status='running'`,
          [
            tenant,
            lease.id,
            lease.generation,
            this.owner,
            terminal ? 'failed' : 'queued',
            permanent ? 'PUBLICATION_BLOCKED' : 'TEMPORARILY_UNAVAILABLE',
          ],
        );
        if (changed.rowCount === 1 && terminal)
          await client.query(
            `UPDATE akb.publications SET status='failed',result=jsonb_build_object('publication_id',id,'status','failed') WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
            [tenant, lease.dedupe_key],
          );
      });
    } finally {
      clearInterval(timer);
      await renewal;
      if (session) {
        (session as pg.PoolClient).removeListener('error', lost);
        if (lock && !sessionDiscard) {
          try {
            await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
              `${tenant}:git-publications`,
            ]);
          } catch {
            sessionDiscard = true;
          }
        }
        session.release(sessionDiscard);
      }
    }
    return true;
  }
}
