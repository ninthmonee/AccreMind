import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { runEvaluation, type KnowledgeEntry, type LlmInferenceAdapter } from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const base = fs.mkdtempSync(path.join(tmpdir(), 'accremind-docs-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let seq = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function makeRepo(name: string, opts: { files?: Record<string, string>; commit?: boolean } = {}): string {
  const root = path.join(base, `${name}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'dev@example.com']);
  git(root, ['config', 'user.name', 'Dev']);
  git(root, ['remote', 'add', 'origin', `git@github.com:acme/${name}-${seq}.git`]);
  for (const [rel, body] of Object.entries(opts.files ?? { 'src/index.ts': 'export {};\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, ['add', '-A']);
  if (opts.commit) git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

function open(root: string, g: string, llmAdapter: LlmInferenceAdapter | null = null): AccreMindPluginInstance {
  return createAccreMindRuntime({ projectRoot: root, globalDir: g, writeGate: 'off', llmAdapter, autoCapture: { enabled: false } });
}

function card(id: string, over: Partial<KnowledgeEntry>): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    id, revision: 1, type: 'pitfall', polarity: 'avoid', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: '默认标题占位', search_aliases: [], claim: '默认结论内容', knowledge_delta: '默认增量', rationale: 'r',
    preconditions: ['适用前提'], exclusions: [], dependency_constraints: [], watch_paths: [], symbol_anchors: [], invalidation_triggers: ['t'],
    verification_method: 'v', alternatives: [], enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active',
    maturity: 'verified', freshness: 'current', serving: 'enabled', priority: 'P1', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'EV-1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: 's' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: new Date(Date.now() + 90 * 864e5).toISOString(),
    ...over,
  };
}

const REFUND_RULES = `# 退款规则

退款相关的业务规则。

## 部分退款

部分退款金额不能超过订单剩余可退金额；同一订单最多部分退款 5 次。

## 退款时机

清算日结完成之前不能发起退款，否则对账会出现负余额。
`;

describe('Rule document sets', () => {
  it('imports, indexes by section and serves domain documents to repositories of the same domain only', async () => {
    const g = path.join(base, 'g-docs');
    const a = open(makeRepo('pay-api'), g);
    const b = open(makeRepo('pay-admin'), g);
    const c = open(makeRepo('wms'), g);
    try {
      a.store.updateRepoProfile({ domains: ['payment'] });
      b.store.updateRepoProfile({ domains: ['payment'] });
      c.store.updateRepoProfile({ domains: ['logistics'] });
      const imported = await a.rpcHandlers['accremind.docs.import']!({ content: REFUND_RULES, fileName: 'refund.md', category: 'business_rules' }) as { docId: string; sections: number };
      assert.equal(imported.sections, 2);
      await a.rpcHandlers['accremind.docs.import']!({ content: '# 编码规范\n\n## 金额字段\n\n金额字段统一用分为单位的整数。\n', fileName: 'coding.md', category: 'project_norms' });
      const docFile = path.join(a.store.paths.projectAccreMindDir, 'docs', 'business_rules', 'refund.md');
      assert.match(fs.readFileSync(docFile, 'utf8'), /domains: \["payment"\]/, 'shareable documents take the repository domains');

      const inA = a.store.searchDocs({ query: '部分退款最多几次' });
      assert.equal(inA[0]?.heading, '部分退款');
      const inB = b.store.searchDocs({ query: '部分退款最多几次' });
      assert.equal(inB[0]?.originRepo, a.store.workspaceId, 'same domain: served in B, labelled with its origin');
      assert.deepEqual(c.store.searchDocs({ query: '部分退款最多几次' }), [], 'other domain: not served');
      assert.deepEqual(b.store.searchDocs({ query: '金额字段 单位' }), [], 'project norms stay in their repository');
      assert.equal(a.store.searchDocs({ query: '金额字段 单位' })[0]?.heading, '金额字段');

      const view = a.viewCompiler.compileTurnView({ sessionId: 's1', userPrompt: '部分退款最多可以退几次？', preview: true });
      assert.ok(view.docRefs.some((r) => r.endsWith('#部分退款')));
      assert.match(view.radarBlock, /规则文档·业务规则/);
      const get = a.tools.find((t) => t.name === 'accremind_get')!;
      const body = (await get.execute({ id: view.docRefs[0]! })).content[0]!.text;
      assert.match(body, /同一订单最多部分退款 5 次/);
    } finally {
      a.dispose();
      b.dispose();
      c.dispose();
    }
  });

  it('carries the project profile as resident context', async () => {
    const g = path.join(base, 'g-profile');
    const a = open(makeRepo('profile'), g);
    try {
      await a.rpcHandlers['accremind.docs.import']!({
        content: '# 项目概况\n\n## 业务定位\n\nB2B 跨境支付网关，服务外贸商户。\n\n## 核心用户\n\n商户财务与运营。\n', fileName: 'profile.md', category: 'project_profile',
      });
      const first = a.viewCompiler.compileTurnView({ sessionId: 'p1', preview: true }).residentPrefix;
      assert.match(first, /accremind-profile/);
      assert.match(first, /业务定位：B2B 跨境支付网关/);
      assert.equal(a.viewCompiler.compileTurnView({ sessionId: 'p2', preview: true }).residentPrefix, first, 'byte-stable across turns');
    } finally {
      a.dispose();
    }
  });

  it('applies AI proposals only after a person accepts them, and logs every change in detail', async () => {
    const g = path.join(base, 'g-proposal');
    const a = open(makeRepo('proposal'), g);
    try {
      const { docId } = a.store.docs.importDoc({ content: REFUND_RULES, fileName: 'refund.md', category: 'business_rules' });
      const file = path.join(a.store.paths.projectAccreMindDir, 'docs', 'business_rules', 'refund.md');
      const before = fs.readFileSync(file, 'utf8');
      const tool = a.tools.find((t) => t.name === 'accremind_propose_doc_change')!;
      const out = JSON.parse((await tool.execute({
        doc_id: docId, section: '部分退款', op: 'update_section', content: '部分退款金额不能超过剩余可退金额；同一订单最多部分退款 10 次（2026-11 起）。',
        rationale: 'refund.ts 中 MAX_PARTIAL_REFUNDS 已改为 10', evidence: 'src/refund.ts#L12',
      }, { sessionId: 'dev-1' })).content[0]!.text);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing is written by a proposal');
      const pending = a.store.docs.listProposals('pending');
      assert.equal(pending.length, 1);
      const decided = await a.rpcHandlers['accremind.docs.decide']!({ id: out.proposal_id, decision: 'accept' }) as { change: { before: string; after: string; version: number } };
      assert.match(fs.readFileSync(file, 'utf8'), /最多部分退款 10 次/);
      assert.match(fs.readFileSync(file, 'utf8'), /version: 2/);
      assert.match(decided.change.before, /5 次/);
      assert.match(decided.change.after, /10 次/);
      const changes = a.store.docs.listChanges({ docId });
      assert.deepEqual(changes.map((c) => c.op), ['update_section', 'import']);
      assert.ok(changes.every((c) => c.op !== 'manual_edit'), 'its own writes are not reported as direct edits');
      assert.match(fs.readFileSync(path.join(a.store.paths.projectAccreMindDir, 'docs', 'CHANGELOG.md'), 'utf8'), /修改章节　章节：部分退款/);
      assert.ok(a.store.searchDocs({ query: '最多部分退款 10 次' }).length > 0, 're-indexed immediately');

      // A proposal based on text that changed since is refused instead of overwriting it.
      const stale = a.store.docs.propose({ docId, section: '退款时机', op: 'update_section', content: '新内容新内容', rationale: 'r' });
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('否则对账会出现负余额', '否则会出现负余额并触发告警'));
      a.store.docs.reconcile();
      assert.throws(() => a.store.docs.decide(stale.id, 'accept'), /已被修改/);
      const manual = a.store.docs.listChanges({ docId })[0]!;
      assert.equal(manual.op, 'manual_edit', 'a direct edit of the file is recorded too');
      assert.equal(manual.section, '退款时机');
      assert.match(manual.after ?? '', /触发告警/);
      a.store.docs.decide(stale.id, 'reject', { note: '内容已过时' });
      assert.equal(a.store.docs.listProposals('pending').length, 0);
    } finally {
      a.dispose();
    }
  });
});

describe('Topic tags', () => {
  it('matches a question to knowledge through the controlled vocabulary when they share no words', () => {
    const g = path.join(base, 'g-vocab');
    const root = makeRepo('vocab');
    fs.mkdirSync(path.join(root, '.accremind'), { recursive: true });
    fs.writeFileSync(path.join(root, '.accremind', 'vocabulary.json'), JSON.stringify({ version: 1, tags: [
      { id: 'refund', label: '退款', aliases: ['退钱', 'refund', '退单'], kind: 'term' },
    ] }));
    const a = open(root, g);
    try {
      const e = a.store.upsertEntry(card('K-TAGREFUND0001A', { title: '退钱流程必须走二次审批', claim: '大额退钱必须经过财务二次审批。' }), 'project', null);
      const hits = a.store.search({ workspaceId: a.store.workspaceId, query: '客户申请退款要注意什么' }).items;
      const hit = hits.find((h) => h.entry.id === e.id);
      assert.ok(hit, 'found through the shared tag');
      assert.ok(hit.matchReasons.some((r) => r.includes('主题标签') && r.includes('退款')));
    } finally {
      a.dispose();
    }
  });

  it('asks the model for tags on the first turn and on topic changes, reuses them otherwise, and queues new terms', async () => {
    const g = path.join(base, 'g-model-tags');
    const root = makeRepo('model-tags');
    fs.mkdirSync(path.join(root, '.accremind'), { recursive: true });
    fs.writeFileSync(path.join(root, '.accremind', 'vocabulary.json'), JSON.stringify({ version: 1, tags: [
      { id: 'refund', label: '退款', aliases: [], kind: 'term' },
      { id: 'settlement', label: '清算', aliases: [], kind: 'term' },
    ] }));
    let calls = 0;
    const llm: LlmInferenceAdapter = {
      async completeJson(req) {
        calls += 1;
        const question = /问题：(.*)/.exec(req.userPrompt)?.[1] ?? '';
        const tags = question.includes('钱要回去') ? ['refund'] : question.includes('对账') ? ['settlement'] : [];
        return { tokenUsed: 5, content: JSON.stringify({ tags, proposed: question.includes('拒付') ? [{ label: '拒付', kind: 'term' }] : [] }) };
      },
    };
    const a = open(root, g, llm);
    try {
      const e = a.store.upsertEntry(card('K-MODELTAG0001AA', { title: '退款前必须冻结积分', claim: '退款前先冻结用户积分，防止积分被提前消费。' }), 'project', null);
      const first = await a.compileBeforeTurnAsync({ sessionId: 's', turnId: '1', userPrompt: '用户想把钱要回去，系统里要处理什么' });
      assert.ok(first.surfacedIds.includes(e.id), 'the model tag finds what no keyword would');
      assert.equal(calls, 1);
      await a.compileBeforeTurnAsync({ sessionId: 's', turnId: '2', userPrompt: '用户想把钱要回去，系统里还要处理别的吗' });
      assert.ok(calls <= 2, 'same topic: tags reused (at most one background refresh)');
      await a.compileBeforeTurnAsync({ sessionId: 's', turnId: '3', userPrompt: '对账时发现拒付的订单怎么处理' });
      assert.ok(calls >= 2, 'topic changed: asked again');
      await new Promise((r) => setTimeout(r, 20));
      const proposals = a.store.docs.listTagProposals('pending');
      assert.deepEqual(proposals.map((p) => p.label), ['拒付']);
      a.store.docs.decideTag(proposals[0]!.id, 'accept', { aliases: ['chargeback'] });
      assert.ok(a.store.docs.vocabulary().tags.some((t) => t.label === '拒付' && t.aliases.includes('chargeback')));
    } finally {
      a.dispose();
    }
  });

  it('falls back to keyword tags when the model is too slow', async () => {
    const g = path.join(base, 'g-slow');
    const root = makeRepo('slow');
    fs.mkdirSync(path.join(root, '.accremind'), { recursive: true });
    fs.writeFileSync(path.join(root, '.accremind', 'vocabulary.json'), JSON.stringify({ version: 1, tags: [{ id: 'refund', label: '退款' }] }));
    const llm: LlmInferenceAdapter = { completeJson: () => new Promise((r) => setTimeout(() => r({ tokenUsed: 1, content: '{"tags":["refund"]}' }), 5000).unref()) };
    const a = open(root, g, llm);
    try {
      a.store.upsertEntry(card('K-SLOWTAG00001AA', { title: '退款需要审批', claim: '退款需要财务审批后才能执行。' }), 'project', null);
      const t0 = Date.now();
      const view = await a.compileBeforeTurnAsync({ sessionId: 'slow', turnId: '1', userPrompt: '退款流程是什么' });
      assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0}ms`);
      assert.ok(view.surfacedIds.includes('K-SLOWTAG00001AA'));
    } finally {
      a.dispose();
    }
  });
});

describe('First-turn signals', () => {
  it('uses the working tree changes and the branch name when the first message says little', async () => {
    const g = path.join(base, 'g-first');
    const root = makeRepo('first', { files: { 'src/order/service.ts': 'export const a = 1;\n', 'README.md': '# r\n' }, commit: true });
    git(root, ['checkout', '-q', '-b', 'feature/refund-partial']);
    fs.writeFileSync(path.join(root, 'src/order/service.ts'), 'export const a = 2;\n');
    const a = open(root, g);
    try {
      const byPath = a.store.upsertEntry(card('K-FIRSTTURN001AA', { title: '订单服务改动要同步更新对账任务', claim: '修改订单服务必须同步更新对账任务。',
        watch_paths: ['src/order/**'] }), 'project', null);
      const byBranch = a.store.upsertEntry(card('K-FIRSTTURN002AA', { title: 'partial refund 需要校验剩余金额', claim: 'partial refund 前校验剩余可退金额。',
        search_aliases: ['partial refund'] }), 'project', null);
      const view = await a.compileBeforeTurnAsync({ sessionId: 'first', turnId: '1', userPrompt: '帮我看看这个问题' });
      assert.ok(view.surfacedIds.includes(byPath.id), 'changed files in the working tree count as active files');
      assert.ok(view.surfacedIds.includes(byBranch.id), 'the branch name describes the task');
    } finally {
      a.dispose();
    }
  });
});

describe('Offline evaluation', () => {
  it('replays recorded turns and hand-written cases, and only saves tuning that scores better', async () => {
    const g = path.join(base, 'g-eval');
    const root = makeRepo('eval');
    const a = open(root, g);
    try {
      const good = a.store.upsertEntry(card('K-EVALGOOD0001AA', { title: '幂等键必须在重试前生成', claim: '重试请求必须复用第一次生成的幂等键。', search_aliases: ['幂等键'] }), 'project', null);
      const bad = a.store.upsertEntry(card('K-EVALBAD00001AA', { title: '幂等键长度限制', claim: '幂等键长度不能超过 64 字符。', search_aliases: ['幂等键'] }), 'project', null);
      a.compileBeforeTurn({ sessionId: 'sess-1', turnId: '1', userPrompt: '重试的时候幂等键怎么处理' });
      await a.rpcHandlers['accremind.feedback.submit']!({ id: good.id, revision: 1, kind: 'verified_effective', sessionId: 'sess-1', turnId: '1', detail: '有用' });
      await a.rpcHandlers['accremind.feedback.submit']!({ id: bad.id, revision: 1, kind: 'inapplicable', sessionId: 'sess-1', turnId: '1', detail: '无关' });
      fs.mkdirSync(path.join(root, '.accremind', 'eval'), { recursive: true });
      fs.writeFileSync(path.join(root, '.accremind', 'eval', 'cases.jsonl'), [
        JSON.stringify({ query: '幂等键重试怎么复用', expect: [good.id] }),
        JSON.stringify({ query: '把首页按钮改成蓝色', expect: [] }),
      ].join('\n'));
      const report = runEvaluation(a.store, { grid: true, apply: true });
      assert.equal(report.cases.receipt, 1);
      assert.equal(report.cases.hand, 2);
      assert.equal(report.current.recall, 1);
      assert.equal(report.current.noise, 0);
      assert.ok(report.current.forbiddenShown > 0, 'the entry reported as not applicable is still shown with the defaults');
      assert.ok(report.ranking && report.ranking.length > 0);
      if (report.appliedTo) assert.ok(fs.existsSync(report.appliedTo));
      else assert.ok(report.best!.metrics.score <= report.current.score, 'nothing saved unless it is better');
    } finally {
      a.dispose();
    }
  });
});
