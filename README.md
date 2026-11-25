# AccreMind

> 把代码和文档里推不出来的工程经验沉淀成本地知识，并在下一次改动前递到模型和开发者手边。

AccreMind 是面向 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）的本地插件与独立工作台。它只收一件事：**这次踩的坑、试过但放弃的方案、最后为什么选它**——也就是读代码、翻文档都还原不出来的那层增量（`knowledge_delta`）。

所有数据留在本机：Markdown 是事实来源，`node:sqlite`（WAL + FTS5 trigram）只做索引，没有后台服务和外部向量库。

---

## 目录

- [为什么需要它](#为什么需要它)
- [三层复用](#三层复用)
- [核心能力](#核心能力)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [在 DSH 中使用](#在-dsh-中使用)
- [独立工作台](#独立工作台)
- [数据放在哪](#数据放在哪)
- [命令行](#命令行)
- [模型配置（可选）](#模型配置可选)
- [开发与验证](#开发与验证)
- [文档](#文档)

## 为什么需要它

模型的上下文会滚走，人的记忆会衰减，文档只留下结论。团队真正花过代价的知识——"这个接口重试会重复扣款"、"这个库 3.x 之后 SSR 下不能动态导入"——通常以口头、聊天记录或某次事故复盘的形式存在，下一次改动时没人想得起来。

AccreMind 在三个时刻把这些知识递回来：

| 场景 | 发生什么 |
| --- | --- |
| 改之前 | 检索命中的经验以条目 id 和一句摘要进入上下文，标记为参考、不执行 |
| 改之中 | 读写到同一文件时，按需展开完整条目：前置条件、反例、验证方法、证据定位 |
| 改之后 | 对话尾部回执记录本轮用到哪些经验，一键反馈"有用 / 没用 / 不准" |

## 三层复用

| 层 | 注入时机 | 默认预算 | 作用 |
| --- | --- | --- | --- |
| 常驻规则 | 每轮对话开头 | 500 tokens | 团队硬约束，字节稳定以保住 KV cache |
| 回合雷达 | 每轮按提问检索 | 300 tokens | 相关经验按 id 提示，标注为参考材料 |
| 工具护栏 | 读/写目标文件时 | 240 / 1500 tokens | 命中同一文件时展开完整条目 |

三层都只是参考材料，不覆盖宿主规则，也没有命令执行权。

## 核心能力

1. **本地优先的双层存储**：正式经验落在仓库 `.accremind/`（可随 Git 提交供全队共享），试用稿、队列、索引、按用户划分的检索记录落在 `~/.dsh/accremind/`。Markdown 卡片 + `node:sqlite` FTS5 索引，索引可随时从文件重建。
2. **五路分流**：提交的候选按 `index_only / link_existing / knowledge_candidate / needs_confirmation / discard` 判定；代码或文档已能还原的输入不会污染知识库。
3. **影子试用与转正**：新条目先进 `probation`，被检索命中并拿到独立验证后才转 `verified`；连续多次曝光无反馈自动归档。
4. **时效与符号复核**：条目记录 `watch_paths` 和符号锚点哈希；代码改动或复核周期到期后进入待复核队列，反证会让条目立即暂停服务。
5. **规则文档集**：`domain` / `business_rules` / `project_norms` / `project_profile` 四类文档按 `##` 章节建索引，支持导入、修改提议、接受/拒绝与变更记录，写入 `.accremind/docs/` 随 Git 评审。
6. **跨仓库知识**：仓库身份取自 `.accremind/repo.json`，其次 `origin`，最后才是路径哈希；`domain` 与 `shared_tech` 层的经验可在同领域仓库间互相提醒。
7. **回执与离线评测**：每轮对话回执保留脱敏问题文本，`accremind eval` 用真实反馈与手写用例回放提醒效果，`--grid` 试参数，`--apply` 只在更好时写回。
8. **经验治理工作台**：七个视图覆盖总览、知识库、候选审核、规则文档、治理、回合记录与 Git 雷达；已验证经验可一键导出为 `.dsh/skills/<slug>/SKILL.md`。
9. **自我改进（无人值守，均可撤销）**，可用插件配置 `autoEvolve: { tune: false, demote: false }` 关闭：
   - **自动调参**：会话打开 1 分钟后在后台运行，每个仓库每周最多一次。要同时满足这几条才会应用：有标注样本 ≥ 30 个，得分至少高 0.03，召回降幅不超过 0.02，被否定的条目不会更多地出现。应用后进入观察期：3 天后用调整之后的新反馈对比新旧参数，同时对比调整前后实际的"不适用"比例，任何一项变差就自动回滚，30 天内不再尝试同一组参数。全部记录在 `~/.dsh/accremind/tuning-history.jsonl`。
   - **低效经验自动降级**：正式经验在当前版本被 ≥ 2 个会话标为"不适用"且占提醒会话 ≥ 25%，或 30 天内在 ≥ 40 个会话中提醒过却从未被打开、引用或确认，会自动降为试用；卡片状态同步写回 Markdown，Git 里可见。因"不适用"暂停后 30 天无人处理会自动归档（试用期满无人决定的等 60 天）。团队规范、当前版本有过确认或反例的、跨仓库共享的经验不做自动处理。每一步都进入总览的「需要你处理」，可一键撤销；撤销后该版本不再自动降级。

## 仓库结构

```
.
├── packages/
│   ├── core/          # @accremind/core：存储、检索、增量评估、治理、评测（宿主无关）
│   ├── dsh-plugin/    # @accremind/dsh-plugin：DSH 工具、上下文注入、面板、CLI、内嵌 WebUI
│   └── webui/         # @accremind/webui：React + Vite 工作台，构建为单文件内联进插件
├── scripts/           # 构建、WebUI 产物一致性校验
├── tests/             # node:test 端到端用例
├── docs/              # 产品设计与技术实现方案、市场发布说明
└── market/            # 插件市场索引
```

## 快速开始

要求 Node.js ≥ 24（`node:sqlite` 的 FTS5 trigram 分词）与 pnpm 10。

```bash
pnpm install
pnpm build          # 构建 core / plugin / webui，并生成内联的工作台产物
pnpm verify         # 构建 + 全部测试 + WebUI 产物指纹校验
```

CI 跑的就是 `pnpm verify`（见 `.github/workflows/ci.yml`）。

## 在 DSH 中使用

本地开发时把包软链进 DSH profile，改代码后重启 DSH 即可生效：

```bash
pnpm install:dsh                      # 默认 desktop profile
pnpm install:dsh -- --profile web     # 或指定 profile
```

也可以手动登记：

```bash
dsh plugin --profile web add "link:$(pwd)/packages/dsh-plugin"
dsh plugin --profile web enable accremind
```

安装后左侧栏出现 `AccreMind` 面板，对话中会按需注入经验、在回合尾部给回执；对话内可用的工具：

- `accremind_capture`：提交经验候选并执行五路分流
- `accremind_search`：按关键词、类型、层、文件路径检索
- `accremind_get`：取完整正文、前置条件、验证方法与证据定位
- `accremind_validate`：登记本次使用的成败，`failure` 会立即暂停条目
- `accremind_export_skill`：把已验证条目固化为 DSH 技能文档

## 独立工作台

不开 DSH 也能起同一套界面（默认 3180 端口，仅监听本机）：

```bash
pnpm ui -- --port 3180
```

修改界面时用 Vite 热更新：

```bash
pnpm dev:webui
```

发版前务必跑 `pnpm verify`：`check:webui` 会比对 `packages/webui` 源码与插件内联产物的指纹，避免界面改动漏进发布包。

## 数据放在哪

| 路径 | 内容 |
| --- | --- |
| `<repo>/.accremind/entries/` | 正式经验卡片（Markdown，含版本与证据引用） |
| `<repo>/.accremind/evidence/` | 条目证据附件 |
| `<repo>/.accremind/rules/` | 常驻规则 |
| `<repo>/.accremind/docs/` | 四类规则文档与变更记录 |
| `<repo>/.accremind/repo.json` | 仓库身份与业务领域（建议提交） |
| `~/.dsh/accremind/probation/` | 试用稿（不写入项目 Git） |
| `~/.dsh/accremind/queue/` | 自动捕获与评估队列 |
| `~/.dsh/accremind/index/` | 可重建的 SQLite 索引 |
| `~/.dsh/accremind/{personal,domain,shared-tech}/` | 跨仓库的经验层 |
| `~/.dsh/accremind/{registry,users,workspaces}/` | 仓库注册表、用户身份、按仓库划分的检索记录 |

## 命令行

```bash
pnpm accremind status                     # 概览 + 时效巡检
pnpm accremind search "订单 重试" --scope auto --file packages/core/src/store/local-store.ts
pnpm accremind get K-XXXX                 # 完整条目
pnpm accremind rebuild                    # 从 Markdown 重建索引
pnpm accremind bootstrap --top 10         # 扫描 Git 历史找高信号提交
pnpm accremind bootstrap --extract        # 再交给模型做代码对照与五路分流
pnpm accremind migrate                    # 跨仓库迁移预演，--apply 执行，--rollback 回退
pnpm accremind repo --domains payments,ledger
pnpm accremind docs import ./adr --category business_rules
pnpm accremind docs proposals             # 待审修改提议与词表提议
pnpm accremind docs accept <提议编号>
pnpm accremind eval --grid --apply        # 回放反馈，调参并只在更好时落盘
pnpm accremind eval auto                  # 立即跑一轮自动调参（含观察期判定）
pnpm accremind eval history               # 调参记录与观察状态
pnpm accremind eval rollback              # 撤销最近一次调参
pnpm accremind demotions [--all]          # 自动降级 / 归档记录
pnpm accremind demotions restore K-XXXX   # 撤销某条经验的自动降级 / 归档
pnpm accremind ui --port 3180
```

所有命令都接受 `--repo` 与 `--global-dir`，默认分别是当前目录与 `~/.dsh/accremind`。

## 模型配置（可选）

检索、提醒、文件护栏和时效巡检全部在本机完成，不需要任何 Key。只有"提炼经验"（`bootstrap --extract`、工作台里的提炼、开启后的自动提炼）会调用模型；插件默认复用宿主 `llm` 服务，也可以用环境变量指定外部端点：

```bash
cp .env.example .env
# ACCREMIND_LLM_BASE_URL / ACCREMIND_LLM_MODEL / ACCREMIND_LLM_API_KEY
# 或 DEEPSEEK_API_KEY / OPENAI_API_KEY
```

密钥只会发给与之配对的服务；自定义 `ACCREMIND_LLM_BASE_URL` 指向其他主机时不会附带 DeepSeek / OpenAI 的 Key。

## 开发与验证

```bash
pnpm build          # 构建 core、plugin 与 WebUI 产物
pnpm build:webui    # 只重建 WebUI 并写回内联产物
pnpm test           # node:test（会先构建）
pnpm verify         # 构建 + 测试 + 产物指纹校验，提交前跑这个
pnpm typecheck      # 内核与 WebUI 类型检查
pnpm pack:check     # 检查发布包内容
pnpm market:index   # 重新生成 market/index.json
```

## 文档

- [架构与设计理念](docs/ARCHITECTURE.md)：愿景、七条原则、总体架构图、经验生命周期、检索流水线与自我改进（新同事建议先读）
- [产品设计方案 V3.2](<docs/AI 研发知识基座 DSH本地插件产品设计方案 V3.md>)：产品边界、数据模型、验收口径
- [技术实现方案 V3.2](<docs/AI 研发知识基座 DSH本地插件技术实现方案 V3.md>)：模块契约、检索与治理实现
- [对外介绍稿](docs/blog/2026-11-23-accremind-introduction.md)：面向团队的一篇完整介绍，可作为对外发布底稿
- [插件市场发布说明](docs/market-publishing.md)

许可证尚未指定；对外分发前请先补充 `LICENSE`。
