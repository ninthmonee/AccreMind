# B06 独立审核、证据冻结与异步发布验证

日期：2026-09-14。范围：本地合成开发，不代表真实认证、真实仓库检查或 S1 验收通过。

## 实现结果

- `POST /evidence/{id}/retain`：审核人按确切版本和已登记定位复制服务端选定片段，生成独立 retained 身份、hash、保留期和不可变来源映射。当前支持已有选定片段的完整定位；不解释任意新行号，不抓取 URL，不接收客户端 content 或模型摘要。合成 retained 策略为 365 天，生产策略仍由团队确定。
- `POST /candidates/{id}/review`：批准、退回、拒绝及记录现有分流。批准必须来自贡献者之外的授权主体，绑定当前候选 revision、assessment revision、scope、证据集合指纹；所有正文、断言及已检查材料依据必须 retained。改变分流必须先保存新判定。权威镜像保留 link_existing，并需显式 mirror_approval。
- `GET /candidates/{id}`：恢复 latest_review、current_approval、当前候选版本的 current_publication，以及门槛和允许动作。输入或目标版本变化后，历史审核标记 stale，不重新当作有效批准。
- `POST /candidates/{id}/publish`：请求事务校验批准并写 publication、queued job、operation 和审计，返回 202/pending。相同 operation 按实际 publication 状态恢复；不同 actor、路由或载荷不能复用操作。
- `GET /publications/{id}`：授权轮询 pending/published/failed；发布后明确 index_status=pending，不伪造搜索索引就绪。
- `POST /knowledge/{id}/revisions`、`POST /candidates/{id}/rebase`：修订绑定目标 content/aggregate revision；固定 target → contribution → candidate 锁序，显式提交人工合并后的完整正文。rebase 递增候选版本并使当前判定/批准失效，随后必须重新判定和独立审核。PATCH 与人工判定保存支持修订快照，不改变绑定。
- `GET /knowledge/{id}` 与 `/revisions`：管理详情及历史读取，提供当前聚合版本用于 CAS。显式历史需要 knowledge:history；暂停/撤回/归档正文还需同范围 knowledge:review。所有依据仍需证据 ACL、存储 hash 与可用性校验；历史正文标记 historical_reference。此接口不替代 B07 的任务预算检索或 MCP。
- `POST /knowledge/{id}/suspend|withdraw|archive`：聚合版本 CAS、幂等、审计/outbox；停止服务不改变正文版本，不提升成熟度。

## Worker 与一致性

API 与 Worker 使用不同 PostgreSQL 角色；Worker 通过共享的发布库处理任务，没有启动 API 服务。运行角色均不能修改审核、判定和正文历史或读取认证令牌。005 为加法迁移，001—004 历史不修改；006 角色授予脚本可单独升级现有开发角色。

Worker 只在 operator 选定的固定合成 tenant 中领取 publication 任务，不使用跨租户管理员查询。短事务使用 SKIP LOCKED 领取，写 60 秒租约、owner 和递增 generation，每 20 秒续租；过期任务可重新领取，旧 generation 不能 checkpoint 或激活。临时 Git/DB 失败 5 秒后重试，最多三次；门槛、授权或版本冲突直接失败。

正文在私有目录中按 tenant 写入裸 Git 仓库；没有 clone、远程推送、源代码执行或可写 checkout。专用数据库连接持有每租户 session advisory lock；连接错误会中止 Git 写入。Git 子进程禁用 hooks、隔离 Git 环境、限制输出和执行时间。publication_id 与 content_hash 写入提交信息，两条 Git refs 原子更新；同一 publication 的同内容重试复用 content_ref，冲突内容拒绝。

Git 操作在数据库业务事务之外完成。最终事务重锁目标与候选，再校验 generation/owner/lease、当前发布状态、最新主体授权、审核者授权及证据、批准和两种目标版本 CAS。只在全部满足时插入知识正文版本、激活聚合对象、更新 publication/job/candidate/contribution 并写审计/outbox。Git 成功而 DB 失败只留下未激活内容，读取仅使用已提交 knowledge_revisions 中的 content_ref。修订重置 maturity=draft/freshness=unknown。

## 验证

- `pnpm verify`：契约无漂移、构建、严格类型检查、lint、普通测试、格式检查。
- `pnpm test:database`：临时 PostgreSQL 17.6 中 46 项通过，无跳过；B06 13 个子用例，与 B03/B05/基础数据库用例一起执行。容器仅开放随机 loopback 端口，无主机数据挂载，使用内存数据目录，完成后自动删除。
- `pnpm contracts:check:sql`：001—005 迁移、角色授予、约束和 RLS 验证通过，使用无网络临时容器。
- 新增 Git 存储测试覆盖真实提交、Unicode、重启后读取、同身份幂等、冲突内容、hash、非法引用、取消和 symlink 目录。

数据库用例覆盖：冻结权限/定位/伪造字段；缺判定、raw、自审与绕 UI 直接调用；刷新恢复；候选修改和退回使旧批准/排队发布失效；真实 Git 写成功后注入 DB trigger 失败与恢复；Git 三次失败；过期 generation；Git 后撤权；两个修订竞争一个目标的唯一胜者与人工 rebase；镜像独立批准；raw 到期不破坏 retained 依据；retained 隔离后拒绝正文；暂停/撤回/归档 CAS 和安全历史。

## 开发入口与边界

升级数据库到 005 后运行 `pnpm synthetic:seed`，配置 contributor 与独立 reviewer 两个固定合成主体及 scope 授权，并授予开发 API/Worker 权限。`AKB_SYNTHETIC_CONTRIBUTIONS=1` 启用贡献/判定/治理与 Worker；API 主体由 operator 的 `AKB_SYNTHETIC_ACTOR=contributor|reviewer` 选择，默认 contributor，不能通过请求 actor、Cookie 或 Bearer 切换。启动第二个 reviewer API 的命令见 README。API 和 Worker 必须共享私有 evidence/content 目录，默认 `.local/evidence` 和 `.local/content`。

已有数据卷不在本轮自动升级，不删卷、不重跑 CREATE ROLE，不启动真实发布。真实 OIDC/成员管理、来源快照、自动提炼、业务 Web 表单、CLI/MCP 业务接通、关键词索引与检索仍未完成。outbox 已事务写入，尚未投递；证据磁盘清理、孤立 Git 回收、生产保留/删除与备份演练属于后续任务。不能宣布 B01/B02 或 S0/S1 通过。下一任务 B07：授权关键词检索、任务预算和 search/get。
