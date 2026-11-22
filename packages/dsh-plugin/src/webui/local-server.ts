import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AccreMindPluginInstance } from '../index.ts';
import { renderAccreMindWebuiHtml } from './ui-bundle.ts';

export interface LocalWebuiServerHandle {
  readonly url: string;
  readonly port: number;
  /** Per-launch secret the page sends with every RPC; other local pages and sites never see it. */
  readonly token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Only the page this server rendered may call it:
 * - `Host` must be a loopback name on our port (blocks DNS rebinding);
 * - a present `Origin` must be our own origin (blocks cross-site requests);
 * - every RPC carries the launch token in a custom header (forces a CORS preflight we never approve).
 */
function assertTrustedRequest(req: http.IncomingMessage, port: number, token: string, requireToken: boolean): void {
  const host = (req.headers.host ?? '').toLowerCase();
  const sep = host.lastIndexOf(':');
  const hostname = sep > 0 ? host.slice(0, sep) : host;
  const hostPort = sep > 0 ? host.slice(sep + 1) : '';
  if (!LOOPBACK_HOSTS.has(hostname) || hostPort !== String(port)) {
    throw new HttpError(403, '拒绝访问：请求的主机名不是本机工作台地址');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${hostname}:${port}`) {
    throw new HttpError(403, '拒绝访问：跨站请求');
  }
  if (requireToken) {
    const sent = req.headers['x-accremind-token'];
    if (typeof sent !== 'string' || !sameSecret(sent, token)) {
      throw new HttpError(401, '工作台会话已失效，请刷新页面');
    }
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(415, '仅接受 JSON 请求');
    }
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ method?: unknown; params?: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求内容过大');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; params?: unknown };
  } catch {
    throw new HttpError(400, '请求格式错误');
  }
}

/**
 * Loopback-only (`127.0.0.1`) HTTP JSON-RPC server hosting the AccreMind workbench
 * for standalone local inspection (`pnpm ui`) or headless integration testing.
 */
export function startAccreMindWebuiServer(
  runtime: AccreMindPluginInstance,
  options: { host?: string; port?: number; token?: string } = {},
): Promise<LocalWebuiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 3180;
  const token = options.token ?? randomBytes(24).toString('base64url');
  const html = renderAccreMindWebuiHtml({ embedded: false }).replace(
    '<head>',
    `<head>\n<meta name="accremind-token" content="${token}" />`,
  );
  let boundPort = requestedPort;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        assertTrustedRequest(req, boundPort, token, false);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(html);
        return;
      }

      if (req.method === 'POST' && req.url === '/rpc') {
        assertTrustedRequest(req, boundPort, token, true);
        const body = await readJsonBody(req);
        const method = typeof body.method === 'string' ? body.method : '';
        const params =
          body.params && typeof body.params === 'object' && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : {};

        if (method.startsWith('__tool.')) {
          const toolName = method.slice('__tool.'.length);
          const tool = runtime.tools.find((t) => t.name === toolName);
          if (!tool) return send(res, 404, { error: `未注册工具: ${toolName}` });
          const toolOut = await tool.execute(params, { sessionId: 'webui-manual' });
          if (toolOut.isError) return send(res, 400, { error: toolOut.content[0]?.text ?? '工具执行失败' });
          return send(res, 200, { result: JSON.parse(toolOut.content[0]?.text ?? '{}') as unknown });
        }

        if (!Object.hasOwn(runtime.rpcHandlers, method)) {
          return send(res, 404, { error: `未知 RPC 方法: ${method}` });
        }
        const result = await runtime.rpcHandlers[method]!(params);
        return send(res, 200, { result });
      }

      send(res, 404, { error: 'Not Found' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
      resolve({
        url: `http://${host}:${boundPort}`,
        port: boundPort,
        token,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}
