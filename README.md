# AccreMind

AccreMind 是面向大模型开发任务的经验闭环平台。

开发者继续使用日常的大模型或 Coding Agent；AccreMind 通过 MCP 在任务过程中召回相关经验并注入上下文，在任务完成时接收由当前大模型提炼的候选经验，经人工审核后进入经验库，供后续任务复用。

当前经验只有两个来源：

1. 外部大模型通过 MCP 主动提交的候选经验；
2. 开发者主动维护并导入的静态 Markdown 经验文件。

当前不连接 Git、代码托管、Wiki、需求、PR、事故、聊天、监控或实时业务系统。

当前技术方向：Studio 使用 React + Vite + TypeScript，后端、Retriever Agent、MCP Gateway 和 Worker 主要使用 Python。

前端采用 TanStack Query + Zustand，并通过 URL/Form/局部状态明确状态所有权；组件库使用 Ant Design，Lint/Format 使用 Oxc。

## 当前文档

- [核心产品需求规格 v0.2](docs/product/AccreMind-Product-Requirements-v0.2.md)
- [核心架构 v0.2](docs/architecture/AccreMind-Core-Architecture-v0.2.md)
- [核心技术选型 v0.2](docs/architecture/AccreMind-Technology-Selection-v0.2.md)
- [Core API 中文接口文档 v0.1](docs/api/AccreMind-Core-API-v0.1.md)
- [MCP Gateway 与经验闭环 v0.1](docs/api/AccreMind-MCP-Gateway-v0.1.md)
- [检索与离线评测 v0.1](docs/api/AccreMind-Retrieval-v0.1.md)
- [静态导入接口与使用流程 v0.1](docs/api/AccreMind-Static-Import-v0.1.md)
- [Compound Engineering 静态案例参考](docs/examples/Compound-Engineering-Static-Reference.md)
- [ADR-001：React + Vite 与 Python 后端](docs/adr/ADR-001-react-vite-python-fastapi.md)
- [ADR-002：前端状态所有权](docs/adr/ADR-002-frontend-state-ownership.md)
- [开发进度](docs/development-progress.md)

仓库包含 Core API、MCP Gateway、Worker、Studio 与部署编排。经验正文永远是数据，不是指令；
Candidate 不进入生产召回；发布动作只属于人工审核者。

静态经验侧已包含 Compound Engineering Markdown 转换器，可将一个领域文件中的多条经验拆分为
`StaticExperienceDocument`，同时生成稳定文件 ID、内容哈希和逐条诊断。Static Import 已接通
Markdown 预检、敏感扫描、确认导入、审核发布、版本更新和可逆导出。

## 可执行领域契约

仓库已经包含第一版 Python/Pydantic 领域契约、领域状态机和生成后的 JSON Schema：

- 契约模型：`backend/packages/contracts/`
- 领域规则：`backend/packages/experience_domain/`
- JSON Schema：`schemas/json-schema/`
- OpenAPI Snapshot：`schemas/openapi/accremind.openapi.json`
- Compound Engineering 静态案例目录：`schemas/examples/compound-engineering/catalog.json`
- 决策说明：[可执行领域契约 v0.1](docs/domain/AccreMind-Executable-Contracts-v0.1.md)

本地验证：

```bash
make install
make schemas
make lint
make test
```

前端与端到端检查：

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e        # 需要 Core API、Studio dev server 与本地 PostgreSQL
```

## 启动本地服务

```bash
cp .env.example .env
make install
make db-up          # postgres + redis
make migrate
make api            # Core API  http://127.0.0.1:8000
make worker         # Celery worker + beat（校验、embedding、复核、反馈聚合）
make mcp            # MCP Gateway（stdio；容器内用 streamable-http）
```

`deploy/compose/compose.yaml` 也能以容器方式运行 api、worker 与 mcp_gateway（共用
`deploy/docker/Dockerfile.backend` 镜像）；迁移仍由 `make migrate` 显式执行。

## 经验闭环

召回、注入与沉淀：

```text
Agent 调用 experience_recall → Core API 按 scope 过滤
→ FTS + pgvector 召回 → RRF 重排 → Experience Pack 注入上下文
→ 任务结束时 experience_feedback / task_complete
→ Candidate 入队 Worker 校验、去重与 embedding
→ 人工审核发布 Version N → 后续召回可见
```

静态经验闭环：

```text
Markdown → preview → 人工确认 commit → Candidate → 审核发布
         → 导出修改 → preview/commit → 审核发布 Version N+1
```

治理闭环：

```text
负面反馈 → experience.review → 达阈值暂停默认召回，否则标记 review_due
到期经验 → experience.review_due → review_due / expired
helpful 反馈 → feedback.aggregate → verified 提升为 proven
```

## 身份与数据库角色

开发态仍使用显式请求头验证 scope 与 RLS 边界：`X-Organization-Id`、`X-Actor-Id`、可选的
team/project scope，以及 `X-Actor-Role`。PAT 已可用（`experience_*` 与 `task_complete` 工具权限），
OIDC 仍未接入。

本地数据库使用三个角色：

- `accremind`：只负责迁移；
- `accremind_app`：Core API、Worker 业务写入，受 PostgreSQL RLS 约束；
- `accremind_maintenance`：仅供周期治理任务跨租户扫描（BYPASSRLS），不用于请求处理。

## 验证脚本

```bash
make smoke           # 核心闭环
make smoke-static    # 静态导入、并发幂等、不可变版本与 RLS
make eval            # 离线召回评测（结果写入 evaluation_runs）
make check           # schemas + lint + test，并校验 schema 快照无漂移
```
