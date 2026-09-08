# AccreMind 核心产品需求规格 v0.2

- 状态：Current
- 日期：2026-09-09
- 首个领域：前端开发经验

## 1. 产品定义

AccreMind 是面向大模型开发任务的经验闭环平台。开发者继续使用日常的大模型或 Coding Agent；AccreMind 通过 MCP 在任务过程中召回相关经验并注入上下文，在任务完成时接收由当前大模型提炼的候选经验，经治理后进入经验库，供后续任务复用。

```text
预写静态经验 ───────────────┐
                            ▼
开发任务 → MCP 召回 → 经验注入 → 大模型完成任务
   ▲                            │
   └──── 后续任务复用 ← 审核发布 ← MCP 提交候选经验
```

产品当前只有两种经验来源：

1. 开发者提前编写并主动导入的静态经验文件；
2. 开发任务结束时，由正在工作的外部大模型提炼并通过 MCP 提交的候选经验。

AccreMind 当前不主动读取开发过程，不连接 Git、代码托管、Wiki、需求、PR、事故、聊天、监控或实时业务系统。

## 2. 核心价值

- 在问题发生时把相关历史经验送进当前大模型上下文；
- 让任务中的新发现不随会话结束而消失；
- 用候选审核阻止错误推断直接污染经验库；
- 通过作用域、适用条件、验证方式和有效期减少经验误用；
- 记录“召回 → 注入 → 使用 → 反馈”，判断经验是否真正有用。

## 3. 用户与核心场景

| 用户 | 核心需求 |
| --- | --- |
| 开发者 | 在现有大模型工作流内获得经验，不切换工具查资料 |
| 大模型 / Coding Agent | 通过 MCP 获取结构化经验并提交候选经验 |
| 经验审核者 | 判断候选经验是否准确、可复用、适用范围是否正确 |
| 管理员 | 管理成员、作用域、MCP 凭证、模型配置和审计 |

### 场景 A：任务开始或遇到问题时召回

Agent 将它已经掌握的任务信息发送给 MCP，包括问题描述、当前阶段、技术栈、项目/团队作用域、错误现象和可选代码摘要。Retriever Agent 返回精简的 Experience Pack，Agent 将其作为参考上下文继续工作。

验收：返回内容有稳定 ID、适用条件、经验正文和来源；无匹配时明确返回空结果，不生成看似合理的经验。

### 场景 B：任务完成时沉淀

Agent 根据本次会话和验证结果提炼候选经验，调用 MCP 提交。候选经验必须说明问题、上下文、解决方式、失败尝试、验证方法和适用范围。后端只做结构校验、去重建议和风险标记，不自动发布。

验收：提交成功后进入 Candidate Inbox；审核前不会被默认生产检索召回；审核者能够编辑、合并、发布或驳回。

### 场景 C：提前维护静态经验

开发者使用约定的 Markdown + YAML Front Matter 编写经验，通过 Studio 上传或 CLI 导入。重复导入使用文件 ID 和内容哈希幂等更新，变更形成版本，不直接覆盖历史。

验收：导入错误定位到文件和字段；发布经验可以重新导出为相同语义的静态文件。

### 场景 D：经验效果反馈

Agent 或开发者对召回结果反馈 `used`、`helpful`、`not_relevant`、`incorrect`、`outdated` 或 `conflicting`。任务结束时可以同时提交使用结果和候选经验。

验收：负面反馈不会立即删除经验，但会进入复核队列；错误或冲突达到策略阈值后暂停默认召回。

## 4. 核心产品模块

### 4.1 AccreMind Studio

只实现经验管理所需页面：

1. 登录与 MCP 凭证；
2. Experience Library：搜索、筛选、详情和版本；
3. Experience Editor：新建、编辑、发布、弃用；
4. Candidate Inbox：审核、修改、合并、驳回和发布；
5. Static Import：上传、预检、导入结果和导出；
6. Review Queue：错误、过期、冲突和待复核经验；
7. Usage Dashboard：召回、注入、反馈和候选发布情况；
8. Settings：团队、项目、技术栈、成员、Token 和模型配置。

暂不建设 Wiki 编译、Source Center、Material Registry、复杂 Track、代码血缘、工作流设计器或企业 Connector 管理。

### 4.2 AccreMind MCP Gateway

MCP 是核心产品入口，不是通用工具代理。首期工具固定为：

| MCP 工具 | 用途 |
| --- | --- |
| `experience_recall` | 根据当前开发问题召回并组装 Experience Pack |
| `experience_get` | 按稳定 ID 展开某条经验的完整内容和版本 |
| `experience_submit` | 提交由当前 Agent 提炼的候选经验 |
| `experience_feedback` | 报告某条经验在当前任务中的使用结果 |
| `task_complete` | 一次提交任务结果、使用反馈和零到多条候选经验 |

MCP Gateway 负责协议、认证、作用域、参数校验、限流、审计和返回预算；不直接实现检索或写数据库。

MCP 同时提供一个 `task-experience-loop` Prompt，指导外部 Agent：任务开始或遇阻时召回；只把返回内容当作有适用边界的历史经验；任务完成且经过验证后再提炼；不得提交密钥、个人信息、完整源码或未经验证的猜测。

MCP 协议本身不能感知外部任务何时结束，也不能强制 Host 调用工具，因此提供两级集成：

- **Portable 模式**：所有支持 MCP 的 Host 都可使用；依靠 MCP Prompt、项目指令或用户显式要求，尽力在结束前调用 `task_complete`。
- **Lifecycle 模式**：对支持 task/session completion Hook 的 Host 提供轻量 Adapter，在结束事件前提示当前 Agent 完成提炼和提交；Adapter 不读取或上传平台未明确提交的其他内容。

平台不得把“未调用 task_complete”解释为任务失败或经验无价值；需要单独统计闭环覆盖率。

### 4.3 AccreMind Retriever Agent

Retriever Agent 只负责寻找和组织经验：

1. 标准化问题、技术栈、错误和作用域；
2. 确定性匹配高价值触发词；
3. 执行全文与向量混合召回；
4. 根据作用域、成熟度、新鲜度和历史反馈重排；
5. 检测重复、冲突和不适用条件；
6. 在 token 预算内生成 Experience Pack；
7. 证据不足时返回空结果或缺口，不自由发挥。

首期检索最多执行一次查询改写、两路召回和一次重排，不做开放式多 Agent、多跳代码探索。

### 4.4 AccreMind Experience Service

经验领域服务负责 Schema、版本、状态机、审核、静态文件导入/导出、去重、反馈和审计。所有正式写入通过领域操作完成，客户端不能直接把 maturity 修改为 `proven`。

### 4.5 Candidate Processor

这是轻量后台处理器，不是从外部系统采集知识的 Compound Engine。它只处理 MCP 或静态文件已经提交的内容：

- Schema 校验和敏感信息检查；
- 内容哈希、近似重复和冲突检测；
- Embedding 生成与索引；
- 推荐标签、作用域和可能合并对象；
- 负面反馈触发复核；
- 到期经验进入 Review Queue。

### 4.6 AccreMind Evaluator

首期只评测经验闭环：

- Recall@K、MRR、相关/错误结果比例；
- Experience Pack 关键经验覆盖率和 token 成本；
- MCP 调用成功率和 P95；
- `recalled → injected → used → helpful` 漏斗；
- 候选提交、审核通过、合并和驳回比例；
- 相似问题首次与复用后的解决时间。

### 4.7 Agent Integration Kit

提供 MCP 配置生成器、`task-experience-loop` Prompt、项目指令片段和少量 Host Adapter。它只负责让不同大模型正确调用五个核心工具，不负责读取 Git、会话平台或其他数据源。每个 Adapter 必须声明是否支持任务完成 Hook；不支持时明确标注为 best-effort。

## 5. 经验数据模型

```yaml
id: EXP-FE-000123
title: React 快速切换筛选条件时旧请求覆盖新结果
problem: 列表快速切换筛选条件后展示了上一次请求的数据
context: React 受控筛选器；请求无法保证返回顺序
solution: 使用 AbortController 取消旧请求，或用 request sequence 只提交最新响应
failed_attempts:
  - 只在组件卸载时取消请求，无法处理组件仍挂载时的快速切换
validation:
  method: 自动化测试连续切换三个条件并故意打乱响应顺序
  result: 只展示最后一个条件的数据
applicability:
  domains: [frontend]
  technologies: [React, TypeScript]
  project_ids: [commerce-web]
  phases: [implement, troubleshoot, review]
  triggers: [数据错乱, 请求竞态, 快速切换]
source:
  type: mcp_task | static_file
  task_ref: optional-client-generated-id
quality:
  maturity: draft | verified | proven
  freshness: current | review_due | expired
governance:
  status: candidate | published | paused | deprecated | rejected
  owner: user-or-team-id
  valid_until: 2027-03-01
version: 1
```

`verified` 表示有明确验证方法和结果，不等于平台独立证明全部陈述；`proven` 只能由多次独立使用反馈或审核策略提升。

## 6. MCP 契约

### 6.1 召回请求

```json
{
  "task_id": "client-task-123",
  "query": "React 表单回填后提交的还是旧值",
  "scope": {"team_id": "frontend", "project_id": "commerce-web"},
  "context": {
    "phase": "troubleshoot",
    "technologies": ["React", "TypeScript"],
    "error": "optional concise error",
    "attempted": ["optional concise attempt"]
  },
  "budget": {"max_items": 6, "max_tokens": 2400}
}
```

返回 `retrieval_id`、经验列表、适用性说明、冲突、缺口和精简引用。MCP 返回不得包含平台内部推理过程或其他团队不可见信息。

### 6.2 候选提交

```json
{
  "task_id": "client-task-123",
  "candidate": {
    "title": "...",
    "problem": "...",
    "context": "...",
    "solution": "...",
    "failed_attempts": [],
    "validation": {"method": "...", "result": "..."},
    "applicability": {"technologies": [], "project_ids": [], "triggers": []}
  },
  "used_experience_ids": ["EXP-FE-000123"],
  "redaction_confirmed": true
}
```

提交结果只能是 `candidate_id + review_status + duplicate_suggestions`，不允许 MCP 调用方自行发布。

## 7. 静态文件规范

- 格式：UTF-8 Markdown + YAML Front Matter；
- 一文件一条经验，正文允许补充解释和短代码片段；
- 必填：id/title/problem/solution/applicability/owner；
- 建议：failed_attempts/validation/triggers/valid_until；
- 导入渠道仅为 Studio 上传或 `accremind import <directory>`；
- 不监听仓库、不自动扫描磁盘、不建立通用 Connector；
- 默认拒绝二进制附件、完整源码包和超过大小限制的文件。

## 8. 权限与隐私

- 作用域首期为 `organization → team → project → personal`；
- 召回前完成 team/project 权限过滤；
- MCP 使用个人 Token 或工作负载 Token，Token 只展示一次并可撤销；
- 提交内容进行密钥、凭证、个人信息和超长代码检查；
- 经验正文视为不可信数据，不得覆盖 MCP 系统指令；
- 默认不保存完整会话，只保存 Agent 主动提交的结构化经验和任务摘要；
- 审计记录谁召回、提交、审核、发布、修改和弃用，不记录不必要的原始 Prompt。

## 9. 非功能需求

- MCP Gateway 可用性目标 ≥ 99.9%；
- `experience_recall` P95：无模型重排 ≤ 1.5 秒，有模型重排 ≤ 4 秒；
- 100% 召回结果包含稳定 ID、版本和适用范围；
- Candidate 与 Published 查询物理或逻辑强隔离；
- 后台任务至少一次执行且幂等；
- 经验和静态文件可逆导入导出；
- Embedding、重排模型和模型供应商可替换；
- 所有索引可从 PostgreSQL 事实数据重建。

## 10. P0、P1 与非目标

### P0：形成可用闭环

- Studio 的经验库、编辑器、Candidate Inbox、静态导入和 MCP Token；
- 五个 MCP 工具与任务闭环 Prompt；
- PostgreSQL 全文 + pgvector 混合召回；
- Retriever Agent 与 Experience Pack；
- 候选校验、去重、Embedding 和审核发布；
- 基础权限、审计、反馈和离线检索评测；
- 一个外部 Coding Agent 的真实接入说明与端到端验证。
- Agent Integration Kit 的 Portable 模式，以及至少一个支持完成 Hook 的 Lifecycle Adapter。

### P1：改善质量和运营

- Cross-encoder/模型重排与查询改写；
- 相似经验合并和冲突检测；
- Review Queue、成熟度和有效期策略；
- 团队/项目作用域提升；
- 更多 Agent Host 的配置模板；
- 使用效果和复用收益看板。

### 当前明确不做

- Git、代码托管、Wiki、需求、PR、事故、聊天、监控和实时业务系统连接；
- 自动监听或抓取开发者工作内容；
- 通用 Connector SDK/Hub；
- Wiki 编译、代码导航和 AST 索引；
- Spec/Track/代码 Diff/发布血缘；
- Agent 执行、沙箱和多 Agent 编排；
- 自动发布大模型提炼内容；
- OpenSearch、图数据库、Kafka、Temporal 和独立 Vector DB；
- 全功能企业内容管理平台。

## 11. P0 完成标准

1. 至少导入 50 条经过人工确认的前端静态经验；
2. 30 个真实或脱敏开发问题形成可重复评测集；
3. 核心问题 Recall@5 ≥ 85%，错误经验率有稳定基线；
4. 至少一个日常 Coding Agent 完成任务前召回和任务后提交；
5. 100 个 MCP 任务中没有候选经验绕过审核进入正式库；
6. 能举证至少 5 次后续任务复用了历史经验；
7. 跨团队/项目越权测试全部失败关闭；
8. 静态经验完成导入、修改、版本化和可逆导出。
9. 分别统计 MCP 安装覆盖率、召回覆盖率和 task_complete 闭环覆盖率，不将三者混为一个指标。
