# Compound Engineering 静态案例参考

本项目将仓库内 `compound-engineering` 技能文档指向的经验库作为只读静态案例源，用于接口、
契约与测试设计时的案例检索。原始经验仍由该目录自己的流程维护，AccreMind 不直接修改或复制
其正文。

## 权威来源

- 使用规范：`compound-engineering/SKILL.md`
- 经验索引：`compound-engineering/references/INDEX.md`
- 经验入口：`compound-engineering/references/experiences.md`
- 经验正文：`compound-engineering/references/experiences/*.md`
- AccreMind 案例目录：`schemas/examples/compound-engineering/catalog.json`

案例目录只记录稳定 ID、原文路径、标题、标签和目标字段映射。测试会验证每个来源文件与标题仍然
存在，从而在经验库移动或改名时及时提示维护映射。

## 字段映射

| Compound Engineering 内容 | AccreMind 目标语义 |
| --- | --- |
| Markdown 标题 | `candidate.title` |
| 场景、背景、问题表现 | `candidate.problem` / `candidate.context` |
| 根因与错误尝试 | `candidate.failed_attempts` / `candidate.context` |
| 解决方案与代码片段 | `candidate.solution` |
| `validated`、验证步骤、版本信息 | `candidate.validation` |
| `domain`、`tech`、`tags` | `candidate.applicability` |
| 原文件路径与标题 | `source.file_id` 的可追溯依据 |

两种格式并不完全相同：Compound Engineering 采用带 `meta`/`tags` 的 Markdown 条目，AccreMind
静态导入契约使用 YAML Front Matter。因此这里把它作为设计与测试案例，而不是可直接导入的生产
经验。若后续需要批量导入，应新增显式转换器、逐条脱敏确认与契约校验，不能把参考目录直接写入
生产 Corpus。

## 首批参考案例

当前目录选择了五类对接口实现最有价值的案例：

1. HTTP 方法能力应覆盖调用方实际需要；
2. POST 操作即使没有 payload 也要统一处理错误和刷新流程；
3. 批量请求必须严格核对嵌套 payload 结构；
4. 并发请求需要序列守卫，避免过期响应覆盖新结果；
5. 前后端字段命名必须与真实响应契约对齐。

这些案例共同约束本项目：接口文档、Pydantic 契约、OpenAPI 快照与路由实现应一起演进，避免
仅修改其中一层造成静默漂移。
