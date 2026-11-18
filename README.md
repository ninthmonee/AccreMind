# AccreMind（AI 研发知识基座 · V3.1 本地 DSH 插件版）

AccreMind 是面向 **DeepSeek Harness (`@deepseek-ai/dsh` / Cordis)** 的本地优先（Local-First）研发经验增量引擎。它只沉淀**“仅凭当前代码与现有仓库文档难以在合理成本内恢复”**的隐性业务约束、架构否决依据、外部依赖陷阱与排障失败路径（`knowledge_delta`）。

---

## 一、核心架构与已实现能力（M0 ~ M3 全量就绪）

1. **零外部运行时依赖双包架构（Node `>= 24`）**：
   - [`packages/core`](./packages/core)：纯 Node 24 标准库构建（内置 `node:sqlite` WAL + FTS5 `trigram`、崩溃安全原子文件替换、零 `node-gyp` C++ 编译、零 Python 子进程）。
   - [`packages/dsh-plugin`](./packages/dsh-plugin)：原生 Cordis 可逆插件壳（`ctx.effect`），对接 `ctx.tools`、`ctx.systemPrompt.section`、`ctx.sessions.registerMessageProjection`、`tools/post-execute` 瀑布流及 WebUI 安全 RPC。
2. **双重上下文唤醒（保护 KV Cache + 零盲区防踩坑）**：
   - **Tier 1 常驻强规范**：字节级稳定前缀挂载 `<repo>/.accremind/rules/*.md`，零抖动保护 DeepSeek KV Cache。
   - **Tier 2 回合前雷达 + 双语别名（`search_aliases`）**：口语提问（如“怎么防止重复扣款/被踢下线”）通过滑动 CJK N-gram + BM25 精准召回底层代码术语条目。
   - **JIT Tool Guard（回合中工具级即时护栏）**：Agent 中途 `read_file` / `edit_file` 触碰高危锚定文件时自动在工具输出尾部追加 `<accremind-guard>` 警示（同会话防重复打扰）。
3. **代码外增量评估（`DeltaAssessor`）与 `probation` 影子试用流**：
   - 支持省 Token `single_pass` 与严格无记忆盲测双检 `isolated_p0`（Pass 1 物理隔离排障答案，仅看源码与文档生成基线）；
   - S03 硬门禁代码级拦截空增量、未证实猜测与本机绝对路径；
   - 合格草稿默认进入 `~/.dsh/accremind/probation/` 影子试用（不污染项目 Git），独立验证有效自动迁入 `<repo>/.accremind/entries/`，连续 3 次曝光无反馈自动归档。
4. **函数符号级逻辑指纹（`symbol_anchors`）、自动信号捕获与 `bootstrap` 历史考古**：
   - 格式化代码、改注释或同文件增删无关函数自动修正行号**零误报**；仅目标函数内部逻辑变更或依赖越界精准标记 `review_due`。
   - 内置后台非阻塞信号检测与持久化重试队列（`~/.dsh/accremind/queue/`，指数退避 + 7 天自动过期清理）。
   - 内置 `bootstrap` Git 历史考古器，支持零 Token 信号挖掘与一键 LLM 提炼冷启动。
5. **经验治理工作台**提供知识库、候选审核、回合回执、治理与设置四个视图。DSH 对话底部可直接处理本轮命中的经验，在工作台内可根据证据复核并导出已验证经验的 `.dsh/skills/<slug>/SKILL.md`。

---

## 二、完整测试与使用指南

### 1. 编译与运行自动化验收套件

```bash
pnpm install --offline
pnpm verify
```

### 2. 启动本地可视化经验工作台（WebUI 独立预览模式）

```bash
# 默认监听 http://127.0.0.1:3180 ，也可通过 --repo 指定任意目标业务仓库路径
pnpm ui
# 或指定目标仓库与端口：
pnpm ui -- --repo /path/to/your-project --port 3180
```

访问 `http://127.0.0.1:3180`，在知识库首页选择「扫描仓库历史」。扫描在本机执行；配置模型后可勾选提交提炼候选。要先体验完整操作，选择「体验示例」可进入独立的临时项目。

- 在「候选审核」核对基线、增量和证据。可直接补证，也可将选中的候选送入本机试用。
- 在「知识库」选择领域知识、项目知识、通用技术、团队规范或个人知识，再按内容类型和治理状态筛选。卡片用于阅读单条经验，表格用于比较结论和适用条件，总结会按范围汇总当前结果，可点修订编号查证。
- 在 DSH 真实任务中使用经验后，可在该回合底部转正、淘汰或反馈。独立预览中的「回合回执」读取当前工作区的回执，「命中模拟」可重复预览匹配效果。
- 在「治理与设置」查看触发复核的变更。核对时效与处理反证各有独立操作；新经验可按工作区配置为先试用或先人工审核。


### 3. CLI 常用命令

```bash
# 查看工作区经验状态与执行本地 Git / 依赖时效巡检
pnpm accremind status -- --repo /path/to/your-project

# 零 Token 扫描目标仓库 Git 历史中的高信号排障/回滚/竞态提交
pnpm bootstrap -- --repo /path/to/your-project --top 10

# 配合 DeepSeek/OpenAI API Key 自动从历史高信号提交提炼经验卡片并五路分流落盘
DEEPSEEK_API_KEY=sk-xxx pnpm bootstrap -- --repo /path/to/your-project --top 10 --extract --mode isolated_p0

# 命令行检索与按 ID 查看详情
pnpm accremind search "重复扣款" -- --repo /path/to/your-project
pnpm accremind get K-1001 -- --repo /path/to/your-project

# 从双层 Markdown 真源一键无损重建 SQLite FTS5 索引
pnpm accremind rebuild -- --repo /path/to/your-project
```

### 4. 挂载到 DeepSeek Harness (`dsh`)

在本仓库根目录执行以下命令，将插件链接到 DSH 的 `web` 配置。若桌面版尚未将 `dsh` 加入 PATH，可在插件管理器选择「添加插件」并选中本仓库的 `packages/dsh-plugin` 目录。

```bash
pnpm build
dsh plugin --profile web add "link:$PWD/packages/dsh-plugin"
dsh web
```

在 DSH 中打开目标仓库的会话，可从输入区的「AccreMind 经验工作台」进入。已完成的回合会显示本轮提示过的经验与反馈操作。

---

## 三、方案文档索引

- [产品设计 V3.2](./AI%20研发知识基座%20DSH本地插件产品设计方案%20V3.md)覆盖知识条目、改前检索、改后沉淀和审核交互。
- [技术实现设计 V3.2](./AI%20研发知识基座%20DSH本地插件技术实现方案%20V3.md)定义原文保存、旧库接入、修订治理和验收用例。R1–R3 为规划中的交付阶段。
- [AI 研发知识基座 PRD V2 修订版.md](./AI%20研发知识基座%20PRD%20V2%20修订版.md)（V2.1 上游规则基线）
