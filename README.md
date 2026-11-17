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
5. **内嵌 Ant Design 6 四视图工作台（WebUI）**：
   - 涵盖 **知识浏览与同名同序修订抽屉**、**基线 vs 增量左右对比审核台**、**Turn 回执与雷达仿真台**、**符号时效治理与历史考古面板**，并支持将已验证经验一键导出为 `.dsh/skills/<slug>/SKILL.md`。

---

## 二、完整测试与使用指南

### 1. 编译与运行全量自动化验收套件（M0 ~ M3 共 6 套 14 项端到端用例）

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

打开浏览器访问 `http://127.0.0.1:3180` 即可交互体验：手动录入与 S03 门禁阻断、影子试用一键转正、基线 vs 增量对比裁决、雷达唤醒测试、Git 时效扫描、历史考古挖掘与 `SKILL.md` 导出。

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

```bash
pnpm build
dsh plugin --profile web add link:/Users/tianye/Desktop/projects/AccreMind/packages/dsh-plugin
```

---

## 三、方案文档索引

- [AI 研发知识基座 DSH本地插件产品设计方案 V3.md](./AI%20研发知识基座%20DSH本地插件产品设计方案%20V3.md)（V3.1）
- [AI 研发知识基座 DSH本地插件技术实现方案 V3.md](./AI%20研发知识基座%20DSH本地插件技术实现方案%20V3.md)（V3.1）
- [AI 研发知识基座 PRD V2 修订版.md](./AI%20研发知识基座%20PRD%20V2%20修订版.md)（V2.1 上游规则基线）
