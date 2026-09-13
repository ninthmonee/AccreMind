# 阶段 A：设计闭环修订与验证

日期：2026-09-12。范围：架构审查 R1—R9、跨端文档、契约 v2、SQL 基线与契约验证工具。没有开发或部署应用。

> 本文保留阶段 A 当时结果。后续阶段 B 已迁移 pnpm workspace、增加共享 SDK 和 fixtures，并初始化 Git；当前复现改用 pnpm install --frozen-lockfile / pnpm contracts:check。工程状态见[阶段 B 记录](2026-09-12-phase-b-validation.md)。

## 修订记录

- R1/R2：区分管理聚合版本与正文版本；修订候选和快照持久保存目标/基线，显式 rebase，发布两次目标 CAS。
- R3：client_evidence_id 与稳定 evidence_mappings；读取指定版本；批准前 retained 证据固定，raw 清理不静默重绑。
- R4/R5：Web-only 票据详情和 approve/deny、public:auth 标记；refresh_tokens 历史关联与会话族撤销；响应丢失重新登录。
- R6/R7：完整详情/摘要/历史拆分；ReadResult 联合分支；具名批准与刷新恢复，包括 current_publication。
- R8/R9：保留 link_existing 的规范镜像独立批准路径；Ajv2020 明确严格配置与未知字段负例。
- 补充：授权导航入口；S1 四个就绪工具/S2 全量八工具；可移植文档链接；源/生成契约与 CI 工作流。

## 实际检查

| 检查 | 本轮结果 |
| --- | --- |
| 源与三份生成契约一致 | 通过，check 模式只读，不改写附件 |
| OpenAPI 3.1 完整规范验证 | Swagger Parser 12.0.0 实际验证通过 |
| JSON Schema Draft 2020-12 | Ajv 8.17.1 + ajv-formats 3.0.1 严格编译 110 个领域 schema |
| HTTP 请求/响应 envelope | 630 个 wire schema 实际编译通过 |
| MCP 工具 | 8 个工具的全部输入/输出 schema 编译通过，保持单一 operation 映射 |
| 正反 fixtures | 57 例通过，含未知 actor/maturity、镜像、空判定、证据映射、完整详情、版本与票据条件；输入无静默修改 |
| API 清单 | 54 路径、60 唯一 operation，path 参数和公开认证/session-only 审批检查通过 |
| 契约级演练 | 上传映射→批准→刷新恢复→发布绑定→修订目标 CAS/竞争修订→失效批准的合成样本一致 |
| 本地 Markdown 链接 | 75 个引用存在；旧 admin 绝对路径已替换为相对路径 |
| SQL 001/002 | 在本轮临时 PostgreSQL 17.6 中以 ON_ERROR_STOP=1 正向迁移、提交通过 |
| SQL 新约束 | evidence 版本 FK、上传映射唯一性、修订绑定/基线 FK、镜像路由、跨租户 FK、refresh 历史/唯一 active/同族替换通过；合成事务回滚 |
| 临时数据库清理 | 指定容器已停止并由 --rm 自动删除，数据仅 tmpfs，无网络和主机目录挂载；下载镜像保留可复测 |

PostgreSQL：17.6 (Debian 17.6-2.pgdg13+1)，aarch64。镜像固定为 `postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929`。这是本轮设计验证版本，不是生产技术栈/安全升级承诺。

复现：`npm run contracts:check`；Docker 启动后 `npm run contracts:check:sql`。完整脚本和锁文件已入项目，未初始化 Git，因此不虚构代码 commit ID。

## 验证边界

- Fixture 与契约级演练是合成样本的结构和绑定一致性检查，不是应用授权、发布门槛、Refresh Token 实现或并发锁测试。
- 本轮已启动现有 Docker 并重跑新版 SQL；未沿用 9 月 11 日结果。SQL 演练以临时 superuser 执行，只测迁移和新约束，不证明 NOBYPASSRLS 运行角色矩阵、真实 CAS/Worker 并发或服务授权通过。
- 未接入 OIDC、模型、真实仓库、系统凭据库、浏览器或 Claude Code，未执行 HTTP/MCP E2E。
- 提供 GitHub Actions 工作流不等于云端 CI 运行：当前目录仍未初始化 Git，也未推送。工程脚手架、客户端类型生成和真实试点仍属阶段 B 及之后。

## 开工入口

先阅读[契约说明](../contracts/README.md)和[后端 B20](../03-后端架构设计.md#b20-阶段-a契约-v2-的闭环与修订规则)，执行 `npm ci --ignore-scripts`、`npm run contracts:check`。D00 的组织参数仍待确认，阶段 A 不替代真实团队试点。
