# AccreMind 与 TeamAI 的对比

> 对象：**AccreMind**（本仓库，v0.1.0）与腾讯开源的 **TeamAI CLI**（`Tencent/teamai-cli`，`npm install -g teamai-cli`）。
> TeamAI 的事实取自其公开仓库 `docs/product-overview.zh-CN.md`、`docs/guide/zh-CN/knowledge.md` 与 README（2026-11 抓取）；Team Context / Team Improvement 仍标 beta，实现可能变动。
> AccreMind 的事实取自本仓库 README、`docs/ARCHITECTURE.md` 与 `CHANGELOG.md`。

## 一句话

**TeamAI 是"团队 AI 工作方式的发行版 + 组织知识中枢"，AccreMind 是"嵌进单次改动的知识注入器"。**
前者解决"全团队的 Agent 资源怎么统一、经验怎么汇到一处"；后者解决"这条经验怎么在它该出现的那个回合恰好出现，并且能被证伪和淘汰"。

两者在"经验沉淀"上有重叠，在产品层次上基本不重叠。

## 各自是什么

| | AccreMind | TeamAI |
| --- | --- | --- |
| 形态 | 三个包：无宿主依赖的内核（`@accremind/core`）、DSH 插件、独立工作台；另有 CLI | 一个全局 CLI + 一个团队 git 仓库 + 各 AI 工具的 hook/规则文件 |
| 运行位置 | 开发者本机；知识随仓库 Git 走 | 本机 CLI + 团队远端（GitHub / GitLab / GitCode / CNB / TGit / 私有 Git） |
| 数据 | 仓库内 `.accremind/` Markdown 卡片 + 本机 `~/.dsh/accremind/` 的 SQLite（FTS5）索引 | 团队仓库 `skills/ rules/ agents/ learnings/ teamwiki/ mcp/ models/ hooks/` 等 |
| 依赖 | Node ≥ 24，零第三方运行时依赖，无服务、无遥测 | Node + npm 全局包 + git 远端；部分能力需 AI 工具与 token（如 iWiki 导入要 `TAI_PAT_TOKEN`） |
| 宿主面 | DSH 是首个且最完整的接入；内核 host-agnostic，换宿主写适配层 | 原生多工具：把同一套 skills/rules/MCP/hooks 分发到成员各自的 AI 工具 |

## 逐项对比

| 维度 | AccreMind | TeamAI |
| --- | --- | --- |
| **主问题** | 代码与文档还原不出来的经验增量，在改动前自动出现，且会失效、会被淘汰 | 团队的 Agent 资源统一分发；团队经验可检索；团队怎么用 AI 可观测 |
| **知识单位** | Markdown 卡片（`decision / pitfall / model / guideline / process`），必须带 `knowledge_delta`、证据定位与符号锚 | `learnings/`（可晋升为 skill/rule/doc）、`rules/`、`docs/`、`teamwiki/` 代码页 |
| **采集入口** | 会话捕获 + 五路分诊（`index_only / link_existing / knowledge_candidate / needs_confirmation / discard`）+ 人工确认 | 会话摩擦提醒（打断、重试）→ agent 提议 → 人确认；`teamai contribute`；`teamai import --from-tools / --from-iwiki / --from-mr` |
| **何时进入模型** | **推**：三层预算注入——常驻规则 500 tokens（字节稳定保 KV 缓存）、回合提醒 300、文件护栏 240/1500 | **拉**：`teamai recall` 检索（默认关闭）；常驻部分靠 pull 把 rules/claudemd/hooks 写进各工具 |
| **相关性控制** | 每层独立 token 预算 + 适用性闸门，"不确定相关宁可不提" | recall 返回排序 + 置信度；常驻规则文件本身无预算 |
| **失效治理** | `watch_paths` + 符号锚 hash + 复核窗口；代码漂移进待复核，纯格式化不误报；反例立即 suspend | 代码页有 `Source freshness`；learning 侧主要靠置信度衰减、`recall maintenance --prune/--archive`（< 0.15 收走） |
| **转正机制** | `probation → verified`，靠**真实回合使用与确认**；重复曝光无验证则归档 | **置信度**（采纳比率 + 评审者加权 + 近期度）；≥ 0.90、≥ 5 upvote、≥ 2 贡献者、≥ 14 天 → 晋升 skill/rule/doc，走 PR 评审 |
| **关系模型** | `supersedes / specializes / overrides` + `tags / domains`；专门化对不共现 | `related:` 的 `MAPS_TO / REFERENCES / SUPERSEDES / CONFLICTS_WITH`；代码图另有 `DEPENDS_ON / CONTAINS / IMPLEMENTS` |
| **作用域** | `personal / project / domain / shared_tech / team_rule`；`team_rule` 只能人提议、免于自动降级 | namespace + `manifest/projects.yaml`、`manifest/roles.yaml` 声明；`<namespace>/` 只发给声明的角色与项目 |
| **协作流程** | 仓库内 Markdown 走 Git 提交与评审（无封装） | `teamai push` → 分支 + PR → 评审合并 → SessionStart hook → `teamai pull` |
| **代码结构知识** | **明确非目标**（不是代码知识图谱） | `teamwiki/` 代码知识图谱是核心能力，`teamai import --dir/--from-repo/--from-org` 生成 |
| **评估/观测** | `accremind eval`：回放真实反馈与手写用例、`--grid` 扫参、`--apply` 仅在分数提升时写回；自动调参带观察窗与回滚 | `teamai digest` 周报、`teamai dashboard` 本地看板、scorer、使用统计上报、`teamai stats`（召回/采纳/打开） |
| **自演化** | 有，且默认关：每周调参（≥ 30 样本、分数 +0.03、召回降幅 ≤ 0.02）+ 自动降级，全部可撤销 | 置信度与晋升阈值可配；`--update-quality` 给"常召回少采纳"的条目起草修订 |
| **成熟度** | v0.1.0，单人/小团队项目，DSH 生态 | 腾讯开源，已有版本迭代与多 Git 平台适配；Team Context / Team Improvement 标注 beta |

## 五个决定性差异

### 1. 推 vs 拉：经验会不会真的被用上

AccreMind 的赌注是**注意力预算**：每轮开头 500 tokens 常驻、300 tokens 相关条目、碰文件时 240/1500，全部自动发生。开发者不需要"想起来去搜"。
TeamAI 的 recall **默认关闭**，打开后也要求 agent 在任务前主动检索。它的强项是覆盖面（团队所有仓库、所有工具），弱项是触发依赖习惯。

这条差异决定了两者适合的知识类型：AccreMind 适合"这条坑每次改这个模块都会踩"；TeamAI 适合"新同学要查、别的团队也可能用"的团队资产。

### 2. 验证信号：行为证据 vs 社会性指标

- AccreMind 的 verified 来自**这个回合它被使用、并且被确认**；反例直接 suspend；没被用上的会被降级、归档，且每一步可撤销。
- TeamAI 的置信度是"召回过它的会话里有多少采纳了它"，再叠加评审者判定与近期度。它衡量的是**活动度**，文档自己也写明"不是知识正确或任务成功的概率"。

结果：AccreMind 的库更小更硬，TeamAI 的库更大更活。前者防止"写了没人看"，后者防止"好经验沉底"。

### 3. 失效锚点：符号级 vs 页面级

AccreMind 把每条经验锚到 `watch_paths` 和函数符号 hash，代码一漂移就进复核队列——这是它最工程化的一块。
TeamAI 的 `Source freshness` 作用在 teamwiki 代码页上；公开文档里没有见到 learning 级的 watch_paths/符号锚，learning 失效主要靠置信度衰减与人工 `--prune`。

对"这个接口重试会重复扣款"这类知识，AccreMind 的锚点更可靠；对"支付域整体怎么分层"，TeamAI 的代码图谱信息量更大。

### 4. 分发与治理：仓库级 vs 组织级

AccreMind 的作用域止于"同一业务领域的多个仓库"（`domain` / `shared_tech`），团队规范 `team_rule` 需要人提议，但没有角色/项目级的定向分发，也没有 PR 封装。
TeamAI 把"谁能拿到哪些 Agent 资源"做成了 manifest：namespace 按角色与项目下发，push/pull 走分支与评审，规则/技能/MCP/模型全部版本化。

这是 AccreMind 当前最明显的空白：它没有"发行层"。

### 5. 边界：一个做注入，一个做发行

AccreMind 明确不做代码知识图谱、不做通用聊天记忆、不写代码不执行命令；TeamAI 明确要做代码结构、会话迁移、使用统计。两者的非目标几乎互补。

## 重叠区与各自独有

| 能力 | AccreMind | TeamAI |
| --- | --- | --- |
| 会话经验沉淀 | ✅ 五路分诊 + 增量门禁 | ✅ 摩擦提醒 + contribute |
| 人工确认后入库 | ✅ | ✅ |
| 团队规范/规则 | ✅ `team_rule` + 规约文档 | ✅ `rules/` + `claudemd/` |
| 知识检索 | ✅ 本机 FTS5 + 适用性闸门 | ✅ recall（混合检索 + 关系行） |
| 自动注入到回合 | ✅ 三层预算 | ⚠️ 仅规则文件常驻，无预算与相关性闸门 |
| 代码锚定与自动失效 | ✅ 符号锚 + 复核队列 | ⚠️ 代码页 freshness，learning 侧弱 |
| 跨工具分发 | ❌（导出 skill 只到 `.dsh/skills/`） | ✅ 多工具 |
| 角色/项目定向分发 | ❌ | ✅ namespace + manifest |
| 代码结构图谱 | ❌ 非目标 | ✅ `teamwiki/` |
| 离线评估与调参回滚 | ✅ `eval` + `--grid` + 自动回滚 | ❌（有 dashboard 与 scorer，无离线回放调参） |
| 组织级使用观测 | ❌ | ✅ 统计上报 + dashboard |

## 怎么选

- **一个人或一个小队，主力在 DSH 里写代码，想让上周的坑这周自动出现** → AccreMind。零服务、零配置、知识随仓库走。
- **几十人、多个 AI 工具并存，需要把 skills/rules/MCP 统一发下去，并让跨仓库代码结构可检索** → TeamAI。组织成本高，但这是它唯一能做的事。
- **两者都要** → 分层：TeamAI 做发行层（谁拿到什么、代码图谱、跨工具），AccreMind 做注入层（每轮把仓库级增量推到模型眼前 + 符号级失效治理）。AccreMind 的卡片可以作为 TeamAI `learnings/` 的高质量来源；TeamAI 的 `teamwiki/` 可以补 AccreMind 明确不做的结构检索。

## 对 AccreMind 的四条启示

1. **补发行层，而不是补图谱**。缺的不是代码结构，是"`.accremind/` 怎么在组织内被聚合与定向分发"。最小可行：一个只读的 `accremind export --bundle` 产出可被团队仓库引用的卡片集，加上 `domain` 级的订阅。
2. **把 eval 包装成"晋升前回归"**。TeamAI 没有离线回放调参，这是 AccreMind 的差异化优势；现在它藏在 CLI 里，应该出现在候选评审和工作台的"转正"动作上。
3. **常驻规则可以做成"规则文件生成器"**。字节稳定的 500 tokens 是稀缺能力：直接生成 `AGENTS.md` / `CLAUDE.md` 的受管段落，比要求团队手写更可信。
4. **接受"推"的代价**：预算与闸门是护城河，但也意味着漏召回。可以给手动深搜留一个显式入口（现在有 `accremind_search` 工具，但缺"这次没注入、我想查一下"的提示）。
