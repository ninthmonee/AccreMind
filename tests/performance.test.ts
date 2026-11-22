import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { LocalMarkdownSqliteStore, ViewCompiler, serializeEntryMarkdown, type KnowledgeEntry } from '@accremind/core';

// Budgets are deliberately loose (shared CI machines); the design targets are ~10x tighter.
const N = 2000;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-perf-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const projectRoot = path.join(base, 'repo');
const globalDir = path.join(base, 'g');
fs.mkdirSync(projectRoot, { recursive: true });

function entry(i: number): KnowledgeEntry {
  const now = '2026-11-21T00:00:00.000Z';
  return {
    id: `K-${String(i).padStart(5, '0')}`, revision: 1, type: 'pitfall', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: `支付回调幂等经验第${i}号 module${i % 50}`, search_aliases: ['重复扣款', `alias${i}`], claim: `第${i}条：回调必须按唯一键幂等处理`,
    knowledge_delta: '网关会重放', rationale: 'r', preconditions: ['p'], exclusions: [], dependency_constraints: [],
    watch_paths: [`src/mod${i % 200}/**`], symbol_anchors: [], invalidation_triggers: ['t'], verification_method: 'v', alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active', maturity: 'draft', freshness: 'current',
    serving: 'enabled', priority: i % 10 === 0 ? 'P0' : 'P1', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'E1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: 's' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: now,
  };
}

function p95(samples: number[]): number {
  return samples.sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]!;
}

describe(`Performance budgets with ${N} entries`, () => {
  const seed = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(seed.paths.projectEntriesDir, `${entry(i).id}.md`), serializeEntryMarkdown(entry(i)));
  let t = performance.now();
  seed.initializeAndReconcile();
  const firstReconcile = performance.now() - t;
  seed.close();

  it('indexes a fresh repository quickly and reopens without re-reading unchanged files', () => {
    assert.ok(firstReconcile < 5000, `first reconcile ${firstReconcile.toFixed(0)}ms`);
    const t0 = performance.now();
    const store = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    store.initializeAndReconcile();
    const reopen = performance.now() - t0;
    store.close();
    assert.ok(reopen < 600, `reopen ${reopen.toFixed(0)}ms`);
  });

  it('keeps the per-tool file reminder and the pre-step radar within budget', () => {
    const store = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    const vc = new ViewCompiler(store, { residentRulesTokens: 500, turnRadarTokens: 300, toolGuardTokens: 240 });
    const guard: number[] = [];
    for (let k = 0; k < 100; k++) {
      const t1 = performance.now();
      vc.compileFileToolGuard({ sessionId: 'g' + k, filePath: `src/mod${k % 200}/a.ts`, sessionSurfacedIds: new Set() });
      guard.push(performance.now() - t1);
    }
    const radar: number[] = [];
    for (let k = 0; k < 30; k++) {
      const t1 = performance.now();
      vc.compileTurnView({ sessionId: 'r' + k, userPrompt: '怎么防止支付回调重复扣款 module7' });
      radar.push(performance.now() - t1);
    }
    store.close();
    assert.ok(p95(guard) < 25, `file reminder p95 ${p95(guard).toFixed(1)}ms`);
    assert.ok(p95(radar) < 150, `radar p95 ${p95(radar).toFixed(1)}ms`);
  });

  it('sees entries written by another process without restarting', () => {
    const a = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    const b = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    a.search({ workspaceId: a.workspaceId, query: '独一无二的跨进程标记' }); // warm the snapshot
    b.upsertEntry({ ...entry(99_999), id: 'K-99999', title: '独一无二的跨进程标记条目' }, 'project', null);
    const hits = a.search({ workspaceId: a.workspaceId, query: '独一无二的跨进程标记' }).items.map((h) => h.entry.id);
    assert.ok(hits.includes('K-99999'));
    a.close();
    b.close();
  });
});
