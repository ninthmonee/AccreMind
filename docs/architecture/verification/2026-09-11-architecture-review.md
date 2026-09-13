# 架构一致性与可实施性审查

日期：2026-09-11。审查对象：PRD V2.1、四份架构/任务文档、OpenAPI、JSON Schema、MCP 定义、两份 SQL，以及已有验证记录。

> 历史审查：R1—R9 已于 2026-09-12 在阶段 A 修订；旧版位置行号仅用于还原当时问题，不代表 v2 当前行号。当前规则见[阶段 A 记录](2026-09-12-phase-a-validation.md)与[后端 B20](../03-后端架构设计.md#b20-阶段-a契约-v2-的闭环与修订规则)。应用实现仍待后续真实验收。

结论：总体架构合理，与 PRD 的核心方向一致；但当前版本尚不适合作为无需澄清即可实现的完整详细设计。发现 5 项 P1 流程/数据缺口和 4 项 P2 契约或交互问题。建议先修复 P1，再冻结 D01 契约。无需推倒三端分工或改成微服务。

这里的 P1 表示应在相关功能开工前解决的设计阻断；P2 表示会造成联调返工或行为不一致。没有应用代码，因此下列为设计审查结论，不是已在运行系统中复现的漏洞。本文未修改原架构、PRD、契约或 SQL。

## 合理且值得保留的部分

- API 与 Worker 分进程的模块化单体，加 PostgreSQL 任务队列，符合首个 20 人试点的复杂度；没有必要提前拆微服务。
- 将代码可恢复、已有权威来源、真实知识增量和检查不完整分开，且允许零产出，符合产品目标。
- 发布、成熟度、时效、服务状态四维分离；引用不直接晋升成熟度，人工审核与验证分离。
- Git 先落不可变内容、数据库激活、outbox 更新索引，以及返回前重新授权的总体一致性方案成立。
- 明确 RLS 只隔离租户、同租户内容仍需 ACL，且客户端不承担最终授权，边界合理。
- 先关键词检索和人工基线检查，再由评测决定是否增加向量检索、自动检查，实施顺序合适。

## P1：应先修复的设计缺口

### R1. 管理操作需要的聚合版本没有读取路径

位置：[后端 B11.1](../../../docs/architecture/03-后端架构设计.md:279)、[KnowledgeItem](../../../docs/architecture/contracts/openapi.json:9016)、[ReadResult](../../../docs/architecture/contracts/openapi.json:9222)。

文档正确区分 `knowledge_entries.revision`（聚合状态版本）与正文 revision，并明确 API item.revision 是正文版本。然而列表、详情、历史返回均没有聚合版本字段，暂停/撤回/归档等操作却要求 `expected_revision`。

例如正文仍是第 1 版，状态经过一次修改后聚合版本为 2；重新加载详情仍只得到正文版本 1。新打开页面的管理者无法取得正确 CAS 条件，也无法按设计在 409 后重新获取最新状态版本。不能依靠此前某次 MutationResult，因为新会话没有该结果。

建议：管理读取返回显式 `aggregate_revision` 与 `content_revision`，或者提供携带聚合版本的 ETag；所有管理写操作明确 expected_revision 对应哪个聚合。保留正文 revision 用于引用和验证。验收覆盖“正文不变、状态连续修改、页面刷新后再次操作”。

### R2. 正文修订候选没有持久化目标知识与基线版本

位置：[创建修订接口](../../../docs/architecture/contracts/openapi.json:2679)、[candidates 表](../../../docs/architecture/data/001_initial_schema.sql:88)、[发布规则](../../../docs/architecture/03-后端架构设计.md:365)。

`POST /knowledge/{id}/revisions` 创建候选，但 CandidateBody、Candidate 和 candidates 表均未定义 `target_knowledge_id` 或修订基线。后续 publish 只指向 candidate；publications.knowledge_id 可以保存发布结果，但没有规定创建修订时如何持久保存目标，以及激活时检查哪个知识聚合版本。

因此 URL 中的目标不能可靠传递至后续独立审核、异步 Worker 和崩溃恢复。两个针对同一旧正文创建的候选也没有明确的“第二个批准后是否必须重做合并”规则。只锁候选不能解决不同候选竞争同一知识的问题。

建议：持久化候选的创建类型、目标 knowledge_id、base_content_revision 和目标聚合版本；发布时锁定目标 knowledge_entries 并执行明确的 CAS。基线过期必须重新核对，不能静默覆盖另一修订。新建候选与修订候选分别定义返回和状态语义。

### R3. 新提交证据的 ID 获取和版本读取没有闭环

位置：[EvidenceInput](../../../docs/architecture/contracts/openapi.json:8753)、[IngestResult](../../../docs/architecture/contracts/openapi.json:8854)、[Contribution](../../../docs/architecture/contracts/openapi.json:8920)、[证据读取接口](../../../docs/architecture/contracts/openapi.json:5444)。

上传证据由后端生成 ID，但 IngestResult 和 Contribution 没有返回证据映射，也没有按 contribution 列出证据的接口。Assessment、Validation 和候选的证据引用却要求服务端 evidence ID/revision。不能依赖模型碰巧在候选中引用它：零候选、无模型的人工导入、单独提交验证材料都需要独立取得证据 ID。

此外 EvidenceRef 使用 `(id, revision, locator)`，SQL 的证据主键也包含 revision，而 `GET /evidence/{id}` 只有 id 参数。多版本证据如何读取审批绑定的确切版本未定义。

建议：返回稳定的上传项标识到 EvidenceRef 的映射，或增加授权的 contribution evidence 列表；证据读取显式支持 revision，并核验该版本的权限/状态。覆盖“无模型、零候选、上传验证材料后提交验证”和“同证据 ID 多版本”用例。

### R4. CLI 票据批准/拒绝这一步没有接口契约

位置：[工具端登录时序](../../../docs/architecture/01-工具端架构设计.md:221)、[后端 B12](../../../docs/architecture/03-后端架构设计.md:294)、[认证接口起点](../../../docs/architecture/contracts/openapi.json:7519)。

现有 API 只有 start、exchange、refresh、logout。浏览器要读取票据详情并明确批准/拒绝，但契约没有这两个动作，也没有定义其绑定 state、租户选择、请求范围、过期票据和重复批准的规则。

这不是 OIDC provider 的标准 authorize/token/callback 可以替代的步骤，而是本项目自定义票据状态从 pending 到 approved/denied 的业务动作。开发者需要自行补接口才能完成登录闭环。

建议：补充票据展示与决定接口，限定已登录 Web 会话，定义 CSRF/Origin、票据有效性、主体/租户及固定工具能力范围的服务端绑定。start/exchange/refresh 的 `security: []` 与 `x-capability: knowledge:read` 也应区分为公开认证入口，避免通用 capability 中间件误要求先登录。

### R5. Refresh token 重用检测缺少历史关联数据

位置：[会话表](../../../docs/architecture/data/002_identity_schema.sql:11)、[轮换规则](../../../docs/architecture/03-后端架构设计.md:304)。

文档要求轮换后重用旧 refresh token 会撤销会话族，但 sessions 只有一个当前 refresh_hash。若轮换覆盖旧 hash，旧 token 再出现时只能发现“不匹配当前令牌”，无法识别它属于哪个会话族，更无法按约定撤销该族。

建议：增加历史 token hash 到 session/family 的关联及 consumed/revoked/过期状态，或明确可验证且能定位会话族的令牌格式。保留期应覆盖重放检测需要；另定义刷新成功但响应丢失时的恢复行为。本地刷新锁只能解决客户端并发，不能替代服务端历史关联。

此处借鉴 [RFC 9700 §4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2) 对轮换保留关联信息的说明，不将本项目票据协议宣称为标准 OAuth 实现。

## P2：应随契约冻结一并修正

### R6. 详情与历史读取复用了检索摘要，无法返回完整条目

位置：[KnowledgeItem / ReadResult](../../../docs/architecture/contracts/openapi.json:9016)、[前端详情要求](../../../docs/architecture/02-前端架构设计.md:101)。

search、read、管理列表和历史列表都复用 KnowledgeItem。它缺少 owner、type、knowledge_role、invalidation_triggers、alternatives、enforcement、mirror 等完整正文/治理字段；ReadResult 只补 publication_status、serving_status 和 budget。既不能满足 get-knowledge 的完整条目承诺，也不能正确展示镜像身份、责任人、失效条件和实际约束状态。严格 additionalProperties=false 下，后端不能临时多返回这些字段。

建议：拆分 SearchHit、KnowledgeDetail、KnowledgeRevisionSummary。详情提供完整正文和必要治理状态；历史条目明确当前/已替代状态与授权读取语义。预算不足时用显式摘要/可展开结果分支，不能以截断文本冒充完整详情。

### R7. 批准记录无法稳定恢复为后续发布输入

位置：[MutationResult](../../../docs/architecture/contracts/openapi.json:9270)、[PublishRequest](../../../docs/architecture/contracts/openapi.json:9422)、[ReviewView](../../../docs/architecture/contracts/openapi.json:9519)。

review 返回通用 `{id, revision, status}`，没有说明 id 是候选还是 review。publish 必需 review_id，但 ReviewView 没有当前有效批准记录，也没有查询某候选 reviews 的接口。即使约定首次响应的 id 为 review_id，刷新页面或另一名发布者接手时仍无法从候选视图恢复该批准。

建议：review 返回具名 ReviewRecord；ReviewView 返回当前有效批准及其 candidate/assessment/hash/scope 绑定，失效时明确 stale。不要用审计记录或客户端猜测推导业务必需 ID。

### R8. 规范镜像的前端发布条件与后端例外不一致

位置：[前端 F10](../../../docs/architecture/02-前端架构设计.md:185)、[后端 B5](../../../docs/architecture/03-后端架构设计.md:131)。

后端允许权威镜像在 link_existing 判定基础上申请正文发布；前端 F10 则概括规定 link_existing 路由完成后没有发布按钮。后半句虽提到镜像门槛，却没有把它写成状态机的例外路径。严格按前半句实现会挡住合法镜像，或者迫使开发者错误改成 knowledge_candidate。

建议：明确 authoritative_mirror + link_existing 的申请、独立批准和发布分支；普通 link_existing 仍不可发布。添加保留原 disposition 的镜像端到端用例。

### R9. “未知字段必拒绝”不能仅靠 Fastify 默认校验实现

位置：[后端 B10](../../../docs/architecture/03-后端架构设计.md:227)、[后端 B17](../../../docs/architecture/03-后端架构设计.md:431)、[Schema bundle](../../../docs/architecture/contracts/schemas.json:2)。

文档要求额外 actor/maturity 字段被拒绝，但 Fastify 的默认 Ajv 配置包含 `removeAdditional: true`，可能先删除未知字段再继续接受请求。这不等于可伪造权威字段，但与“拒绝非法输入”的契约及负例验收不一致。另外 bundle 声明 Draft 2020-12，应明确对应编译器与响应序列化适配，不能假定直接挂默认校验器即可。

建议：冻结请求 validator 配置，至少明确 `removeAdditional: false`，区分请求验证与响应序列化，选择显式 Ajv2020 或受测试的契约转换路径；在 D01 加入实际编译与额外字段负例。

依据：[Fastify 官方校验文档](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[Ajv JSON Schema 版本支持](https://ajv.js.org/json-schema.html#draft-2020-12-breaking)。

## 合理性上的补充建议（不作为已确认缺陷计数）

- **保留证据的迁移规则需要补详细时序。** 30 天原始证据到期前转为 retained 对象，如果证据 ID/hash/locator 改变，会影响审批指纹；应规定发布前固定最小审核证据，或定义重新绑定和审核规则。不要让正常保留清理破坏在用知识的可追溯性。
- **导航产物需要可消费入口。** 已有 navigation_items 表，但检索契约只返回知识条目，没有明确导航/链接如何被用户检索和使用。产品若仍承诺降低已有材料发现成本，应补入口，或者明确首版只保存分流记录、后续开放导航检索。
- **S1 验收与任务依赖需对齐。** S1 包含 T07 的完整 8 工具桥接，但使用/验证/反馈依赖的 B08 在 S2。建议明确 S1 验收工具子集、未就绪工具行为，S2 再验收完整 8 工具，避免在 S1 用 Mock 冒充完整完成。
- **Git 方案有合理性，但增加跨存储运维成本。** 它来自 PRD 的内容版本/可迁移要求，现阶段无需推翻；需要尽早做同一条知识两次修订、索引乱序、历史清理和备份恢复的纵向验证。只有收益不足时再通过 ADR 讨论替换。

## 本次实际验证范围

通过 Python 标准库重新解析并比较，得到：

| 检查 | 本次结果 |
| --- | --- |
| JSON 解析 | 三份 JSON 均成功 |
| 路径、操作、schema、工具计数 | 48 路径、54 操作、93 schema、8 MCP 工具 |
| OpenAPI 与 Schema bundle | 规范化 `$ref` 后 93 个 schema 完全相同 |
| MCP 输出 | 8 个工具的展开输出均与 OpenAPI data schema 一致 |
| MCP 请求体 | 6 个有 JSON 请求体的工具均与 OpenAPI 展开输入一致 |
| 内部 `$ref`、required/properties | OpenAPI 和 bundle 未发现悬空引用或缺失必填属性定义 |
| 业务流程 | 人工逐项对照，发现上述 9 项问题 |

本次没有重新执行 PostgreSQL 迁移、RLS/并发实验、真实宿主、OIDC 或浏览器 E2E。已有记录声称临时 PostgreSQL 迁移通过，本报告不把该记录当作本次重跑结果。当前 Python 没有 jsonschema/openapi_spec_validator；以上结构比较不等于完整第三方 OpenAPI 语义验证。

建议修复顺序：R1/R2 版本与修订模型 → R3 证据闭环 → R4/R5 认证 → R6/R7/R8 界面与契约 → R9 契约编译验证。随后按“纯人工导入 → 获取证据 ID → 判定 → 独立批准 → 刷新页面 → 发布 → 修订 → 再发布 → 暂停/撤回”的最小流程做一次契约级演练，再启动三端全面实现。
