# 静态经验导入 v0.1

状态：Implemented，2026-09-10。此阶段对应技术选型开发顺序第 5 项。

## 使用流程

1. 准备 UTF-8 Markdown 文件；开头为 `---` 包裹的 YAML Front Matter。
2. `POST /api/v1/static-import/preview` 预检，检查每条 action 和 diagnostics。
3. 用户确认预检结果后，携带原文件、`preview_hash`、`idempotency_key` 和
   `redaction_confirmed: true` 调用 `POST /api/v1/static-import/commit`。
4. 使用返回的 `candidate_ids` 调用 `GET /api/v1/candidates/{candidate_id}`，审核结构化经验与
   `markdown_body` 补充正文；由 reviewer/admin 执行 prepare-review 和 publish。
5. `GET /api/v1/static-import/export/{experience_id}` 导出当前版本的 Markdown。
6. 修改导出文件后重复预检、确认、审核，生成同一个 Experience 的下一版本。

身份请求头沿用 [Core API](AccreMind-Core-API-v0.1.md)。这里的确认是 API 调用方表达的人工作业意图，
服务端仍会重新校验内容、权限和当前数据库状态，不信任文件中的状态或发布声明。

## 预检请求与响应

```json
{
  "files": [
    {"filename": "request-race.md", "content": "---\nfile_id: ...\n---\n..."}
  ]
}
```

`filename` 只作为诊断标签，不作为服务端文件路径。预检不会写入 Candidate、文件绑定、审计或回执。
单批 1–50 个文件，总计最多 2,000,000 UTF-8 字节，单文件最多 128,000 字节；拒绝 NUL、YAML
重复键、锚点、别名、非安全类型和超过 20 层嵌套。

响应包含 `preview_hash`、`can_commit` 和 `items`：

| action | 含义 |
| --- | --- |
| `create` | 当前精确 scope 下没有这个 file_id，确认后创建 Candidate。 |
| `update` | 文件已发布、experience_id/owner/scope/base_version 匹配，确认后创建修订 Candidate。 |
| `unchanged` | 规范化内容没有变化，复用已有 Candidate。 |
| `conflict` | 同批重复 ID、已有待处理修订、版本过期、身份映射不匹配或目标不可更新。 |
| `error` | 文件、契约、敏感内容或 scope 校验失败。 |

每条包含 filename、file_id、content_hash、action、候选/经验引用，以及可用时的 base_version。
诊断包含 `field`、`message` 和可用时的 `line`。诊断不回显匹配到的密钥或个人信息。

敏感扫描目前是确定性规则，检测常见私钥、API 凭证、密钥赋值、邮箱、手机号、身份证号和过长代码块。
它不是完整 DLP，无法证明任意正文均无敏感内容；命中后应先修改文件，再预检。

## 确认请求

```json
{
  "files": [{"filename": "request-race.md", "content": "完整的原预检文件内容"}],
  "preview_hash": "预检返回的64位摘要",
  "idempotency_key": "import-batch-20260910-001",
  "redaction_confirmed": true
}
```

成功返回 `200`，包含 `candidate_ids`（按输入顺序，含 unchanged 的原 Candidate）和
`unchanged_count`。任意一条无效时整批失败，不部分写入。内容或绑定状态改变后旧预检返回 `409`，
应重新预检；同一幂等键提交不同请求也返回 `409`。不确认脱敏返回 `422`，批次总量超限返回 `413`。

相同认证 scope、actor 和幂等键的成功重试返回原结果。PostgreSQL 事务级 advisory lock 按文件键排序，
配合唯一主键和事务回执保证并发重试不重复创建。SQLite 仅用于快速测试，不提供生产并发保证。

文件身份由精确 `organization/team/project/personal` scope 和 `file_id` 决定；组织级调用者可以导入
多个获准的子 scope，项目级调用者不能扩大范围。数据库 static_files 和 import_receipts 的 RLS
继承关联 Candidate 的可见性。确认导入和审核发布均写入审计，审计不保存正文。

## 文件契约、哈希和更新

权威字段见 [静态文件 Schema](../../schemas/json-schema/static-experience-document.schema.json)。
首次导入省略 `experience_id` 和 `base_version`；导出时由服务端填入。

`content_hash` 可省略或保留旧值，导入时总是服务端重算。SHA-256 的输入为严格验证后、键排序的 JSON
元数据和规范化 Markdown 正文，排除 `content_hash`、`experience_id`、`base_version`；换行统一为 LF，
移除正文行末空白与首尾空行。仅改变排版或服务器分配的引用不会重复创建内容。

Compound Engineering 转换器保留原有来源哈希语义；将转换结果传给
`accremind_static_experience.markdown.render_markdown(document)` 即可生成可导入文件，导入服务按上述
规范重新计算哈希。服务不修改 Compound Engineering 原文。

`base_version` 表示编辑基于哪个已发布版本。内容改变时必须与当前版本一致；预检和发布都检查版本，
避免旧文件覆盖新经验。scope 与 owner 不能通过修订改变。修订审核完成之前，旧版本继续提供召回。
发布后版本正文保持不可变；静态来源、valid_until 和补充正文都被保留。已过期版本不进入默认召回。

当前导出接口也能导出 MCP 来源经验供阅读；此阶段仅允许有静态文件绑定的经验通过静态文件更新，
MCP 来源的修订入口留待 Experience Editor 阶段。拒绝/合并的候选不能通过 unchanged 自动恢复。

## 本地验证

```bash
make install
make db-up
make migrate
make schemas
make lint
make test
make smoke-static
```

`smoke-static` 使用本机 PostgreSQL 的非超级用户连接，创建独立 smoke 组织数据，验证并发确认、
版本更新、旧版本保留、跨 scope 访问拒绝以及无 scope 时 RLS 关闭访问。它不会删除已有业务数据。
