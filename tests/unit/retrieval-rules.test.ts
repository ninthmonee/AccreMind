import assert from 'node:assert/strict';
import test from 'node:test';
import { keywords, Utf8TokenCounter, versionMatches } from '../../apps/api/src/retrieval-rules.js';

test('retrieval segmentation preserves Chinese words and exact API identifiers', () => {
  const terms = keywords('事务顺序 E_TRANSACTION /api/v1/knowledge');
  assert.ok(terms.includes('事务'));
  assert.ok(terms.includes('e_transaction'));
  assert.ok(terms.some((t) => t.includes('api/v1/knowledge')));
  assert.equal(new Set(terms).size, terms.length);
  assert.deepEqual(keywords('   !!! '), []);
});
test('stable version ranges distinguish unsupported syntax, missing versions and mismatches', () => {
  assert.equal(versionMatches('17.6.0', '^17.0.0'), true);
  assert.equal(versionMatches('18.0.0', '^17.0.0'), false);
  assert.equal(versionMatches('0.2.9', '^0.2.0'), true);
  assert.equal(versionMatches('0.3.0', '^0.2.0'), false);
  assert.equal(versionMatches('1.2.9', '~1.2.0'), true);
  assert.equal(versionMatches('1.3.0', '~1.2.0'), false);
  assert.equal(versionMatches('1.2.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(versionMatches('17.6.0', '17.x'), undefined);
  assert.equal(versionMatches('1.0.0-beta', '^1.0.0'), undefined);
  assert.equal(versionMatches('synthetic-revision', 'synthetic-revision'), true);
});
test('conservative UTF-8 budget counter is deterministic across Unicode and does not pretend to be BPE', () => {
  const counter = new Utf8TokenCounter();
  assert.equal(counter.version, 'utf8-bytes-v1');
  assert.equal(counter.count('中文'), 6);
  assert.equal(counter.count('abc'), 3);
  assert.equal(counter.count('😀'), 4);
});
