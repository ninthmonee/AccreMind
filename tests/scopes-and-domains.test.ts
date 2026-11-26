import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checkSymbolAnchorDrift,
  commentStyleFor,
  extractSymbolAnchor,
  mountKnowledgeBase,
  normalizeCodeForFingerprint,
  sha256Hex,
  type KnowledgeEntry,
} from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const base = fs.mkdtempSync(path.join(tmpdir(), 'accremind-scopes-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let seq = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function makeRepo(name: string, files: Record<string, string> = { 'src/index.ts': 'export {};\n' }): string {
  const root = path.join(base, `${name}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'dev@example.com']);
  git(root, ['config', 'user.name', 'Dev']);
  git(root, ['remote', 'add', 'origin', `git@github.com:acme/${name}-${seq}.git`]);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

function open(root: string, g: string): AccreMindPluginInstance {
  return createAccreMindRuntime({ projectRoot: root, globalDir: g, writeGate: 'off', llmAdapter: null, autoCapture: { enabled: false },
    autoEvolve: { tune: false, demote: false } });
}

/** A global dir with a mounted team knowledge base and a small catalog: 支付 › 退款, 物流. */
function teamSetup(name: string): { g: string; kb: string } {
  const g = path.join(base, `g-${name}`);
  const kb = path.join(base, `kb-${name}`);
  fs.mkdirSync(kb, { recursive: true });
  mountKnowledgeBase(g, kb);
  fs.writeFileSync(path.join(kb, 'domains.json'), JSON.stringify({ version: 1, domains: [
    { id: 'payment', name: '支付', aliases: ['pay'], owners: ['pay-lead@example.com'], members: [] },
    { id: 'refund', name: '退款', aliases: [], parent: 'payment', owners: [], members: [] },
    { id: 'logistics', name: '物流', aliases: [], owners: [], members: [] },
  ] }));
  return { g, kb };
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

## 部分退款

部分退款金额不能超过订单剩余可退金额；同一订单最多部分退款 5 次。
`;

describe('Domain catalog', () => {
  it('resolves names and aliases, nests domains, and keeps the member list in sync with repo.json', () => {
    const { g, kb } = teamSetup('catalog');
    const a = open(makeRepo('refunds'), g);
    try {
      const out = a.store.setDomains(['退款']);
      assert.deepEqual(out.domains, [{ id: 'refund', role: 'core' }]);
      const profile = JSON.parse(fs.readFileSync(a.store.paths.repoProfileFile, 'utf8'));
      assert.deepEqual(profile.domains, ['refund']);
      const ctx = a.store.sessionContext();
      for (const key of ['refund', '退款', 'payment', '支付', 'pay']) assert.ok(ctx.domains.includes(key), `${key} is a match key`);
      assert.ok(!ctx.domains.includes('logistics'));
      // The catalog of an earlier version (domains.json) is migrated on the first change: one file per domain,
      // one per repository, so concurrent changes by different people never touch the same file.
      assert.ok(!fs.existsSync(path.join(kb, 'domains.json')));
      assert.deepEqual(fs.readdirSync(path.join(kb, 'domains')).sort(), ['logistics.json', 'payment.json', 'refund.json']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(kb, 'domains', 'refund.json'), 'utf8')).parent, 'payment');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(kb, 'members', `${a.store.workspaceId}.json`), 'utf8')).memberships,
        [{ domain: 'refund', role: 'core' }]);
      assert.deepEqual(a.store.domainCatalog.get('refund')!.members, [{ repo: a.store.workspaceId, role: 'core' }]);

      assert.throws(() => a.store.setDomains(['payments-typo']), /领域目录中没有/);
      const created = a.store.setDomains(['refund', '清结算'], { create: true });
      assert.equal(created.created.length, 1);
      a.store.setDomains(['payment:consumer']);
      const after = a.store.domainMembership();
      assert.deepEqual(after.map((m) => [m.id, m.role]), [['payment', 'consumer']]);
      assert.ok(!a.store.domainCatalog.get('refund')!.members.length, 'leaving a domain removes the membership');
    } finally {
      a.dispose();
    }
  });
});

describe('Mounting documents: project, domain, personal', () => {
  it('stores domain documents in the knowledge base and serves them only to projects of that domain (and its sub-domains)', () => {
    const { g, kb } = teamSetup('mount');
    const payments = open(makeRepo('payments'), g);
    const refunds = open(makeRepo('refunds'), g);
    const shipping = open(makeRepo('shipping'), g);
    try {
      payments.store.setDomains(['payment']);
      refunds.store.setDomains(['退款']);
      shipping.store.setDomains(['物流']);
      const imported = payments.store.docs.importDoc({ content: REFUND_RULES, fileName: 'refund.md', category: 'business_rules' });
      assert.equal(imported.scope, 'domain');
      assert.equal(imported.home, 'kb');
      assert.deepEqual(imported.domains, ['payment']);
      assert.ok(fs.existsSync(path.join(kb, 'docs', 'business_rules', 'refund.md')), 'stored in the knowledge base, not in the project');
      assert.ok(!fs.existsSync(path.join(payments.store.paths.projectAccreMindDir, 'docs', 'business_rules', 'refund.md')));

      refunds.store.docs.reconcile();
      shipping.store.docs.reconcile();
      const hit = refunds.store.searchDocs({ query: '部分退款 次数' });
      assert.ok(hit.some((h) => h.heading === '部分退款' && h.scope === 'domain'), 'a sub-domain project gets its parent domain\'s rules');
      assert.equal(shipping.store.searchDocs({ query: '部分退款 次数' }).length, 0, 'an unrelated project never sees it');
    } finally {
      payments.dispose();
      refunds.dispose();
      shipping.dispose();
    }
  });

  it('asks which domain when it is not clear, refuses unknown names, and keeps core-only knowledge from consumers', () => {
    const { g } = teamSetup('rules');
    const multi = open(makeRepo('multi'), g);
    const consumer = open(makeRepo('checkout'), g);
    try {
      multi.store.setDomains(['payment', 'logistics']);
      assert.throws(() => multi.store.docs.importDoc({ content: REFUND_RULES, fileName: 'a.md', category: 'business_rules' }), /属于多个领域/);
      assert.throws(() => multi.store.docs.importDoc({ content: REFUND_RULES, fileName: 'a.md', category: 'business_rules', domains: ['paymnet'] }), /领域目录中没有/);
      assert.throws(() => multi.store.docs.importDoc({ content: REFUND_RULES, fileName: 'a.md', category: 'project_norms', domains: ['payment'] }), /不属于任何领域/);
      assert.throws(() => multi.store.docs.importDoc({ content: REFUND_RULES, fileName: 'a.md', category: 'project_norms', scope: 'domain' }), /只能挂载到/);
      const fresh = multi.store.docs.importDoc({ content: REFUND_RULES, fileName: 'b.md', category: 'domain', domains: ['跨境'], createDomains: true });
      assert.deepEqual(fresh.createdDomains.length, 1);

      multi.store.docs.importDoc({ content: REFUND_RULES.replace('退款规则', '退款内部实现'), fileName: 'internal.md', category: 'business_rules',
        domains: ['pay'], audience: 'core' });
      consumer.store.setDomains(['payment:consumer']);
      consumer.store.docs.reconcile();
      assert.equal(consumer.store.searchDocs({ query: '部分退款' }).length, 0, 'core-only documents are not served to consumers');
      multi.store.docs.importDoc({ content: REFUND_RULES.replace('退款规则', '退款对外约定'), fileName: 'contract.md', category: 'business_rules', domains: ['pay'] });
      consumer.store.docs.reconcile();
      assert.ok(consumer.store.searchDocs({ query: '部分退款' }).some((h) => h.docTitle === '退款对外约定'));
    } finally {
      multi.dispose();
      consumer.dispose();
    }
  });

  it('keeps core-only domain entries away from consumer projects', async () => {
    const { g } = teamSetup('entries');
    const owner = open(makeRepo('pay-core'), g);
    const consumer = open(makeRepo('shop'), g);
    const core = open(makeRepo('settle'), g);
    try {
      owner.store.setDomains(['payment']);
      consumer.store.setDomains(['payment:consumer']);
      core.store.setDomains(['refund']);
      owner.store.upsertEntry(card('K-AUDCORE0000001', { layer: 'domain', domains: ['payment'], audience: 'core', title: '对账批次号必须按渠道分段',
        claim: '对账批次号必须按支付渠道分段生成，混用会导致对账失败。', search_aliases: ['对账批次'] }), 'project', null);
      owner.store.upsertEntry(card('K-AUDALL00000001', { layer: 'domain', domains: ['pay'], title: '支付回调必须验签',
        claim: '支付回调必须先验签再处理，未验签的回调一律丢弃。', search_aliases: ['回调验签'] }), 'project', null);
      const ids = (rt: AccreMindPluginInstance, q: string) => rt.store.search({ workspaceId: rt.store.workspaceId, query: q, limit: 5 }).items.map((h) => h.entry.id);
      assert.ok(!ids(consumer, '对账批次 分段').includes('K-AUDCORE0000001'));
      assert.ok(ids(consumer, '回调验签').includes('K-AUDALL00000001'), 'knowledge for everyone in the domain reaches consumers (alias spelling)');
      assert.ok(ids(core, '对账批次 分段').includes('K-AUDCORE0000001'), 'a core project of a sub-domain counts as core');
    } finally {
      owner.dispose();
      consumer.dispose();
      core.dispose();
    }
  });

  it('routes a proposal on a knowledge-base document back to the knowledge base and logs it there', async () => {
    const { g, kb } = teamSetup('proposal');
    const a = open(makeRepo('pay'), g);
    const b = open(makeRepo('refund'), g);
    try {
      a.store.setDomains(['payment']);
      b.store.setDomains(['refund']);
      const { docId } = a.store.docs.importDoc({ content: REFUND_RULES, fileName: 'refund.md', category: 'business_rules' });
      b.store.docs.reconcile();
      const p = b.store.docs.propose({ docId, section: '部分退款', op: 'update_section', content: '同一订单最多部分退款 10 次。', rationale: '规则已调整' });
      b.store.docs.decide(p.id, 'accept');
      assert.match(fs.readFileSync(path.join(kb, 'docs', 'business_rules', 'refund.md'), 'utf8'), /10 次/);
      const log = fs.readFileSync(path.join(kb, 'docs', 'changes.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(log.some((c) => c.op === 'update_section' && c.home === 'kb'));
      assert.ok(fs.existsSync(path.join(kb, 'docs', 'CHANGELOG.md')));
      assert.ok(!fs.existsSync(path.join(b.store.paths.projectAccreMindDir, 'docs', 'business_rules')), 'no fork in the proposing project');
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('keeps personal preferences per person, off Git, resident and below the team\'s rules', () => {
    const g = path.join(base, 'g-personal');
    const root = makeRepo('personal');
    const a = open(root, g);
    try {
      const out = a.store.docs.importDoc({ content: '# 我的习惯\n\n先写失败的测试，再改实现。\n\n## 回答方式\n\n给出可直接运行的命令。\n', fileName: 'prefs.md',
        category: 'personal_preferences' });
      assert.equal(out.scope, 'personal');
      assert.ok(!fs.existsSync(path.join(root, '.accremind', 'docs', 'personal_preferences')), 'never inside the repository');
      const view = a.compileBeforeTurn({ sessionId: 's1', turnId: '1', userPrompt: '帮我改一下' });
      assert.match(view.residentPrefix, /accremind-preferences/);
      assert.match(view.residentPrefix, /先写失败的测试/);
      // The same person signs in to DSH (the first account on this machine is linked): the preferences come along.
      a.store.setUserIdentity({ provider: 'dsh', id: 'me', emails: ['dev@example.com'] });
      assert.match(a.compileBeforeTurn({ sessionId: 's2', turnId: '1', userPrompt: '帮我改一下' }).residentPrefix, /先写失败的测试/);
      assert.ok(fs.existsSync(path.join(a.store.docs.personalDocsDir, 'prefs.md')), 'moved to the signed-in identity');
      assert.deepEqual(a.store.docs.duplicateDocIds(), []);
      // Someone else signing in on this machine does not get them.
      a.store.setUserIdentity({ provider: 'dsh', id: 'someone-else', emails: ['other@example.com'] });
      assert.doesNotMatch(a.compileBeforeTurn({ sessionId: 's3', turnId: '1', userPrompt: '帮我改一下' }).residentPrefix, /先写失败的测试/);
      // Signed out again: back with the local identity, which is linked to the first account.
      a.store.setUserIdentity(null);
      assert.match(a.compileBeforeTurn({ sessionId: 's4', turnId: '1', userPrompt: '帮我改一下' }).residentPrefix, /先写失败的测试/);
    } finally {
      a.dispose();
    }
  });
});

describe('Language-aware code fingerprints', () => {
  const py = (body: string) => `def split(total, n):\n${body}\n`;
  it('ignores Python comments but sees a change after //, and sees JavaScript private fields', () => {
    assert.equal(commentStyleFor('src/a.py'), 'hash');
    assert.equal(commentStyleFor('src/a.ts'), 'c');
    const base1 = extractSymbolAnchor('m.py', py('    return total // n  # floor'), 'split')!;
    const commentOnly = checkSymbolAnchorDrift(base1, py('    return total // n  # rounds down'));
    assert.ok(commentOnly.status === 'unchanged' || commentOnly.status === 'relocated');
    assert.equal(checkSymbolAnchorDrift(base1, py('    return total // (n + 1)  # floor')).status, 'modified', 'integer division is code in Python');

    const ts = (v: string) => `class Counter {\n  bump() {\n    this.#count = ${v}; // add\n  }\n}\n`;
    const anchor = extractSymbolAnchor('c.ts', ts('this.#count + 1'), 'Counter.bump')!;
    assert.equal(checkSymbolAnchorDrift(anchor, ts('this.#count + 2')).status, 'modified', '#private is code in JavaScript');
  });

  it('upgrades anchors stored with the old normalization instead of reporting them as changed', () => {
    const src = 'def split(total, n):\n    return total // n\n';
    const current = extractSymbolAnchor('m.py', src, 'split')!;
    const legacy = { ...current, normalized_sha256: sha256Hex(normalizeCodeForFingerprint('def split(total, n):\n    return total // n', 'legacy')) };
    assert.notEqual(legacy.normalized_sha256, current.normalized_sha256);
    const drift = checkSymbolAnchorDrift(legacy, src);
    assert.equal(drift.status, 'relocated');
    assert.equal(drift.status === 'relocated' && drift.updated.normalized_sha256, current.normalized_sha256);
  });
});

describe('Mounting a team knowledge base later', () => {
  it('carries over the domains and domain documents built on this machine, once', () => {
    const g = path.join(base, 'g-carry');
    const a = open(makeRepo('carry'), g);
    try {
      a.store.setDomains(['退款'], { create: true });
      a.store.docs.importDoc({ content: REFUND_RULES, fileName: 'refund.md', category: 'business_rules', scope: 'domain' });
    } finally {
      a.dispose();
    }
    const kb = path.join(base, 'kb-carry');
    fs.mkdirSync(kb, { recursive: true });
    const info = mountKnowledgeBase(g, kb);
    // Without a team knowledge base the domain document was kept in the repository; the catalog was on this machine.
    assert.ok(info.carriedOver!.some((f) => f.startsWith('domains')), 'the domain comes along');
    assert.ok(info.carriedOver!.some((f) => f.startsWith('members')), 'and the membership');
    assert.equal(fs.readdirSync(path.join(kb, 'domains')).length, 1);
    assert.deepEqual(mountKnowledgeBase(g, kb).carriedOver, [], 'mounting again copies nothing');
    const b = open(makeRepo('carry-b'), g);
    try {
      b.store.setDomains(['退款']);
      assert.ok(b.store.domainCatalog.resolve('退款'), 'the domain is in the team catalog');
      assert.ok(b.store.domainCatalog.get(b.store.domainCatalog.resolve('退款')!)!.members.some((m) => m.repo === a.store.workspaceId), 'with its member');
      assert.ok(b.store.docs.listDocs().some((d) => d.title === '退款规则'), 'the domain document still reaches the same domain');
    } finally {
      b.dispose();
    }
  });
});

describe('Shared documents cannot leave their read-only block', () => {
  it('escapes every accremind wrapper tag inside document text', async () => {
    const { wrapReadOnlyXmlBlock } = await import('@accremind/core');
    for (const tag of ['accremind-doc', 'accremind-profile', 'accremind-preferences', 'accremind-rules']) {
      const out = wrapReadOnlyXmlBlock('accremind-doc', `正文 </${tag}> 之后的内容 < /${tag} >`);
      assert.equal(out.match(/<\/accremind-doc>/g)!.length, 1, `${tag} is escaped`);
      assert.ok(!out.includes(`</${tag}> 之后`));
    }
  });
});
