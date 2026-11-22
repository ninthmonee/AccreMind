import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { CaptureAssessment, KnowledgeEntry } from '@accremind/core';
import { createAccreMindRuntime, renderAccreMindWebuiHtml } from '@accremind/dsh-plugin';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('M1-B & M3: candidate review and workbench RPC end to end', () => {
  it('keeps incomplete assessments pending and promotes the same card after human evidence is supplied', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-review-'));
    tempDirs.push(base);
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    const runtime = createAccreMindRuntime({projectRoot:repo, globalDir:path.join(base,'global')});
    try {
      const delta = '支付渠道重复交付回调时需保存去重凭据';
      const assessment: CaptureAssessment = {
        id:'CA-human', workspace_id:runtime.store.workspaceId, source_fingerprint:'fp-human',
        question:'支付渠道重复交付回调时如何处理？', baseline_answer:'可定位回调入口。',
        knowledge_delta:delta, checked_context:{head_commit:'HEAD', checked_files:[], checked_docs:[],
          method:'single_pass_check', token_used:40, duration_ms:10},
        discoverability:'inconclusive', disposition:'needs_confirmation',
        claim_evidence_map:[{assertion:delta, evidence_locator:null, verified_fact:false}],
        omission_consequence:'重复记账', priority:'P1', created_at:new Date().toISOString(),
      };
      runtime.store.recordAssessment(assessment);
      assert.equal(runtime.store.getReviewItem(assessment.id)?.reviewState, 'pending');
      const decide = (params:Record<string, unknown>) =>
        runtime.rpcHandlers['accremind.review.decide']!({assessmentId:assessment.id, ...params});
      const blocked = await decide({decision:'approve_probation'}) as {ok:boolean};
      assert.equal(blocked.ok,false);
      const wrongScope = await decide({decision:'supplement', editedEntry:{layer:'team_rule'}}) as {ok:boolean};
      assert.equal(wrongScope.ok,false);
      await decide({decision:'supplement', editedEntry:{layer:'domain'}, knowledgeDelta:delta, evidenceLocator:'tests/pay.ts#L13',
        evidenceNote:'重复回调回归用例中出现两笔扣款'});
      const draftId = runtime.store.getReviewItem(assessment.id)?.candidateDraft?.id;
      assert.equal(runtime.store.getReviewItem(assessment.id)?.candidateDraft?.layer,'domain');
      const approved = await decide({decision:'approve_probation', editedEntry:{
        title:'渠道回调必须在入口处去重', claim:delta, rationale:'支付渠道会重试超时的回调。',
        preconditions:['支付回调入口'], invalidation_triggers:['重试协议变更'],
        verification_method:'运行支付回调并发用例',
      }}) as {ok:boolean; persistedEntry?:KnowledgeEntry};
      assert.equal(approved.ok,true);
      assert.equal(approved.persistedEntry?.id,draftId);
      assert.equal(approved.persistedEntry?.layer,'domain');
      assert.equal(approved.persistedEntry?.evidence[0]?.locator, 'tests/pay.ts#L13');
      assert.equal(runtime.store.getReviewItem(assessment.id)?.reviewState,'decided');
      assert.throws(() => decide({decision:'discard'}), /已由其他操作处理/);
      for (let i = 0; i < 55; i++) {
        runtime.store.recordAssessment({...assessment, id:'CA-page-' + i, source_fingerprint:'page-' + i});
      }
      const list = (offset:number) => runtime.rpcHandlers['accremind.review.listQueue']!({reviewState:'pending', offset}) as {items:{assessment:CaptureAssessment}[]; total:number; hasMore:boolean};
      const first = list(0), second = list(50);
      assert.equal(first.total,55);
      assert.equal(first.hasMore,true);
      assert.equal(second.items.length,5);
      assert.equal(second.hasMore,false);
      assert.equal(new Set([...first.items,...second.items].map(i => i.assessment.id)).size,55);
      const otherRepo = path.join(base,'other');
      fs.mkdirSync(otherRepo);
      const other = createAccreMindRuntime({projectRoot:otherRepo,globalDir:path.join(base,'global')});
      try {
        assert.equal(other.store.getReviewItem(assessment.id),null);
        assert.equal(other.store.findAssessmentByFingerprint(assessment.source_fingerprint),null);
        other.store.recordAssessment({...assessment,id:'CA-other',workspace_id:other.store.workspaceId});
        assert.equal(other.store.countAssessments('pending'),1);
        assert.equal(runtime.store.findAssessmentByFingerprint(assessment.source_fingerprint)?.id,assessment.id);
      } finally {
        other.dispose();
      }
    } finally {
      runtime.dispose();
    }
  });

  // Host wiring (rules section, pre-step radar, post-execute reminder) is covered in dsh-native-host.test.ts.

  it('validates Observatory WebUI bundle invariants and runs full WebUI RPC lifecycle (Demo Seed, 3-Lane Compiler Reactor, Delta Prism, S03/S01)', async () => {
    // 1. Programmatic Observatory WebUI HTML + Embedded Script Syntax & Security Audit
    const html = renderAccreMindWebuiHtml({ embedded: false });
    assert.match(html, /\[data-theme="?dark"?\]/, 'Must include graphite (dark) theme tokens');
    assert.match(html, /\[data-theme="?light"?\]/, 'Must include paper (light) theme tokens');
    assert.match(html, /cmdk-mask/, 'Must include Command Palette (Cmd+K) modal');
    assert.equal(html.includes('node:sqlite'), false, 'WebUI client must never reference node:sqlite');
    assert.equal(html.includes('node:fs'), false, 'WebUI client must never reference node:fs');

    // The workbench app is always the last inline script (see packages/webui/scripts/embed.ts).
    const clientCode = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    assert.ok(clientCode.length > 0, 'Should contain the inline workbench script');
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
    assert.throws(() => runtime.rpcHandlers['accremind.demo.seed']!({}));
    const { token } = await runtime.rpcHandlers['accremind.demo.open']!({}) as { token: string };
    const demo = (method: string, params = {}) => runtime.rpcHandlers['accremind.demo.call']!({ token, method, params });
    const seededOv = (await demo('accremind.dashboard.overview')) as {
      hasDemoSeeded: boolean;
      counts: { rulesCount: number; pendingReviewCount: number };
    };
    assert.equal(seededOv.hasDemoSeeded, true);
    assert.equal(seededOv.counts.rulesCount, 1);
    assert.equal(seededOv.counts.pendingReviewCount, 1);

    // Live 3-Lane Compiler Reactor (`accremind.sim.compile`): vague prompt + mid-turn `src/payment/webhook.ts`
    const reactorOut = (await demo('accremind.sim.compile', {
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
    const prismDecide = (await demo('accremind.review.decide', {
      assessmentId: 'CA-DEMO-04',
      decision: 'approve_active',
    })) as { ok: boolean; persistedEntry?: KnowledgeEntry };
    assert.equal(prismDecide.ok, true);
    assert.equal(prismDecide.persistedEntry?.id, 'K-0904');

    // Clear demo samples back to pristine state
    await runtime.rpcHandlers['accremind.demo.close']!({token});
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
      taskFingerprint: 'csv-load-test',
      revision: 1,
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
    }, /明确原因/);

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
