# 开发进度

更新日期：2026-09-10。顺序依据技术选型 v0.2 第 14 节；逐项交付，不把代码骨架视为产品验收完成。

| 顺序 | 内容 | 当前状态 |
| --- | --- | --- |
| 1–2 | 工程结构、workspace、门禁和 Compose | 后端 uv、前端 pnpm、Oxc 门禁已就绪；Compose 覆盖 postgres/redis/api/worker/mcp_gateway，镜像构建未在本机验证。 |
| 3 | 可执行领域契约 | 已实现；含静态更新 base_version。 |
| 4 | 数据库、迁移、RLS 与审计 | 已实现；本次增加 BYPASSRLS 维护角色与 evaluation_runs。 |
| 5 | Experience Service 和静态导入 dry-run | 已完成静态预检、确认导入、版本化发布与可逆导出。 |
| 6 | FTS + pgvector Retriever 和离线评测 | 已实现 FTS + pgvector + RRF、embedding 缺失降级与 evaluation.run；数据集仍是合成冒烟集，P0 真实数据未验收。 |
| 7 | 五个 MCP 工具和 Prompt | 已实现，stdio 与 Streamable HTTP 共用同一组 handler；真实宿主接入未验收。 |
| 8 | Celery 校验、去重、Embedding、复核 | 已实现 candidate.process、experience.embed、experience.review、experience.review_due、feedback.aggregate、evaluation.run。 |
| 9 | React Studio | 已实现 Experience Library、Editor、Candidate Inbox、Static Import、Access Token 与 Jobs。 |
| 10 | 生成 TS client 和前后端联调 | OpenAPI client 由 openapi-typescript 生成；Playwright e2e 覆盖创建 → 审核 → 发布 → 导出 → Token 生命周期。 |
| 11 | Portable Integration Kit 和 completion Hook | 已提供 portable 指令、MCP 配置模板与 Claude Code Stop Hook 模板；未安装到宿主。 |
| 12 | 完整 Agent 经验闭环 | API 与 MCP 级闭环已有测试覆盖；真实 Agent 使用与闭环覆盖率待验收。 |

本次交付（治理与检索闭环）：

- [x] Worker 补上 `experience.review` handler：错误/冲突反馈达阈值暂停默认召回，否则标记 review_due。
- [x] 周期任务 `experience.review_due`（到期与临近到期标记）与 `feedback.aggregate`（proven 提升 + 复核）。
- [x] 离线评测任务 `evaluation.run`，聚合指标写入 `evaluation_runs`。
- [x] 迁移 0006：BYPASSRLS 维护角色 `accremind_maintenance` 与 `evaluation_runs` 表。
- [x] Compose 增加 api/worker/mcp_gateway 服务与后端镜像定义。

尚未完成：

- 前端 e2e 复跑确认：本次修复了角色下拉被拦截与 `验证结果` 标签冲突两处定位器问题。
- Compose 镜像构建与容器内运行验证。
- `experience.paused` 经验目前只能靠人工复核恢复，Studio 还没有恢复入口。
- P0 的 50 条人工确认经验、30 个真实/脱敏问题以及真实 Agent 使用效果，必须通过实际数据与
  人工审核验收，不能由开发测试结果替代。
