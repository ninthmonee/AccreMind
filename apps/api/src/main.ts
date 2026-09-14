import { createShutdown, loadDevelopmentConfig } from '@accremind/domain';
import { createApp } from './app.js';
import { createDatabasePool } from './database.js';
import { PostgresContributionService } from './contributions.js';
import { FileEvidenceStore } from './evidence-store.js';
import {
  syntheticContributionIdentity,
  syntheticContributionsEnabled,
} from './synthetic-contributions.js';
import { fileURLToPath } from 'node:url';
import { PostgresAssessmentService } from './assessments.js';
import { PostgresGovernanceService } from './governance.js';
import { PostgresKnowledgeGovernance } from './knowledge-governance.js';
import { GitContentStore } from './content-store.js';
import { PostgresRetrievalService } from './retrieval.js';
import { PostgresValidationService } from './validations.js';
import { PostgresConfigurationService } from './configurations.js';
const config = loadDevelopmentConfig(process.env);
const pool = config.databaseUrl ? createDatabasePool(config.databaseUrl) : undefined;
const enabled = syntheticContributionsEnabled(process.env, config);
const store = new FileEvidenceStore(
  process.env.AKB_SYNTHETIC_EVIDENCE_DIR ??
    fileURLToPath(new URL('../../../.local/evidence/', import.meta.url)),
);
const content = new GitContentStore(
  process.env.AKB_SYNTHETIC_CONTENT_DIR ??
    fileURLToPath(new URL('../../../.local/content/', import.meta.url)),
);
const versions = pool ? new PostgresKnowledgeGovernance(pool, store, content) : undefined;
const app = createApp(config, {
  ...(enabled && pool
    ? {
        contributions: new PostgresContributionService(pool, store),
        assessments: new PostgresAssessmentService(pool, store),
        governance: new PostgresGovernanceService(pool, store),
        knowledge: versions!,
        retrieval: new PostgresRetrievalService(pool, versions!),
        validations: new PostgresValidationService(pool, store, versions!),
        configurations: new PostgresConfigurationService(pool, store, content),
        ...syntheticContributionIdentity(pool, process.env.AKB_SYNTHETIC_ACTOR),
      }
    : {}),
  checkDatabase: async () => {
    if (!pool) return false;
    await pool.query('SELECT 1');
    if (enabled) await pool.query('SELECT environment FROM akb.contributions LIMIT 0');
    if (enabled) await pool.query('SELECT evidence_set_hash FROM akb.assessments LIMIT 0');
    if (enabled) await pool.query('SELECT result FROM akb.publications LIMIT 0');
    if (enabled)
      await pool.query('SELECT generation,read_window_start FROM akb.operations LIMIT 0');
    if (enabled) await pool.query('SELECT proof_fingerprint FROM akb.validations LIMIT 0');
    if (enabled) await pool.query('SELECT generation,next_revision FROM akb.config_heads LIMIT 0');
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
    business: enabled ? 'synthetic_versioned_configuration' : 'not_implemented',
  }),
);
