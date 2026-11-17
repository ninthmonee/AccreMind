import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  LocalMarkdownSqliteStore,
  parseEntryMarkdown,
  serializeEntryMarkdown,
  type CaptureAssessment,
  type KnowledgeEntry,
} from '@accremind/core';

const tempDirs: string[] = [];

function makeTempWorkspace(): { projectRoot: string; globalDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m0-store-'));
  tempDirs.push(base);
  const projectRoot = path.join(base, 'repo');
  const globalDir = path.join(base, 'global-dsh');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  return { projectRoot, globalDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sampleAssessment(workspaceId: string, id = 'CA-0001'): CaptureAssessment {
  return {
    id,
    workspace_id: workspaceId,
    source_fingerprint: `fp-${id}`,
    question: '订单支付回调并发到达时如何防止重复入账？',
    checked_context: {
      head_commit: 'abc1234',
      checked_files: ['src/payment/callback.ts'],
      checked_docs: ['README.md'],
      method: 'single_pass_check',
      token_used: 420,
      duration_ms: 120,
    },
    discoverability: 'missing_context',
    baseline_answer: '代码仅展示了调用 ledger.credit()，未说明第三方网关会并发重放同一通知。',
    knowledge_delta: '第三方支付网关在超时 1s 时会并发投递相同 notify_id，必须依赖数据库唯一键幂等拦截。',
    claim_evidence_map: [
      {
        assertion: '网关超时重放需唯一索引拦截',
        evidence_locator: 'src/payment/callback.ts#L30-L55',
        verified_fact: true,
      },
    ],
    omission_consequence: '先查后插在高并发下会出现双倍入账事故',
    priority: 'P0',
    disposition: 'knowledge_candidate',
    created_at: '2026-11-18T00:00:00.000Z',
  };
}

function sampleEntry(id = 'K-0001', assessmentId = 'CA-0001'): KnowledgeEntry {
  return {
    id,
    revision: 1,
    type: 'pitfall',
    knowledge_role: 'experience',
    layer: 'project',
    title: '支付回调必须依赖 idempotency_key 唯一索引防并发重入',
    search_aliases: ['重复扣款', '重复入账', '防重', '幂等', 'double charge'],
    claim: '严禁用 SELECT 再 INSERT 判断回调幂等，必须直接 INSERT 捕获唯一键冲突。',
    knowledge_delta: '第三方网关存在同毫秒双发重试行为，先查后插在压测下已证实产生双入账。',
    rationale: '隔离级别 READ COMMITTED 下两个并发事务同时查到空记录。',
    preconditions: ['接入第三方异步支付回调接口'],
    exclusions: [],
    dependency_constraints: [{ name: 'pg', range: '^8.0.0' }],
    watch_paths: ['src/payment/**/*.ts'],
    symbol_anchors: [],
    invalidation_triggers: ['切换至统一网关幂等中间件后复核'],
    verification_method: '运行 pnpm test src/payment/callback-race.spec.ts',
    alternatives: [
      {
        option: 'Redis 分布式锁',
        rejected_because: '锁过期时间难以覆盖极端 GC 停顿，数据库唯一键才是最终兜底',
        evidence_id: 'EV-0001',
      },
    ],
    enforcement: { kind: 'test', status: 'implemented', ref: 'src/payment/callback-race.spec.ts' },
    status: 'active',
    maturity: 'verified',
    freshness: 'current',
    serving: 'enabled',
    priority: 'P0',
    capture_assessment_id: assessmentId,
    supersedes: null,
    evidence: [
      {
        id: 'EV-0001',
        source_type: 'git_commit',
        source_ref: 'abc1234',
        locator: 'src/payment/callback.ts#L30-L55',
        summary: '并发重放压测复现与修复对照',
      },
    ],
    created_at: '2026-11-18T00:00:00.000Z',
    updated_at: '2026-11-18T00:00:00.000Z',
    last_validated_at: '2026-11-18T00:00:00.000Z',
    review_due_at: '2027-02-18T00:00:00.000Z',
  };
}

describe('M0 Store, Markdown Codec & Bilingual Alias FTS5 Recall', () => {
  it('roundtrips Markdown frontmatter + sections deterministically', () => {
    const original = sampleEntry();
    const md = serializeEntryMarkdown(original);
    const parsed = parseEntryMarkdown(md);
    assert.deepEqual(parsed, original);
    assert.equal(serializeEntryMarkdown(parsed), md);
  });

  it('reconstructs 100% losslessly when accremind.sqlite is deleted and isolates Git conflict files', () => {
    const { projectRoot, globalDir } = makeTempWorkspace();
    const store = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    const assessment = sampleAssessment(store.workspaceId);
    const entry = sampleEntry();

    store.upsertEntry(entry, 'project', assessment);

    // Drop a conflicted Markdown file into .accremind/entries/ to simulate an unresolved git merge
    const conflictPath = path.join(store.paths.projectEntriesDir, 'K-9999.md');
    fs.writeFileSync(
      conflictPath,
      ['---', 'id: "K-9999"', '<<<<<<< HEAD', 'title: "A"', '=======', 'title: "B"', '>>>>>>> main', '---'].join('\n'),
      'utf8',
    );

    store.close();
    // Delete the entire SQLite database file + WAL/SHM
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${store.paths.sqlitePath}${suffix}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    const reopened = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    const stats = reopened.rebuildIndexFromScratch();
    assert.equal(stats.syncedCount, 1);
    assert.equal(stats.corruptedCount, 1);

    const corrupted = reopened.listCorruptedFiles();
    assert.equal(corrupted.length, 1);
    assert.match(corrupted[0]!.reason, /Git 合并冲突/);

    // Healthy entry remains 100% intact and searchable via colloquial alias "重复扣款"
    const res = reopened.search({
      workspaceId: reopened.workspaceId,
      query: '怎么防止重复扣款',
      workspaceDependencies: { pg: '8.11.3' },
    });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0]!.entry.id, 'K-0001');

    reopened.close();
  });

  it('classifies L3 zero-result reasons accurately (version_excluded vs suspended_conflict)', () => {
    const { projectRoot, globalDir } = makeTempWorkspace();
    const store = new LocalMarkdownSqliteStore({ projectRoot, globalDir });
    const assessment = sampleAssessment(store.workspaceId);
    const entry = sampleEntry();
    store.upsertEntry(entry, 'project', assessment);

    // Incompatible pg major version 9.0.0 vs ^8.0.0 -> zeroReason = version_excluded
    const incompatible = store.search({
      workspaceId: store.workspaceId,
      query: '重复扣款',
      workspaceDependencies: { pg: '9.0.0' },
    });
    assert.equal(incompatible.items.length, 0);
    assert.equal(incompatible.zeroReason, 'version_excluded');

    // Failure validation suspends serving -> zeroReason = suspended_conflict
    store.submitValidation({
      entryId: 'K-0001',
      sessionId: 'sess-2',
      taskFingerprint: 'task-fail-1',
      outcome: 'failure',
      evidenceNote: '新网关已内置全局去重，原结论在 v2 接口不再成立',
    });

    const suspendedSearch = store.search({
      workspaceId: store.workspaceId,
      query: '重复扣款',
      workspaceDependencies: { pg: '8.11.3' },
    });
    assert.equal(suspendedSearch.items.length, 0);
    assert.equal(suspendedSearch.zeroReason, 'suspended_conflict');

    store.close();
  });
});
