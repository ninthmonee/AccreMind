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
    this.baseUrl = (
      options.baseUrl ??
      process.env.ACCREMIND_LLM_BASE_URL ??
      'https://api.deepseek.com/v1'
    ).replace(/\/+$/, '');
    this.apiKey =
      options.apiKey ??
      process.env.ACCREMIND_LLM_API_KEY ??
      process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      '';
    this.model = options.model ?? process.env.ACCREMIND_LLM_MODEL ?? 'deepseek-chat';
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
          throw new Error(`LLM 调用失败 (HTTP ${resp.status}): ${errText.slice(0, 200)}`);
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
