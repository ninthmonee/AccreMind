import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { collectEvidenceBundle, DeltaAssessor, runArchaeologyBootstrap, sharingAllowed, type LlmInferenceAdapter } from '@accremind/core';
import { createAccreMindRuntime, type AccreMindPluginInstance } from '@accremind/dsh-plugin';

const dirs: string[] = [];
const runtimes: AccreMindPluginInstance[] = [];
afterEach(() => {
  while (runtimes.length) runtimes.pop()!.dispose();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-exclusion-'));
  dirs.push(dir);
  return dir;
}
function open(base: string, name: string, llm: LlmInferenceAdapter | null = null) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/index.ts'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, dependencies: { pg: '8.12.0' } }));
  const rt = createAccreMindRuntime({ projectRoot: root, globalDir: path.join(base, 'global'),
    writeGate: 'off', llmAdapter: llm, autoCapture: { enabled: true, modelUpload: true } });
  runtimes.push(rt);
  return rt;
}
const response = { tokenUsed: 10, content: JSON.stringify({ question: '任务并发重入如何保护？',
  discoverability: 'code_recoverable', disposition: 'index_only', baseline_answer: '代码里已有任务锁。',
  knowledge_delta: '', omission_consequence: '无', priority: 'P2', claim_evidence_map: [], candidate: null }) };
function enqueue(rt: AccreMindPluginInstance) {
  return rt.autoCapture.enqueueJob({ sessionId: 'test-session', sourceType: 'session_turn', sourceRef: 'test-source',
    touchedFiles: ['src/index.ts'], rawCandidateContext: '任务并发重入，代码里已有任务锁。' });
}
async function capture(rt: AccreMindPluginInstance, layer: 'project' | 'domain' | 'shared_tech' | 'personal') {
  const tool = rt.tools.find(t => t.name === 'accremind_capture')!;
  const result = await tool.execute({ question: layer + '：为什么 fork 后 pg 连接中断？', discoverability: 'missing_context',
    disposition: 'knowledge_candidate', baseline_answer: '代码里只看到创建连接池。',
    knowledge_delta: 'fork 子进程继承父进程 socket，父进程回收后会关闭连接，必须重建 pg 连接池。',
    title: 'fork 后 pg 连接池必须重建', claim: 'fork 后在子进程里重建 pg 连接池，避免父进程回收 socket。',
    rationale: '独立回归任务验证了父进程回收后的连接中断。', layer, domains: ['payment'],
    applies_dependencies: layer === 'shared_tech' ? [{ name: 'pg', range: '^8' }] : [],
    search_aliases: ['fork', 'pg', '连接池', 'socket'], preconditions: ['使用 fork 与 pg'],
    invalidation_triggers: ['改为 worker_threads'], verification_method: 'fork 后查询连接状态',
    file_locator: 'src/index.ts#L1', evidence_summary: '排障记录已复现。',
  }, { sessionId: 'capture-fixture' });
  assert.notEqual(result.isError, true, result.content[0]!.text);
  return JSON.parse(result.content[0]!.text).persistedEntry.id as string;
}
function hits(rt: AccreMindPluginInstance) {
  return rt.store.search({ workspaceId: rt.store.workspaceId, query: 'fork 后 pg 连接池 socket', scope: 'all', limit: 30 });
}

describe('Repository exclusion: capture policy throughout the runtime', () => {
  it('pauses pending work and blocks turn completion, direct enqueue, triage and CLI without inference or writes', async () => {
    const base = workspace();
    let calls = 0;
    const llm: LlmInferenceAdapter = { async completeJson() { calls += 1; return response; } };
    const rt = open(base, 'paused', llm);
    const job = enqueue(rt);
    const jobFile = path.join(rt.store.paths.queueDir, job.jobId + '.json');
    const before = fs.readFileSync(jobFile, 'utf8');
    rt.store.setRepoSettings({ capture: false });
    await rt.handleTurnCompleted({ sessionId: 'excluded', userPrompt: '注意，因为并发重入会导致重复结算。', assistantReply: '回归通过。' });
    assert.equal(rt.autoCapture.checkAndEnqueueSession('excluded').enqueuedJob, null);
    assert.throws(() => enqueue(rt), /排除沉淀/);
    assert.deepEqual(await rt.autoCapture.processPendingQueue(), []);
    assert.equal(calls, 0, 'excluded work must not invoke the model');
    assert.equal(fs.readFileSync(jobFile, 'utf8'), before, 'paused work is retained, not retried or consumed');
    assert.equal(rt.store.countAssessments(), 0);
    await assert.rejects(() => runArchaeologyBootstrap({ store: rt.store, triageEngine: rt.triageEngine, llm }), /排除沉淀/);
    assert.equal(calls, 0);
    for (const flags of [[], ['--extract']]) {
      const raw = execFileSync(process.execPath, [path.resolve('packages/dsh-plugin/src/cli.ts'), 'bootstrap',
        '--repo', rt.store.paths.projectRoot, '--global-dir', rt.store.paths.globalRoot, ...flags], { encoding: 'utf8' });
      const result = JSON.parse(raw);
      assert.equal(result.mode, 'repository_excluded');
      assert.deepEqual(result.candidates, []);
    }
    const input = await new DeltaAssessor({ llm, workspaceId: rt.store.workspaceId }).assess(collectEvidenceBundle({
      repoRoot: rt.store.paths.projectRoot, touchedFiles: ['src/index.ts'], rawCandidateContext: '任务锁保护并发。',
      sourceType: 'session_turn', sourceRef: 'isolated-assessment',
    }));
    assert.throws(() => rt.triageEngine.processCandidate(input), /排除沉淀/);
    assert.equal(rt.store.countAssessments(), 0);
    rt.store.setRepoSettings({ capture: true });
    assert.equal((await rt.autoCapture.processPendingQueue()).length, 1, 're-enabling resumes the original queue');
    assert.equal(fs.existsSync(jobFile), false);
  });

  it('retains a queued job when the policy changes during an awaited model response', async () => {
    const base = workspace();
    let rt: AccreMindPluginInstance;
    const llm: LlmInferenceAdapter = { async completeJson() {
      rt.store.setRepoSettings({ capture: false });
      return response;
    } };
    rt = open(base, 'in-flight', llm);
    const job = enqueue(rt);
    const file = path.join(rt.store.paths.queueDir, job.jobId + '.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.deepEqual(await rt.autoCapture.processPendingQueue(), []);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(rt.store.countAssessments(), 0);
    assert.deepEqual(rt.store.listEntriesForAdmin(), []);
  });
});

describe('Repository exclusion: queue ownership and failed in-flight requests', () => {
  it('keeps queues separate for two repositories using the same global directory', async () => {
    const base = workspace();
    let calls = 0;
    const llm: LlmInferenceAdapter = { async completeJson() { calls += 1; return response; } };
    const a = open(base, 'queue-owner', llm);
    const b = open(base, 'other-owner', llm);
    const job = enqueue(a);
    const file = path.join(a.store.paths.queueDir, job.jobId + '.json');
    a.store.setRepoSettings({ capture: false, share: false });
    assert.notEqual(a.store.paths.queueDir, b.store.paths.queueDir);
    assert.deepEqual(b.autoCapture.listQueuedJobs(), []);
    assert.deepEqual(await b.autoCapture.processPendingQueue(), []);
    assert.equal(calls, 0);
    assert.ok(fs.existsSync(file));
  });

  it('does not mutate retry metadata when inference rejects after exclusion', async () => {
    const base = workspace();
    let rt: AccreMindPluginInstance;
    const llm: LlmInferenceAdapter = { async completeJson() {
      rt.store.setRepoSettings({ capture: false });
      throw new Error('fixture rejected inference');
    } };
    rt = open(base, 'rejected-in-flight', llm);
    const job = enqueue(rt);
    const file = path.join(rt.store.paths.queueDir, job.jobId + '.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.deepEqual(await rt.autoCapture.processPendingQueue(), []);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(rt.store.countAssessments(), 0);
  });
});

describe('Repository exclusion: every repository-derived sharing read', () => {
  it('retains originless machine-wide knowledge but never borrows a muted repository source', () => {
    const ctx = { repoId: 'reader', domains: [], languages: [], dependencies: {}, share: false, mutedRepos: ['source'] };
    assert.equal(sharingAllowed('__global__', null, ctx, '__global__'), true);
    assert.equal(sharingAllowed('__global__', 'reader', ctx, '__global__'), true);
    assert.equal(sharingAllowed('__global__', 'source', ctx, '__global__'), false);
    assert.equal(sharingAllowed('source', 'reader', ctx, '__global__'), false);
  });

  it('gates global origins, direct IDs, admin lists, duplicates and rule documents without rebuilding the shared index', async () => {
    const base = workspace();
    const a = open(base, 'source');
    const b = open(base, 'reader');
    a.store.updateRepoProfile({ domains: ['payment'] });
    b.store.updateRepoProfile({ domains: ['payment'] });
    const ids = [];
    for (const layer of ['shared_tech', 'domain', 'personal'] as const) ids.push(await capture(a, layer));
    const own = await capture(b, 'project');
    const doc = a.store.docs.importDoc({ category: 'business_rules', fileName: 'clearing.md', domains: ['payment'],
      title: '支付清算规则', tags: ['清算专用术语'], content: '# 支付清算规则\n\n## 退款顺序\n\n退款必须等到支付清算日结完成。\n' });
    b.store.docs.reconcile();
    for (const id of ids) {
      const entry = a.store.getEntry(id, { recordUsage: false });
      assert.ok(entry.found && entry.servable);
      const baseline = b.store.search({ workspaceId: b.store.workspaceId, query: 'fork 后 pg 连接池 socket',
        scope: 'all', layer: entry.entry.layer, limit: 30 });
      assert.ok(baseline.items.some(h => h.entry.id === id), 'shared origin visible before exclusion in layer ' + entry.entry.layer + ': ' + JSON.stringify(baseline.items.map(h => ({ id: h.entry.id, verdict: h.scopeVerdict }))));
      assert.equal(b.store.getEntry(id, { recordUsage: false }).found, true);
    }
    assert.ok(b.store.docs.getDoc(doc.docId));
    const section = b.store.docs.search({ query: '退款 支付清算', ctx: b.store.sessionContext() })[0]!;
    assert.ok(section);
    assert.ok(b.store.docs.getSection(section.ref));
    a.store.setRepoSettings({ share: false });
    assert.ok(b.store.sessionContext({ share: true, mutedRepos: [] }).mutedRepos?.includes(a.store.workspaceId));
    assert.equal(b.store.sessionContext({ repoId: a.store.workspaceId }).repoId, b.store.workspaceId);
    assert.equal(b.store.search({ workspaceId: b.store.workspaceId, context: { repoId: a.store.workspaceId },
      query: 'fork 后 pg 连接池 socket', scope: 'all', limit: 30 }).items.some(h => ids.includes(h.entry.id)), false);
    for (const id of ids) {
      assert.equal(hits(b).items.some(h => h.entry.id === id), false);
      assert.equal(b.store.getEntry(id, { recordUsage: false, includeHistoryOrSuspended: true }).found, false);
      assert.equal(b.store.listEntriesForAdmin().some(h => h.entry.id === id), false);
    }
    const original = a.store.getEntry(ids[0]!, { recordUsage: false });
    assert.ok(original.found && original.servable);
    assert.equal(b.store.findSimilarEntries(original.entry).some(h => ids.includes(h.id)), false);
    assert.equal(b.store.docs.getDoc(doc.docId), null);
    assert.equal(b.store.docs.getSection(section.ref), null);
    assert.equal(b.store.docs.listDocs().some(d => d.docId === doc.docId), false);
    assert.deepEqual(b.store.docs.search({ query: '退款 支付清算', ctx: { ...b.store.sessionContext(), share: true, mutedRepos: [] } }), []);
    assert.ok(a.store.getEntry(ids[0]!, { recordUsage: false }).found, 'existing own-origin global knowledge is retained');
    assert.equal(hits(a).items.some(h => h.entry.id === own), false, 'sharing disabled is also inbound');
    assert.equal(a.store.sessionContext({ share: true }).share, false, 'host hints cannot weaken the policy');
    a.store.setRepoSettings({ share: true });
    for (const id of ids) {
      const entry = a.store.getEntry(id, { recordUsage: false });
      assert.ok(entry.found && entry.servable);
      assert.ok(b.store.search({ workspaceId: b.store.workspaceId, query: 'fork 后 pg 连接池 socket',
        scope: 'all', layer: entry.entry.layer, limit: 30 }).items.some(h => h.entry.id === id), 'sharing resumes without an index rebuild');
    }
    assert.ok(b.store.docs.getSection(section.ref));
  });
});
