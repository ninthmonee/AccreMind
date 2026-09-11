# AccreMind Core API v0.1

本文档描述当前后端纵向切片已经实现的接口。开发环境默认地址为
`http://127.0.0.1:8000`，交互式 OpenAPI 页面为 `/docs`。

## 身份与权限请求头

当前版本使用开发态请求头模拟身份，后续会替换为 PAT/OIDC。除健康检查外，业务接口均需传入：

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `X-Organization-Id` | 是 | 调用者所属组织，也是所有资源的最高隔离边界。 |
| `X-Actor-Id` | 是 | 当前调用者的稳定标识。 |
| `X-Actor-Role` | 否 | `developer`、`reviewer` 或 `admin`，默认 `developer`。 |
| `X-Team-Id` | 否 | 团队范围；使用项目范围时必须同时提供。 |
| `X-Project-Id` | 否 | 项目范围，必须隶属于当前团队范围。 |
| `X-Personal-Owner-Id` | 否 | 个人范围，不可与团队或项目范围同时使用。 |

请求体中的 `requested_scope` 只能收窄请求头声明的权限，不能扩大权限。读取越权资源时统一
返回 `404`，避免泄露该资源是否存在；主动请求超出权限的召回范围时返回 `403`。

## 接口一览

### `GET /health`

检查 API 进程是否存活，不访问数据库。成功响应：

```json
{"status": "ok"}
```

### `GET /ready`

执行 `SELECT 1` 检查数据库连接。服务和数据库均可用时返回：

```json
{"status": "ready"}
```

### `POST /api/v1/candidates`

提交已验证、已确认脱敏的候选经验。接口只创建 Candidate，不会直接发布。相同组织、调用者和
`idempotency_key` 的重复请求返回同一个 Candidate，不重复创建数据。

请求体示例见
[experience-submit.valid.json](../../schemas/examples/experience-submit.valid.json)。其中：

- `candidate` 是候选经验正文，包含问题、背景、方案、失败尝试、验证证据和适用范围；
- `used_experience_ids` 记录当前任务曾参考的经验；
- `redaction_confirmed` 必须为 `true`；
- `idempotency_key` 由客户端生成并在重试时保持不变。

成功返回 `201` 和 Candidate 完整视图。字段验证失败返回 `422`。

### `POST /api/v1/candidates/{candidate_id}/prepare-review`

将 Candidate 从 `submitted` 经 `processing` 推进到 `ready_for_review`。只有
`reviewer` 或 `admin` 可调用。重复调用已处于待审核状态的 Candidate 是幂等的。

权限不足返回 `403`，资源不存在或越权返回 `404`，状态不允许转换返回 `409`。

### `POST /api/v1/candidates/{candidate_id}/publish`

发布待审核 Candidate，在同一事务内创建 Experience 和不可变的 Version 1；静态修订创建同一个
Experience 的下一版本，并校验导入基线版本。只有 `reviewer` 或 `admin` 可调用；重复发布返回
对应 Experience 的当前版本。

成功响应包含经验范围、所有者、状态及当前版本正文。状态不允许发布时返回 `409`。

### `GET /api/v1/experiences/{experience_id}`

按稳定 Experience ID 获取当前生效版本。资源不存在或超出调用者范围均返回 `404`。

### `POST /api/v1/retrieval/recall`

在权限和预算范围内召回已发布经验。请求体示例见
[recall-request.valid.json](../../schemas/examples/recall-request.valid.json)。

`budget.max_items` 限制经验条数，`budget.max_tokens` 限制指导文本的估算 Token 数。没有匹配时
返回空 `items`，并在 `gaps` 中给出 `no_matching_published_experience`，不会生成虚构经验。

当前召回实现是可解释的中英文词法匹配，尚未启用向量检索、重排和冲突检测；这些字段已经通过
契约预留。

### 静态经验与候选详情

- `GET /api/v1/candidates/{candidate_id}`：读取候选正文、静态来源与补充 Markdown，供审核使用。
- `POST /api/v1/static-import/preview`：不写入的逐文件预检。
- `POST /api/v1/static-import/commit`：确认预检并幂等、原子地创建 Candidate。
- `GET /api/v1/static-import/export/{experience_id}`：导出当前版本 Markdown。

详细请求、冲突语义和限制见 [静态导入接口](AccreMind-Static-Import-v0.1.md)。
召回 SQL 同时排除 expired 和 valid_until 已到期的版本。

## 端到端状态流

```text
POST /candidates
  submitted
      ↓ reviewer/admin
POST /candidates/{id}/prepare-review
  ready_for_review
      ↓ reviewer/admin
POST /candidates/{id}/publish
  published Experience Version 1
      ↓
POST /retrieval/recall
  Experience Pack
```

机器可读定义以 [OpenAPI Snapshot](../../schemas/openapi/accremind.openapi.json) 为准；领域对象的
独立 JSON Schema 位于 `schemas/json-schema/`。
