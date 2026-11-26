import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { isExcludedPath, normalizeExcludePaths, type KnowledgeEntry } from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const temps: string[] = [];
afterEach(() => { while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true }); });

function boot(): AccreMindPluginInstance {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-scope-'));
  temps.push(base);
  const projectRoot = path.join(base, 'repo');
  fs.mkdirSync(path.join(projectRoot, 'src/order'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'vendor/lib'), { recursive: true });
  return createAccreMindRuntime({ projectRoot, globalDir: path.join(base, 'g'), autoCapture: { enabled: false } });
}

function rule(id: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id, revision: 1, type: 'pitfall', polarity: 'avoid', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: '订单写入必须先落事件再写账务', search_aliases: ['重复扣款', '幂等'],
    claim: '新增订单写入路径时先写事件表，再更新账务，保证重复回调不会重复扣款。',
    knowledge_delta: '增量', rationale: 'r', preconditions: ['新增或修改订单写入链路'], exclusions: [], dependency_constraints: [],
    watch_paths: ['src/order/write.ts'], symbol_anchors: [], invalidation_triggers: ['表结构变化'], verification_method: 'v',
    alternatives: [], enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active', maturity: 'verified',
    freshness: 'current', serving: 'enabled', priority: 'P0', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'EV-1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: 's' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: new Date(Date.now() + 90 * 864e5).toISOString(),
    ...over,
  };
}

function readTool(toolPath: string) {
  return {
    sessionId: 's1',
    turnId: '1',
    toolName: 'read_file',
    args: { path: toolPath },
    result: { content: [{ type: 'text', text: 'file body' }] },
  };
}

describe('仓库范围：整仓暂停与路径排除', () => {
  it('normalizes exclude prefixes and matches a prefix plus everything under it', () => {
    assert.deepEqual(
      normalizeExcludePaths([' vendor/lib/ ', 'dist', './generated', '/etc', '~/secrets', 'a/../b', 'dist', '']),
      ['vendor/lib', 'dist', 'generated'],
    );
    assert.deepEqual(normalizeExcludePaths(undefined), []);
    assert.equal(isExcludedPath('vendor/lib/x.ts', ['vendor/lib']), true);
    assert.equal(isExcludedPath('vendor/lib', ['vendor/lib/']), false, 'prefixes are normalized before matching');
    assert.equal(isExcludedPath('vendor/libx/a.ts', ['vendor/lib']), false);
    assert.equal(isExcludedPath('src/app.ts', ['vendor/lib']), false);
    assert.equal(isExcludedPath('src/app.ts', []), false);
  });

  it('pauses the whole repository from the committed repo.json, and resumes on demand', () => {
    const rt = boot();
    try {
      rt.store.upsertEntry(rule('K-900101'), 'project', null);
      const live = rt.compileBeforeTurn({ sessionId: 's1', turnId: '1', userPrompt: '重复扣款怎么防', activeFiles: ['src/order/write.ts'] });
      assert.ok(live.surfacedIds.includes('K-900101'), 'the rule reaches the turn before pausing');

      rt.store.setProjectSettings({ enabled: false });
      const committed = JSON.parse(fs.readFileSync(rt.store.paths.repoProfileFile, 'utf8'));
      assert.equal(committed.settings.enabled, false, 'the switch travels with the repository');
      assert.equal(rt.compileResidentSystemSection(), '', 'no system section');
      const view = rt.compileBeforeTurn({ sessionId: 's1', turnId: '1', userPrompt: '新增订单写入路径要注意什么' });
      assert.deepEqual([view.residentPrefix, view.radarBlock, view.surfacedIds], ['', '', []], 'no reminders at all');
      const payload = readTool('src/order/write.ts');
      assert.equal(rt.handleAfterTool(payload), payload.result, 'file results pass through untouched');

      rt.store.setProjectSettings({ enabled: true });
      const resumed = rt.compileBeforeTurn({ sessionId: 's2', turnId: '1', userPrompt: '重复扣款怎么防', activeFiles: ['src/order/write.ts'] });
      assert.ok(resumed.surfacedIds.includes('K-900101'), 'resuming restores the reminders');
    } finally {
      rt.dispose();
    }
  });

  it('keeps the file guard out of excluded paths, and only out of them', () => {
    const rt = boot();
    try {
      rt.store.upsertEntry(rule('K-900201', { watch_paths: ['vendor/lib/x.ts', 'src/order/write.ts'] }), 'project', null);

      const vendorRead = readTool('vendor/lib/x.ts');
      const guarded = rt.handleAfterTool(vendorRead);
      assert.notEqual(guarded, vendorRead.result, 'watched file gets the mid-turn guard');
      assert.match((guarded.content.at(-1) as { text: string }).text, /accremind-guard/);

      rt.store.setProjectSettings({ excludePaths: ['vendor/lib'] });
      assert.deepEqual(JSON.parse(fs.readFileSync(rt.store.paths.repoProfileFile, 'utf8')).settings.excludePaths, ['vendor/lib']);
      const quiet = readTool('vendor/lib/x.ts');
      assert.equal(rt.handleAfterTool(quiet), quiet.result, 'excluded prefix: no guard');
      const otherSession = { ...readTool('src/order/write.ts'), sessionId: 's2' };
      const stillGuarded = rt.handleAfterTool(otherSession);
      assert.match((stillGuarded.content.at(-1) as { text: string }).text, /accremind-guard/, 'other paths keep the guard');
    } finally {
      rt.dispose();
    }
  });
});
