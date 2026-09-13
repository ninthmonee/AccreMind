import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { compileSchema, mcpTools } from '@accremind/contracts';
import type { ErrorEnvelope } from '@accremind/contracts';
import { randomUUID } from 'node:crypto';
export async function startBridge() {
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
