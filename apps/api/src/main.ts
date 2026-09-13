import { createShutdown, loadDevelopmentConfig } from '@accremind/domain';
import { createApp } from './app.js';
import { createDatabasePool } from './database.js';
const config = loadDevelopmentConfig(process.env);
const pool = config.databaseUrl ? createDatabasePool(config.databaseUrl) : undefined;
const app = createApp(config, {
  checkDatabase: async () => {
    if (!pool) return false;
    await pool.query('SELECT 1');
    return true;
  },
});
pool?.on('error', () => {
  console.error(JSON.stringify({ service: 'api', code: 'DATABASE_UNAVAILABLE' }));
});
const shutdown = createShutdown(async () => {
  await app.close();
  await pool?.end();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void shutdown().catch(() => {
      console.error(JSON.stringify({ service: 'api', code: 'SHUTDOWN_FAILED' }));
      process.exitCode = 1;
    });
  });
await app.listen({ host: config.host, port: config.port });
console.log(
  JSON.stringify({
    service: 'api',
    mode: config.mode,
    host: config.host,
    port: config.port,
    business: 'not_implemented',
  }),
);
