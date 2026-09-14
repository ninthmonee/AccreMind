import type { AuthorizationService, PrincipalContext } from '@accremind/domain';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';

/** Exact scope grants plus explicit ancestor grants; no implicit role escalation.
 * The principal check is repeated in the SQL statement to avoid stale ACL caches.
 * Scope filtering happens in PostgreSQL before any protected data is returned.
 */
export const allowedScopesSql = `
  SELECT DISTINCT target.id
  FROM akb.scopes target
  LEFT JOIN akb.repos repo
    ON repo.tenant_id = target.tenant_id AND repo.id = target.repo_id
  JOIN akb.grants g ON g.tenant_id = target.tenant_id
  JOIN akb.scopes granted
    ON granted.tenant_id = g.tenant_id AND granted.id = g.scope_id
  JOIN akb.principals principal
    ON principal.tenant_id = g.tenant_id AND principal.id = g.principal_id
  WHERE target.tenant_id = $1 AND principal.id = $2
    AND principal.active AND principal.authz_version = $3
    AND g.capability = $4 AND g.revoked_at IS NULL
    AND (granted.id = target.id OR granted.kind = 'team'
      OR (granted.kind = 'domain' AND
        (target.domain_id = granted.domain_id OR repo.domain_id = granted.domain_id)))`;

export async function allowedScopesInTransaction(
  client: TransactionClient,
  ctx: PrincipalContext,
  capability: string,
): Promise<ReadonlySet<string>> {
  const result = await client.query<{ id: string }>(allowedScopesSql, [
    ctx.tenantId,
    ctx.actorId,
    ctx.authzVersion,
    capability,
  ]);
  return new Set(result.rows.map((row) => row.id));
}

export class PostgresAuthorizationService implements AuthorizationService {
  constructor(private readonly pool: TransactionPool) {}

  allowedScopes(ctx: PrincipalContext, capability: string): Promise<ReadonlySet<string>> {
    const identity = { ...ctx };
    return withPrincipalTransaction(this.pool, identity, (client) =>
      allowedScopesInTransaction(client, identity, capability),
    );
  }

  async assertEvidenceReadable(
    ctx: PrincipalContext,
    refs: readonly SchemaTypes['EvidenceRef'][],
  ): Promise<void> {
    const identity = { ...ctx };
    // Validate and snapshot references, including exact evidence revisions.
    const references = refs.map((ref) => {
      assertSchema('EvidenceRef', ref);
      return { ...ref };
    });
    await withPrincipalTransaction(this.pool, identity, async (client) => {
      if (references.length === 0) return;
      // One statement checks current permissions and all refs at the same snapshot.
      const result = await client.query<{ readable: boolean }>(
        `WITH allowed AS (${allowedScopesSql}),
         requested AS (
           SELECT DISTINCT id, revision
           FROM jsonb_to_recordset($5::jsonb) AS ref(id uuid, revision bigint)
         )
         SELECT NOT EXISTS (
           SELECT 1 FROM requested ref WHERE NOT EXISTS (
             SELECT 1 FROM akb.evidence evidence
             JOIN allowed ON allowed.id = evidence.scope_id
             WHERE evidence.tenant_id = $1 AND evidence.id = ref.id
               AND evidence.revision = ref.revision AND evidence.status = 'available'
               AND evidence.expires_at > now()
           )
         ) AS readable`,
        [
          identity.tenantId,
          identity.actorId,
          identity.authzVersion,
          'evidence:read',
          JSON.stringify(references),
        ],
      );
      if (result.rows[0]?.readable !== true) throw new AccessDeniedError();
    });
  }
}
