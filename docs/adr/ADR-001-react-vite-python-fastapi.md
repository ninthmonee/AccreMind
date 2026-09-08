# ADR-001：Studio 使用 React + Vite，后端统一 Python

- 状态：Accepted
- 日期：2026-09-09

## 决策

AccreMind Studio 使用 React、TypeScript、Vite 和 Ant Design。后端 Core API、Retriever Agent、MCP Gateway、CLI 和 Worker 统一使用 Python；主要框架为 FastAPI、Pydantic、SQLAlchemy、官方 MCP Python SDK 和 Celery。

## 原因

Studio 是登录后的管理 SPA，不需要 Next.js 的 SSR、SEO 和 BFF。React 对复杂表格、Markdown/代码编辑、Diff 和可视化有成熟生态；Vite 保持构建与部署简单。

Python 同时适合 API、检索、Embedding、重排和后续评测。官方 MCP Python SDK 已提供类型驱动 Tool Schema、stdio 与 Streamable HTTP，可以避免为了 MCP 单独保留 Node.js 后端。

## 后果

- Python/Pydantic 是后端业务契约权威来源，前端类型从 OpenAPI 生成；
- Retriever Agent 首期是 Python 模块而非独立微服务；
- Studio 作为静态 SPA 部署，认证和业务操作全部经过 FastAPI；
- 若未来建设公开内容门户，可以新增 Next.js 应用，但不改变 Studio；
- 如果团队最终拥有显著更强的 Vue 能力，可在正式 UI 开发前重新评估，此后不再轻易切换框架。
