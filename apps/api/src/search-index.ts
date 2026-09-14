import { randomUUID } from 'node:crypto';
import type { TransactionClient, TransactionPool } from './database.js';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import { knowledge } from './governance-state.js';
import { allowedScopesSql } from './authorization.js';
import type { PrincipalContext } from '@accremind/domain';
import type { ContentStore } from './content-store.js';
import type { SchemaTypes } from '@accremind/contracts';
import { assertSchema } from '@accremind/contracts';
import { keywords, indexVersion } from './retrieval-rules.js';
import { tenantTransaction } from './database.js';

export async function enqueueIndex(
  client: TransactionClient,
  tenant: string,
  actor: string,
  scope: string,
  id: string,
  revision: number,
) {
  await client.query(
    `INSERT INTO akb.jobs(tenant_id,id,actor_id,scope_id,kind,dedupe_key,status,payload) VALUES($1,$2,$3,$4,'search_index',$5,'queued',$6::jsonb) ON CONFLICT(tenant_id,kind,dedupe_key) DO NOTHING`,
    [tenant, randomUUID(), actor, scope, `${id}:${revision}`, JSON.stringify({ knowledge_id: id })],
  );
}
type IndexJob = {
  id: string;
  actor_id: string;
  scope_id: string;
  generation: string;
  attempts: number;
  payload: { knowledge_id: string };
};
/** Index is replaceable derived state. It never makes a stale body serveable. */
export class SearchIndexWorker {
  private readonly owner = randomUUID();
  constructor(
    private readonly pool: TransactionPool,
    private readonly content: ContentStore,
  ) {}
  async rebuild(ctx: PrincipalContext): Promise<number> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, async (client) => {
      const rows = await client.query<{ id: string; scope_id: string }>(
        `WITH allowed AS (${allowedScopesSql}) SELECT k.id,k.scope_id FROM akb.knowledge_entries k JOIN allowed ON allowed.id=k.scope_id WHERE k.tenant_id=$1`,
        [identity.tenantId, identity.actorId, identity.authzVersion, 'knowledge:publish'],
      );
      for (const row of rows.rows) {
        await client.query(
          `UPDATE akb.publications p SET index_status='pending',result=result||'{"index_status":"pending"}'::jsonb WHERE p.tenant_id=$1 AND p.knowledge_id=$2 AND p.status='published' AND EXISTS(SELECT 1 FROM akb.knowledge_entries k JOIN akb.knowledge_revisions r ON r.tenant_id=k.tenant_id AND r.knowledge_id=k.id AND r.revision=k.active_content_revision WHERE k.tenant_id=p.tenant_id AND k.id=p.knowledge_id AND r.review_id=p.review_id)`,
          [identity.tenantId, row.id],
        );
        await client.query(
          `INSERT INTO akb.jobs(tenant_id,id,actor_id,scope_id,kind,dedupe_key,status,payload) VALUES($1,$2,$3,$4,'search_index',$5,'queued',$6::jsonb)`,
          [
            identity.tenantId,
            randomUUID(),
            identity.actorId,
            row.scope_id,
            `rebuild:${row.id}:${randomUUID()}`,
            JSON.stringify({ knowledge_id: row.id }),
          ],
        );
      }
      return rows.rows.length;
    });
  }
  async runOnce(tenant: string): Promise<boolean> {
    const job = await tenantTransaction(this.pool, tenant, async (client) => {
      const result = await client.query<IndexJob>(
        `WITH next AS (SELECT id FROM akb.jobs WHERE tenant_id=$1 AND kind='search_index' AND ((status='queued' AND next_run_at<=now()) OR (status='running' AND lease_until<now())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE akb.jobs j SET status='running',generation=generation+1,attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '60 seconds' FROM next WHERE j.tenant_id=$1 AND j.id=next.id RETURNING j.*`,
        [tenant, this.owner],
      );
      return result.rows[0];
    });
    if (!job) return false;
    try {
      if (job.attempts > 3) throw new Error('Index retry budget exhausted');
      const prepared = await tenantTransaction(this.pool, tenant, async (client) => {
        const actor = await client.query<{ authz_version: string }>(
          'SELECT authz_version FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND active',
          [tenant, job.actor_id],
        );
        if (!actor.rows[0]) throw new AccessDeniedError();
        const ctx = {
          tenantId: tenant,
          actorId: job.actor_id,
          authzVersion: Number(actor.rows[0].authz_version),
        };
        const k = await knowledge(client, ctx, job.payload.knowledge_id, 'knowledge:read');
        if (k.scope_id !== job.scope_id) throw new AccessDeniedError();
        const revision = await client.query<{ content_ref: string; content_hash: string }>(
          'SELECT content_ref,content_hash FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2 AND revision=$3',
          [tenant, k.id, k.active_content_revision],
        );
        if (!revision.rows[0]) throw new AccessDeniedError();
        return { ctx, k, revision: revision.rows[0] };
      });
      const active =
        prepared.k.publication_status === 'published' && prepared.k.serving_status === 'enabled';
      let body: SchemaTypes['CandidateBody'] | undefined;
      if (active) {
        const content = JSON.parse(
          await this.content.read(
            tenant,
            prepared.revision.content_ref,
            prepared.revision.content_hash,
          ),
        ) as { body: SchemaTypes['CandidateBody'] };
        assertSchema('CandidateBody', content.body);
        body = content.body;
      }
      await withPrincipalTransaction(this.pool, prepared.ctx, async (client) => {
        const k = await knowledge(client, prepared.ctx, prepared.k.id, 'knowledge:read', true);
        if (
          k.revision !== prepared.k.revision ||
          k.active_content_revision !== prepared.k.active_content_revision
        )
          throw new Error('Index version changed');
        const fenced = await client.query(
          `SELECT id FROM akb.jobs WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND lease_owner=$4 AND lease_until>now() AND status='running' FOR UPDATE`,
          [tenant, job.id, job.generation, this.owner],
        );
        if (fenced.rowCount !== 1) throw new Error('Index lease changed');
        if (body && k.publication_status === 'published' && k.serving_status === 'enabled') {
          const title = keywords(body.title).join(' '),
            claim = keywords(body.claim).join(' '),
            context = keywords(
              JSON.stringify({ context: body.context, rationale: body.rationale }),
            ).join(' ');
          await client.query(
            `INSERT INTO akb.search_documents(tenant_id,knowledge_id,knowledge_revision,scope_id,title,segmented_text,lexemes,index_version) VALUES($1,$2,$3,$4,$5,$6,
      setweight(to_tsvector('simple',$7),'A')||setweight(to_tsvector('simple',$8),'B')||setweight(to_tsvector('simple',$9),'C'),$10)
      ON CONFLICT(tenant_id,knowledge_id) DO UPDATE SET knowledge_revision=excluded.knowledge_revision,scope_id=excluded.scope_id,title=excluded.title,segmented_text=excluded.segmented_text,lexemes=excluded.lexemes,index_version=excluded.index_version,updated_at=now()`,
            [
              tenant,
              k.id,
              k.active_content_revision,
              k.scope_id,
              body.title,
              [title, claim, context].join(' '),
              title,
              claim,
              context,
              indexVersion,
            ],
          );
          await client.query(
            `UPDATE akb.publications SET index_status='ready',result=result||'{"index_status":"ready"}'::jsonb WHERE tenant_id=$1 AND knowledge_id=$2 AND status='published' AND candidate_id IN (SELECT candidate_id FROM akb.knowledge_revisions WHERE tenant_id=$1 AND knowledge_id=$2 AND revision=$3)`,
            [tenant, k.id, k.active_content_revision],
          );
        } else
          await client.query(
            'DELETE FROM akb.search_documents WHERE tenant_id=$1 AND knowledge_id=$2',
            [tenant, k.id],
          );
        await client.query(
          "UPDATE akb.jobs SET status='succeeded',lease_owner=NULL,lease_until=NULL WHERE tenant_id=$1 AND id=$2",
          [tenant, job.id],
        );
        await client.query(
          "UPDATE akb.outbox SET delivered_at=now() WHERE tenant_id=$1 AND aggregate_id=$2 AND aggregate_revision<=$3 AND event_type IN ('knowledge.published','knowledge.suspend','knowledge.withdraw','knowledge.archive')",
          [tenant, k.id, k.revision],
        );
      });
    } catch (error) {
      await tenantTransaction(this.pool, tenant, async (client) => {
        const terminal = error instanceof AccessDeniedError || job.attempts >= 3;
        const changed = await client.query(
          `UPDATE akb.jobs SET status=$5,lease_owner=NULL,lease_until=NULL,next_run_at=now()+interval '5 seconds',last_error_code='TEMPORARILY_UNAVAILABLE' WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND lease_owner=$4 AND status='running'`,
          [tenant, job.id, job.generation, this.owner, terminal ? 'failed' : 'queued'],
        );
        if (changed.rowCount === 1 && terminal)
          await client.query(
            `UPDATE akb.publications SET index_status='failed',result=result||'{"index_status":"failed"}'::jsonb WHERE tenant_id=$1 AND knowledge_id=$2 AND status='published' AND index_status='pending'`,
            [tenant, job.payload.knowledge_id],
          );
      });
    }
    return true;
  }
}
