import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createAccreMindRuntime } from '@accremind/dsh-plugin';
import { authFixtures } from './helpers/auth-fixtures.ts';
import { FakeDshHost } from './helpers/fake-dsh-host.ts';

const tempDirs: string[] = [];
const hosts: FakeDshHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function seededRepo(): { repoRoot: string; globalDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-native-'));
  tempDirs.push(base);
  const repoRoot = path.join(base, 'repo');
  const globalDir = path.join(base, 'global');
  fs.mkdirSync(path.join(repoRoot, 'src/auth'), { recursive: true });
  const seed = createAccreMindRuntime({ projectRoot: repoRoot, globalDir, llmAdapter: null });
  const { ruleEntry, authAssessment, authPitfall } = authFixtures(seed.store.workspaceId);
  seed.store.upsertEntry(ruleEntry, 'rules', null);
  seed.store.upsertEntry(authPitfall, 'project', authAssessment);
  seed.dispose();
  return { repoRoot, globalDir };
}

function mount(globalDir: string): FakeDshHost {
  const host = new FakeDshHost();
  hosts.push(host);
  host.mount({ globalDir, llmAdapter: null, autoCapture: { enabled: false } });
  return host;
}

const text = (m: { content: Array<{ text?: string }> }) => m.content.map((c) => c.text ?? '').join('\n');

describe('DSH native host integration (agents, waterfalls, connection route)', () => {
  it('binds tools and a byte-stable rules section to each agent of a repository session', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    const agent = host.createAgent('s-1', repoRoot);

    assert.deepEqual([...agent.tools.keys()].sort(), [
      'accremind_capture', 'accremind_export_skill', 'accremind_get', 'accremind_search', 'accremind_validate',
    ]);
    const section = agent.sections.find((s) => s.name === 'accremind-resident-rules');
    assert.ok(section);
    const first = await section.text();
    assert.equal(await section.text(), first, 'resident rules must not change between steps (KV cache)');
    assert.match(first, /R-0001@r1/);
  });

  it('ignores sessions without an absolute working directory', () => {
    const { globalDir } = seededRepo();
    const host = mount(globalDir);
    const agent = host.createAgent('s-nocwd', 'relative/path');
    assert.equal(agent.tools.size, 0);
  });

  it('admits the radar as an extra immutable message and never rewrites the user message', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    const agent = host.createAgent('s-2', repoRoot);
    const prompt = '为什么移动端用户偶尔会被踢下线？';
    const admitted = await host.preStep(agent, prompt);

    assert.equal(text(admitted[0]!), prompt, 'the user message itself is untouched');
    const radar = admitted.find((m) => m.source?.kind === 'accremind');
    assert.ok(radar, 'radar is admitted as its own identified message');
    assert.match(text(radar), /<accremind-radar role="reference-only"/);
    assert.match(text(radar), /K-0888/);
  });

  it('adds a file reminder after a tool touches an anchored file, once per session', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    const agent = host.createAgent('s-3', repoRoot);
    await host.preStep(agent, '帮我调整一下首页按钮的颜色');

    const first = await host.afterTool(agent, 'edit', { path: 'src/auth/token.ts' }, 'Updated token.ts');
    assert.equal(first.length, 1);
    assert.equal(first[0]!.source?.kind, 'accremind');
    assert.match(text(first[0]!), /<accremind-guard/);
    assert.match(text(first[0]!), /K-0888/);

    const again = await host.afterTool(agent, 'read', { path: 'src/auth/token.ts' }, 'export {}');
    assert.equal(again.length, 0, 'the same entry is not repeated within a session');

    const outside = await host.afterTool(agent, 'read', { path: '../other-repo/src/auth/token.ts' }, 'x');
    assert.equal(outside.length, 0, 'paths outside the repository are ignored');
  });

  it('records what each turn used and exposes it through the authenticated workbench route', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    const agent = host.createAgent('s-4', repoRoot);
    await host.preStep(agent, '为什么移动端用户偶尔会被踢下线？');
    host.endTurn(agent, '已解释宽限窗口');

    assert.equal(host.routePath, '/api/accremind/invoke');
    const listed = await host.invoke('s-4', 'accremind.turn.list', {});
    assert.equal(listed.ok, true);
    const hits = listed.value.receipts[0].hits.map((h: { id: string }) => h.id);
    assert.ok(hits.includes('K-0888'));

    const html = await host.invoke('s-4', 'workbench');
    assert.equal(html.ok, true);
    assert.match(html.value, /<!DOCTYPE html>/);
  });

  it('rejects unknown, prototype and cross-session workbench calls', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    host.createAgent('s-5', repoRoot);

    assert.equal((await host.invoke('s-5', 'accremind.nope')).ok, false);
    assert.equal((await host.invoke('s-5', 'constructor')).ok, false);
    assert.equal((await host.invoke('s-5', 'accremind.turn.list', { sessionId: 'someone-else' })).ok, false);
    assert.equal((await host.invoke('missing-session', 'accremind.kb.list')).ok, false);
  });

  it('unbinds tools when the agent goes away and on plugin disposal', async () => {
    const { repoRoot, globalDir } = seededRepo();
    const host = mount(globalDir);
    const a = host.createAgent('s-6', repoRoot);
    const b = host.createAgent('s-7', repoRoot);
    host.disposeAgent(a);
    await new Promise((r) => setImmediate(r));
    assert.equal(a.tools.size, 0);
    assert.equal(b.tools.size, 5);
    host.dispose();
    await new Promise((r) => setImmediate(r));
    assert.equal(b.tools.size, 0);
  });

  it('never breaks the agent when AccreMind cannot open a workspace', async () => {
    const { globalDir } = seededRepo();
    const host = mount(globalDir);
    // An absolute cwd where `.accremind/` cannot be created (a regular file) makes the store fail.
    const notADir = path.join(globalDir, 'not-a-directory');
    fs.writeFileSync(notADir, 'x');
    const agent = host.createAgent('s-8', notADir);
    assert.equal(agent.tools.size, 0);
    const admitted = await host.preStep(agent, '被踢下线');
    assert.equal(admitted.length, 1, 'the step proceeds with the original messages only');
    assert.deepEqual(await host.afterTool(agent, 'edit', { path: 'a.ts' }, 'ok'), []);
    host.endTurn(agent, 'done');
  });
});
