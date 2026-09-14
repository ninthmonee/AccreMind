import pg from 'pg';
import type { PrincipalContext } from '@accremind/domain';

export function createDatabasePool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
  });
}

export class AccessDeniedError extends Error {
  readonly code = 'NOT_FOUND_OR_INACCESSIBLE';
  constructor() {
    super('Resource is unavailable');
    this.name = 'AccessDeniedError';
  }
}

export type TransactionClient = Pick<pg.PoolClient, 'query' | 'release'>;
export interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

/** Internal boundary: ctx must come from verified identity, NEVER request JSON or headers.
 * The current synthetic HTTP server does not expose this boundary to callers.
 * All callback queries must be awaited and use this client, not pool.query().
 */
export async function withPrincipalTransaction<T>(
  pool: TransactionPool,
  ctx: PrincipalContext,
  run: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !uuid.test(ctx.tenantId) ||
    !uuid.test(ctx.actorId) ||
    !Number.isSafeInteger(ctx.authzVersion) ||
    ctx.authzVersion < 1
  )
    throw new AccessDeniedError();
  // Snapshot identity so callers cannot mutate the context during an await.
  const { tenantId, actorId, authzVersion } = ctx;
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('akb.tenant_id', $1, true)", [tenantId]);
    const principal = await client.query(
      `SELECT id FROM akb.principals
       WHERE tenant_id = $1 AND id = $2 AND active AND authz_version = $3`,
      [tenantId, actorId, authzVersion],
    );
    if (principal.rowCount !== 1) throw new AccessDeniedError();
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    // Never return a connection with an uncertain transaction to the pool.
    client.release(discard);
  }
}

export async function tenantTransaction<T>(
  pool: TransactionPool,
  tenant: string,
  run: (client: TransactionClient) => Promise<T>,
) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tenant))
    throw new AccessDeniedError();
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('akb.tenant_id',$1,true)", [tenant]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
