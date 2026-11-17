# AccreMind（AI 研发知识基座 · V3.1 本地 DSH 插件版）

AccreMind 是面向 **DeepSeek Harness (`dsh` / Cordis)** 的本地优先（Local-First）研发经验增量引擎。它只沉淀**“仅凭当前代码与现有仓库文档难以在合理成本内恢复”**的隐性业务约束、架构否决依据、外部依赖陷阱与排障失败路径（`knowledge_delta`）。

## 核心特性（V3.1）

1. **零外部运行时依赖双包架构**：
   - `@accremind/core`：纯 Node.js `>= 24` 标准库构建（内置 `node:sqlite` WAL + FTS5 `trigram`、原子文件替换、零 `node-gyp` C++ 编译、零 Python 子进程）。
   - `@accremind/dsh-plugin`：原生 Cordis 可逆插件壳（`ctx.effect`）。
2. **双重上下文唤醒（保护 KV Cache + 零盲区防踩坑）**：
   - **Tier 1 常驻强规范**：字节级稳定前缀挂载 `<repo>/.accremind/rules/*.md`。
   - **Tier 2 回合前雷达 + 双语别名（`search_aliases`）**：口语提问（如“防重/丢单”）精准命中代码术语条目。
   - **JIT Tool Guard（回合中工具级即时护栏）**：Agent 中途 `read_file` / `edit_file` 触碰高危文件时动态追加内联警示。
3. **代码外增量五路分流与 `probation` 影子试用**：
   - 代码复述自动转 `index_only`，已有文档转 `link_existing`，无证据猜测入 `needs_confirmation`；
   - 合格候选进入 `~/.dsh/accremind/probation/` 影子试用（不弄脏项目 Git），用中有效一键转正迁入 `<repo>/.accremind/entries/`，连续曝光无反馈自动归档。
4. **函数符号级逻辑指纹（`symbol_anchors`）与 `bootstrap` 历史考古**：
   - 格式化代码或同文件增删无关函数自动修正行号**零误报**；目标函数内部逻辑变更精准标记 `review_due`。
   - 内置 Git 历史高信号提交挖掘器，老项目接入即可快速冷启动。

## 方案文档索引

- [AI 研发知识基座 DSH本地插件产品设计方案 V3.md](./AI%20研发知识基座%20DSH本地插件产品设计方案%20V3.md)（V3.1）
- [AI 研发知识基座 DSH本地插件技术实现方案 V3.md](./AI%20研发知识基座%20DSH本地插件技术实现方案%20V3.md)（V3.1）
- [AI 研发知识基座 PRD V2 修订版.md](./AI%20研发知识基座%20PRD%20V2%20修订版.md)（V2.1 上游规则基线）

## 快速验证与测试

环境要求：Node.js `>= 24.0.0`

```bash
pnpm install --offline
pnpm verify
```
