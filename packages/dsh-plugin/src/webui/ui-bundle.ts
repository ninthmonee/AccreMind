import { ACCREMIND_APP_HTML } from './app-html.ts';

/**
 * AccreMind 经验工作台：一个自包含页面（无外部资源），只通过 RPC 与插件通信。
 * 页面源码在 packages/webui（React + shadcn/ui），由 `pnpm build:webui` 构建并内联到 app-html.ts。
 * 独立预览（pnpm ui）与 DSH 内嵌（sandbox iframe）共用同一份产物，只有标题不同。
 */
export function renderAccreMindWebuiHtml(options: { embedded?: boolean } = {}): string {
  const productTitle = options.embedded ? 'DSH 经验工作台' : '工程经验工作台';
  return ACCREMIND_APP_HTML.replace(/<title>[^<]*<\/title>/, () => `<title>${productTitle} · AccreMind</title>`);
}
