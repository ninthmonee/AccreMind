<div align="center">

# ![AccreMind](docs/brand/accremind-wordmark-dark.svg#gh-dark-mode-only)![AccreMind](docs/brand/accremind-wordmark-light.svg#gh-light-mode-only)

**模型总会被下一代取代，知识不会。**

—— 把散落在项目里的经验，沉淀成可以复用的知识资产。

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/ninthmonee/AccreMind/actions/workflows/ci.yml/badge.svg)](https://github.com/ninthmonee/AccreMind/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-339933.svg)](https://nodejs.org)
[![内核与宿主无关](https://img.shields.io/badge/%E5%86%85%E6%A0%B8-%E5%AE%BF%E4%B8%BB%E6%97%A0%E5%85%B3-6c6cf0.svg)](#宿主模型)
[![DSH 插件](https://img.shields.io/badge/DSH%20%E6%8F%92%E4%BB%B6-%E2%89%A50.2.2--rc.5-4d6bfe.svg)](#deepseek-harnessdsh)

</div>

AccreMind 是面向 AI 辅助研发的本地优先知识库。它把散落在各个项目里的经验——每一次决策、试过又被推翻的路线、领域规则与团队通用约定、踩过的坑，以及它们彼此之间的关联——变成可以提交、可以评审、可以复用的 Markdown 知识资产；然后在下一次改动发生之前，把它们递回到模型和开发者眼前。

所有内容都留在你自己的机器上：Markdown 是事实来源，`node:sqlite`（WAL + FTS5 trigram）只是可随时重建的索引。没有后台服务，没有外部向量库，没有遥测。

---

## 目录

- [为什么需要它](#为什么需要它)
- [它是怎么工作的](#它是怎么工作的)
- [宿主模型](#宿主模型)
- [我们要沉淀哪些知识](#我们要沉淀哪些知识)
- [三层注入](#三层注入)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [宿主接入](#宿主接入)
- [独立工作台](#独立工作台)
- [团队知识库、领域与挂载范围](#团队知识库领域与挂载范围)
- [数据放在哪](#数据放在哪)
- [命令行](#命令行)
- [模型配置（可选）](#模型配置可选)
- [设计原则](#设计原则)
- [与其它方案的区别](#与其它方案的区别)
- [非目标](#非目标)
- [环境要求](#环境要求)
- [开发与验证](#开发与验证)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 为什么需要它

模型的上下文会滚动丢弃，人的记忆会衰减，而文档通常只留下结论、丢掉理由。

真正让团队付出过代价的知识——"这个接口重试会重复扣款""这个库 3.x 之后在 SSR 下不能动态导入""队列方案我们试过，回滚了"——通常躺在某个聊天线程、某份复盘，或者某个人的脑子里。它恰恰是写下一次改动时最缺的那部分，也是 AI 助手最无法从仓库里推断出来的那部分。

AccreMind 只把这部分差值（delta）沉淀成资产，别的都不存。

## 它是怎么工作的

三个时刻，一个知识库：

| 时刻 | 发生什么 |
| --- | --- |
| **改动之前** | 与本回合相关的条目以**引用**形式注入——id 加一行摘要，并显式标注为素材而非指令 |
| **改动之中** | 读到某条目监视的文件时，展开完整条目：前置条件、反例、如何验证、证据在哪 |
| **改动之后** | 回合尾部生成回执，列出本条用了什么，并提供「有帮助 / 没帮助 / 不准确」一键反馈 |

## 宿主模型

AccreMind 不属于任何单一宿主。内核 `@accremind/core` 是一个零依赖的 Node.js 库——只 import `node:*` 内建模块——并由三个共享同一套公开 API 的入口驱动：

| 入口 | 包 | 需要宿主吗 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件 | `@accremind/dsh-plugin` | 是——第一个，也是目前最完整的宿主接入 |
| 命令行 | `accremind`（在 `@accremind/core` 内） | 否 |
| 独立工作台 | `@accremind/webui` | 否 |

DSH 是第一个适配层，不是设计中心：回合钩子、工具、侧边栏面板与技能导出，是宿主能提供的表面，而每一处都只是对内核的一层薄映射。接入新的宿主——IDE 扩展、服务端——就是写一个适配层，调用公开 API，并用那个宿主自己的表达方式还原同样这三层注入。

DSH 接入确实带了 DSH 形状的默认值：个人状态放在 `~/.dsh/accremind/`（可用 `globalDir` 覆盖），导出的技能落在 `.dsh/skills/<slug>/SKILL.md`。这些是适配层的约定，不是内核数据模型的约定——知识本身始终是仓库里的纯 Markdown。

## 我们要沉淀哪些知识

"散落在项目里的经验"不是一句口号，而是六类具体知识，每一类在库里都有明确归属：

| 类别 | 实际长什么样 | 条目类型 | 所在层 |
| --- | --- | --- | --- |
| **决策与理由** | 为什么选这个设计、付出了什么代价、它排除了哪些后续选项 | `decision` | `project` |
| **坑与试过被推翻的路线** | "这个接口重试会重复扣款"；"队列方案我们试过，回滚了" | `pitfall` | `project` |
| **领域规则** | 业务不变量、时序规则、已结算订单永远不能变成什么 | `model` / `guideline` | `domain` |
| **团队通用约定** | 命名、错误信封、迁移写法、评审预期 | `guideline` / `process` | `project`；被确认为团队规范后进入 `team_rule` |
| **共享技术坑** | "这个库 3.x 之后在 SSR 下不能动态导入"——在每个仓库都成立 | `model` / `pitfall` | `shared_tech` |
| **流程知识** | 这个项目实际怎么发版、怎么灰度、怎么处理线上事故 | `process` | `project` / `personal` |

让它成为「知识资产」而不是「笔记堆」的，是另外两条：

- **关联本身就是记录的一部分。** 条目会写明它 `supersedes`（替代）了谁、`specializes`（细化）了哪个共享技术条目、`overrides`（豁免）了哪条团队规则，以及属于哪些 `tags` 与 `domains`。存在细化关系的一对条目不会同时下发，所以是「新结论替换旧结论」，而不是越堆越多的互相矛盾。
- **作用域决定谁能看到。** `personal` 只属于你，`project` 留在本仓库，`domain` 与 `shared_tech` 可以跨仓库复用，`team_rule` 是组织级——它只能由人提出，自动沉淀永远不会写入，也不会被自动降级或归档。

### 明确不沉淀的东西

- 代码、测试和现有文档里已经写清楚的内容。
- `git log` 随手就能还原的 diff 与文件清单。
- 本机路径、一次性的环境噪声。
- 没验证过的猜测：它们会留在 `needs_confirmation` 等人裁决，没人背书就丢弃。

### 候选如何被筛选

只接受 **`knowledge_delta`**——读者无法从代码和现有文档中还原的那部分。每个候选都要过五路分流：

| 处置 | 含义 |
| --- | --- |
| `index_only` | 代码/文档里本来就能查到；建索引供检索，不存卡片 |
| `link_existing` | 与已有条目重复；建立链接，不新增 |
| `knowledge_candidate` | 真正的差值；升级为 Markdown 卡片 |
| `needs_confirmation` | 看起来合理但尚未验证；挂起等人裁决 |
| `discard` | 空差值、猜测，或本机路径；丢弃 |

新卡片一律先进入 `probation`（试用期），只有被真实回合命中并验证之后才会转成 `verified`——不会自我提拔。

## 三层注入

| 层 | 触发时机 | 默认预算 | 作用 |
| --- | --- | --- | --- |
| 常驻规则 | 每回合开始 | 500 tokens | 团队硬约束；字节稳定，让 KV 缓存得以命中 |
| 回合雷达 | 每回合按查询匹配 | 300 tokens | 以 id 形式列出匹配条目，标注为参考资料 |
| 工具护栏 | 读写被监视的文件时 | 240 / 1500 tokens | 同一文件被触及时展开完整条目 |

三层都是只读参考资料，不覆盖宿主规则，也没有执行权限。

## 核心能力

- **本地优先的两级存储** —— 团队知识放在仓库内 `.accremind/`（可以提交、可以在 PR 里评审）；草稿、队列、索引与个人检索日志放在 `~/.dsh/accremind/`。索引随时可以从 Markdown 重建。
- **五路分流** —— `index_only / link_existing / knowledge_candidate / needs_confirmation / discard`，让代码里能还原的内容不污染知识库。
- **影子试用期** —— 新条目先静默参与检索，被独立验证后再转正；反复曝光却始终没有反馈的条目会被归档。
- **失效与符号锚点** —— 条目记录 `watch_paths` 与符号锚点哈希。代码变化或复审窗口过期会把条目推入复核队列，出现反例则立即挂起；纯格式化改动不会触发误报。
- **规则文档集** —— `domain` / `business_rules` / `project_norms` / `project_profile` 四类，按 `##` 小节建索引，支持导入、变更提案、接受/驳回与变更日志，落在 `.accremind/docs/`，跟代码一起评审。
- **跨仓库知识** —— 仓库身份依次取自 `.accremind/repo.json`、`origin`、路径哈希。`domain` 与 `shared_tech` 层的条目可在同域仓库之间共享。
- **结构化的知识关联** —— 条目标明它 `supersedes`（替代）了谁、`specializes`（细化）了哪个共享技术条目、`overrides`（豁免）了哪条团队规则，并与相关知识共享受控词表的 `tags` 与 `domains`。这些关联在检索与注入时会被尊重——细化关系的一对条目不会同时下发——结构因此不会退化成散文里的链接。
- **回执与离线评估** —— 每回合留存脱敏后的问题与反馈；`accremind eval` 用真实反馈和 `.accremind/eval/cases.jsonl` 里手写的真实问题回放，报告同时给出三组对照：什么都不提醒（`off`）、只提醒常驻团队规范（`rulesOnly`）、以及完整提醒路径，`lift` 就是后者比前者多做的部分。`--grid` 扫参数，只有分数变好才 `--apply` 写回。
- **工作台** —— 七个视图：总览、知识库、候选审核、规则文档、治理、回合记录、Git 雷达。已验证条目可以导出为 `.dsh/skills/<slug>/SKILL.md`。
- **可审计、可回滚的自我改进** —— 由 `autoEvolve: { tune: false, demote: false }` 控制：
  - *自动调参*：会话打开一分钟后触发，每个仓库每周最多一次。只有在标注样本 ≥ 30、分数提升 ≥ 0.03、召回下降不超过 0.02、且被驳回条目没有更多曝光时才会生效；生效后进入观察窗，如果调整后的反馈或「实际不适用率」变差就自动回滚。每一步都记在 `~/.dsh/accremind/tuning-history.jsonl`，可以撤销。
  - *自动降级*：当前修订下若有两个以上会话把某已验证条目标为「不适用」且占比 ≥ 25%，或该条目 30 天内曝光 ≥ 40 个会话却从未被打开、引用或确认，就退回到试用期。挂起条目 30 天无人处理归档，试用草稿 60 天归档。团队规范条目、在当前修订上被确认过的条目、有反例支撑的条目不在降级范围内。每次动作都会进入总览的「需要你关注」列表，并支持一键撤销。

## 快速开始

### 从源码安装（npm 发布前推荐）

```bash
git clone https://github.com/ninthmonee/AccreMind.git
cd AccreMind
pnpm install
pnpm build      # 构建 core、插件与内联的工作台产物
pnpm verify     # 构建 + 全量测试 + 工作台产物指纹
```

然后把插件装进 DSH profile：

```bash
pnpm install:dsh                      # 默认 desktop profile
pnpm install:dsh -- --profile web     # 或指定其它 profile
```

### 从插件市场安装

包名是 `@accremind/dsh-plugin`；在 DSH 的「自定义插件索引」里填这个地址：

```
https://raw.githubusercontent.com/ninthmonee/AccreMind/main/market/index.json
```

路径是 **插件 → 实验性插件 → 自定义插件索引**，然后在 Discover 里安装 **AccreMind**。发布细节见 [docs/market-publishing.md](docs/market-publishing.md)。

## 宿主接入

### DeepSeek Harness（DSH）

参考实现。安装后侧边栏会出现 `AccreMind` 面板，条目会在对话需要时自动注入，每个回合尾部追加一份回执。模型可以使用六个工具：

| 工具 | 用途 |
| --- | --- |
| `accremind_capture` | 提交候选并跑五路分流 |
| `accremind_search` | 按关键词、类型、层级或文件路径检索 |
| `accremind_get` | 取全文、前置条件、验证步骤与证据 |
| `accremind_validate` | 记录本次使用的成功或失败；`failure` 会挂起该条目 |
| `accremind_export_skill` | 把已验证条目固化为 DSH 技能文档 |
| `accremind_propose_doc_change` | 对规则文档提出变更，交人评审 |

## 独立工作台

不装 DSH 也能跑同一套界面（默认 3180 端口，仅回环）：

```bash
pnpm ui -- --port 3180
```

| 视图 | 回答什么问题 |
| --- | --- |
| 总览 | 有什么需要我处理，知识库健康度如何 |
| 知识库 | 浏览、检索、汇总全部条目 |
| 候选审核 | 对照基线与差值，核对证据 |
| 规则文档 | 领域、业务规则、项目规范与待处理提案 |
| 治理 | 失效复核、反例、设置 |
| 回合记录 | 每个回合到底用了哪些条目 |
| Git 雷达 | 从提交历史里扫描高信号经验 |

改界面用 `pnpm dev:webui`（Vite HMR）。发布前务必运行 `pnpm verify`：`check:webui` 会比对 `packages/webui` 源码与内联产物，避免界面改动没进发布包。

## 团队知识库、领域与挂载范围

一份知识属于谁，决定它提醒给谁。AccreMind 分三层挂载：

| 挂载到 | 适合 | 保存在 | 提醒给 |
| --- | --- | --- | --- |
| 本项目 `project` | 项目规范、项目概况、只属于本仓库的业务规则 | `<repo>/.accremind/docs/` | 本仓库；可再限定到一个子项目 |
| 领域 `domain` | 领域说明、跨项目共享的业务规则 | 团队知识库（未挂载时为本仓库） | 属于该领域（含下级领域）的所有项目 |
| 个人 `personal` | 个人偏好（回答风格、习惯） | `~/.dsh/accremind/personal/docs/<用户>/` | 只有你自己，不进 Git |

**团队知识库**是一个独立的 Git 仓库，放团队共享、又不属于任何单个项目的东西：

```
<团队知识库>/
├── domains/<领域>.json        # 每个领域一个文件：名称、别名、上级、负责人
├── members/<仓库>.json        # 每个仓库一个文件：它属于哪些领域（核心 / 使用方，可限定子项目）
├── docs/<类别>/*.md          # 领域文档 + changes.ndjson + CHANGELOG.md
└── feedback/<仓库>/<用户哈希>.json  # 每个人的使用计数（只有计数，没有提问内容）
```

```bash
pnpm accremind team set ~/code/team-knowledge     # 挂载；没有挂载时用本机 ~/.dsh/accremind/knowledge/
pnpm accremind domains add 退款 --parent 支付 --aliases refund --owners lead@example.com
pnpm accremind domains join 退款                   # 本仓库作为核心项目加入
pnpm accremind domains join 支付 --role consumer   # 只是调用方：看得到面向所有人的规则，看不到“仅核心项目”的内部细节
pnpm accremind subprojects add pay --paths services/pay/ --domains 支付 --owners pay-dev@example.com
pnpm accremind docs import refund.md --category business_rules --scope domain --domains 退款 [--audience core]
pnpm accremind docs import norms.md --category project_norms --subproject pay
pnpm accremind docs import my-prefs.md --category personal_preferences
```

- 一个领域可以有多个项目，一个项目也可以属于多个领域；上级领域的规则会提醒给下级领域的项目。
- 领域目录按“每个领域一个文件、每个仓库一个成员文件”存放，不同人新建领域或加入领域不会改同一个文件，Git 合并不冲突。旧版的 `domains.json` 会在第一次修改时自动拆分。
- 挂载了团队知识库时，导入不在目录里的领域名会被拒绝（防止拼写分叉），确认是新领域加 `--new-domain`；工作台的导入弹窗可以直接新建领域（可选上级），并让本仓库加入。
- 工作台导入支持上传 Markdown 文件（可多选、可拖入），也可以直接粘贴。
- 挂载到“本项目”时可以选目标项目：默认是当前打开的项目，也可以选本机登记过的其他项目，或浏览文件夹选择任意项目。
- 先在本机建了领域、之后才挂载团队知识库时，本机的领域和成员关系会在挂载时带过去（只带一次，团队已有的文件不覆盖）。
- AccreMind 只写文件、不会替你提交或推送。规则文档页顶部会提示 `.accremind/` 和团队知识库里还有多少改动未提交、未推送或未拉取。
- 规则文档页可以按挂载范围、领域（含下级领域和别名）、存放位置筛选，并全文搜索章节内容；知识库页可以按领域和子项目筛选经验。
- 个人偏好跟着人走：同一个人从本机身份切到宿主登录账号（或反过来）时，偏好文档会自动移到当前身份下。
- 冲突时的优先级：团队规范 > 项目规范与经验 > 领域规则 > 个人偏好。个人偏好常驻但排在最后。
- 经验的证据引用了文档章节（`D:<文档>#<章节>`）时，章节被修改或删除，这条经验自动转为待复核。
- 回合记录会写明每条提醒的命中理由；反馈“不适用”时可以选原因（领域不对、不是这个项目或子项目、版本不对、已过时、和这次问题无关）。

**项目级设置**写在 `.accremind/repo.json`，随仓库评审：

```json
{
  "domains": ["refund", "payment:consumer"],
  "owners": ["team-lead@example.com"],
  "projects": [{ "id": "pay", "paths": ["services/pay/"], "domains": ["refund"], "owners": ["pay-dev@example.com"] }],
  "settings": {
    "budgets": { "turnRadarTokens": 400 },
    "tuning": { "textSaturation": 6 },
    "autoDemotion": { "demoteUnusedShownSessions": 12 }
  }
}
```

自定义了 `settings.tuning` 的项目不参与自动调参。负责人决定待办归谁：经验按“领域负责人 → 子项目负责人 → 仓库负责人”找人，工作台可以“只看我的”，`pnpm accremind digest` 输出近 7 天的摘要（待办、自动降级、文档变更、调参、提醒效果），读者按 Git 用户名称呼。

## 数据放在哪

| 路径 | 内容 |
| --- | --- |
| `<repo>/.accremind/entries/` | 已验证经验卡片（Markdown，含修订与证据） |
| `<repo>/.accremind/evidence/` | 证据附件 |
| `<repo>/.accremind/rules/` | 常驻规则 |
| `<repo>/.accremind/docs/` | 四类规则文档与变更日志 |
| `<repo>/.accremind/repo.json` | 仓库身份、业务领域、子项目、负责人与项目级设置（建议提交） |
| `<团队知识库>/` | 领域目录、领域文档与团队使用计数（独立 Git 仓库） |
| `~/.dsh/accremind/knowledge.json` | 团队知识库挂载位置（`ACCREMIND_KNOWLEDGE_ROOT` 可覆盖） |
| `~/.dsh/accremind/personal/docs/` | 个人偏好文档，按人分开 |
| `~/.dsh/accremind/probation/` | 试用期草稿（不写进仓库） |
| `~/.dsh/accremind/queue/` | 自动沉淀与评估队列 |
| `~/.dsh/accremind/index/` | 可重建的 SQLite 索引 |
| `~/.dsh/accremind/{personal,domain,shared-tech}/` | 跨仓库知识层 |
| `~/.dsh/accremind/{registry,users,workspaces}/` | 仓库注册表、用户身份、按仓库的检索日志 |

## 命令行

```bash
pnpm accremind status                     # 总览 + 失效巡检
pnpm accremind search "订单重试" --scope auto --file packages/core/src/store/local-store.ts
pnpm accremind get K-XXXX                 # 查看完整条目
pnpm accremind rebuild                    # 从 Markdown 重建索引
pnpm accremind bootstrap --top 10         # 从 Git 历史扫描高信号提交
pnpm accremind bootstrap --extract        # 交给模型做分流
pnpm accremind migrate                    # 跨仓库迁移演练；--apply、--rollback
pnpm accremind repo --domains payments,ledger:consumer [--new-domain]
pnpm accremind team [set <dir> | unset]  # 团队知识库
pnpm accremind domains [list | add | join | leave]
pnpm accremind subprojects [list | add <id> --paths a/,b/ | remove <id>]
pnpm accremind docs import ./adr --category business_rules --scope domain --domains refund
pnpm accremind docs list --scope domain --domain payment   # 另支持 --category、--query
pnpm accremind docs search partial refund
pnpm accremind docs proposals             # 待处理的文档与词表提案
pnpm accremind docs accept <proposal-id>
pnpm accremind eval                       # 回放真实反馈 + cases.jsonl，附 off / rulesOnly 对照基线
pnpm accremind eval --grid --apply        # 回放反馈并调参，只有更好才写回
pnpm accremind eval auto                  # 立即执行一轮调参（含观察窗判定）
pnpm accremind eval history               # 调参历史与观察状态
pnpm accremind eval rollback              # 撤销上一次调参
pnpm accremind usage [--days 7]           # 自动提炼/主题标注的调用次数与 token 用量
pnpm accremind demotions [--all]          # 自动降级/归档记录
pnpm accremind demotions restore K-XXXX   # 撤销某条降级或归档
pnpm accremind digest [--days 7] [--json]   # 近 7 天摘要：待办、自动变更、文档变更、提醒效果、模型用量
pnpm accremind ui --port 3180
```

所有命令都接受 `--repo` 与 `--global-dir`，默认是当前目录与 `~/.dsh/accremind`。

## 模型配置（可选）

检索、提醒、文件护栏与失效巡检完全本地，不需要任何 key。只有**抽取**（`bootstrap --extract`、工作台里的抽取、以及开启后的自动沉淀）会调用模型。插件默认复用宿主的 `llm` 服务；也可以用环境变量指向外部端点：

```bash
cp .env.example .env
# ACCREMIND_LLM_BASE_URL / ACCREMIND_LLM_MODEL / ACCREMIND_LLM_API_KEY
# 或 DEEPSEEK_API_KEY / OPENAI_API_KEY
```

Key 只会发往它所属的服务：当 `ACCREMIND_LLM_BASE_URL` 指向别的主机时，DeepSeek 或 OpenAI 的 key 不会被带上。

## 设计原则

| # | 原则 | 在实现里的含义 |
| --- | --- | --- |
| 1 | 只存差值 | 先由代码与文档生成基线答案，分流丢掉一切可还原内容 |
| 2 | 本地优先，Markdown 是事实来源 | 每条都是可评审的卡片，SQLite 只是可重建索引 |
| 3 | 是参考，不是指令 | 注入在只读标签内、经过清洗、标注为素材；不覆盖宿主、无执行权 |
| 4 | 证据与新鲜度优先于结论 | 条目带证据位置与符号锚点，代码漂移即进复核队列 |
| 5 | AI 提议，人做裁决 | 先试用后验证；规则文档与词表只在人接受后才变更 |
| 6 | 尊重上下文预算 | 分层 token 预算；常驻块字节稳定以命中 KV 缓存；不确定就沉默 |
| 7 | 可审计、可回滚的自我改进 | 检索参数自动调参并自动回滚；知识内容永不自动改写 |

## 与其它方案的区别

| | AccreMind | `AGENTS.md` / `CLAUDE.md` | Wiki / ADR | 聊天记忆类助手 |
| --- | --- | --- | --- | --- |
| 存什么 | 只存代码里还原不出的差值 | 粘进去的原文 | 决策，很少记坑 | 过往对话轮次 |
| 存在哪 | 仓库内 Markdown 卡片 + 本地索引 | 单个扁平文件，手工维护 | 散文，只能人工搜 | 通常在云端向量库 |
| 何时进入模型 | 三个带预算的时刻 | 每回合整个文件 | 人读到的时候 | 相似度匹配 |
| 新鲜度 | 符号锚点、监视路径、复核队列 | 无 | 手工 | 无 |
| 验证 | 试用期 → 真实使用后转正 | 无 | 有评审则有 | 无 |
| 是否离开本机 | 否 | 否 | 视情况 | 通常会 |

## 非目标

- 不是通用聊天记忆，也不是个人笔记工具。
- 不是代码知识图谱，不索引仓库结构。
- 不替代 ADR——它补的是 ADR 通常省略的那部分。
- 不写代码、不执行命令、不覆盖宿主规则。

## 环境要求

- **Node.js ≥ 24** —— 需要 `node:sqlite` 与 FTS5 trigram 分词。
- **DeepSeek Harness ≥ 0.2.2-rc.5** —— 仅在用插件时需要；声明在 `engines.dsh` 里，低于该范围时 DSH 会拒绝安装或启动该包。命令行与独立工作台只需要 Node.js。

## 开发与验证

```bash
pnpm build          # 构建 core、插件与工作台产物
pnpm build:webui    # 只重建工作台并回写内联产物
pnpm test           # node:test（会先构建）
pnpm verify         # 构建 + 测试 + 产物指纹，提交 PR 前必跑
pnpm typecheck      # kernel 与工作台类型检查
pnpm pack:check     # 校验发布包形态（含宿主兼容性）
pnpm market:index   # 重新生成 market/index.json
```

CI 在每次 push 时运行 `pnpm verify`、`pnpm pack:check` 与市场索引校验。完整流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [架构与设计原则](docs/ARCHITECTURE.md) —— 愿景、七条原则、数据流、生命周期、检索链路、自我改进
- [产品方案 V3.2](<docs/AI 研发知识基座 DSH本地插件产品设计方案 V3.md>) —— 范围、数据模型、验收标准
- [技术方案 V3.2](<docs/AI 研发知识基座 DSH本地插件技术实现方案 V3.md>) —— 模块契约、检索与治理
- [插件市场发布](docs/market-publishing.md) —— 包形态、索引 schema、发布顺序
- [V1 / V2 历史设计](docs/legacy/README.md) —— 2026 年 9 月的两版设计稿，原样归档
- [介绍长文](docs/blog/2026-11-23-accremind-introduction.md) —— 面向团队的完整介绍
- [更新日志](CHANGELOG.md) · [安全策略](SECURITY.md) · [参与贡献](CONTRIBUTING.md)

深入文档目前以中文撰写，英文翻译的进度记录在 [docs/README.md](docs/README.md)。

## 参与贡献

欢迎提 issue 和 PR。请先读 [CONTRIBUTING.md](CONTRIBUTING.md)：里面有本地环境、PR 必须通过的检查项和提交信息约定。本项目遵循 [Contributor Covenant](CODE_OF_CONDUCT.md) 行为准则。

## 许可证

[MIT](LICENSE) © 2026 AccreMind contributors
