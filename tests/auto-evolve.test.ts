import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_TUNING,
  LocalMarkdownSqliteStore,
  autoTuneStatus,
  mergeTuning,
  readTuningHistory,
  rollbackTuning,
  runAutoTune,
  tuningHash,
  type EvalCase,
  type EvalMetrics,
  type KnowledgeEntry,
  type RetrievalTuning,
} from '@accremind/core';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function ws() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-evolve-'));
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'repo'));
  return { projectRoot: path.join(base, 'repo'), globalDir: path.join(base, 'g') };
}

const DAY = 86_400_000;

function card(id: string, over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id, revision: 1, type: 'pitfall', polarity: 'avoid', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: `调用支付接口前要检查 ${id}`, search_aliases: [], claim: '调用支付接口前必须先校验签名并记录请求编号。', knowledge_delta: '增量', rationale: 'r',
    preconditions: ['前提'], exclusions: [], dependency_constraints: [], watch_paths: [], symbol_anchors: [], invalidation_triggers: ['t'],
    verification_method: 'v', alternatives: [], enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active',
    maturity: 'verified', freshness: 'current', serving: 'enabled', priority: 'P1', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'EV-1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: 's' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: new Date(Date.now() + 90 * DAY).toISOString(),
    ...over,
  };
}

/** Records `n` sessions that were shown the entry (and optionally reported it / used it) starting `daysAgo`. */
function usage(store: LocalMarkdownSqliteStore, entryId: string, opts: { shown: number; inapplicable?: number; used?: number; daysAgo?: number }) {
  const ins = store.rawDb.prepare(`INSERT INTO usage_events (event_id, workspace_id, session_id, entry_id, revision, event_type, detail, created_at)
    VALUES (?, ?, ?, ?, 1, ?, NULL, ?)`);
  const start = Date.now() - (opts.daysAgo ?? 1) * DAY;
  for (let i = 0; i < opts.shown; i++) {
    const at = new Date(start + i * 1000).toISOString();
    ins.run(`EVU-${randomUUID()}`, store.workspaceId, `s${i}`, entryId, 'radar_shown', at);
    if (i < (opts.inapplicable ?? 0)) ins.run(`EVU-${randomUUID()}`, store.workspaceId, `s${i}`, entryId, 'feedback_inapplicable', at);
    if (i < (opts.used ?? 0)) ins.run(`EVU-${randomUUID()}`, store.workspaceId, `s${i}`, entryId, 'cited', at);
  }
}

function statusOf(store: LocalMarkdownSqliteStore, id: string) {
  const got = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
  assert.ok(got.found && got.servable);
  return { status: got.entry.status, serving: got.entry.serving };
}

describe('Automatic demotion of low-value entries', () => {
  it('demotes a confirmed entry that keeps not fitting, and a person can undo it for good', () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      store.upsertEntry(card('K-DEMOTE00000001'), 'project', null);
      usage(store, 'K-DEMOTE00000001', { shown: 4, inapplicable: 2 });
      const out = store.runAutoDemotion();
      assert.deepEqual(out.demoted, ['K-DEMOTE00000001']);
      assert.deepEqual(statusOf(store, 'K-DEMOTE00000001'), { status: 'probation', serving: 'enabled' });
      const file = store.rawDb.prepare('SELECT file_path FROM entries WHERE id = ?').get('K-DEMOTE00000001') as { file_path: string };
      assert.match(fs.readFileSync(file.file_path, 'utf8'), /"?status"?:\s*"?probation/, 'the change is visible in the Markdown file (and in Git)');
      const [rec] = store.listAutoDemotions();
      assert.equal(rec!.step, 'demote');
      assert.match(rec!.reason, /2 个会话反馈“不适用”/);
      assert.ok(store.listAttentionItems().some((a) => a.entry_id === 'K-DEMOTE00000001' && a.kind === 'auto_demoted'));

      const restored = store.restoreAutoDemotion('K-DEMOTE00000001');
      assert.deepEqual([restored.status, restored.serving], ['active', 'enabled']);
      assert.equal(store.listAutoDemotions().length, 0);
      assert.equal(store.listAutoDemotions({ includeReverted: true })[0]!.reverted_at !== null, true);
      assert.ok(!store.listAttentionItems().some((a) => a.entry_id === 'K-DEMOTE00000001'));
      assert.deepEqual(store.runAutoDemotion().demoted, [], 'a revision a person kept is left alone');
      assert.throws(() => store.restoreAutoDemotion('K-DEMOTE00000001'), /没有尚未撤销/);
    } finally {
      store.close();
    }
  });

  it('demotes an entry shown for weeks that nobody ever used, but not one that was used once', () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      store.upsertEntry(card('K-UNUSED00000001'), 'project', null);
      store.upsertEntry(card('K-USEDONCE000001'), 'project', null);
      store.upsertEntry(card('K-RECENT00000001'), 'project', null);
      usage(store, 'K-UNUSED00000001', { shown: 40, daysAgo: 35 });
      usage(store, 'K-USEDONCE000001', { shown: 40, used: 1, daysAgo: 35 });
      usage(store, 'K-RECENT00000001', { shown: 40, daysAgo: 5 });
      const out = store.runAutoDemotion();
      assert.deepEqual(out.demoted, ['K-UNUSED00000001']);
      assert.match(store.listAutoDemotions()[0]!.reason, /从未被打开、引用或确认/);
    } finally {
      store.close();
    }
  });

  it('never touches team rules, confirmed wording, shared entries, or anything when switched off', () => {
    const { projectRoot, globalDir } = ws();
    const store = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    try {
      store.upsertEntry(card('K-RULE000000001A', { layer: 'team_rule' }), 'rules', null);
      store.upsertEntry(card('K-CONFIRMED0001A'), 'project', null);
      store.upsertEntry(card('K-SHARED0000001A', { layer: 'shared_tech' }), 'shared_tech', null);
      for (const id of ['K-RULE000000001A', 'K-CONFIRMED0001A', 'K-SHARED0000001A']) usage(store, id, { shown: 4, inapplicable: 3 });
      store.importDemoActivity([{ kind: 'validation', entryId: 'K-CONFIRMED0001A', revision: 1, outcome: 'success', at: new Date().toISOString() }]);
      assert.deepEqual(store.runAutoDemotion().demoted, []);
    } finally {
      store.close();
    }
    const off = new LocalMarkdownSqliteStore({ projectRoot, globalDir, autoDemotion: false });
    try {
      off.upsertEntry(card('K-OFF0000000001A'), 'project', null);
      usage(off, 'K-OFF0000000001A', { shown: 4, inapplicable: 3 });
      assert.deepEqual(off.runAutoDemotion(), { demoted: [], archived: [] });
    } finally {
      off.close();
    }
  });

  it('archives an entry paused for low value that nobody decided on, unless someone did; restoring brings it back', () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      for (const id of ['K-ARCHIVE0000001', 'K-DECIDED0000001']) {
        store.upsertEntry(card(id), 'project', null);
        usage(store, id, { shown: 1 });
        for (let i = 0; i < 3; i++) store.recordInapplicable(id, `bad-${i}`, '无关');
        assert.deepEqual(statusOf(store, id), { status: 'active', serving: 'suspended' });
      }
      store.recordGovernanceDecision({ id: 'K-DECIDED0000001', revision: 1 }, 'note', '我在看');
      assert.deepEqual(store.runAutoDemotion({ now: new Date(Date.now() + 10 * DAY) }).archived, [], 'not before the wait');
      const later = store.runAutoDemotion({ now: new Date(Date.now() + 31 * DAY) });
      assert.deepEqual(later.archived, ['K-ARCHIVE0000001']);
      assert.equal(statusOf(store, 'K-ARCHIVE0000001').status, 'archived');
      assert.deepEqual(statusOf(store, 'K-DECIDED0000001'), { status: 'active', serving: 'suspended' });

      const back = store.restoreAutoDemotion('K-ARCHIVE0000001');
      assert.deepEqual([back.status, back.serving], ['active', 'enabled']);
    } finally {
      store.close();
    }
  });

  it('runs as part of maintenance', () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      store.upsertEntry(card('K-MAINT000000001'), 'project', null);
      usage(store, 'K-MAINT000000001', { shown: 3, inapplicable: 2 });
      assert.deepEqual(store.runMaintenance().demoted, ['K-MAINT000000001']);
    } finally {
      store.close();
    }
  });
});

describe('Automatic tuning with guardrails and rollback', () => {
  const labelled = (n: number): EvalCase[] => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, source: 'hand', query: `q${i}`, expect: ['K-X'], forbid: [] }));
  const m = (score: number, recall = 0.8, forbiddenShown = 0.1): EvalMetrics => ({ cases: 40, score, recall, forbiddenShown, noise: 0, misses: [] });
  /** Scores only the tag weight: 0.4 is best, 0.2 worst. */
  const byTag = (scores: Record<string, EvalMetrics>) => async (_c: EvalCase[], t: RetrievalTuning) => scores[String(t.weights.tag)] ?? m(0.5);

  it('changes nothing without enough labelled feedback', async () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      const out = await runAutoTune(store, { cases: () => labelled(5) });
      assert.equal(out.action, 'skipped');
      assert.match(out.reason, /样本不足/);
      assert.ok(!fs.existsSync(path.join(store.paths.globalRoot, 'tuning.json')));
      assert.equal((await runAutoTune(store, { cases: () => labelled(50) })).reason.includes('不足 7 天'), true, 'runs at most weekly');
    } finally {
      store.close();
    }
  });

  it('applies only a clearly better and safe variation, records it, and keeps it when it holds up', async () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      // 0.4 scores best but loses recall: refused. 0.2 is better and safe: applied.
      const unsafe = await runAutoTune(store, { cases: () => labelled(40), evaluator: byTag({ '0.3': m(0.5), '0.4': m(0.7, 0.6) }) });
      assert.equal(unsafe.action, 'skipped');
      assert.equal(tuningHash(store.tuning), tuningHash(DEFAULT_TUNING));
      const t0 = new Date();
      const applied = await runAutoTune(store, { now: t0, force: true, cases: () => labelled(40), evaluator: byTag({ '0.3': m(0.5), '0.2': m(0.56), '0.4': m(0.7, 0.6) }) });
      assert.equal(applied.action, 'apply');
      assert.equal(store.tuning.weights.tag, 0.2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(store.paths.globalRoot, 'tuning.json'), 'utf8')).weights.tag, 0.2);
      assert.equal(autoTuneStatus(store).watching?.label, applied.record!.label);

      const early = await runAutoTune(store, { now: new Date(t0.getTime() + DAY), cases: () => labelled(40), evaluator: byTag({}) });
      assert.equal(early.action, 'watching');
      const kept = await runAutoTune(store, { now: new Date(t0.getTime() + 4 * DAY), cases: () => labelled(20),
        evaluator: byTag({ '0.2': m(0.6), '0.3': m(0.59) }) });
      assert.equal(kept.action, 'kept');
      assert.equal(store.tuning.weights.tag, 0.2);
      assert.deepEqual(readTuningHistory(store).map((r) => r.action), ['kept', 'apply']);
    } finally {
      store.close();
    }
  });

  it('rolls back when the new settings do worse on the turns since, and does not retry them for a while', async () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      const t0 = new Date();
      await runAutoTune(store, { now: t0, cases: () => labelled(40), evaluator: byTag({ '0.3': m(0.5), '0.2': m(0.56) }) });
      assert.equal(store.tuning.weights.tag, 0.2);
      const out = await runAutoTune(store, { now: new Date(t0.getTime() + 4 * DAY), cases: () => labelled(20),
        evaluator: byTag({ '0.2': m(0.5), '0.3': m(0.6) }) });
      assert.equal(out.action, 'rollback');
      assert.equal(store.tuning.weights.tag, 0.3);
      assert.match(out.reason, /已回滚/);
      const retry = await runAutoTune(store, { now: new Date(t0.getTime() + 12 * DAY), cases: () => labelled(40),
        evaluator: byTag({ '0.3': m(0.5), '0.2': m(0.56) }) });
      assert.equal(retry.action, 'skipped', 'the rolled-back variation is on cool-down');
      assert.equal(store.tuning.weights.tag, 0.3);
    } finally {
      store.close();
    }
  });

  it('rolls back when people report "doesn\'t apply" much more often after the change', async () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      const t0 = new Date(Date.now() - 5 * DAY);
      await runAutoTune(store, { now: t0, cases: () => labelled(40), evaluator: byTag({ '0.3': m(0.5), '0.2': m(0.56) }) });
      const ins = store.rawDb.prepare(`INSERT INTO usage_events (event_id, workspace_id, session_id, entry_id, revision, event_type, detail, created_at)
        VALUES (?, ?, ?, 'K-A', 1, ?, NULL, ?)`);
      for (let i = 0; i < 60; i++) {
        const before = new Date(t0.getTime() - (i + 1) * 60_000).toISOString();
        const after = new Date(t0.getTime() + (i + 1) * 60_000).toISOString();
        ins.run(`E-${randomUUID()}`, store.workspaceId, `b${i}`, 'radar_shown', before);
        ins.run(`E-${randomUUID()}`, store.workspaceId, `a${i}`, 'radar_shown', after);
        if (i < 3) ins.run(`E-${randomUUID()}`, store.workspaceId, `b${i}`, 'feedback_inapplicable', before);
        if (i < 15) ins.run(`E-${randomUUID()}`, store.workspaceId, `a${i}`, 'feedback_inapplicable', after);
      }
      const out = await runAutoTune(store, { cases: () => [], evaluator: byTag({}) });
      assert.equal(out.action, 'rollback');
      assert.match(out.reason, /不适用”比例/);
      assert.equal(store.tuning.weights.tag, 0.3);
    } finally {
      store.close();
    }
  });

  it('a person can undo the latest change at any time; a change made elsewhere is picked up', async () => {
    const store = new LocalMarkdownSqliteStore(ws());
    try {
      await runAutoTune(store, { cases: () => labelled(40), evaluator: byTag({ '0.3': m(0.5), '0.2': m(0.56) }) });
      const undo = rollbackTuning(store);
      assert.equal(undo.action, 'manual_rollback');
      assert.equal(store.tuning.weights.tag, 0.3);
      assert.equal(autoTuneStatus(store).watching, null);

      fs.writeFileSync(path.join(store.paths.globalRoot, 'tuning.json'), JSON.stringify(mergeTuning({ textSaturation: 9 })));
      await runAutoTune(store, { cases: () => labelled(3) });
      assert.equal(store.tuning.textSaturation, 9, 'another window\'s settings are adopted before judging');
    } finally {
      store.close();
    }
  });

  it('replays real recorded turns end to end and the plugin can be switched off', async () => {
    const { projectRoot, globalDir } = ws();
    const rt = createAccreMindRuntime({ projectRoot, globalDir, writeGate: 'off', llmAdapter: null, autoCapture: { enabled: false }, autoEvolve: { tune: false, demote: false } });
    try {
      assert.equal(rt.store.autoDemotionPolicy.enabled, false);
      const e = rt.store.upsertEntry(card('K-REAL000000001A', { title: '幂等键必须在重试前生成', claim: '重试必须复用第一次的幂等键。', search_aliases: ['幂等键'] }), 'project', null);
      rt.compileBeforeTurn({ sessionId: 'sess-1', turnId: '1', userPrompt: '重试的时候幂等键怎么处理' });
      await rt.rpcHandlers['accremind.feedback.submit']!({ id: e.id, revision: 1, kind: 'verified_effective', sessionId: 'sess-1', turnId: '1', detail: '有用' });
      const out = await runAutoTune(rt.store, { policy: { minCases: 1 } });
      assert.ok(['skipped', 'apply'].includes(out.action), out.reason);
      const status = await rt.rpcHandlers['accremind.tuning.status']!({}) as { lastRunAt: string | null };
      assert.ok(status.lastRunAt);
    } finally {
      rt.dispose();
    }
  });
});
