import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  LlmUsageMeter,
  LocalMarkdownSqliteStore,
  ViewCompiler,
  meterLlm,
  runEvaluation,
  type KnowledgeEntry,
  type LlmInferenceAdapter,
} from '@accremind/core';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function ws() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-obs-'));
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'repo', 'src/order'), { recursive: true });
  return { projectRoot: path.join(base, 'repo'), globalDir: path.join(base, 'g') };
}

function card(id: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id, revision: 1, type: 'pitfall', polarity: 'avoid', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: '订单写入必须先落事件再写账务', search_aliases: ['重复扣款', '幂等'], claim: '新增订单写入路径时先写事件表，再更新账务，保证重复回调不会重复扣款。',
    knowledge_delta: '增量', rationale: 'r', preconditions: ['新增或修改订单写入链路'], exclusions: [], dependency_constraints: [],
    watch_paths: ['src/order/write.ts'], symbol_anchors: [], invalidation_triggers: ['t'], verification_method: 'v',
    alternatives: [], enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active', maturity: 'verified',
    freshness: 'current', serving: 'enabled', priority: 'P0', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'EV-1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: 's' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: new Date(Date.now() + 90 * 864e5).toISOString(),
    ...over,
  };
}

function open(llm: LlmInferenceAdapter | null = null) {
  const { projectRoot, globalDir } = ws();
  return createAccreMindRuntime({ projectRoot, globalDir, llmAdapter: llm, autoCapture: { enabled: false } });
}

describe('模型用量计数', () => {
  it('counts calls and tokens per kind, including calls that fail or report no tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-usage-'));
    dirs.push(dir);
    const meter = new LlmUsageMeter(path.join(dir, 'usage', 'llm-usage.jsonl'));
    const ok: LlmInferenceAdapter = { async completeJson() { return { content: '{}', tokenUsed: 42 }; } };
    const tag = meterLlm(ok, meter, 'tag');
    await tag.completeJson({ systemPrompt: 's', userPrompt: 'u' });
    await tag.completeJson({ systemPrompt: 's', userPrompt: 'u2' });
    const failing = meterLlm({ async completeJson() { throw new Error('boom'); } }, meter, 'capture');
    await assert.rejects(failing.completeJson({ systemPrompt: 's', userPrompt: 'u3' }));

    const sum = meter.read(7);
    assert.equal(sum.calls, 3);
    assert.equal(sum.tokens, 84);
    assert.equal(sum.callsWithoutTokens, 1, 'a failed call is still a call, just without tokens');
    assert.deepEqual(sum.byKind.tag, { calls: 2, tokens: 84 });
    assert.deepEqual(sum.byKind.capture, { calls: 1, tokens: 0 });
    assert.equal(sum.byDay.length, 1);
  });
});

describe('评估的对照基线', () => {
  it('reports nothing-shown and rules-only arms next to the real reminder path', () => {
    const rt = open();
    try {
      rt.store.upsertEntry(card('K-900001'), 'project', null);
      const casesFile = path.join(rt.store.paths.projectAccreMindDir, 'eval', 'cases.jsonl');
      fs.mkdirSync(path.dirname(casesFile), { recursive: true });
      fs.writeFileSync(casesFile, [
        JSON.stringify({ query: '订单写入怎么防重复扣款', files: ['src/order/write.ts'], expect: ['K-900001'] }),
        JSON.stringify({ query: 'README 中英文两版怎么保持一致' }),
      ].join('\n'));

      const report = runEvaluation(rt.store, { casesFile });
      assert.equal(report.current.recall, 1, 'the reminder path finds the entry');
      assert.equal(report.baseline.off.recall, 0, 'without AccreMind nothing is shown');
      assert.equal(report.baseline.off.noise, 0);
      assert.equal(report.baseline.rulesOnly.recall, 0, 'a project entry is not a resident team rule');
      assert.equal(report.baseline.lift.recall, 1);
      assert.ok(report.baseline.lift.score > 0);
      assert.equal(report.cases.hand, 2);
    } finally {
      rt.dispose();
    }
  });
});

describe('工具护栏的文件级缓存', () => {
  it('searches a file once per index version and still tells a second session', () => {
    const rt = open();
    try {
      const entry = rt.store.upsertEntry(card('K-900002'), 'project', null);
      const vc = new ViewCompiler(rt.store, { residentRulesTokens: 500, turnRadarTokens: 300, toolGuardTokens: 240 });
      const first = vc.compileFileToolGuard({ sessionId: 's1', filePath: 'src/order/write.ts', sessionSurfacedIds: new Set() });
      assert.deepEqual(first.newlySurfacedIds, [entry.id]);
      const second = vc.compileFileToolGuard({ sessionId: 's2', filePath: 'src/order/write.ts', sessionSurfacedIds: new Set() });
      assert.deepEqual(second.newlySurfacedIds, [entry.id], 'the other session still gets the reminder');
      assert.equal(vc.guardStats.searches, 1);
      assert.equal(vc.guardStats.cacheHits, 1);
      // A write to the index invalidates the cached hits.
      rt.store.upsertEntry(card('K-900003', { title: '订单写入前先校验幂等键' }), 'project', null);
      vc.compileFileToolGuard({ sessionId: 's3', filePath: 'src/order/write.ts', sessionSurfacedIds: new Set() });
      assert.equal(vc.guardStats.searches, 2);
    } finally {
      rt.dispose();
    }
  });
});

describe('系统前缀固定', () => {
  it('keeps the cached prefix byte-stable and delivers a mid-conversation rule as one ephemeral note', () => {
    const rt = open();
    try {
      rt.store.upsertEntry(card('K-900004', { layer: 'team_rule', title: '提交前必须跑 verify', claim: '每次提交前先跑 pnpm verify。' }), 'rules', null);
      const prefixes: string[] = [];
      const ephemerals: string[] = [];
      const hook = (turnId: string) => ({
        sessionId: 's-prefix', turnId, userPrompt: '帮我改一下订单写入',
        injectSystemStablePrefix: (t: string) => prefixes.push(t),
        injectTurnEphemeralContext: (t: string) => ephemerals.push(t),
      });
      rt.compileBeforeTurn(hook('1'));
      assert.equal(prefixes.length, 1);
      const pinned = prefixes[0]!;
      assert.match(pinned, /K-900004/);

      // A second rule is accepted mid-conversation: the prefix stays byte-identical, the change arrives ephemerally.
      rt.store.upsertEntry(card('K-900005', { layer: 'team_rule', title: '提交信息用中文', claim: '提交信息用中文写清动机。' }), 'rules', null);
      rt.compileBeforeTurn(hook('2'));
      assert.equal(prefixes[1], pinned, 'prompt cache stays valid');
      assert.match(ephemerals.at(-1)!, /accremind-rule-update/);
      assert.match(ephemerals.at(-1)!, /K-900005/);
      assert.doesNotMatch(ephemerals.at(-1)!, /K-900004/);

      // A new session starts from the current rules, so the pinned prefix is refreshed there.
      rt.compileBeforeTurn({ sessionId: 's-new', turnId: '1', userPrompt: '新会话', injectSystemStablePrefix: (t: string) => prefixes.push(t) });
      assert.match(prefixes.at(-1)!, /K-900005/);
    } finally {
      rt.dispose();
    }
  });
});