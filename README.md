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
- [Compound Engineering 静态案例参考](docs/examples/Compound-Engineering-Static-Reference.md)
- [ADR-001：React + Vite 与 Python 后端](docs/adr/ADR-001-react-vite-python-fastapi.md)
- [ADR-002：前端状态所有权](docs/adr/ADR-002-frontend-state-ownership.md)

当前仓库已进入后端纵向切片阶段，包含可执行领域契约、Core API、数据库迁移和本地基础设施；MCP Gateway、Worker 和 Studio 尚未实现。

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

## 启动 Core API

```bash
cp .env.example .env
make install
make db-up
make migrate
make api
```

服务默认监听 `http://127.0.0.1:8000`，开发环境 OpenAPI 页面为 `http://127.0.0.1:8000/docs`。

当前 API 实现了第一条纵向闭环：

```text
提交 Candidate
→ Reviewer 标记 ready_for_review
→ Reviewer 发布 Experience Version 1
→ 基础词法召回只返回 Published Experience
```

身份认证目前使用显式的开发态请求头：`X-Organization-Id`、`X-Actor-Id`、可选的 team/project scope，以及 `X-Actor-Role`。它用于尽早验证 scope 和 RLS 边界，不是最终 PAT/OIDC 实现。

本地数据库使用两个角色：`accremind` 只负责迁移，Core API 使用非超级用户 `accremind_app`，保证 PostgreSQL RLS 不会被运行连接绕过。
