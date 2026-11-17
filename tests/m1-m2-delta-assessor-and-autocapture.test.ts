import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AutoCaptureCoordinator,
  collectEvidenceBundle,
  DeltaAssessor,
  evaluateSessionSignals,
  LocalMarkdownSqliteStore,
  runArchaeologyBootstrap,
  TriageEngine,
  type LlmCompletionRequest,
  type LlmInferenceAdapter,
} from '@accremind/core';

const tempDirs: string[] = [];

function git(cwd: string, args: string[], envOverrides?: Record<string, string>): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, ...envOverrides },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('M1-A & M2: DeltaAssessor (Isolated Blind Check), SignalDetector & Durable AutoCapture Queue', () => {
  it('enforces strict blind isolation in isolated_p0 mode (Pass 1 never sees troubleshooting answer) and binds symbol anchors', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m1a-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'src/cache.ts'),
      [
        'export async function refreshTokenCache(userId: string) {',
        '  const token = await fetchToken(userId);',
        '  await redis.set(`tok:${userId}`, token, "EX", 300);',
        '  return token;',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Demo Service\nToken helper.\n', 'utf8');

    const store = new LocalMarkdownSqliteStore({ projectRoot: repoRoot, globalDir });
    const recordedCalls: LlmCompletionRequest[] = [];

    const secretAnswerClue = 'SECRET_TROUBLESHOOTING_CLUE_REDIS_CLUSTER_HASH_TAG';

    const mockLlm: LlmInferenceAdapter = {
      async completeJson(req) {
        recordedCalls.push(req);
        if (recordedCalls.length === 1) {
          // Pass 1A: Formulate neutral question
          return {
            tokenUsed: 80,
            content: JSON.stringify({
              question: '在 Redis Cluster 模式下写入用户 Token 缓存键名有什么要求？',
              estimated_priority: 'P0',
            }),
          };
        }
        if (recordedCalls.length === 2) {
          // Pass 1B: Blind Baseline Check -> MUST NOT contain secretAnswerClue!
          assert.equal(
            req.userPrompt.includes(secretAnswerClue),
            false,
            'Blind baseline pass MUST NOT leak troubleshooting answer!',
          );
          return {
            tokenUsed: 120,
            content: JSON.stringify({
              baseline_answer: '代码仅写入 tok:${userId} 并设置 300 秒过期，未体现集群槽位约束。',
              cited_files: ['src/cache.ts'],
            }),
          };
        }
        // Pass 2: Delta Judge
        return {
          tokenUsed: 210,
          content: '```json\n' + JSON.stringify({
            question: '在 Redis Cluster 模式下写入用户 Token 缓存键名有什么要求？',
            discoverability: 'missing_context',
            disposition: 'knowledge_candidate',
            baseline_answer: '代码仅写入 tok:${userId}',
            knowledge_delta: '多键 Lua 脚本操作同一用户缓存时必须加 {userId} Hash Tag 保证落入同一哈希槽。',
            omission_consequence: '多键原子清理会报 CROSSSLOT 错误',
            priority: 'P0',
            claim_evidence_map: [
              {
                assertion: '必须使用 {userId} Hash Tag',
                evidence_locator: 'src/cache.ts#L1-L5',
                verified_fact: true,
              },
            ],
            candidate: {
              title: 'Redis Cluster 多键操作同一用户缓存必须加 {userId} Hash Tag',
              type: 'pitfall',
              claim: '涉及 Lua 脚本批量操作用户键时，键名须使用 tok:{userId} 格式。',
              rationale: 'Redis Cluster 跨槽位多键执行会抛 CROSSSLOT 异常。',
              search_aliases: ['CROSSSLOT', '哈希槽', 'redis cluster key'],
              preconditions: ['生产环境使用 Redis Cluster 分片集群且存在多键 Lua 脚本'],
              invalidation_triggers: ['迁回单实例 Redis 后复核'],
              verification_method: 'pnpm test cache-cluster.spec.ts',
            },
          }) + '\n```',
        };
      },
    };

    const bundle = collectEvidenceBundle({
      repoRoot,
      touchedFiles: ['src/cache.ts'],
      rawCandidateContext: `排障记录：线上报 CROSSSLOT (${secretAnswerClue})，因为未加 {userId}。`,
      sourceType: 'session_turn',
      sourceRef: 'turn-42',
    });

    const assessor = new DeltaAssessor({ llm: mockLlm, workspaceId: store.workspaceId });
    const assessed = await assessor.assess(bundle, 'isolated_p0');

    assert.equal(recordedCalls.length, 3);
    assert.equal(assessed.assessment.checked_context.method, 'isolated_check');
    assert.equal(assessed.assessment.checked_context.token_used, 410);
    assert.ok(assessed.candidateEntry);
    assert.equal(assessed.candidateEntry.symbol_anchors.length, 1);
    assert.equal(assessed.candidateEntry.symbol_anchors[0]!.symbol_name, 'refreshTokenCache');

    const triage = new TriageEngine(store, 'probation');
    const out = triage.processCandidate(assessed);
    assert.equal(out.finalDisposition, 'knowledge_candidate');
    assert.equal(out.persistedZone, 'probation');

    store.close();
  });

  it('detects session signals accurately, retries transient LLM failures with durable queue, and prunes >7d jobs', async () => {
    // 1. Signal evaluation checks
    const personalOnly = evaluateSessionSignals({
      userMessages: ['/capture'],
      assistantMessages: [],
      editedFiles: ['~/.zshrc'],
      hadCommandFailure: false,
      hadSubsequentCommandSuccess: false,
      totalToolCalls: 2,
      maxEditsOnSingleFile: 1,
    });
    assert.equal(personalOnly.shouldCapture, false, 'Personal dotfiles must be excluded');

    const weakOnly = evaluateSessionSignals({
      userMessages: ['改一下样式'],
      assistantMessages: ['已修改'],
      editedFiles: ['src/button.tsx'],
      hadCommandFailure: false,
      hadSubsequentCommandSuccess: false,
      totalToolCalls: 2,
      maxEditsOnSingleFile: 4, // Only +1 weak point < threshold 3!
    });
    assert.equal(weakOnly.shouldCapture, false, 'Repeated edits alone must NOT trigger capture');

    const causalCorrection = evaluateSessionSignals({
      userMessages: ['不能这样改，因为会导致下游账单对账时序错乱'],
      assistantMessages: [],
      editedFiles: ['src/Order.ts'],
      hadCommandFailure: false,
      hadSubsequentCommandSuccess: false,
      totalToolCalls: 1,
      maxEditsOnSingleFile: 1,
    });
    assert.equal(causalCorrection.shouldCapture, true);
    assert.ok(causalCorrection.strongSignals.includes('causal_user_correction'));

    // 2. Durable queue retry + 7-day TTL pruning
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m2-queue-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src/job.ts'), 'export function runJob() {}\n', 'utf8');

    const store = new LocalMarkdownSqliteStore({ projectRoot: repoRoot, globalDir });
    const triage = new TriageEngine(store, 'probation');

    let shouldFailLlm = true;
    const flakyLlm: LlmInferenceAdapter = {
      async completeJson() {
        if (shouldFailLlm) {
          throw new Error('HTTP 503 Service Unavailable');
        }
        return {
          tokenUsed: 150,
          content: JSON.stringify({
            question: '定时任务并发重入如何保护？',
            discoverability: 'code_recoverable',
            disposition: 'index_only',
            baseline_answer: 'runJob 代码中已显式判断分布式锁',
            knowledge_delta: '',
            omission_consequence: '无',
            priority: 'P2',
            claim_evidence_map: [],
            candidate: null,
          }),
        };
      },
    };

    const coordinator = new AutoCaptureCoordinator({
      store,
      triageEngine: triage,
      llm: flakyLlm,
      assessmentMode: 'single_pass',
    });

    // Simulate Error -> Edit -> Green recovery signal
    coordinator.recordToolActivity({
      sessionId: 's-rec-1',
      toolName: 'run_command',
      isCommandOrTest: true,
      failed: true,
    });
    coordinator.recordToolActivity({
      sessionId: 's-rec-1',
      toolName: 'edit_file',
      editedRelPath: 'src/job.ts',
    });
    coordinator.recordToolActivity({
      sessionId: 's-rec-1',
      toolName: 'run_command',
      isCommandOrTest: true,
      failed: false,
    });
    coordinator.recordTurnConversation('s-rec-1', '修一下任务并发失败', '已补充锁校验并测试通过');

    const { signalResult, enqueuedJob } = coordinator.checkAndEnqueueSession('s-rec-1');
    assert.ok(signalResult.strongSignals.includes('error_to_green_recovery'));
    assert.ok(enqueuedJob);
    assert.equal(coordinator.listQueuedJobs().length, 1);

    // First drain fails due to HTTP 503 -> job stays in queue with attempts=1!
    const failedDrain = await coordinator.processPendingQueue();
    assert.equal(failedDrain.length, 0);
    const queuedAfterFail = coordinator.listQueuedJobs();
    assert.equal(queuedAfterFail.length, 1);
    assert.equal(queuedAfterFail[0]!.attempts, 1);

    // Second drain after backoff window succeeds -> job removed from queue & routed to navigation.json!
    shouldFailLlm = false;
    const futureNow = Date.now() + 120_000;
    const okDrain = await coordinator.processPendingQueue(futureNow);
    assert.equal(okDrain.length, 1);
    assert.equal(okDrain[0]!.finalDisposition, 'index_only');
    assert.equal(coordinator.listQueuedJobs().length, 0);

    // Verify 7-day TTL pruning removes expired queue files
    const staleJob = coordinator.enqueueJob({
      sessionId: 'old',
      sourceType: 'session_turn',
      sourceRef: 'old',
      touchedFiles: [],
      rawCandidateContext: 'old',
    });
    assert.equal(coordinator.listQueuedJobs().length, 1);
    const pruned = coordinator.pruneExpiredQueueJobs(Date.now() + 8 * 24 * 3600 * 1000);
    assert.equal(pruned, 1);
    assert.equal(coordinator.deleteQueuedJob(staleJob.jobId), false);

    store.close();
  });

  it('runs end-to-end `runArchaeologyBootstrap` against a Git repo and persists extracted experience', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m1a-boot-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    git(repoRoot, ['init']);
    git(repoRoot, ['config', 'user.email', 'dev@example.com']);
    git(repoRoot, ['config', 'user.name', 'Dev']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);

    fs.writeFileSync(
      path.join(repoRoot, 'src/pay.ts'),
      'export function settleOrder() { return true; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/pay.spec.ts'),
      'it("handles idempotency race", () => {});\n',
      'utf8',
    );
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'hotfix(pay): fix idempotency race condition on callback']);

    const store = new LocalMarkdownSqliteStore({ projectRoot: repoRoot, globalDir });
    const triage = new TriageEngine(store, 'probation');

    const mockBootLlm: LlmInferenceAdapter = {
      async completeJson() {
        return {
          tokenUsed: 180,
          content: JSON.stringify({
            question: '结算回调并发重放时有什么隐性约束？',
            discoverability: 'missing_context',
            disposition: 'knowledge_candidate',
            baseline_answer: 'settleOrder 返回布尔值',
            knowledge_delta: '渠道网关会在 500ms 超时时重放回调，必须在入口层按 settle_no 去重。',
            omission_consequence: '并发重放造成双倍结算',
            priority: 'P0',
            claim_evidence_map: [
              {
                assertion: '入口层必须按 settle_no 唯一约束去重',
                evidence_locator: 'src/pay.ts#L1',
                verified_fact: true,
              },
            ],
            candidate: {
              title: '结算回调必须在入口层按 settle_no 做幂等去重',
              type: 'pitfall',
              claim: '所有结算回调先写 settle_no 唯一幂等表再执行业务入账。',
              rationale: '渠道网关 500ms 超时自动重放。',
              search_aliases: ['双倍结算', '回调重放'],
              preconditions: ['修改 src/pay.ts 结算回调逻辑'],
              invalidation_triggers: ['渠道网关下线时复核'],
              verification_method: 'pnpm test src/pay.spec.ts',
            },
          }),
        };
      },
    };

    const bootOut = await runArchaeologyBootstrap({
      store,
      triageEngine: triage,
      llm: mockBootLlm,
      topK: 5,
    });

    assert.equal(bootOut.minedCommits.length, 1);
    assert.equal(bootOut.triageReport.persistedExperienceEntries.length, 1);
    assert.equal(bootOut.triageReport.persistedExperienceEntries[0]!.status, 'probation');

    store.close();
  });
});
