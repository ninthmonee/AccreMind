import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { createApiClient, ApiClientError } from '@accremind/contracts';
import type { SchemaTypes } from '@accremind/contracts';

const api = createApiClient({ baseUrl: '/api/v1' });
const labels: Record<string, string> = {
  draft: '待验证',
  verified: '已验证',
  proven: '多次独立验证',
  current: '有效',
  unknown: '时效待确认',
  stale: '已过时',
  repo: '仓库范围',
  domain: '领域范围',
  global: '全局范围',
  review_due: '待复核',
  published: '已发布',
  enabled: '可使用',
  experience: '经验',
  authoritative_mirror: '权威镜像',
  decision: '决策',
  guideline: '指南',
  pitfall: '避坑',
  process: '流程',
  model: '模型',
  suspended: '已暂停',
  withdrawn: '已撤回',
  archived: '已归档',
};
function ErrorNotice({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="notice">
      <div>
        <strong>
          {error instanceof ApiClientError &&
          ['FORBIDDEN', 'NOT_FOUND_OR_INACCESSIBLE', 'UNAUTHENTICATED'].includes(error.code)
            ? '内容不存在或当前无权访问'
            : '请求未完成'}
        </strong>
        <p>
          {error instanceof ApiClientError && error.code === 'RATE_LIMITED'
            ? '读取配额已耗尽，请稍后再试。'
            : '无法读取不等于没有知识。请检查服务、权限和输入。'}
        </p>
        <button onClick={retry}>重试</button>
      </div>
    </div>
  );
}
function Tags({ values }: { values: string[] }) {
  return (
    <div className="chips">
      {values.map((v) => (
        <span className="badge" key={v}>
          {labels[v] ?? v}
        </span>
      ))}
    </div>
  );
}
function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : (
        <p>暂无条目。</p>
      )}
    </section>
  );
}
function Conditions({ context }: { context: SchemaTypes['Context'] }) {
  return (
    <>
      <TextList title="适用前提" items={context.preconditions} />
      <TextList title="不适用范围 / 例外" items={context.exclusions} />
      <TextList
        title="依赖版本"
        items={context.dependency_constraints.map((c) => `${c.name}：${c.version_range}`)}
      />
      <h3>验证方法</h3>
      <p>{context.verification_method}</p>
    </>
  );
}
function Sources({ refs }: { refs: SchemaTypes['EvidenceRef'][] }) {
  return (
    <section>
      <h3>证据引用（{refs.length}）</h3>
      <ul className="source-list">
        {refs.map((r, i) => (
          <li key={i}>
            <code>{r.id}</code> · 版本 {r.revision}
            <br />
            {r.locator}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function DetailBody({ item }: { item: SchemaTypes['KnowledgeDetail'] }) {
  return (
    <article className="knowledge-card">
      <Tags
        values={[
          item.body.knowledge_role,
          item.maturity,
          item.freshness,
          item.publication_status,
          item.serving_status,
        ]}
      />
      {item.usage_mode !== 'current_guidance' && (
        <div role="status" className="notice">
          这是历史或停止服务的内容，不能当作当前建议。
        </div>
      )}
      <h2>{item.body.title}</h2>
      <p className="claim">{item.body.claim}</p>
      <p className="metadata">
        正文版本 {item.content_revision} · {labels[item.body.scope.kind]} · 创建于{' '}
        {new Date(item.created_at).toLocaleDateString('zh-CN')}
      </p>
      <Conditions context={item.body.context} />
      <h3>原因与依据</h3>
      <p>{item.body.rationale.text}</p>
      <TextList title="失效触发条件" items={item.body.invalidation_triggers} />
      {item.body.alternatives.length > 0 && (
        <section>
          <h3>备选方案</h3>
          {item.body.alternatives.map((a, i) => (
            <p key={i}>
              <strong>{a.option}</strong>：{a.rejection_reason.text}
            </p>
          ))}
        </section>
      )}
      <TextList title="知识增量" items={item.knowledge_delta.map((d) => d.text)} />
      <Sources refs={item.source_refs} />
    </article>
  );
}
export function KnowledgeList() {
  const [cursor, setCursor] = useState('');
  const [previous, setPrevious] = useState<string[]>([]);
  const list = useQuery({
    queryKey: ['knowledge-list', cursor],
    queryFn: ({ signal }) =>
      api.request('listKnowledge', { query: { limit: 10, ...(cursor ? { cursor } : {}) }, signal }),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  return (
    <>
      <div className="eyebrow">KNOWLEDGE</div>
      <h1>知识浏览</h1>
      <p className="lead">查看当前已发布、可使用且你有权访问的知识。</p>
      <a className="action-link" href="#search">
        去检索知识 →
      </a>
      {list.isPending || list.isFetching ? (
        <p role="status">正在读取知识列表…</p>
      ) : list.isError ? (
        <ErrorNotice
          error={list.error}
          retry={() => {
            setCursor('');
            setPrevious([]);
            if (!cursor) void list.refetch();
          }}
        />
      ) : (
        <>
          <p className="metadata">本页 {list.data.items.length} 条</p>
          {list.data.items.length === 0 ? (
            <section className="knowledge-card">
              <h2>暂无可浏览的知识</h2>
              <p>当前授权范围没有可用条目。贡献须经过独立审核发布后才会出现。</p>
            </section>
          ) : (
            list.data.items.map((k) => (
              <article className="knowledge-card" key={k.id}>
                <Tags values={[k.type, k.knowledge_role, k.maturity, k.freshness]} />
                <h2>
                  <a href={`#knowledge/${k.id}`}>{k.title}</a>
                </h2>
                <p className="metadata">
                  正文版本 {k.content_revision} · {labels[k.scope.kind]}
                </p>
                <a className="action-link" href={`#knowledge/${k.id}`}>
                  查看详情 →
                </a>
              </article>
            ))
          )}
          <div className="pagination">
            <button
              disabled={!previous.length || list.isFetching}
              onClick={() => {
                setCursor(previous.at(-1)!);
                setPrevious(previous.slice(0, -1));
              }}
            >
              上一页
            </button>
            <button
              disabled={!list.data.next_cursor || list.isFetching}
              onClick={() => {
                setPrevious([...previous, cursor]);
                setCursor(list.data.next_cursor);
              }}
            >
              下一页
            </button>
            <button
              onClick={() => {
                setCursor('');
                setPrevious([]);
                if (!cursor) void list.refetch();
              }}
            >
              刷新列表
            </button>
          </div>
        </>
      )}
    </>
  );
}
export function KnowledgeDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ['knowledge-detail', id],
    queryFn: ({ signal }) => api.request('getKnowledgeDetail', { path: { id }, signal }),
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });
  return (
    <>
      <a className="action-link" href="#knowledge">
        ← 返回知识列表
      </a>
      <h1>知识详情</h1>
      {detail.isPending || detail.isFetching ? (
        <p role="status">正在核对版本与证据…</p>
      ) : detail.isError ? (
        <ErrorNotice
          error={detail.error}
          retry={() => {
            void detail.refetch();
          }}
        />
      ) : (
        <DetailBody item={detail.data} />
      )}
      <a className="action-link" href="#search">
        按任务环境检索 →
      </a>
    </>
  );
}

type SearchAttempt = {
  taskInput: SchemaTypes['TaskCreate'];
  search: Omit<SchemaTypes['SearchRequest'], 'task_id'>;
};
export function KnowledgeSearch({ principal }: { principal: SchemaTypes['Me'] }) {
  const [repo, setRepo] = useState('00000000-0000-4000-8000-000000000004');
  const [query, setQuery] = useState('');
  const [commit, setCommit] = useState('synthetic-baseline-v1');
  const [dependencies, setDependencies] = useState('{}');
  const [scope, setScope] = useState<SchemaTypes['SearchRequest']['scope']>('repo');
  const [validation, setValidation] = useState('');
  const [attempt, setAttempt] = useState<SearchAttempt>();
  const [budget, setBudget] = useState<SchemaTypes['Budget']>();
  const [expanded, setExpanded] = useState<SchemaTypes['ReadResult']>();
  const [readAttempt, setReadAttempt] = useState<SchemaTypes['ReadRequest']>();
  const [session] = useState(() => {
    const key = `akb-search-session:${principal.tenant_id}:${principal.principal_id}`;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const value = crypto.randomUUID();
      sessionStorage.setItem(key, value);
      return value;
    } catch {
      return crypto.randomUUID();
    }
  });
  const search = useMutation({
    mutationFn: async (input: SearchAttempt) => {
      const task = await api.request('createTask', { body: input.taskInput });
      setBudget(task.budget);
      const result = await api.request('searchKnowledge', {
        body: { ...input.search, task_id: task.id },
      });
      return { task, result };
    },
    onSuccess: ({ result }) => setBudget(result.budget),
  });
  const read = useMutation({
    mutationFn: (input: SchemaTypes['ReadRequest']) =>
      api.request('readKnowledge', { body: input }),
    onSuccess: (result) => {
      setExpanded(result);
      setBudget(result.budget);
    },
  });
  function submit() {
    let env: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(dependencies);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((v) => typeof v !== 'string')
      )
        throw new Error();
      env = parsed as Record<string, string>;
    } catch {
      setValidation('依赖版本须为 JSON 对象，例如 {"node":"24.21.0"}。');
      return;
    }
    setValidation('');
    setExpanded(undefined);
    read.reset();
    const input: SearchAttempt = {
      taskInput: {
        operation_id: crypto.randomUUID(),
        repo_id: repo.trim(),
        client_session_id: `web-search:${session}`,
      },
      search: {
        operation_id: crypto.randomUUID(),
        repo_id: repo.trim(),
        query: query.trim(),
        environment: { commit: commit.trim(), dependencies: env },
        scope,
        limit: 5,
        token_budget: 4000,
      },
    };
    setAttempt(input);
    search.mutate(input);
  }
  return (
    <>
      <div className="eyebrow">SEARCH</div>
      <h1>按任务环境检索</h1>
      <p className="lead">提供仓库和版本，查找符合适用条件的知识。引用不等于验证。</p>
      <form
        className="search-form knowledge-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          问题 / 关键词
          <input
            required
            maxLength={2000}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：人工审核、事务顺序"
          />
        </label>
        <label>
          仓库 ID
          <input required maxLength={36} value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label>
          代码版本 / 提交
          <input required value={commit} onChange={(e) => setCommit(e.target.value)} />
        </label>
        <label>
          依赖版本（JSON）
          <textarea
            value={dependencies}
            onChange={(e) => setDependencies(e.target.value)}
            rows={2}
          />
        </label>
        <label>
          检索范围
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="repo">当前仓库</option>
            <option value="domain">所属领域</option>
            <option value="global">所有授权范围</option>
          </select>
        </label>
        <p className="metadata">当前默认仓库及代码版本为合成演练参数，请按实际任务调整。</p>
        <button disabled={search.isPending || read.isPending} type="submit">
          {search.isPending ? '正在检索…' : '检索知识'}
        </button>
      </form>
      {validation && <p role="alert">{validation}</p>}
      {budget && (
        <p role="status" className="budget">
          本次任务读取预算：已用 {budget.used} / {budget.limit} · 剩余 {budget.remaining} · 本次返回{' '}
          {budget.returned_tokens} tokens。检索及展开详情均计数。
        </p>
      )}
      {search.isError && (
        <ErrorNotice
          error={search.error}
          retry={() => {
            if (attempt) search.mutate(attempt);
          }}
        />
      )}
      {search.data && !search.isPending && !search.isError && (
        <section aria-live="polite">
          <h2>
            {
              {
                matched: '找到适用知识',
                no_applicable_knowledge: '没有找到适用知识',
                clarification_required: '需要补充版本或条件',
                budget_exhausted: '本次任务读取预算已耗尽',
              }[search.data.result.outcome]
            }
          </h2>
          {search.data.result.clarification_questions.map((q, i) => (
            <p key={i}>{q}</p>
          ))}
          {search.data.result.items.map((hit) => (
            <article className="knowledge-card" key={hit.id}>
              <Tags values={[hit.maturity, hit.freshness]} />
              <h2>{hit.title}</h2>
              <p className="claim">{hit.claim}</p>
              <p className="metadata">
                正文版本 {hit.revision} · {hit.match_reason}
              </p>
              <Conditions context={hit.context} />
              <h3>原因</h3>
              <p>{hit.rationale.text}</p>
              <Sources refs={hit.source_refs} />
              <button
                disabled={read.isPending || search.isPending}
                onClick={() => {
                  setExpanded(undefined);
                  const input = {
                    task_id: search.data!.task.id,
                    operation_id: crypto.randomUUID(),
                    id: hit.id,
                    revision: hit.revision,
                  };
                  setReadAttempt(input);
                  read.mutate(input);
                }}
              >
                展开完整详情
              </button>
            </article>
          ))}
        </section>
      )}
      {read.isPending && <p role="status">正在读取完整详情…</p>}
      {read.isError && (
        <ErrorNotice
          error={read.error}
          retry={() => {
            if (readAttempt) read.mutate(readAttempt);
          }}
        />
      )}
      {expanded?.kind === 'complete' && !read.isError && <DetailBody item={expanded.item} />}{' '}
      {expanded?.kind === 'budget_limited' && !read.isError && (
        <div role="status" className="notice">
          {expanded.reason === 'read_budget_exhausted'
            ? '任务读取预算已耗尽，未返回完整正文。'
            : '完整正文超过预算，未截断适用条件。'}
        </div>
      )}
    </>
  );
}
