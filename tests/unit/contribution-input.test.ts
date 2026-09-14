import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, validateContribution } from '../../apps/api/src/contribution-input.js';
import { ContributionError } from '../../apps/api/src/contribution-errors.js';
import { sha256 } from '../../apps/api/src/evidence-store.js';
import { syntheticContributionsEnabled } from '../../apps/api/src/synthetic-contributions.js';
import { loadDevelopmentConfig } from '@accremind/domain';

const id = '00000000-0000-4000-8000-000000000001';
const input = () => ({
  idempotency_key: id,
  repo_id: id,
  task_id: id,
  source_event_ids: [id],
  environment: { commit: 'synthetic', dependencies: {} },
  evidence: [
    {
      client_evidence_id: id,
      source_kind: 'selected_text',
      source_ref: 'synthetic:note',
      source_revision: '1',
      locator: 'line:1',
      content: '合成证据',
      sha256: sha256('合成证据'),
    },
  ],
});

test('contribution snapshot, stable object hashing and exact UTF-8 checksum', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
    canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
  );
  const original = input();
  const snapshot = validateContribution(original);
  original.evidence[0]!.content = 'mutated';
  assert.equal(snapshot.evidence[0]!.content, '合成证据');
  assert.throws(
    () => validateContribution(original),
    (error: unknown) => error instanceof ContributionError && error.code === 'INVALID_INPUT',
  );
});

test('receive rejects duplicate identities, forged properties and secrets in any field', () => {
  const duplicate = input();
  duplicate.evidence.push({ ...duplicate.evidence[0]! });
  assert.throws(() => validateContribution(duplicate));
  const events = input();
  events.source_event_ids.push(id);
  assert.throws(() => validateContribution(events));
  assert.throws(() => validateContribution({ ...input(), actor_id: id }));
  for (const secret of [
    'password=synthetic-secret',
    '-----BEGIN PRIVATE KEY-----',
    'Bearer synthetic-token-0123456789',
  ]) {
    const bad = input();
    bad.environment.commit = secret;
    assert.throws(() => validateContribution(bad));
  }
  for (const source of [
    '.env',
    'src/.env.local',
    '%2Essh/id_rsa',
    'personal:notes',
    '/Users/synthetic/note',
    'https://u:secret@example.test/doc',
  ]) {
    const bad = input();
    bad.evidence[0]!.source_ref = source;
    assert.throws(() => validateContribution(bad));
  }
});

test('256KB receive limit counts UTF-8 bytes rather than characters', () => {
  const bad = input();
  bad.evidence[0]!.content = '汉'.repeat(90000);
  bad.evidence[0]!.sha256 = sha256(bad.evidence[0]!.content);
  assert.throws(
    () => validateContribution(bad),
    (error: unknown) => error instanceof ContributionError && error.statusCode === 413,
  );
});

test('synthetic contribution opt-in requires public local fixture credentials', () => {
  assert.equal(syntheticContributionsEnabled({}, loadDevelopmentConfig({})), false);
  assert.throws(() =>
    syntheticContributionsEnabled({ AKB_SYNTHETIC_CONTRIBUTIONS: '1' }, loadDevelopmentConfig({})),
  );
  for (const databaseUrl of [
    'postgresql://u:p@localhost/other',
    'postgresql://akb_api:real-secret@localhost/accremind_dev',
  ])
    assert.throws(() =>
      syntheticContributionsEnabled(
        { AKB_SYNTHETIC_CONTRIBUTIONS: '1' },
        loadDevelopmentConfig({ DATABASE_URL: databaseUrl }),
      ),
    );
  assert.equal(
    syntheticContributionsEnabled(
      { AKB_SYNTHETIC_CONTRIBUTIONS: '1' },
      loadDevelopmentConfig({
        DATABASE_URL: 'postgresql://akb_api:synthetic-only@127.0.0.1/accremind_dev',
      }),
    ),
    true,
  );
});
