import { loadDevelopmentConfig, syntheticPrincipal } from '@accremind/domain';
import { createDatabasePool } from './database.js';
import { PostgresConfigurationService } from './configurations.js';
import { FileEvidenceStore } from './evidence-store.js';
import { GitContentStore } from './content-store.js';
import { fileURLToPath } from 'node:url';
import { syntheticReviewerId } from './synthetic-contributions.js';

const [id, revision, operationId, reason, ...extra] = process.argv.slice(2);
if (!id || !revision || !operationId || !reason || extra.length || !/^[1-9]\d*$/.test(revision))
  throw new Error('Usage: synthetic:config:revoke <id> <revision> <operation_id> <reason>');
const config = loadDevelopmentConfig({
  ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
});
if (!config.databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required');
const url = new URL(config.databaseUrl);
if (
  url.pathname !== '/accremind_dev' ||
  decodeURIComponent(url.username) !== 'akb_migration' ||
  decodeURIComponent(url.password) !== 'synthetic-only'
)
  throw new Error('Command requires the local synthetic development database');
const actor = process.env.AKB_SYNTHETIC_ACTOR ?? 'contributor';
if (!['contributor', 'reviewer'].includes(actor)) throw new Error('Invalid synthetic actor');
const me = syntheticPrincipal();
const pool = createDatabasePool(config.databaseUrl, 1);
try {
  const service = new PostgresConfigurationService(
    pool,
    new FileEvidenceStore(
      process.env.AKB_SYNTHETIC_EVIDENCE_DIR ??
        fileURLToPath(new URL('../../../.local/evidence/', import.meta.url)),
    ),
    new GitContentStore(
      process.env.AKB_SYNTHETIC_CONTENT_DIR ??
        fileURLToPath(new URL('../../../.local/content/', import.meta.url)),
    ),
  );
  const result = await service.revoke(
    {
      tenantId: me.tenant_id,
      actorId: actor === 'reviewer' ? syntheticReviewerId : me.principal_id,
      authzVersion: me.authz_version,
    },
    id,
    { operation_id: operationId, expected_revision: Number(revision), reason },
  );
  console.log(
    JSON.stringify({
      service: 'synthetic-config-revoke',
      id: result.id,
      revision: result.revision,
      status: result.status,
      real_login: false,
    }),
  );
} finally {
  await pool.end();
}
