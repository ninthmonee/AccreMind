#!/usr/bin/env node
import { startBridge } from './bridge.js';
import { ClaudeCodeAdapter } from './host-adapter.js';
import { contractVersion, mcpTools } from '@accremind/contracts';
import { createShutdown } from '@accremind/domain';
const [command, action, ...rest] = process.argv.slice(2);
if (command === 'mcp' && action === 'serve' && rest.length === 0) {
  const server = await startBridge();
  const shutdown = createShutdown(() => server.close());
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void shutdown().catch(() => {
        console.error('Engineering bridge shutdown failed');
        process.exitCode = 1;
      });
    });
} else if (
  command === 'doctor' &&
  (action === '--json' || action === undefined) &&
  rest.length === 0
) {
  const endpointValue = process.env.AKB_ENDPOINT ?? 'http://127.0.0.1:3100';
  if (!URL.canParse(endpointValue)) {
    console.error('Engineering doctor endpoint is invalid');
    process.exit(2);
  }
  const endpoint = new URL(endpointValue);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    console.error('Engineering doctor only supports credential-free loopback endpoints');
    process.exitCode = 2;
  } else {
    let health: 'reachable' | 'unavailable' = 'unavailable';
    try {
      const response = await fetch(new URL('/healthz', endpoint), {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) health = 'reachable';
    } catch {
      /* An unavailable service is not an empty knowledge result. */
    }
    const report = {
      stage: 'engineering-scaffold',
      contractVersion,
      backend: health,
      host: new ClaudeCodeAdapter().detect(),
      tools: mcpTools.length,
      login: 'not_implemented',
      configChanges: false,
    };
    console.log(JSON.stringify(report, null, action === '--json' ? undefined : 2));
    if (health !== 'reachable') process.exitCode = 1;
  }
} else if (command === '--version' && action === undefined) {
  console.log('akb 0.1.0 (engineering-scaffold)');
} else {
  console.error('Usage: akb doctor [--json] | akb mcp serve | akb --version');
  process.exitCode = command ? 2 : 0;
}
