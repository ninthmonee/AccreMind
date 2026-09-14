import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { createApiClient, contractVersion, dispositions } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';
import { ConfigPreview } from './ConfigPreview.js';
import { KnowledgeList, KnowledgeDetail, KnowledgeSearch } from './KnowledgePages.js';
const api = createApiClient({ baseUrl: '/api/v1' });
function Workspace({ principal, page }: { principal: SchemaTypes['Me']; page: string }) {
  const scoped = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [principal.tenant_id, principal.principal_id, principal.authz_version],
  );
  useEffect(
    () => () => {
      void scoped.cancelQueries();
      scoped.clear();
    },
    [scoped],
  );
  return (
    <QueryClientProvider client={scoped}>
      <main>
        {page === 'knowledge' || page === 'search' || page.startsWith('knowledge/') ? (
          !principal.capabilities.includes('knowledge:read') ? (
            <div role="alert">
              <h1>当前没有知识读取权限</h1>
              <p>请检查身份和授权配置。</p>
            </div>
          ) : page === 'knowledge' ? (
            <KnowledgeList />
          ) : page === 'search' ? (
            <KnowledgeSearch principal={principal} />
          ) : (
            <KnowledgeDetail id={page.slice('knowledge/'.length)} />
          )
        ) : (
          <>
            <div className="eyebrow">DEVELOPMENT BASELINE / 契约 {contractVersion}</div>
            <h1>把经验变成可靠的上下文。</h1>
            <p className="lead">优先保存代码之外的必要信息，而不是重复描述代码。</p>
            <div className="notice">
              <strong>
                {principal.capabilities.includes('knowledge:contribute')
                  ? '合成贡献开发模式'
                  : '合成开发模式'}
              </strong>
              <span>
                {principal.capabilities.includes('knowledge:contribute')
                  ? '已启用合成贡献、人工判定、审核发布、授权检索、独立验证与配置接口。业务管理表单尚未实现，不代表真实团队登录成功。'
                  : '当前身份没有内容权限。业务表单、检索和验证尚未实现，不代表真实团队登录成功。'}
              </span>
            </div>
            <section className="grid" aria-label="工程状态">
              <article>
                <span className="label">工程基础</span>
                <h2>三端，一份契约</h2>
                <p>Web、API / Worker 和 MCP 工具端共享生成类型与严格校验。</p>
                <small>
                  身份版本 {principal.authz_version} · 授权能力 {principal.capabilities.length}
                </small>
              </article>
              <article>
                <span className="label">下一条纵向切片</span>
                <h2>从证据到复用</h2>
                <p>人工导入 → 增量判定 → 独立审核 → 发布 → 授权检索 → 撤回</p>
                <small>
                  {principal.capabilities.includes('knowledge:contribute')
                    ? '合成独立验证与配置版本已实现 · 下一步为完整治理流程'
                    : '尚未开启合成贡献接收'}
                </small>
              </article>
            </section>
          </>
        )}
        {page === 'overview' && principal.capabilities.includes('config:read') && <ConfigPreview />}
        {page === 'overview' && (
          <section className="routes">
            <h2>五路分流</h2>
            <div className="chips">
              {dispositions.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
            <p>零条新增经验可以是正确结果。引用不等于验证，优先级不等于可信度。</p>
          </section>
        )}
      </main>
    </QueryClientProvider>
  );
}
export function App() {
  const [page, setPage] = useState(() => window.location.hash.slice(1) || 'overview');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    const change = () => setPage(window.location.hash.slice(1) || 'overview');
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const identity = useQuery({
    queryKey: ['bootstrap', 'me'],
    queryFn: ({ signal }) => api.request('getMe', { signal }),
    retry: false,
  });
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/">
          Accre<span>Mind</span>
          <small>研发知识基座</small>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="工作台导航">
          <a href="#overview" aria-current={page === 'overview' ? 'page' : undefined}>
            工程概览
          </a>
          <a href="#knowledge" aria-current={page.startsWith('knowledge') ? 'page' : undefined}>
            知识浏览
          </a>
          <a href="#search" aria-current={page === 'search' ? 'page' : undefined}>
            知识检索
          </a>
          {['贡献记录', '增量审核', '验证与纠错', '配置与治理'].map((name) => (
            <button key={name} disabled>
              {name}
              <span>待实现</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          证据优先 · 人工审核
          <br />
          授权隔离 · 可纠错
        </div>
      </aside>
      {identity.isPending ? (
        <main role="status">
          <h1>正在连接知识服务…</h1>
        </main>
      ) : identity.isError ? (
        <main role="alert">
          <div className="eyebrow">SERVICE UNAVAILABLE</div>
          <h1>无法获取身份上下文</h1>
          <p>这表示服务或协议异常，不表示“没有知识”或已退出登录。</p>
          <button
            onClick={() => {
              void identity.refetch();
            }}
          >
            重新连接
          </button>
        </main>
      ) : (
        <Workspace
          key={`${identity.data.tenant_id}:${identity.data.principal_id}:${identity.data.authz_version}`}
          principal={identity.data}
          page={page}
        />
      )}
    </div>
  );
}
