import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createApiClient, ApiClientError } from '@accremind/contracts';

const api = createApiClient({ baseUrl: '/api/v1' });
const outcomes = {
  updated: '已获取有效配置',
  unchanged: '配置未变更',
  incompatible: '宿主版本不兼容，请先升级',
  revoked: '配置已撤销，请停止使用',
};
export function ConfigPreview() {
  const [repo, setRepo] = useState('00000000-0000-4000-8000-000000000004');
  const [version, setVersion] = useState('2.10.0');
  const [request, setRequest] = useState<
    { repo: string; version: string; nonce: number } | undefined
  >();
  const config = useQuery({
    queryKey: ['config-preview', request],
    enabled: !!request,
    queryFn: ({ signal }) =>
      api.request('getConfig', {
        query: { repo_id: request!.repo, client_version: request!.version },
        signal,
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <section className="routes config-preview" aria-labelledby="config-heading">
      <h2 id="config-heading">组织配置读取演练</h2>
      <p>从当前授权仓库读取实际配置。宿主版本为演练输入，不代表已检测或安装 Claude Code。</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setRequest({
            repo: repo.trim(),
            version: version.trim(),
            nonce: (request?.nonce ?? 0) + 1,
          });
        }}
      >
        <label>
          仓库 ID
          <input
            required
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            maxLength={36}
          />
        </label>
        <label>
          宿主版本
          <input
            required
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            maxLength={64}
          />
        </label>
        <button type="submit" disabled={config.isFetching}>
          {config.isFetching ? '正在读取…' : '读取配置'}
        </button>
      </form>
      {config.isError && (
        <p role="alert">
          {config.error instanceof ApiClientError && config.error.code === 'RATE_LIMITED'
            ? '配置读取次数已达上限，请稍后重试。'
            : '配置读取失败，请检查权限、仓库 ID 和已发布配置。'}
        </p>
      )}
      {config.data && (
        <div aria-live="polite">
          <p>
            <strong>{outcomes[config.data.outcome]}</strong> · 版本 {config.data.revision} ·{' '}
            {config.data.status}
          </p>
          <p>
            最低宿主版本 {config.data.body.min_host_version} · 单次条数上限{' '}
            {config.data.body.query_limit} · 正文预算 {config.data.body.token_limit}
          </p>
          {config.data.status === 'active' && config.data.outcome !== 'incompatible' && (
            <>
              <h3>受控入口说明</h3>
              <pre>{config.data.body.gateway_text}</pre>
              <h3>强制规则（{config.data.body.mandatory_rules.length}）</h3>
              {config.data.body.mandatory_rules.length === 0 ? (
                <p>当前配置没有强制规则。</p>
              ) : (
                config.data.body.mandatory_rules.map((rule) => (
                  <details key={rule.knowledge_id}>
                    <summary>
                      知识 {rule.knowledge_id} · 版本 {rule.revision}
                    </summary>
                    <pre>{rule.text}</pre>
                  </details>
                ))
              )}
            </>
          )}
          <small>这里只读取配置，未写入本地宿主文件。</small>
        </div>
      )}
    </section>
  );
}
