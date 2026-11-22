export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface ResolvedLlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Where the key came from, for display only; never the key itself. */
  keySource: 'ACCREMIND_LLM_API_KEY' | 'DEEPSEEK_API_KEY' | 'OPENAI_API_KEY' | 'none';
  configured: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Pairs each vendor key with its own endpoint so a key is never sent to another vendor.
 * - `ACCREMIND_LLM_API_KEY` goes to `ACCREMIND_LLM_BASE_URL` (DeepSeek when unset).
 * - With a custom base URL, only the key of that vendor (by host) is used; other hosts get no key.
 * - Otherwise `DEEPSEEK_API_KEY` → DeepSeek, then `OPENAI_API_KEY` → OpenAI.
 */
export function resolveLlmEndpoint(env: Record<string, string | undefined>): ResolvedLlmEndpoint {
  const customBase = env.ACCREMIND_LLM_BASE_URL?.trim();
  const customModel = env.ACCREMIND_LLM_MODEL?.trim();
  if (env.ACCREMIND_LLM_API_KEY) {
    const baseUrl = customBase || DEEPSEEK_BASE_URL;
    return { baseUrl, apiKey: env.ACCREMIND_LLM_API_KEY, model: customModel || defaultModelFor(baseUrl), keySource: 'ACCREMIND_LLM_API_KEY', configured: true };
  }
  if (customBase) {
    const host = hostOf(customBase);
    if (host.endsWith('deepseek.com') && env.DEEPSEEK_API_KEY) {
      return { baseUrl: customBase, apiKey: env.DEEPSEEK_API_KEY, model: customModel || 'deepseek-chat', keySource: 'DEEPSEEK_API_KEY', configured: true };
    }
    if (host.endsWith('openai.com') && env.OPENAI_API_KEY) {
      return { baseUrl: customBase, apiKey: env.OPENAI_API_KEY, model: customModel || 'gpt-4o-mini', keySource: 'OPENAI_API_KEY', configured: true };
    }
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return { baseUrl: customBase, apiKey: '', model: customModel || defaultModelFor(customBase), keySource: 'none', configured: local };
  }
  if (env.DEEPSEEK_API_KEY) {
    return { baseUrl: DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY, model: customModel || 'deepseek-chat', keySource: 'DEEPSEEK_API_KEY', configured: true };
  }
  if (env.OPENAI_API_KEY) {
    return { baseUrl: OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY, model: customModel || 'gpt-4o-mini', keySource: 'OPENAI_API_KEY', configured: true };
  }
  return { baseUrl: DEEPSEEK_BASE_URL, apiKey: '', model: customModel || 'deepseek-chat', keySource: 'none', configured: false };
}

function defaultModelFor(baseUrl: string): string {
  return hostOf(baseUrl).endsWith('openai.com') ? 'gpt-4o-mini' : 'deepseek-chat';
}

/** Errors that a retry cannot fix (bad key, bad request): fail fast instead of spending tokens. */
export class NonRetryableLlmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'NonRetryableLlmError';
    this.status = status;
  }
}

export interface LlmCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}

export interface LlmCompletionResponse {
  content: string;
  tokenUsed: number;
}

/**
 * Host-agnostic LLM inference adapter seam:
 * Can be backed by DSH's native model service OR direct OpenAI/DeepSeek/Ollama HTTP endpoints.
 */
export interface LlmInferenceAdapter {
  completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export interface OpenAiCompatibleClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Extracts valid JSON object text even when a model wraps output in ```json ... ``` fences.
 */
export function extractJsonObjectText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAiCompatibleLlmClient implements LlmInferenceAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleClientOptions = {}) {
    const resolved = resolveLlmEndpoint(process.env);
    this.baseUrl = (options.baseUrl ?? resolved.baseUrl).replace(/\/+$/, '');
    // An explicit key always wins; otherwise only the key that belongs to the resolved endpoint is used.
    this.apiKey = options.apiKey ?? (options.baseUrl && options.baseUrl !== resolved.baseUrl ? '' : resolved.apiKey);
    this.model = options.model ?? resolved.model;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async completeJson(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (!this.apiKey && !this.baseUrl.includes('127.0.0.1') && !this.baseUrl.includes('localhost')) {
      throw new Error(
        '未配置模型 API Key（请设置 DEEPSEEK_API_KEY / ACCREMIND_LLM_API_KEY 或注入 DSH 宿主模型适配器）',
      );
    }

    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (this.apiKey) {
          headers.authorization = `Bearer ${this.apiKey}`;
        }

        const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.model,
            temperature: req.temperature ?? 0.1,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: req.systemPrompt },
              { role: 'user', content: req.userPrompt },
            ],
          }),
        });

        clearTimeout(timer);

        if (resp.status === 429 || resp.status >= 500) {
          throw new Error(`LLM 服务暂时不可用 (HTTP ${resp.status})`);
        }
        if (!resp.ok) {
          const errText = await resp.text();
          throw new NonRetryableLlmError(`LLM 调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`, resp.status);
        }

        const json = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };

        const rawContent = json.choices?.[0]?.message?.content ?? '';
        const tokenUsed = Number(json.usage?.total_tokens ?? 0);

        return {
          content: extractJsonObjectText(rawContent),
          tokenUsed,
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        if (err instanceof NonRetryableLlmError) break;
        if (attempt < this.maxRetries) {
          const jitterMs = Math.floor(Math.random() * 250);
          const backoffMs = Math.min(4000, 400 * 2 ** attempt) + jitterMs;
          await sleep(backoffMs);
          continue;
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
