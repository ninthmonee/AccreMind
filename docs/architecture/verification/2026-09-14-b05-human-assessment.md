# B05 人工增量判定与五路分流

日期：2026-09-14。范围：合成开发条件下 B05 人工路径，不代表真实组织接入或 S1 审核发布闭环完成。

## 本轮实现

- 使用冻结的 AssessmentWrite / CandidatePatch / AssessmentRecord / ReviewView / NavigationPage 契约，没有手改生成文件或新增 MCP 工具。
- owner 登记的 baseline_materials 关联确切受控证据对象，运行时只读。服务核对 repo、commit、source_revision、locator、hash、材料类型、现行 read/evidence ACL、状态与保留期，再实际读取文件校验 SHA-256。请求材料引用不会触发任意 URL 获取或代码执行。
- 人工填写中立问题、检查范围与完成确认、基线答案、最小增量、逐断言来源、缺失代价和理由。human-v1 规则拒绝伪造 isolated_check/model_version；未来隔离检查器接口只接收中立问题与材料，不接收候选正文。
- 未完成检查必须 inconclusive；无可靠基线、未确认/推断断言或未解决问题进入 needs_confirmation。代码/测试行为不能单独确认历史决策。priority 只影响队列排序，不授予可信度。
- index_only/link_existing 生成授权导航，不创建已发布知识；有来源支持的 missing_context 增量进入 knowledge_candidate。显式无复用价值/重复的人工理由可 discard。authoritative_mirror 保留 link_existing，进入待独立镜像批准，不能伪造 missing_context。
- 所有 B05 写操作锁 contribution → candidate；expected_revision 对照当前候选版本。判定保存也递增候选版本并追加正文快照，防止相同版本的并发判定覆盖。判定 id 保持稳定、revision 追加，旧文档和 claim_evidence 映射不重写。
- 同 operation_id 恢复原判定版本，不重复更新状态、生成导航或写 outbox；异 actor/route/payload 拒绝。恢复旧结果前重新授权历史确切来源。
- 候选编辑支持把 B03 evidence_mappings 中新上传证据绑定到正文；编辑后当前判定为 null、旧导航不再返回、待处理状态回到 accepted，历史检查仍保留。范围变更和修订目标编辑保留给后续治理流程。
- 贡献 route_counts 从当前候选版本的判定计算；兄弟候选并发时不会丢计数。全部索引/链接/丢弃可以 completed 且 knowledge_candidate/published_ids 为零。仍有未检查候选时 accepted，有缺口时 waiting_confirmation，有经验或镜像待审时 waiting_review。job succeeded 只表示所有候选已提交人工阶段结果，不表示已审核或发布。
- GET 候选/待审队列读取当前判定，未检查保持 assessment=null。所需来源不可见时给无原题名/断言/定位的安全占位，不产生可批准动作；无候选 review scope 时统一安全 404。
- 导航返回前重查来源权限、状态和当前候选/判定版本，旧版本导航隐藏；普通导航不充当经验建议。审核队列按 priority → created_at → id 排序，游标只包含排序位置并签名绑定主体/授权版本/接口/scope/query；服务重启需重新获取 cursor。
- 新增加法迁移 004，未修改历史 001/002/003。API 增加判定/映射/导航写权限与候选/贡献/job 更新权限，仍不能写基线登记、修改判定历史、读令牌或写批准/知识发布。

## 使用

新合成库使用更新后的 Compose 初始化；已有库由 owner 显式追加 004，不自动认领旧 Compose 历史或删除卷。`pnpm synthetic:seed` 配置接收权限和 B05 scope grants，并登记四份公开合成 code/test/authoritative_doc/history 材料。API 和 seed 使用相同私有证据目录，默认 `.local/evidence`，可由 operator 配置 AKB_SYNTHETIC_EVIDENCE_DIR。

开启 AKB_SYNTHETIC_CONTRIBUTIONS=1 并重启 API 后，`pnpm synthetic:assessment` 通过真实 HTTP/共享 SDK 演练五路分流、同键恢复与导航读取。演练只处理合成文本，不宣称真实仓库检查、独立审核或模型执行。

## 验证

执行 `pnpm verify`、`pnpm test:database` 与 `pnpm contracts:check:sql`。环境 Node 24.19.0 / pnpm 10.17.1；项目固定 Node 24.20.0 未改。数据库使用随机 loopback 端口、无主机挂载或持久卷的临时 PostgreSQL 17.6；写夹具前核验随机 guard，结束自动删除容器。

最终结果：

- `pnpm verify` 通过：契约/SDK 漂移、构建、严格类型检查、lint、24 项普通测试和格式检查。3 个数据库套件在普通测试中明确 skipped，并由下面命令实际执行。
- `pnpm test:database` 通过：32 项测试、0 失败、0 skipped，包含 B05 的 11 个业务子用例、B03 的 11 个子用例与原有迁移/授权套件；显式 seed 和两个真实 HTTP 合成演练均成功。
- `pnpm contracts:check:sql` 通过：001/002/003/004 SQL、运行角色权限、契约约束和租户隔离检查。临时测试容器已自动删除，现有开发库未自动升级或重置。

覆盖五路存取、兄弟候选并发计数、零知识产出、未检查/P0/推断负例、材料分类/定位/hash/版本伪造、历史原因证据、同候选 CAS 竞争、幂等历史恢复、候选编辑与旧导航失效、镜像例外、优先级/签名分页、HTTP 与共享 SDK、scope 越权、运行角色登记权限拒绝、读证据时撤权回滚和安全占位。B03 接收与原有迁移/授权套件同时回归；显式 seed 实际执行两次，并通过监听 loopback 的真实 HTTP 跑两个合成演练脚本。

## 下一步与保留边界

下一任务 B06：独立审核、retained 必要证据、审核/候选/判定/证据/目标绑定、发布 gate 和异步发布恢复。当前 current_approval/latest_review/current_publication 均为 null，allowed_actions 为空，并给出 CAPABILITY_NOT_READY 阻断；没有自动批准或发布。

真实 OIDC/仓库快照/权威材料接入、包级零候选处理、自动提炼、retained 提取、到期磁盘清理、Git 正文版本库、Worker 任务领取/outbox 投递、知识检索和验证业务尚未实现。中立问题与断言语义由人工检查者负责，服务只校验结构与可审核来源，不以字符串相似或模型自评分证明正确性。S0/S1 不标通过。
