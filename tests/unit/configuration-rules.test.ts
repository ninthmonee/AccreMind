import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibleHost, stableHostVersion } from '../../apps/api/src/configuration-rules.js';

test('configuration host compatibility uses numeric stable versions and never guesses prereleases', () => {
  assert.equal(compatibleHost('2.10.0', '2.9.0'), true);
  assert.equal(compatibleHost('2.9.0', '2.10.0'), false);
  assert.equal(compatibleHost('v2.10.0', '2.10.0'), true);
  for (const value of ['latest', '2.10', '2.10.0-beta.1', '02.10.0', '9007199254740992.0.0']) {
    assert.equal(stableHostVersion(value), false);
    assert.equal(compatibleHost(value, '2.0.0'), false);
  }
});
