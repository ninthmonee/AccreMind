import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createHostLlmAdapter,
  describeModelChannel,
  hostLlmProvider,
  isHostLlmAdapter,
} from '../packages/dsh-plugin/src/host-llm-adapter.ts';
import { FakeDshHost } from './helpers/fake-dsh-host.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface StreamRequest {
  provider: string;
  model: string;
  maxTokens: number;
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
}

/** Stand-in for the host model service: records requests and replays scripted chunks. */
function fakeLlm(options: {
  providers?: Array<{ id?: string; model?: string }>;
  chunks?: Array<{ type?: string; text?: string; usage?: { totalTokens?: number } }>;
  failSystemRole?: boolean;
} = {}) {
  const requests: StreamRequest[] = [];
  return {
    requests,
    service: {
      listProviders: () => options.providers ?? [{ id: 'deepseek', model: 'deepseek-chat' }],
      stream: async function* (request: StreamRequest) {
        requests.push(request);
        if (options.failSystemRole && request.messages.some((m) => m.role === 'system')) {
          throw new Error('unsupported role: system');
        }
        for (const chunk of options.chunks ?? [
          { type: 'reasoning-delta', text: '内部推理' },
          { type: 'text', text: '{"ok":' },
          { type: 'text', text: 'true}', usage: { totalTokens: 42 } },
        ]) {
          yield chunk;
        }
      },
    },
  };
}

describe('host model adapter', () => {
  it('reads the host model service and reports its provider', () => {
    const { service } = fakeLlm();
    const adapter = createHostLlmAdapter({ get: (name: string) => (name === 'llm' ? service : undefined) } as any);
    assert.ok(adapter, 'host service should yield an adapter');
    assert.equal(isHostLlmAdapter(adapter), true);
    assert.deepEqual(hostLlmProvider(adapter), { provider: 'deepseek', model: 'deepseek-chat' });
    assert.match(describeModelChannel(adapter), /宿主模型服务（deepseek\/deepseek-chat）/);
  });

  it('stays unbound when the host exposes no model service', async () => {
    const missing = createHostLlmAdapter({ get: () => undefined } as any);
    assert.equal(isHostLlmAdapter(missing), true);
    assert.equal(hostLlmProvider(missing), null);
    assert.equal(describeModelChannel(missing), '宿主模型服务（待连接）');
    await assert.rejects(() => missing.completeJson({ systemPrompt: 'S', userPrompt: 'U' }), /宿主未提供 llm/);
    const throwing = { get: () => { throw new Error('service not declared'); } } as any;
    assert.equal(hostLlmProvider(createHostLlmAdapter(throwing)), null);
    assert.equal(hostLlmProvider(createHostLlmAdapter({ get: () => ({ listProviders: () => [] }) } as any)), null);
  });

  it('binds through inject when the service is not readable at mount time', async () => {
    const { service } = fakeLlm();
    const adapters: Array<(inner: any) => void> = [];
    const ctx = {
      get: () => undefined,
      inject: (names: string[], install: (inner: any) => void) => { adapters.push(install); return () => {}; },
    } as any;
    const adapter = createHostLlmAdapter(ctx);
    assert.equal(hostLlmProvider(adapter), null);
    // The host only publishes the model service after the plugin mounted.
    adapters[0]!({ get: (name: string) => (name === 'llm' ? service : undefined) });
    assert.deepEqual(hostLlmProvider(adapter), { provider: 'deepseek', model: 'deepseek-chat' });
    const result = await adapter.completeJson({ systemPrompt: 'S', userPrompt: 'U' });
    assert.equal(result.content, '{"ok":true}');
  });

  it('skips the lingshu-whitebox judge when choosing a provider', () => {
    const { service } = fakeLlm({ providers: [{ id: 'lingshu-whitebox' }, { id: 'qwen', model: 'qwen-max' }] });
    const adapter = createHostLlmAdapter({ get: () => service } as any);
    assert.deepEqual(hostLlmProvider(adapter), { provider: 'qwen', model: 'qwen-max' });
  });

  it('collects answer text without the reasoning stream and keeps host token usage', async () => {
    const { service, requests } = fakeLlm();
    const adapter = createHostLlmAdapter({ get: () => service } as any)!;
    const result = await adapter.completeJson({
      systemPrompt: '你是评估器', userPrompt: '评估这条经验', temperature: 0,
    });
    assert.equal(result.content, '{"ok":true}');
    assert.equal(result.tokenUsed, 42);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.provider, 'deepseek');
    assert.equal(requests[0]!.model, 'deepseek-chat');
    assert.equal(requests[0]!.messages[0]!.role, 'system');
    assert.equal(requests[0]!.messages[0]!.content[0]!.text, '你是评估器');
    assert.equal(requests[0]!.messages[1]!.content[0]!.text, '评估这条经验');
  });

  it('merges the prompt into one user turn when the host rejects system roles', async () => {
    const { service, requests } = fakeLlm({ failSystemRole: true });
    const adapter = createHostLlmAdapter({ get: () => service } as any)!;
    const result = await adapter.completeJson({ systemPrompt: 'S', userPrompt: 'U' });
    assert.equal(result.content, '{"ok":true}');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.messages.map((m) => m.role), ['user']);
    assert.equal(requests[1]!.messages[0]!.content[0]!.text, 'S\n\nU');
  });

  it('surfaces an empty answer instead of a silent success', async () => {
    const { service } = fakeLlm({ chunks: [{ type: 'reasoning-delta', text: '只有推理' }] });
    const adapter = createHostLlmAdapter({ get: () => service } as any)!;
    await assert.rejects(() => adapter.completeJson({ systemPrompt: 'S', userPrompt: 'U' }), /宿主模型/);
  });

  it('labels injected adapters and missing models distinctly', () => {
    const injected = { completeJson: async () => ({ content: '{}', tokenUsed: 1 }) };
    assert.equal(isHostLlmAdapter(injected), false);
    assert.equal(describeModelChannel(injected), '外部注入适配器');
    assert.equal(describeModelChannel(null), '未配置模型');
  });

  it('wires the host service into every workspace runtime through settings', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-host-llm-'));
    tempDirs.push(base);
    const repoRoot = path.join(base, 'repo');
    const globalDir = path.join(base, 'global');
    fs.mkdirSync(repoRoot, { recursive: true });
    const { service } = fakeLlm();
    const host = new FakeDshHost({ llm: service });
    try {
      // No llmAdapter is passed: the plugin must reach for the host's own model service.
      host.mount({ projectRoot: repoRoot, globalDir, autoCapture: { enabled: false } });
      host.createAgent('session-1', repoRoot);
      const settings = await host.invoke('session-1', 'accremind.settings.get');
      assert.equal(settings.ok, true);
      assert.equal(settings.value.modelChannel, 'host');
      assert.equal(settings.value.modelAvailable, true);
      assert.match(settings.value.modelEndpoint, /宿主模型服务/);
    } finally {
      host.dispose();
    }
  });
});
