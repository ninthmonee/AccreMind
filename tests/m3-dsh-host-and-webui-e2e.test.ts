import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { CaptureAssessment, KnowledgeEntry } from '@accremind/core';
import {
  apply as applyAccreMindPlugin,
  createAccreMindRuntime,
  renderAccreMindWebuiHtml,
  type CordisContext,
  type DshNativeToolPostExecuteContext,
  type DshProjectedMessage,
} from '@accremind/dsh-plugin';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('M1-B & M3: Native DSH Seams (`systemPrompt`, `registerMessageProjection`, `tools/post-execute`) & WebUI RPC E2E', () => {
  it('wires native `@deepseek-ai/dsh` systemPrompt section, non-mutating message projection, and `tools/post-execute` waterfall', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m3-dsh-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(path.join(repoRoot, 'src/auth'), { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    // Pre-seed a team mandatory rule + a project pitfall
    const seedRuntime = createAccreMindRuntime({
      projectRoot: repoRoot,
      globalDir,
      writeGate: 'off',
    });

    const ruleEntry: KnowledgeEntry = {
      id: 'R-0001',
      revision: 1,
      type: 'guideline',
      polarity: 'avoid',
      knowledge_role: 'authoritative_mirror',
      layer: 'team_rule',
      title: '严禁在日志中打印明文 JWT 或用户手机号',
      search_aliases: ['隐私日志', 'JWT脱敏'],
      claim: '所有认证日志输出必须经过 maskToken() 与 maskPhone() 处理。',
      knowledge_delta: '',
      rationale: '安全合规审计强制红线（ADR-SEC-01）',
      preconditions: ['任何服务端日志输出'],
      exclusions: [],
      dependency_constraints: [],
      watch_paths: [],
      symbol_anchors: [],
      invalidation_triggers: ['安全规范版本更新'],
      verification_method: 'pnpm lint:sec',
      alternatives: [],
      enforcement: { kind: 'lint', status: 'verified', ref: 'eslint-rule-no-pii' },
      status: 'active',
      maturity: 'proven',
      freshness: 'current',
      serving: 'enabled',
      priority: 'P0',
      capture_assessment_id: null,
      supersedes: null,
      evidence: [
        {
          id: 'EV-R1',
          source_type: 'doc_ref',
          source_ref: 'docs/sec-policy.md',
          locator: 'docs/sec-policy.md#L1-L20',
          summary: '团队安全红线规范镜像',
        },
      ],
      created_at: '2026-11-18T00:00:00.000Z',
      updated_at: '2026-11-18T00:00:00.000Z',
      last_validated_at: '2026-11-18T00:00:00.000Z',
      review_due_at: '2027-06-01T00:00:00.000Z',
    };
    seedRuntime.store.upsertEntry(ruleEntry, 'rules', null);

    const authAssessment: CaptureAssessment = {
      id: 'CA-AUTH1',
      workspace_id: seedRuntime.store.workspaceId,
      source_fingerprint: 'fp-auth-1',
      question: '刷新 RefreshToken 时为何必须宽限 5 秒并发窗口？',
      checked_context: {
        head_commit: 'aaa',
        checked_files: ['src/auth/token.ts'],
        checked_docs: [],
        method: 'single_pass_check',
        token_used: 100,
        duration_ms: 30,
      },
      discoverability: 'missing_context',
      baseline_answer: '代码有 5s grace window',
      knowledge_delta: '移动端多 Tab 并发请求会同时携带旧 RefreshToken，无宽限期会导致用户瞬间被踢登出。',
      claim_evidence_map: [
        {
          assertion: '多并发请求需 5 秒旧票据宽限窗口',
          evidence_locator: 'src/auth/token.ts#L15-L40',
          verified_fact: true,
        },
      ],
      omission_consequence: '误删宽限逻辑会导致多请求并发踢登出',
      priority: 'P0',
      disposition: 'knowledge_candidate',
      created_at: '2026-11-18T00:00:00.000Z',
    };

    const authPitfall: KnowledgeEntry = {
      id: 'K-0888',
      revision: 1,
      type: 'pitfall',
      knowledge_role: 'experience',
      layer: 'project',
      title: 'RefreshToken 轮换必须保留 5 秒旧票据并发宽限窗口',
      search_aliases: ['莫名退出登录', '被踢下线', 'refresh token grace'],
      claim: '轮换新 RefreshToken 时旧票据设置 5s 宽限期而非立即物理删除。',
      knowledge_delta: '客户端弱网并发重发携带同一旧票据，立即作废会触发安全重放告警把用户踢下线。',
      rationale: '移动端弱网并发请求实测复现。',
      preconditions: ['修改 src/auth/token.ts 票据轮换逻辑'],
      exclusions: [],
      dependency_constraints: [],
      watch_paths: ['src/auth/**/*.ts'],
      symbol_anchors: [],
      invalidation_triggers: ['客户端引入单飞队列锁后复核'],
      verification_method: 'pnpm test auth-grace.spec.ts',
      alternatives: [],
      enforcement: { kind: 'test', status: 'implemented', ref: 'src/auth/auth-grace.spec.ts' },
      status: 'active',
      maturity: 'verified',
      freshness: 'current',
      serving: 'enabled',
      priority: 'P0',
      capture_assessment_id: 'CA-AUTH1',
      supersedes: null,
      evidence: [
        {
          id: 'EV-888',
          source_type: 'file_lines',
          source_ref: 'src/auth/token.ts',
          locator: 'src/auth/token.ts#L15-L40',
          summary: '5s 宽限期逻辑与压测用例',
        },
      ],
      created_at: '2026-11-18T00:00:00.000Z',
      updated_at: '2026-11-18T00:00:00.000Z',
      last_validated_at: '2026-11-18T00:00:00.000Z',
      review_due_at: '2027-06-01T00:00:00.000Z',
    };
    seedRuntime.store.upsertEntry(authPitfall, 'project', authAssessment);
    seedRuntime.dispose();

    // Now mount onto a mock `@deepseek-ai/dsh` host context
    let registeredPromptTextFn: (() => string | Promise<string>) | null = null;
    let registeredProjector:
      | ((ctx: { sessionId: string; messages: DshProjectedMessage[] }) => DshProjectedMessage[] | Promise<DshProjectedMessage[]>)
      | null = null;
    let postExecuteHook:
      | ((execCtx: DshNativeToolPostExecuteContext, next?: () => Promise<unknown>) => Promise<unknown>)
      | null = null;
    let providedService: unknown = null;
    const cleanups: Array<() => void> = [];

    const dshCtx: CordisContext = {
      effect(setup) {
        cleanups.push(setup());
      },
      provide(name, inst) {
        if (name === 'accremind') providedService = inst;
      },
      systemPrompt: {
        section(spec) {
          registeredPromptTextFn = spec.text;
        },
      },
      sessions: {
        registerMessageProjection(proj) {
          registeredProjector = proj;
        },
      },
      on(event, listener) {
        if (event === 'tools/post-execute') {
          postExecuteHook = listener;
        }
        return () => {};
      },
    };

    applyAccreMindPlugin(dshCtx, { projectRoot: repoRoot, globalDir });

    assert.ok(providedService, 'Should register `accremind` service via ctx.provide');
    assert.ok(registeredPromptTextFn, 'Should register `accremind-resident-rules` section');
    assert.ok(registeredProjector, 'Should register non-mutating message projection');
    assert.ok(postExecuteHook, 'Should register `tools/post-execute` waterfall');

    // 1. Check Tier 1 Resident Rules byte stability
    const p1 = await registeredPromptTextFn!();
    const p2 = await registeredPromptTextFn!();
    assert.equal(p1, p2, 'Resident system section must be 100% byte-identical across turns');
    assert.match(p1, /R-0001@r1/);

    // 2. Check Message Projection (colloquial query "被踢下线" hits K-0888 via search_aliases!)
    const rawMessages: DshProjectedMessage[] = [
      { role: 'user', content: '为什么移动端用户偶尔会被踢下线？' },
    ];
    const projected = await registeredProjector!({
      sessionId: 'sess-proj-1',
      messages: rawMessages,
    });
    assert.equal(
      rawMessages[0]!.content,
      '为什么移动端用户偶尔会被踢下线？',
      'Must NOT mutate persistent raw transcript message!',
    );
    assert.match(projected[0]!.content, /<accremind-radar role="reference-only"/);
    assert.match(projected[0]!.content, /K-0888/);

    // 3. Check `tools/post-execute` waterfall in a fresh session touching `src/auth/token.ts`
    const execCtx: DshNativeToolPostExecuteContext = {
      sessionId: 'sess-waterfall-2',
      tool: 'edit_file',
      args: { path: 'src/auth/token.ts' },
      output: { content: [{ type: 'text', text: 'Updated token.ts' }] },
    };
    let nextCalled = false;
    await postExecuteHook!(execCtx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(execCtx.output.content.length, 2);
    assert.match(execCtx.output.content[1]!.text, /<accremind-guard/);
    assert.match(execCtx.output.content[1]!.text, /K-0888/);

    for (const fn of cleanups) fn();
  });

  it('validates Observatory WebUI bundle invariants and runs full WebUI RPC lifecycle (Demo Seed, 3-Lane Compiler Reactor, Delta Prism, S03/S01)', async () => {
    // 1. Programmatic Observatory WebUI HTML + Embedded Script Syntax & Security Audit
    const html = renderAccreMindWebuiHtml({ embedded: false });
    assert.match(html, /\[data-theme="dark"\]/, 'Must include Obsidian dark theme tokens');
    assert.match(html, /\[data-theme="light"\]/, 'Must include Alabaster light theme tokens');
    assert.match(html, /cmdk-mask/, 'Must include Command Palette (Cmd+K) modal');
    assert.equal(html.includes('node:sqlite'), false, 'WebUI client must never reference node:sqlite');
    assert.equal(html.includes('node:fs'), false, 'WebUI client must never reference node:fs');

    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(scriptMatch?.[1], 'Should contain inline Observatory controller script');
    const clientCode = scriptMatch[1]!;
    assert.equal(/\b(?:prompt|alert)\s*\(/.test(clientCode), false, 'Must use custom modals, ZERO native prompt()/alert()');
    // Compile client JS with Function constructor as a deterministic syntax gate!
    assert.doesNotThrow(() => new Function(clientCode));

    // 2. Full WebUI RPC End-to-End Lifecycle
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-m3-rpc-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(globalDir, { recursive: true });

    const runtime = createAccreMindRuntime({
      projectRoot: repoRoot,
      globalDir,
      writeGate: 'probation',
    });

    // Test Demo Playground Seeding -> Live 3-Lane Compiler Reactor -> Delta Prism Review -> Clean Clear!
    await runtime.rpcHandlers['accremind.demo.seed']!({});
    const seededOv = (await runtime.rpcHandlers['accremind.dashboard.overview']!({})) as {
      hasDemoSeeded: boolean;
      counts: { rulesCount: number; pendingReviewCount: number };
    };
    assert.equal(seededOv.hasDemoSeeded, true);
    assert.equal(seededOv.counts.rulesCount, 1);
    assert.equal(seededOv.counts.pendingReviewCount, 1);

    // Live 3-Lane Compiler Reactor (`accremind.sim.compile`): vague prompt + mid-turn `src/payment/webhook.ts`
    const reactorOut = (await runtime.rpcHandlers['accremind.sim.compile']!({
      userPrompt: '帮我重构一下账务结算模块代码结构',
      midTurnToolFile: 'src/payment/webhook.ts',
    })) as {
      residentPrefix: string;
      residentSha256: string;
      guardBlock: string;
      guardSurfacedIds: string[];
    };
    assert.match(reactorOut.residentPrefix, /R-0901@r1/);
    assert.notEqual(reactorOut.residentSha256, 'empty');
    assert.match(reactorOut.guardBlock, /<accremind-guard/);
    assert.ok(reactorOut.guardSurfacedIds.includes('K-0901'));

    // Approve pending Delta Prism candidate (`CA-DEMO-04`) into active project store
    const prismDecide = (await runtime.rpcHandlers['accremind.review.decide']!({
      assessmentId: 'CA-DEMO-04',
      decision: 'approve_active',
    })) as { ok: boolean; persistedEntry?: KnowledgeEntry };
    assert.equal(prismDecide.ok, true);
    assert.equal(prismDecide.persistedEntry?.id, 'K-0904');

    // Clear demo samples back to pristine state
    await runtime.rpcHandlers['accremind.demo.clear']!({});
    const clearedOv = (await runtime.rpcHandlers['accremind.dashboard.overview']!({})) as {
      hasDemoSeeded: boolean;
      counts: { totalEntries: number };
    };
    assert.equal(clearedOv.hasDemoSeeded, false);
    assert.equal(clearedOv.counts.totalEntries, 0);

    // Capture via tool -> enters `probation`
    const capTool = runtime.tools.find((t) => t.name === 'accremind_capture')!;
    const capRes = await capTool.execute({
      question: '批量导入 CSV 时为什么必须用流式解析？',
      discoverability: 'missing_context',
      disposition: 'knowledge_candidate',
      baseline_answer: '当前使用 createReadStream',
      knowledge_delta: '超过 50MB 的报表一次性 readFileSync 曾触发容器 512MB OOM 重启。',
      title: 'CSV 导入严禁整文件读入内存，必须走流式解析',
      type: 'pitfall',
      priority: 'P1',
      claim: '导入接口一律走 stream pipeline，单批上限 500 行。',
      rationale: '容器内存限制 512MB，曾发生 OOM。',
      search_aliases: ['OOM', '内存溢出', 'CSV导入'],
      preconditions: ['处理用户上传文件解析'],
      invalidation_triggers: ['迁移至独立离线 Worker 后复核'],
      verification_method: 'pnpm test csv-stream.spec.ts',
      file_locator: 'src/import/csv.ts#L10-L40',
    });
    const entryId = (JSON.parse(capRes.content[0]!.text) as { persistedEntry: KnowledgeEntry })
      .persistedEntry.id;

    // Dashboard overview shows 1 probation
    const ov1 = (await runtime.rpcHandlers['accremind.dashboard.overview']!({})) as {
      counts: { probationCount: number; activeCount: number };
    };
    assert.equal(ov1.counts.probationCount, 1);
    assert.equal(ov1.counts.activeCount, 0);

    // Promote from WebUI (`accremind.probation.decide`) -> moves to `active`!
    await runtime.rpcHandlers['accremind.probation.decide']!({
      id: entryId,
      action: 'promote',
    });
    // Submit positive validation -> upgrades to `verified`
    await runtime.rpcHandlers['accremind.feedback.submit']!({
      id: entryId,
      kind: 'verified_effective',
      detail: '压测 100MB CSV 内存稳定在 110MB',
    });

    // Editorial revision (`revisionImpact: 'editorial'`) -> increments revision to 2 AND preserves `verified`!
    const edRev = (await runtime.rpcHandlers['accremind.kb.saveRevision']!({
      id: entryId,
      revisionImpact: 'editorial',
      patch: { title: 'CSV 大文件导入必须走流式解析防容器 OOM' },
    })) as { ok: true; entry: KnowledgeEntry };
    assert.equal(edRev.ok, true);
    assert.equal(edRev.entry.revision, 2);
    assert.equal(edRev.entry.maturity, 'verified');

    // S03 Hard Gate on `saveRevision`: clearing `knowledge_delta` MUST return `{ ok: false, missingFields }`!
    const blockedRev = (await runtime.rpcHandlers['accremind.kb.saveRevision']!({
      id: entryId,
      revisionImpact: 'substantive',
      patch: { knowledge_delta: '   ' },
    })) as { ok: false; missingFields: string[] };
    assert.equal(blockedRev.ok, false);
    assert.ok(blockedRev.missingFields.some((m) => m.includes('knowledge_delta')));

    // Substantive valid revision (`revisionImpact: 'substantive'`) -> increments revision to 3 AND resets `maturity` to `draft`!
    const subRev = (await runtime.rpcHandlers['accremind.kb.saveRevision']!({
      id: entryId,
      revisionImpact: 'substantive',
      patch: { claim: '导入接口一律走 stream pipeline，单批落库上限调整为 200 行。' },
    })) as { ok: true; entry: KnowledgeEntry };
    assert.equal(subRev.ok, true);
    assert.equal(subRev.entry.revision, 3);
    assert.equal(subRev.entry.maturity, 'draft');

    // S01 High-Risk Withdrawal: empty reason throws, valid reason withdraws & blocks `accremind_get`!
    assert.throws(() => {
      runtime.rpcHandlers['accremind.kb.withdraw']!({ id: entryId, reason: '  ' });
    }, /S01 高危操作校验失败/);

    await runtime.rpcHandlers['accremind.kb.withdraw']!({
      id: entryId,
      reason: '旧导入模块已整体下线，由新对象存储直传替代',
    });

    const getTool = runtime.tools.find((t) => t.name === 'accremind_get')!;
    const afterWithdraw = await getTool.execute({ id: entryId });
    assert.equal(afterWithdraw.isError, true);
    assert.match(afterWithdraw.content[0]!.text, /withdrawn/);

    runtime.dispose();
  });
});
