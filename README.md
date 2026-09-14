# AccreMind · AI 研发知识基座

团队研发知识基础设施：优先保存当前代码与权威文档无法可靠恢复的必要上下文，要求证据、适用条件、独立审核和纠错。

当前完成阶段 A 设计修订、阶段 B 工程基线、阶段 C 数据库事务与 scope 授权基础，以及 B03/B05/B06/B07/B08/B09 的合成贡献、判定、发布、检索、独立验证和配置版本。Web 已接通知识列表 → 详情 → 检索，以及工程概览中的配置读取演练；真实登录、宿主采集/安装和完整业务管理表单尚未实现。默认 HTTP 仍只提供无内容权限的 loopback 合成身份，显式开启后可演练业务接口，不代表生产服务验收。

## 工程结构

```text
apps/api          Fastify API（独立进程）
apps/worker       后台 Worker（独立进程，处理合成发布与检索索引）
apps/web          React 管理工作台
apps/tool         akb CLI / MCP stdio Bridge
packages/contracts 生成类型、Schema、统一 HTTP 客户端
packages/domain    领域接口及安全的开发配置
tests             契约、HTTP、stdio 和基础测试
evals             真实试点评测边界（材料待授权）
ops               开发 PostgreSQL、角色与宿主手动示例
```

Monorepo 只是现阶段的组织选择。应用可分别部署；按租户的知识 Git 内容库是运行时数据，不放入应用代码仓库。将来分仓仍必须共享固定版本契约。

## 启动

Node 24.21.0，pnpm 10.17.1。在项目目录执行 `nvm use`，按 `.nvmrc` 切换版本；保留其他项目的 Node 和 pnpm 版本。

```sh
corepack pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

工作台：<http://127.0.0.1:5173>；API：<http://127.0.0.1:3100/healthz>。

知识页面： [知识列表](http://127.0.0.1:5173/#knowledge) → 点击标题查看详情 → [任务检索](http://127.0.0.1:5173/#search)。检索使用实际任务、依赖版本与读取预算；列表和管理详情不消耗任务预算，检索中的展开详情调用计费读取接口。网络失败重试保留原操作 ID，同一浏览器会话的同仓库任务不会通过重复检索刷新额度。当前检索为分词关键词匹配，包含常用词的长问题可能命中较多内容。

专用合成开发库准备好后，可执行 `pnpm synthetic:knowledge`，经证据冻结、固定独立合成主体审核、异步 Git 发布和索引生成两条明确标注的页面示例；等待 Worker 完成后刷新列表，检索“人工审核”。此命令每次运行新增候选和发布记录，不代表真实组织批准，不用于生产环境。页面接通及验证范围见 [Web 知识页面验证记录](docs/architecture/verification/2026-09-14-web-knowledge-pages.md)。

统一 launcher 的 Web 支持热更新；API/Worker 修改后需重启，或分别使用各应用的 `dev` watch 命令。Ctrl+C 会关闭三个开发进程。

未配置数据库时 `/healthz` 为 200，`/readyz` 为 503；`/api/v1/me` 仅返回无内容权限的合成主体。不要将该结果称作真实登录。合成模式拒绝非 loopback 绑定、非本地数据库、模型外发，以及任何真实 Cookie/Bearer 凭据。生产模式当前拒绝启动。

可选的本地数据库：

```sh
pnpm db:up
# 将 .env.example 复制为 .env，检查它只包含合成开发参数
pnpm dev
```

开发 launcher 可加载项目 `.env`，不提交它；API 与 Worker 使用不同数据库角色。开发数据库只绑定 `127.0.0.1:55432`，凭据 `synthetic-only` 是公开的合成开发值，**禁止用于生产或真实私有资料**。首次空卷启动依次执行 SQL 001—008 和开发角色脚本；已有卷不会重跑初始化，修改 SQL 后不得直接删除真实资料，应使用显式迁移。

`pnpm db:stop` 只停止开发服务并保留数据卷。不要把 `docker compose down -v` 当成日常重置方式。B03 原始证据保存于忽略版本控制的 `.local/evidence` 私有目录；Git 知识正文版本库位于私有 `.local/content`，只读取已由数据库激活的版本。

## B03 合成手工贡献

新建合成开发数据库按 Compose 初始化 001—008。复制 `.env.example` 为本地 `.env` 后，为显式初始化设置其中注释的 `MIGRATION_DATABASE_URL`，运行：

```sh
pnpm synthetic:seed
```

随后将 `.env` 中 `AKB_SYNTHETIC_CONTRIBUTIONS` 改为 `1` 并启动或重启 `pnpm dev`，另一个终端运行：

```sh
pnpm synthetic:demo
```

演练仅生成合成文本，执行创建任务 → 接收证据 → 同键重传 → 引用服务端证据的手工候选 → 查询状态和证据。输出 `accepted` / `duplicate`、稳定证据映射和持久化任务 ID；候选没有增量判定或批准，不会发布。演练不读取实际源文件，不调用模型，也不启用 MCP 业务工具。

API 增加 `POST /api/v1/tasks`、`POST /api/v1/contributions`、`GET /api/v1/contributions`、`GET /api/v1/contributions/:id`、`GET /api/v1/evidence/:id?revision=N`。默认未开启时合法访问返回 401；开启后通过数据库现行 scope 授权。客户端不能提交 actor 或借本地证据 ID 冒充服务端引用。列表暂限当前贡献者，cursor 绑定主体与范围，服务重启后旧 cursor 需重新获取。

已有数据库必须先检查迁移历史：有 ledger 的库用显式迁移器追加 003；旧 Compose 无 ledger 的合成库由 owner 显式执行 `docs/architecture/data/003_contribution_context.sql` 一次，不自动认领旧历史。随后 `synthetic:seed` 会同事务授予接收所需权限；也可由 owner 单独执行 `ops/db/004_contribution_grants.sql`。不重跑 CREATE ROLE，不删卷。初始化会拒绝混有其他租户、真实主体或固定 ID 冲突的数据库。

原始证据默认 30 天，到期后读取拒绝；B06 已支持独立 retained 冻结；磁盘清理和孤立文件回收仍属于后续保留/治理任务。敏感内容复检覆盖明显密钥和个人/凭据来源，不宣称能识别所有敏感资料；当前仍仅用于合成开发。详情见 [B03 验证记录](docs/architecture/verification/2026-09-14-b03-contribution.md)。

## B05 人工增量判定与五路分流

在已升级到迁移 004 的合成开发库中重新运行 `pnpm synthetic:seed`，会同事务配置 B05 接收权限、固定主体的 assess/review scope 授权和四份合成基线材料。证据目录由服务端配置，默认为 `.local/evidence`；若 owner 配置 `AKB_SYNTHETIC_EVIDENCE_DIR`，初始化与 API 必须使用同一个私有目录。运行中的 API 更新后需重启。然后运行：

```sh
pnpm synthetic:assessment
```

演练通过真实 HTTP 保存并查询五路结果：`index_only`、`link_existing`、`knowledge_candidate`、`needs_confirmation`、`discard`，并验证同操作重传和授权导航。它只使用登记的合成文本，不代表真实仓库检查或独立审核。

新增 `PUT /api/v1/candidates/:id/assessment`、`PATCH /api/v1/candidates/:id`、`GET /api/v1/candidates/:id`、`GET /api/v1/reviews` 和 `GET /api/v1/navigation?scope_id=...`。保存使用现有 AssessmentWrite/CandidatePatch 契约，`expected_revision` 是当前候选版本；人工判定保存成功也会递增候选版本，必须重新 GET 取得下一次 CAS 条件。判定历史追加保存，同 operation_id 重试返回原版本；新保存不能覆盖其他检查者的结果。

人工填写中立问题、实际材料/版本/定位/hash、查询范围、完成或未完成原因、基线答案、必要增量、断言证据映射、缺失代价与分流理由。后端只接受 `human_review` / `human-v1`，不接受客户端伪造 isolated_check 或 model_version。基线材料必须已由 owner/可信适配器登记到 baseline_materials，内容以受控证据对象校验；API 没有登记权威来源的写权限，也不抓取请求中的 URL 或执行源代码。真实仓库快照与组织来源登记仍待 B02 接入。

未检查必须 inconclusive；推断/未确认断言、无可靠基线支持或未解决问题不能进入 knowledge_candidate，P0 不改变门槛。普通索引/链接只生成导航；镜像仍保留 link_existing，进入 waiting_review 等待独立显式批准。全部索引/链接/丢弃可 completed 且知识产出为零；零输入候选包尚不能通过候选判定接口完成，仍等待后续 B04 包级处理。候选修改会重置当前判定并隐藏旧导航，但保留历史。没有证据权限的审核读取只返回安全占位，不返回原题名、断言或证据定位。

已有有 ledger 的库由显式迁移器追加 004；无 ledger 的旧 Compose 合成库由 owner 显式执行 `docs/architecture/data/004_human_assessment.sql` 一次，再运行 seed 或单独执行 `ops/db/005_assessment_grants.sql`。本轮不自动迁移现有数据卷。详情见 [B05 验证记录](docs/architecture/verification/2026-09-14-b05-human-assessment.md)。

## B06 独立审核、冻结与异步发布

合成开发库先升级到迁移 005，再运行 `pnpm synthetic:seed` 配置两个独立的固定主体及 API/Worker 权限。有 ledger 的库用显式迁移器追加 005；无 ledger 的旧 Compose 合成库由 owner 显式执行 `docs/architecture/data/005_review_publication.sql` 一次，再 seed 或单独执行 `ops/db/006_governance_grants.sql`。不自动升级现有卷、不重跑 CREATE ROLE。

将 `.env` 中 `AKB_SYNTHETIC_CONTRIBUTIONS` 设为 `1` 后运行 `pnpm dev`，默认 API 为 contributor，Worker 领取固定合成 tenant 的发布任务。构建完成后，可在另一个终端启动独立 reviewer API：

```sh
AKB_SYNTHETIC_ACTOR=reviewer PORT=3101 node --env-file-if-exists=.env apps/api/dist/main.js
```

主体只由 operator 环境选择，不能通过请求 actor、Cookie 或 Bearer 切换；这两个服务都只允许 loopback 合成开发。API 和 Worker 必须使用相同私有 evidence/content 目录，默认 `.local/evidence` / `.local/content`，可用 `AKB_SYNTHETIC_EVIDENCE_DIR` / `AKB_SYNTHETIC_CONTENT_DIR` 配置。

审核流程：reviewer 冻结确切版本与定位的已选定 raw 片段 → contributor 将新的 retained EvidenceRef 绑定正文与判定并重存 → reviewer 独立批准 → publisher 请求发布 → Worker 写 Git 并二次校验后事务激活。未冻结、缺判定、自审、未确认断言、过期批准或目标版本冲突均阻断。镜像需显式 mirror_approval，仍保留 link_existing。

`POST /candidates/:id/publish` 返回 202/pending，通过 `GET /publications/:id` 或 ReviewView.current_publication 恢复；published 的 index_status 由 B07 索引 Worker 从 pending 推进到 ready 或 failed。修订创建和显式 rebase 绑定目标的 content/aggregate revision，候选修改后必须重新判定和审核。暂停/撤回/归档使用聚合版本 CAS。知识详情/历史是管理读取，不替代任务预算检索或 MCP。

46 项真实数据库测试覆盖自审、冻结、刷新与历史授权恢复、Git/DB 分步失败、过期 generation、撤权、竞争修订、镜像和生命周期。详见 [B06 验证记录](docs/architecture/verification/2026-09-14-b06-review-publication.md)。

## B07 授权检索、读预算与 MCP

合成库升级到迁移 006 后运行 `pnpm synthetic:seed`。有 ledger 的库使用显式迁移器；旧 Compose 无 ledger 的库由 owner 检查后执行 `docs/architecture/data/006_retrieval.sql` 一次，再 seed 或单独执行 `ops/db/007_retrieval_grants.sql`。不重跑 CREATE ROLE、不删卷，本轮未迁移现有数据卷。

设置 `AKB_SYNTHETIC_CONTRIBUTIONS=1` 后启动 API 和 Worker。先通过 `POST /api/v1/tasks` 创建任务；同一主体/仓库的存续 client_session_id 会复用任务。使用共享 HTTP SDK 或 POST `/api/v1/knowledge/search`、`/api/v1/knowledge/read`，按共享 SearchRequest/ReadRequest 提供 task_id 和 operation_id。重传使用原 operation_id 和原请求；不同查询使用新 operation_id。首次 search 绑定任务环境，版本变化需新会话。

每任务默认 3 次读取，主体每固定小时最多 20 次，每滚动小时最多创建 10 个新会话；search/get 共用读预算。结果最多 5 条、4000 个保守 UTF-8 字节预算单位，不是模型 BPE token。零答案、条件澄清和预算受限结果会消耗一次正常读取；技术故障释放预留。条件与依据不能被截掉，装不下就返回澄清或受限元数据。

发布和生命周期事务排队索引，Worker 从 Git 当前正文重建关键词索引。索引 pending/failed 返回暂不可用，不能伪装零答案；返回前复检当前权限、正文版本和证据可用性。`pnpm synthetic:reindex` 显式排队重建，由运行中的 Worker 处理；不会重置数据库。

MCP 默认无内容权限。构建后显式开启合成 HTTP Bridge：

```sh
AKB_SYNTHETIC_TOOLS=1 AKB_ENDPOINT=http://127.0.0.1:3100 node apps/tool/dist/cli.js mcp serve
```

search-knowledge、get-knowledge、get-contribution、record-usage、submit-validation、submit-feedback、get-config 已接真实 loopback HTTP 并校验输出。ingest-knowledge 仍未就绪，返回 TEMPORARILY_UNAVAILABLE/CAPABILITY_NOT_READY。真实登录、宿主配置安装与 S1 验收未完成。见 [B07](docs/architecture/verification/2026-09-14-b07-retrieval.md)、[B08](docs/architecture/verification/2026-09-14-b08-independent-validation.md)和 [B09](docs/architecture/verification/2026-09-14-b09-configuration.md)验证记录。

## B08 使用反馈与独立验证

合成库需升级到迁移 007，再运行 `pnpm synthetic:seed` 配置权限。有 ledger 的库使用显式迁移器；无 ledger 的旧 Compose 合成库由 owner 检查后执行 `docs/architecture/data/007_validation.sql` 一次，再 seed 或执行 `ops/db/008_validation_grants.sql`。本轮未升级现有数据卷。新建空库初始化包含 001—007。

`POST /api/v1/usage-events` 只接受 cited/applied；`POST /api/v1/feedback` 保存反馈，均按 event_id 幂等。`POST /api/v1/validations` 返回 202/pending，提交者的 success 不等于已验证。独立且有 `knowledge:validation-review` 权限的主体通过 `GET /api/v1/validations` 和 `POST /api/v1/validations/:id/review` 审核，使用 operation_id 与 expected_revision 恢复和防止竞争覆盖。

审核核对当前授权、任务环境、确切知识版本及 retained 证据；自审被拒绝。一次有效成功晋升 verified；proven 要求两个不同任务、提交者及证据内容，非 repo 范围还要求不同项目。同任务复制证据、引用、使用、整体构建、失败和无结论均不增加独立成功数。旧版本审核不会晋升当前正文。accepted failure 标记 review_due 并排入人工反证复核任务，不自动暂停。提交不会扣减检索预算。

成熟度规则由后端执行，结论针对性仍由独立人工审核确认。反证处理工作流、后台时效复核、通知投递及 Web 表单留待治理阶段；详情见 [B08 验证记录](docs/architecture/verification/2026-09-14-b08-independent-validation.md)。

## B09 组织配置版本与 get-config

合成库需升级到迁移 008，再运行 `pnpm synthetic:seed`。无 ledger 的旧 Compose 合成库由 owner 检查后显式执行 `docs/architecture/data/008_configuration.sql`，再 seed 或执行 `ops/db/009_configuration_grants.sql`；不重跑初始化或删除卷。有 ledger 的库使用显式迁移器。新建空库包含 001—008，本机专用 55432 合成库已追加升级。

`POST /api/v1/config/versions` 创建不可变草稿，`POST /api/v1/config/:id/activate` 使用 operation_id/expected_revision 发布，`GET /api/v1/config/versions` 查看授权版本。`GET /api/v1/config?repo_id=...&client_version=...` 下发 updated/unchanged/incompatible/revoked 结果，可带 current_config_version；强制规则核验当前知识版本、完整条件与 retained 来源，独立限流、不扣检索预算。

已撤销 ID 不重新激活；回滚复制已核对正文为新版本并重新发布。冻结契约无撤销路由，合成 operator 使用 `pnpm synthetic:config:revoke <id> <revision> <operation_id> <reason>`。Web 工程概览有实际配置读取演练，完整管理表单和宿主安装尚未实现。见 [B09 验证记录](docs/architecture/verification/2026-09-14-b09-configuration.md)。

## CLI / MCP

```sh
node apps/tool/dist/cli.js doctor --json
node apps/tool/dist/cli.js --version
node apps/tool/dist/cli.js mcp serve
```

`mcp serve` 的 stdout 只允许 JSON-RPC，不要通过有 banner 的 package-manager 命令包装它。默认 8 个工具均无内容权限并返回明确的 `UNAUTHENTICATED`；显式开启 `AKB_SYNTHETIC_TOOLS=1` 后，检索、读取、贡献状态、使用、验证、反馈与配置七个工具通过 loopback HTTP 调用真实 API，ingest-knowledge 返回 `CAPABILITY_NOT_READY`。验证提交返回 pending，不表示已审核通过。

Claude Code 接入模板在 `ops/claude-code/mcp.example.json`。真实 Claude Code CLI 尚未在当前机器发现；不要直接复制占位绝对路径，不自动写 `.mcp.json`，完成真实版本/配置验收后再手动合并已有 server 配置。官方 SDK stdio 测试不能替代真实宿主兼容性验收。

## 检查和生成

```sh
pnpm contracts:generate
pnpm verify
pnpm contracts:check:sql
pnpm test:database
```

`verify` 执行契约漂移、共享 SDK 漂移、构建、严格类型检查、lint、测试和格式检查。SQL 检查需 Docker，使用固定 digest 的无网络、无主机数据挂载临时 PostgreSQL，结束自动删除容器。

`test:database` 另启一个无主机挂载、无持久卷的临时 PostgreSQL，仅发布随机 loopback 端口，实际运行迁移、ACL、证据权限、撤权、连接复用及 B03/B05/B06/B07/B08/B09 接收、判定、发布、检索、验证、配置、并发和故障测试，结束自动删除临时容器。普通 `verify` 不需要 Docker，数据库套件会明确显示 skipped；CI 单独运行两种数据库检查。

新增显式迁移执行器：构建后运行 `pnpm --filter @accremind/api migrate`，必须通过环境提供仅本地合成目标的 `MIGRATION_DATABASE_URL`，不要把凭据放进命令行或 Git。它管理 001/002 初始迁移及 003—008 加法迁移，按文件 SHA-256 记录历史，以 advisory lock 串行执行，每个迁移及其历史记录同事务提交；失败回滚当前迁移，已完成的前序迁移保留，不自动执行破坏性 down migration。角色配置仍由运维单独执行。

已有 Compose 数据卷使用 SQL init，不带新迁移历史，迁移器不会自动认领或重置它们。现有卷也不会自动获得本轮新增的 `akb.repos`/`akb.evidence` API SELECT 权限；经检查后由迁移 owner 显式授予，不要重跑包含 CREATE ROLE 的整个初始化脚本，更不要删卷。已有库历史接管与生产迁移仍待单独实现。

唯一契约源为 `docs/architecture/contracts/source/openapi.json` 和工具元数据 `source/mcp-tools.json`。生成的 JSON 和 `packages/contracts/src/generated` 均提交版本控制；禁止分别手改。详情见[契约说明](docs/architecture/contracts/README.md)。

Git 仓库已有提交及 origin。GitHub Actions 工作流已恢复，运行工程检查和两个数据库套件；本轮未提交、推送或运行远端 CI。

## 下一阶段与组织参数

下一条纵向切片：合成身份 → 手工证据 → 人工增量判定 → 独立审核 → 发布 → CLI/MCP 检索 → 暂停/撤回。

执行状态：CI/verify、数据库授权基础及 B03/B05/B06/B07/B08/B09 合成业务已落地；真实认证与来源接入尚未完成，不能宣布 S0/S1 通过。下一任务 B10：完整治理、时效复核与保留清理。见 [B09 验证记录](docs/architecture/verification/2026-09-14-b09-configuration.md)。

真实试点前需要[启动参数表](docs/pilot-startup.md)：试点仓库、OIDC、审核人、部署/模型许可和数据保留策略。缺参数时只能继续合成开发，不得外发真实资料。

参考：[工程决策](docs/decisions/0001-engineering-baseline.md)、[阶段 B 验证记录](docs/architecture/verification/2026-09-12-phase-b-validation.md)、[任务与验收计划](docs/architecture/04-开发任务与验收计划.md)。
