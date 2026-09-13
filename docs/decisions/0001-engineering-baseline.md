# ADR 0001：工程与合成开发基线

日期：2026-09-12。状态：工程实施基线；组织接入和正式试点尚未批准。

## 决策

- 采用 pnpm workspace monorepo，API/Worker 同后端工作线但独立进程，Web/Tool 可独立构建和部署。没有增加微服务、向量库或自动发布。
- Node 精确版本由 .node-version 固定，pnpm 由 packageManager 固定，依赖均精确写入各 package.json 并由 pnpm-lock.yaml 锁定传递依赖。阶段 A 的 npm package-lock 已替换，不混用安装器。
- Ajv 固定 8.18.0；MCP SDK 原锁文件保留旧 Ajv，采用局部 override 在 SDK 支持的版本范围内修复安全公告。后续升级 SDK 时复审该 override，不忽略安全扫描。
- OpenAPI 仍是单一领域源；共享 TypeScript、运行时 Schema、MCP 定义和 operation manifest 统一生成并检查漂移。HTTP 客户端不记录凭据/正文，网络异常不转为空结果。
- Fastify 显式 Ajv2020 请求校验与响应校验后序列化，禁止静默去字段和全局类型强转；实际 HTTP 测试覆盖未知字段/错误版本类型。
- synthetic 是唯一当前可运行模式，强制 loopback 且不接受真实凭据；production 失败关闭。模型未接入，Worker 不领取或伪装完成任务；8 个 MCP 工具合法调用明确失败，尚不能消费知识。
- PostgreSQL 开发容器只绑定 loopback；迁移 owner 和 API/Worker/Auth 运行角色分离，运行角色 NOBYPASSRLS。当前只授骨架所需最小权限，之后随领域实现审查，不默认授全部业务表写入。
- 提供手动 Claude Code 配置模板，不修改真实宿主配置。当前找不到 Claude Code CLI，真实版本/stdout/config CAS 的宿主验收仍未完成。

## 影响

Monorepo 降低当前小团队契约协调成本，但不是硬依赖。拆仓时共享 contracts 包须固定版本，建立跨仓兼容 CI；不会要求所有应用同时部署。

合成模式不能接收真实私有代码。公开开发密码、合成主体 ID 和空 capabilities 是测试基础，不是生产认证方案。新增组织认证、模型 endpoint 或来源接入需完成 D00 的授权和数据策略。

## 未决组织参数

试点团队/业务域/repo 映射、独立审核人、OIDC issuer/client、回调白名单、域名/机器、模型许可/数据地域、内容 owner、原始和 retained 证据保留期、正式预算/评测冻结见[启动表](../pilot-startup.md)。因此 D00/S0 不标为完整通过。

版本和实际检查证据见[阶段 B 记录](../architecture/verification/2026-09-12-phase-b-validation.md)，lockfile 为最终依赖依据。没有承诺工期、成本或收益。
