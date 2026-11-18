import pluginPackage from '../../package.json' with { type: 'json' };
import { ACCREMIND_OBSERVATORY_CLIENT_SCRIPT } from './client-script.ts';
import { ACCREMIND_OBSERVATORY_STYLES } from './styles.ts';

/**
 * AccreMind V3.1 "Dark-Matter Observatory & Context Prism" WebUI Bundle.
 * Features dual-theme (Obsidian Dark + Alabaster Blueprint), interactive orbital constellation SVG,
 * 4D orthogonal telemetry chips, Delta Prism side-by-side review desk, 3-lane live KV-cache & JIT
 * context compiler simulator, Command Palette (Cmd+K), and zero direct filesystem/SQLite coupling.
 */
export function renderAccreMindWebuiHtml(options: { embedded?: boolean } = {}): string {
  const productTitle = options.embedded ? 'DSH 经验工作台' : '工程经验工作台';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${productTitle} · AccreMind</title>
<style>${ACCREMIND_OBSERVATORY_STYLES}</style>
</head>
<body>
<div id="toast-pill" class="toast-pill" role="status"></div>

<div class="app-frame">
  <header class="topbar">
    <div class="topbar-inner">
      <div class="topbar-brand" title="${productTitle}"><div class="brand-orb" aria-hidden="true">Δ</div><span class="brand-name">AccreMind</span></div>
      <span class="workspace-label"><span class="workspace-dot"></span><span id="hud-ws">正在加载…</span></span>
      <div class="topbar-actions">
        <button class="cmdk-trigger" id="btn-cmdk" aria-label="搜索经验或操作"><span>搜索经验或操作</span><span class="kbd">⌘ K</span></button>
        <button class="btn btn-sm" id="btn-theme">亮色主题</button>
        <button class="btn btn-primary" id="btn-new-entry">＋ 录入经验</button>
        <span class="release-version" title="AccreMind 插件版本"><span>版本</span><b>v${pluginPackage.version}</b></span>
      </div>
    </div>
    <div class="topnav-inner">
      <nav class="topnav" aria-label="工作台菜单">
        <button class="nav-btn active" data-nav="kb" aria-current="page">知识库 <span class="nav-count" id="cnt-kb">0</span></button>
        <button class="nav-btn" data-nav="review">候选审核 <span class="nav-count" id="cnt-rev">0</span></button>
        <button class="nav-btn" data-nav="reactor">回合回执</button>
        <button class="nav-btn" data-nav="gov">治理与设置 <span class="nav-count" id="cnt-gov">0</span></button>
      </nav>
      <div class="nav-tools">
        <button class="quiet-button" data-open-legend>状态说明</button>
        <button class="quiet-button" id="btn-demo-toggle" data-demo-switch><span id="demo-label">体验示例</span></button>
      </div>
      <button class="quiet-button mobile-actions" id="btn-mobile-actions" aria-label="搜索与更多操作">更多</button>
    </div>
  </header>
  <main class="stage" aria-label="${productTitle}">
    <div class="stage-body">
      <div id="demo-banner" class="demo-banner" hidden>当前在演示空间中，所有操作仅作用于临时样本。<button class="btn btn-sm" data-demo-switch>返回我的工作区</button></div>
      <div id="app-error" class="alert-box alert-s01" role="alert" hidden></div>
      <section id="view-kb">
        <div class="glass-panel work-focus">
          <div class="work-focus-copy">
            <strong id="next-title">正在读取工作区…</strong>
          </div>
          <div id="next-actions" class="action-row"></div>
          <div id="constellation-svg-slot" aria-label="项目经验分布"></div>
        </div>

        <section id="library" aria-label="经验条目">
          <div class="library-heading">
            <div id="scope-choices" class="scope-choices" role="group" aria-label="按知识范围浏览">
              <input id="flt-layer" type="hidden" value="" />
              <button data-scope="" aria-pressed="true">全部知识 <span></span></button>
              <button data-scope="domain" aria-pressed="false">领域知识 <span></span></button>
              <button data-scope="project" aria-pressed="false">项目知识 <span></span></button>
              <button data-scope="shared_tech" aria-pressed="false">通用技术 <span></span></button>
              <button data-scope="team_rule" aria-pressed="false">团队规范 <span></span></button>
              <button data-scope="personal" aria-pressed="false">个人知识 <span></span></button>
            </div>
            <div class="seg-group" aria-label="显示方式">
              <button class="seg-btn active" data-view-mode="cards" aria-pressed="true">卡片</button>
              <button class="seg-btn" data-view-mode="table" aria-pressed="false">表格</button>
              <button class="seg-btn" data-view-mode="summary" aria-pressed="false">总结</button>
            </div>
          </div>
          <div class="toolbar">
            <div class="toolbar-filters">
              <input id="flt-q" aria-label="搜索经验" type="search" placeholder="搜索标题、结论或中英文别名　/" />
              <select id="flt-type" aria-label="经验类型"><option value="">所有类型</option><option value="pitfall">排障陷阱</option><option value="decision">架构决策</option><option value="guideline">规范</option><option value="model">领域模型</option><option value="process">操作流程</option></select>
              <select id="flt-zone" aria-label="存储空间">
                <option value="">所有存储位置</option><option value="rules">规范库</option><option value="project">项目库</option><option value="probation">本机试用池</option><option value="personal">个人空间</option><option value="shared_tech">跨项目共享库</option>
              </select>
              <select id="flt-status" aria-label="确认状态">
                <option value="">全部确认状态</option><option value="candidate">候选</option><option value="active">已确认</option><option value="probation">试用中</option><option value="withdrawn">已撤回</option><option value="archived">已归档</option>
              </select>
              <button class="btn btn-sm" id="toggle-filters" aria-expanded="false" aria-controls="more-filters">更多筛选</button>
              <button class="btn btn-sm" id="clear-filters" hidden>清除筛选</button>
            </div>
            <div id="more-filters" class="more-filters" hidden>

              <select id="flt-maturity" aria-label="成熟度"><option value="">所有成熟度</option><option value="draft">待验证</option><option value="verified">已验证一次</option><option value="proven">多任务证实</option><option value="verified_or_proven">已独立验证（全部）</option></select>
              <select id="flt-freshness" aria-label="时效性"><option value="">所有时效</option><option value="current">当前适用</option><option value="review_due">待复核</option><option value="stale">已失效</option></select>
              <select id="flt-serving" aria-label="检索开关"><option value="">所有检索状态</option><option value="enabled">检索已开启</option><option value="suspended">检索已暂停</option></select>
            </div>
          </div>
          <div id="result-caption" class="result-caption" aria-live="polite"><span id="scope-caption">全部知识</span><span id="vault-count"></span></div>
          <div id="vault-host" aria-live="polite"></div>
        </section>
        <details id="overview-panel" class="glass-panel overview-panel">
          <summary>知识分布与状态 <span class="summary-meta" id="overview-total"></span></summary>
          <div class="overview-body">
            <div class="overview-stats">
              <button class="layer-tile" data-filter-shortcut="rules">团队规范 <strong id="lt-rules">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="project">项目库已确认 <strong id="lt-proj">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="probation">试用中 <strong id="lt-prob">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="nav">代码与文档索引 <strong id="lt-nav">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="active">已确认 <strong id="m-active">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="verified">已独立验证 <strong id="m-ver">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="due">待复核 <strong id="m-stale">0</strong></button>
              <button class="layer-tile" data-filter-shortcut="suspended">已暂停检索 <strong id="m-suspended">0</strong></button>
            </div>
          </div>
        </details>

      </section>

      <!-- VIEW 2: Delta Prism Review Desk -->
      <section id="view-review" style="display:none;">
        <div class="glass-panel" style="margin-bottom:18px;">
          <div class="panel-head">
            <div>
              <div class="panel-title">候选记录</div>
              <div class="panel-sub">核对新增结论的来源，再决定去向。</div>
            </div>
          </div>
          <div style="padding:18px 20px;" id="prism-queue-host"></div>
        </div>

        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">代码与文档索引</div>
              <div class="panel-sub">可直接从代码或文档查到的内容保存在这里。</div>
            </div>
          </div>
          <div style="padding:14px 20px;" id="nav-index-host"></div>
        </div>
      </section>

      <!-- VIEW 3: 3-Lane Context Compiler & JIT Guard Reactor -->
      <section id="view-reactor" style="display:none;">
        <section class="glass-panel receipt-panel"><div class="panel-head"><h2>最近回合</h2><button id="refresh-receipts" class="btn btn-sm">刷新回执</button></div><div id="receipt-host" aria-live="polite"></div></section>
        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">命中模拟</div>
              <div class="panel-sub">预览提问和文件路径会触发哪些提示。模拟只读，曝光仅在真实任务中记录。</div>
            </div>
          </div>
          <div style="padding:18px 20px;">
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
              <span style="font-size:12px;color:var(--text-3);align-self:center;">示例场景</span>
              <button class="btn btn-sm" data-sim-preset="1">支付重复扣款</button>
              <button class="btn btn-sm" data-sim-preset="2">中途编辑 webhook.ts</button>
              <button class="btn btn-sm" data-sim-preset="3">Redis 草稿试用</button>
            </div>
            <div class="sim-fields">
              <div>
                <label class="form-hint" for="sim-prompt">本轮提问</label>
                <input id="sim-prompt" value="帮我重构一下账务结算模块代码结构" style="width:100%;" />
              </div>
              <div>
                <label class="form-hint" for="sim-active-file">提问中提到的文件</label>
                <input id="sim-active-file" placeholder="如 src/order/order.service.ts" style="width:100%;" />
              </div>
              <div>
                <label class="form-hint" for="sim-jit-file">任务中读写的文件</label>
                <input id="sim-jit-file" value="src/payment/webhook.ts" style="width:100%;" />
              </div>
              <button class="btn btn-primary" id="btn-run-reactor">预览命中</button>
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
              <div class="panel-title">经验复核</div>
              <div class="panel-sub">核对触发原因和代码差异，决定继续使用、修订或标记失效。</div>
            </div>
            <button class="btn btn-sm" id="btn-gov-scan">检查变更</button>
          </div>
          <div style="padding:16px 20px;" id="gov-stale-host"></div>
        </div>

        <div class="glass-panel" style="margin-bottom:16px;">
          <div class="panel-head">
            <div>
              <div class="panel-title">从 Git 历史发现经验</div>
              <div class="panel-sub">先在本机扫描修复、回滚和连续返工的提交，再选择需要提炼的记录。</div>
            </div>
            <button class="btn btn-sm btn-primary" id="btn-gov-arch">扫描提交</button>
          </div>
          <div style="padding:16px 20px;" id="arch-timeline-host">
            <div style="color:var(--text-3);font-size:12.5px;">从当前仓库的提交记录开始。扫描在本机执行。</div>
          </div>
        </div>

        <section id="workspace-settings" class="glass-panel settings-panel"><div class="panel-head"><h2>经验写入与模型</h2></div><div id="settings-host"></div></section>
        <div class="glass-panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">检索索引</div>
              <div class="panel-sub">从本机保存的 Markdown 经验卡片重建检索索引。</div>
            </div>
            <button class="btn btn-sm" id="btn-gov-rebuild">重建索引</button>
          </div>
          <div style="padding:14px 20px;color:var(--text-2);font-size:12.5px;" id="rebuild-status">
            出现缺失条目或解决文件冲突后，可重新建立索引。
          </div>
        </div>
      </section>
    </div>
  </main>
</div>

<!-- Multi-Tab Inspector & Editor Drawer -->
<div class="backdrop" id="drawer-backdrop">
  <div class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="drw-title">
    <div class="drawer-header">
      <div style="font-weight:700;font-size:14.5px;" id="drw-title">条目检视</div>
      <button class="btn btn-sm" id="drw-close">✕ Esc</button>
    </div>
    <div class="drawer-tabs" id="drw-tabs">
      <button class="d-tab active" data-dtab="edit">内容与修订</button>
      <button class="d-tab" data-dtab="raw">Markdown 原文</button>
      <button class="d-tab" data-dtab="gene">锚点与验证记录</button>
    </div>
    <div class="drawer-scroll" id="drw-scroll"></div>
    <div class="drawer-footer" id="drw-foot"></div>
  </div>
</div>

<!-- Command Palette (Cmd+K) -->
<div class="modal-mask" id="cmdk-mask">
  <div class="modal-card" role="dialog" aria-modal="true" aria-label="搜索经验与操作">
    <input class="cmdk-input" id="cmdk-input" placeholder="输入关键词、双语别名或操作命令…" />
    <div class="cmdk-list" id="cmdk-list"></div>
  </div>
</div>

<!-- Custom S01 / L6 / Action Dialog -->
<div class="modal-mask" id="dialog-mask">
  <div class="modal-card" id="dialog-box" role="dialog" aria-modal="true" aria-labelledby="dialog-title"></div>
</div>

<script>${ACCREMIND_OBSERVATORY_CLIENT_SCRIPT}</script>
</body>
</html>`;
}
