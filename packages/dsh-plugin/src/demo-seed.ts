import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  serializeEntryMarkdown,
  sha256Hex,
  type CaptureAssessment,
  type GitStalenessScanner,
  type KnowledgeEntry,
  type LocalMarkdownSqliteStore,
} from '@accremind/core';
import { advanceDemoOrder, readDemoBaseline } from './demo-fixture.ts';
import type { RpcHandlerMap } from './rpc-handlers.ts';

/**
 * Demo workspace only: sample entries, assessments and usage history for the “体验示例” space.
 * Kept apart from the production handlers; every handler refuses to run outside demo mode.
 */
export const DEMO_ENTRY_IDS = ['R-0901', 'K-0901', 'K-0902', 'K-0903'];
const DEMO_ASSESSMENT_IDS = ['CA-DEMO-01', 'CA-DEMO-02', 'CA-DEMO-03', 'CA-DEMO-04'];

export function createDemoHandlers({ store, stalenessScanner, demoMode }: {
  store: LocalMarkdownSqliteStore;
  stalenessScanner: GitStalenessScanner;
  demoMode: boolean;
}): RpcHandlerMap {
  return {
    'accremind.demo.seed': () => {
      if (!demoMode) throw new Error('请先进入独立演示工作区');
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

      seedDemoActivity(store);
      seedDemoLedger(store);
      // Snapshots are taken before the sample code changes, so the review page can show “then vs now”.
      advanceDemoOrder(store.paths.projectRoot);
      stalenessScanner.scanWorkspace();
      return { seeded: true };
    },

    'accremind.demo.clear': () => {
      if (!demoMode) throw new Error('请先进入独立演示工作区');
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
        store.deleteAssessment(caId);
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

/** Twenty-eight days of plausible, deterministic reminder and feedback history for the demo charts. */
function seedDemoActivity(store: LocalMarkdownSqliteStore): void {
  const entries = store.listEntriesForAdmin()
    .map(hit => hit.entry)
    .filter(entry => entry.status === 'active' || entry.status === 'probation');
  if (!entries.length) return;
  const weights = entries.map((_, i) => Math.max(1, entries.length - i));
  const rows: Parameters<LocalMarkdownSqliteStore['importDemoActivity']>[0] = [];
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const pick = () => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < entries.length; i++) { r -= weights[i]!; if (r <= 0) return entries[i]!; }
    return entries[0]!;
  };
  const today = new Date();
  for (let back = 27; back >= 0; back--) {
    const day = new Date(today.getTime() - back * 86_400_000);
    const weekday = day.getUTCDay();
    const base = weekday === 0 || weekday === 6 ? 1 : 4;
    const reminders = Math.round(base + (27 - back) * 0.18 + rand() * 4);
    for (let n = 0; n < reminders; n++) {
      const entry = pick();
      const at = new Date(day.getTime() - Math.floor(rand() * 8) * 3_600_000).toISOString();
      rows.push({ kind: 'usage', entryId: entry.id, revision: entry.revision, eventType: entry.priority === 'P0' ? 'guard_shown' : 'radar_shown', at });
      const roll = rand();
      if (roll < 0.34) rows.push({ kind: 'validation', entryId: entry.id, revision: entry.revision, outcome: 'success', at });
      else if (roll < 0.37) rows.push({ kind: 'usage', entryId: entry.id, revision: entry.revision, eventType: 'feedback_inapplicable', at });
    }
  }
  // A handful of recent turns so the turn log shows all three channels, one of them already confirmed helpful.
  const rules = entries.filter(entry => entry.layer === 'team_rule');
  const others = entries.filter(entry => entry.layer !== 'team_rule');
  const prompts = 6;
  for (let n = 0; n < prompts; n++) {
    const at = new Date(today.getTime() - (n * 5 + 1) * 3_600_000).toISOString();
    const sessionId = `demo-session-${Math.floor(n / 2) + 1}`;
    const radar = others[n % Math.max(1, others.length)];
    const guard = others[(n + 1) % Math.max(1, others.length)];
    const hits: Array<{ entryId: string; revision: number; title: string; status: string; source: 'rule' | 'radar' | 'jit'; filePath?: string }> = [
      ...rules.slice(0, 1).map(entry => ({ entryId: entry.id, revision: entry.revision, title: entry.title, status: entry.status, source: 'rule' as const })),
    ];
    if (radar) hits.push({ entryId: radar.id, revision: radar.revision, title: radar.title, status: radar.status, source: 'radar' });
    if (guard && guard !== radar && n % 2 === 0) {
      hits.push({ entryId: guard.id, revision: guard.revision, title: guard.title, status: guard.status, source: 'jit',
        filePath: guard.symbol_anchors[0]?.file_path ?? guard.watch_paths[0] });
    }
    rows.push({ kind: 'turn', sessionId, turnId: `demo-turn-${n + 1}`, at, hits });
    if (n === 1 && radar) rows.push({ kind: 'validation', entryId: radar.id, revision: radar.revision, outcome: 'success', at, sessionId });
  }
  store.importDemoActivity(rows);
}

/** Publication records, evidence snapshots and confirmations from two teammates for the demo entries. */
function seedDemoLedger(store: LocalMarkdownSqliteStore): void {
  const live = store.listEntriesForAdmin().map((hit) => hit.entry)
    .filter((entry) => entry.status === 'active' || entry.status === 'probation');
  const day = 86_400_000;
  const people = ['lin.wei@example.com', 'chen.yu@example.com'];
  live.forEach((entry, i) => {
    const published = new Date(Date.now() - (20 - i) * day).toISOString();
    store.ledger.append(entry, { kind: 'decision', action: 'publish', note: '人工审核批准入库', at: published, actor: people[0] });
    store.snapshots.capture(entry);
    if (entry.maturity === 'draft') return;
    store.ledger.append(entry, { kind: 'validated', task: `ticket-${entry.id}-1`, note: '在真实任务中确认有用', at: new Date(Date.now() - (10 - i) * day).toISOString(), actor: people[0] });
    if (entry.maturity === 'proven') {
      store.ledger.append(entry, { kind: 'validated', task: `ticket-${entry.id}-2`, note: '另一项独立任务复现并确认', at: new Date(Date.now() - (4 - i % 3) * day).toISOString(), actor: people[1] });
    }
  });
}
