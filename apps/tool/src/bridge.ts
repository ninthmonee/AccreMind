import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  assertSchema,
  ApiClientError,
  createApiClient,
  compileSchema,
  mcpTools,
} from '@accremind/contracts';
import type { ErrorEnvelope, SchemaTypes } from '@accremind/contracts';
import { randomUUID } from 'node:crypto';
export async function startBridge() {
  const flag = process.env.AKB_SYNTHETIC_TOOLS;
  if (flag && !['0', '1'].includes(flag)) throw new Error('Invalid synthetic tool opt-in');
  let api: ReturnType<typeof createApiClient> | undefined;
  if (flag === '1') {
    const value = process.env.AKB_ENDPOINT ?? 'http://127.0.0.1:3100';
    if (!URL.canParse(value)) throw new Error('Invalid tool endpoint');
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Synthetic tools require a credential-free loopback endpoint');
    api = createApiClient({
      baseUrl: new URL('/api/v1', url).href,
      fetch: (url, options) => fetch(url, { ...options, redirect: 'error' }),
    });
  }
  const server = new Server(
    { name: 'accremind', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      outputSchema: tool.outputSchema as Tool['outputSchema'],
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = mcpTools.find((item) => item.name === request.params.name);
    const valid = tool && compileSchema(tool.inputSchema)(request.params.arguments);
    if (valid && api) {
      try {
        const input = request.params.arguments;
        const signal = AbortSignal.timeout(15000);
        const data =
          tool.name === 'search-knowledge'
            ? await api.request('searchKnowledge', {
                body: input as SchemaTypes['SearchRequest'],
                signal,
              })
            : tool.name === 'get-knowledge'
              ? await api.request('readKnowledge', {
                  body: input as SchemaTypes['ReadRequest'],
                  signal,
                })
              : tool.name === 'get-contribution'
                ? await api.request('getContribution', {
                    path: { id: (input as { id: string }).id },
                    signal,
                  })
                : tool.name === 'record-usage'
                  ? await api.request('recordUsage', {
                      body: input as SchemaTypes['UsageRequest'],
                      signal,
                    })
                  : tool.name === 'submit-validation'
                    ? await api.request('submitValidation', {
                        body: input as SchemaTypes['ValidationRequest'],
                        signal,
                      })
                    : tool.name === 'submit-feedback'
                      ? await api.request('submitFeedback', {
                          body: input as SchemaTypes['FeedbackRequest'],
                          signal,
                        })
                      : tool.name === 'get-config'
                        ? await api.request('getConfig', {
                            query: input as {
                              repo_id: string;
                              client_version: string;
                              current_config_version?: number;
                            },
                            signal,
                          })
                        : undefined;
        if (data !== undefined) {
          if (!compileSchema(tool.outputSchema)(data))
            throw new Error('Tool response contract mismatch');
          return {
            structuredContent: data,
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          };
        }
        const error: ErrorEnvelope = {
          request_id: randomUUID(),
          error: {
            code: 'TEMPORARILY_UNAVAILABLE',
            message: 'CAPABILITY_NOT_READY: this tool is not implemented',
            retryable: false,
            details: [],
          },
        };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      } catch (error) {
        const code =
          error instanceof ApiClientError &&
          [
            'UNAUTHENTICATED',
            'FORBIDDEN',
            'NOT_FOUND_OR_INACCESSIBLE',
            'INVALID_INPUT',
            'REVISION_CONFLICT',
            'RATE_LIMITED',
            'TEMPORARILY_UNAVAILABLE',
            'PUBLICATION_BLOCKED',
            'PAYLOAD_TOO_LARGE',
            'IDEMPOTENCY_CONFLICT',
          ].includes(error.code)
            ? (error.code as ErrorEnvelope['error']['code'])
            : 'TEMPORARILY_UNAVAILABLE';
        const envelope: ErrorEnvelope = {
          request_id: randomUUID(),
          error: {
            code,
            message: 'Tool request could not be completed',
            retryable: code === 'TEMPORARILY_UNAVAILABLE',
            details: [],
          },
        };
        assertSchema('Error', envelope);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
        };
      }
    }
    const error: ErrorEnvelope = {
      request_id: randomUUID(),
      error: {
        code: valid ? 'UNAUTHENTICATED' : 'INVALID_INPUT',
        message: valid
          ? 'Engineering scaffold: authentication and business tools are not implemented'
          : 'Tool input does not match the shared contract',
        retryable: false,
        details: [],
      },
    };
    return {
      isError: true,
      // outputSchema describes success data; errors travel as a validated text envelope.
      content: [{ type: 'text' as const, text: JSON.stringify(error) }],
    };
  });
  await server.connect(new StdioServerTransport());
  return server;
}
