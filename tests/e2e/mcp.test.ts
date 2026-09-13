import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertSchema } from '@accremind/contracts';
const cli = fileURLToPath(new URL('../../apps/tool/dist/cli.js', import.meta.url));
test(
  'real MCP stdio initialize/list/call uses shared 8 tools and fails closed',
  { timeout: 15000 },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', 'serve'],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stage-b-contract-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const result = await client.listTools();
      assert.equal(result.tools.length, 8);
      assert.equal(new Set(result.tools.map((tool) => tool.name)).size, 8);
      const invalid = await client.callTool({
        name: 'get-contribution',
        arguments: { id: 'not-a-uuid', actor_id: 'forged' },
      });
      assert.equal(invalid.isError, true);
      const invalidContent = invalid.content as { type: string; text: string }[];
      const invalidError: unknown = JSON.parse(invalidContent[0]!.text);
      assertSchema('Error', invalidError);
      assert.equal(invalidError.error.code, 'INVALID_INPUT');
      const blocked = await client.callTool({
        name: 'get-contribution',
        arguments: { id: '00000000-0000-4000-8000-000000000001' },
      });
      assert.equal(blocked.isError, true);
      assert.equal(blocked.structuredContent, undefined);
      const blockedContent = blocked.content as { type: string; text: string }[];
      assert.equal(blockedContent[0]!.type, 'text');
      const blockedError: unknown = JSON.parse(blockedContent[0]!.text);
      assertSchema('Error', blockedError);
      assert.equal(blockedError.error.code, 'UNAUTHENTICATED');
    } finally {
      await client.close();
    }
  },
);
