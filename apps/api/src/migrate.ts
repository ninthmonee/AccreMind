import { loadDevelopmentConfig } from '@accremind/domain';
import { createDatabasePool } from './database.js';
import { migrateDatabase } from './migrations.js';

const config = loadDevelopmentConfig({
  ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
});
if (!config.databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required');
const pool = createDatabasePool(config.databaseUrl, 1);
try {
  const applied = await migrateDatabase(pool);
  console.log(JSON.stringify({ service: 'migration', applied }));
} catch {
  // Do not print driver errors: they may contain credentials or SQL values.
  console.error(JSON.stringify({ service: 'migration', code: 'MIGRATION_FAILED' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
