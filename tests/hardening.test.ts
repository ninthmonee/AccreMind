import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AutoCaptureCoordinator,
  ENTRY_ID_PATTERN,
  EntryIdCollisionError,
  LocalMarkdownSqliteStore,
  OpenAiCompatibleLlmClient,
  TriageEngine,
  evaluateSemverRange,
  generateEntryId,
  isSqliteCorruptionError,
  redactSensitiveText,
  resolveLlmEndpoint,
  serializeEntryMarkdown,
  type KnowledgeEntry,
} from '@accremind/core';
import { createAccreMindRuntime, renderAccreMindWebuiHtml, startAccreMindWebuiServer } from '@accremind/dsh-plugin';

const tempDirs: string[] = [];
function workspace(): { projectRoot: string; globalDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-hardening-'));
  tempDirs.push(base);
  const projectRoot = path.join(base, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });
  return { projectRoot, globalDir: path.join(base, 'global') };
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  const now = '2026-11-21T00:00:00.000Z';
  return {
    id, revision: 1, type: 'pitfall', knowledge_role: 'authoritative_mirror', layer: 'project',
    title: '支付回调必须幂等', search_aliases: ['重复扣款'], claim: '支付回调需按 notify_id 唯一键幂等处理',
    knowledge_delta: '网关超时会重放通知', rationale: '线上曾出现双倍入账', preconditions: ['修改支付回调'],
    exclusions: [], dependency_constraints: [], watch_paths: ['src/pay/**'], symbol_anchors: [],
    invalidation_triggers: ['改用消息队列消费回调'], verification_method: '并发重放测试', alternatives: [],
    enforcement: { kind: 'none', status: 'proposed', ref: null }, status: 'active', maturity: 'draft',
    freshness: 'current', serving: 'enabled', priority: 'P0', capture_assessment_id: null, supersedes: null,
    evidence: [{ id: 'E1', source_type: 'doc_ref', source_ref: 'README.md', locator: 'README.md#L1', summary: '说明' }],
    created_at: now, updated_at: now, last_validated_at: null, review_due_at: now, ...overrides,
  };
}

describe('Hardening: identity and storage safety', () => {
  it('generates collision-free, pattern-valid IDs without coordination', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) ids.add(generateEntryId('K'));
    assert.equal(ids.size, 10_000);
    for (const id of [...ids].slice(0, 50)) assert.match(id, ENTRY_ID_PATTERN);
    assert.match('K-1001', ENTRY_ID_PATTERN, 'legacy IDs stay valid');
  });

  it('refuses to overwrite a different entry that shares an ID, and moving zones leaves no stale copy', () => {
    const store = new LocalMarkdownSqliteStore(workspace());
    store.initializeAndReconcile();
    store.upsertEntry(entry('K-2001', { status: 'probation' }), 'probation', null);
    assert.throws(
      () => store.upsertEntry(entry('K-2001', { title: '另一条完全不同的经验', created_at: '2026-11-22T00:00:00.000Z' }), 'project', null),
      EntryIdCollisionError,
    );
    // Same entry (same creation time) moved to the project zone: the probation copy disappears.
    store.upsertEntry(entry('K-2001'), 'project', null);
    assert.equal(fs.existsSync(path.join(store.paths.probationDir, 'K-2001.md')), false);
    const got = store.getEntry('K-2001', { recordUsage: false });
    assert.ok(got.found && got.servable && got.storageZone === 'project');
    store.close();
  });

  it('keeps the confirmed copy when a stale probation file shares its ID and reports the duplicate', () => {
    const store = new LocalMarkdownSqliteStore(workspace());
    fs.writeFileSync(path.join(store.paths.projectEntriesDir, 'K-3001.md'), serializeEntryMarkdown(entry('K-3001', { title: '项目正式版本' })));
    fs.writeFileSync(path.join(store.paths.probationDir, 'K-3001.md'), serializeEntryMarkdown(entry('K-3001', { title: '试用旧草稿', status: 'probation' })));
    store.initializeAndReconcile();
    const got = store.getEntry('K-3001', { recordUsage: false });
    assert.ok(got.found && got.servable);
    assert.equal(got.entry.title, '项目正式版本');
    assert.ok(store.listCorruptedFiles().some((c) => c.reason.includes('K-3001')));
    store.close();
  });

  it('only rebuilds the index for genuine corruption, never for busy or locked databases', () => {
    assert.equal(isSqliteCorruptionError(new Error('database is locked')), false);
    assert.equal(isSqliteCorruptionError(new Error('SQLITE_BUSY: database is busy')), false);
    assert.equal(isSqliteCorruptionError(new Error('file is not a database')), true);
    const ws = workspace();
    const first = new LocalMarkdownSqliteStore(ws);
    const dbPath = first.paths.sqlitePath;
    first.close();
    fs.writeFileSync(dbPath, 'this is not sqlite '.repeat(200));
    const healed = new LocalMarkdownSqliteStore(ws);
    healed.initializeAndReconcile();
    assert.ok(fs.readdirSync(path.dirname(dbPath)).some((f) => f.includes('.corrupt.')), 'corrupt file is kept aside');
    healed.close();
  });

  it('gives every repository its own index file', () => {
    const a = new LocalMarkdownSqliteStore(workspace());
    const b = new LocalMarkdownSqliteStore({ ...workspace(), globalDir: a.paths.globalRoot });
    assert.notEqual(a.paths.sqlitePath, b.paths.sqlitePath);
    a.close();
    b.close();
  });
});

describe('Hardening: privacy and model calls', () => {
  it('never pairs a vendor key with another vendor endpoint', () => {
    const openaiOnly = resolveLlmEndpoint({ OPENAI_API_KEY: 'sk-openai' });
    assert.equal(new URL(openaiOnly.baseUrl).hostname, 'api.openai.com');
    const deepseekBaseOpenAiKey = resolveLlmEndpoint({ ACCREMIND_LLM_BASE_URL: 'https://api.deepseek.com/v1', OPENAI_API_KEY: 'sk-openai' });
    assert.equal(deepseekBaseOpenAiKey.apiKey, '');
    const thirdParty = resolveLlmEndpoint({ ACCREMIND_LLM_BASE_URL: 'https://llm.example.com/v1', DEEPSEEK_API_KEY: 'sk-ds' });
    assert.equal(thirdParty.apiKey, '');
    assert.equal(resolveLlmEndpoint({}).configured, false);
  });

  it('does not retry requests that a retry cannot fix', async () => {
    let calls = 0;
    const client = new OpenAiCompatibleLlmClient({
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', maxRetries: 3,
      fetchImpl: (async () => { calls += 1; return new Response('bad key', { status: 401 }); }) as typeof fetch,
    });
    await assert.rejects(() => client.completeJson({ systemPrompt: 's', userPrompt: 'u' }), /401/);
    assert.equal(calls, 1);
  });

  it('redacts conversation excerpts before they are written to the retry queue', () => {
    const store = new LocalMarkdownSqliteStore(workspace());
    const coordinator = new AutoCaptureCoordinator({ store, triageEngine: new TriageEngine(store, 'probation'), llm: null });
    const job = coordinator.enqueueJob({
      sessionId: 's1', sourceType: 'session_turn', sourceRef: 's1', touchedFiles: [],
      rawCandidateContext: '连接串 postgres://app:Sup3rSecret@db/prod，password=hunter22pass，手机 13812345678',
    });
    const onDisk = fs.readFileSync(path.join(store.paths.queueDir, `${job.jobId}.json`), 'utf8');
    for (const secret of ['Sup3rSecret', 'hunter22pass', '13812345678']) assert.equal(onDisk.includes(secret), false, secret);
    store.close();
  });

  it('covers common cloud keys and personal identifiers without touching ordinary numbers', () => {
    const out = redactSensitiveText('LTAIabcdefghijkl1234 身份证 11010519491231002X 订单 202611211234567890').redactedText;
    assert.ok(!out.includes('LTAI') && !out.includes('11010519491231002X'));
    assert.ok(out.includes('202611211234567890'));
  });

  it('keeps background model upload off until the user opts in for the workspace', () => {
    const ws = workspace();
    const runtime = createAccreMindRuntime({ ...ws, autoCapture: { enabled: true } });
    const get = runtime.rpcHandlers['accremind.settings.get']!;
    assert.equal((get({}) as { modelUpload: boolean }).modelUpload, false);
    runtime.rpcHandlers['accremind.settings.setModelUpload']!({ modelUpload: true });
    assert.equal((get({}) as { modelUpload: boolean }).modelUpload, true);
    runtime.dispose();
  });
});

describe('Hardening: version ranges', () => {
  const cases: Array<[string, string, ReturnType<typeof evaluateSemverRange>]> = [
    ['2.1.0', '^1.0.0 || ^2.0.0', 'match'], ['3.0.0', '^1.0.0 || ^2.0.0', 'mismatch'],
    ['1.5.0', '1.x', 'match'], ['2.0.0', '1.x', 'mismatch'], ['3.0.0-beta.1', '>=3.0.0', 'mismatch'],
    ['0.2.5', '^0.2.3', 'match'], ['0.3.0', '^0.2.3', 'mismatch'], ['1.5.0', '1.0.0 - 2.0.0', 'match'],
    ['2.0.1', '1.0.0 - 2.0.0', 'mismatch'], ['workspace:*', '>=2', 'unknown'], ['^18.2.0', '^18.0.0', 'match'],
  ];
  for (const [version, range, expected] of cases) {
    it(`${version} against ${range} is ${expected}`, () => assert.equal(evaluateSemverRange(version, range), expected));
  }
});

describe('Hardening: standalone workbench server', () => {
  it('ships a workbench script that parses (template-literal escapes are easy to break)', () => {
    for (const embedded of [false, true]) {
      const html = renderAccreMindWebuiHtml({ embedded });
      const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
      assert.doesNotThrow(() => new Function(script));
      assert.equal(/KV-CACHE|registerMessageProjection|Tier 2\.5/.test(html), false, 'no internal jargon in the UI');
    }
  });

  it('rejects cross-site, rebinding and tokenless calls, and accepts its own page', async () => {
    const runtime = createAccreMindRuntime({ ...workspace(), llmAdapter: null, autoCapture: { enabled: false } });
    const srv = await startAccreMindWebuiServer(runtime, { port: 0 });
    const body = JSON.stringify({ method: 'accremind.settings.setGate', params: { writeGate: 'review' } });
    try {
      const page = await (await fetch(srv.url + '/')).text();
      assert.ok(page.includes(srv.token), 'the page carries its launch token');

      const csrf = await fetch(srv.url + '/rpc', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body });
      assert.equal(csrf.status, 403);
      const noToken = await fetch(srv.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(noToken.status, 401);
      const plain = await fetch(srv.url + '/rpc', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-accremind-token': srv.token }, body });
      assert.equal(plain.status, 415);
      const proto = await fetch(srv.url + '/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-accremind-token': srv.token },
        body: JSON.stringify({ method: 'constructor', params: {} }),
      });
      assert.equal(proto.status, 404);
      const get = runtime.rpcHandlers['accremind.settings.get']!;
      assert.equal((get({}) as { writeGate: string }).writeGate, 'probation', 'rejected calls changed nothing');

      const ok = await fetch(srv.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-accremind-token': srv.token }, body });
      assert.equal(ok.status, 200);
      assert.equal((get({}) as { writeGate: string }).writeGate, 'review');
    } finally {
      await srv.close();
      runtime.dispose();
    }
  });

  it('rejects requests whose Host is not the loopback address (DNS rebinding)', async () => {
    const runtime = createAccreMindRuntime({ ...workspace(), llmAdapter: null, autoCapture: { enabled: false } });
    const srv = await startAccreMindWebuiServer(runtime, { port: 0 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        import('node:http').then(({ request }) => {
          const req = request({ host: '127.0.0.1', port: srv.port, path: '/', headers: { host: `attacker.example:${srv.port}` } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        }, reject);
      });
      assert.equal(status, 403);
    } finally {
      await srv.close();
      runtime.dispose();
    }
  });
});
