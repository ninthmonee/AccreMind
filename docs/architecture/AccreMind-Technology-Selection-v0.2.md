# AccreMind 核心版技术选型 v0.2

- 状态：Current
- 日期：2026-09-09
- 决策：React 管理台 + Python 后端
- 约束：只接收 MCP 提交经验和人工静态文件，不建设外部数据连接器

## 1. 最终选择

```text
Frontend                    Backend
React + Vite                Python + FastAPI
TypeScript                  Pydantic + SQLAlchemy
Ant Design                  PostgreSQL + pgvector
TanStack Query              Official MCP Python SDK
React Router                Celery + Redis
```

系统采用四个运行单元：Studio Web、Core API、MCP Gateway 和 Worker。Retriever Agent 是后端独立模块，首期和 Core API 同进程，达到性能或团队边界后可以单独部署。

```text
Coding Agent / LLM Host                 Developer
          │ MCP                           │ Web
          ▼                               ▼
  Python MCP Gateway ───────────► Python Core API
                                          │
                     Experience Service · Retriever Agent
                     Candidate Service  · Static Import
                                          │
                                  PostgreSQL + pgvector
                                          ▲
                              Celery Worker│
                                          │
                                        Redis
```

## 2. 前端框架决策

### 选择：React + Vite，不使用 Next.js

AccreMind Studio 是登录后的后台管理 SPA，不需要搜索引擎收录、服务端渲染或 React Server Components。使用 Vite 可以减少全栈框架约束，让 Python API 成为清晰、唯一的后端边界。

推荐组合：

| 能力 | 选择 |
| --- | --- |
| 语言与构建 | TypeScript + React + Vite |
| UI 组件 | Ant Design |
| 路由 | React Router |
| 服务端状态 | TanStack Query |
| 表格 | Ant Design Table；复杂场景再引入 TanStack Table |
| 表单 | Ant Design Form；Schema 动态表单再评估 React Hook Form |
| 全局客户端状态 | P0 不引入；出现明确跨路由工作台状态时再采用 Zustand |
| Markdown | react-markdown + Shiki |
| 经验正文编辑 | Monaco Editor，简单表单先用普通编辑区 |
| 图表 | ECharts |
| 单元/组件测试 | Vitest + Testing Library |
| 浏览器 E2E | Playwright |

### 为什么不是 Vue

Vue + Vite + Element Plus 也能很快完成后台。如果核心开发者已经明显更熟悉 Vue，它可能是个人开发速度最快的选择。但在没有既定偏好的前提下选择 React，原因是：

- 复杂数据表格、Markdown/代码编辑、Diff、可视化和管理台生态更宽；
- 与未来可能提供的前端 SDK、嵌入式组件和 Agent UI 更容易共享；
- React 人才和企业组件生态更普遍；
- 当前前端试点领域本身以 React 经验作为首批重点。

因此这里的“最快”是指从 P0 到可持续迭代最快，而不是首页写出来最快。

### 为什么不是 Next.js

- 当前没有 SEO 和公开内容页需求；
- Python 已经承担 API、认证、领域逻辑和 MCP；
- 再引入 Next.js BFF 会产生两层后端和重复鉴权；
- Vite SPA 的开发、部署和故障边界更简单。

未来若建设公开经验社区或服务端内容门户，可新增独立 Next.js 应用，不改 Studio。

### 状态管理边界

AccreMind Studio 按状态所有权选择工具，不建立一个包揽所有数据的全局 Store：

| 状态 | 放置位置 | 示例 |
| --- | --- | --- |
| 服务端状态 | TanStack Query | 经验、Candidate、审核队列、用户、Token 元数据、统计结果 |
| URL 状态 | React Router search params/path params | 搜索词、筛选、分页、排序、team/project、当前详情 ID |
| 表单草稿 | Ant Design Form / Monaco 局部状态 | 经验编辑、审核意见、静态导入配置 |
| 短暂 UI 状态 | 组件 `useState`/`useReducer` | Drawer、Modal、行选择、展开折叠 |
| 稳定全局依赖 | React Context | 主题、语言、只读的当前会话能力 |
| 复杂跨路由工作台状态 | Zustand，满足条件后才引入 | 多面板布局、跨页面未提交选择、可恢复导入向导 |

TanStack Query 只保存服务端缓存，不保存编辑器草稿、筛选条件或弹窗状态。React Router 与 Query 也不能同时为同一资源各维护一套 loader cache；当前采用 Declarative Router + TanStack Query 作为唯一服务端缓存。

Zustand 不加入 P0 默认依赖。只有某项状态同时满足“跨多个远距离组件、不能自然进入 URL/服务端/表单、生命周期明显长于单组件”时才建立小型 domain store；禁止创建单一 `useAppStore`，禁止把 API response 复制进 Zustand。

## 3. Python 后端技术栈

| 范围 | 选择 | 说明 |
| --- | --- | --- |
| Python 管理 | uv workspace | 锁定解释器与依赖，统一命令 |
| Web API | FastAPI | 类型驱动、异步、OpenAPI 自动生成 |
| Schema | Pydantic v2 | API、MCP、静态文件共享模型 |
| ORM | SQLAlchemy 2.x | 成熟、支持 async 和复杂事务 |
| Migration | Alembic | 数据库版本迁移 |
| PostgreSQL Driver | psycopg 3 | async、连接池和现代 PostgreSQL 支持 |
| MCP | 官方 MCP Python SDK v2 / FastMCP | stdio + Streamable HTTP |
| Background Jobs | Celery | embedding、去重、到期和评测任务 |
| Broker/Cache | Redis | Celery broker、短缓存和限流计数 |
| HTTP Client | HTTPX | 模型供应商和内部调用 |
| Retry | Tenacity | 外部模型调用的有限重试 |
| CLI | Typer | 静态经验预检、导入和导出 |
| Test | pytest + pytest-asyncio + Testcontainers | 单元和真实 PostgreSQL 集成测试 |
| Quality | Ruff + Pyright | 格式、Lint 和静态类型检查 |
| Observability | OpenTelemetry | API、MCP、检索、模型和 Worker trace |

FastAPI 基于 Python 类型与 Pydantic，自动生成 OpenAPI 和 JSON Schema，并内置常用安全模型，适合作为前端和 MCP 共用的领域 API。[FastAPI 官方特性](https://fastapi.tiangolo.com/features/)

## 4. MCP Gateway

使用官方 MCP Python SDK v2，不自写 JSON-RPC。SDK 支持类型驱动的 Tool Schema、stdio 和 Streamable HTTP；本地 Agent 使用 stdio，部署服务使用 Streamable HTTP。[官方 MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)

五个工具：

- `experience_recall`
- `experience_get`
- `experience_submit`
- `experience_feedback`
- `task_complete`

一个 Prompt：`task-experience-loop`。

实现原则：

- MCP Pydantic Input/Output Model 直接复用 `accremind_contracts`；
- Gateway 不查询数据库，只调用 Core API application service；
- stdio adapter 和 HTTP adapter 共享 Tool handler；
- HTTP 使用 PAT/Bearer Token，解析出 organization/team/project scope；
- 工具返回短文本 `content` 和结构化结果；
- `experience_submit` 与 `task_complete` 永远只创建 Candidate；
- MCP 不能感知所有 Host 的任务完成，Portable Prompt 为 best-effort，支持 Hook 的 Host 由 Integration Kit 增强。

官方 SDK 文档明确推荐本地使用 stdio、部署使用 Streamable HTTP，SSE 只保留兼容用途。[MCP Python transport 文档](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/index.md)

## 5. 后端模块边界

```text
backend/
├── apps/
│   ├── api/                    # FastAPI Core API
│   ├── mcp_gateway/            # FastMCP stdio/HTTP entrypoints
│   ├── worker/                 # Celery app and tasks
│   └── cli/                    # Typer static import/export
├── packages/
│   ├── contracts/              # Pydantic models + JSON Schema export
│   ├── experience_domain/      # aggregate/state/version/review rules
│   ├── retriever_agent/        # retrieval plan/RRF/rerank/pack
│   ├── candidate_processor/    # validation/redaction/dedup
│   ├── static_experience/      # Markdown front matter parser
│   ├── auth_policy/            # PAT/RBAC/scope
│   ├── model_providers/        # embedding/rewriter/reranker adapters
│   ├── evaluation/             # datasets/scorers/reports
│   └── observability/
└── tests/
frontend/
├── apps/studio/                # React + Vite
├── packages/api-client/        # OpenAPI generated client
├── packages/design-system/
└── tests/
schemas/                        # generated JSON Schema/OpenAPI snapshots
evals/                          # versioned datasets and judgments
deploy/compose/                 # PostgreSQL/pgvector + Redis + apps
```

Python 后端是业务契约的权威来源。CI 从 FastAPI OpenAPI 生成 TypeScript client；前端不得手写一套重复 DTO。

## 6. Core API 领域模块

Core API 使用 FastAPI Router 分模块，但初期作为模块化单体部署：

- `identity`：用户、团队、项目、PAT；
- `experiences`：经验、不可变版本、发布与弃用；
- `candidates`：提交、审核、编辑、合并与驳回；
- `retrieval`：Retriever Agent 和 Experience Pack；
- `feedback`：召回、使用和负面反馈；
- `static_import`：preview、commit 和 export；
- `tasks`：结构化 task_complete；
- `evaluation`：数据集和运行结果；
- `audit`：关键操作审计。

Router 只做协议转换，业务规则放在 application/domain service，SQLAlchemy model 不直接作为 API response。

## 7. PostgreSQL 与检索

PostgreSQL 保存组织、经验、版本、Candidate、审核、Token、反馈、任务摘要、检索运行和审计；pgvector 保存带模型版本的 embedding。

Retriever Agent 固定状态机：

```text
validate
→ authorize and scope filter
→ normalize technology aliases
→ deterministic trigger lookup
→ PostgreSQL FTS + pgvector HNSW
→ RRF fusion
→ applicability/maturity/freshness/feedback rerank
→ conflict grouping
→ token-budgeted Experience Pack
→ empty or response
```

关键策略：

- team/project、published、paused 和 valid_until 条件进入召回 SQL；
- PostgreSQL `tsvector` + GIN 处理错误信息和技术术语；
- pgvector HNSW 处理语义相似；
- RRF 融合两路名次；
- 可选模型 rerank 只处理少量最终候选；
- 保存查询模式、排名特征、embedding/index 版本和经验版本；
- 定期用 exact search 评估 HNSW recall。

核心版不引入 OpenSearch 和独立 Vector DB。pgvector 支持 HNSW、PostgreSQL FTS 混合和迭代扫描，足够当前规模。[pgvector 官方文档](https://github.com/pgvector/pgvector)

## 8. 模型能力

Python Protocol 定义三个窄接口：

```python
class EmbeddingProvider(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

class QueryRewriter(Protocol):
    async def rewrite(self, request: RecallRequest) -> list[str]: ...

class RerankerProvider(Protocol):
    async def rerank(self, query: str, items: list[CandidateHit]) -> list[float]: ...
```

默认使用 OpenAI-compatible HTTP provider，也允许本地模型。模型、endpoint、维度和版本配置化；Embedding 模型变化必须建立新索引版本，不能混用向量。

首期 Retriever Agent 不是无限循环 Agent，最多一次查询改写、两路召回和一次重排。

## 9. Worker 和 Redis

Celery 任务：

- `candidate.validate`
- `candidate.scan_sensitive_data`
- `candidate.find_duplicates`
- `experience.embed`
- `experience.review_due`
- `feedback.aggregate`
- `evaluation.run`

Redis 只承担 broker、短缓存和限流计数，不保存正式经验或权限真相。任务携带幂等键，数据库写入使用唯一约束和事务保证重复执行安全。

若后续实践证明 Celery 运维成本高且任务规模很小，可替换为 PostgreSQL 队列；领域服务不依赖 Celery Task 对象。

## 10. 静态经验

静态导入不是 Connector：

1. Studio 上传，或 CLI 读取用户明确指定的目录；
2. Python 解析 Markdown + YAML Front Matter；
3. Pydantic 执行 Schema、大小和字段校验；
4. secret/PII scanner 检查敏感信息；
5. 返回 create/update/conflict/error dry-run；
6. 用户确认后创建 Candidate 或 Draft；
7. 发布后由 Celery 生成 embedding；
8. 可重新导出 Markdown。

服务不扫描磁盘、不监听仓库、不同步外部文件变化。

## 11. 权限与安全

- 首期提供本地管理员和 PAT，团队部署可接外部 OIDC；
- FastAPI dependency 执行 RBAC + organization/team/project scope；
- PostgreSQL Row Level Security 是生产隔离防线；
- PAT 使用强随机值，只保存 hash，可撤销、过期和限定工具；
- 不保存外部模型的完整会话和思维过程；
- 经验正文视为不可信数据，不能成为系统指令；
- MCP/HTTP 原始正文默认不写日志和 trace；
- 候选内容检查 secret、PII、完整源码和超长文本；
- 审核、发布、弃用、Token 和权限变化写不可变审计事件。

首期不引入 OPA 或自建 Keycloak，避免维护两套权限真相。

## 12. 测试和工程质量

后端：

- pytest 单元测试领域状态机；
- Hypothesis 测试 Schema、作用域和状态转换不变量；
- Testcontainers 启动真实 PostgreSQL/pgvector 和 Redis；
- MCP in-memory/stdio/HTTP contract tests；
- 固定检索数据集验证 Recall@K、MRR 和越权过滤；
- Ruff format/check、Pyright strict、Alembic migration check。

前端：

- Vitest + Testing Library；
- MSW 模拟 OpenAPI client 边界；
- Playwright 覆盖登录、经验编辑、静态导入、候选审核和 Token；
- ESLint、TypeScript strict 和构建检查。

## 13. 明确不选

| 技术/方案 | 当前决定 |
| --- | --- |
| Vue | 不选；团队若已有强 Vue 能力可重新评估 |
| Next.js | 不选；Studio 不需要 SSR/SEO/BFF |
| 默认全局 Zustand Store | 不选；P0 没有需要它承载的状态 |
| Node.js 后端 | 不选；按项目方向统一 Python |
| 自写 MCP 协议 | 不选；使用官方 Python SDK |
| Django | 不选；当前 API/MCP/异步检索形态下 FastAPI 更轻 |
| Python 微服务群 | 不选；先模块化单体，按实测边界拆分 |
| LangChain/LlamaIndex 领域内核 | 不选；用窄接口避免框架锁定 |
| OpenSearch/Vector DB | 不选；PostgreSQL + pgvector 足够 |
| Kafka/Temporal/Neo4j | 不选；当前不存在对应复杂度 |

## 14. 开发顺序

1. 建立 `frontend/`、`backend/`、`schemas/`、`deploy/` 正式结构；
2. 建立 uv 和 pnpm workspace、质量门禁和 Docker Compose；
3. 用 Pydantic 定义经验、Candidate、MCP 和静态文件契约；
4. 建立 PostgreSQL/pgvector Schema、Alembic、RLS 和审计；
5. 实现 Experience Service 和静态导入 dry-run；
6. 实现 FTS + pgvector Retriever Agent 与离线评测；
7. 使用官方 Python SDK 实现五个 MCP 工具和 Prompt；
8. 实现 Celery 的校验、去重、Embedding 和复核任务；
9. 开发 React Studio 的 Library、Editor、Candidate Inbox 和 Token；
10. 生成 TypeScript API client，完成前后端联调；
11. 实现 Portable Integration Kit 和一个 completion Hook Adapter；
12. 跑通召回 → 注入 → 完成 → 提交 → 审核 → 再召回。
