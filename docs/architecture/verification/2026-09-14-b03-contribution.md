# B03 合成手工贡献与证据持久化

日期：2026-09-14。范围：任务 B03 的合成开发接收链路；真实身份与试点验收不在本轮完成范围。

## 实现

- PostgresContributionService：创建任务、接收贡献、查询贡献/列表和读取确切证据版本。Schema 来自现有 contracts，不改唯一契约源。
- 原始证据以 UTF-8 SHA-256 校验后写受控文件，文件与目录 fsync，身份/版本不可覆盖；DB 保存引用和 30 天到期时间，原始正文不进入长期 Git、任务、outbox 或审计。
- 包上限 256KB 按 UTF-8 字节复检；重复客户端证据/事件 ID、明显密钥、个人和凭据来源、伪造额外字段会被拒绝。敏感检测是补充控制，不保证识别所有敏感资料。
- 按 tenant + operation key 串行，检查 actor/route/payload hash；同键同载荷复用，异载荷或跨 actor/route 拒绝。源事件按 tenant + manual + event ID 去重，重用事件不得覆盖原贡献。
- contribution、source_events、evidence 元数据、contribution_evidence 映射、candidate/revision、human_assessment job、outbox、operation 与审计同事务提交。文件先持久化；DB 失败可能留下未被引用的私有对象，不主动删除可能已提交的对象。
- 手工候选只接受已有且有权读取的确切服务端证据引用，不能用 client_evidence_id 代替。候选没有 CaptureAssessment 或批准，保持 candidate；贡献保持 accepted，不声称已发布。
- 证据返回前复查授权、状态与到期时间；映射恢复同样过滤不可见证据，隐藏其 ID/locator。列表暂限当前贡献者，签名 cursor 绑定主体、授权版本与 scope，保留微秒排序位置；重启后旧 cursor 失效。
- 新增 003 加法迁移保存 environment，未修改历史 001/002；运行角色仅增加接收所需 SELECT/INSERT，不开放身份令牌、审批或知识发布写权限。
- 默认模式依旧没有内容权限。AKB_SYNTHETIC_CONTRIBUTIONS=1 只接受 accremind_dev 的公开合成 API 角色；synthetic:seed 是显式 owner 操作，并拒绝其他租户/主体与固定 ID 冲突。Cookie/Bearer 一律拒绝，模型外发仍禁止。

## 验证

验收命令：`pnpm verify`、`pnpm test:database`、`pnpm contracts:check:sql`。本机使用 Node 24.19.0 / pnpm 10.17.1；项目 Node 固定版本仍为 24.20.0，未修改系统运行时。

最终结果：

- `pnpm verify` 通过：契约/SDK 漂移、构建、严格类型检查、lint、19 项普通测试与格式检查；2 个数据库套件在普通测试中明确 skipped，并由下面命令单独实际执行。
- `pnpm test:database` 通过：20 项测试、0 失败、0 skipped，包括 B03 的 11 个业务子用例与原有迁移/授权套件。
- `pnpm contracts:check:sql` 通过：001/002/003 SQL、运行角色、契约约束和角色隔离检查。两个临时测试容器均已自动删除。

数据库验收只在脚本创建的随机 loopback 端口、无主机挂载/持久卷的临时 PostgreSQL 17.6 中进行，检查随机 guard 后才写测试夹具；测试结束自动删除容器。

覆盖并发同键接收、事件换键重传、异载荷/actor/route 冲突、跨租户相同 key、证据与待处理任务重启恢复、手工候选持久化和伪造证据拒绝、第二个证据写失败的整包 DB 回滚、任务归属/到期、签名分页、Fastify 与共享 SDK、显式 seed 重复执行和实际 HTTP 合成演练，以及隔离/到期/撤权后的安全拒绝与映射过滤。原有迁移/授权/连接复用套件继续执行。

## 保留边界与下一步

B03 在合成开发范围完成接收侧功能。Worker 尚不消费 human_assessment，也不发送 outbox；它们是持久化待处理记录。零候选贡献处于 accepted，不能在未检查时宣称 completed 或 discard。后续 B05 实现 CaptureAssessment 人工检查、基线与增量判定、五路分流；B06 再实现独立审核与发布。

retained 证据提取、到期磁盘清理、未引用对象回收、生产备份/迁移和真实身份接入仍待后续任务。未启用真实资料、LLM、MCP 业务调用或远端 CI，不宣称通过 S0/S1。
