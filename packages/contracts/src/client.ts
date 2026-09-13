import { assertSchema, compileSchema, operationManifest } from './index.js';
import type { operations } from './generated/api.js';
type JsonBody<T> = T extends { content: { 'application/json': infer V } } ? V : never;
type RequestBody<N extends keyof operations> = operations[N] extends { requestBody: infer B }
  ? JsonBody<B>
  : never;
type Success<N extends keyof operations> = {
  [K in keyof operations[N]['responses']]: K extends 200 | 201 | 202
    ? JsonBody<operations[N]['responses'][K]>
    : never;
}[keyof operations[N]['responses']];
type Data<N extends keyof operations> = Success<N> extends { data: infer D } ? D : never;
export interface RequestOptions<N extends keyof operations> {
  body?: RequestBody<N>;
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}
export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  getCsrfToken?: () => string | undefined;
}
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    readonly requestId: string | undefined,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'ApiClientError';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function createApiClient(options: ClientOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async request<N extends keyof operations>(
      name: N,
      request: RequestOptions<N> = {},
    ): Promise<Data<N>> {
      const operation = operationManifest[name];
      let path = operation.path;
      const query = new URLSearchParams();
      for (const kind of ['path', 'query'] as const) {
        const supplied = request[kind] ?? {};
        const allowed = operation.parameters.filter((p) => p.in === kind);
        if (Object.keys(supplied).some((key) => !allowed.some((p) => p.name === key)))
          throw new ApiClientError('INVALID_INPUT', undefined);
        for (const parameter of allowed) {
          const value = supplied[parameter.name];
          if (value === undefined && !parameter.required) continue;
          if (!compileSchema(parameter.schema)(value))
            throw new ApiClientError('INVALID_INPUT', undefined);
          if (kind === 'path')
            path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
          else query.set(parameter.name, String(value));
        }
      }
      if (operation.requestSchema) assertSchema(operation.requestSchema, request.body);
      else if (request.body !== undefined) throw new ApiClientError('INVALID_INPUT', undefined);
      const headers: Record<string, string> = { 'X-Request-ID': crypto.randomUUID() };
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = options.getCsrfToken?.();
      if (csrf && !['GET', 'HEAD'].includes(operation.method)) headers['X-CSRF-Token'] = csrf;
      let response: Response;
      try {
        response = await fetcher(
          `${options.baseUrl.replace(/\/$/, '')}${path}${query.size ? `?${query}` : ''}`,
          {
            method: operation.method,
            headers,
            credentials: 'same-origin',
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );
      } catch {
        throw new ApiClientError(
          request.signal?.aborted ? 'CANCELLED' : 'TEMPORARILY_UNAVAILABLE',
          undefined,
          !request.signal?.aborted,
        );
      }
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new ApiClientError('PROTOCOL_MISMATCH', undefined);
      }
      if (!response.ok) {
        assertSchema('Error', result);
        throw new ApiClientError(result.error.code, result.request_id, result.error.retryable);
      }
      if (!record(result) || Object.keys(result).sort().join(',') !== 'data,request_id')
        throw new ApiClientError('PROTOCOL_MISMATCH', undefined);
      assertSchema('Id', result.request_id);
      assertSchema(operation.responseSchema, result.data);
      return result.data as Data<N>;
    },
  };
}
