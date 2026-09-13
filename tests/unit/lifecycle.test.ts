import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdown } from '@accremind/domain';

test('concurrent shutdown signals share one cleanup promise', async () => {
  let calls = 0;
  const shutdown = createShutdown(async () => {
    calls++;
  });
  const first = shutdown();
  assert.equal(first, shutdown());
  await first;
  await shutdown();
  assert.equal(calls, 1);
});
