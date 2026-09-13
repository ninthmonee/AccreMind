import assert from 'node:assert/strict';
import test from 'node:test';
import { AccessDeniedError, withPrincipalTransaction } from '../../apps/api/src/database.js';
import type { TransactionClient } from '../../apps/api/src/database.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000101',
  actorId: '00000000-0000-4000-8000-000000000201',
  authzVersion: 1,
};

function fakePool(
  options: { denied?: boolean; rollbackFails?: boolean; commitFails?: boolean } = {},
) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (sql: string, parameters: unknown[] = []) => {
      statements.push(sql);
      values.push(parameters);
      if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('rollback failed');
      if (sql === 'COMMIT' && options.commitFails) throw new Error('commit failed');
      return { rows: [], rowCount: options.denied ? 0 : 1 };
    },
    release: (discard: unknown) => releases.push(discard),
  } as unknown as TransactionClient;
  return { pool: { connect: async () => client }, statements, values, releases };
}

test('principal transaction pins one client and sets tenant with transaction-local parameters', async () => {
  const mock = fakePool();
  const result = await withPrincipalTransaction(mock.pool, ctx, async (client) => {
    await client.query('SELECT protected');
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(mock.statements[0], 'BEGIN');
  assert.equal(mock.statements[1], "SELECT set_config('akb.tenant_id', $1, true)");
  assert.deepEqual(mock.values[1], [ctx.tenantId]);
  assert.deepEqual(mock.values[2], [ctx.tenantId, ctx.actorId, 1]);
  assert.deepEqual(mock.statements.slice(-2), ['SELECT protected', 'COMMIT']);
  assert.deepEqual(mock.releases, [false]);
});

test('invalid and stale identities cannot execute a protected callback', async () => {
  const mock = fakePool({ denied: true });
  let calls = 0;
  const run = async () => ++calls;
  await assert.rejects(
    withPrincipalTransaction(mock.pool, { ...ctx, tenantId: "';SET ROLE postgres" }, run),
    AccessDeniedError,
  );
  assert.deepEqual(mock.statements, []);
  await assert.rejects(withPrincipalTransaction(mock.pool, ctx, run), AccessDeniedError);
  assert.equal(calls, 0);
  assert.equal(mock.statements.at(-1), 'ROLLBACK');
  assert.deepEqual(mock.releases, [false]);
});

test('business and commit failures roll back; failed rollback discards the connection', async () => {
  for (const rollbackFails of [false, true]) {
    const mock = fakePool({ rollbackFails });
    const original = new Error('business failure');
    await assert.rejects(
      withPrincipalTransaction(mock.pool, ctx, async () => {
        throw original;
      }),
      (error) => error === original,
    );
    assert.equal(mock.statements.at(-1), 'ROLLBACK');
    assert.deepEqual(mock.releases, [rollbackFails]);
  }
  const mock = fakePool({ commitFails: true });
  await assert.rejects(
    withPrincipalTransaction(mock.pool, ctx, async () => 'ok'),
    /commit failed/,
  );
  assert.equal(mock.statements.at(-1), 'ROLLBACK');
});
