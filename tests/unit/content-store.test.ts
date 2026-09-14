import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitContentStore } from '../../apps/api/src/content-store.js';
import { sha256 } from '../../apps/api/src/evidence-store.js';

test('bare Git content refs survive restart, preserve exact Unicode and reject identity conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'accremind-git-'));
  const tenant = randomUUID();
  const publication = randomUUID();
  try {
    const store = new GitContentStore(root);
    const content = JSON.stringify({ claim: '合成内容', body: '无证据原文\n' });
    const ref = await store.write(tenant, publication, content);
    assert.match(ref, /^[a-f0-9]{40}:/);
    const restarted = new GitContentStore(root);
    assert.equal(await restarted.read(tenant, ref, sha256(content)), content);
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 12 }, () => restarted.read(tenant, ref, sha256(content))),
      ),
      Array(12).fill(content),
    );
    assert.equal(await restarted.write(tenant, publication, content), ref);
    await assert.rejects(restarted.write(tenant, publication, 'changed'));
    await assert.rejects(restarted.read(tenant, ref, '0'.repeat(64)));
    await assert.rejects(restarted.read(tenant, 'HEAD:../../outside', '0'.repeat(64)));
    await assert.rejects(restarted.write('../outside', publication, content));
    await assert.rejects(restarted.write(tenant, randomUUID(), content, AbortSignal.abort()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('Git content storage rejects a symlink repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'accremind-git-link-'));
  const target = await mkdtemp(join(tmpdir(), 'accremind-git-target-'));
  const tenant = randomUUID();
  try {
    await symlink(target, join(root, `${tenant}.git`));
    await assert.rejects(new GitContentStore(root).write(tenant, randomUUID(), 'synthetic'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
