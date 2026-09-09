---
file_id: frontend-react-request-race
experience_id: EXP-FE-000123
owner_id: user-frontend-reviewer
scope:
  organization_id: acme
  team_id: frontend
  project_id: commerce-web
valid_until: 2027-03-01
experience:
  title: React 快速切换筛选条件时旧请求覆盖新结果
  problem: 列表快速切换筛选条件后展示了上一次请求的数据
  context: React 受控筛选器，请求无法保证返回顺序
  solution: 使用 AbortController 取消旧请求，或用 sequence 只提交最新响应
  failed_attempts:
    - 只在组件卸载时取消请求
  validation:
    method: 连续切换三个条件并故意打乱响应顺序
    result: 只展示最后一个条件的数据
    verified_on: 2026-09-09
  applicability:
    domains: [frontend]
    technologies: [React, TypeScript]
    project_ids: [commerce-web]
    phases: [troubleshoot]
    triggers: [数据错乱, 请求竞态, 快速切换]
content_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---

取消旧请求能够节省资源；当底层请求不能取消时，使用单调递增的 sequence 忽略过期响应。

