import pg from 'pg';
import { createShutdown, loadDevelopmentConfig } from '@accremind/domain';
import { SearchIndexWorker } from '@accremind/api/search-index';
import { PublicationWorker } from '@accremind/api/publication-worker';
import { FileEvidenceStore, GitContentStore } from '@accremind/api/stores';
import { fileURLToPath } from 'node:url';
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
const enabled = process.env.AKB_SYNTHETIC_CONTRIBUTIONS === '1';
if (
  process.env.AKB_SYNTHETIC_CONTRIBUTIONS &&
  !['0', '1'].includes(process.env.AKB_SYNTHETIC_CONTRIBUTIONS)
)
  throw new Error('Invalid synthetic opt-in');
if (enabled && !config.databaseUrl)
  throw new Error('Synthetic publication processing requires WORKER_DATABASE_URL');
if (enabled && config.databaseUrl) {
  const url = new URL(config.databaseUrl);
  if (
    url.pathname !== '/accremind_dev' ||
    decodeURIComponent(url.username) !== 'akb_worker' ||
    decodeURIComponent(url.password) !== 'synthetic-only'
  )
    throw new Error('Publication worker requires the synthetic development worker role');
}
const worker =
  enabled && pool
    ? new PublicationWorker(
        pool,
        new FileEvidenceStore(
          process.env.AKB_SYNTHETIC_EVIDENCE_DIR ??
            fileURLToPath(new URL('../../../.local/evidence/', import.meta.url)),
        ),
        new GitContentStore(
          process.env.AKB_SYNTHETIC_CONTENT_DIR ??
            fileURLToPath(new URL('../../../.local/content/', import.meta.url)),
        ),
      )
    : undefined;
const index =
  enabled && pool
    ? new SearchIndexWorker(
        pool,
        new GitContentStore(
          process.env.AKB_SYNTHETIC_CONTENT_DIR ??
            fileURLToPath(new URL('../../../.local/content/', import.meta.url)),
        ),
      )
    : undefined;
let processing: Promise<void> | undefined;
function poll() {
  if (!worker || processing) return;
  processing = worker
    .runOnce('00000000-0000-4000-8000-000000000001')
    .then(async () => {
      await index?.runOnce('00000000-0000-4000-8000-000000000001');
    })
    .catch(() => {
      console.error(
        JSON.stringify({ service: 'worker', code: 'PUBLICATION_PROCESSING_UNAVAILABLE' }),
      );
    })
    .finally(() => {
      processing = undefined;
    });
}
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
      job_processing: worker ? 'synthetic_publication_and_index' : 'not_implemented',
    }),
  );
}
pool?.on('error', () => {
  console.error(JSON.stringify({ service: 'worker', code: 'DATABASE_UNAVAILABLE' }));
});
await heartbeat();
poll();
const pollTimer = setInterval(poll, 1000);
const timer = setInterval(() => {
  void heartbeat();
}, 30000);
const shutdown = createShutdown(async () => {
  clearInterval(timer);
  clearInterval(pollTimer);
  await processing;
  await pool?.end();
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void shutdown().catch(() => {
      console.error(JSON.stringify({ service: 'worker', code: 'SHUTDOWN_FAILED' }));
      process.exitCode = 1;
    });
  });
