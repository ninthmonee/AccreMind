import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDevelopmentConfig, syntheticPrincipal } from '@accremind/domain';
import { getValidator, dispositions, validatorOptions } from '@accremind/contracts';
test('synthetic defaults use loopback and no external integrations', () => {
  assert.deepEqual(loadDevelopmentConfig({}), {
    mode: 'synthetic',
    host: '127.0.0.1',
    port: 3100,
    databaseUrl: undefined,
  });
  assert.equal(getValidator('Me')(syntheticPrincipal()), true);
  assert.deepEqual(syntheticPrincipal().capabilities, []);
});
test('production, public binding and model egress fail closed', () => {
  for (const env of [
    { AKB_MODE: 'production' },
    { NODE_ENV: 'production' },
    { HOST: '0.0.0.0' },
    { MODEL_ID: 'anything' },
    { MODEL_ENDPOINT: 'https://external.test' },
    { DATABASE_URL: 'postgres://u:p@external.test/db' },
    { DATABASE_URL: 'not a URL containing synthetic-secret' },
    { PORT: '0' },
  ])
    assert.throws(() => loadDevelopmentConfig(env));
  assert.throws(
    () => loadDevelopmentConfig({ DATABASE_URL: 'not a URL containing synthetic-secret' }),
    { message: 'Invalid DATABASE_URL' },
  );
});
test('shared enum and validators have no consumer copies or silent mutation', () => {
  assert.equal(dispositions.length, 5);
  assert.equal(validatorOptions.removeAdditional, false);
  const input = {
    operation_id: '00000000-0000-4000-8000-000000000001',
    expected_revision: 1,
    reason: 'synthetic',
    actor_id: 'forged',
  };
  assert.equal(getValidator('Mutation')(input), false);
  assert.equal(input.actor_id, 'forged');
});
