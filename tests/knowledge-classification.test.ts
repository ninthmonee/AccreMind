import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { KnowledgeEntry, KnowledgeLayer } from '@accremind/core';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';

it('keeps the five layers explicit: domain/project in the repository, personal machine-wide, team rules only by proposal', async () => {
  const base = mkdtempSync(join(tmpdir(), 'accremind-classification-'));
  const globalDir = join(base, 'global');
  const runtime = createAccreMindRuntime({
    projectRoot: join(base, 'first'),
    globalDir,
    writeGate: 'off',
    llmAdapter: null,
  });
  const other = createAccreMindRuntime({
    projectRoot: join(base, 'second'),
    globalDir,
    llmAdapter: null,
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    runtime.rpcHandlers[method]!(params);
  type ScopeCounts = Record<KnowledgeLayer, number>;
  const list = async (filters: Record<string, unknown> = {}) =>
    (await call('accremind.kb.list', { adminView: true, ...filters })) as {
      items: { entry: KnowledgeEntry; storageZone: string }[];
      scopeCounts: ScopeCounts;
    };
  const capture = async (name: string, type: 'model' | 'pitfall', layer?: string) => {
    const params = {
      title: name,
      type,
      layer,
      question: name + '有哪些适用条件？',
      baseline_answer: '订单仓库可定位回调函数。',
      knowledge_delta: name + '的业务时序约束',
      disposition: 'knowledge_candidate',
      discoverability: 'missing_context',
      claim: name + '需要检查支付结果。',
      preconditions: ['订单支付完成'],
      invalidation_triggers: ['回调契约更新'],
      rationale: '渠道可能重放回调',
      verification_method: '支付回调回归测试',
      file_locator: 'tests/pay.ts#L7',
      search_aliases: ['回调重放'],
      evidence_summary: '回归测试验证重复事件的影响',
    };
    return (await call('accremind.capture.manual', params)) as { persistedEntry: KnowledgeEntry };
  };
  try {
    const domain = (await capture('结算时序约束', 'pitfall', 'domain')).persistedEntry;
    const project = (await capture('仓库实体映射', 'model')).persistedEntry;
    assert.equal(domain.layer, 'domain');
    assert.throws(() => runtime.store.upsertEntry(domain, 'shared_tech', null), /领域知识/);
    assert.equal(project.layer, 'project');
    assert.ok(existsSync(join(runtime.store.paths.projectEntriesDir, domain.id + '.md')));
    // The other repository can read it by ID (it is registered on this machine) but is not reminded of it:
    // without a shared business domain it is only a cross-repository reference.
    assert.ok(other.store.getEntry(domain.id, { recordUsage: false }).found);
    const otherHits = other.store.search({ workspaceId: other.store.workspaceId, query: '回调重放' }).items;
    assert.ok(!otherHits.some((h) => h.entry.id === domain.id && h.scopeVerdict !== 'cross_ref'));
    const result = await list({
      layer: 'domain',
      type: 'pitfall',
      query: '回调重放',
      status: 'active',
    });
    assert.deepEqual(
      result.items.map((i) => i.entry.id),
      [domain.id],
    );
    assert.deepEqual(result.scopeCounts, {
      personal: 0,
      team_rule: 0,
      shared_tech: 0,
      domain: 1,
      project: 0,
    });
    const noMatch = await list({ layer: 'domain', type: 'model' });
    assert.equal(noMatch.items.length, 0);
    assert.equal(noMatch.scopeCounts.project, 1);
    const overview = (await call('accremind.dashboard.overview')) as {
      counts: { byScope: ScopeCounts; byCategory: Record<string, number> };
    };
    assert.equal(overview.counts.byScope.domain, 1);
    assert.equal(overview.counts.byScope.project, 1);
    assert.deepEqual(overview.counts.byCategory, {
      model: 1,
      decision: 0,
      guideline: 0,
      pitfall: 1,
      process: 0,
    });
    const search = runtime.tools.find((t) => t.name === 'accremind_search')!;
    const hits = JSON.parse(
      (await search.execute({ query: '回调重放', layer: 'domain' })).content[0]!.text,
    ).items;
    assert.deepEqual(
      hits.map((hit: { layer: string }) => hit.layer),
      ['domain'],
    );
    const personal = (await capture('另建个人副本', 'pitfall', 'personal')).persistedEntry;
    assert.equal(personal.layer, 'personal');
    assert.equal(personal.visibility, 'private');
    assert.ok(existsSync(join(runtime.store.paths.personalDir, personal.id + '.md')), 'personal entries never enter the repository');
    assert.ok(!existsSync(join(runtime.store.paths.projectEntriesDir, personal.id + '.md')));
    await assert.rejects(
      async () =>
        call('accremind.kb.saveRevision', { id: domain.id, patch: { layer: 'team_rule' } }),
      /layer/,
    );

    runtime.store.updateExistingEntryDirect({ ...domain, maturity: 'verified' });
    const reclassified = (await call('accremind.kb.saveRevision', {
      id: domain.id,
      expectedRevision: domain.revision,
      revisionImpact: 'editorial',
      patch: { layer: 'project' },
    })) as { ok: boolean; entry: KnowledgeEntry };
    assert.equal(reclassified.entry.revision, domain.revision + 1);
    assert.equal(reclassified.entry.maturity, 'draft');
    assert.equal(reclassified.entry.layer, 'project');
    assert.match(
      readFileSync(join(runtime.store.paths.projectEntriesDir, domain.id + '.md'), 'utf8'),
      /layer: "project"/,
    );
    assert.equal((await list()).scopeCounts.domain, 0);
    assert.equal((await list()).scopeCounts.project, 2);
    assert.equal((await list()).scopeCounts.personal, 1);
  } finally {
    other.dispose();
    runtime.dispose();
    rmSync(base, { force: true, recursive: true });
  }
});
