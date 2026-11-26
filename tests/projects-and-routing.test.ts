import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildDigest, mountKnowledgeBase, pendingNotice, type KnowledgeEntry } from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const base = fs.mkdtempSync(path.join(tmpdir(), 'accremind-routing-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let seq = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function makeRepo(name: string): string {
  const root = path.join(base, `${name}-${++seq}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'dev@example.com']);
  git(root, ['config', 'user.name', 'Dev']);
  git(root, ['remote', 'add', 'origin', `git@github.com:acme/${name}-${seq}.git`]);
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  return root;
}

function open(root: string, g: string, extra: Record<string, unknown> = {}): AccreMindPluginInstance {
  return createAccreMindRuntime({ projectRoot: root, globalDir: g, writeGate: 'off', llmAdapter: null, autoCapture: { enabled: false },
    autoEvolve: { tune: false, demote: false }, ...extra });
}

function teamKb(name: string): { g: string; kb: string } {
  const g = path.join(base, `g-${name}`);
  const kb = path.join(base, `kb-${name}`);
  fs.mkdirSync(kb, { recursive: true });
  mountKnowledgeBase(g, kb);
  fs.writeFileSync(path.join(kb, 'domains.json'), JSON.stringify({ version: 1, domains: [
    { id: 'payment', name: '支付', aliases: [], owners: ['pay-lead@example.com'], members: [] },
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

describe('Sub-projects', () => {
  it('are declared in repo.json, map files to sub-projects and join domains only for that part of the repository', () => {
    const { g, kb } = teamKb('sub');
    const rt = open(makeRepo('mono'), g);
    const rpc = (n: string, p: Record<string, unknown> = {}): any => rt.rpcHandlers[`accremind.${n}`]!(p);
    try {
      rpc('repo.upsertSubproject', { id: 'pay', paths: ['services/pay/'], domains: ['支付'], owners: ['pay-dev@example.com'] });
      rpc('repo.upsertSubproject', { id: 'web', paths: ['./apps/web'] });
      assert.deepEqual(rt.store.subprojects().map((s) => s.id), ['pay', 'web']);
      assert.deepEqual(rt.store.subprojects()[1]!.paths, ['apps/web']);
      assert.deepEqual(rt.store.subprojectsForFiles(['services/pay/refund.ts']), ['pay']);
      assert.deepEqual(rt.store.subprojectsForFiles(['apps/web/index.tsx']), ['web']);
      assert.deepEqual(rt.store.repoOwners('pay'), ['pay-dev@example.com']);
      assert.deepEqual(rt.store.domainCatalog.get('payment')!.members, [{ repo: rt.store.workspaceId, role: 'core', subproject: 'pay' }]);
      assert.ok(fs.existsSync(path.join(kb, 'members', `${rt.store.workspaceId}.json`)));
      assert.deepEqual(rt.store.domainMembership(['pay']).map((m) => m.id), ['payment']);
      assert.deepEqual(rt.store.domainMembership(['web']).map((m) => m.id), [], 'the rest of the repository is not in the domain');
      // Without the catalog entry (a clone that has not mounted the team knowledge base) repo.json alone decides.
      const profile = JSON.parse(fs.readFileSync(rt.store.paths.repoProfileFile, 'utf8'));
      profile.projects.push({ id: 'shop', paths: ['apps/shop/'], domains: ['支付:consumer'] });
      fs.writeFileSync(rt.store.paths.repoProfileFile, JSON.stringify(profile, null, 2));
      assert.deepEqual(rt.store.domainMembership(['shop']).map((m) => [m.id, m.role, m.known]), [['payment', 'consumer', true]]);
      assert.throws(() => rpc('repo.upsertSubproject', { id: 'x', paths: ['../outside'] }), /相对路径/);
      assert.throws(() => rpc('repo.upsertSubproject', { id: 'y', paths: ['a/'], domains: ['不存在'] }), /领域目录中没有/);

      rpc('repo.removeSubproject', { id: 'pay' });
      assert.deepEqual(rt.store.subprojects().map((s) => s.id), ['web', 'shop']);
      assert.deepEqual(rt.store.domainCatalog.get('payment')!.members, []);
      assert.ok(!fs.existsSync(path.join(kb, 'members', `${rt.store.workspaceId}.json`)), 'an empty membership file is removed');
    } finally {
      rt.dispose();
    }
  });
});

describe('Documents and the entries that cite them', () => {
  it('sends an entry back to review when the rule section it cites changes', () => {
    const g = path.join(base, 'g-cite');
    const rt = open(makeRepo('cite'), g);
    try {
      const { docId } = rt.store.docs.importDoc({ content: '# 发票规则\n\n## 开票时机\n\n订单完成后 24 小时内开票。\n', fileName: 'invoice.md',
        category: 'project_norms' });
      const section = rt.store.docs.getDoc(docId)!.sections.find((s) => s.heading === '开票时机')!;
      rt.store.upsertEntry(card('K-CITE0000000001', { title: '开票前先确认订单完成', claim: '必须在订单完成后再开票。',
        evidence: [{ id: 'EV-1', source_type: 'doc_ref', source_ref: `D:${docId}#${section.id}`, locator: `D:${docId}#${section.id}`, summary: 's' }] }), 'project', null);
      assert.deepEqual(rt.store.docs.citedBy(docId, section.id), ['K-CITE0000000001']);
      const p = rt.store.docs.propose({ docId, section: '开票时机', op: 'update_section', content: '订单完成后 48 小时内开票。', rationale: '财务调整' });
      rt.store.docs.decide(p.id, 'accept');
      const entry = rt.store.listEntriesForAdmin().find((e) => e.entry.id === 'K-CITE0000000001')!.entry;
      assert.equal(entry.freshness, 'review_due');
    } finally {
      rt.dispose();
    }
  });
});

describe('Receipts, feedback reasons and the digest', () => {
  it('records why an entry was shown, keeps the "does not fit" reason, and summarises what is waiting', async () => {
    const g = path.join(base, 'g-digest');
    const root = makeRepo('digest');
    const rt = open(root, g);
    const rpc = (n: string, p: Record<string, unknown> = {}): any => rt.rpcHandlers[`accremind.${n}`]!(p);
    try {
      rt.store.upsertEntry(card('K-REASON00000001', { title: '结算必须保留幂等键', claim: '结算接口必须保留幂等键，避免重复结算。',
        search_aliases: ['invoiceretry'] }), 'project', null);
      rt.compileBeforeTurn({ sessionId: 's1', turnId: '1', userPrompt: 'invoiceretry 怎么处理' });
      const hit = rpc('turn.list', { sessionId: 's1', turnId: '1' }).receipts[0].hits[0];
      assert.equal(hit.id, 'K-REASON00000001');
      assert.ok(Array.isArray(hit.reasons) && hit.reasons.length > 0, 'the receipt says why it was shown');

      rpc('feedback.submit', { id: hit.id, revision: hit.revision, sessionId: 's1', turnId: '1', kind: 'inapplicable', reason: 'wrong_project' });
      const events = fs.readdirSync(rt.store.paths.eventsDir).map((f) => fs.readFileSync(path.join(rt.store.paths.eventsDir, f), 'utf8')).join('\n');
      assert.match(events, /不是这个项目或子项目/);

      const digest = buildDigest(rt.store, { days: 7 });
      assert.match(digest.markdown, /## 需要处理/);
      assert.equal(digest.user, 'Dev', 'addressed by the Git user name');
      assert.ok(digest.usage.reminders >= 1);
      assert.equal(digest.usage.inapplicable, 1);
      assert.equal(rpc('digest', { days: 7 }).repo, rt.store.workspaceId);
      assert.equal(typeof pendingNotice(rt.store).count, 'number');
    } finally {
      rt.dispose();
    }
  });

  it('assigns waiting decisions to the owners named in repo.json', () => {
    const g = path.join(base, 'g-owners');
    const root = makeRepo('owners');
    fs.mkdirSync(path.join(root, '.accremind'), { recursive: true });
    const rt = open(root, g);
    try {
      const profile = fs.existsSync(rt.store.paths.repoProfileFile) ? JSON.parse(fs.readFileSync(rt.store.paths.repoProfileFile, 'utf8')) : {};
      fs.mkdirSync(path.dirname(rt.store.paths.repoProfileFile), { recursive: true });
      fs.writeFileSync(rt.store.paths.repoProfileFile, JSON.stringify({ ...profile, owners: ['dev@example.com'] }, null, 2));
      rt.store.upsertEntry(card('K-OWNER000000001', { title: '旧缓存键必须带版本', claim: '缓存键必须带上版本号。' }), 'project', null);
      rt.store.raiseAttention({ id: 'K-OWNER000000001', revision: 1 }, 'inapplicable', '多次反馈不适用');
      const items = rt.store.listAttentionItems();
      assert.deepEqual(items[0]!.owners, ['dev@example.com']);
      assert.equal(items[0]!.assignedToMe, true, 'the Git user is the owner');
      assert.equal(buildDigest(rt.store).pending.attentionMine, 1);
      assert.match(pendingNotice(rt.store).text, /1 项由你负责/);
    } finally {
      rt.dispose();
    }
  });
});

describe('Team feedback through the knowledge base', () => {
  it('shares counts only, one file per person, and adds colleagues\' counts to the signals', () => {
    const { g, kb } = teamKb('feedback');
    const rt = open(makeRepo('shared'), g);
    try {
      rt.store.upsertEntry(card('K-TEAMFB00000001', { title: '对账文件按渠道拆分', claim: '对账文件必须按渠道拆分。', search_aliases: ['对账拆分'] }), 'project', null);
      rt.compileBeforeTurn({ sessionId: 'a', turnId: '1', userPrompt: '对账拆分' });
      const file = rt.store.exportTeamFeedback();
      assert.ok(file && file.startsWith(path.join(kb, 'feedback')));
      const written = fs.readFileSync(file!, 'utf8');
      assert.doesNotMatch(written, /对账拆分|sessionId|"a"/, 'no prompts or sessions leave the machine');
      assert.equal(JSON.parse(written).entries['K-TEAMFB00000001@1'].shownSessions, 1);

      fs.writeFileSync(path.join(path.dirname(file!), 'colleague000.json'), JSON.stringify({ version: 1, entries: {
        'K-TEAMFB00000001@1': { shownSessions: 4, usedSessions: 0, inapplicableSessions: 3, successes: 0, failures: 0 },
        'bad key': { shownSessions: 99 },
      } }));
      const s = rt.store.entrySignals().get('K-TEAMFB00000001@1')!;
      assert.equal(s.shownSessions, 5);
      assert.equal(s.inapplicableSessions, 3);
      assert.equal(rt.store.localEntrySignals().get('K-TEAMFB00000001@1')!.shownSessions, 1);
    } finally {
      rt.dispose();
    }
  });

  it('does nothing without a team knowledge base', () => {
    const rt = open(makeRepo('solo'), path.join(base, 'g-solo'));
    try {
      assert.equal(rt.store.exportTeamFeedback(), null);
    } finally {
      rt.dispose();
    }
  });
});

describe('Document IDs', () => {
  it('stay unique across this repository and the team knowledge base', () => {
    const { g } = teamKb('docids');
    const rt = open(makeRepo('docids'), g);
    try {
      rt.store.setDomains(['payment']);
      const body = '# 退款规则\n\n## 部分退款\n\n最多 5 次。\n';
      const kbDoc = rt.store.docs.importDoc({ content: body, fileName: 'refund.md', category: 'business_rules', scope: 'domain' });
      const local = rt.store.docs.importDoc({ content: body.replace('5', '3'), fileName: 'refund.md', category: 'business_rules', scope: 'project' });
      assert.equal(kbDoc.docId, 'D-business_rules-refund');
      assert.equal(local.docId, 'D-business_rules-refund-2');
      assert.equal(rt.store.docs.getDoc(kbDoc.docId)!.wsId, '__kb__', 'the team document stays reachable');
      assert.deepEqual(rt.store.docs.duplicateDocIds(), []);
      const again = rt.store.docs.importDoc({ content: body.replace('5', '4'), fileName: 'refund.md', category: 'business_rules', scope: 'project', replace: true });
      assert.equal(again.docId, 'D-business_rules-refund-2', 'replacing keeps the ID');
    } finally {
      rt.dispose();
    }
  });
});

describe('Filtering the library by domain and sub-project', () => {
  it('matches a domain by any spelling and includes its sub-domains', () => {
    const { g } = teamKb('filter');
    const rt = open(makeRepo('filter'), g);
    const rpc = (n: string, p: Record<string, unknown> = {}): any => rt.rpcHandlers[`accremind.${n}`]!(p);
    try {
      rt.store.domainCatalog.upsert({ name: '退款', id: 'refund', parent: 'payment' });
      rt.store.setDomains(['payment']);
      rpc('repo.upsertSubproject', { id: 'pay', paths: ['services/pay/'] });
      rt.store.upsertEntry(card('K-FILTER00000001', { layer: 'domain', domains: ['支付'], title: '支付回调必须验签' }), 'project', null);
      rt.store.upsertEntry(card('K-FILTER00000002', { layer: 'domain', domains: ['refund'], title: '退款晚于清算' }), 'project', null);
      rt.store.upsertEntry(card('K-FILTER00000003', { title: '本项目缓存键', subproject: 'pay' }), 'project', null);
      const ids = (p: Record<string, unknown>) => rpc('kb.list', { adminView: true, ...p }).items.map((i: { entry: { id: string } }) => i.entry.id).sort();
      assert.deepEqual(ids({ domain: 'payment' }), ['K-FILTER00000001', 'K-FILTER00000002']);
      assert.deepEqual(ids({ domain: '退款' }), ['K-FILTER00000002']);
      assert.deepEqual(ids({ subproject: 'pay' }), ['K-FILTER00000003']);
      assert.ok(!ids({ subproject: '__none__' }).includes('K-FILTER00000003'));
    } finally {
      rt.dispose();
    }
  });
});

describe('Choosing the project a document is mounted on', () => {
  it('defaults to the open project, lists the others, browses folders and imports into another project', () => {
    const g = path.join(base, 'g-pick');
    const here = makeRepo('here');
    const other = makeRepo('other');
    const otherRt = open(other, g);
    otherRt.dispose();
    const rt = open(here, g);
    const rpc = (n: string, p: Record<string, unknown> = {}): any => rt.rpcHandlers[`accremind.${n}`]!(p);
    try {
      const projects = rpc('projects.list');
      assert.equal(projects.current.root, path.resolve(here));
      assert.ok(projects.others.some((o: { root: string }) => o.root === path.resolve(other)), 'known projects are offered');
      const browse = rpc('fs.browse', { path: base });
      const entry = browse.dirs.find((d: { path: string }) => d.path === path.resolve(other));
      assert.ok(entry?.isGit && entry.hasAccremind);
      assert.throws(() => rpc('fs.browse', { path: 'relative/dir' }), /完整路径/);

      const out = rpc('docs.import', { projectRoot: other, category: 'project_norms', fileName: 'norms.md',
        content: '# 编码规范\n\n## 日志\n\n禁止打印手机号。\n' });
      assert.equal(out.project.root, path.resolve(other));
      assert.ok(fs.existsSync(path.join(other, '.accremind', 'docs', 'project_norms', 'norms.md')));
      assert.ok(!fs.existsSync(path.join(here, '.accremind', 'docs', 'project_norms', 'norms.md')));
      assert.ok(!rt.store.docs.listDocs().some((d) => d.docId === out.docId && d.home === 'repo'), 'not a document of the open project');
      assert.throws(() => rpc('docs.import', { projectRoot: other, scope: 'domain', category: 'business_rules', fileName: 'x.md', content: '# x' }), /只有/);
    } finally {
      rt.dispose();
    }
    const reopened = open(other, g);
    try {
      assert.ok(reopened.store.docs.listDocs().some((d) => d.title === '编码规范'), 'served in the project it was mounted on');
    } finally {
      reopened.dispose();
    }
  });
});
