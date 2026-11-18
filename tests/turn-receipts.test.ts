import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';
import type { KnowledgeEntry } from '@accremind/core';

async function setup(t: { after(cleanup: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'accremind-receipts-'));
  const config = { projectRoot: join(dir, 'repo'), globalDir: join(dir, 'local'), llmAdapter: null };
  const runtime = createAccreMindRuntime(config);
  t.after(() => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const rpc = (name: string, params: Record<string, unknown> = {}): any => runtime.rpcHandlers['accremind.' + name]!(params);
  const captured = await rpc('capture.manual', {
    question: '部署期间需要考虑什么？', discoverability: 'missing_context', disposition: 'knowledge_candidate',
    baseline_answer: '代码中存在重试。', knowledge_delta: '滚动发布阶段旧实例仍可能重试相同账单。',
    claim: '结算必须保留幂等键', title: 'Invoice retry', rationale: '重复请求在滚动窗口曾导致两次结算。',
    search_aliases: ['invoiceretry'], type: 'pitfall', priority: 'P0',
    preconditions: ['滚动发布'], invalidation_triggers: ['改用原子去重后复核'],
    file_locator: 'src/invoice.ts#L4-L7', verification_method: '运行并发结算回归',
  });
  const { id, revision } = captured.persistedEntry as KnowledgeEntry;
  const compile = (sessionId: string, turnId: string, hit = true) => runtime.compileBeforeTurn({
    sessionId, turnId, userPrompt: hit ? 'invoiceretry' : 'XYZ_NOT_A_MATCH',
  });
  return { config, runtime, rpc, id, revision, compile };
}

it('keeps simulator read-only and defers third-exposure retirement until its real turn can receive feedback', async t => {
  const { runtime, rpc, id, compile } = await setup(t);
  for (let i=0; i<5; i++) rpc('sim.compile', { userPrompt: 'invoiceretry', midTurnToolFile: 'src/invoice.ts' });
  assert.deepEqual(rpc('turn.list').receipts, []);
  assert.equal(runtime.store.listEntriesForAdmin()[0]!.probationExposures, 0);
  for (let i=1; i<=3; i++) {
    const session = 'session-' + i;
    compile(session, '1');
    compile(session, '1');
    assert.equal(runtime.store.listEntriesForAdmin()[0]!.probationExposures, i);
    if (i < 3) await runtime.handleTurnCompleted({ sessionId: session });
  }
  const simultaneous = compile('concurrent', '1', false);
  assert.deepEqual(simultaneous.surfacedIds, []);
  assert.equal(rpc('kb.get', {id}).entry.status, 'probation');
  assert.equal(rpc('turn.list',{sessionId:'session-3', turnId:'1'}).receipts[0].hits.length,1);
  await runtime.handleTurnCompleted({sessionId:'session-3'});
  compile('next-task', '1', false);
  assert.equal(rpc('kb.get', {id}).entry.status, 'archived');
  const hit = rpc('turn.list',{sessionId:'session-3'}).receipts[0].hits[0];
  assert.equal(hit.status, 'probation');
  assert.equal(hit.currentStatus, 'archived');
});

it('deduplicates verified feedback by task, binds revision, and keeps suspension and freshness independent', async t => {
  const { runtime, config, rpc, id, revision, compile } = await setup(t);
  const ref = { id, revision, sessionId:'task-one', turnId:'1' };
  compile('task-one', '1');
  rpc('probation.decide', { ...ref, action:'promote' });
  assert.throws(() => rpc('feedback.submit',{id, kind:'verified_effective', detail:'passed'}), /任务/);
  compile('task-one', '2');
  const verify = { ...ref, kind:'verified_effective', detail:'重放两笔并发账单，数据库均只提交一次。' };
  const first = rpc('feedback.submit', verify);
  const again = rpc('feedback.submit', { ...verify, turnId:'2' });
  assert.equal(first.record.id, again.record.id);
  assert.equal(again.updatedEntry.maturity,'verified');
  assert.equal(rpc('turn.list',{sessionId:'task-one'}).receipts[0].hits[0].feedback,'success');
  assert.throws(() => rpc('feedback.submit',{...verify, sessionId:'unseen'}), /未引用/);
  compile('task-two', '1');
  assert.equal(rpc('feedback.submit',{...verify, sessionId:'task-two'}).updatedEntry.maturity,'proven');
  rpc('feedback.submit',{...verify, kind:'suspected_error', detail:'第三次重放出现重复记账。'});
  assert.equal(rpc('turn.list',{sessionId:'task-one'}).receipts[0].hits[0].feedback,'failure');
  assert.throws(() => rpc('feedback.submit',verify), /反证/);
  const due = rpc('kb.get', {id}).entry as KnowledgeEntry;
  runtime.store.updateExistingEntryDirect({...due, freshness:'review_due'});
  const saved = rpc('kb.saveRevision',{id, expectedRevision:revision, revisionImpact:'editorial', patch:{title:'Invoice retries'}});
  assert.equal(saved.entry.serving,'suspended');
  assert.equal(saved.entry.freshness,'review_due');
  assert.equal(saved.entry.review_due_at,due.review_due_at);
  assert.throws(() => rpc('kb.saveRevision',{id, patch:{serving:'enabled'}}), /字段/);
  assert.throws(() => rpc('feedback.submit',verify), /版本/);
  assert.throws(() => rpc('gov.resolveConflict',{id,revision:saved.entry.revision,reason:'已回归'}), /时效/);
  runtime.store.updateExistingEntryDirect({...saved.entry, freshness:'current'});
  assert.equal(rpc('gov.resolveConflict',{id,revision:saved.entry.revision,reason:'已核对新代码与回归结果'}).serving,'enabled');
  const second = createAccreMindRuntime(config);
  try {
    const result:any = second.rpcHandlers['accremind.turn.list']!({sessionId:'task-one',turnId:'1'});
    assert.equal(result.receipts[0].hits[0].revision, revision);
    assert.equal(result.receipts[0].hits[0].currentRevision, revision + 1);
  } finally { second.dispose(); }
});

it('can promote on the last real exposure but refuses promotion and validation after a counterexample',async t => {
  const {rpc,id,compile,revision} = await setup(t);
  compile('one','1'); compile('one','2'); compile('one','3');
  const ref = {id,revision,sessionId:'one',turnId:'3'};
  const current = rpc('kb.get',{id}).entry;
  assert.equal(current.status,'probation');
  rpc('feedback.submit',{...ref, kind:'suspected_error', detail:'并发回放失败'});
  assert.throws(() => rpc('probation.decide',{...ref, action:'promote'}), /试用状态/);
  assert.throws(() => rpc('feedback.submit',{...ref,kind:'verified_effective',detail:'重试'}), /反证/);
  rpc('gov.resolveConflict',{id,revision,reason:'核对该回放使用了旧测试数据，最新账本无重复'});
  assert.equal(rpc('probation.decide',{...ref, action:'promote'}).status,'active');
});
