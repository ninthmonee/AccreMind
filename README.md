# AccreMind

AccreMind 是面向大模型开发任务的经验闭环平台。

开发者继续使用日常的大模型或 Coding Agent；AccreMind 通过 MCP 在任务过程中召回相关经验并注入上下文，在任务完成时接收由当前大模型提炼的候选经验，经人工审核后进入经验库，供后续任务复用。

当前经验只有两个来源：

1. 外部大模型通过 MCP 主动提交的候选经验；
2. 开发者主动维护并导入的静态 Markdown 经验文件。

当前不连接 Git、代码托管、Wiki、需求、PR、事故、聊天、监控或实时业务系统。

## 当前文档

- [核心产品需求规格 v0.2](docs/product/AccreMind-Product-Requirements-v0.2.md)
- [核心架构 v0.2](docs/architecture/AccreMind-Core-Architecture-v0.2.md)
- [核心技术选型 v0.2](docs/architecture/AccreMind-Technology-Selection-v0.2.md)

当前仓库处于正式项目开工前的需求与架构阶段，不包含此前的协议实验代码和样例数据。
