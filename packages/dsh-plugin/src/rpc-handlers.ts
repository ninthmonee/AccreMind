import * as fs from 'node:fs';
import type { TurnReceipts } from './turn-receipts.ts';
import type { DshToolDefinition } from './cordis-types.ts';
import { advanceDemoOrder, readDemoBaseline } from './demo-fixture.ts';
import { decideReview, reviewMissingFields } from './candidate-review.ts';
import * as path from 'node:path';
import {
  KNOWLEDGE_LAYERS,
  isRepositoryKnowledgeLayer,
  exportEntryToDshSkill,
  runArchaeologyBootstrap,
  scanGitHistorySignals,
  serializeEntryMarkdown,
  sha256Hex,
  type AccreMindConfig,
  type AutoCaptureCoordinator,
  type CaptureAssessment,
  type Disposition,
  type EntryStatus,
  type Freshness,
  type GitStalenessScanner,
  type KnowledgeEntry,
  type KnowledgeLayer,
  type KnowledgeType,
  type LlmInferenceAdapter,
  type LocalMarkdownSqliteStore,
  type ServingStatus,
  type TriageEngine,
  type ViewCompiler,
} from '@accremind/core';

export type RpcHandlerMap = Record<
  string,
  (params: Record<string, unknown>) => Promise<unknown> | unknown
>;

function emptyScopeCounts(): Record<KnowledgeLayer, number> {
  return Object.fromEntries(KNOWLEDGE_LAYERS.map(layer => [layer, 0])) as Record<KnowledgeLayer, number>;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

const DEMO_ENTRY_IDS = ['R-0901', 'K-0901', 'K-0902', 'K-0903'];
const DEMO_ASSESSMENT_IDS = ['CA-DEMO-01', 'CA-DEMO-02', 'CA-DEMO-03', 'CA-DEMO-04'];

/**
 * Complete Host RPC Router for the AccreMind V3.1 Creative Observatory WebUI.
 * Browser views NEVER touch `node:sqlite`, `fs`, or OS processes directly.
 */
export function createWebuiRpcHandlers(deps: {
  receipts: TurnReceipts;
  tools: DshToolDefinition<any>[];
  demoMode?: boolean;
  store: LocalMarkdownSqliteStore;
  viewCompiler: ViewCompiler;
  budgets: AccreMindConfig['budgets'];
  stalenessScanner: GitStalenessScanner;
  triageEngine: TriageEngine;
  autoCapture: AutoCaptureCoordinator;
  getLlmAdapter: () => LlmInferenceAdapter | null;
}): RpcHandlerMap {
  const {
    store,
    viewCompiler,
    budgets,
    stalenessScanner,
    triageEngine,
    autoCapture,
    getLlmAdapter,
  } = deps;

  function currentEntry(params: Record<string, unknown>) {
    const found = store.getEntry(String(params.id ?? ''), { recordUsage: false, includeHistoryOrSuspended: true });
    if (!found.found || !found.servable) throw new Error('未找到条目');
    deps.receipts.checkReference(params, found.entry);
    return found.entry;
  }

  function decideGovernance(params: Record<string, unknown>, action: 'resolve' | 'stale') {
    const entry = currentEntry(params);
    const reason = String(params.reason ?? '').trim();
    if (!reason) throw new Error('请填写本次裁决的依据');
    if (!['active', 'probation'].includes(entry.status)) throw new Error('归档或撤回的经验不能在此更改');
    if (action === 'resolve' && (entry.serving !== 'suspended' || entry.freshness !== 'current')) {
      throw new Error('仅能对时效已核对、检索已暂停的经验解除反证');
    }
    const now = new Date().toISOString();
    const next = store.updateExistingEntryDirect({
      ...entry, ...(action === 'resolve' ? { serving: 'enabled' as const } : { freshness: 'stale' as const }), updated_at: now,
    });
    store.rawDb.prepare('INSERT INTO governance_decisions VALUES (?, ?, ?, ?, ?, ?)').run(
      store.workspaceId, entry.id, entry.revision, action, reason, now,
    );
    return next;
  }

  return {
    'accremind.gov.markStale': (params) => decideGovernance(params, 'stale'),
    'accremind.gov.resolveConflict': (params) => decideGovernance(params, 'resolve'),
    'accremind.turn.list': (params) => ({
      receipts: deps.receipts.list(typeof params.sessionId === 'string' ? params.sessionId : undefined,
        typeof params.turnId === 'string' ? params.turnId : undefined, Number(params.limit ?? 20)),
    }),
    'accremind.capture.manual': async (params) => {
      const capture = deps.tools.find((tool) => tool.name === 'accremind_capture')!;
      const out = await capture.execute(params, { sessionId: 'webui-manual' });
      if (out.isError) throw new Error(out.content[0]?.text ?? '捕获失败');
      return JSON.parse(out.content[0]!.text);
    },
    'accremind.dashboard.overview': () => {
      const all = store.listEntriesForAdmin();
      const pendingCount = store.countAssessments('pending');
      const corrupted = store.listCorruptedFiles();
      const queuedJobs = autoCapture.listQueuedJobs();

      let activeCount = 0;
      let rulesCount = 0;
      let projectActiveCount = 0;
      let probationCount = 0;
      let reviewDueCount = 0;
      let suspendedCount = 0;
      let governanceQueueCount = 0;
      let verifiedOrProvenCount = 0;
      const byScope = emptyScopeCounts();
      const byType: Record<string, number> = {
        pitfall: 0,
        decision: 0,
        guideline: 0,
        model: 0,
        process: 0,
      };

      for (const { entry, storageZone } of all) {
        if (storageZone === 'project' && entry.status === 'active') projectActiveCount += 1;
        if (storageZone === 'rules') rulesCount += 1;
        if (entry.status === 'active') activeCount += 1;
        if (entry.status === 'probation') probationCount += 1;
        if (entry.freshness === 'review_due') reviewDueCount += 1;
        if (entry.serving === 'suspended') suspendedCount += 1;
        if (entry.freshness !== 'current' || (entry.serving === 'suspended' &&
            (entry.status === 'active' || entry.status === 'probation'))) governanceQueueCount += 1;
        if (entry.maturity === 'verified' || entry.maturity === 'proven') {
          verifiedOrProvenCount += 1;
        }
        byScope[entry.layer] = (byScope[entry.layer] ?? 0) + 1;
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      }

      const hasDemoSeeded = deps.demoMode === true && all.some((i) => DEMO_ENTRY_IDS.includes(i.entry.id));

      return {
        workspaceId: store.workspaceId,
        projectName: path.basename(store.paths.projectRoot),
        projectDir: store.paths.projectAccreMindDir,
        globalDir: store.paths.globalRoot,
        maxProbationExposures: store.maxProbationExposures,
        budgets,
        hasDemoSeeded,
        counts: {
          totalEntries: all.length,
          byScope,
          byCategory: byType,
          activeCount,
          projectActiveCount,
          rulesCount,
          probationCount,
          reviewDueCount,
          suspendedCount,
          governanceQueueCount: governanceQueueCount + corrupted.length,
          verifiedOrProvenCount,
          pendingReviewCount: pendingCount,
          corruptedCount: corrupted.length,
          queuedCaptureJobs: queuedJobs.length,
          navigationItemsCount: store.listNavigationItems().length,
        },
        byType,
      };
    },

    'accremind.kb.list': (params) => {
      if (params.adminView === true) {
        const items = store.listEntriesForAdmin({
          status: (params.status as EntryStatus | undefined) || undefined,
          freshness: (params.freshness as Freshness | undefined) || undefined,
          serving: (params.serving as ServingStatus | undefined) || undefined,
          type: (params.type as KnowledgeType | undefined) || undefined,
          query: typeof params.query === 'string' ? params.query : undefined,
        });
        const matching = items.filter(({ entry, storageZone }) =>
          (!params.storageZone || storageZone === params.storageZone) &&
          (!params.maturity || (params.maturity === 'verified_or_proven'
            ? entry.maturity === 'verified' || entry.maturity === 'proven'
            : entry.maturity === params.maturity)),
        );
        const scopeCounts = emptyScopeCounts();
        for (const {entry} of matching) {
          scopeCounts[entry.layer] = (scopeCounts[entry.layer] ?? 0) + 1;
        }
        const filtered = params.layer ? matching.filter(({entry}) => entry.layer === params.layer) : matching;
        return {
          scopeCounts,
          items: filtered.map((i) => ({
            entry: i.entry,
            storageZone: i.storageZone,
            probationExposures: i.probationExposures,
            score: 1,
            matchReasons: [],
            truncated: false,
          })),
          zeroReason: filtered.length === 0 ? 'no_applicable_entry' : 'none',
          tokenUsed: 0,
        };
      }

      return store.search({
        workspaceId: store.workspaceId,
        query: typeof params.query === 'string' ? params.query : undefined,
        type: (params.type as KnowledgeType | undefined) || undefined,
        layer: (params.layer as KnowledgeLayer | undefined) || undefined,
        filePath: typeof params.filePath === 'string' ? params.filePath : undefined,
        includeProbation: params.includeProbation !== false,
        limit: typeof params.limit === 'number' ? params.limit : 20,
      });
    },

    'accremind.kb.get': (params) => {
      const id = String(params.id ?? '');
      const outcome = store.getEntry(id, {
        recordUsage: false,
        includeHistoryOrSuspended: true,
      });
      if (!outcome.found || !outcome.servable) {
        return outcome;
      }
      const assessment = outcome.entry.capture_assessment_id
        ? store.getAssessment(outcome.entry.capture_assessment_id)
        : null;
      const validations = store.listValidations(id);
      const rawMarkdown = serializeEntryMarkdown(outcome.entry);
      return {
        ...outcome,
        assessment,
        validations,
        rawMarkdown,
      };
    },

    'accremind.kb.saveRevision': (params) => {
      const id = String(params.id ?? '');
      if (params.expectedRevision !== undefined) currentEntry({ id, revision: params.expectedRevision });
      const patch = (params.patch ?? {}) as Partial<KnowledgeEntry>;
      const editableStrings = ['title', 'claim', 'rationale', 'knowledge_delta'];
      const editableLists = ['search_aliases', 'invalidation_triggers', 'preconditions'];
      for (const [name, value] of Object.entries(patch)) {
        if (name === 'layer' && isRepositoryKnowledgeLayer(value)) continue;
        if (editableStrings.includes(name) && typeof value === 'string') continue;
        if (editableLists.includes(name) && Array.isArray(value) && value.every(v => typeof v === 'string')) continue;
        throw new Error(`无法通过正文修订修改字段 ${name}`);
      }
      const revisionImpact =
        params.revisionImpact === 'editorial' ? 'editorial' : 'substantive';
      return store.saveRevision({ id, patch, revisionImpact });
    },

    'accremind.kb.withdraw': (params) => {
      const id = String(params.id ?? '');
      const reason = String(params.reason ?? '').trim();
      if (!reason) {
        throw new Error('S01 高危操作校验失败：撤回知识必须填写明确原因');
      }
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) {
        throw new Error(`未找到条目: ${id}`);
      }
      const withdrawn: KnowledgeEntry = {
        ...found.entry,
        status: 'withdrawn',
        serving: 'suspended',
        supersedes:
          typeof params.supersedes === 'string' ? params.supersedes : found.entry.supersedes,
        updated_at: new Date().toISOString(),
      };
      return { entry: store.updateExistingEntryDirect(withdrawn), reason };
    },

    'accremind.probation.decide': (params) => {
      const entry = currentEntry(params);
      const id = entry.id;
      const action = String(params.action ?? '');
      if (entry.status !== 'probation' || (action === 'promote' && entry.serving !== 'enabled')) {
        throw new Error('试用状态已变化，请刷新后重新核对');
      }
      if (action === 'promote') {
        return store.promoteProbationToActive(id);
      }
      if (action === 'dismiss') {
        return store.dismissProbation(id);
      }
      throw new Error(`未知试用裁决动作: ${action}`);
    },

    'accremind.feedback.submit': (params) => {
      const entry = currentEntry(params);
      const id = entry.id;
      const kind = String(params.kind ?? '');
      const detail = String(params.detail ?? '');
      if (!detail.trim()) {
        throw new Error('反馈说明与依据不能为空');
      }

      if (kind === 'verified_effective' || kind === 'suspected_error') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'webui-manual';
        let task = params.turnId ? `session:${sessionId}` : String(params.taskFingerprint ?? '').trim();
        if (!task && kind === 'suspected_error') task = `report:${sha256Hex(detail.trim())}`;
        if (!task) throw new Error('请填写独立任务、工单或测试运行标识');
        if (kind === 'verified_effective' && entry.evidence.some((ev) =>
          ev.source_type === 'session_turn' && ev.source_ref === sessionId && params.turnId)) {
          throw new Error('请在产生该经验的会话之外验证');
        }
        return store.submitValidation({
          entryId: id,
          sessionId,
          taskFingerprint: task,
          outcome: kind === 'verified_effective' ? 'success' : 'failure',
          evidenceNote: detail,
        });
      }

      const current = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (current.found && current.servable) {
        store.recordUsage({
          workspace_id: store.workspaceId,
          session_id: 'webui-feedback',
          entry_id: id,
          revision: current.entry.revision,
          event_type: 'feedback_inapplicable',
          detail,
        });
      }
      return { recorded: true };
    },

    'accremind.sim.compile': (params) => {
      const userPrompt = typeof params.userPrompt === 'string' ? params.userPrompt : '';
      const errorOutput = typeof params.errorOutput === 'string' ? params.errorOutput : '';
      const activeFile = typeof params.activeFile === 'string' ? params.activeFile.trim() : '';
      const midTurnToolFile =
        typeof params.midTurnToolFile === 'string' ? params.midTurnToolFile.trim() : '';

      const simSurfaced = new Set<string>();
      const turnView = viewCompiler.compileTurnView(
        {
          sessionId: 'webui-simulator',
          preview: true,
          userPrompt,
          errorOutput,
          activeFiles: activeFile ? [activeFile] : [],
        },
        simSurfaced,
      );

      const jitOut = midTurnToolFile
        ? viewCompiler.compileFileToolGuard({
            sessionId: 'webui-simulator',
            preview: true,
            filePath: midTurnToolFile,
            sessionSurfacedIds: simSurfaced,
          })
        : { guardBlock: '', newlySurfacedIds: [] };

      return {
        residentPrefix: turnView.residentPrefix,
        residentRuleIds: turnView.residentRuleIds,
        residentSha256: turnView.residentPrefix
          ? sha256Hex(turnView.residentPrefix).slice(0, 16)
          : 'empty',
        residentTokens: estimateTokens(turnView.residentPrefix),
        radarBlock: turnView.radarBlock,
        radarTokens: estimateTokens(turnView.radarBlock),
        radarSurfacedIds: turnView.surfacedIds,
        guardBlock: jitOut.guardBlock,
        guardTokens: estimateTokens(jitOut.guardBlock),
        guardSurfacedIds: jitOut.newlySurfacedIds,
        budgets,
      };
    },

    'accremind.review.listQueue': (params) => {
      const reviewState =
        (params.reviewState as 'pending' | 'decided' | 'all' | undefined) ?? 'all';
      const limit = typeof params.limit === 'number' && Number.isInteger(params.limit)
        ? Math.max(1, Math.min(200, params.limit)) : 50;
      const offset = typeof params.offset === 'number' && Number.isInteger(params.offset)
        ? Math.max(0, params.offset) : 0;
      const total = store.countAssessments(reviewState);
      return {
        offset, limit, total, hasMore: offset + limit < total,
        items: store.listAssessments({reviewState, limit, offset}).map(item => ({
          ...item, missingFields: reviewMissingFields(item),
        })),
        navigationItems: store.listNavigationItems(),
      };
    },

    'accremind.review.decide': (params) => decideReview(store, params),

    'accremind.gov.scanStaleness': () => {
      const scan = stalenessScanner.scanWorkspace();
      const entries = store.listEntriesForAdmin().map(item => item.entry);
      const staleEntries = entries.filter(entry => entry.freshness !== 'current');
      return {
        scan, staleEntries,
        reviewDetails: Object.fromEntries(staleEntries.map(e => [e.id, stalenessScanner.reviewDetails(e)])),
        suspendedEntries: entries.filter(entry => entry.serving === 'suspended' && (entry.status === 'active' || entry.status === 'probation')),
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.gov.requestReview': (params) => {
      const entry = currentEntry(params);
      const reason = String(params.reason ?? '').trim();
      if (!reason) throw new Error('请填写重新评估的具体依据');
      if (entry.freshness !== 'stale' || !['active', 'probation'].includes(entry.status)) {
        throw new Error('仅可重新评估已标为失效的正式或试用条目');
      }
      const now = new Date().toISOString();
      const updated = store.updateExistingEntryDirect({...entry, freshness:'review_due', serving:'suspended', updated_at:now});
      store.rawDb.prepare('UPDATE freshness_reviews SET reason = ? WHERE workspace_id = ? AND entry_id = ?')
        .run(reason,store.workspaceId,entry.id);
      store.rawDb.prepare('INSERT INTO governance_decisions VALUES (?, ?, ?, ?, ?, ?)').run(
        store.workspaceId,entry.id,entry.revision,'request_review',reason,now);
      return updated;
    },

    'accremind.gov.readAnchor': (params) => {
      const entry = currentEntry(params);
      return stalenessScanner.readAnchor(entry, String(params.filePath ?? ''), String(params.symbolName ?? ''));
    },

    'accremind.gov.rebindAnchor': (params) => {
      const entry = currentEntry(params);
      if (params.revision !== entry.revision) throw new Error('条目版本已经变更，请刷新并重新核对');
      return {entry:stalenessScanner.rebindAnchor(entry, String(params.oldFilePath ?? ''), String(params.oldSymbolName ?? ''),
        String(params.filePath ?? '').trim(), String(params.symbolName ?? '').trim())};
    },

    'accremind.gov.confirmFresh': (params) => {
      const id = String(params.id ?? '');
      const found = store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true });
      if (!found.found || !found.servable) throw new Error(`未找到条目: ${id}`);
      if (params.revision !== undefined && params.revision !== found.entry.revision) {
        throw new Error('条目版本已经变更，请刷新后重新核对');
      }
      if (typeof params.reviewToken === 'string' && params.reviewToken !== stalenessScanner.reviewDetails(found.entry).reviewToken) {
        throw new Error('对照代码已经变化，请刷新差异后再次核对');
      }
      return stalenessScanner.confirmFresh(found.entry);
    },

    'accremind.gov.bootstrapHistory': async (params) => {
      const maxCommits = typeof params.maxCommits === 'number' ? params.maxCommits : 150;
      const topK = typeof params.topK === 'number' ? params.topK : 10;
      const extractWithLlm = Boolean(params.extractWithLlm);
      const llm = getLlmAdapter();

      if (extractWithLlm && llm) {
        const result = await runArchaeologyBootstrap({
          store,
          triageEngine,
          llm,
          maxCommitsToScan: maxCommits, topK,
          commitShas: Array.isArray(params.commitShas) ? params.commitShas.map(String) : undefined,
        });
        return {...result, modelAvailable:true};
      }

      const minedCommits = scanGitHistorySignals({
        repoRoot: store.paths.projectRoot,
        maxCommitsToScan: maxCommits,
        topK,
      });
      return {
        minedCommits, modelAvailable: Boolean(llm),
        message: extractWithLlm && !llm ? '当前未连接提炼模型，仅扫描提交；尚未生成候选。' : undefined,
        triageReport: null as null | { dispositionCounts: Record<Disposition, number> },
      };
    },

    'accremind.gov.exportSkill': (params) => {
      const id = String(params.id ?? '');
      const skillSlug = String(params.skillSlug ?? '');
      return exportEntryToDshSkill({ store, entryId: id, skillSlug });
    },

    'accremind.gov.rebuildIndex': () => {
      const stats = store.rebuildIndexFromScratch();
      return {
        ...stats,
        corruptedFiles: store.listCorruptedFiles(),
      };
    },

    'accremind.queue.list': () => {
      return { jobs: autoCapture.listQueuedJobs() };
    },

    'accremind.queue.drain': async () => {
      const outcomes = await autoCapture.processPendingQueue();
      return { processed: outcomes.length, outcomes };
    },

    'accremind.demo.seed': () => {
      if (!deps.demoMode) throw new Error('请先进入独立演示工作区');
      const baseline = readDemoBaseline(store.paths.projectRoot);
      const now = new Date().toISOString();
      const future = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

      // 1. Resident Mandatory Rule (Tier 1 KV-Cache Locked)
      const ruleEntry: KnowledgeEntry = {
        id: 'R-0901',
        revision: 1,
        type: 'guideline',
        polarity: 'avoid',
        knowledge_role: 'authoritative_mirror',
        layer: 'team_rule',
        title: '支付与账务核心链路禁止浮点数运算及明文打印敏感凭据',
        search_aliases: ['金额精度', '浮点数', '日志脱敏', 'decimal'],
        claim: '所有涉及资金结算字段一律使用 bigint 最小货币单位（分），日志禁止打印原始 Token 与卡号。',
        knowledge_delta: '',
        rationale: '财务审计合规红线镜像（ADR-FIN-001）',
        preconditions: ['涉及 billing / payment / ledger 模块开发'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/billing/**/*.ts', 'src/payment/**/*.ts'],
        symbol_anchors: [],
        invalidation_triggers: ['集团安全与账务规范大版本更新'],
        verification_method: '核对此项目 docs/adr/001-finance-redlines.md 中的规范',
        alternatives: [],
        enforcement: { kind: 'none', status: 'proposed', ref: null },
        status: 'active',
        maturity: 'proven',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P0',
        capture_assessment_id: null,
        supersedes: null,
        evidence: [
          {
            id: 'EV-R901',
            source_type: 'doc_ref',
            source_ref: 'docs/adr/001-finance-redlines.md',
            locator: 'docs/adr/001-finance-redlines.md#L1-L3',
            summary: '账务精度与隐私合规强制规范',
          },
        ],
        created_at: now,
        updated_at: now,
        last_validated_at: now,
        review_due_at: future,
      };
      store.upsertEntry(ruleEntry, 'rules', null);

      // 2. Active Verified P0 Pitfall
      const ca1: CaptureAssessment = {
        id: 'CA-DEMO-01',
        workspace_id: store.workspaceId,
        source_fingerprint: 'fp-demo-01',
        question: '微信与 Stripe 异步支付回调如何防止并发双倍入账与验签失败？',
        checked_context: {
          head_commit: baseline.commit,
          checked_files: ['src/payment/webhook.ts'],
          checked_docs: ['README.md'],
          method: 'isolated_check',
          token_used: 540,
          duration_ms: 480,
        },
        discoverability: 'missing_context',
        baseline_answer: '源码读取 req.rawBody 并写入 payment_events 表，但未说明为何禁用全局 bodyParser 及为何不能先 SELECT 再 INSERT。',
        knowledge_delta: '第三方网关在 1s 超时会同毫秒双发重试，READ COMMITTED 下先查后插必现双入账；且 JSON 重序列化会改变浮点格式导致 HMAC 验签 100% 失败。',
        claim_evidence_map: [
          {
            assertion: '必须保留原始 Buffer 验签并依赖 idempotency_key 唯一索引直接 INSERT 捕获冲突',
            evidence_locator: baseline.paymentLocator,
            verified_fact: true,
          },
        ],
        omission_consequence: '误加全局 JSON 中间件导致回调全量验签失败，或并发重放造成双倍入账资损',
        priority: 'P0',
        disposition: 'knowledge_candidate',
        created_at: now,
      };
      const k1: KnowledgeEntry = {
        id: 'K-0901',
        revision: 2,
        type: 'pitfall',
        knowledge_role: 'experience',
        layer: 'project',
        title: '异步支付回调严禁重序列化验签，防重必须直插唯一索引而非先查后插',
        search_aliases: ['重复扣款', '双倍入账', '防重', '幂等', '验签失败', 'idempotency_key'],
        claim: 'webhook 路由必须挂载 rawBody Buffer 直接计算签名，入账幂等必须靠 INSERT ON CONFLICT DO NOTHING 原子拦截。',
        knowledge_delta: ca1.knowledge_delta,
        rationale: '预发压测曾因 1000ms 超时重放穿透 SELECT-then-INSERT 造成 3 笔重复入账。',
        preconditions: ['修改 src/payment/webhook.ts 或全局 HTTP Body 解析中间件'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/payment/**/*.ts'],
        symbol_anchors: [baseline.payment],
        invalidation_triggers: ['统一接入 API 网关层签名与去重插件后复核'],
        verification_method: 'node --test --test-name-pattern=payment tests/scenarios.test.mjs',
        alternatives: [
          {
            option: 'Redis SETNX 5秒锁',
            rejected_because: 'Full GC 或主从切换锁丢失仍会穿透，唯一索引才是最终账务兜底',
            evidence_id: 'EV-901',
          },
        ],
        enforcement: { kind: 'test', status: 'verified', ref: 'tests/scenarios.test.mjs' },
        status: 'active',
        maturity: 'proven',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P0',
        capture_assessment_id: ca1.id,
        supersedes: null,
        evidence: [
          {
            id: 'EV-901',
            source_type: 'git_commit',
            source_ref: baseline.commit,
            locator: baseline.paymentLocator,
            summary: '并发 50 线程回调重放压测与唯一键拦截回归测试',
          },
        ],
        created_at: now,
        updated_at: now,
        last_validated_at: now,
        review_due_at: future,
      };
      store.upsertEntry(k1, 'project', ca1);

      // 3. Shadow Probation Draft (1/3 exposures used)
      const ca2: CaptureAssessment = {
        id: 'CA-DEMO-02',
        workspace_id: store.workspaceId,
        source_fingerprint: 'fp-demo-02',
        question: 'Redis Cluster 分片环境下执行多键 Lua 脚本清理用户会话有何隐性限制？',
        checked_context: {
          head_commit: baseline.commit,
          checked_files: ['src/auth/session-cache.ts'],
          checked_docs: [],
          method: 'single_pass_check',
          token_used: 310,
          duration_ms: 290,
        },
        discoverability: 'missing_context',
        baseline_answer: '本地开发环境为单节点 Redis，直接拼接 session:uid 与 refresh:uid 运行正常。',
        knowledge_delta: '生产环境为 6 分片 Redis Cluster，未加 {uid} Hash Tag 的多键 Lua 脚本在预发必报 CROSSSLOT Keys in request don’t hash to the same slot。',
        claim_evidence_map: [
          {
            assertion: '同用户多键原子脚本必须使用 {uid} Hash Tag 强制同槽位',
            evidence_locator: 'src/auth/session-cache.ts#L1-L3',
            verified_fact: true,
          },
        ],
        omission_consequence: '本地单机测试全绿，上线预发集群立即抛 CROSSSLOT 导致无法登出',
        priority: 'P1',
        disposition: 'knowledge_candidate',
        created_at: now,
      };
      const k2: KnowledgeEntry = {
        id: 'K-0902',
        revision: 1,
        type: 'pitfall',
        knowledge_role: 'experience',
        layer: 'project',
        title: 'Redis Cluster 多键 Lua 脚本必须使用 {uid} Hash Tag 保证同槽位',
        search_aliases: ['CROSSSLOT', '哈希槽', '退出登录报错', '被踢下线', 'redis lua'],
        claim: '凡需要在同一 Lua 脚本或事务中操作的多枚用户缓存键，统一命名为 sess:{uid}:meta 与 sess:{uid}:rt。',
        knowledge_delta: ca2.knowledge_delta,
        rationale: '单机 Docker Redis 无法暴露跨分片槽位校验错误。',
        preconditions: ['编写 Redis eval/evalsha 脚本或 pipeline 跨键原子操作'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/auth/**/*.ts'],
        symbol_anchors: [],
        invalidation_triggers: ['切换至非分片内存存储架构'],
        verification_method: 'node --test --test-name-pattern=session tests/scenarios.test.mjs',
        alternatives: [],
        enforcement: { kind: 'none', status: 'proposed', ref: null },
        status: 'probation',
        maturity: 'draft',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P1',
        capture_assessment_id: ca2.id,
        supersedes: null,
        evidence: [
          {
            id: 'EV-902',
            source_type: 'git_commit',
            source_ref: baseline.commit,
            locator: 'src/auth/session-cache.ts#L1-L3',
            summary: '预发集群 CROSSSLOT 报错堆栈与 {uid} 修复验证',
          },
        ],
        created_at: now,
        updated_at: now,
        last_validated_at: null,
        review_due_at: future,
      };
      store.upsertEntry(k2, 'probation', ca2);
      store.recordProbationExposure('K-0902');

      // 4. Review-Due Architecture Decision (Symbol Drift Alert)
      const ca3: CaptureAssessment = {
        id: 'CA-DEMO-03',
        workspace_id: store.workspaceId,
        source_fingerprint: 'fp-demo-03',
        question: '订单落库后发送下游履约消息为何要求挂载在事务提交回调之后？',
        checked_context: {
          head_commit: baseline.commit,
          checked_files: ['src/order/order.service.ts'],
          checked_docs: [],
          method: 'isolated_check',
          token_used: 410,
          duration_ms: 350,
        },
        discoverability: 'missing_context',
        baseline_answer: '代码调用了 afterCommit 钩子发送 MQ。',
        knowledge_delta: 'MQ 投递仅需 2ms，而订单主从复杂事务提交耗时可达 15ms，事务内直发会导致履约服务回查主库读不到未提交订单。',
        claim_evidence_map: [
          {
            assertion: '必须在事务提交落盘回调后再投递下游事件',
            evidence_locator: baseline.orderLocator,
            verified_fact: true,
          },
        ],
        omission_consequence: '重构时误移回事务闭包内会导致高并发偶发丢单',
        priority: 'P0',
        disposition: 'knowledge_candidate',
        created_at: now,
      };
      const k3: KnowledgeEntry = {
        id: 'K-0903',
        revision: 1,
        type: 'decision',
        knowledge_role: 'experience',
        layer: 'domain',
        title: '订单领域事件投递必须延迟至数据库事务提交落盘回调之后',
        search_aliases: ['丢单', '查无订单', '事务竞态', 'afterCommit', '履约延迟'],
        claim: '禁止在 @Transactional 方法体内直接调用 mqProducer.send，统一通过 txManager.afterCommit 注册或写本地 Outbox 表。',
        knowledge_delta: ca3.knowledge_delta,
        rationale: '异步消费者反查速度经常快于复杂事务 WAL 刷盘完成时机。',
        preconditions: ['修改订单创建与状态机流转核心服务'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/order/**/*.ts'],
        symbol_anchors: [baseline.order],
        invalidation_triggers: ['OrderService.createOrder 函数体逻辑重构或切换 Outbox 模式'],
        verification_method: 'node --test --test-name-pattern=order tests/scenarios.test.mjs',
        alternatives: [],
        enforcement: { kind: 'test', status: 'implemented', ref: 'tests/scenarios.test.mjs' },
        status: 'active',
        maturity: 'verified',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P0',
        capture_assessment_id: ca3.id,
        supersedes: null,
        evidence: [
          {
            id: 'EV-903',
            source_type: 'git_commit',
            source_ref: baseline.commit,
            locator: baseline.orderLocator,
            summary: '模拟提交延迟 30ms 的履约消费竞态复现测试',
          },
          {
            id: 'EV-903-SCOPE',
            source_type: 'doc_ref',
            source_ref: 'docs/demo-evidence.md',
            locator: 'docs/demo-evidence.md#L7',
            summary: '示例按订单履约的业务时序约束归为领域知识，经验与代码仍保存在当前仓库。',
          },
        ],
        created_at: now,
        updated_at: now,
        last_validated_at: now,
        review_due_at: future,
      };
      store.upsertEntry(k3, 'project', ca3);

      // 5. Pending Delta Prism Review Candidate in Review Queue!
      const caPending: CaptureAssessment = {
        id: 'CA-DEMO-04',
        workspace_id: store.workspaceId,
        source_fingerprint: 'fp-demo-04',
        question: '大体积报表导出为何禁止使用 ORM 实体全量映射而采用游标流？',
        checked_context: {
          head_commit: baseline.commit,
          checked_files: ['src/report/exporter.ts'],
          checked_docs: ['README.md'],
          method: 'isolated_check',
          token_used: 390,
          duration_ms: 310,
        },
        discoverability: 'missing_context',
        baseline_answer: 'exporter.ts 使用了 raw SQL cursor 流式读取，未写明为何不用标准 Repository.find()。',
        knowledge_delta: '10 万行 ORM 实体水合（Hydration）会产生约 780MB V8 堆对象，在 K8s 512MB Pod 限制下必触发 OOMKilled (Exit 137)。',
        claim_evidence_map: [
          {
            assertion: '10万行级导出禁用 ORM Hydration，必须走数据库原生游标流且每批 <= 500 行',
            evidence_locator: 'src/report/exporter.ts#L1-L3',
            verified_fact: true,
          },
        ],
        omission_consequence: '新同学为图方便改回 Repository.find() 会直接打爆生产导出 Pod 内存',
        priority: 'P1',
        disposition: 'knowledge_candidate',
        created_at: now,
      };
      const pendingDraft: KnowledgeEntry = {
        id: 'K-0904',
        revision: 1,
        type: 'pitfall',
        knowledge_role: 'experience',
        layer: 'project',
        title: '十万行级报表导出严禁使用 ORM 实体水合，必须走原生游标流防 Pod OOM',
        search_aliases: ['OOM', 'Exit 137', '内存溢出', '报表导出', 'cursor stream'],
        claim: '超过 5000 行的导出查询禁止经过 ORM 实体实例化，必须采用数据库原生流式游标直写响应流。',
        knowledge_delta: caPending.knowledge_delta,
        rationale: 'Pod 内存硬上限 512MB，ORM 对象包装开销约为原始行数据的 6 倍。',
        preconditions: ['开发或修改后台大数据量 CSV/XLSX 导出接口'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/report/**/*.ts'],
        symbol_anchors: [],
        invalidation_triggers: ['导出链路整体迁移至离线对象存储批处理架构'],
        verification_method: 'node --test --test-name-pattern=report tests/scenarios.test.mjs',
        alternatives: [],
        enforcement: { kind: 'none', status: 'proposed', ref: null },
        status: 'candidate',
        maturity: 'draft',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P1',
        capture_assessment_id: caPending.id,
        supersedes: null,
        evidence: [
          {
            id: 'EV-904',
            source_type: 'git_commit',
            source_ref: baseline.commit,
            locator: 'src/report/exporter.ts#L1-L3',
            summary: 'Pod Exit 137 内存快照对比与游标流压测报告',
          },
        ],
        created_at: now,
        updated_at: now,
        last_validated_at: null,
        review_due_at: future,
      };
      store.recordAssessment(caPending, pendingDraft);

      // 6. Code Navigation Item (`index_only` demonstration)
      store.appendNavigationItem({
        id: 'NAV-DEMO-01',
        kind: 'code_index',
        title: '系统全局错误码枚举与 HTTP 状态映射表（代码可直接恢复，不占经验库）',
        locator: 'src/common/errors/error-codes.ts#L1',
        summary: '增量门禁判定为 code_recoverable，自动分流至导航锚点而非冗余经验正文',
        assessment_id: 'CA-DEMO-01',
        created_at: now,
      });

      advanceDemoOrder(store.paths.projectRoot);
      stalenessScanner.scanWorkspace();
      return { seeded: true };
    },

    'accremind.demo.clear': () => {
      if (!deps.demoMode) throw new Error('请先进入独立演示工作区');
      const dirs = [
        store.paths.projectRulesDir,
        store.paths.projectEntriesDir,
        store.paths.probationDir,
      ];
      for (const dir of dirs) {
        for (const id of [...DEMO_ENTRY_IDS, 'K-0904']) {
          const p = path.join(dir, `${id}.md`);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
      for (const caId of DEMO_ASSESSMENT_IDS) {
        store.rawDb.prepare('DELETE FROM capture_assessments WHERE id = ?').run(caId);
      }
      if (fs.existsSync(store.paths.navigationFilePath)) {
        const filtered = store
          .listNavigationItems()
          .filter((n) => n.id !== 'NAV-DEMO-01');
        fs.writeFileSync(
          store.paths.navigationFilePath,
          `${JSON.stringify(filtered, null, 2)}\n`,
          'utf8',
        );
      }
      store.rebuildIndexFromScratch();
      return { cleared: true };
    },
  };
}
