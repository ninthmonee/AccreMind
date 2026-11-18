import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';

it('keeps samples and settings scoped while combining lifecycle filters with alias searches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'accremind-workspaces-'));
  const options = { projectRoot: join(root, 'project'), globalDir: join(root, 'global'), llmAdapter: null };
  let runtime = createAccreMindRuntime(options);
  const call = (method: string, params = {}) => runtime.rpcHandlers[method]!(params);
  try {
    await call('accremind.settings.setGate', { writeGate: 'review' });
    const { token } = await call('accremind.demo.open') as { token: string };
    const demo = (method: string, params = {}) => call('accremind.demo.call', { token, method, params });
    const counts = (await demo('accremind.dashboard.overview') as {counts: Record<string,number>}).counts;
    const list = async (filter: Record<string, string>) =>
      (await demo('accremind.kb.list', { adminView: true, ...filter }) as {items: {entry:{id:string}}[]}).items;
    assert.equal((await list({storageZone:'rules'})).length, counts.rulesCount);
    assert.equal((await list({status:'active', storageZone:'project'})).length, counts.projectActiveCount);
    assert.equal((await list({maturity:'verified_or_proven'})).length, counts.verifiedOrProvenCount);
    assert.deepEqual((await list({query:'CROSSSLOT',status:'probation'})).map(row => row.entry.id), ['K-0902']);
    assert.equal((await list({query:'CROSSSLOT',status:'active'})).length, 0);
    assert.equal((await demo('accremind.settings.get') as {writeGate:string}).writeGate, 'probation');
    await call('accremind.demo.close', { token });
    await assert.rejects(async () => demo('accremind.dashboard.overview'));
    assert.equal(runtime.store.listEntriesForAdmin().length,0);
    runtime.dispose();
    runtime = createAccreMindRuntime(options);
    assert.equal((await call('accremind.settings.get') as {writeGate:string}).writeGate, 'review');
    const other = createAccreMindRuntime({...options, projectRoot: join(root, 'other')});
    try {
      assert.equal((await other.rpcHandlers['accremind.settings.get']!({}) as {writeGate:string}).writeGate, 'probation');
    } finally { other.dispose(); }
  } finally {
    runtime.dispose();
    rmSync(root, {recursive: true, force: true});
  }
});
