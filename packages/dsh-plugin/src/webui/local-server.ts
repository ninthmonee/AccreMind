import * as http from 'node:http';
import type { AccreMindPluginInstance } from '../index.ts';
import { renderAccreMindWebuiHtml } from './ui-bundle.ts';

export interface LocalWebuiServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Loopback-only (`127.0.0.1`) HTTP JSON-RPC server hosting the 4 AccreMind WebUI views
 * for standalone local inspection (`pnpm ui`) or headless integration testing.
 */
export function startAccreMindWebuiServer(
  runtime: AccreMindPluginInstance,
  options: { host?: string; port?: number } = {},
): Promise<LocalWebuiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 3180;
  const html = renderAccreMindWebuiHtml({ embedded: false });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/rpc') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          method?: string;
          params?: Record<string, unknown>;
        };
        const method = body.method ?? '';
        const params = body.params ?? {};

        if (method.startsWith('__tool.')) {
          const toolName = method.slice('__tool.'.length);
          const tool = runtime.tools.find((t) => t.name === toolName);
          if (!tool) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `未注册工具: ${toolName}` }));
            return;
          }
          const toolOut = await tool.execute(params, { sessionId: 'webui-manual' });
          if (toolOut.isError) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: toolOut.content[0]?.text ?? '工具执行失败' }));
            return;
          }
          const parsed = JSON.parse(toolOut.content[0]?.text ?? '{}') as unknown;
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ result: parsed }));
          return;
        }

        const handler = runtime.rpcHandlers[method];
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `未知 RPC 方法: ${method}` }));
          return;
        }

        const result = await handler(params);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ result }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
      resolve({
        url: `http://${host}:${actualPort}`,
        port: actualPort,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}
