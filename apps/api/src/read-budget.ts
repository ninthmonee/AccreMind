import { randomUUID } from 'node:crypto';
import type { SchemaTypes } from '@accremind/contracts';
import type { PrincipalContext } from '@accremind/domain';
import { AccessDeniedError, withPrincipalTransaction } from './database.js';
import type { TransactionClient, TransactionPool } from './database.js';
import { ContributionError, conflict } from './contribution-errors.js';
import { operation } from './governance-state.js';
import { canonicalJson } from './contribution-input.js';
import { allowedScopesSql } from './authorization.js';
import { serverUsage } from './usage-events.js';

type TaskRow = {
  id: string;
  repo_id: string;
  limit_reads: number;
  used_reads: number;
  reserved_reads: number;
  environment: SchemaTypes['Environment'] | null;
  expires_at: Date;
};
type OpRow = {
  id: string;
  generation: string;
  status: string;
  response: SchemaTypes['SearchResult'] | SchemaTypes['ReadResult'] | null;
  reserved_until: Date | null;
  read_window_start: Date | null;
  budget_task_id: string;
};
export type Reservation = {
  generation: number;
  charged: boolean;
  queryId: string;
  task: TaskRow;
  replay?: SchemaTypes['SearchResult'] | SchemaTypes['ReadResult'];
};
export const taskBudget = (task: TaskRow, tokens = 0): SchemaTypes['Budget'] => ({
  limit: task.limit_reads,
  used: task.used_reads,
  reserved: task.reserved_reads,
  remaining: Math.max(0, task.limit_reads - task.used_reads - task.reserved_reads),
  returned_tokens: tokens,
});
async function actorLock(client: TransactionClient, ctx: PrincipalContext) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${ctx.tenantId}:read-budget:${ctx.actorId}`,
  ]);
}
export async function readTask(
  client: TransactionClient,
  ctx: PrincipalContext,
  id: string,
  repo?: string,
  lock = false,
) {
  const result = await client.query<TaskRow>(
    `WITH allowed AS (${allowedScopesSql}) SELECT t.* FROM akb.tasks t
  JOIN akb.scopes scope ON scope.tenant_id=t.tenant_id AND scope.repo_id=t.repo_id JOIN allowed ON allowed.id=scope.id
  WHERE t.tenant_id=$1 AND t.id=$5 AND t.principal_id=$2 AND t.expires_at>now() ${lock ? 'FOR UPDATE OF t' : ''}`,
    [ctx.tenantId, ctx.actorId, ctx.authzVersion, 'knowledge:read', id],
  );
  const task = result.rows[0];
  if (!task || (repo && repo !== task.repo_id)) throw new AccessDeniedError();
  return task;
}
/** Short durable reservations; Git/evidence reads are outside the task transaction. */
export class ReadBudgetService {
  constructor(private readonly pool: TransactionPool) {}
  async reserve(
    ctx: PrincipalContext,
    taskId: string,
    id: string,
    route: string,
    hash: string,
    repo?: string,
    environment?: SchemaTypes['Environment'],
  ): Promise<Reservation> {
    return withPrincipalTransaction(this.pool, ctx, async (client) => {
      await actorLock(client, ctx);
      await readTask(client, ctx, taskId, repo, true);
      // Reclaim timed-out operations for this verified principal. Fences prevent late completions.
      const expired = await client.query<OpRow>(
        `SELECT * FROM akb.operations WHERE tenant_id=$1 AND actor_id=$2 AND budget_task_id IS NOT NULL AND status='pending' AND reserved_until<now() FOR UPDATE`,
        [ctx.tenantId, ctx.actorId],
      );
      for (const op of expired.rows) {
        if (op.read_window_start) {
          await client.query(
            'UPDATE akb.tasks SET reserved_reads=reserved_reads-1 WHERE tenant_id=$1 AND id=$2 AND reserved_reads>0',
            [ctx.tenantId, op.budget_task_id],
          );
          await client.query(
            'UPDATE akb.read_windows SET reserved=reserved-1 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=$3 AND reserved>0',
            [ctx.tenantId, ctx.actorId, op.read_window_start],
          );
        }
        await client.query(
          "UPDATE akb.operations SET status='failed',error_code='TEMPORARILY_UNAVAILABLE',reserved_until=NULL WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, op.id],
        );
      }
      let task = await readTask(client, ctx, taskId, repo, true);
      if (environment) {
        if (task.environment && JSON.stringify(task.environment) !== JSON.stringify(environment)) {
          if (canonicalJson(task.environment) !== canonicalJson(environment))
            throw new ContributionError(
              'INVALID_INPUT',
              400,
              'Task environment is immutable; create a distinct task session for changed conditions',
            );
        }
        if (!task.environment) {
          await client.query(
            'UPDATE akb.tasks SET environment=$3::jsonb WHERE tenant_id=$1 AND id=$2',
            [ctx.tenantId, taskId, JSON.stringify(environment)],
          );
          task = { ...task, environment };
        }
      }
      const previous = await operation(client, ctx, id, route, hash);
      const saved = previous
        ? await client.query<OpRow>('SELECT * FROM akb.operations WHERE tenant_id=$1 AND id=$2', [
            ctx.tenantId,
            id,
          ])
        : undefined;
      const op = saved?.rows[0];
      if (op?.status === 'completed' && op.response)
        return {
          generation: Number(op.generation),
          charged: false,
          queryId: id,
          task,
          replay: op.response,
        };
      if (op?.status === 'pending')
        throw new ContributionError(
          'TEMPORARILY_UNAVAILABLE',
          503,
          'The logical read is already in progress',
        );
      const window = await client.query<{ window_start: Date; used: number; reserved: number }>(
        `INSERT INTO akb.read_windows(tenant_id,principal_id,window_start) VALUES($1,$2,date_trunc('hour',now())) ON CONFLICT(tenant_id,principal_id,window_start) DO UPDATE SET used=akb.read_windows.used RETURNING *`,
        [ctx.tenantId, ctx.actorId],
      );
      const current = window.rows[0]!;
      const charged =
        task.used_reads + task.reserved_reads < task.limit_reads &&
        current.used + current.reserved < 20;
      const generation = Number(op?.generation ?? 0) + 1;
      if (op)
        await client.query(
          `UPDATE akb.operations SET status='pending',generation=$3,budget_task_id=$4,reserved_until=now()+interval '60 seconds',read_window_start=$5,error_code='' WHERE tenant_id=$1 AND id=$2`,
          [ctx.tenantId, id, generation, taskId, charged ? current.window_start : null],
        );
      else
        await client.query(
          `INSERT INTO akb.operations(tenant_id,id,actor_id,route,payload_hash,status,generation,budget_task_id,reserved_until,read_window_start,expires_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,now()+interval '60 seconds',$8,now()+interval '8 days')`,
          [
            ctx.tenantId,
            id,
            ctx.actorId,
            route,
            hash,
            generation,
            taskId,
            charged ? current.window_start : null,
          ],
        );
      if (charged) {
        await client.query(
          'UPDATE akb.tasks SET reserved_reads=reserved_reads+1 WHERE tenant_id=$1 AND id=$2',
          [ctx.tenantId, taskId],
        );
        await client.query(
          'UPDATE akb.read_windows SET reserved=reserved+1 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=$3',
          [ctx.tenantId, ctx.actorId, current.window_start],
        );
        task = { ...task, reserved_reads: task.reserved_reads + 1 };
      }
      return { generation, charged, queryId: id, task };
    });
  }
  async complete<T extends SchemaTypes['SearchResult'] | SchemaTypes['ReadResult']>(
    ctx: PrincipalContext,
    taskId: string,
    id: string,
    reservation: Reservation,
    result: T,
    elapsed: number,
    validate: (client: TransactionClient) => Promise<void>,
  ): Promise<T> {
    return withPrincipalTransaction(this.pool, ctx, async (client) => {
      await actorLock(client, ctx);
      let task = await readTask(client, ctx, taskId, undefined, true);
      const saved = await client.query<OpRow>(
        `SELECT * FROM akb.operations WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND generation=$4 AND status='pending' AND reserved_until>now() FOR UPDATE`,
        [ctx.tenantId, id, ctx.actorId, reservation.generation],
      );
      const op = saved.rows[0];
      if (!op)
        throw new ContributionError(
          'TEMPORARILY_UNAVAILABLE',
          503,
          'Read reservation expired or changed',
        );
      await validate(client);
      const retrieved =
        'items' in result
          ? result.items.map((item) => ({ id: item.id, revision: item.revision }))
          : result.kind === 'complete'
            ? [{ id: result.item.id, revision: result.item.content_revision }]
            : [];
      for (const item of retrieved)
        await serverUsage(client, ctx, taskId, item.id, item.revision, 'retrieved', id);
      if (reservation.charged) {
        const updated = await client.query<TaskRow>(
          'UPDATE akb.tasks SET reserved_reads=reserved_reads-1,used_reads=used_reads+1 WHERE tenant_id=$1 AND id=$2 AND reserved_reads>0 RETURNING *',
          [ctx.tenantId, taskId],
        );
        if (!updated.rows[0]) conflict();
        task = updated.rows[0];
        await client.query(
          'UPDATE akb.read_windows SET reserved=reserved-1,used=used+1 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=$3 AND reserved>0',
          [ctx.tenantId, ctx.actorId, op.read_window_start],
        );
      }
      const response = { ...result, budget: taskBudget(task, result.budget.returned_tokens) };
      const window = await client.query<{ remaining: number }>(
        "SELECT greatest(0,20-used-reserved) remaining FROM akb.read_windows WHERE tenant_id=$1 AND principal_id=$2 AND window_start=date_trunc('hour',now())",
        [ctx.tenantId, ctx.actorId],
      );
      response.budget.remaining = Math.min(
        response.budget.remaining,
        window.rows[0]?.remaining ?? 20,
      );
      await client.query(
        "UPDATE akb.operations SET status='completed',response=$3::jsonb,reserved_until=NULL WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, id, JSON.stringify(response)],
      );
      await client.query(
        `INSERT INTO akb.retrieval_costs(tenant_id,id,operation_id,actor_id,generation,elapsed_ms,returned_tokens,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ctx.tenantId,
          randomUUID(),
          id,
          ctx.actorId,
          reservation.generation,
          Math.max(0, Math.round(elapsed)),
          response.budget.returned_tokens,
          'outcome' in result ? result.outcome : result.kind,
        ],
      );
      return response;
    });
  }
  /** Internal cleanup can release a reservation even if the actor was revoked during I/O. */
  async fail(ctx: PrincipalContext, id: string, generation: number, elapsed: number) {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('akb.tenant_id',$1,true)", [ctx.tenantId]);
      await actorLock(client, ctx);
      const saved = await client.query<OpRow>(
        `SELECT * FROM akb.operations WHERE tenant_id=$1 AND id=$2 AND actor_id=$3 AND generation=$4 AND status='pending' FOR UPDATE`,
        [ctx.tenantId, id, ctx.actorId, generation],
      );
      const op = saved.rows[0];
      if (op) {
        if (op.read_window_start) {
          await client.query(
            'UPDATE akb.tasks SET reserved_reads=reserved_reads-1 WHERE tenant_id=$1 AND id=$2 AND reserved_reads>0',
            [ctx.tenantId, op.budget_task_id],
          );
          await client.query(
            'UPDATE akb.read_windows SET reserved=reserved-1 WHERE tenant_id=$1 AND principal_id=$2 AND window_start=$3 AND reserved>0',
            [ctx.tenantId, ctx.actorId, op.read_window_start],
          );
        }
        await client.query(
          "UPDATE akb.operations SET status='failed',error_code='TEMPORARILY_UNAVAILABLE',reserved_until=NULL WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id],
        );
        await client.query(
          `INSERT INTO akb.retrieval_costs(tenant_id,id,operation_id,actor_id,generation,elapsed_ms,returned_tokens,outcome) VALUES($1,$2,$3,$4,$5,$6,0,'failed')`,
          [
            ctx.tenantId,
            randomUUID(),
            id,
            ctx.actorId,
            generation,
            Math.max(0, Math.round(elapsed)),
          ],
        );
      }
      await client.query('COMMIT');
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
}
