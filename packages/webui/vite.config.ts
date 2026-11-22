import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type UserConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 开发模式下把 /rpc 代理到 `pnpm ui` 启动的本地工作台（默认 3180）。
 * 工作台每次启动都会生成一次性令牌，这里从它的首页读取后注入请求头，并去掉浏览器的 Origin，
 * 以通过 local-server 的同源与令牌校验。
 */
const backend = process.env.ACCREMIND_BACKEND ?? 'http://127.0.0.1:3180';

async function readBackendToken(): Promise<string> {
  try {
    const page = await (await fetch(backend + '/')).text();
    return /name="accremind-token" content="([^"]+)"/.exec(page)?.[1] ?? '';
  } catch {
    return '';
  }
}

export default defineConfig(async ({ command }) => {
  const token = command === 'serve' ? await readBackendToken() : '';
  if (command === 'serve' && !token) {
    console.warn(`[webui] 未连上 ${backend}，请先在仓库根目录运行 pnpm ui`);
  }
  const config: UserConfig = {
    plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true })],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    build: {
      target: 'es2022',
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      chunkSizeWarningLimit: 4096,
      reportCompressedSize: false,
      modulePreload: false,
    },
    server: {
      proxy: {
        '/rpc': {
          target: backend,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (req) => {
              req.removeHeader('origin');
              req.setHeader('x-accremind-token', token);
            });
          },
        },
      },
    },
  };
  return config;
});
