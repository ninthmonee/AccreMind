# AccreMind · AI 研发知识基座

团队研发知识基础设施：优先保存当前代码与权威文档无法可靠恢复的必要上下文，要求证据、适用条件、独立审核和纠错。

当前完成阶段 A 设计修订、阶段 B 工程基线，以及阶段 C 的数据库事务与 scope 授权基础。**不是已经可用的知识服务**：真实登录、证据采集、审核发布、检索、任务队列和验证业务均未实现。当前 HTTP 仍仅提供无内容权限的 loopback 合成身份；新授权服务是内部基础模块，不是登录接口。

## 工程结构

```text
apps/api          Fastify API（独立进程）
apps/worker       后台 Worker（独立进程，尚不领取业务任务）
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

Node 24.20.0，pnpm 10.17.1。建议通过现有 Node 版本管理器选择 `.node-version`，不修改系统 Node。

```sh
corepack pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

工作台：<http://127.0.0.1:5173>；API：<http://127.0.0.1:3100/healthz>。

统一 launcher 的 Web 支持热更新；API/Worker 修改后需重启，或分别使用各应用的 `dev` watch 命令。Ctrl+C 会关闭三个开发进程。

未配置数据库时 `/healthz` 为 200，`/readyz` 为 503；`/api/v1/me` 仅返回无内容权限的合成主体。不要将该结果称作真实登录。合成模式拒绝非 loopback 绑定、非本地数据库、模型外发，以及任何真实 Cookie/Bearer 凭据。生产模式当前拒绝启动。

可选的本地数据库：

```sh
pnpm db:up
# 将 .env.example 复制为 .env，检查它只包含合成开发参数
pnpm dev
```

开发 launcher 可加载项目 `.env`，不提交它；API 与 Worker 使用不同数据库角色。开发数据库只绑定 `127.0.0.1:55432`，凭据 `synthetic-only` 是公开的合成开发值，**禁止用于生产或真实私有资料**。首次空卷启动依次执行 SQL 001/002/开发角色脚本；已有卷不会重跑初始化，修改 SQL 后不得直接删除真实资料，应使用显式迁移。

`pnpm db:stop` 只停止开发服务并保留数据卷。不要把 `docker compose down -v` 当成日常重置方式。知识内容与证据存储实现仍待阶段 C。

## CLI / MCP

```sh
node apps/tool/dist/cli.js doctor --json
node apps/tool/dist/cli.js --version
node apps/tool/dist/cli.js mcp serve
```

`mcp serve` 的 stdout 只允许 JSON-RPC，不要通过有 banner 的 package-manager 命令包装它。当前 8 个工具只支持 Schema 输入校验，合法调用返回明确 UNAUTHENTICATED，不查询、不提交、不声称知识已发布。

Claude Code 接入模板在 `ops/claude-code/mcp.example.json`。真实 Claude Code CLI 尚未在当前机器发现；不要直接复制占位绝对路径，不自动写 `.mcp.json`，完成真实版本/配置验收后再手动合并已有 server 配置。官方 SDK stdio 测试不能替代真实宿主兼容性验收。

## 检查和生成

```sh
pnpm contracts:generate
pnpm verify
pnpm contracts:check:sql
pnpm test:database
```

`verify` 执行契约漂移、共享 SDK 漂移、构建、严格类型检查、lint、测试和格式检查。SQL 检查需 Docker，使用固定 digest 的无网络、无主机数据挂载临时 PostgreSQL，结束自动删除容器。

`test:database` 另启一个无主机挂载、无持久卷的临时 PostgreSQL，仅发布随机 loopback 端口，实际运行 Node/pg 迁移、两用户两仓库 ACL、证据权限、撤权与连接复用测试，结束自动删除临时容器。普通 `verify` 不需要 Docker，数据库套件会明确显示 skipped；CI 单独运行两种数据库检查。

新增显式迁移执行器：构建后运行 `pnpm --filter @accremind/api migrate`，必须通过环境提供仅本地合成目标的 `MIGRATION_DATABASE_URL`，不要把凭据放进命令行或 Git。它只管理 001/002 领域与身份初始迁移，按文件 SHA-256 记录历史，以 advisory lock 串行执行，每个迁移及其历史记录同事务提交；失败回滚当前迁移，已完成的前序迁移保留，不自动执行破坏性 down migration。角色配置仍由运维单独执行。

已有 Compose 数据卷使用 SQL init，不带新迁移历史，迁移器不会自动认领或重置它们。现有卷也不会自动获得本轮新增的 `akb.repos`/`akb.evidence` API SELECT 权限；经检查后由迁移 owner 显式授予，不要重跑包含 CREATE ROLE 的整个初始化脚本，更不要删卷。已有库历史接管与生产迁移仍待单独实现。

唯一契约源为 `docs/architecture/contracts/source/openapi.json` 和工具元数据 `source/mcp-tools.json`。生成的 JSON 和 `packages/contracts/src/generated` 均提交版本控制；禁止分别手改。详情见[契约说明](docs/architecture/contracts/README.md)。

Git 仓库已有提交及 origin。GitHub Actions 工作流已恢复，运行工程检查和两个数据库套件；本轮未提交、推送或运行远端 CI。

## 下一阶段与组织参数

下一条纵向切片：合成身份 → 手工证据 → 人工增量判定 → 独立审核 → 发布 → CLI/MCP 检索 → 暂停/撤回。

执行状态：CI/verify 修复和数据库事务/授权基础已落地；B01/B02 仅部分完成，真实认证、成员管理和仓库映射尚未实现，不能宣布 S0/S1 通过。后续先推进 B03 的合成手工贡献与证据持久化，不等待 LLM；详情见[阶段 C 基础验证](docs/architecture/verification/2026-09-14-phase-c-foundation.md)。

真实试点前需要[启动参数表](docs/pilot-startup.md)：试点仓库、OIDC、审核人、部署/模型许可和数据保留策略。缺参数时只能继续合成开发，不得外发真实资料。

参考：[工程决策](docs/decisions/0001-engineering-baseline.md)、[阶段 B 验证记录](docs/architecture/verification/2026-09-12-phase-b-validation.md)、[任务与验收计划](docs/architecture/04-开发任务与验收计划.md)。
