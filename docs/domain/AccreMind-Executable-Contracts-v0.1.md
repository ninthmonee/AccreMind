# AccreMind 可执行领域契约 v0.1

- 状态：Implemented
- 日期：2026-09-09
- 权威来源：`accremind_contracts` Pydantic 模型与 `accremind_experience_domain` 领域规则

## 1. 契约边界

Pydantic 模型定义所有跨进程数据形状，并用于生成 JSON Schema。它们不作为 SQLAlchemy Model，也不直接承担持久化和复杂业务操作。

领域包定义状态转换、成熟度晋升和 scope 收窄规则。未来的 FastAPI、MCP Gateway、CLI 和 Worker 必须调用这些规则，不允许通过通用字段更新绕过它们。

```text
Pydantic contracts
├── MCP tool input/output schema
├── HTTP/OpenAPI DTO
├── static file front matter validation
└── worker message validation

Domain rules
├── candidate lifecycle
├── experience lifecycle
├── maturity promotion
└── authenticated scope constraints
```

## 2. 标识与幂等

- 所有外部标识为 1–128 字符，只允许字母、数字、点、下划线、冒号和连字符。
- `experience_submit` 和 `task_complete` 必须携带调用方生成的 `idempotency_key`。
- `task_id` 是调用方关联一次开发任务的稳定标识，不是权限依据。
- 正式 `experience_id` 由服务端生成。
- 静态文件使用作者维护的稳定 `file_id`；首次导入时 `experience_id` 可以省略，提交后导出的文件必须包含服务端分配的 `experience_id`。
- `content_hash` 是规范化 Front Matter 与 Markdown 正文的 SHA-256，小写十六进制字符串。

数据库实现必须对“认证主体 + 操作类型 + idempotency_key”建立唯一约束。

## 3. Candidate 状态机

| 当前状态 | 操作 | 目标状态 | 执行主体 |
| --- | --- | --- | --- |
| `submitted` | `start_processing` | `processing` | Worker/Application Service |
| `processing` | `mark_ready` | `ready_for_review` | Worker/Application Service |
| `processing` | `reject` | `rejected` | Reviewer/System policy |
| `ready_for_review` | `publish` | `published` | Reviewer |
| `ready_for_review` | `merge` | `merged` | Reviewer |
| `ready_for_review` | `reject` | `rejected` | Reviewer |

`published`、`merged` 和 `rejected` 是 Candidate 的终态。MCP 提交接口只能创建 `submitted` Candidate，不能传入或修改状态。

## 4. Experience 状态机

| 当前状态 | 操作 | 目标状态 |
| --- | --- | --- |
| `published` | `pause` | `paused` |
| `published` | `deprecate` | `deprecated` |
| `paused` | `republish` | `published` |
| `paused` | `deprecate` | `deprecated` |

`deprecated` 是终态。Experience 状态属于经验聚合；Experience Version 发布后不可变。内容修订必须创建 `version + 1`，不得覆盖旧版本。

## 5. 成熟度与新鲜度

成熟度和发布状态相互独立：

- `draft → verified`：必须存在验证方法和验证结果；
- `verified → proven`：默认至少有两个独立任务给出 helpful 使用证据；
- 调用方不能在提交时自行声明 `proven`。

新鲜度为 `current`、`review_due` 或 `expired`。到期策略由 Worker 计算；`expired` 默认不进入生产召回。

## 6. Scope 规则

层级是 `organization → team → project`，personal scope 与 team/project scope 互斥。

- 请求可以省略 scope，此时使用 Token 的完整 scope；
- organization Token 可以收窄至本组织的 team/project；
- team Token 可以收窄至同一 team 的 project；
- project Token 只能访问相同 project；
- personal Token 只能使用完全相同的 personal scope；
- 请求体中的 organization/team/project 永远不能扩大 Token 权限。

未来数据库必须以 PostgreSQL RLS 作为最后一道隔离防线。

## 7. 提交和完成规则

- `experience_submit.redaction_confirmed` 必须为 `true`；
- `task_complete.redaction_confirmed` 必须为 `true`；
- 未验证完成的任务可以提交反馈，但不能提交 Candidate；
- `task_complete` 中所有反馈必须引用同一个 `task_id`；
- 所有 DTO 拒绝未知字段；文本、列表、返回条目和 token budget 都有上限。

敏感信息扫描仍必须在 Gateway 和 Worker 执行；`redaction_confirmed` 只是调用方声明，不替代服务端扫描。

## 8. 生产召回不变量

未来 Repository 和数据库实现必须保证：

1. Retriever 只能读取 Published Corpus；
2. Candidate、Paused、Deprecated 和 Expired 数据默认不可召回；
3. 权限过滤在 FTS 和向量检索之前进入 SQL；
4. 返回项必须包含稳定 ID、版本、适用范围、成熟度和新鲜度；
5. 无合格结果时返回合法的空 `ExperiencePack`，不得生成经验正文。

建议给 Retriever 使用只读数据库角色和只暴露 Published 数据的视图，避免依赖调用方记住状态过滤条件。

## 9. 生成与验证

`make schemas` 从 Pydantic 模型重新生成 `schemas/json-schema`。生成结果必须提交 Git；CI 应重新生成并通过 `git diff --exit-code -- schemas/` 检查漂移。

当前测试覆盖：

- 未确认脱敏的提交被拒绝；
- 未验证任务不能提交 Candidate；
- Candidate 不能绕过处理和审核直接发布；
- Deprecated Experience 不能恢复；
- project scope 不能越权扩大到 team；
- 跨 organization 请求被拒绝；
- 成熟度晋升需要验证证据和独立 helpful 使用；
- 静态文件 ID 与 SHA-256 格式；
- 未知字段和超预算请求被拒绝。

