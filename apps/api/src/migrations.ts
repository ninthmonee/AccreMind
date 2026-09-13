import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TransactionPool } from './database.js';

const migrationFiles = ['001_initial_schema.sql', '002_identity_schema.sql'] as const;

/** Explicit operator action, never called by API startup. Initial migrations only.
 * Existing untracked schemas are NOT silently adopted; they fail safely.
 * Runtime role provisioning is separate from schema migrations.
 */
export async function migrateDatabase(pool: TransactionPool): Promise<string[]> {
  const migrations = await Promise.all(
    migrationFiles.map(async (id) => {
      const sql = await readFile(
        new URL(`../../../docs/architecture/data/${id}`, import.meta.url),
        'utf8',
      );
      // SQL files contain their own BEGIN/COMMIT. Remove only the outer wrapper
      // so the schema changes and ledger entry share our transaction.
      const begin = sql.indexOf('\nBEGIN;');
      if (begin < 0 || !sql.trimEnd().endsWith('COMMIT;'))
        throw new Error(`Unsupported migration wrapper: ${id}`);
      const body = sql
        .slice(begin + '\nBEGIN;'.length)
        .trimEnd()
        .slice(0, -'COMMIT;'.length);
      return { id, body, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
  const client = await pool.connect();
  const applied: string[] = [];
  let locked = false;
  let discard = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('accremind-schema-migrations'))");
    locked = true;
    await client.query(`CREATE SCHEMA IF NOT EXISTS akb_migrations`);
    await client.query(`CREATE TABLE IF NOT EXISTS akb_migrations.applied (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ledger = await client.query<{ id: string; checksum: string }>(
      'SELECT id, checksum FROM akb_migrations.applied ORDER BY id',
    );
    // Check the entire known history BEFORE changing the database.
    for (const row of ledger.rows) {
      const migration = migrations.find((item) => item.id === row.id);
      if (!migration || migration.checksum !== row.checksum)
        throw new Error(`Migration history mismatch: ${row.id}`);
    }
    for (const migration of migrations) {
      if (ledger.rows.some((row) => row.id === migration.id)) continue;
      await client.query('BEGIN');
      await client.query(migration.body);
      await client.query('INSERT INTO akb_migrations.applied(id, checksum) VALUES ($1, $2)', [
        migration.id,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      applied.push(migration.id);
    }
    return applied;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    if (locked && !discard) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext('accremind-schema-migrations'))");
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}
