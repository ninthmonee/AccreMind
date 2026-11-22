import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmInferenceAdapter,
} from '@accremind/core';
import type { CordisContext } from './cordis-types.ts';

/**
 * Bridges AccreMind's `LlmInferenceAdapter` seam onto DeepSeek Harness' own model service
 * (`ctx.get('llm')`), so the plugin never needs a third-party API key of its own.
 *
 * Everything here is defensive: the service shape is read, never assumed. A host that exposes no
 * model service simply yields `null`, and the plugin keeps working without auto-capture.
 */

/** Chunks yielded by the host model service; `reasoning-delta` carries thinking, not the answer. */
interface HostLlmChunk {
  type?: string;
  text?: string;
  usage?: { totalTokens?: number; outputTokens?: number };
}

interface HostLlmProvider {
  id?: string;
  model?: string;
}

interface HostLlmService {
  stream?: (request: Record<string, unknown>) => AsyncIterable<HostLlmChunk>;
  listProviders?: () => HostLlmProvider[];
}

export interface HostLlmProviderSummary {
  provider: string;
  model: string;
}

/** Providers that must never back knowledge capture (they are other plugins' private judges). */
const EXCLUDED_PROVIDER_IDS = new Set(['lingshu-whitebox']);

const HOST_ADAPTER_META = new WeakMap<object, HostLlmProviderSummary>();
/** Membership is recorded at creation: an adapter may stay unbound if the host never answers. */
const HOST_ADAPTERS = new WeakSet<object>();

/** Rough token estimate used only for reporting; matches the view compiler's byte/3.2 rule. */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.2);
}

function readHostLlm(ctx: CordisContext): HostLlmService | null {
  try {
    const llm = ctx.get?.('llm');
    if (!llm || typeof llm !== 'object') return null;
    return typeof (llm as HostLlmService).stream === 'function' ? (llm as HostLlmService) : null;
  } catch {
    // Cordis throws on undeclared service access in some hosts; a missing model service is benign.
    return null;
  }
}

function pickProvider(llm: HostLlmService): HostLlmProviderSummary | null {
  let providers: HostLlmProvider[];
  try {
    providers = llm.listProviders?.() ?? [];
  } catch {
    return null;
  }
  if (!Array.isArray(providers)) return null;
  for (const candidate of providers) {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    if (!id || EXCLUDED_PROVIDER_IDS.has(id)) continue;
    const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : id;
    return { provider: id, model };
  }
  return null;
}

function userMessage(text: string): { role: string; content: { type: 'text'; text: string }[] } {
  return { role: 'user', content: [{ type: 'text', text }] };
}

async function drain(
  llm: HostLlmService,
  request: Record<string, unknown>,
): Promise<{ text: string; tokenUsed: number }> {
  let text = '';
  let tokenUsed = 0;
  for await (const chunk of llm.stream!(request)) {
    if (typeof chunk?.text === 'string' && chunk.type !== 'reasoning-delta') text += chunk.text;
    const total = chunk?.usage?.totalTokens;
    if (typeof total === 'number' && total > 0) tokenUsed = total;
  }
  return { text, tokenUsed: tokenUsed || estimateTokens(text) };
}

/**
 * One request through the host model service. System and user prompts are sent as separate turns;
 * hosts that only accept a single text part get a merged retry instead of a failed capture.
 */
async function completeThroughHost(
  llm: HostLlmService,
  provider: HostLlmProviderSummary,
  req: LlmCompletionRequest,
): Promise<LlmCompletionResponse> {
  const base = {
    provider: provider.provider,
    model: provider.model,
    maxTokens: 2048,
    ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
  };
  try {
    const { text, tokenUsed } = await drain(llm, {
      ...base,
      messages: [
        { role: 'system', content: [{ type: 'text', text: req.systemPrompt }] },
        userMessage(req.userPrompt),
      ],
    });
    if (text.trim()) return { content: text, tokenUsed };
    throw new Error('宿主模型返回空内容');
  } catch (first) {
    const { text, tokenUsed } = await drain(llm, {
      ...base,
      messages: [userMessage(`${req.systemPrompt}\n\n${req.userPrompt}`)],
    });
    if (!text.trim()) {
      throw new Error(
        `宿主模型未返回可用内容：${first instanceof Error ? first.message : String(first)}`,
      );
    }
    return { content: text, tokenUsed };
  }
}

interface BoundHostLlm {
  llm: HostLlmService;
  provider: HostLlmProviderSummary;
}

/**
 * Builds the adapter from the host model service. The plugin passes the result into its runtime
 * options, so every workspace inherits it and no API key is ever needed.
 *
 * Binding is deferred on purpose: plugins mount in an order the host chooses, so the model service
 * may not answer `ctx.get('llm')` yet. A direct read is tried first, an `inject(['llm'])`
 * declaration captures the service whenever it appears, and the first capture wins.
 */
export function createHostLlmAdapter(ctx: CordisContext): LlmInferenceAdapter {
  let bound: BoundHostLlm | null = null;
  let adapter: LlmInferenceAdapter | null = null;
  const capture = (candidate: CordisContext): BoundHostLlm | null => {
    if (bound) return bound;
    const llm = readHostLlm(candidate);
    if (!llm) return null;
    const provider = pickProvider(llm);
    if (!provider) return null;
    bound = { llm, provider };
    if (adapter) HOST_ADAPTER_META.set(adapter, provider);
    return bound;
  };
  capture(ctx);
  try {
    // A host that rejects the declaration throws here; the direct read above still applies.
    ctx.inject?.(['llm'], (inner) => { capture(inner); });
  } catch {
    // ignore: services are probed, never assumed
  }
  const hostAdapter: LlmInferenceAdapter = {
    completeJson: (req: LlmCompletionRequest): Promise<LlmCompletionResponse> => {
      const target = bound ?? capture(ctx);
      if (!target) return Promise.reject(new Error('宿主未提供 llm 模型服务，经验评估暂不可用'));
      return completeThroughHost(target.llm, target.provider, req);
    },
  };
  adapter = hostAdapter;
  HOST_ADAPTERS.add(hostAdapter);
  if (bound) HOST_ADAPTER_META.set(hostAdapter, (bound as BoundHostLlm).provider);
  return hostAdapter;
}

/** True when the adapter came from {@link createHostLlmAdapter}, not from an explicitly injected one. */
export function isHostLlmAdapter(adapter: LlmInferenceAdapter | null | undefined): boolean {
  return Boolean(adapter && HOST_ADAPTERS.has(adapter as object));
}

/** Provider/model behind a host adapter, for display in settings; `null` while still unbound. */
export function hostLlmProvider(adapter: LlmInferenceAdapter | null | undefined): HostLlmProviderSummary | null {
  return adapter ? (HOST_ADAPTER_META.get(adapter as object) ?? null) : null;
}

/**
 * Human-readable model channel label. Keeps the three sources distinguishable in the workbench so
 * users can tell "the host answered" apart from "no model at all".
 */
export function describeModelChannel(adapter: LlmInferenceAdapter | null | undefined): string {
  if (!adapter) return '未配置模型';
  if (isHostLlmAdapter(adapter)) {
    const host = hostLlmProvider(adapter);
    return host ? `宿主模型服务（${host.provider}/${host.model}）` : '宿主模型服务（待连接）';
  }
  return '外部注入适配器';
}
