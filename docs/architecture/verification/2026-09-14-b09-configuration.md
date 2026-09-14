# B09 合成组织配置版本记录

日期：2026-09-14。范围：固定合成主体、loopback HTTP、真实 PostgreSQL/Git/证据文件。Node 24.21.0、pnpm 10.17.1。未修改冻结 v2.0.0 契约，未新增依赖、提交代码或部署；其他项目的 Node 默认版本保留。

## 已实现

- GET /config、GET/POST /config/versions、POST /config/{id}/activate 按冻结契约实现；共享 SDK 和 MCP get-config 调用真实 HTTP。默认无内容授权，真实 Cookie/Bearer 仍被拒绝。
- 正文与 hash 不可修改，每个 repo scope 版本单调递增；草稿绑定创建时的发布 generation。config:manage 主体显式激活并给出原因。同一 generation 的竞争草稿只有一个胜者，过期草稿需重新创建。scope→operation 锁序、CAS 与幂等历史防止重试覆盖。
- 新激活将旧 active 标记 revoked，已撤销 ID 是终态；历史重传返回撤销状态，不重新激活。回滚复制已核对的原始正文为新 ID/版本，再由管理人员显式发布。配置历史和审计追加保存主体、版本、operation_id 与原因。
- config:read/config:manage 分开授权；repo 选择执行授权 SQL，显式 domain/team 授权才覆盖下属 repo。即使管理员拥有多个域权限，也不能把不适用该 repo 的规则直接下发。
- mandatory_rules 绑定当前 published/enabled 的确切知识版本，读取 Git 和 retained 证据核验 hash、来源、有效期及权限。text 是完整 CandidateBody 的 canonical JSON，保留条件、理由、例外和来源；手工伪造、失效或不适用的规则被拒绝，完整文本超过 16000 字符不截断。只分发文本，不执行命令或分发 Skills。
- 最低宿主版本须为有界稳定数字 semver；版本低于最低值或不可判定返回 incompatible。current_config_version 相同返回 unchanged，仍返回完整正文及 hash，不宣称差量补丁。
- 配置 GET 按 tenant/actor/小时独立限额 60 次成功响应，四类正常 outcome 均计数，不扣 task 检索预算。文件校验并行，最终配置版本复检与配额提交串行；I/O 期间配置变化返回技术失败并要求重试，不伪装 unchanged 或空配置。
- revoked 下发为惰性墓碑：入口文本替换为停止使用说明，规则清空；sha256 对应实际返回正文的 canonical JSON，不是原始撤销正文 hash。墓碑不能当回滚源，客户端应停止使用该版本。
- Web 工程概览有实际“组织配置读取演练”，显示版本、兼容结果、入口文本与规则。宿主版本是演练输入，不代表已检测或安装 Claude Code；管理导航与完整 F05 表单未实现。

## 撤销与升级

冻结契约没有 revoke 路由，合成 operator 使用同一授权/事务服务执行显式命令：

```sh
pnpm synthetic:config:revoke <id> <revision> <operation_id> <reason>
```

命令要求本地 accremind_dev 的 migration operator 配置，固定主体仍核验 config:manage；参数不含凭据，输出只含 ID/版本/状态，不提供生产撤销能力。

[008 迁移](../data/008_configuration.sql)新增发布头、配置事件与配额表，强制 RLS、trigger 保护正文和 revoked 终态；[009 权限](../../../ops/db/009_configuration_grants.sql)只授予必要表和 status 列更新。首次空卷包含 001—008；已有无 ledger 合成库由 owner 检查后显式追加 008，不重跑初始化或删除卷。旧草稿缺少 generation 时须重新创建。本轮已检查专用 55432 合成库零旧配置、无其他团队，再追加 008 并重新 seed。

## 验证与边界

- 真实数据库测试 74 项通过，含 9 个 B09 子用例：并发创建/竞争发布、正文与权限、无检索扣费、实际 I/O 撤权/配置撤销竞态、终态与复制回滚、多域、签名分页、MCP HTTP、65 个并发请求的独立配额。
- SQL 检查通过，包含 008/009、运行权限及 RLS；临时 PostgreSQL 无主机挂载或持久卷，结束自动删除。
- pnpm verify 通过：契约、构建、类型、lint、格式；常规测试 36 项，32 项通过、4 个数据库父套件按设计跳过，已由真实数据库命令执行。
- 未实现真实 OIDC、宿主安装/hash CAS/本地缓存回退、完整管理 UI、更正推送或 B10 治理。撤销状态通过主动 GET 获取，离线宿主不会自动收到更正；不宣称 T02/T06/T07 全量或 S0/S1 已验收。
- ConfigBody 的 query_limit/token_limit 是下发参数；检索 API 仍执行自身 B07 门槛，不能利用配置提高服务端任务预算。配置不授予内容或执行权限。

下一任务 B10：完整治理、冲突与范围变更、时效及保留任务、更正通知。
