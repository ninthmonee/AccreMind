# ADR-002：TanStack Query 与 Zustand 分别管理服务端和客户端状态

- 状态：Accepted
- 日期：2026-09-09

## 决策

AccreMind Studio 使用 TanStack Query 作为唯一的服务端缓存和 mutation 协调层，使用 Zustand 管理纯客户端的全局状态。筛选、分页、排序、team/project 和当前资源 ID 仍使用 React Router URL 状态；经验编辑与审核正文由表单/编辑器局部持有。

Zustand 按 `uiStore`、`workbenchStore` 和 `importStore` 拆分，用于 UI 偏好、多面板导航、跨页面选择和导入向导状态。它不保存 API response、请求状态、Token、经验正文或文件内容。

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

## Zustand Store 约定

1. `uiStore`：侧栏、密度、主题和命令面板等无敏感 UI 偏好；
2. `workbenchStore`：已打开的资源 ID、当前面板和跨页选择，不存资源正文；
3. `importStore`：导入步骤、字段映射和临时结果 ID，不存原始文件内容；
4. selector 必须最小化订阅范围，组件不得无选择器订阅整个 Store；
5. persist 只允许白名单字段，并提供版本和 migration；
6. 服务端数据始终通过 TanStack Query 获取和失效。

## 后果

- 服务端、URL、表单和 UI 状态各有唯一 owner；
- 不建立全局 `useAppStore`；
- Zustand 只存纯客户端领域状态，并按 feature 创建独立 Store；
- React Router 使用 Declarative 模式，避免其 loader cache 与 TanStack Query 重叠。
