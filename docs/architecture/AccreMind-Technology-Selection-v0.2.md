# AccreMind 核心版技术选型 v0.2

- 状态：Current
- 日期：2026-09-09
- 约束：只接收 MCP 提交经验和人工静态文件，不建设外部数据连接器

## 1. 选型结论

核心版统一使用 TypeScript，采用四个运行单元：Studio Web、Core API、MCP Gateway 和 Worker。Retriever Agent 保留独立模块边界，但首期与 Core API 同进程部署。PostgreSQL + pgvector 同时承担经验事实库、全文检索和向量检索。

```text
Coding Agent / LLM Host                 Developer
          │ MCP                           │ Web / CLI
          ▼                               ▼
  AccreMind MCP Gateway ────────► AccreMind Core API
                                          │
                     Experience Service · Retriever Agent
                     Candidate Service  · Static Import
                                          │
                                  PostgreSQL + pgvector
                                          ▲
                             Worker ───────┘
                    validate / redact / embed / dedup
```

这是完整但收敛的产品架构：具备 UI、API、MCP、检索、经验治理、异步处理、权限、审计和评测，而不承担外围系统集成。

## 2. 技术栈

| 范围 | 选择 | 说明 |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | 管理应用与共享包 |
| 语言 | TypeScript on Node.js | 前后端、MCP、Retriever 和 Worker 统一语言 |
| Studio | Next.js + React | 经验管理、审核和设置 |
| UI | Tailwind CSS + Radix primitives | 轻量设计系统 |
| 数据交互 | TanStack Query + TanStack Table | Library 与 Inbox 核心交互 |
| 编辑器 | Monaco Editor | Markdown、Front Matter 和版本 Diff |
| Core API | Fastify + TypeBox | 低开销、Schema 驱动、易拆模块 |
| 数据访问 | Drizzle ORM + 参数化 SQL | 领域写入用 ORM，FTS/vector 用 SQL |
| MCP | 官方 MCP TypeScript SDK v2 | Streamable HTTP + stdio |
| 数据库 | PostgreSQL + pgvector | Canonical、FTS、vector、版本和审计 |
| 后台任务 | pg-boss | 复用 PostgreSQL，不引入额外队列基础设施 |
| 静态格式 | Markdown + YAML Front Matter | 人工编写与可逆导入导出 |
| 契约 | TypeBox + JSON Schema | REST、MCP、文件共享定义 |
| 测试 | Vitest + Testcontainers + Playwright | 单元、数据库集成和 UI E2E |
| 可观测性 | OpenTelemetry | trace、metric、log 关联 |
| 本地环境 | Docker Compose | PostgreSQL/pgvector + 应用 |
| 生产环境 | Docker；规模需要时 Kubernetes | 不把 K8s 作为开发前提 |

正式 Gateway 使用官方 MCP SDK v2，不再扩展仓库中的手写 JSON-RPC 实验。[MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)

## 3. 为什么采用单 TypeScript 技术栈

当前 Retriever Agent 的职责是结构化查询理解、规则触发、PostgreSQL 混合召回、有限查询改写、重排和打包，不需要自训练模型或复杂数据科学流水线。统一 TypeScript 可以共享 Schema、减少双构建和跨服务契约，并先证明经验闭环。

通过 `EmbeddingProvider`、`QueryRewriter` 和 `RerankerProvider` 保留替换边界。只有出现本地 GPU 推理、自训练 reranker 或大规模离线实验等明确需求时，才增加 Python inference/evaluation worker。

## 4. 正式模块边界

```text
apps/
├── studio-web/                 # Next.js
├── core-api/                   # Fastify REST API
├── mcp-gateway/                # 官方 MCP SDK
└── worker/                     # pg-boss consumers
packages/
├── contracts/                  # TypeBox/JSON Schema 与生成类型
├── experience-domain/          # 聚合、状态机、版本和审核规则
├── retriever-agent/            # 检索、融合、重排和 Experience Pack
├── candidate-processor/        # 校验、脱敏、去重和索引
├── static-experience/          # Markdown 导入、预检和导出
├── auth-policy/                # Token、scope 与权限
├── evaluation/                 # dataset、scorer 和报告
├── observability/              # OpenTelemetry 约定
├── agent-integration/          # MCP 配置、Prompt 与可选 Host hooks
└── design-system/
schemas/
├── experience.schema.json
├── mcp-tools.schema.json
└── events.schema.json
evals/
├── datasets/
├── judgments/
└── reports/
deploy/
└── compose/
```

MCP Gateway 不访问数据库；它验证身份和 MCP 参数后调用 Core API。Worker 只消费领域命令产生的任务，不绕过 Experience Service 修改发布状态。

## 5. PostgreSQL 数据设计

核心表：

- `organizations`、`teams`、`projects`、`users`、`memberships`；
- `api_tokens`：只保存 hash、scope、到期和最后使用时间；
- `experiences`：稳定 ID、当前发布版本和治理状态；
- `experience_versions`：不可变正文、适用范围、内容哈希和创建者；
- `experience_embeddings`：模型、维度、文本哈希和 vector；
- `experience_triggers`、`experience_relations`；
- `candidates`、`candidate_duplicate_matches`、`reviews`；
- `retrieval_runs`、`retrieval_hits`、`experience_feedback`；
- `task_completions`：只保存结构化任务摘要和候选关联；
- `static_imports`、`static_import_items`；
- `audit_events`。

Candidate 和 Published 必须通过状态与查询隔离；生产 Retriever 只查询 `published` 且未暂停、未过期的版本。

## 6. Retriever Agent

### 6.1 有限状态机

```text
validate request
→ enforce organization/team/project scope
→ normalize query and technology aliases
→ deterministic trigger lookup
→ PostgreSQL FTS + pgvector retrieval
→ reciprocal rank fusion
→ applicability / maturity / freshness / feedback rerank
→ conflict and duplicate grouping
→ token-budgeted Experience Pack
→ empty result or response
```

首期最多一次可选查询改写，不做无限 ReAct 循环。提供三种模式：

- `fast`：确定性触发 + FTS/vector + 本地打分；
- `balanced`：增加一次查询改写或模型 rerank；
- `strict`：不调用生成模型，只返回直接命中的已发布经验。

### 6.2 混合检索

- `tsvector`/GIN 处理术语、错误文本和技术名称；
- pgvector HNSW 处理语义相似；
- RRF 融合排名，不直接混合不可比的原始分数；
- team/project scope、status 和 valid_until 在召回 SQL 中执行；
- 保存 rank、score feature、模型/索引版本和命中版本；
- 定期用 exact search 对 HNSW 做 recall 基准。

pgvector 支持 HNSW、FTS 混合和迭代扫描，足以覆盖核心版；现阶段不引入 OpenSearch 或独立 Vector DB。[pgvector 官方文档](https://github.com/pgvector/pgvector)

### 6.3 模型边界

```ts
interface EmbeddingProvider { embed(texts: string[]): Promise<Vector[]> }
interface QueryRewriter { rewrite(input: RecallInput): Promise<string[]> }
interface RerankerProvider { rerank(query: string, items: Candidate[]): Promise<Score[]> }
```

默认接入 OpenAI-compatible HTTP API。模型、endpoint、维度和版本必须配置化；Embedding 切换建立新索引版本，不能在同一索引混用不同模型向量。

## 7. MCP Gateway

- 使用官方 SDK 注册五个工具和一个 Prompt；
- 本地 Agent 使用 stdio，远程团队使用 Streamable HTTP；
- Tool Schema 从 `packages/contracts` 生成；
- 个人 Access Token/PAT 解析为 organization/team/project 权限；
- 返回短文本 `content` 和机器可读 `structuredContent`；
- 每次调用生成 `trace_id`、`retrieval_id` 或 `candidate_id`；
- 返回内容明确标注“历史经验有适用边界，必须结合当前任务验证”；
- `experience_submit` 和 `task_complete` 只能创建 Candidate。

MCP 不能主动获知 Host 任务生命周期。`packages/agent-integration` 提供 Portable 配置/Prompt，以及按 Host 隔离的可选 completion hook adapter；核心领域不能依赖某个 Host 私有 API。对没有 hook 的 Host，任务结束沉淀只能是 best-effort，并纳入覆盖率指标。

## 8. 静态经验导入

静态导入不是 Connector：

1. Studio 上传文件，或 CLI 读取用户明确指定的目录；
2. 解析 Markdown Front Matter；
3. 执行 Schema、大小和敏感信息预检；
4. 展示新增、更新、冲突和失败的 dry-run；
5. 用户确认后创建 Candidate 或受权限控制的 Draft；
6. 发布后异步生成 embedding；
7. 可按 team/project 导出静态经验包。

服务不会自行扫描磁盘、监听仓库或同步外部文件变化。

## 9. Candidate Processor

pg-boss 任务：

- `candidate.validate`：Schema、长度、代码比例、敏感信息；
- `candidate.deduplicate`：内容 hash + vector 相似候选；
- `experience.embed`：按内容 hash 幂等生成向量；
- `experience.review_due`：扫描 valid_until；
- `feedback.aggregate`：汇总负面反馈并生成复核项；
- `evaluation.run`：执行固定数据集。

所有任务携带幂等键并支持失败重试。当前没有跨系统长流程，因此不引入 Temporal。

## 10. 权限与安全

- 首期提供本地管理员和 PAT；团队部署可接 OIDC，但不自建身份平台；
- 应用层 RBAC + organization/team/project scope；
- PostgreSQL Row Level Security 作为生产隔离防线；
- Token 使用强随机值，只保存 hash，可撤销、到期和限定工具；
- Prompt/经验正文按不可信数据处理；
- 提交前后做 secret/PII 规则检查，超长代码默认拒绝；
- 不保存完整外部会话；
- 日志和 trace 默认不记录 MCP 原始正文；
- 审核、发布、弃用、Token 和权限变化写不可变审计事件。

首期不引入 OPA。策略复杂到需要独立声明语言之前，使用版本化 TypeScript Policy 模块，避免维护两套权限真相。

## 11. API 与事件

```text
POST /v1/recall
GET  /v1/experiences/:id
POST /v1/candidates
POST /v1/feedback
POST /v1/tasks/complete
GET  /v1/experiences
POST /v1/experiences
POST /v1/candidates/:id/review
POST /v1/static-imports/preview
POST /v1/static-imports/:id/commit
POST /v1/tokens
DELETE /v1/tokens/:id
```

领域事件先使用 PostgreSQL Outbox：`candidate.submitted`、`candidate.reviewed`、`experience.published`、`experience.paused`、`experience.deprecated`、`experience.recalled`、`experience.feedback_received`、`task.completed`。当前没有跨系统消费者，不引入 Kafka。

## 12. 可观测与评测

- OpenTelemetry trace：MCP → Core API → Retriever → PostgreSQL/model；
- 关键属性：team/project、tool、retrieval_id、query_mode、embedding_model、index_version、hit_count、latency；
- 原始 query 和经验正文默认不进入 trace；
- 检索数据集使用 JSONL，Judge 结果保留人工 gold labels；
- 观测后端可被企业平台替换，不作为领域依赖。

[OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/) 提供 traces、metrics 和 logs 的统一语义约定。

## 13. 已删除或延后的技术

| 删除/延后 | 当前原因 |
| --- | --- |
| Connector Hub 与外部连接器 | 经验只有 MCP 和静态文件两个入口 |
| Python 检索服务 | 当前能力 TypeScript 足以承担 |
| S3/MinIO | 首期不接附件和原始快照 |
| Redis | pg-boss 和 PostgreSQL 足够 |
| Temporal | 没有跨系统长流程 |
| Kafka/Redpanda | 没有大量事件消费者 |
| OpenSearch | PostgreSQL FTS + pgvector 足够 |
| Tree-sitter/代码索引 | 不读取代码仓库 |
| Neo4j | 核心经验关系可由 PostgreSQL 表表达 |
| OPA/Keycloak | 首期策略和身份复杂度不足以抵消运维成本 |

## 14. 开发顺序

1. 重组 monorepo、共享 Schema、Docker Compose 和 CI；
2. PostgreSQL 经验、版本、Candidate、权限、反馈和审计模型；
3. Experience Service、静态文件 parser 和导入预检；
4. FTS + pgvector Retriever Agent 和离线评测；
5. 使用官方 SDK 实现五个 MCP 工具和 Prompt；
6. 实现 Portable Integration Kit 和一个有 completion hook 的 Host Adapter；
7. Studio Experience Library、Editor、Candidate Inbox 和 Token；
8. Worker 的校验、脱敏、去重、Embedding 和到期复核；
9. 接入一个真实 Coding Agent，完成召回 → 注入 → 完成 → 提交 → 审核 → 再召回；
10. 根据真实评测再决定是否增加模型 rerank、OIDC 或独立 Retriever 服务。
