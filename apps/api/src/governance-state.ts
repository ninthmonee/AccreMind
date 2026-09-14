import { randomUUID } from 'node:crypto';
import { assertSchema } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { allowedScopesInTransaction, allowedScopesSql } from './authorization.js';
import { AccessDeniedError } from './database.js';
import type { TransactionClient } from './database.js';
import { ContributionError, conflict, invalidInput } from './contribution-errors.js';
import { canonicalJson, assertSelectedInputSafe } from './contribution-input.js';
import { findCandidate } from './candidate-state.js';
import type { CandidateRow } from './candidate-state.js';

export function governanceInput<T>(name: keyof SchemaTypes, value: unknown): T {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json) > 256 * 1024)
    throw new ContributionError('PAYLOAD_TOO_LARGE', 413, 'Mutation exceeds 256KB');
  try {
    assertSchema(name, value);
  } catch {
    invalidInput('Mutation does not match contract');
  }
  const result = JSON.parse(json) as T;
  assertSelectedInputSafe(result);
  return result;
}
export function blocked(message: string): never {
  throw new ContributionError('PUBLICATION_BLOCKED', 422, message);
}
export function stale(message: string): never {
  throw new ContributionError('REVISION_CONFLICT', 409, message);
}

export async function operation(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  route: string,
  hash: string,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${ctx.tenantId}:operation:${id}`,
  ]);
  const result = await client.query<{
    actor_id: string;
    route: string;
    payload_hash: string;
    response: unknown;
  }>(
    'SELECT actor_id,route,payload_hash,response FROM akb.operations WHERE tenant_id=$1 AND id=$2',
    [ctx.tenantId, id],
  );
  const row = result.rows[0];
  if (row && (row.actor_id !== ctx.actorId || row.route !== route || row.payload_hash !== hash))
    conflict();
  return row;
}
export async function finish(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  route: string,
  hash: string,
  response: unknown,
) {
  await client.query(
    `INSERT INTO akb.operations(tenant_id,id,actor_id,route,payload_hash,status,response,expires_at)
    VALUES($1,$2,$3,$4,$5,'completed',$6::jsonb,now()+interval '8 days')`,
    [ctx.tenantId, id, ctx.actorId, route, hash, JSON.stringify(response)],
  );
}
export type KnowledgeRow = {
  id: string;
  scope_id: string;
  owner_id: string;
  revision: string;
  active_content_revision: string;
  publication_status: SchemaTypes['Publication'];
  serving_status: SchemaTypes['Serving'];
};
export async function knowledge(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  capability: string,
  lock = false,
) {
  const result = await client.query<KnowledgeRow>(
    `WITH allowed AS (${allowedScopesSql}) SELECT k.* FROM akb.knowledge_entries k JOIN allowed ON allowed.id=k.scope_id WHERE k.tenant_id=$1 AND k.id=$5 ${lock ? 'FOR UPDATE OF k' : ''}`,
    [ctx.tenantId, ctx.actorId, ctx.authzVersion, capability, id],
  );
  if (!result.rows[0]) throw new AccessDeniedError();
  return result.rows[0];
}
/** Global order: target -> contribution -> candidate. B05 must use the same order. */
export async function lockCandidate(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  capability: string,
): Promise<CandidateRow> {
  const row = await findCandidate(client, ctx, id, capability);
  if (row.target_knowledge_id)
    await knowledge(client, ctx, row.target_knowledge_id, capability, true);
  await client.query('SELECT id FROM akb.contributions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    ctx.tenantId,
    row.contribution_id,
  ]);
  return findCandidate(client, ctx, id, capability, true);
}
export async function assertCapability(
  client: TransactionClient,
  ctx: PrincipalContext,
  scope: string,
  capability: string,
) {
  if (!(await allowedScopesInTransaction(client, ctx, capability)).has(scope))
    throw new AccessDeniedError();
}
export async function audit(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  revision: number,
  action: string,
  request: string,
) {
  await client.query(
    `INSERT INTO akb.audit(tenant_id,id,actor_id,action,object_id,object_revision,reason,request_id) VALUES($1,$2,$3,$4,$5,$6,'Explicit governance mutation',$7)`,
    [ctx.tenantId, randomUUID(), ctx.actorId, action, id, revision, request],
  );
}
export async function aggregate(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  key: string,
) {
  const result = await client.query<{ status: string }>(
    `SELECT CASE
    WHEN bool_or(c.publication_status='candidate') THEN 'waiting_confirmation'
    WHEN bool_or(c.publication_status='in_review') THEN 'waiting_review' ELSE 'completed' END status
    FROM akb.candidates c WHERE tenant_id=$1 AND contribution_id=$2`,
    [ctx.tenantId, id],
  );
  const status = result.rows[0]!.status;
  const updated = await client.query<{ revision: string }>(
    'UPDATE akb.contributions SET revision=revision+1,processing_status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING revision',
    [ctx.tenantId, id, status],
  );
  await client.query(
    `INSERT INTO akb.outbox(tenant_id,id,event_key,event_type,aggregate_id,aggregate_revision,payload) VALUES($1,$2,$3,'contribution.governed',$4,$5,$6::jsonb)`,
    [
      ctx.tenantId,
      randomUUID(),
      `governance:${key}`,
      id,
      updated.rows[0]!.revision,
      JSON.stringify({ contribution_id: id, processing_status: status }),
    ],
  );
}
export const sameScope = (a: SchemaTypes['Scope'], b: SchemaTypes['Scope']) =>
  canonicalJson(a) === canonicalJson(b);
