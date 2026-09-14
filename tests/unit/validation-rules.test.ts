import assert from 'node:assert/strict';
import test from 'node:test';
import { validationMaturity, genericMethod } from '../../apps/api/src/validation-rules.js';
test('maturity uses independent task/actor/proof combinations and project scope, never raw counts', () => {
  const a = { task: 'a', actor: 'a', repo: 'a', proof: 'a' };
  assert.equal(validationMaturity([], false), 'draft');
  assert.equal(validationMaturity([a], false), 'verified');
  for (const b of [
    { ...a, task: 'b', actor: 'b' },
    { ...a, actor: 'b', proof: 'b' },
    { ...a, task: 'b', proof: 'b' },
  ])
    assert.equal(validationMaturity([a, b], false), 'verified');
  const b = { task: 'b', actor: 'b', repo: 'a', proof: 'b' };
  assert.equal(validationMaturity([a, b], false), 'proven');
  assert.equal(validationMaturity([a, b], true), 'verified');
  assert.equal(validationMaturity([a, { ...b, repo: 'b' }], true), 'proven');
  // Distinct global counts alone must not produce proven when identities correlate.
  assert.equal(
    validationMaturity(
      [a, { ...a, task: 'b', proof: 'b' }, { ...a, task: 'b', actor: 'b' }],
      false,
    ),
    'verified',
  );
});
test('plain build/suite success cannot masquerade as a targeted method; human detail remains reviewable', () => {
  for (const method of ['pnpm build', 'npm run test', '全量测试通过', 'all tests passed'])
    assert.equal(genericMethod(method), true);
  assert.equal(genericMethod('复现事务消费在提交前后读取的差异，断言指定订单的可见性'), false);
});
