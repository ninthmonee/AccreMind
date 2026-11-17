import { ACCREMIND_OBSERVATORY_CLIENT_SCRIPT } from './client-script.ts';
import { ACCREMIND_OBSERVATORY_STYLES } from './styles.ts';

/**
 * AccreMind V3.1 "Dark-Matter Observatory & Context Prism" WebUI Bundle.
 * Features dual-theme (Obsidian Dark + Alabaster Blueprint), interactive orbital constellation SVG,
 * 4D orthogonal telemetry chips, Delta Prism side-by-side review desk, 3-lane live KV-cache & JIT
 * context compiler simulator, Command Palette (Cmd+K), and zero direct filesystem/SQLite coupling.
 */
export function renderAccreMindWebuiHtml(options: { embedded?: boolean } = {}): string {
  const subtitle = options.embedded ? 'DSH Embedded Observatory' : 'Engineering Dark-Matter Engine';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AccreMind · 研发暗物质观测站 (V3.1)</title>
<style>${ACCREMIND_OBSERVATORY_STYLES}</style>
</head>
<body>
<div id="toast-pill" class="toast-pill"></div>

<div class="app-frame">
  <!-- Left Telemetry Rail -->
  <aside class="rail">
    <div class="brand-box">
      <div class="brand-orb">Δ</div>
      <div>
        <div class="brand-name">AccreMind</div>
        <div class="brand-tag">${subtitle}</div>
      </div>
    </div>

    <div class="rail-group-label">Observatory Views</div>
    <button class="nav-btn active" data-nav="kb">
      <span class="nav-left"><span>✦</span><span>暗物质知识星图</span></span>
      <span class="nav-count" id="cnt-kb">0</span>
    </button>
    <button class="nav-btn" data-nav="review">
      <span class="nav-left"><span>◫</span><span>增量分光镜审核台</span></span>
      <span class="nav-count" id="cnt-rev">0</span>
    </button>
    <button class="nav-btn" data-nav="reactor">
      <span class="nav-left"><span>⚡</span><span>上下文编译反应堆</span></span>
      <span class="nav-count">SIM</span>
    </button>
    <button class="nav-btn" data-nav="gov">
      <span class="nav-left"><span>🧬</span><span>符号基因与历史考古</span></span>
      <span class="nav-count" id="cnt-gov">0</span>
    </button>

    <div class="rail-group-label" style="margin-top:12px;">Safeguards</div>
    <button class="nav-btn" data-open-legend="1">
      <span class="nav-left"><span>⊞</span><span>四维正交矩阵图例</span></span>
      <span class="kbd">L6</span>
    </button>

    <div class="rail-footer">
      <div class="pulse-row">
        <span class="pulse-dot"></span>
        <span style="font-weight:600;">SQLite WAL + FTS5 Engine</span>
      </div>
      <div class="mono" id="rail-dir" style="word-break:break-all;opacity:0.8;">.accremind</div>
    </div>
  </aside>

  <!-- Main Stage -->
  <div class="stage">
    <header class="hud-bar">
      <div class="hud-left">
        <span class="ws-pill">
          <span style="color:var(--accent);">●</span>
          <span id="hud-ws">initializing…</span>
        </span>
        <button class="cmdk-trigger" id="btn-cmdk">
          <span>快速检索经验、别名或执行指令…</span>
          <span><span class="kbd">⌘</span> <span class="kbd">K</span></span>
        </button>
      </div>
      <div class="hud-actions">
        <button class="btn btn-sm" id="btn-demo-toggle" data-seeded="0">✦ 载入工程暗物质样本</button>
        <button class="btn btn-sm" id="btn-theme">☀ 亮色蓝图</button>
        <button class="btn btn-primary" id="btn-new-entry">＋ 捕获暗物质经验</button>
      </div>
    </header>

    <div class="stage-body">
      <!-- Top Bento Hero: Orbital Constellation + 4D Telemetry -->
      <section class="hero-bento">
        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">分层知识轨道星图 (Layered Orbital Topology)</div>
              <div class="panel-sub">内环常驻红线锁 KV-Cache · 中环项目正式资产 · 外环本机影子孵化舱</div>
            </div>
            <span class="l1-lock-pill">LOCAL-FIRST · ZERO CLOUD</span>
          </div>
          <div class="constellation-wrap">
            <div id="constellation-svg-slot"></div>
            <div class="constellation-legend">
              <div class="layer-tile" data-filter-shortcut="active">
                <div class="layer-tile-top"><span>Tier-0 常驻红线 (rules)</span><span style="color:var(--emerald);">●</span></div>
                <div class="layer-tile-num" id="lt-rules">0</div>
              </div>
              <div class="layer-tile" data-filter-shortcut="active">
                <div class="layer-tile-top"><span>项目正式经验 (entries)</span><span style="color:var(--accent);">●</span></div>
                <div class="layer-tile-num" id="lt-proj">0</div>
              </div>
              <div class="layer-tile" data-filter-shortcut="probation">
                <div class="layer-tile-top"><span>影子孵化草稿 (probation)</span><span style="color:var(--violet);">●</span></div>
                <div class="layer-tile-num" id="lt-prob">0</div>
              </div>
              <div class="layer-tile" data-filter-shortcut="nav">
                <div class="layer-tile-top"><span>代码导航锚点 (index_only)</span><span style="color:var(--text-3);">●</span></div>
                <div class="layer-tile-num" id="lt-nav">0</div>
              </div>
            </div>
          </div>
        </div>

        <div class="glass-panel">
          <div class="panel-head">
            <div class="panel-title">四维质量遥测 (零百分比铁律)</div>
            <button class="btn btn-sm" data-open-legend="1">四维正交释义</button>
          </div>
          <div class="telemetry-grid">
            <div class="metric-cell">
              <div class="metric-k"><span>已生效资产 (ACTIVE)</span><span style="color:var(--emerald);">▲</span></div>
              <div class="metric-v" id="m-active">0</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>影子孵化池 (PROBATION)</span><span style="color:var(--violet);">🧪</span></div>
              <div class="metric-v" id="m-prob">0</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>跨任务已证实 (VERIFIED+)</span><span style="color:var(--accent);">✓</span></div>
              <div class="metric-v" id="m-ver">0</div>
            </div>
            <div class="metric-cell">
              <div class="metric-k"><span>符号变动待复核 (REV_DUE)</span><span style="color:var(--amber);">!</span></div>
              <div class="metric-v" id="m-stale">0</div>
            </div>
          </div>
        </div>
      </section>

      <!-- VIEW 1: Dark-Matter Vault -->
      <section id="view-kb">
        <div class="toolbar">
          <div class="toolbar-filters">
            <input id="flt-q" placeholder="按标题、隐性增量或双语别名即时检索 (按 / 聚焦)…" style="width:310px;" />
            <select id="flt-status">
              <option value="">全部确认态</option>
              <option value="active">已生效 (active)</option>
              <option value="probation">影子孵化 (probation)</option>
              <option value="withdrawn">已撤回 (withdrawn)</option>
              <option value="archived">已归档 (archived)</option>
            </select>
            <select id="flt-type">
              <option value="">全部类型</option>
              <option value="pitfall">排障陷阱 (pitfall)</option>
              <option value="decision">架构取舍 (decision)</option>
              <option value="guideline">规范红线 (guideline)</option>
              <option value="model">领域模型 (model)</option>
              <option value="process">操作次序 (process)</option>
            </select>
          </div>
          <div class="seg-group">
            <button class="seg-btn active" data-view-mode="cards">星图卡片</button>
            <button class="seg-btn" data-view-mode="table">密集台账</button>
          </div>
        </div>
        <div id="vault-host"></div>
      </section>

      <!-- VIEW 2: Delta Prism Review Desk -->
      <section id="view-review" style="display:none;">
        <div class="glass-panel" style="margin-bottom:18px;">
          <div class="panel-head">
            <div>
              <div class="panel-title">增量分光镜审核台 (Delta Prism · 代码可发现性双栏对照)</div>
              <div class="panel-sub">剥离源码已有事实（左栏），仅放行具备真实证据支撑的代码外暗物质增量（右栏）</div>
            </div>
          </div>
          <div style="padding:18px 20px;" id="prism-queue-host"></div>
        </div>

        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">代码导航与权威文档锚点池 (navigation.json)</div>
              <div class="panel-sub">被分流为 index_only / link_existing 的可恢复事实存放于此，绝不污染经验库</div>
            </div>
          </div>
          <div style="padding:14px 20px;" id="nav-index-host"></div>
        </div>
      </section>

      <!-- VIEW 3: 3-Lane Context Compiler & JIT Guard Reactor -->
      <section id="view-reactor" style="display:none;">
        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">三层上下文编译反应堆 & 回合中 JIT 护栏实况沙盒</div>
              <div class="panel-sub">实时运行后端 ViewCompiler，检视 KV-Cache 前缀锁、双语雷达召回与 tools/post-execute 动态护栏输出</div>
            </div>
          </div>
          <div style="padding:18px 20px;">
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
              <span style="font-size:12px;color:var(--text-3);align-self:center;">一键填入仿真场景：</span>
              <button class="btn btn-sm" data-sim-preset="1">⚡ 场景 1：口语搜“怎么防止重复扣款”</button>
              <button class="btn btn-sm" data-sim-preset="2">🛡️ 场景 2：首轮模糊提问 + 中途读写 webhook.ts (触发 JIT 护栏!)</button>
              <button class="btn btn-sm" data-sim-preset="3">🧪 场景 3：命中影子孵化草稿 CROSSSLOT</button>
            </div>
            <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr auto;gap:10px;align-items:end;">
              <div>
                <div class="form-hint">模拟本轮开发者输入 (User Prompt)</div>
                <input id="sim-prompt" value="帮我重构一下账务结算模块代码结构" style="width:100%;" />
              </div>
              <div>
                <div class="form-hint">回合前显式提及路径 (beforeTurn)</div>
                <input id="sim-active-file" placeholder="如 src/order/order.service.ts" style="width:100%;" />
              </div>
              <div>
                <div class="form-hint">回合中 Agent 工具触碰文件 (JIT Guard)</div>
                <input id="sim-jit-file" value="src/payment/webhook.ts" style="width:100%;" />
              </div>
              <button class="btn btn-primary" id="btn-run-reactor">编译本轮视图</button>
            </div>

            <div class="lanes-grid" id="reactor-lanes"></div>
          </div>
        </div>
      </section>

      <!-- VIEW 4: Symbol Gene Radar & Git Archaeology Time-Machine -->
      <section id="view-gov" style="display:none;">
        <div class="glass-panel" style="margin-bottom:16px;">
          <div class="panel-head">
            <div>
              <div class="panel-title">符号基因漂移巡检队列 (Symbol Fingerprint Radar)</div>
              <div class="panel-sub">剥离注释与空白提取归一化 SHA-256：Prettier 格式化与行号平移静默自愈，仅函数体实质改动报警</div>
            </div>
            <button class="btn btn-sm" id="btn-gov-scan">立即扫描本地 Git</button>
          </div>
          <div style="padding:16px 20px;" id="gov-stale-host"></div>
        </div>

        <div class="glass-panel" style="margin-bottom:16px;">
          <div class="panel-head">
            <div>
              <div class="panel-title">Git 历史考古冷启动时光机 (accremind bootstrap)</div>
              <div class="panel-sub">零 Token 挖掘本地仓库历史中的 revert / hotfix / race / 48h 连续返工簇提交</div>
            </div>
            <button class="btn btn-sm btn-primary" id="btn-gov-arch">挖掘当前仓库高信号提交</button>
          </div>
          <div style="padding:16px 20px;" id="arch-timeline-host">
            <div style="color:var(--text-3);font-size:12.5px;">点击右上按钮扫描当前 Git 历史，快速发现值得沉淀的历史排障暗物质。</div>
          </div>
        </div>

        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">双底座存储自愈引擎 (Markdown SoT → SQLite FTS5)</div>
              <div class="panel-sub">SQLite 仅为 100% 可销毁重建的派生索引，真源永远保存在人类可读的 Markdown 卡片中</div>
            </div>
            <button class="btn btn-sm" id="btn-gov-rebuild">一键全量无损重建索引</button>
          </div>
          <div style="padding:14px 20px;color:var(--text-2);font-size:12.5px;" id="rebuild-status">
            状态就绪：支持随时校验双层目录哈希并隔离未解决的 Git 合并冲突文件。
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<!-- Multi-Tab Inspector & Editor Drawer -->
<div class="backdrop" id="drawer-backdrop">
  <div class="drawer-panel">
    <div class="drawer-header">
      <div style="font-weight:700;font-size:14.5px;" id="drw-title">条目检视</div>
      <button class="btn btn-sm" id="drw-close">✕ Esc</button>
    </div>
    <div class="drawer-tabs" id="drw-tabs">
      <button class="d-tab active" data-dtab="edit">结构化检视与同名同序修订</button>
      <button class="d-tab" data-dtab="raw">Markdown 真源卡片 (.md)</button>
      <button class="d-tab" data-dtab="gene">符号基因指纹 & 独立验证账本</button>
    </div>
    <div class="drawer-scroll" id="drw-scroll"></div>
    <div class="drawer-footer" id="drw-foot"></div>
  </div>
</div>

<!-- Command Palette (Cmd+K) -->
<div class="modal-mask" id="cmdk-mask">
  <div class="modal-card">
    <input class="cmdk-input" id="cmdk-input" placeholder="输入关键词、双语别名或操作命令…" />
    <div class="cmdk-list" id="cmdk-list"></div>
  </div>
</div>

<!-- Custom S01 / L6 / Action Dialog -->
<div class="modal-mask" id="dialog-mask">
  <div class="modal-card" id="dialog-box"></div>
</div>

<script>${ACCREMIND_OBSERVATORY_CLIENT_SCRIPT}</script>
</body>
</html>`;
}
