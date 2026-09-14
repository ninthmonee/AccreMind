import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { root } from './generate-contracts.mjs';
const image =
  'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
const name = `accremind-phase-a-pg-${process.pid}-${randomBytes(4).toString('hex')}`;
function docker(args, input) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(`${args[0]} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
let started = false;
try {
  docker([
    'run',
    '--rm',
    '--detach',
    '--network',
    'none',
    '--name',
    name,
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--tmpfs',
    '/var/lib/postgresql/data',
    image,
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      ready = true;
      break;
    }
    await setTimeout(1000);
  }
  if (!ready) throw new Error('Temporary PostgreSQL did not become ready within 30 seconds');
  for (const file of [
    'docs/architecture/data/001_initial_schema.sql',
    'docs/architecture/data/002_identity_schema.sql',
    'docs/architecture/data/003_contribution_context.sql',
    'docs/architecture/data/004_human_assessment.sql',
    'docs/architecture/data/005_review_publication.sql',
    'docs/architecture/data/006_retrieval.sql',
    'docs/architecture/data/007_validation.sql',
    'docs/architecture/data/008_configuration.sql',
    'ops/db/003_runtime_roles.sql',
    'ops/db/006_governance_grants.sql',
    'ops/db/007_retrieval_grants.sql',
    'ops/db/008_validation_grants.sql',
    'ops/db/009_configuration_grants.sql',
    'tests/contracts/phase-a-schema.sql',
    'tests/integration/runtime-roles.sql',
  ]) {
    const output = docker(
      ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
      readFileSync(`${root}${file}`, 'utf8'),
    );
    console.log(`${file}: passed (${output.trim().split('\n').length} SQL result lines)`);
  }
  console.log(docker(['exec', name, 'psql', '-U', 'postgres', '-Atc', 'SELECT version();']).trim());
  console.log(`Validated image: ${image}`);
  console.log(
    'SQL constraints and basic runtime-role tenant isolation passed; not full ACL, concurrency or recovery acceptance',
  );
} finally {
  if (started) {
    docker(['stop', '--timeout', '5', name]);
    console.log(
      `Temporary container ${name} stopped and automatically removed; no host data was mounted`,
    );
  }
}
