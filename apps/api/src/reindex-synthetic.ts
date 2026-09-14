import { loadDevelopmentConfig, syntheticPrincipal } from '@accremind/domain';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './database.js';
import { GitContentStore } from './content-store.js';
import { SearchIndexWorker } from './search-index.js';

// Explicit operator action. Rebuild only the fixed public synthetic tenant and authorized scopes.
const config = loadDevelopmentConfig({
  ...process.env,
  DATABASE_URL: process.env.WORKER_DATABASE_URL,
});
if (!config.databaseUrl) throw new Error('WORKER_DATABASE_URL is required');
const url = new URL(config.databaseUrl);
if (
  url.pathname !== '/accremind_dev' ||
  decodeURIComponent(url.username) !== 'akb_worker' ||
  decodeURIComponent(url.password) !== 'synthetic-only'
)
  throw new Error('Reindex requires the synthetic development worker role');
const pool = createDatabasePool(config.databaseUrl, 2);
const me = syntheticPrincipal();
try {
  const index = new SearchIndexWorker(
    pool,
    new GitContentStore(
      process.env.AKB_SYNTHETIC_CONTENT_DIR ??
        fileURLToPath(new URL('../../../.local/content/', import.meta.url)),
    ),
  );
  const count = await index.rebuild({
    tenantId: me.tenant_id,
    actorId: me.principal_id,
    authzVersion: me.authz_version,
  });
  console.log(
    JSON.stringify({
      service: 'synthetic-reindex',
      queued: count,
      processing: 'worker',
      index_version: 'zh-segmenter-exact-v1',
    }),
  );
} finally {
  await pool.end();
}
