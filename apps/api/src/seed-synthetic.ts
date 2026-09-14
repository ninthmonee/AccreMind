import { readFile } from 'node:fs/promises';
import { loadDevelopmentConfig, syntheticPrincipal } from '@accremind/domain';
import { createDatabasePool } from './database.js';
import {
  syntheticCapabilities,
  syntheticRepoId,
  syntheticScopeId,
  syntheticReviewerId,
} from './synthetic-contributions.js';
import { seedSyntheticMaterials } from './synthetic-materials.js';
import { FileEvidenceStore } from './evidence-store.js';
import { fileURLToPath } from 'node:url';

// Explicit seed for public synthetic development identities. Never run on API startup.
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
  throw new Error('Seed requires the accremind_dev synthetic migration role');
const pool = createDatabasePool(config.databaseUrl, 1);
const client = await pool.connect();
const me = syntheticPrincipal();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('akb.tenant_id',$1,true)", [me.tenant_id]);
  await client.query('SELECT environment FROM akb.contributions LIMIT 0');
  await client.query('SELECT evidence_set_hash FROM akb.assessments LIMIT 0');
  // Refuse to mix this fixture into a database already containing any other team.
  const tenants = await client.query('SELECT id FROM akb.tenants WHERE id<>$1', [me.tenant_id]);
  if (tenants.rowCount) throw new Error('Non-fixture tenants exist');
  await client.query('INSERT INTO akb.tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    me.tenant_id,
    'synthetic development',
  ]);
  const principals = await client.query(
    "SELECT id FROM akb.principals WHERE oidc_issuer<>'synthetic' OR id NOT IN ($1,$2)",
    [me.principal_id, syntheticReviewerId],
  );
  if (principals.rowCount) throw new Error('Non-fixture principals exist');
  await client.query(
    `INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name)
    VALUES($1,$2,'synthetic','manual-import','Synthetic contributor') ON CONFLICT DO NOTHING`,
    [me.tenant_id, me.principal_id],
  );
  await client.query(
    `INSERT INTO akb.principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES($1,$2,'synthetic','manual-review','Synthetic reviewer') ON CONFLICT DO NOTHING`,
    [me.tenant_id, syntheticReviewerId],
  );
  const reviewer = await client.query(
    "SELECT id FROM akb.principals WHERE tenant_id=$1 AND id=$2 AND oidc_issuer='synthetic' AND oidc_subject='manual-review'",
    [me.tenant_id, syntheticReviewerId],
  );
  if (reviewer.rowCount !== 1) throw new Error('Synthetic reviewer identity collision');
  const domain = '00000000-0000-4000-8000-000000000003';
  await client.query(
    'INSERT INTO akb.domains(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [me.tenant_id, domain, 'synthetic'],
  );
  await client.query(
    'INSERT INTO akb.repos(tenant_id,id,domain_id,name,canonical_remote) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [me.tenant_id, syntheticRepoId, domain, 'synthetic repo', 'synthetic:manual-import'],
  );
  await client.query(
    "INSERT INTO akb.scopes(tenant_id,id,kind,repo_id) VALUES($1,$2,'repo',$3) ON CONFLICT DO NOTHING",
    [me.tenant_id, syntheticScopeId, syntheticRepoId],
  );
  const fixture = await client.query(
    `SELECT p.id FROM akb.principals p JOIN akb.repos r ON r.tenant_id=p.tenant_id
     JOIN akb.scopes s ON s.tenant_id=r.tenant_id AND s.repo_id=r.id
     WHERE p.tenant_id=$1 AND p.id=$2 AND p.oidc_issuer='synthetic' AND p.oidc_subject='manual-import'
       AND r.id=$3 AND r.canonical_remote='synthetic:manual-import' AND s.id=$4 AND s.kind='repo'`,
    [me.tenant_id, me.principal_id, syntheticRepoId, syntheticScopeId],
  );
  if (fixture.rowCount !== 1) throw new Error('Synthetic fixture identity collision');
  for (const [index, capability] of syntheticCapabilities.entries())
    await client.query(
      'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        me.tenant_id,
        `00000000-0000-4000-8000-00000000001${index}`,
        me.principal_id,
        syntheticScopeId,
        capability,
      ],
    );
  await client.query(
    await readFile(
      new URL('../../../ops/db/004_contribution_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  await client.query(
    await readFile(
      new URL('../../../ops/db/005_assessment_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  for (const [index, capability] of [
    'knowledge:read',
    'evidence:read',
    'knowledge:review',
    'knowledge:publish',
    'knowledge:contribute',
    'knowledge:validation-review',
    'knowledge:history',
    'config:read',
    'config:manage',
  ].entries())
    await client.query(
      'INSERT INTO akb.grants(tenant_id,id,principal_id,scope_id,capability) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [
        me.tenant_id,
        `00000000-0000-4000-8000-00000000002${index}`,
        syntheticReviewerId,
        syntheticScopeId,
        capability,
      ],
    );
  await client.query(
    await readFile(
      new URL('../../../ops/db/006_governance_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  await client.query(
    await readFile(
      new URL('../../../ops/db/007_retrieval_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  await client.query(
    await readFile(
      new URL('../../../ops/db/008_validation_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  await client.query(
    await readFile(
      new URL('../../../ops/db/009_configuration_grants.sql', import.meta.url),
      'utf8',
    ).then((sql) => sql.slice(sql.indexOf('BEGIN;') + 6, sql.lastIndexOf('COMMIT;'))),
  );
  await seedSyntheticMaterials(
    client,
    { tenantId: me.tenant_id, actorId: me.principal_id, authzVersion: me.authz_version },
    syntheticRepoId,
    syntheticScopeId,
    new FileEvidenceStore(
      process.env.AKB_SYNTHETIC_EVIDENCE_DIR ??
        fileURLToPath(new URL('../../../.local/evidence/', import.meta.url)),
    ),
  );
  await client.query('COMMIT');
  console.log(
    JSON.stringify({
      service: 'synthetic-seed',
      repo_id: syntheticRepoId,
      scope_id: syntheticScopeId,
      real_login: false,
    }),
  );
} catch {
  await client.query('ROLLBACK');
  console.error(JSON.stringify({ service: 'synthetic-seed', code: 'SEED_FAILED' }));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
