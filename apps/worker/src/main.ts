import pg from 'pg';
import { createShutdown, loadDevelopmentConfig } from '@accremind/domain';
const config = loadDevelopmentConfig({
  ...process.env,
  DATABASE_URL: process.env.WORKER_DATABASE_URL,
});
const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
    })
  : undefined;
async function heartbeat() {
  let database = 'not_configured';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unavailable';
    }
  }
  console.log(
    JSON.stringify({
      service: 'worker',
      mode: config.mode,
      database,
      job_processing: 'not_implemented',
    }),
  );
}
pool?.on('error', () => {
  console.error(JSON.stringify({ service: 'worker', code: 'DATABASE_UNAVAILABLE' }));
});
await heartbeat();
const timer = setInterval(() => {
  void heartbeat();
}, 30000);
const shutdown = createShutdown(async () => {
  clearInterval(timer);
  await pool?.end();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void shutdown().catch(() => {
      console.error(JSON.stringify({ service: 'worker', code: 'SHUTDOWN_FAILED' }));
      process.exitCode = 1;
    });
  });
