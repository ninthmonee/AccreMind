import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  extractSymbolAnchor,
  GitStalenessScanner,
  LocalMarkdownSqliteStore,
  type CaptureAssessment,
  type KnowledgeEntry,
} from '@accremind/core';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setupTempGitRepo(): { repoRoot: string; globalDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m0-git-'));
  tempDirs.push(base);
  const repoRoot = path.join(base, 'repo');
  const globalDir = path.join(base, 'global');
  fs.mkdirSync(path.join(repoRoot, 'src/order'), { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });

  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'dev@example.com']);
  git(repoRoot, ['config', 'user.name', 'Dev']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { '@nestjs/typeorm': '10.0.2' } }, null, 2),
    'utf8',
  );

  return { repoRoot, globalDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('M0 Optimization #3: Symbol-Level Fingerprint Anchoring & Low-Noise Git Staleness', () => {
  it('silently relocates line numbers on formatting/unrelated edits, and marks review_due ONLY on real symbol body mutation', () => {
    const { repoRoot, globalDir } = setupTempGitRepo();
    const serviceRelPath = 'src/order/order.service.ts';
    const serviceAbsPath = path.join(repoRoot, serviceRelPath);

    const v1Code = [
      'export class OrderService {',
      '  async createOrder(dto: { id: string }) {',
      '    await this.repo.save(dto);',
      '    this.tx.afterCommit(() => this.mq.send(dto.id));',
      '    return dto.id;',
      '  }',
      '}',
      '',
    ].join('\n');

    fs.writeFileSync(serviceAbsPath, v1Code, 'utf8');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'feat: initial order service']);

    const anchor = extractSymbolAnchor(serviceRelPath, v1Code, 'OrderService.createOrder');
    assert.ok(anchor, 'Should extract OrderService.createOrder symbol anchor');
    assert.equal(anchor.start_line, 2);
    assert.equal(anchor.end_line, 6);

    const store = new LocalMarkdownSqliteStore({ projectRoot: repoRoot, globalDir });
    const scanner = new GitStalenessScanner(store);

    const assessment: CaptureAssessment = {
      id: 'CA-0100',
      workspace_id: store.workspaceId,
      source_fingerprint: 'fp-order-tx',
      question: '订单写入后何时发送下游 MQ 消息？',
      checked_context: {
        head_commit: 'HEAD',
        checked_files: [serviceRelPath],
        checked_docs: [],
        method: 'single_pass_check',
        token_used: 100,
        duration_ms: 50,
      },
      discoverability: 'missing_context',
      baseline_answer: '代码调用了 afterCommit',
      knowledge_delta: '高并发压测证明事务内直发会导致下游查无订单',
      claim_evidence_map: [
        {
          assertion: '必须走 afterCommit 钩子',
          evidence_locator: `${serviceRelPath}#L2-L6`,
          verified_fact: true,
        },
      ],
      omission_consequence: '下游消费者读不到未提交订单',
      priority: 'P0',
      disposition: 'knowledge_candidate',
      created_at: '2026-11-18T00:00:00.000Z',
    };

    const entry: KnowledgeEntry = {
      id: 'K-0100',
      revision: 1,
      type: 'pitfall',
      knowledge_role: 'experience',
      layer: 'project',
      title: '订单创建必须在 afterCommit 回调中发送 MQ',
      search_aliases: ['丢单', '事务提交回调'],
      claim: '禁止在 createOrder 事务闭包内直接调用 mq.send。',
      knowledge_delta: '压测复现过消费者快于 PG 提交落盘导致查无订单。',
      rationale: '网络投递快于复杂事务提交落盘。',
      preconditions: ['修改 OrderService.createOrder'],
      exclusions: [],
      dependency_constraints: [{ name: '@nestjs/typeorm', range: '^10.0.0' }],
      watch_paths: ['src/order/**/*.ts'],
      symbol_anchors: [anchor],
      invalidation_triggers: ['改为 Outbox 事务消息表后失效'],
      verification_method: 'pnpm test order-race',
      alternatives: [],
      enforcement: { kind: 'none', status: 'proposed', ref: null },
      status: 'active',
      maturity: 'verified',
      freshness: 'current',
      serving: 'enabled',
      priority: 'P0',
      capture_assessment_id: 'CA-0100',
      supersedes: null,
      evidence: [
        {
          id: 'EV-0100',
          source_type: 'file_lines',
          source_ref: serviceRelPath,
          locator: `${serviceRelPath}#L2-L6`,
          summary: 'afterCommit 事务绑定位置',
        },
      ],
      created_at: '2026-11-18T00:00:00.000Z',
      updated_at: '2026-11-18T00:00:00.000Z',
      last_validated_at: '2026-11-18T00:00:00.000Z',
      review_due_at: '2027-06-01T00:00:00.000Z',
    };

    store.upsertEntry(entry, 'project', assessment);
    scanner.scanWorkspace();

    // Commit 2: Add banner comments, a brand new unrelated method above createOrder, and extra whitespace!
    const v2ReformattedWithNewHelper = [
      '// Banner header added during refactor',
      'export function formatOrderCode(id: string): string {',
      '  return `ORD-${id}`;',
      '}',
      '',
      'export class OrderService {',
      '  async pingHealth(): Promise<boolean> {',
      '    return true;',
      '  }',
      '',
      '  async createOrder( dto: { id: string } ) {',
      '    // Added inline comment that does NOT alter logic!',
      '    await this.repo.save(dto);',
      '',
      '    this.tx.afterCommit(() => this.mq.send(dto.id));',
      '    return dto.id;',
      '  }',
      '}',
      '',
    ].join('\n');

    fs.writeFileSync(serviceAbsPath, v2ReformattedWithNewHelper, 'utf8');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'style: add helper and comments']);

    const reportAfterFormatting = scanner.scanWorkspace();
    assert.deepEqual(
      reportAfterFormatting.markedReviewDue,
      [],
      'Formatting & unrelated functions MUST NOT trigger false review_due!',
    );
    assert.deepEqual(reportAfterFormatting.relocatedEntries, ['K-0100']);

    const relocatedOut = store.getEntry('K-0100', { recordUsage: false });
    assert.ok(relocatedOut.found && relocatedOut.servable);
    assert.equal(relocatedOut.entry.freshness, 'current');
    assert.equal(relocatedOut.entry.symbol_anchors[0]!.start_line, 11);
    assert.equal(relocatedOut.entry.evidence[0]!.locator, 'src/order/order.service.ts#L11-L17');

    // Commit 3: Actually change the logic inside OrderService.createOrder (switch to outbox.enqueue)
    const v3ModifiedLogic = v2ReformattedWithNewHelper.replace(
      'this.tx.afterCommit(() => this.mq.send(dto.id));',
      'await this.outbox.enqueue(dto.id);',
    );
    fs.writeFileSync(serviceAbsPath, v3ModifiedLogic, 'utf8');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'refactor(order): migrate mq send to outbox table']);

    const reportAfterLogicChange = scanner.scanWorkspace();
    assert.equal(reportAfterLogicChange.markedReviewDue.length, 1);
    assert.equal(reportAfterLogicChange.markedReviewDue[0]!.entryId, 'K-0100');
    assert.match(reportAfterLogicChange.markedReviewDue[0]!.reason, /OrderService\.createOrder/);

    const staleOut = store.getEntry('K-0100', { recordUsage: false });
    assert.ok(staleOut.found && staleOut.servable);
    assert.equal(staleOut.entry.freshness, 'review_due');
    // The actual patch and detection reason survive a second scan and a pause.
    scanner.scanWorkspace();
    const review = scanner.reviewDetails(staleOut.entry);
    assert.match(review.reason, /OrderService.createOrder/);
    assert.match(review.diff, /-.*this.tx.afterCommit/);
    assert.match(review.diff, /\+.*this.outbox.enqueue/);
    const paused = store.updateExistingEntryDirect({...staleOut.entry, serving:'suspended'});
    const confirmed = scanner.confirmFresh(paused);
    assert.equal(confirmed.serving, 'suspended');
    assert.equal(confirmed.freshness, 'current');
    assert.notEqual(confirmed.symbol_anchors[0]?.normalized_sha256, anchor.normalized_sha256);
    assert.equal(scanner.scanWorkspace().markedReviewDue.length, 0);

    store.close();
  });
});
