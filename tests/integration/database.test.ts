import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PostgresAuthorizationService } from '../../apps/api/src/authorization.js';
import {
  AccessDeniedError,
  createDatabasePool,
  withPrincipalTransaction,
} from '../../apps/api/src/database.js';
import { migrateDatabase } from '../../apps/api/src/migrations.js';

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const alice = { tenantId: id(101), actorId: id(201), authzVersion: 1 };
const bob = { ...alice, actorId: id(202) };
const ops = { ...alice, actorId: id(203) };
const other = { tenantId: id(102), actorId: id(204), authzVersion: 1 };
const ref = (suffix: number, revision = 1) => ({ id: id(suffix), revision, locator: 'line:1' });
const apiUrl = process.env.ACCREMIND_TEST_DATABASE_URL;
const ownerUrl = process.env.ACCREMIND_TEST_OWNER_URL;

test(
  'real PostgreSQL migration, transaction and scope authorization boundary',
  { skip: !apiUrl || !ownerUrl, timeout: 30000 },
  async (t) => {
    // Guard against accidentally running fixture writes against a persistent DB.
    assert.ok(apiUrl && ownerUrl);
    for (const url of [apiUrl, ownerUrl]) {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, '127.0.0.1');
      assert.equal(parsed.pathname, '/accremind_test');
    }
    const admin = createDatabasePool(ownerUrl, 1);
    // One pooled connection deliberately exercises reuse across tenants and failures.
    const pool = createDatabasePool(apiUrl, 1);
    const auth = new PostgresAuthorizationService(pool);
    try {
      const guard = await admin.query<{ token: string }>(
        'SELECT token FROM public.accremind_test_guard',
      );
      assert.ok(process.env.ACCREMIND_TEST_GUARD);
      assert.equal(guard.rows[0]?.token, process.env.ACCREMIND_TEST_GUARD);
      await admin.query(
        await readFile(new URL('./authorization-fixture.sql', import.meta.url), 'utf8'),
      );

      await t.test(
        'initial migrations are repeatable and checksum drift blocks execution',
        async () => {
          assert.deepEqual(await migrateDatabase(admin), []);
          const checksum = await admin.query<{ checksum: string }>(
            'SELECT checksum FROM akb_migrations.applied WHERE id = $1',
            ['001_initial_schema.sql'],
          );
          await admin.query('UPDATE akb_migrations.applied SET checksum = $1 WHERE id = $2', [
            'changed',
            '001_initial_schema.sql',
          ]);
          await assert.rejects(migrateDatabase(admin), /Migration history mismatch/);
          await admin.query('UPDATE akb_migrations.applied SET checksum = $1 WHERE id = $2', [
            checksum.rows[0]?.checksum,
            '001_initial_schema.sql',
          ]);
          assert.deepEqual(await migrateDatabase(admin), []);
        },
      );

      await t.test(
        'failed initial migration rolls back DDL and does not record success',
        async () => {
          // Still inside the guarded disposable container; never drop or reset a DB.
          await admin.query('CREATE DATABASE accremind_migration_failure');
          const failureUrl = new URL(ownerUrl);
          failureUrl.pathname = '/accremind_migration_failure';
          const failurePool = createDatabasePool(failureUrl.toString(), 1);
          try {
            // Inject a failure after 002 creates its schema and first table.
            await failurePool.query(`
              CREATE FUNCTION public.fail_identity_table() RETURNS event_trigger
              LANGUAGE plpgsql AS $$
              BEGIN
                IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
                  WHERE schema_name = 'akb_identity' AND command_tag = 'CREATE TABLE')
                THEN RAISE EXCEPTION 'synthetic migration failure'; END IF;
              END $$;
              CREATE EVENT TRIGGER fail_identity ON ddl_command_end
                WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.fail_identity_table();
            `);
            await assert.rejects(migrateDatabase(failurePool));
            assert.deepEqual(
              (await failurePool.query('SELECT id FROM akb_migrations.applied')).rows,
              [{ id: '001_initial_schema.sql' }],
            );
            assert.equal(
              (await failurePool.query("SELECT to_regnamespace('akb_identity') AS schema_name"))
                .rows[0]?.schema_name,
              null,
            );
            assert.ok(
              (await failurePool.query("SELECT to_regclass('akb.principals') AS table_name"))
                .rows[0]?.table_name,
            );
          } finally {
            await failurePool.end();
          }
        },
      );

      await t.test(
        'two users see only their own repo; ops privilege does not grant content',
        async () => {
          assert.deepEqual(await auth.allowedScopes(alice, 'knowledge:read'), new Set([id(303)]));
          assert.deepEqual(await auth.allowedScopes(bob, 'knowledge:read'), new Set([id(304)]));
          assert.deepEqual(await auth.allowedScopes(ops, 'knowledge:read'), new Set());
          assert.deepEqual(await auth.allowedScopes(alice, 'knowledge:publish'), new Set());
          assert.deepEqual(await auth.allowedScopes(other, 'knowledge:read'), new Set([id(307)]));
          await assert.rejects(
            auth.allowedScopes({ ...alice, tenantId: other.tenantId }, 'knowledge:read'),
            AccessDeniedError,
          );
        },
      );

      await t.test(
        'evidence ACL is separate and checks exact revision and availability',
        async () => {
          await auth.assertEvidenceReadable(alice, [ref(601), ref(601)]);
          for (const refs of [[ref(602)], [ref(603)], [ref(601, 2)], [ref(601), ref(602)]])
            await assert.rejects(auth.assertEvidenceReadable(alice, refs), AccessDeniedError);
          // Bob can read repo B knowledge, but has no evidence grant.
          await assert.rejects(auth.assertEvidenceReadable(bob, [ref(602)]), AccessDeniedError);
          for (const status of ['quarantined', 'expired', 'deleted']) {
            await admin.query('UPDATE akb.evidence SET status = $1 WHERE id = $2', [
              status,
              id(601),
            ]);
            await assert.rejects(auth.assertEvidenceReadable(alice, [ref(601)]), AccessDeniedError);
          }
          await admin.query(
            "UPDATE akb.evidence SET status = 'available', expires_at = now() - interval '1 day' WHERE id = $1",
            [id(601)],
          );
          await assert.rejects(auth.assertEvidenceReadable(alice, [ref(601)]), AccessDeniedError);
          await admin.query(
            "UPDATE akb.evidence SET expires_at = now() + interval '1 day' WHERE id = $1",
            [id(601)],
          );
        },
      );

      await t.test(
        'explicit domain/team grants include descendants, never parents or siblings',
        async () => {
          await admin.query('UPDATE akb.grants SET scope_id = $1 WHERE id = $2', [
            id(302),
            id(501),
          ]);
          assert.deepEqual(
            await auth.allowedScopes(alice, 'knowledge:read'),
            new Set([id(302), id(303), id(304)]),
          );
          await admin.query('UPDATE akb.grants SET scope_id = $1 WHERE id = $2', [
            id(301),
            id(501),
          ]);
          assert.deepEqual(
            await auth.allowedScopes(alice, 'knowledge:read'),
            new Set([id(301), id(302), id(303), id(304), id(305), id(306)]),
          );
          await admin.query('UPDATE akb.grants SET scope_id = $1 WHERE id = $2', [
            id(303),
            id(501),
          ]);
        },
      );

      await t.test(
        'revocation, disabled principal and stale authz versions fail closed',
        async () => {
          await admin.query('UPDATE akb.grants SET revoked_at = now() WHERE id = $1', [id(501)]);
          assert.deepEqual(await auth.allowedScopes(alice, 'knowledge:read'), new Set());
          await admin.query('UPDATE akb.grants SET revoked_at = now() WHERE id = $1', [id(503)]);
          await assert.rejects(auth.assertEvidenceReadable(alice, [ref(601)]), AccessDeniedError);
          await admin.query('UPDATE akb.principals SET authz_version = 2 WHERE id = $1', [
            alice.actorId,
          ]);
          await assert.rejects(auth.allowedScopes(alice, 'knowledge:read'), AccessDeniedError);
          await admin.query('UPDATE akb.principals SET active = false WHERE id = $1', [
            bob.actorId,
          ]);
          await assert.rejects(auth.allowedScopes(bob, 'knowledge:read'), AccessDeniedError);
        },
      );

      await t.test(
        'commit/rollback clear tenant context on a reused non-owner connection',
        async () => {
          const freshAlice = { ...alice, authzVersion: 2 };
          await withPrincipalTransaction(pool, freshAlice, async (client) => {
            const rows = await client.query('SELECT id FROM akb.principals');
            assert.equal(rows.rowCount, 3);
            const role = await client.query<{ unsafe: boolean }>(`SELECT rolsuper OR rolbypassrls
            OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname = 'akb' AND tableowner = current_user)
            AS unsafe FROM pg_roles WHERE rolname = current_user`);
            assert.equal(role.rows[0]?.unsafe, false);
          });
          assert.equal((await pool.query('SELECT id FROM akb.principals')).rowCount, 0);
          await assert.rejects(
            withPrincipalTransaction(pool, other, async (client) => {
              assert.equal((await client.query('SELECT id FROM akb.principals')).rowCount, 1);
              await client.query('SELECT * FROM akb_identity.sessions');
            }),
          );
          assert.equal((await pool.query('SELECT id FROM akb.principals')).rowCount, 0);
          assert.deepEqual(await auth.allowedScopes(other, 'knowledge:read'), new Set([id(307)]));
        },
      );
    } finally {
      await pool.end();
      await admin.end();
    }
  },
);
