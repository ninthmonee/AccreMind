import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { FileEvidenceStore, sha256 } from '../../apps/api/src/evidence-store.js';

const tenant = '00000000-0000-4000-8000-000000000001';
const evidence = '00000000-0000-4000-8000-000000000002';
test('evidence survives store restart, is immutable, tenant-bound and integrity checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'accremind-evidence-'));
  try {
    const store = new FileEvidenceStore(root);
    const content = '不可变合成片段';
    const hash = sha256(content);
    const key = await store.write(tenant, evidence, content);
    assert.equal(await new FileEvidenceStore(root).read(tenant, key, hash), content);
    await assert.rejects(store.write(tenant, evidence, content));
    await assert.rejects(store.read(evidence, key, hash));
    await assert.rejects(store.read(tenant, '../outside', hash));
    await chmod(join(root, key), 0o600);
    await writeFile(join(root, key), 'corrupted');
    await assert.rejects(store.read(tenant, key, hash), /integrity/);
    await rm(join(root, key));
    await symlink(join(root, 'other'), join(root, key));
    await writeFile(join(root, 'other'), content);
    await assert.rejects(store.read(tenant, key, hash));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
