import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  LocalMarkdownSqliteStore,
  TriageEngine,
  type CaptureAssessment,
  type KnowledgeEntry,
} from '@accremind/core';

const tempDirs: string[] = [];

function createSandboxStore() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m0-gate-'));
  tempDirs.push(base);
  const projectRoot = path.join(base, 'repo');
  const globalDir = path.join(base, 'global');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  const store = new LocalMarkdownSqliteStore({
    projectRoot,
    globalDir,
    maxProbationExposures: 3,
  });
  return { store, projectRoot, globalDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function buildDraftEntry(id: string, assessmentId: string): KnowledgeEntry {
  return {
    id,
    revision: 1,
    type: 'pitfall',
    knowledge_role: 'experience',
    layer: 'project',
    title: '特定容器布局下表格组件需显式列宽',
    search_aliases: ['列宽塌陷', 'table width'],
    claim: '启用 ellipsis 且父级 flex 容器未定宽时，必须显式传入 width 属性。',
    knowledge_delta: '组件文档未声明 flex:1 + ellipsis 组合会导致宽度计算死循环，排障对比确认显式列宽可规避。',
    rationale: '见最小复现回归记录。',
    preconditions: ['使用 table-component@1.2.3 且开启 ellipsis'],
    exclusions: [],
    dependency_constraints: [],
    watch_paths: ['src/ui/table/**/*.tsx'],
    symbol_anchors: [],
    invalidation_triggers: ['升级 table-component 至 2.x 后复核'],
    verification_method: 'pnpm test table-ellipsis.spec.tsx',
    alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', ref: null },
    status: 'candidate',
    maturity: 'draft',
    freshness: 'current',
    serving: 'enabled',
    priority: 'P1',
    capture_assessment_id: assessmentId,
    supersedes: null,
    evidence: [
      {
        id: `EV-${id}`,
        source_type: 'file_lines',
        source_ref: 'src/ui/table/OrderTable.tsx',
        locator: 'src/ui/table/OrderTable.tsx#L12-L34',
        summary: '排障前后渲染宽度快照对比',
      },
    ],
    created_at: '2026-11-18T00:00:00.000Z',
    updated_at: '2026-11-18T00:00:00.000Z',
    last_validated_at: null,
    review_due_at: '2027-02-18T00:00:00.000Z',
  };
}

describe('M0 PRD §11.5 Deterministic Delta Gate & Shadow Probation Lifecycle', () => {
  it('routes code restatement to index_only, existing docs to link_existing, and unverified guesses to needs_confirmation', () => {
    const { store } = createSandboxStore();
    const triage = new TriageEngine(store, 'probation');

    // Case 1 (PRD §11.5 #1): Pure code restatement -> index_only (even if caller tried knowledge_candidate!)
    const codeRestatement: CaptureAssessment = {
      id: 'CA-CASE1',
      workspace_id: store.workspaceId,
      source_fingerprint: 'fp-case-1',
      question: '订单创建后调用了哪个模块？',
      checked_context: {
        head_commit: '111',
        checked_files: ['src/order/index.ts'],
        checked_docs: [],
        method: 'single_pass_check',
        token_used: 50,
        duration_ms: 20,
      },
      discoverability: 'code_recoverable',
      baseline_answer: '代码直接调用了 notifyService.send()',
      knowledge_delta: '',
      claim_evidence_map: [],
      omission_consequence: '无额外后果',
      priority: 'P2',
      disposition: 'knowledge_candidate', // Deliberately wrong disposition -> must be auto-clamped to index_only!
      created_at: '2026-11-18T00:00:00.000Z',
    };

    // Case 2 (PRD §11.5 #2): Existing authoritative ADR -> link_existing
    const existingAdr: CaptureAssessment = {
      id: 'CA-CASE2',
      workspace_id: store.workspaceId,
      source_fingerprint: 'fp-case-2',
      question: '为什么选用 PostgreSQL 而不是 MongoDB？',
      checked_context: {
        head_commit: '111',
        checked_files: [],
        checked_docs: ['docs/adr/0003-database.md'],
        method: 'single_pass_check',
        token_used: 60,
        duration_ms: 20,
      },
      discoverability: 'authoritative_source',
      baseline_answer: 'ADR-0003 已完整记录事务一致性选型依据',
      knowledge_delta: '',
      claim_evidence_map: [],
      omission_consequence: '重复讨论',
      priority: 'P2',
      disposition: 'link_existing',
      created_at: '2026-11-18T00:00:00.000Z',
    };

    // Case 3 (PRD §11.5 #4 & #6): P0 priority BUT root cause is an unverified guess -> needs_confirmation!
    const unverifiedP0Guess: CaptureAssessment = {
      id: 'CA-CASE3',
      workspace_id: store.workspaceId,
      source_fingerprint: 'fp-case-3',
      question: '为什么重试次数设置为 3 次？',
      checked_context: {
        head_commit: '111',
        checked_files: ['src/pay/retry.ts'],
        checked_docs: [],
        method: 'single_pass_check',
        token_used: 80,
        duration_ms: 30,
      },
      discoverability: 'missing_context',
      baseline_answer: '代码常量 MAX_RETRY = 3',
      knowledge_delta: '猜测当初写 3 次是为了防止重复扣款',
      claim_evidence_map: [
        {
          assertion: '猜测是为了防重复扣款',
          evidence_locator: 'src/pay/retry.ts#L3',
          verified_fact: false,
        },
      ],
      omission_consequence: '误改重试参数',
      priority: 'P0',
      disposition: 'knowledge_candidate',
      created_at: '2026-11-18T00:00:00.000Z',
    };

    const batchReport = triage.processBatch([
      { assessment: codeRestatement },
      { assessment: existingAdr },
      {
        assessment: unverifiedP0Guess,
        candidateEntry: buildDraftEntry('K-0301', 'CA-CASE3'),
      },
    ]);

    // Rule 7: Zero qualified candidates -> 0 experience entries persisted!
    assert.equal(batchReport.persistedExperienceEntries.length, 0);
    assert.equal(batchReport.dispositionCounts.index_only, 1);
    assert.equal(batchReport.dispositionCounts.link_existing, 1);
    assert.equal(batchReport.dispositionCounts.needs_confirmation, 1);
    assert.equal(store.listNavigationItems().length, 2);

    store.close();
  });

  it('blocks direct API bypass without valid CaptureAssessment or with local absolute paths (PRD §11.5 #8)', () => {
    const { store } = createSandboxStore();

    // Attempt 1: Directly calling upsertEntry without assessment
    const orphanEntry: KnowledgeEntry = {
      ...buildDraftEntry('K-0401', 'CA-MISSING'),
      status: 'active',
    };
    assert.throws(() => store.upsertEntry(orphanEntry, 'project', null), /S03 硬发布门禁拦截/);

    // Attempt 2: Evidence locator contains local absolute path `/Users/tianye/...`
    const validAssessment: CaptureAssessment = {
      id: 'CA-ABS',
      workspace_id: store.workspaceId,
      source_fingerprint: 'fp-abs',
      question: '布局宽度为何塌陷？',
      checked_context: {
        head_commit: '222',
        checked_files: ['src/ui/table/OrderTable.tsx'],
        checked_docs: [],
        method: 'human_review',
        token_used: 0,
        duration_ms: 0,
      },
      discoverability: 'missing_context',
      baseline_answer: '无文档说明',
      knowledge_delta: 'flex+ellipsis 宽度塌陷',
      claim_evidence_map: [
        {
          assertion: '需显式列宽',
          evidence_locator: 'src/ui/table/OrderTable.tsx#L12',
          verified_fact: true,
        },
      ],
      omission_consequence: '渲染异常',
      priority: 'P1',
      disposition: 'knowledge_candidate',
      created_at: '2026-11-18T00:00:00.000Z',
    };

    const absPathEntry: KnowledgeEntry = {
      ...buildDraftEntry('K-0402', 'CA-ABS'),
      status: 'active',
      evidence: [
        {
          id: 'EV-BAD',
          source_type: 'file_lines',
          source_ref: '/Users/tianye/Desktop/secret.ts',
          locator: '/Users/tianye/Desktop/secret.ts#L1',
          summary: '本机绝对路径违规',
        },
      ],
    };

    assert.throws(
      () => store.upsertEntry(absPathEntry, 'project', validAssessment),
      /禁止使用本机绝对路径/,
    );

    store.close();
  });

  it('manages Shadow Probation: keeps repo clean during trial, promotes to active on validation, and asks for a decision (never auto-archives) after 3 silent exposures', () => {
    const { store } = createSandboxStore();
    const triage = new TriageEngine(store, 'probation');

    const makeValidCandidate = (num: string): { assessment: CaptureAssessment; entry: KnowledgeEntry } => ({
      assessment: {
        id: `CA-${num}`,
        workspace_id: store.workspaceId,
        source_fingerprint: `fp-${num}`,
        question: `场景问题 ${num}：特定容器下如何避免列宽塌陷？`,
        checked_context: {
          head_commit: '333',
          checked_files: ['src/ui/table/OrderTable.tsx'],
          checked_docs: [],
          method: 'single_pass_check',
          token_used: 100,
          duration_ms: 40,
        },
        discoverability: 'missing_context',
        baseline_answer: '仅见 width 属性',
        knowledge_delta: `增量信息 ${num}`,
        claim_evidence_map: [
          {
            assertion: `增量信息 ${num}`,
            evidence_locator: 'src/ui/table/OrderTable.tsx#L12-L34',
            verified_fact: true,
          },
        ],
        omission_consequence: '列宽异常',
        priority: 'P1',
        disposition: 'knowledge_candidate',
        created_at: '2026-11-18T00:00:00.000Z',
      },
      entry: buildDraftEntry(`K-${num}`, `CA-${num}`),
    });

    // Candidate 0501 -> enters ~/.dsh/accremind/probation/ (NOT <repo>/.accremind/entries/!)
    const c1 = makeValidCandidate('0501');
    const out1 = triage.processCandidate({
      assessment: c1.assessment,
      candidateEntry: c1.entry,
    });
    assert.equal(out1.persistedZone, 'probation');
    assert.equal(
      fs.existsSync(path.join(store.paths.projectEntriesDir, 'K-0501.md')),
      false,
      'Probation draft must NOT pollute project git entries directory yet!',
    );
    assert.equal(fs.existsSync(path.join(store.paths.probationDir, 'K-0501.md')), true);

    // Retrieving 10 times MUST NOT change maturity from `draft`!
    for (let i = 0; i < 10; i += 1) {
      store.getEntry('K-0501', { sessionId: `s-${i}`, recordUsage: true });
    }
    const stillDraft = store.getEntry('K-0501', { recordUsage: false });
    assert.ok(stillDraft.found && stillDraft.servable);
    assert.equal(stillDraft.entry.maturity, 'draft');

    // Positive validation in independent task 1 -> promotes K-0501 into project entries/ AND upgrades to `verified`!
    const val1 = store.submitValidation({
      entryId: 'K-0501',
      sessionId: 'sess-indep-1',
      taskFingerprint: 'task-A',
      outcome: 'success',
      evidenceNote: '在新报表页面复用成功解决宽度塌陷',
    });
    assert.equal(val1.updatedEntry.status, 'active');
    assert.equal(val1.updatedEntry.maturity, 'verified');
    assert.equal(fs.existsSync(path.join(store.paths.projectEntriesDir, 'K-0501.md')), true);
    assert.equal(fs.existsSync(path.join(store.paths.probationDir, 'K-0501.md')), false);

    // Duplicate validation in SAME task-A -> stays `verified` (not `proven`)
    const valDup = store.submitValidation({
      entryId: 'K-0501',
      sessionId: 'sess-indep-1',
      taskFingerprint: 'task-A',
      outcome: 'success',
      evidenceNote: '同任务二次调用不刷成熟度',
    });
    assert.equal(valDup.updatedEntry.maturity, 'verified');

    // Independent task-B -> upgrades to `proven`!
    const val2 = store.submitValidation({
      entryId: 'K-0501',
      sessionId: 'sess-indep-2',
      taskFingerprint: 'task-B',
      outcome: 'success',
      evidenceNote: '结算表格独立任务再次验证有效',
    });
    assert.equal(val2.updatedEntry.maturity, 'proven');

    // Candidate 0502 -> shown 3 times with no feedback: silence is not evidence against it,
    // so it keeps serving and is put in front of the user to decide.
    const c2 = makeValidCandidate('0502');
    triage.processCandidate({ assessment: c2.assessment, candidateEntry: c2.entry });
    assert.equal(store.recordProbationExposure('K-0502').needsDecision, false);
    assert.equal(store.recordProbationExposure('K-0502').needsDecision, false);
    const third = store.recordProbationExposure('K-0502');
    assert.equal(third.needsDecision, true);
    assert.equal(third.autoArchived, false);

    const stillServing = store.getEntry('K-0502', { recordUsage: false });
    assert.ok(stillServing.found && stillServing.servable && stillServing.entry.status === 'probation');
    assert.deepEqual(store.listAttentionItems().map((a) => [a.entry_id, a.kind]), [['K-0502', 'probation_silent']]);
    store.dismissProbation('K-0502');
    assert.deepEqual(store.listAttentionItems(), [], 'deciding clears the reminder');

    store.close();
  });
});
