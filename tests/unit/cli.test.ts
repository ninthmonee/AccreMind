import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('doctor rejects invalid, external and credentialed endpoints without leaking values', () => {
  const cli = fileURLToPath(new URL('../../apps/tool/dist/cli.js', import.meta.url));
  for (const endpoint of [
    'synthetic-secret:not a URL',
    'https://example.com',
    'http://user:synthetic-secret@127.0.0.1:3100',
  ]) {
    const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
      env: { ...process.env, AKB_ENDPOINT: endpoint },
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /synthetic-secret|example\.com/);
  }
});
