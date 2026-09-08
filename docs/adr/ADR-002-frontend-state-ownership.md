# ADR-002：TanStack Query 管理服务端状态，P0 不引入 Zustand

- 状态：Accepted
- 日期：2026-09-09

## 决策

AccreMind Studio 使用 TanStack Query 作为唯一的服务端缓存和 mutation 协调层。筛选、分页、排序、team/project 和当前资源 ID 使用 React Router URL 状态；经验编辑与审核草稿由表单/编辑器局部持有；短暂交互使用组件状态；P0 不安装 Zustand。

只有出现无法合理放入 URL、服务端、表单或组件，且确实需要跨路由长期共享的复杂客户端状态时，才引入按领域拆分的小型 Zustand store。

## 原因

AccreMind Studio 的核心页面——Experience Library、Candidate Inbox、Review Queue、Usage Dashboard 和 Token 管理——主要展示和修改 Python API 中的数据。TanStack Query 已经处理缓存、新鲜度、请求去重、mutation、失效和重取。

将相同 API 数据复制到 Zustand 会产生两个事实源，需要额外同步 loading、error、stale 和 optimistic update，增加管理台最常见的一致性错误。搜索和表格状态进入 URL，还可以获得刷新保持、浏览器前进后退和可分享链接。

## Query Key 约定

```ts
experienceKeys.all(scope)
experienceKeys.list(scope, filters)
experienceKeys.detail(scope, experienceId, version)
candidateKeys.list(scope, filters)
candidateKeys.detail(scope, candidateId)
reviewKeys.queue(scope, filters)
usageKeys.summary(scope, dateRange)
```

所有 key 必须包含有效 scope。mutation 成功后失效最小相关 key；除非用户体验确实要求，不默认实现复杂 optimistic update，审核、发布、合并等治理动作优先等待服务端确认。

## Zustand 引入门槛

满足下列全部条件才引入：

1. 状态被多个不相邻路由或组件同时消费；
2. 它不是服务端数据的副本；
3. 放入 URL 会过大、敏感或语义不合理；
4. 表单或 React Context 无法清晰表达生命周期；
5. 已有真实功能和测试证明需要，而不是提前预防。

可能满足条件的后续能力包括多面板工作台、跨路由未提交批量选择和可恢复的复杂导入向导。

## 后果

- P0 少一个依赖和一套状态约定；
- 服务端、URL、表单和 UI 状态各有唯一 owner；
- 不建立全局 `useAppStore`；
- 如果后续引入 Zustand，只存纯客户端领域状态，并按 feature 创建独立 store；
- React Router 使用 Declarative 模式，避免其 loader cache 与 TanStack Query 重叠。
