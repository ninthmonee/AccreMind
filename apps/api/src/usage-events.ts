import { randomUUID } from 'node:crypto';
import type { PrincipalContext } from '@accremind/domain';
import type { TransactionClient } from './database.js';
import { sha256 } from './evidence-store.js';

/** Internal server events only. Identity binds a logical return or validation decision, never a retry. */
export async function serverUsage(
  client: TransactionClient,
  ctx: PrincipalContext,
  task: string,
  id: string,
  revision: number,
  type: 'retrieved' | 'validation_submitted' | 'validation_accepted',
  key: string,
) {
  const digest = sha256(`${type}:${key}:${id}:${revision}`);
  const event = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  await client.query(
    `INSERT INTO akb.usage_events(tenant_id,id,event_id,actor_id,task_id,knowledge_id,knowledge_revision,event_type,used_in,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,actor_id,event_id) DO NOTHING`,
    [
      ctx.tenantId,
      randomUUID(),
      event,
      ctx.actorId,
      task,
      id,
      revision,
      type,
      `${type}:${key}`,
      digest,
    ],
  );
}
