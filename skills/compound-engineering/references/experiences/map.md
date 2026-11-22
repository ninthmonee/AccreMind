# 经验沉淀 — 地图

> 地图控件与业务动作的集成、坐标契约及交互资源生命周期。

---

## Vue 3 / 地图菜单

### 地图右键菜单：原始选点与展示避让分离，业务动作由页面接入

> **meta** `type=pattern` `tech=vue3` `domain=map` `severity=medium` `validated=2026-10-12` `last_updated=2026-10-12` `version=vue@3.5.43`
>
> **tags** `vue3, map, context-menu, long-press, viewport, component-structure`

validated_at: 2026-10-12 @ vue@3.5.43

**场景与现象**：调度主屏需要在鼠标右键、键盘菜单键及触屏长按后提供业务入口。菜单在地图边缘需要避让，但业务回调仍应取得用户实际选中的位置；长按释放产生的合成 `click` 也不能立即关闭刚打开的菜单。

**根因与边界**：原始地理选点与菜单外壳的位置是两种状态，若共用并修改同一个像素值，边缘避让会改变业务动作的位置。Pointer 手势和 click 是不同事件序列，长按成功后的释放仍可能产生 click。地图实例重建、页面隐藏和 KeepAlive 失活不会自动取消业务组件自行注册的 DOM 监听与计时器。

**解决方案**：

1. **保留原始坐标**：`useMapContextMenu` 在最近的 `MapScene` 上下文中取得稳定画布容器，通过 `unproject` 保存 `{ coordinates, pixel }`。`coordinates` 保留引擎返回的完整精度 `[经度, 纬度]`，本次调度主屏的高德引擎使用 GCJ-02；`pixel` 为相对画布左上角的 CSS 像素。业务标题可以 `toFixed(4)`，传递给业务的坐标不四舍五入。
2. **避让只改变展示**：`MapContextMenu` 由原始 `context.pixel`、菜单尺寸和 `camera.size` 计算外壳位置；`placeMapContextMenu` 不修改原始输入。选择事件始终发出 `select({ item, context })`，业务侧使用这个原始 context，而不是菜单 `left/top`。
3. **分离通用与业务实现**：`packages/effects/map` 保留通用 Hook、菜单 UI、尺寸测量、定位、焦点和关闭行为；`workbench/components/DispatchMapContextMenu.vue` 提供“创建工单、上报事件、查看附近抢险力量”的文案、图标及 `DispatchMapActionEvent` 转换。接口、弹窗、路由和业务状态由业务调用方接入，地图目录不发出这些请求。统一 `action` 与专用动作事件择一接入，避免同一次选择重复提交。
4. **统一交互入口**：在画布容器的 capture 阶段处理 `contextmenu`，阻止浏览器菜单；监听稳定的容器，SDK 替换子节点后仍有效。画布聚焦后通过 `Shift+F10` 或菜单键在画布中心打开，菜单内支持方向键、Home/End、Enter/Space、Escape 和 Tab。菜单必须作为 `MapScene` 的后代挂载，父组件 setup 无法反向注入子组件地图。
5. **保留普通地图手势**：单指或触控笔持续 `550ms` 打开，移动超过 `8px`、第二指（包括落在地图外）、抬起及取消都会取消待触发长按。监听不提前阻止 pointerdown / pointermove，也不抢 pointer capture；长按成功后，在释放的 `800ms` 内仅抑制同位置的一次非键盘合成 click。不同位置、键盘 click 和下一次普通点击继续正常处理。全局 pointermove 使用 capture + passive，避免 SDK 的 stopPropagation 绕过移动取消。
6. **清理资源**：普通画布点击、viewport 变化、祖先滚动、窗口 resize / blur 关闭菜单并取消待触发长按。禁用、地图解绑 / 销毁、页面隐藏、KeepAlive 失活及作用域释放清理 Hook 的画布 / Pointer 监听、计时器和 click 抑制，恢复后重新绑定；`MapContextMenu` 卸载时释放 ResizeObserver 与文档外部点击监听。不要将仍可为 ready 的缓存地图视为持续可交互。

**最小可运行用法**：以下 SFC 可放在 `apps/main-app/src/views/workbench/index.vue` 验证业务事件；使用仓库已有业务组件，`schematic` 引擎不依赖高德 Key。业务组件已经在内部封装通用 `MapContextMenu`，页面只组合地图并接收动作。

```vue
<script setup lang="ts">
import type { DispatchMapActionEvent } from './components/dispatch-map-actions';

import { ref } from 'vue';
import { MapScene } from '@decision/map';

import DispatchMapContextMenu from './components/DispatchMapContextMenu.vue';

const lastAction = ref<DispatchMapActionEvent | null>(null);

function handleMapAction(event: DispatchMapActionEvent) {
  // 业务侧接收完整精度的原始选点；后续在此接入对应表单或查询。
  lastAction.value = event;
}
</script>

<template>
  <div style="height: 480px">
    <MapScene engine="schematic" :center="[121.47, 31.23]" :zoom="11">
      <DispatchMapContextMenu @action="handleMapAction" />
    </MapScene>
  </div>
  <output v-if="lastAction">
    {{ lastAction.action }} · {{ lastAction.coordinates }} ·
    {{ lastAction.pixel }}
  </output>
</template>
```

**验证方式与结果**：

```bash
node --test scripts/test-map-context-menu.mjs
node --test scripts/test-map-runtime.mjs
pnpm --filter @decision/map typecheck
pnpm --filter @decision/main-app typecheck
```

本次任务验证基线：菜单交互 / 位置测试 `17/17`、地图运行时回归 `108/108`、地图与主应用类型检查、lint 和构建均通过。自动化模拟覆盖原始坐标精度、CSS 缩放、地图隔离、长按阈值与取消、原生 contextmenu 后的释放、一次 click 抑制、viewport 关闭、隐藏、禁用、解绑、销毁、卸载、键盘入口及边缘避让；KeepAlive 的清理由 Hook 的 activated / deactivated 路径实现，不能把以上自动化结果等同于真实设备的缓存页面验收。用户通过 question 工具确认“已解决，符合预期”。

**触控验证限制**：本次浏览器工具不能注入真实触屏 Pointer，长按 / 多指行为仅通过自动化模拟验证；粗指针菜单项的 `min-height: 44px` 通过 CSS 检查。未宣称完成真实 iPad 或触控笔实机验收。

**预防方式与检索**：扩展菜单时先检索本条，新增业务项和请求留在对应业务目录；原始拾取位置保持不可变，展示位置只作派生值。回归需要包含“长按后释放”与“边缘点击后动作坐标”两个边界，避免只检查菜单是否出现。通用 Vue 组合方式参考 [Vue composables](../../../vue/references/core-new-apis.md#composables) 与 [KeepAlive](../../../vue/references/advanced-patterns.md#keepalive)，本条补充地图手势和坐标契约。

**实现位置**：[通用 Hook](../../../../../packages/effects/map/src/composables/use-map-context-menu.ts)、[通用菜单](../../../../../packages/effects/map/src/components/MapContextMenu.vue)、[展示定位](../../../../../packages/effects/map/src/utils/context-menu.ts)、[调度业务菜单](../../../../../apps/main-app/src/views/workbench/components/DispatchMapContextMenu.vue)。
