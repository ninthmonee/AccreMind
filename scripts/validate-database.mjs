import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const image =
  'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929';
const name = `accremind-acl-test-${process.pid}-${randomBytes(4).toString('hex')}`;
const guard = randomBytes(24).toString('hex');
const root = new URL('../', import.meta.url);

function docker(args, input) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Docker ${args[0]} failed`);
  return result.stdout;
}
function node(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Database check subprocess failed');
}
let started = false;
try {
  // Disposable synthetic data only. Random loopback port; no host data mounts.
  // Unlike the network-none SQL checker, this tests the real Node/pg TCP boundary.
  docker([
    'run',
    '--rm',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_PASSWORD=synthetic-only',
    '--env',
    'POSTGRES_DB=accremind_test',
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
  if (!ready) throw new Error('Temporary database did not become ready');
  const port = docker(['port', name, '5432/tcp'])
    .trim()
    .match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error('Database port is not loopback');
  const ownerUrl = `postgresql://postgres:synthetic-only@127.0.0.1:${port}/accremind_test`;
  const apiUrl = `postgresql://akb_api:synthetic-only@127.0.0.1:${port}/accremind_test`;
  const psql = [
    'exec',
    '-i',
    name,
    'psql',
    '-U',
    'postgres',
    '-d',
    'accremind_test',
    '-v',
    'ON_ERROR_STOP=1',
  ];
  docker(
    psql,
    `CREATE TABLE public.accremind_test_guard(token text NOT NULL);
    INSERT INTO public.accremind_test_guard VALUES ('${guard}');`,
  );
  node(['--import', 'tsx', 'apps/api/src/migrate.ts'], {
    ...process.env,
    NODE_ENV: 'test',
    AKB_MODE: 'synthetic',
    HOST: '127.0.0.1',
    MODEL_ENDPOINT: '',
    MODEL_ID: '',
    MIGRATION_DATABASE_URL: ownerUrl,
  });
  docker(psql, readFileSync(new URL('ops/db/003_runtime_roles.sql', root), 'utf8'));
  node(
    [
      '--import',
      'tsx',
      '--test',
      'tests/integration/database.test.ts',
      'tests/integration/contributions.test.ts',
      'tests/integration/assessments.test.ts',
      'tests/integration/governance.test.ts',
    ],
    {
      ...process.env,
      ACCREMIND_TEST_DATABASE_URL: apiUrl,
      ACCREMIND_TEST_OWNER_URL: ownerUrl,
      ACCREMIND_TEST_GUARD: guard,
    },
  );
} finally {
  if (started) {
    docker(['stop', '--timeout', '5', name]);
    console.log(`Removed disposable database container ${name}; no persistent volume was used`);
  }
}
