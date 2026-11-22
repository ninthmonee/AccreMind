/**
 * 工作台与插件之间唯一的通信通道。
 * - 在 DSH 内：页面运行在 sandbox iframe，由宿主注入 window.__DSH_ACCREMIND_RPC__ 转发；
 * - 独立预览（pnpm ui）：POST /rpc，并携带页面 <meta name="accremind-token"> 中的一次性令牌；
 * - 演示空间：所有调用包进 accremind.demo.call，作用于临时项目，不触碰真实工作区。
 */
type Bridge = (method: string, params: Record<string, unknown>) => Promise<unknown>;

declare global {
  interface Window {
    __DSH_ACCREMIND_RPC__?: Bridge;
  }
}

let demoToken: string | null = null;
let activeCalls = 0;

async function hostRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (window.__DSH_ACCREMIND_RPC__) return (await window.__DSH_ACCREMIND_RPC__(method, params)) as T;
  const token = document.querySelector('meta[name="accremind-token"]')?.getAttribute('content') ?? '';
  const resp = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-accremind-token': token },
    body: JSON.stringify({ method, params }),
  });
  let json: { result?: T; error?: string };
  try {
    json = (await resp.json()) as { result?: T; error?: string };
  } catch {
    throw new Error(`工作台服务无响应（HTTP ${resp.status}）`);
  }
  if (!resp.ok || json.error) throw new Error(json.error || `RPC HTTP ${resp.status}`);
  return json.result as T;
}

/** 调用 accremind.* RPC；处于演示空间时自动转发到临时项目。失败时抛出带中文说明的 Error。 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  activeCalls++;
  try {
    if (demoToken) return await hostRpc<T>('accremind.demo.call', { token: demoToken, method, params });
    return await hostRpc<T>(method, params);
  } finally {
    activeCalls--;
  }
}

export const isRpcBusy = () => activeCalls > 0;
export const isDemo = () => demoToken !== null;

/** 打开独立演示空间（服务端创建临时项目并写入示例经验）。 */
export async function openDemo(): Promise<void> {
  const session = await hostRpc<{ token: string }>('accremind.demo.open', {});
  demoToken = session.token;
}

/** 关闭演示空间并回到真实工作区；关闭失败不影响切换。 */
export async function closeDemo(): Promise<void> {
  const token = demoToken;
  demoToken = null;
  if (token) await hostRpc('accremind.demo.close', { token }).catch(() => undefined);
}
