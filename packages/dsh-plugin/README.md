# @accremind/dsh-plugin

AccreMind 的 DeepSeek Harness 插件：把研发过程中真正花过代价才得到的经验（隐性约束、排障陷阱、架构取舍）沉淀成本地知识，再在需要的那一刻交还给模型和开发者。

数据全部留在本机：Markdown 是事实来源，`node:sqlite`（WAL + FTS5 trigram）只做索引，零外部运行时依赖。

## 它解决什么

模型的上下文会滚走，人的记忆会衰减。写进文档的结论往往只剩结论，丢掉的是"为什么"。AccreMind 抓的是代码与文档无法反推的那一层增量：当时踩了什么坑、试过什么失败的方案、为什么最后选了这个。

## 三层复用

| 层 | 注入时机 | 预算 | 作用 |
| --- | --- | --- | --- |
| 常驻规则 | 每轮对话开头 | 默认 500 tokens | 团队硬约束，字节稳定以保住 KV cache |
| 回合雷达 | 每轮按提问检索 | 默认 300 tokens | 相关经验按条目 id 提示，标记为参考、不执行 |
| 工具护栏 | 读/写目标文件时 | 默认 240 / 1500 tokens | 命中同一文件时按需展开完整条目 |

三层都只是"参考材料"，不会覆盖宿主的规则，也没有命令执行权。

## 沉淀链路

1. 捕获：对话结束后按 `autoCapture` 策略入队，或由模型显式调用 `accremind_capture`。
2. 评估：用评测模型判定这条经验是"代码/文档已能恢复"还是"真正的增量"，给出 `discoverability`、`disposition` 与基线回答。
3. 落盘：写入 Markdown（条目 + 版本），同步索引。
4. 试用与转正：新条目默认 `probation`（试用草稿），被检索命中到 `maxProbationExposures` 次、且经 `accremind_validate` 反馈后转 `verified`。
5. 导出：`accremind_export_skill` 把一条已验证经验写成 `.dsh/skills/<slug>/SKILL.md`，让它成为任何会话都能命中的技能。

## 工具

- `accremind_capture`：提交经验候选并按五路分流（index_only / link_existing / knowledge_candidate / needs_confirmation / discard）。
- `accremind_search`：按关键词、类型、层、文件路径检索条目。
- `accremind_get`：取完整正文、前置条件、验证方法与证据定位。
- `accremind_validate`：登记本次使用的成败；`failure` 会立即暂停该条目等待复核。
- `accremind_export_skill`：把条目固化成 DSH 技能文档。

## 界面

- 左侧栏 `AccreMind` 面板：经验工作台（检索、审阅、版本、导出），唯一的入口，输入框区域保持干净。
- 回合尾部回执：本轮命中了几条经验，可一键反馈"有用 / 没用 / 不准"。

## 配置

```yaml
- insert:
    - id: accremind
      name: '@accremind/dsh-plugin'
      config:
        globalDir: ~/.dsh/accremind        # 全局知识库（personal / shared_tech 层）
        projectDirName: .accremind          # 仓库内知识库（project 层）
        writeGate: probation                # 新条目默认状态
        maxProbationExposures: 3            # 试用期被命中多少次后允许转正
        assessmentMode: single_pass         # 单轮评估
        budgets:
          residentRulesTokens: 500
          turnRadarTokens: 300
          toolGuardTokens: 240
          toolReadMaxTokens: 1500
        autoCapture:
          enabled: true
```

模型通道默认复用宿主 `llm` 服务（自动挑一个非白盒 provider），也可以用 `ACCREMIND_LLM_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 指定外部端点。`accremind.settings.get` 会返回当前通道（`host` / `injected` / `env` / `none`）与描述。

## 安装

本地开发（把包软链进 profile，改代码即时生效）：

```bash
node packages/dsh-plugin/scripts/install-to-dsh.mjs --profile desktop
```

从源码构建并验证：

```bash
node scripts/build.ts
node --test tests/*.test.ts
node scripts/check-webui.ts
```

## 要求

- Node.js >= 24（`node:sqlite` 的 FTS5 trigram 分词）
- DeepSeek Harness >= 0.2.2-rc.5

## 许可

尚未指定开源许可证；对外分发前请先在仓库根目录补充 `LICENSE`。
