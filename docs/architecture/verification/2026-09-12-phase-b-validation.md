# 阶段 B：工程准备与验证

日期：2026-09-12。范围：Git 初始化、pnpm workspace、四个应用、两个共享包、生成 SDK、开发 PostgreSQL、测试与 CI。不是阶段 C 业务闭环实现。

## 交付与状态

- Git main 初始化；未提交、配置远程或推送。V1/PRD 原文不改。
- apps/api、worker、web、tool 与 packages/contracts、domain；Node/依赖/包管理器版本固定，pnpm-lock.yaml。
- OpenAPI → 生成 TypeScript/operation map/Schema/MCP；shared client 在三端可复用；CI 检查生成漂移。
- API health/ready/me、Worker 心跳、Web 无权限合成工作台、CLI doctor 与 8 工具失败关闭 Bridge。
- 开发 PostgreSQL Compose、迁移与最小运行角色；合成密码仅用于 loopback 开发，生产认证/模型禁用。
- D00 工程部分和 D01 基础完成；D00 组织参数/真实 Claude Code 和 Q01 真实标注待提供，S0 未全部通过。

## 实际验证

- 环境：Node 24.20.0、pnpm 10.17.1；React 19.3.0、Fastify 5.12.4、Vite 7.3.6、MCP SDK 1.30.0、TypeScript 5.9.3、Ajv 8.18.0。精确传递依赖以锁文件为准。
- `pnpm install --offline --frozen-lockfile` 使用本轮依赖缓存复现成功；没有关闭严格 peer 检查。
- `pnpm verify` 通过：OpenAPI 3.1、110 领域 Schema、8 MCP 定义、630 HTTP wire Schema、61 组正负 fixtures、54 paths/60 operations、共享 SDK 漂移、六包构建与严格类型、lint、10 项运行测试、格式检查。87 个本地 Markdown 链接可解析。
- HTTP 实测采用 Fastify inject：未知字段不被静默删除、错误 revision 类型被拒绝、真实凭据被拒绝、无数据库 readiness 为 503；共享客户端不把网络故障转成零结果。
- MCP 实测通过官方 SDK 启动真实子进程 stdio，完成 initialize/list（8 工具）及 get-contribution 非法输入/未认证调用。错误使用 Error Schema 校验的文本 envelope，不将错误对象放入仅描述成功数据的 outputSchema。
- `pnpm contracts:check:sql` 在固定 digest 的 PostgreSQL 17.6 上通过 001/002/开发角色脚本、阶段 A 约束、基础运行角色测试。API 非表 owner/非 BYPASSRLS，无租户上下文不可见、跨租户不可见、API/Worker 无权读身份敏感表。合成样本事务回滚，临时容器自动删除。
- Compose 空卷初始化、`pnpm dev`、API/Worker 分角色真实连接通过；实际 TCP `/healthz`、`/readyz`、`/api/v1/me` 及 Vite 代理均为 200；me 为合成主体且 capabilities 为空。浏览器实际加载确认工作台正常渲染，业务入口明确禁用。
- CLI doctor 实测 backend reachable、host unsupported、configChanges false；没有修改宿主配置。另有非法/外部/带凭据 endpoint 的脱敏拒绝测试。
- 退出测试发现 SIGINT/SIGTERM 双信号重复关闭连接池，已修复为共享单次 cleanup promise，并补回归测试；再次 Ctrl+C 干净退出。API/Worker/Web 与开发数据库已停止，开发数据卷保留。
- `pnpm audit --json`：0 已知公告（不是全面安全审计）。曾发现 Ajv 条件性 ReDoS 公告，已升级直接依赖并将 SDK 的 Ajv 锁定为其 semver 范围内的 8.18.0；未通过忽略公告或削弱校验解决。
- GitHub Actions 工程检查已配置，但未推送/运行远端 CI，也未配置分支保护。PRD/V1 原文件哈希与阶段 A 留存值一致。

## 未实现与限制

没有真实登录/证据采集/独立审核/发布/检索/验证/队列处理，没有真实 OIDC 或 Claude Code 宿主验收，没有正式评测样本、成本或收益结果。MCP SDK subprocess E2E 只能验证 stdio 协议及失败关闭路径。Docker 临时测试不会证明所有业务 RLS/事务/恢复已通过。

配置和复现见[根 README](../../../README.md)、[工程 ADR](../../decisions/0001-engineering-baseline.md)、[组织启动表](../../pilot-startup.md)。真实资料接入必须先解决授权边界。
