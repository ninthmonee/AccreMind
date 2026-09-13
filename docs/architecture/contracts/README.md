# 契约 v2：单一源、生成和迁移

阶段 A 修订，2026-09-12。这里只包含设计契约及验证工具，不表示 API/CLI/Web 已实现。

## 唯一修改入口

- `source/openapi.json`：HTTP 操作和所有领域 schema 的权威源。
- `source/mcp-tools.json`：8 个工具的名称、对应 operationId 和说明；输入/输出禁止单独维护。
- 顶层 `openapi.json`、`schemas.json`、`mcp-tools.json` 都由 `scripts/generate-contracts.mjs` 生成。
- `scripts/upgrade-contracts-v1-to-v2.mjs` 是本轮一次性迁移记录，有 source 时拒绝重跑；日常不要使用它覆盖源。

```sh
corepack pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm contracts:check
# 可选：需已启动的 Docker，隔离临时 PostgreSQL，结束自动清理
pnpm contracts:check:sql
```

依赖精确固定并由 pnpm-lock.yaml 锁定传递版本。OpenAPI/Schema/MCP 生成不依赖第三方包；共享 TypeScript SDK 用固定 openapi-typescript 生成，完整检查用 Swagger Parser、Ajv2020 和 ajv-formats。阶段 B 已初始化 Git 并提供工程 CI，但尚未推送，不能声称云端 CI 已运行。

## 破坏性变化

v1.0.0 → v2.0.0，不允许旧客户端无条件继续解析。

| 问题 | v2 契约 |
| --- | --- |
| R1 聚合版本不可读 | 管理 summary/detail/history 提供 aggregate_revision、content_revision；状态写使用前者 |
| R2 修订目标丢失 | Candidate.revision_binding、RevisionCreate、RevisionRebase、发布目标 CAS 与 SQL 快照 |
| R3 证据 ID/版本断链 | EvidenceInput.client_evidence_id、evidence_mappings、必需 revision 查询参数；retain 入口冻结最小证据 |
| R4 票据无审批接口 | session-only ticket GET/decision；公开认证入口 public:auth |
| R5 refresh 重用无法定位 | identity.refresh_tokens 历史关联；sessions.id 就是 family ID；失响应重新登录 |
| R6 详情不是完整正文 | SearchHit / KnowledgeSummary / KnowledgeDetail / KnowledgeRevisionSummary；ReadResult 明确 complete/budget_limited |
| R7 批准刷新丢失 | ReviewRecord.review_id；ReviewView.current_approval/latest_review/current_publication |
| R8 镜像被前端阻断 | link_existing + authoritative_mirror + 显式 mirror_approval=true 的专门批准路径 |
| R9 非法字段被静默删除 | Ajv2020 严格校验，removeAdditional/coerceTypes/useDefaults 均 false |

新增 GET /navigation，不增加第九个 MCP 工具。导航只降低资料发现成本，不当成经验/已验证建议。

## 数据迁移与兼容限制

当前无应用或生产数据，SQL 001/002 已直接修订为空数据库 v2 基线。它们不是可在 v1 数据库重复执行的升级脚本；严禁用重建/删库方式迁移真实资料。

若存在独立的 v1 原型：先停止写入并备份；通过专门 expand/backfill/switch/contract 迁移补字段和表，再升级所有客户端。

- 不知道 target/base 的修订候选不能猜测，保留待确认并重新绑定/审核。
- 无 client_evidence_id 的旧贡献，只有存在可核对上传清单时才能回填映射；否则显式标记旧数据未迁移，补交证据。
- 旧 refresh_hash 没有已消费历史，不能声称提供重用检测；撤销旧工具会话，要求重新登录，新会话进入 refresh_tokens。
- 原批准只能在 exact candidate/assessment/evidence/scope/target 绑定完整时保留；否则 stale，重新判定和审核。旧 raw 证据先冻结 retained 并重绑批准。
- 旧正文版本的 maturity/freshness 不得从当前聚合猜测；缺少历史依据标 unknown/draft 并复核，不抬高成熟度。
- v1 ReadResult/KnowledgeItem 不兼容 v2 联合结果；所有三端重新生成类型和 fixtures。v1 幂等缓存不得直接当成 v2 成功结果返回。

领域和安全语义以[后端 B20](../03-后端架构设计.md#b20-阶段-a契约-v2-的闭环与修订规则)为准。Fixture 检查只证明样本满足契约及演练绑定一致，不证明真实权限、事务或协议实现。
