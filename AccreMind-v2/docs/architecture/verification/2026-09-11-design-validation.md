# 架构详细设计验证记录

- 日期：2026-09-11。
- 范围：工具端、前端、后端、开发任务、OpenAPI/JSON Schema/MCP 定义和 SQL 迁移。
- 结论：文档结构与本地引用通过检查；领域与身份 SQL 已在临时 PostgreSQL 17 容器中实际迁移通过；OpenAPI/JSON Schema 完成内部引用与必填字段结构检查，尚未使用第三方 OpenAPI 规范验证器作完整语义验证。

## 已执行检查

| 项目 | 结果 | 证据说明 |
| --- | --- | --- |
| Markdown 代码围栏 | 通过 | 四份主文档围栏数量成对 |
| 本地文档附件链接 | 通过 | 主文档引用的 PRD、契约和 SQL 文件存在 |
| JSON 可解析 | 通过 | openapi.json、schemas.json、mcp-tools.json 均可由标准 JSON 解析器读取 |
| Schema 本地引用 | 通过 | OpenAPI 与 Schema bundle 的本地 `$ref` 均能解析到现有 schema |
| 对象必填字段 | 通过 | `required` 中字段均存在于相应 `properties` |
| OpenAPI 操作唯一性 | 通过 | 48 个路径、54 个 operationId，operationId 无重复且均声明 capability |
| MCP 工具唯一性 | 通过 | 8 个工具名无重复 |
| 开发任务依赖 | 通过 | 33 个任务 ID 唯一，直接依赖存在且依赖图无环 |
| PostgreSQL 领域迁移 | 通过 | `001_initial_schema.sql` 在 pgvector/pgvector:pg17 临时容器中以 `ON_ERROR_STOP=1` 完整执行并提交 |
| PostgreSQL 身份迁移 | 通过 | `002_identity_schema.sql` 在同一数据库中随后完整执行并提交 |
| 临时资源清理 | 通过 | `accremind-design-pg` 容器已停止并因 `--rm` 自动删除 |
| 原文保持不变 | 通过 | V1 SHA-256 为 `668a8b1e99e2d6723a13d72d2f200e57fa128f6295b6ecb715c3201253c05bd0`；PRD V2.1 为 `81f9491aa4058ea101824e62a2c44f4ae96179dd53aa29c4841a6d599c83b4dd` |

## 尚未完成的验证

- 尚未生成应用代码，因此没有 TypeScript 编译、前端组件、CLI、MCP 宿主和端到端运行结果。
- 尚未接入组织 OIDC、系统凭据库、真实 Claude Code 版本或真实团队仓库。
- 第三方 Python OpenAPI 校验依赖因当前 Python 证书链无法下载，因此本次只执行了自有结构校验；这不等于 OpenAPI 规范的完整验证。
- SQL 已验证正向迁移语法和建表，不代表 RLS 角色权限矩阵、并发锁、恢复和删除流程已经通过。对应工作仍由 B02、B06、B12、Q02、Q03 执行。

## 开发前必须补充

1. 在仓库建立契约生成源和 CI 校验，避免直接维护三个派生 JSON 文件。
2. 为 OpenAPI 选择锁定版本的规范验证器，并把完整验证加入 D01。
3. 用非表 owner、`NOBYPASSRLS` 的运行角色执行租户和同租户内容 ACL 集成测试。
4. 使用真实 Claude Code 版本验证 stdio MCP、项目级配置读改写及 stdout 纯净性。
5. 使用两个浏览器会话验证审核三方合并、撤权和异步发布恢复。
