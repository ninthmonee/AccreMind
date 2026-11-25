import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  applyMigration,
  CrossRepoFeedback,
  computeWorkspaceId,
  legacyOwnerId,
  LocalMarkdownSqliteStore,
  parseEntryMarkdown,
  planMigration,
  rollbackMigration,
  serializeEntryMarkdown,
  type KnowledgeEntry,
  type StorageZone,
} from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const base = fs.mkdtempSync(path.join(tmpdir(), 'accremind-xrepo-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let seq = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** A real Git repository with an origin remote (its identity), a Git user (the actor) and a dependency manifest. */
function makeRepo(name: string, opts: { remote?: string | null; email?: string; deps?: Record<string, string>; files?: Record<string, string> } = {}): string {
  const root = path.join(base, `${name}-${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', opts.email ?? 'dev@example.com']);
  git(root, ['config', 'user.name', 'Dev']);
  if (opts.remote !== null) git(root, ['remote', 'add', 'origin', opts.remote ?? `git@github.com:acme/${name}-${seq}.git`]);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, dependencies: opts.deps ?? {} }));
  for (const [rel, body] of Object.entries(opts.files ?? { 'src/index.ts': 'export {};\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  git(root, ['add', '-A']);
  return root;
}

function open(root: string, globalDir: string, writeGate: 'off' | 'probation' = 'off'): AccreMindPluginInstance {
  return createAccreMindRuntime({ projectRoot: root, globalDir, writeGate, llmAdapter: null, autoCapture: { enabled: false } });
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

function put(rt: AccreMindPluginInstance, entry: KnowledgeEntry, zone: StorageZone): KnowledgeEntry {
  return rt.store.upsertEntry(entry, zone, null);
}

function hits(rt: AccreMindPluginInstance, query: string, extra: Record<string, unknown> = {}) {
  return rt.store.search({ workspaceId: rt.store.workspaceId, query, ...extra }).items;
}

function radarIds(rt: AccreMindPluginInstance, prompt: string, session = `s-${++seq}`): string[] {
  return rt.viewCompiler.compileTurnView({ sessionId: session, userPrompt: prompt, preview: true }).surfacedIds;
}

describe('Cross-repository knowledge: identity and sharing', () => {
  it('derives a stable repository ID from the Git remote, so two clones share one identity', () => {
    const g = path.join(base, 'g-identity');
    const a = makeRepo('pay', { remote: 'git@github.com:acme/pay.git' });
    const b = makeRepo('pay-clone', { remote: 'https://dev@github.com/acme/pay' });
    const ra = open(a, g);
    const rb = open(b, g);
    try {
      assert.equal(ra.store.workspaceId, rb.store.workspaceId);
      assert.equal(ra.store.identity.source, 'remote');
      assert.match(ra.store.workspaceId, /^pay-[0-9a-f]{10}$/);
      assert.equal(ra.store.identity.org, 'github.com/acme');
    } finally {
      ra.dispose();
      rb.dispose();
    }
  });

  it('V1: one shared-tech entry written once is found from two repositories with the same stack', async () => {
    const g = path.join(base, 'g-v1');
    const a = open(makeRepo('svc-a', { deps: { pg: '^8.11.0' } }), g);
    const b = open(makeRepo('svc-b', { deps: { pg: '8.12.0', express: '^4' } }), g);
    try {
      const capture = a.tools.find((t) => t.name === 'accremind_capture')!;
      const out = JSON.parse((await capture.execute({
        question: 'pg 连接池在 fork 之后为什么会报连接被关闭？',
        discoverability: 'missing_context', disposition: 'knowledge_candidate',
        baseline_answer: '代码里只看到创建连接池。', knowledge_delta: 'fork 出的子进程继承父进程的 socket，父进程回收后子进程连接被关闭。',
        title: 'fork 子进程后必须重建 pg 连接池', claim: 'fork 之后在子进程里重新创建 pg 连接池，不要复用父进程的池。',
        layer: 'shared_tech', applies_dependencies: [{ name: 'pg', range: '^8' }], search_aliases: ['连接被关闭', 'connection terminated'],
        preconditions: ['使用 cluster 或 child_process.fork'], invalidation_triggers: ['pg 驱动改为惰性连接'],
        rationale: '多次线上排障确认', verification_method: 'fork 两个 worker 并发查询', file_locator: 'src/db.ts#L1',
        evidence_summary: '排障记录',
      }, { sessionId: 'cap-1' })).content[0]!.text);
      const id = out.persistedEntry.id as string;
      assert.equal(out.persistedZone, 'shared_tech');
      assert.ok(fs.existsSync(path.join(a.store.paths.sharedTechDir, `${id}.md`)), 'written once, machine-wide');
      assert.ok(!fs.existsSync(path.join(a.store.paths.projectEntriesDir, `${id}.md`)));
      const fromB = hits(b, 'fork 之后连接被关闭');
      const hitB = fromB.find((h) => h.entry.id === id);
      assert.ok(hitB, 'B finds it without a restart');
      assert.equal(hitB.scopeVerdict, 'stack_match');
      assert.equal(hitB.originRepo, a.store.workspaceId);
      assert.ok(hits(a, 'fork 之后连接被关闭').some((h) => h.entry.id === id));
      assert.ok(radarIds(b, 'worker fork 之后 pg 报 connection terminated 怎么办').includes(id));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V2: domain knowledge reaches repositories of the same business domain and stays out of others', async () => {
    const g = path.join(base, 'g-v2');
    const a = open(makeRepo('pay-api'), g);
    const b = open(makeRepo('pay-admin'), g);
    const c = open(makeRepo('wms'), g);
    try {
      await a.rpcHandlers['accremind.repo.setDomains']!({ domains: ['payment'] });
      await b.rpcHandlers['accremind.repo.setDomains']!({ domains: ['payment'] });
      await c.rpcHandlers['accremind.repo.setDomains']!({ domains: ['logistics'] });
      assert.deepEqual(JSON.parse(fs.readFileSync(a.store.paths.repoProfileFile, 'utf8')).domains, ['payment']);
      const d = put(a, card('K-DOMAIN0000001A', {
        layer: 'domain', domains: ['payment'], title: '退款必须晚于清算日结', claim: '清算日结完成之前不能发起退款，否则对账出现负余额。',
        search_aliases: ['退款时机', '清算'],
      }), 'project');
      assert.ok(fs.existsSync(path.join(a.store.paths.projectEntriesDir, `${d.id}.md`)), 'domain knowledge stays in its home repository (Git-shared)');
      const fromB = hits(b, '什么时候可以发起退款 清算').find((h) => h.entry.id === d.id);
      assert.equal(fromB?.scopeVerdict, 'domain_match');
      const fromC = hits(c, '什么时候可以发起退款 清算').find((h) => h.entry.id === d.id);
      assert.ok(!fromC || fromC.scopeVerdict === 'cross_ref', 'another domain never gets it as applicable knowledge');
      assert.ok(!radarIds(c, '仓库出库单怎么做').includes(d.id));
    } finally {
      a.dispose();
      b.dispose();
      c.dispose();
    }
  });

  it('V3: project knowledge and its paths never leak into another repository (no mismatched reminders)', () => {
    const g = path.join(base, 'g-v3');
    const a = open(makeRepo('shop-a', { files: { 'src/order/service.ts': 'export {}' } }), g);
    const b = open(makeRepo('shop-b', { files: { 'src/order/x.ts': 'export {}' } }), g);
    try {
      const k = put(a, card('K-PROJECT000001A', {
        title: '订单服务创建前必须加分布式锁', claim: '创建订单前在 Redis 上加锁，避免重复下单。', priority: 'P0',
        watch_paths: ['src/order/**'], search_aliases: ['重复下单'],
      }), 'project');
      assert.ok(a.viewCompiler.compileFileToolGuard({ sessionId: 'ga', filePath: 'src/order/service.ts', sessionSurfacedIds: new Set(), preview: true })
        .newlySurfacedIds.includes(k.id));
      assert.deepEqual(b.viewCompiler.compileFileToolGuard({ sessionId: 'gb', filePath: 'src/order/x.ts', sessionSurfacedIds: new Set(), preview: true })
        .newlySurfacedIds, [], 'same relative path in another repository does not trigger the guard');
      assert.ok(!radarIds(b, '怎么避免重复下单').includes(k.id));
      assert.ok(!hits(b, '重复下单').some((h) => h.entry.id === k.id));
      const all = hits(b, '重复下单 订单 加锁', { scope: 'all' }).find((h) => h.entry.id === k.id);
      assert.equal(all?.scopeVerdict, 'cross_ref', 'explicit scope=all finds it, labelled as a reference');
      assert.throws(() => b.store.updateExistingEntryDirect({ ...k, title: '改别人的卡片' }), /只能在该仓库中修改/);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V4: unrelated tasks get no reminders even with a populated machine-wide library', () => {
    const g = path.join(base, 'g-v4');
    const a = open(makeRepo('lib-a', { deps: { pg: '^8', redis: '^4' } }), g);
    const b = open(makeRepo('ui-b', { deps: { react: '^18' } }), g);
    try {
      const topics = [
        ['连接池', 'pg 连接池 fork 后必须重建'], ['事务', 'pg 事务里不要调用外部 HTTP'], ['锁', 'redis 分布式锁必须设置过期时间'],
        ['缓存', 'redis 缓存穿透要缓存空值'], ['重试', '幂等键必须在重试前生成'], ['时区', '数据库时间统一存 UTC'],
      ];
      topics.forEach(([alias, title], i) => put(a, card(`K-SHARED000000${i}A`, {
        layer: 'shared_tech', title: title!, claim: `${title}，否则线上会出错。`, search_aliases: [alias!],
        applies_to: { dependencies: [{ name: i < 2 ? 'pg' : 'redis', range: '*' }] }, origin_repo: a.store.workspaceId,
      }), 'shared_tech'));
      const unrelated = [
        '把按钮的颜色改成蓝色', '给首页加一个轮播图', '重构 Header 组件的样式', '修改登录页的文案', '把表格改成分页展示',
        '升级 react 路由写法', '调整移动端的边距', '添加暗色主题切换', '优化图片懒加载', '修复下拉框的对齐问题',
        '国际化英文翻译补全', '把弹窗改成抽屉', '增加一个空状态插画', '表单校验提示语改短', '把图标换成线性风格',
        '页面标题加上品牌名', '列表支持拖拽排序', '统一按钮圆角', '侧边栏折叠动画', '日期选择器默认今天',
      ];
      const noisy = unrelated.filter((p) => radarIds(b, p).length > 0);
      assert.ok(noisy.length / unrelated.length <= 0.05, `noisy prompts: ${noisy.join(' | ')}`);
      // And a related task in a repository without the dependency does not get pg/redis entries either.
      assert.deepEqual(hits(b, 'redis 分布式锁必须设置过期时间').map((h) => h.entry.id), []);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V5: overlapping shared-tech and domain entries are never served together; the more specific one wins', () => {
    const g = path.join(base, 'g-v5');
    const pay = open(makeRepo('pay-core', { deps: { decimal: '^10' } }), g);
    const other = open(makeRepo('report', { deps: { decimal: '^10' } }), g);
    try {
      pay.store.updateRepoProfile({ domains: ['payment'] });
      const s = put(pay, card('K-SHAREDDUP0001A', {
        layer: 'shared_tech', title: '金额计算必须使用十进制库', claim: '金额计算必须使用 decimal 十进制库，禁止使用浮点数相加。',
        search_aliases: ['金额精度'], applies_to: { dependencies: [{ name: 'decimal', range: '*' }] }, origin_repo: pay.store.workspaceId,
      }), 'shared_tech');
      const d = put(pay, card('K-DOMAINDUP0001A', {
        layer: 'domain', domains: ['payment'], title: '支付金额计算必须使用十进制库', specializes: s.id,
        claim: '金额计算必须使用 decimal 十进制库，禁止使用浮点数相加。', search_aliases: ['金额精度'],
      }), 'project');
      const inPay = hits(pay, '金额精度 浮点数相加').map((h) => h.entry.id);
      assert.ok(inPay.includes(d.id) && !inPay.includes(s.id), `pay repo: ${inPay.join(',')}`);
      const inOther = hits(other, '金额精度 浮点数相加').map((h) => h.entry.id);
      assert.ok(inOther.includes(s.id) && !inOther.includes(d.id), `other repo: ${inOther.join(',')}`);
    } finally {
      pay.dispose();
      other.dispose();
    }
  });
});

describe('Cross-repository knowledge: priorities, privacy and feedback', () => {
  it('V6: a suspected contradiction of a team rule is flagged (rule wins) unless an unexpired exception is documented', () => {
    const g = path.join(base, 'g-v6');
    const a = open(makeRepo('orders'), g);
    try {
      const rule = put(a, card('R-RULE000000001A', {
        layer: 'team_rule', polarity: 'avoid', title: '禁止在事务内调用外部支付接口', priority: 'P0',
        claim: '禁止在数据库事务内调用外部支付接口，必须先提交事务再调用。',
      }), 'rules');
      const prj = card('K-CONFLICT00001A', {
        layer: 'project', polarity: 'recommend', title: '对账任务在事务内调用外部支付接口', search_aliases: ['对账任务'],
        claim: '对账任务可以在数据库事务内调用外部支付接口，必须先提交事务再调用的要求不适用。',
      });
      put(a, prj, 'project');
      const view = () => a.viewCompiler.compileTurnView({ sessionId: `v6-${++seq}`, userPrompt: '对账任务 事务 外部支付接口' });
      const flagged = view();
      assert.ok(flagged.surfacedIds.includes(prj.id), 'a suspected conflict is shown, not withheld');
      assert.match(flagged.radarBlock, new RegExp(`${prj.id}[^\\n]*疑似与团队规范 ${rule.id} 相反`));
      assert.ok(a.store.listAttentionItems().some((i) => i.entry_id === prj.id && i.kind === 'rule_conflict'));
      const expires = new Date(Date.now() + 30 * 864e5).toISOString();
      a.store.updateExistingEntryDirect({ ...prj, overrides: [{ rule_id: rule.id, reason: '对账走只读副本', approver: 'lead@example.com', expires_at: expires }] });
      assert.ok(!a.store.listAttentionItems().some((i) => i.entry_id === prj.id && i.kind === 'rule_conflict'), 'a documented exception clears the conflict');
      const waived = view();
      assert.ok(waived.surfacedIds.includes(prj.id));
      assert.match(waived.residentPrefix, new RegExp(`本仓库豁免：见 ${prj.id}`));
      a.store.updateExistingEntryDirect({ ...prj, overrides: [{ rule_id: rule.id, reason: 'x', approver: 'lead', expires_at: '2020-01-01T00:00:00.000Z' }] });
      assert.match(view().radarBlock, /以规范为准/, 'an expired exception no longer applies');
    } finally {
      a.dispose();
    }
  });

  it('V7: personal knowledge belongs to the user (not one e-mail), never reaches another user, a repository or a skill', async () => {
    const g = path.join(base, 'g-v7');
    const mine = open(makeRepo('tools-a', { email: 'alice@example.com' }), g);
    // Same person on this machine, different Git e-mail in this repository.
    const mine2 = open(makeRepo('tools-c', { email: 'alice@home.example' }), g);
    // Another person: a signed-in identity supplied by the host.
    const theirs = open(makeRepo('tools-b', { email: 'bob@example.com' }), g);
    try {
      const capture = mine.tools.find((t) => t.name === 'accremind_capture')!;
      const out = JSON.parse((await capture.execute({
        question: '本机 zsh 补全很慢怎么办？', discoverability: 'missing_context', disposition: 'knowledge_candidate',
        baseline_answer: '无', knowledge_delta: '关掉 compinit 的安全检查可以提速。', title: '我的 zsh 补全提速办法',
        claim: '在 zshrc 里使用 compinit -C 跳过安全检查。', layer: 'personal', search_aliases: ['zsh 补全'],
        preconditions: ['本机 zsh'], invalidation_triggers: ['换 shell'], rationale: '亲测', verification_method: '计时',
        file_locator: 'README.md#L1', evidence_summary: '本机实验',
      }, { sessionId: 'p-1' })).content[0]!.text);
      const id = out.persistedEntry.id as string;
      assert.ok(fs.existsSync(path.join(mine.store.paths.personalDir, `${id}.md`)));
      const md = fs.readFileSync(path.join(mine.store.paths.personalDir, `${id}.md`), 'utf8');
      assert.doesNotMatch(md, /alice@example\.com/, 'no e-mail in the card');
      assert.equal(parseEntryMarkdown(md).owner, mine.store.currentUser().userId);
      assert.equal(mine2.store.currentUser().userId, mine.store.currentUser().userId, 'one local user across repositories');
      assert.equal(parseEntryMarkdown(md).visibility, 'private');
      assert.ok(hits(mine2, 'zsh 补全 很慢').some((h) => h.entry.id === id && h.scopeVerdict === 'owner_match'), 'follows its owner to other repositories');
      // Alice signs in first on this machine account (her local entries follow her); Bob signs in later.
      mine.store.setUserIdentity({ provider: 'dsh', id: 'alice', emails: ['alice@example.com'] });
      theirs.store.setUserIdentity({ provider: 'dsh', id: 'bob', emails: ['bob@example.com'] });
      assert.ok(!hits(theirs, 'zsh 补全 很慢').some((h) => h.entry.id === id), 'never served to someone else');
      mine.store.updateExistingEntryDirect({ ...out.persistedEntry, maturity: 'verified' });
      const exportTool = mine.tools.find((t) => t.name === 'accremind_export_skill')!;
      const exported = await exportTool.execute({ id, skill_slug: 'zsh-speed' });
      assert.ok(exported.isError);
      assert.match(exported.content[0]!.text, /个人经验/);
      assert.throws(() => mine.store.upsertEntry({ ...out.persistedEntry, id: 'K-LEAK0000000001' }, 'project', null), /个人经验/);
      // Signing in later links the local user: earlier personal entries still belong to the same person.
      const signedIn = mine2.store.setUserIdentity({ provider: 'dsh', id: 'alice', emails: ['alice@example.com'] });
      assert.equal(signedIn.userId, 'dsh:alice');
      assert.ok(hits(mine2, 'zsh 补全 很慢').some((h) => h.entry.id === id), 'linked account keeps access');
      // Entries written by older versions (owner = e-mail hash) are recognised too.
      assert.ok(mine.store.currentUser().aliases.includes(legacyOwnerId('alice@example.com')));
    } finally {
      mine.dispose();
      theirs.dispose();
      mine2.dispose();
    }
  });

  it('V8: "does not apply" stops a shared entry in that repository first; several repositories pause it everywhere', () => {
    const g = path.join(base, 'g-v8');
    const a = open(makeRepo('fb-a', { deps: { pg: '^8' } }), g);
    const b = open(makeRepo('fb-b', { deps: { pg: '^8' } }), g);
    try {
      const s = put(a, card('K-FEEDBACK0001AA', {
        layer: 'shared_tech', title: 'pg 批量写入必须分批提交', claim: 'pg 批量写入每批不超过一千行再提交。', search_aliases: ['批量写入'],
        applies_to: { dependencies: [{ name: 'pg', range: '*' }] }, origin_repo: a.store.workspaceId,
      }), 'shared_tech');
      const inB = () => hits(b, '批量写入 分批提交').some((h) => h.entry.id === s.id);
      const inA = () => hits(a, '批量写入 分批提交').some((h) => h.entry.id === s.id);
      assert.ok(inA() && inB());
      b.store.recordInapplicable(s.id, 'b-1', '我们用 COPY');
      assert.ok(inB(), 'one report only lowers it');
      const second = b.store.recordInapplicable(s.id, 'b-2', '我们用 COPY');
      assert.equal(second.suppressedHere, true);
      assert.equal(second.suspended, false);
      assert.ok(!inB(), 'suppressed in B');
      assert.ok(inA(), 'still served in A');
      a.store.recordInapplicable(s.id, 'a-1', '不适用');
      const last = a.store.recordInapplicable(s.id, 'a-2', '不适用');
      assert.equal(last.suspended, true, 'two repositories agree and nobody confirmed it: paused everywhere');
      assert.equal(a.store.getEntry(s.id, { recordUsage: false, includeHistoryOrSuspended: true }).found, true);
      assert.ok(!inA());
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V8b: a counterexample reported from another repository pauses the shared entry at its next maintenance', () => {
    const g = path.join(base, 'g-v8b');
    const a = open(makeRepo('cx-a', { deps: { pg: '^8' } }), g);
    const b = open(makeRepo('cx-b', { deps: { pg: '^8' } }), g);
    try {
      const d = put(a, card('K-COUNTEREX001AA', {
        layer: 'domain', domains: ['payment'], title: '支付回调必须验签后再处理', claim: '支付回调必须验签后再处理业务。',
        search_aliases: ['回调验签'],
      }), 'project');
      b.store.updateRepoProfile({ domains: ['payment'] });
      assert.ok(hits(b, '回调验签').some((h) => h.entry.id === d.id));
      const res = b.store.submitValidation({ entryId: d.id, sessionId: 'b-s', taskFingerprint: 't-1', outcome: 'failure', evidenceNote: '验签后仍被重放' });
      assert.equal(res.updatedEntry.serving, 'enabled', 'B never writes A\'s card');
      assert.ok(!hits(b, '回调验签').some((h) => h.entry.id === d.id), 'stopped in B at once');
      assert.deepEqual(a.store.applyCrossRepoFeedback(), [d.id]);
      assert.equal(a.store.getEntry(d.id, { recordUsage: false, includeHistoryOrSuspended: true }).found
        && (a.store.getEntry(d.id, { recordUsage: false, includeHistoryOrSuspended: true }) as { entry: KnowledgeEntry }).entry.serving, 'suspended');
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V9: trials never leave their repository; a promoted team-rule trial becomes a resident rule', () => {
    const g = path.join(base, 'g-v9');
    const a = open(makeRepo('trial-a', { deps: { pg: '^8' } }), g, 'probation');
    const b = open(makeRepo('trial-b', { deps: { pg: '^8' } }), g);
    try {
      const t = put(a, card('K-TRIAL00000001A', {
        layer: 'shared_tech', status: 'probation', maturity: 'draft', title: 'pg 游标必须显式关闭',
        claim: 'pg 游标用完必须显式关闭。', search_aliases: ['游标关闭'], applies_to: { dependencies: [{ name: 'pg', range: '*' }] },
      }), 'probation');
      assert.ok(hits(a, '游标关闭').some((h) => h.entry.id === t.id));
      assert.ok(!hits(b, '游标关闭').some((h) => h.entry.id === t.id), 'a trial is only served where it was produced');
      const promoted = a.store.promoteProbationToActive(t.id);
      assert.ok(fs.existsSync(path.join(a.store.paths.sharedTechDir, `${promoted.id}.md`)));
      assert.ok(hits(b, '游标关闭').some((h) => h.entry.id === t.id), 'once promoted it is shared');
      const r = put(a, card('R-TRIALRULE0001A', { layer: 'team_rule', status: 'probation', maturity: 'draft', title: '接口必须带幂等键', claim: '所有写接口必须带幂等键。' }), 'probation');
      a.store.promoteProbationToActive(r.id);
      assert.ok(fs.existsSync(path.join(a.store.paths.projectRulesDir, `${r.id}.md`)), 'team rules go to the rules folder');
      assert.ok(a.store.listResidentRules().some((x) => x.id === r.id));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('proposes team rules instead of writing them, and reclassifies across scopes by moving the card', async () => {
    const g = path.join(base, 'g-reclass');
    const a = open(makeRepo('reclass', { deps: { pg: '^8' } }), g);
    try {
      const capture = a.tools.find((t) => t.name === 'accremind_capture')!;
      const proposal = JSON.parse((await capture.execute({
        question: '写接口要不要强制幂等键？', discoverability: 'missing_context', disposition: 'knowledge_candidate',
        baseline_answer: '无', knowledge_delta: '历史上重复扣款都来自没有幂等键的写接口。', title: '所有写接口必须带幂等键',
        claim: '所有写接口必须带幂等键。', propose_team_rule: true, preconditions: ['写接口'], invalidation_triggers: ['x'],
        rationale: '事故复盘', verification_method: '接口契约检查', file_locator: 'README.md#L1', evidence_summary: '复盘',
      }, { sessionId: 'r-1' })).content[0]!.text);
      assert.equal(proposal.proposedTeamRule, true);
      assert.equal(proposal.persistedEntry, null);
      assert.equal(a.store.listResidentRules().length, 0);

      const k = put(a, card('K-RECLASS000001A', { title: 'pg 的 numeric 返回字符串', claim: 'pg 驱动把 numeric 当字符串返回，需要显式转换。' }), 'project');
      const moved = a.store.saveRevision({ id: k.id, patch: { layer: 'shared_tech' }, revisionImpact: 'editorial' });
      assert.ok(moved.ok);
      assert.ok(fs.existsSync(path.join(a.store.paths.sharedTechDir, `${k.id}.md`)));
      assert.ok(!fs.existsSync(path.join(a.store.paths.projectEntriesDir, `${k.id}.md`)));
      assert.equal(moved.ok && moved.entry.origin_repo, a.store.workspaceId);
    } finally {
      a.dispose();
    }
  });
});

describe('Cross-repository knowledge: migration', () => {
  it('V10: a repository that gains a stable ID keeps its history and recall; migrate tags and rolls back exactly', () => {
    const g = path.join(base, 'g-v10');
    const root = makeRepo('legacy', { remote: null });
    const before = open(root, g);
    const legacyId = computeWorkspaceId(root);
    assert.equal(before.store.workspaceId, legacyId);
    put(before, card('K-LEGACY0000001A', { layer: 'domain', title: '对账差异必须人工确认', claim: '对账差异超过阈值时必须人工确认。', search_aliases: ['对账差异'] }), 'project');
    put(before, card('K-LEGACY0000002A', { title: '导出任务必须限流', claim: '导出任务每分钟不超过十次。', search_aliases: ['导出限流'] }), 'project');
    before.store.recordUsage({ workspace_id: legacyId, session_id: 's', entry_id: 'K-LEGACY0000002A', revision: 1, event_type: 'cited' });
    const recallBefore = ['对账差异', '导出限流'].map((q) => hits(before, q).map((h) => h.entry.id).join(','));
    before.dispose();

    git(root, ['remote', 'add', 'origin', 'git@github.com:acme/legacy-svc.git']);
    const after = open(root, g);
    try {
      assert.notEqual(after.store.workspaceId, legacyId);
      const recallAfter = ['对账差异', '导出限流'].map((q) => hits(after, q).map((h) => h.entry.id).join(','));
      assert.deepEqual(recallAfter, recallBefore, 'recall unchanged after the ID changed');
      const usage = after.store.rawDb.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE workspace_id = ?').get(after.store.workspaceId) as { n: number };
      assert.ok(Number(usage.n) >= 1, 'history re-keyed to the new ID');
      assert.ok(fs.existsSync(path.join(g, 'workspaces', legacyId, 'index.sqlite')), 'the old copy is kept as the rollback');

      const file = path.join(after.store.paths.projectEntriesDir, 'K-LEGACY0000001A.md');
      const original = fs.readFileSync(file, 'utf8');
      const plan = planMigration(after.store, { domains: ['finance'] });
      assert.deepEqual(plan.tagDomains.map((t) => t.id), ['K-LEGACY0000001A']);
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'dry run writes nothing');
      applyMigration(after.store, { domains: ['finance'] });
      assert.deepEqual(parseEntryMarkdown(fs.readFileSync(file, 'utf8')).domains, ['finance']);
      assert.equal(JSON.parse(fs.readFileSync(after.store.paths.repoProfileFile, 'utf8')).repo_id, after.store.workspaceId);
      const untouched = fs.readFileSync(path.join(after.store.paths.projectEntriesDir, 'K-LEGACY0000002A.md'), 'utf8');
      assert.match(untouched, /format_version: 1\n/, 'cards without new metadata stay v1');
      const rb = rollbackMigration(after.store);
      assert.deepEqual(rb.restored, [file]);
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'byte-identical after rollback');
      assert.ok(!fs.existsSync(after.store.paths.repoProfileFile));
    } finally {
      after.dispose();
    }
  });

  it('downgrades v2 cards for an older plugin on request', () => {
    const g = path.join(base, 'g-down');
    const a = open(makeRepo('down'), g);
    try {
      const k = put(a, card('K-DOWNGRADE0001A', { layer: 'domain', domains: ['x'], origin_repo: a.store.workspaceId, title: '降级测试卡片', claim: '降级测试的结论内容' }), 'project');
      const file = path.join(a.store.paths.projectEntriesDir, `${k.id}.md`);
      assert.match(fs.readFileSync(file, 'utf8'), /format_version: 2/);
      const out = rollbackMigration(a.store, { downgradeCards: true });
      assert.deepEqual(out.downgraded, [file]);
      const md = fs.readFileSync(file, 'utf8');
      assert.match(md, /format_version: 1\n/);
      assert.equal(serializeEntryMarkdown(parseEntryMarkdown(md)), md);
    } finally {
      a.dispose();
    }
  });
});

describe('Cross-repository knowledge: robustness', () => {
  it('V12: concurrent edits of one machine-wide entry from two repositories never corrupt the card', () => {
    const g = path.join(base, 'g-v12');
    const a = open(makeRepo('cc-a'), g);
    const b = open(makeRepo('cc-b'), g);
    try {
      const s = put(a, card('K-CONCURRENT01AA', { layer: 'shared_tech', title: '并发修改测试卡片', claim: '并发修改测试的原始结论内容' }), 'shared_tech');
      hits(b, '并发修改测试卡片');
      const edited = a.store.saveRevision({ id: s.id, patch: { claim: 'A 仓库改过之后的结论内容' }, revisionImpact: 'editorial' });
      assert.ok(edited.ok && edited.entry.revision === 2);
      assert.throws(() => b.store.updateExistingEntryDirect({ ...s, claim: 'B 基于旧版本的修改' }), /刚被其他窗口或命令修改过/);
      // A card changed on disk behind both indexes is also refused (and picked up).
      fs.appendFileSync(path.join(a.store.paths.sharedTechDir, `${s.id}.md`), '\n');
      assert.throws(() => b.store.updateExistingEntryDirect({ ...(edited.ok ? edited.entry : s), claim: 'B 的修改' }), /刚被其他窗口或命令修改过/);
      const onDisk = parseEntryMarkdown(fs.readFileSync(path.join(a.store.paths.sharedTechDir, `${s.id}.md`), 'utf8'));
      assert.equal(onDisk.claim, 'A 仓库改过之后的结论内容');
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('V14: a broken card in one repository only affects that repository', () => {
    const g = path.join(base, 'g-v14');
    const a = open(makeRepo('iso-a'), g);
    const b = open(makeRepo('iso-b'), g);
    try {
      a.store.updateRepoProfile({ domains: ['payment'] });
      b.store.updateRepoProfile({ domains: ['payment'] });
      put(a, card('K-ISOGOOD00001AA', { layer: 'domain', domains: ['payment'], title: '好卡片 结算规则', claim: '结算规则必须在日终之后执行', search_aliases: ['结算规则'] }), 'project');
      fs.writeFileSync(path.join(a.store.paths.projectEntriesDir, 'K-ISOBAD000001AA.md'), '---\nid: x\n<<<<<<< HEAD\n');
      a.store.initializeAndReconcile();
      b.store.initializeAndReconcile();
      assert.equal(a.store.listCorruptedFiles().length, 1);
      assert.equal(b.store.listCorruptedFiles().length, 0, 'not reported in another repository');
      assert.ok(hits(b, '结算规则').some((h) => h.entry.id === 'K-ISOGOOD00001AA'), 'the good cards still serve');
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('Index writes and feedback housekeeping', () => {
  it('commits a large reconcile in short batches so other repositories are not locked out for the whole scan', () => {
    const g = path.join(base, 'g-batch');
    const root = makeRepo('batch');
    const rt = open(root, g);
    try {
      for (let i = 0; i < 650; i++) {
        const id = `K-BATCH${String(i).padStart(7, '0')}`;
        fs.writeFileSync(path.join(rt.store.paths.projectEntriesDir, `${id}.md`), serializeEntryMarkdown(card(id, { title: `批量对账卡片 ${i}`, claim: `批量对账第 ${i} 条结论内容` })));
      }
      rt.store.initializeAndReconcile();
      assert.ok(rt.store.lastReconcileBatches >= 4, `batches: ${rt.store.lastReconcileBatches}`);
      assert.ok(hits(rt, '批量对账卡片').length > 0);
    } finally {
      rt.dispose();
    }
  });

  it('compacts cross-repository feedback without changing what it means', () => {
    const fb = new CrossRepoFeedback(path.join(base, 'fb-compact', 'feedback'), path.join(base, 'fb-compact', 'locks'));
    for (let rev = 1; rev <= 3; rev++) {
      for (let i = 0; i < 150; i++) fb.append('K-COMPACT', { repo: `r${i % 3}`, revision: rev, kind: 'inapplicable', session: `s${i}` });
    }
    fb.append('K-COMPACT', { repo: 'r9', revision: 3, kind: 'success', session: 'ok' });
    const before = fb.standing('K-COMPACT', 3);
    const out = fb.compact('K-COMPACT', 3);
    assert.ok(out.after <= 4 && out.before > out.after, JSON.stringify(out));
    assert.deepEqual(fb.standing('K-COMPACT', 3), before, 'same standing after compaction');
    assert.deepEqual(fb.read('K-COMPACT', 1), [], 'older revisions dropped');
    fb.append('K-COMPACT', { repo: 'r0', revision: 3, kind: 'inapplicable', session: 'new-session' });
    assert.equal(fb.standing('K-COMPACT', 3).inapplicableSessionsByRepo.r0, before.inapplicableSessionsByRepo.r0! + 1, 'appends keep counting after compaction');
  });
});

describe('Freshness of shared entries', () => {
  it('flags a shared entry for a re-check in a repository whose dependency had a major upgrade, without touching the card', () => {
    const g = path.join(base, 'g-fresh');
    const root = makeRepo('fresh-b', { deps: { pg: '^8.11.0' } });
    const a = open(makeRepo('fresh-a', { deps: { pg: '^8' } }), g);
    const b = open(root, g);
    try {
      const s = put(a, card('K-FRESHSHARED01A', { layer: 'shared_tech', title: 'pg 游标需要显式关闭', claim: 'pg 游标使用后必须显式关闭。',
        search_aliases: ['游标关闭'], applies_to: { dependencies: [{ name: 'pg', range: '*' }] } }), 'shared_tech');
      b.stalenessScanner.scanWorkspace();
      assert.deepEqual(b.store.listSharedReviews(), [], 'first scan only records the dependency versions');
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fresh-b', dependencies: { pg: '^9.0.0' } }));
      const report = b.stalenessScanner.scanWorkspace();
      assert.ok(report.markedReviewDue.some((m) => m.entryId === s.id));
      const hit = hits(b, '游标关闭').find((h) => h.entry.id === s.id);
      assert.ok(hit?.matchReasons.some((r) => r.includes('pg')), 'shown with the reason to re-check');
      assert.equal(parseEntryMarkdown(fs.readFileSync(path.join(a.store.paths.sharedTechDir, `${s.id}.md`), 'utf8')).freshness, 'current', 'shared card untouched');
      b.store.submitValidation({ entryId: s.id, sessionId: 'b-v', taskFingerprint: 'tf', outcome: 'success', evidenceNote: '在 pg 9 上验证通过' });
      assert.deepEqual(b.store.listSharedReviews(), []);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe('Shared machine-wide index', () => {
  it('keeps one entry index for every repository and only per-repository state in each repository database', () => {
    const g = path.join(base, 'g-shared-index');
    const a = open(makeRepo('idx-a', { deps: { pg: '^8' } }), g);
    const b = open(makeRepo('idx-b', { deps: { pg: '^8' } }), g);
    try {
      const s = put(a, card('K-SHAREDINDEX01A', { layer: 'shared_tech', title: '共享索引只有一份', claim: '共享索引只保存一份条目。',
        applies_to: { dependencies: [{ name: 'pg', range: '*' }] } }), 'shared_tech');
      assert.ok(fs.existsSync(path.join(g, 'index', 'global.sqlite')));
      const mainTables = (a.store.rawDb.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
      assert.ok(!mainTables.includes('entries'), 'repository databases no longer carry their own entry copy');
      const rows = (b.store.rawDb.prepare('SELECT COUNT(*) AS n FROM g.entries WHERE id = ?').get(s.id) as { n: number }).n;
      assert.equal(Number(rows), 1, 'one row for the entry, read by both repositories');
      assert.ok(hits(b, '共享索引只有一份').some((h) => h.entry.id === s.id));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it('upgrades a v6 repository database: drops its private entry copy and re-indexes into the shared index', () => {
    const g = path.join(base, 'g-upgrade-v7');
    const root = makeRepo('upgrade');
    const first = open(root, g);
    const k = put(first, card('K-UPGRADEV700001', { title: '升级后仍可检索', claim: '升级到共享索引之后仍然可以检索到。', search_aliases: ['升级检索'] }), 'project');
    const dbPath = first.store.paths.sqlitePath;
    first.dispose();
    // Simulate the previous layout: a private entry table in the repository database at schema v6.
    fs.rmSync(path.join(g, 'index'), { recursive: true, force: true });
    const old = new DatabaseSync(dbPath);
    old.exec("CREATE TABLE entries (id TEXT, workspace_id TEXT, PRIMARY KEY (workspace_id, id)); INSERT INTO entries VALUES ('K-STALE', 'x'); PRAGMA user_version = 6;");
    old.close();
    const again = open(root, g);
    try {
      const tables = (again.store.rawDb.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = 'entries'").all());
      assert.equal(tables.length, 0);
      assert.ok(hits(again, '升级检索').some((h) => h.entry.id === k.id));
    } finally {
      again.dispose();
    }
  });
});

describe('V11: performance with 30 repositories and 10,000 entries', () => {
  it('keeps radar, file reminder and reopen within budget', () => {
    const g = path.join(base, 'g-perf');
    const REPOS = 30;
    const PER = 330;
    const roots: string[] = [];
    for (let r = 0; r < REPOS; r++) {
      const root = path.join(base, `perf-${r}`);
      fs.mkdirSync(path.join(root, '.accremind', 'entries'), { recursive: true });
      fs.writeFileSync(path.join(root, '.accremind', 'repo.json'), JSON.stringify({ repo_id: `perf-${r}`, domains: [r % 3 === 0 ? 'payment' : 'other'] }));
      for (let i = 0; i < PER; i++) {
        const id = `K-${String(r).padStart(2, '0')}${String(i).padStart(4, '0')}`;
        const layer = i % 4 === 0 ? 'domain' : 'project';
        const e = card(id, {
          layer, ...(layer === 'domain' ? { domains: [r % 3 === 0 ? 'payment' : 'other'] } : {}),
          title: `支付回调幂等经验 repo${r} 第${i}号 module${i % 50}`, search_aliases: ['重复扣款', `alias${i}`],
          claim: `第${r}-${i}条：回调必须按唯一键幂等处理`, watch_paths: [`src/mod${i % 200}/**`],
        });
        fs.writeFileSync(path.join(root, '.accremind', 'entries', `${id}.md`), serializeEntryMarkdown(e));
      }
      roots.push(root);
    }
    // Register every repository once (as opening each would).
    for (const root of roots.slice(1)) new LocalMarkdownSqliteStore({ projectRoot: root, globalDir: g }).close();
    let t = performance.now();
    const first = new LocalMarkdownSqliteStore({ projectRoot: roots[0]!, globalDir: g });
    const firstSync = first.initializeAndReconcile();
    const firstMs = performance.now() - t;
    first.close();
    assert.ok(firstSync.syncedCount >= REPOS * PER * 0.25, `indexed ${firstSync.syncedCount}`);
    assert.ok(firstMs < 15_000, `first full index ${firstMs.toFixed(0)}ms`);

    t = performance.now();
    const store = new LocalMarkdownSqliteStore({ projectRoot: roots[0]!, globalDir: g });
    store.initializeAndReconcile();
    const reopen = performance.now() - t;
    const rt = { store, viewCompiler: null as never };
    void rt;
    const samples: number[] = [];
    const guard: number[] = [];
    for (let k = 0; k < 30; k++) {
      const t1 = performance.now();
      store.search({ workspaceId: store.workspaceId, query: `怎么防止支付回调重复扣款 module${k % 50}` });
      samples.push(performance.now() - t1);
    }
    for (let k = 0; k < 60; k++) {
      const t1 = performance.now();
      store.search({ workspaceId: store.workspaceId, filePath: `src/mod${k % 200}/a.ts` });
      guard.push(performance.now() - t1);
    }
    store.close();
    // Another repository opening afterwards finds everything already indexed (shared index).
    t = performance.now();
    const second = new LocalMarkdownSqliteStore({ projectRoot: roots[1]!, globalDir: g });
    second.initializeAndReconcile();
    const secondOpen = performance.now() - t;
    second.close();
    assert.ok(secondOpen < 1500, `second repository open ${secondOpen.toFixed(0)}ms`);
    const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
    assert.ok(reopen < 1500, `reopen ${reopen.toFixed(0)}ms`);
    assert.ok(p95(samples) < 300, `search p95 ${p95(samples).toFixed(1)}ms`);
    assert.ok(p95(guard) < 60, `file lookup p95 ${p95(guard).toFixed(1)}ms`);
    console.log(`[perf] first index ${firstMs.toFixed(0)}ms, second repo open ${secondOpen.toFixed(0)}ms, reopen ${reopen.toFixed(0)}ms, search p95 ${p95(samples).toFixed(1)}ms, file p95 ${p95(guard).toFixed(1)}ms`);
  });
});
describe('Repository exclusion: the capture and share switches', () => {
  const captureArgs = {
    question: '为什么结算服务读到的时钟和网关差 8 小时？',
    discoverability: 'missing_context', disposition: 'knowledge_candidate',
    baseline_answer: '代码里只看到 new Date()。',
    knowledge_delta: '容器默认 TZ=UTC，网关按东八区解释，结算落库前必须显式转成 UTC。',
    title: '结算落库前显式转 UTC', claim: '写入结算时间前统一转成 UTC，不要依赖容器时区。',
    layer: 'project', preconditions: ['容器未设置 TZ'], invalidation_triggers: ['容器统一设置 TZ=Asia/Shanghai'],
    verification_method: '对比两个时区的写入结果', file_locator: 'src/settle.ts#L1', evidence_summary: '排障记录',
  };

  it('E1: capture=false stops the radar and the capture tool, and keeps the library untouched', async () => {
    const g = path.join(base, 'g-e1');
    const rt = open(makeRepo('settle-e1'), g);
    try {
      assert.deepEqual(rt.store.repoSettings(), { capture: true, share: true }, '未写开关等于开启');
      const saved = await rt.rpcHandlers['accremind.repo.setSettings']!({ capture: false });
      assert.equal((saved as { capture: boolean }).capture, false);
      assert.equal(JSON.parse(fs.readFileSync(rt.store.paths.repoProfileFile, 'utf8')).capture, false);

      const radar = await rt.rpcHandlers['accremind.gov.bootstrapHistory']!({ maxCommits: 50, topK: 5 }) as { minedCommits: unknown[]; message?: string };
      assert.deepEqual(radar.minedCommits, [], '被排除的项目不扫描提交历史');
      assert.match(String(radar.message), /排除沉淀/);

      const capture = rt.tools.find((t) => t.name === 'accremind_capture')!;
      const blocked = await capture.execute(captureArgs, { sessionId: 'excl-1' });
      assert.equal(blocked.isError, true);
      assert.match(blocked.content[0]!.text, /排除沉淀/);
      const written = fs.existsSync(rt.store.paths.projectEntriesDir)
        ? fs.readdirSync(rt.store.paths.projectEntriesDir).filter((f) => f.endsWith('.md'))
        : [];
      assert.deepEqual(written, [], '排除期间一条经验也不落盘');

      await rt.rpcHandlers['accremind.repo.setSettings']!({ capture: true });
      assert.deepEqual(rt.store.repoSettings(), { capture: true, share: true });
      const allowed = await capture.execute(captureArgs, { sessionId: 'excl-2' });
      assert.notEqual(allowed.isError, true, '改回 true 之后捕获恢复正常');
    } finally {
      rt.dispose();
    }
  });

  it('E2: share=false closes the cross-repository channel in both directions', async () => {
    const g = path.join(base, 'g-e2');
    const a = open(makeRepo('pay-api-e2'), g);
    const b = open(makeRepo('pay-admin-e2'), g);
    try {
      await a.rpcHandlers['accremind.repo.setDomains']!({ domains: ['payment'] });
      await b.rpcHandlers['accremind.repo.setDomains']!({ domains: ['payment'] });
      const shared = put(a, card('K-DOMAINEXCL0001', {
        layer: 'domain', domains: ['payment'], title: '退款必须晚于清算日结', claim: '清算日结完成之前不能发起退款。',
        search_aliases: ['退款时机', '清算'],
      }), 'project');
      b.store.rebuildIndexFromScratch();
      assert.equal(hits(b, '什么时候可以发起退款 清算').find((h) => h.entry.id === shared.id)?.scopeVerdict, 'domain_match');

      await a.rpcHandlers['accremind.repo.setSettings']!({ share: false });
      assert.deepEqual(a.store.repoSettings(), { capture: true, share: false });
      b.store.rebuildIndexFromScratch();
      const leaked = hits(b, '什么时候可以发起退款 清算').find((h) => h.entry.id === shared.id);
      assert.equal(leaked, undefined, '关掉共享后，别的仓库不再检索到它的经验，连参考结果也不返回');

      const mine = put(b, card('K-DOMAINEXCL0002', {
        layer: 'domain', domains: ['payment'], title: '对账日切前不要回补流水', claim: '日切回补流水会落到下一账期。',
        search_aliases: ['对账', '回补'],
      }), 'project');
      a.store.rebuildIndexFromScratch();
      assert.equal(hits(a, '对账日切 回补流水').find((h) => h.entry.id === mine.id), undefined, '不共享的仓库也不读取别人的经验');
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

