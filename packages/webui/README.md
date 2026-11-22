# @accremind/webui · 经验工作台前端

AccreMind 工作台的界面源码（React 19 + shadcn/ui 风格组件 + Tailwind CSS v4）。构建产物是**一个自包含的 HTML**，
由 `scripts/embed.ts` 写入 `packages/dsh-plugin/src/webui/app-html.ts`，插件运行时不依赖任何 npm 包、字体或网络。

## 常用命令

```bash
pnpm build:webui   # 类型检查 → vite 单文件构建 → 生成 app-html.ts（改完界面后必须执行并提交 app-html.ts）
pnpm ui            # 先启动本地工作台后端（默认 127.0.0.1:3180）
pnpm dev:webui     # 再启动热更新开发服务器 http://localhost:5173（/rpc 自动代理到 3180 并注入令牌）
```

开发地址加 `?demo=1` 可直接进入演示空间。

## 结构

| 目录 | 职责 |
|---|---|
| `src/app/` | 外壳：全局状态 `app-context`、顶部导航 `header`、⌘K 命令面板、录入经验对话框、主题 |
| `src/features/library/` | 知识库：数据卡片、经验流水线、范围环形图，以及卡片 / 表格（TanStack Table）/ 总结（Recharts）三种视图 |
| `src/features/entry/` | 经验详情抽屉：概览、证据时间线、锚点与时效、增量评估、Markdown 原文 |
| `src/features/coming-soon.tsx` | Git 雷达 / 候选审核 / 治理 / 回合记录的占位页（下一阶段迁移） |
| `src/components/ui/` | 基于 Radix 的 shadcn/ui 风格基础组件 |
| `src/components/display.tsx` | 页头、数据卡片、环形进度、分段条、空状态、图表提示框 |
| `src/lib/` | `rpc`（唯一通信通道，含演示空间转发）、类型、文案与状态色、`useAsync` |

## 数据流与约束

- 只通过 `rpc()` 调用 `accremind.*` 方法：DSH 内经 `window.__DSH_ACCREMIND_RPC__` 转发，独立预览走 `POST /rpc` + 页面令牌。
- 写操作或切换演示空间后调用 `refresh()`，所有读取随 `revision` 自动刷新。
- 三套主题由 `<html data-theme>` 控制（石墨 / 纸白 / 高对比），偏好存于 `localStorage.accremind_theme`。
- 图表配色用 `--chart-1…5`（已按色盲安全规则校验），状态色只用于状态并总配文字标签。
- 产物须满足插件测试：不得出现原生 `alert/prompt`、Node 内置模块，应用脚本必须是页面最后一个 `<script>`。
