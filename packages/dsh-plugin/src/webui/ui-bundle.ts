/**
 * Ant Design 6-compliant embedded WebUI bundle for AccreMind V3.1.
 * Strictly adheres to the WebUI security boundary: zero direct filesystem or SQLite access;
 * all state reads and mutations go through typed `accremind.*` Host RPC calls.
 */
export function renderAccreMindWebuiHtml(options: { embedded?: boolean } = {}): string {
  const isEmbedded = Boolean(options.embedded);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AccreMind · DSH 本地研发经验增量工作台 (V3.1)</title>
<style>
  :root {
    --primary: #1677ff;
    --primary-hover: #4096ff;
    --primary-bg: #e6f4ff;
    --primary-border: #91caff;
    --success: #52c41a;
    --success-bg: #f6ffed;
    --success-border: #b7eb8f;
    --warn: #faad14;
    --warn-bg: #fffbe6;
    --warn-border: #ffe58f;
    --danger: #ff4d4f;
    --danger-bg: #fff2f0;
    --danger-border: #ffccc7;
    --bg-layout: #f5f5f5;
    --bg-card: #ffffff;
    --border: #f0f0f0;
    --border-strong: #d9d9d9;
    --text: rgba(0, 0, 0, 0.88);
    --text-sec: rgba(0, 0, 0, 0.65);
    --text-muted: rgba(0, 0, 0, 0.45);
    --radius: 6px;
    --radius-lg: 8px;
    --shadow: 0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    color: var(--text);
    background: var(--bg-layout);
  }
  .shell { display: flex; min-height: 100vh; }
  .sider {
    width: 228px;
    background: #fff;
    border-right: 1px solid var(--border);
    padding: 16px 8px;
    flex-shrink: 0;
  }
  .brand {
    padding: 4px 12px 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 12px;
  }
  .brand-title { font-size: 16px; font-weight: 600; color: var(--text); }
  .brand-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .nav-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 9px 12px; margin: 4px 0; border-radius: var(--radius);
    cursor: pointer; color: var(--text-sec); font-weight: 500; user-select: none;
  }
  .nav-item:hover { background: #fafafa; color: var(--text); }
  .nav-item.active { background: var(--primary-bg); color: var(--primary); font-weight: 600; }
  .badge-pill {
    font-size: 12px; padding: 1px 7px; border-radius: 10px;
    background: #f0f0f0; color: var(--text-sec);
  }
  .nav-item.active .badge-pill { background: #fff; color: var(--primary); }
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .topbar {
    height: 56px; background: #fff; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
    position: sticky; top: 0; z-index: 10;
  }
  .content { padding: 24px; max-width: 1360px; width: 100%; }
  .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
  .stat-card {
    background: #fff; border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 20px;
  }
  .stat-label { font-size: 12px; color: var(--text-muted); }
  .stat-val { font-size: 24px; font-weight: 600; margin-top: 6px; }
  .card {
    background: #fff; border: 1px solid var(--border); border-radius: var(--radius-lg);
    margin-bottom: 16px; overflow: hidden;
  }
  .card-head {
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; font-weight: 600;
  }
  .card-body { padding: 16px 20px; }
  .filter-bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
  input, select, textarea {
    font: inherit; padding: 6px 11px; border: 1px solid var(--border-strong);
    border-radius: var(--radius); background: #fff; color: var(--text); outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--primary); }
  .btn {
    height: 32px; padding: 0 14px; border-radius: var(--radius); border: 1px solid var(--border-strong);
    background: #fff; color: var(--text); cursor: pointer; font-size: 13px; display: inline-flex;
    align-items: center; gap: 6px;
  }
  .btn:hover { border-color: var(--primary-hover); color: var(--primary-hover); }
  .btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: #fff; }
  .btn-danger { background: var(--danger); border-color: var(--danger); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #fafafa; text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text-sec); font-weight: 600; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:hover td { background: #fafafa; }
  .chip {
    display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 4px;
    border: 1px solid var(--border-strong); background: #fafafa; margin-right: 4px;
  }
  .chip-blue { background: var(--primary-bg); border-color: var(--primary-border); color: var(--primary); }
  .chip-green { background: var(--success-bg); border-color: var(--success-border); color: #389e0d; }
  .chip-orange { background: var(--warn-bg); border-color: var(--warn-border); color: #d48806; }
  .chip-red { background: var(--danger-bg); border-color: var(--danger-border); color: #cf1322; }
  .split-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 12px 0; }
  .cmp-box { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: #fafafa; }
  .cmp-delta { background: var(--primary-bg); border-color: var(--primary-border); }
  .turn-bar {
    background: #fafafa; border: 1px solid var(--border-strong); border-radius: var(--radius);
    padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .drawer-mask {
    position: fixed; inset: 0; background: rgba(0,0,0,0.35); backdrop-filter: blur(2px);
    display: none; justify-content: flex-end; z-index: 50;
  }
  .drawer-mask.open { display: flex; }
  .drawer {
    width: 680px; max-width: 94vw; background: #fff; height: 100%; display: flex;
    flex-direction: column; box-shadow: var(--shadow);
  }
  .drawer-head { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 15px; }
  .drawer-body { padding: 20px; overflow-y: auto; flex: 1; }
  .drawer-foot { padding: 12px 20px; border-top: 1px solid var(--border); background: #fff; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .fh { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
  .field input, .field textarea, .field select { width: 100%; }
  .code-plain {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    background: #f5f5f5; padding: 10px 12px; border-radius: var(--radius); white-space: pre-wrap;
    word-break: break-word; border: 1px solid var(--border);
  }
  .banner-warn { background: var(--warn-bg); border: 1px solid var(--warn-border); padding: 10px 14px; border-radius: var(--radius); margin-bottom: 12px; font-size: 13px; }
  .banner-err { background: var(--danger-bg); border: 1px solid var(--danger-border); padding: 10px 14px; border-radius: var(--radius); margin-bottom: 12px; font-size: 13px; color: #cf1322; }
  .toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #fff; border: 1px solid var(--border); box-shadow: var(--shadow);
    padding: 8px 16px; border-radius: var(--radius); z-index: 100; display: none; font-size: 13px;
  }
</style>
</head>
<body>
<div id="toast" class="toast"></div>
<div class="shell">
  <aside class="sider">
    <div class="brand">
      <div class="brand-title">AccreMind V3.1</div>
      <div class="brand-sub">${isEmbedded ? 'DSH 内嵌经验面板' : 'DSH 本地经验基座'}</div>
    </div>
    <div class="nav-item active" data-tab="kb">
      <span>知识浏览与编辑</span><span class="badge-pill" id="nav-kb-cnt">0</span>
    </div>
    <div class="nav-item" data-tab="review">
      <span>增量对比审核台</span><span class="badge-pill" id="nav-rev-cnt">0</span>
    </div>
    <div class="nav-item" data-tab="turn">
      <span>Turn 回执与雷达联调</span><span class="badge-pill">实时</span>
    </div>
    <div class="nav-item" data-tab="gov">
      <span>时效治理与历史考古</span><span class="badge-pill" id="nav-gov-cnt">0</span>
    </div>
  </aside>

  <div class="main">
    <header class="topbar">
      <div>
        <strong id="ws-label">加载工作区中…</strong>
        <span class="chip" id="dir-label" style="margin-left:8px;">.accremind</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn" id="btn-top-scan">巡检本地 Git 时效</button>
        <button class="btn btn-primary" id="btn-open-create">＋ 手动录入经验</button>
      </div>
    </header>

    <main class="content">
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-label">已生效项目经验 (active)</div>
          <div class="stat-val" id="st-active">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">影子试用草稿 (probation)</div>
          <div class="stat-val" id="st-probation">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">已验证 / 可靠 (verified+proven)</div>
          <div class="stat-val" id="st-verified">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">代码变更待复核 (review_due)</div>
          <div class="stat-val" id="st-stale">0</div>
        </div>
      </div>

      <!-- TAB 1: Knowledge Explorer -->
      <section id="tab-kb">
        <div class="card">
          <div class="card-head">
            <span>本地研发经验库（L6 四维状态正交 · 禁百分比评分）</span>
          </div>
          <div class="card-body">
            <div class="filter-bar">
              <input id="f-query" placeholder="按标题 / 结论 / 双语别名检索 (按 / 聚焦)" style="width:280px;" />
              <select id="f-status">
                <option value="">全部确认态</option>
                <option value="active">已生效 (active)</option>
                <option value="probation">影子试用 (probation)</option>
                <option value="withdrawn">已撤回 (withdrawn)</option>
                <option value="archived">已归档 (archived)</option>
              </select>
              <select id="f-type">
                <option value="">全部主类型</option>
                <option value="pitfall">排障陷阱 (pitfall)</option>
                <option value="decision">架构取舍 (decision)</option>
                <option value="guideline">规范准则 (guideline)</option>
                <option value="model">领域模型 (model)</option>
                <option value="process">操作流程 (process)</option>
              </select>
              <button class="btn btn-primary" id="btn-kb-search">查询</button>
              <button class="btn" id="btn-kb-reset">重置</button>
            </div>
            <div id="kb-table-wrap"></div>
          </div>
        </div>
      </section>

      <!-- TAB 2: Delta Review Desk -->
      <section id="tab-review" style="display:none;">
        <div class="card">
          <div class="card-head">
            <span>代码可发现性对照与五路分流审核台（PRD §6.8.5）</span>
          </div>
          <div class="card-body" id="review-list-wrap"></div>
        </div>
        <div class="card">
          <div class="card-head">
            <span>已分流的代码导航与权威文档索引 (navigation.json · 不计入经验数)</span>
          </div>
          <div class="card-body" id="nav-items-wrap"></div>
        </div>
      </section>

      <!-- TAB 3: Turn Experience Bar & Live Radar Simulator -->
      <section id="tab-turn" style="display:none;">
        <div class="card">
          <div class="card-head"><span>对话气泡底部 Turn 经验回执条与雷达命中仿真</span></div>
          <div class="card-body">
            <div class="filter-bar">
              <input id="sim-query" placeholder="输入模拟开发者提问，如：怎么防止重复扣款 / 丢单" style="width:360px;" />
              <button class="btn btn-primary" id="btn-sim-run">测试本轮雷达唤醒</button>
            </div>
            <div id="sim-result-wrap"></div>
          </div>
        </div>
      </section>

      <!-- TAB 4: Governance, Archaeology & Settings -->
      <section id="tab-gov" style="display:none;">
        <div class="card">
          <div class="card-head">
            <span>符号级时效复核队列（格式化免疫 · 仅函数体逻辑或依赖变更触发）</span>
            <button class="btn" id="btn-gov-rescan">立即扫描</button>
          </div>
          <div class="card-body" id="gov-stale-wrap"></div>
        </div>

        <div class="card">
          <div class="card-head">
            <span>Git 历史考古冷启动挖掘器 (accremind bootstrap)</span>
            <button class="btn btn-primary" id="btn-gov-bootstrap">扫描仓库高信号历史提交</button>
          </div>
          <div class="card-body" id="gov-arch-wrap">
            <div style="color:var(--text-muted);">点击右上按钮扫描当前 Git 仓库最近历史中的 revert / hotfix / race / 48h 返工热区提交。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span>本地派生索引维护（Markdown 真源 → SQLite FTS5）</span>
            <button class="btn" id="btn-gov-rebuild">一键全量无损重建 SQLite 索引</button>
          </div>
          <div class="card-body" id="gov-rebuild-msg" style="color:var(--text-sec);">
            所有条目以双层目录 Markdown 文件为唯一真源；删除或重建 accremind.sqlite 不会丢失任何知识正文。
          </div>
        </div>
      </section>
    </main>
  </div>
</div>

<!-- Detail / Same-Order Edit / Create Drawer -->
<div class="drawer-mask" id="drawer-mask">
  <div class="drawer">
    <div class="drawer-head">
      <span id="drawer-title">条目详情</span>
      <button class="btn" id="btn-drawer-close">✕ 关闭</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
    <div class="drawer-foot" id="drawer-foot"></div>
  </div>
</div>

<script>
(function() {
  async function callRpc(method, params) {
    if (window.__DSH_ACCREMIND_RPC__) {
      return window.__DSH_ACCREMIND_RPC__(method, params || {});
    }
    const resp = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: method, params: params || {} })
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(data.error || ('RPC 调用失败: ' + resp.status));
    }
    return data.result;
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(function() { el.style.display = 'none'; }, 2800);
  }

  function statusBadges(e) {
    const stCls = e.status === 'active' ? 'chip-green' : e.status === 'probation' ? 'chip-blue' : 'chip-red';
    const matMap = { draft: '待验证 (draft)', verified: '已验证 (verified)', proven: '已证实 (proven)' };
    const freshCls = e.freshness === 'current' ? '' : 'chip-orange';
    const serveBadge = e.serving === 'suspended' ? '<span class="chip chip-red">已熔断暂停</span>' : '';
    return '<span class="chip ' + stCls + '">' + esc(e.status) + '</span>' +
           '<span class="chip">' + esc(matMap[e.maturity] || e.maturity) + '</span>' +
           (e.freshness !== 'current' ? '<span class="chip ' + freshCls + '">' + esc(e.freshness) + '</span>' : '') +
           serveBadge;
  }

  async function refreshOverview() {
    const ov = await callRpc('accremind.dashboard.overview', {});
    document.getElementById('ws-label').textContent = '工作区: ' + ov.workspaceId;
    document.getElementById('dir-label').textContent = ov.projectDir;
    document.getElementById('st-active').textContent = ov.counts.activeCount;
    document.getElementById('st-probation').textContent = ov.counts.probationCount;
    document.getElementById('st-verified').textContent = ov.counts.verifiedOrProvenCount;
    document.getElementById('st-stale').textContent = ov.counts.reviewDueCount;
    document.getElementById('nav-kb-cnt').textContent = ov.counts.totalEntries;
    document.getElementById('nav-rev-cnt').textContent = ov.counts.pendingReviewCount;
    document.getElementById('nav-gov-cnt').textContent = ov.counts.reviewDueCount + ov.counts.corruptedCount;
  }

  async function loadKbList() {
    const q = document.getElementById('f-query').value.trim();
    const st = document.getElementById('f-status').value;
    const tp = document.getElementById('f-type').value;
    const res = await callRpc('accremind.kb.list', {
      adminView: !q,
      query: q || undefined,
      status: st || undefined,
      type: tp || undefined,
      includeProbation: true
    });

    const wrap = document.getElementById('kb-table-wrap');
    if (!res.items || res.items.length === 0) {
      const reasonMap = {
        no_applicable_entry: '无匹配适用经验（零结果属于合法返回，系统绝不强行填充无关内容）',
        version_excluded: '找到相关条目但因当前仓库依赖版本不满足前置约束被排除',
        suspended_conflict: '匹配条目当前因反证反馈处于已暂停检索 (suspended) 状态'
      };
      wrap.innerHTML = '<div class="banner-warn"><strong>零结果返回（L3）</strong>：' +
        esc(reasonMap[res.zeroReason] || '当前无记录') + '</div>';
      return;
    }

    let html = '<table><thead><tr><th>ID</th><th>标题与双语别名</th><th>类型/优先级</th><th>四维正交状态</th><th>操作</th></tr></thead><tbody>';
    for (const hit of res.items) {
      const e = hit.entry;
      const aliases = (e.search_aliases || []).slice(0, 4).map(function(a) { return '<span class="chip">' + esc(a) + '</span>'; }).join('');
      const probBtns = e.status === 'probation'
        ? '<button class="btn btn-primary" data-promote="' + esc(e.id) + '" style="height:26px;padding:0 8px;">✓ 转正</button> '
        : '';
      html += '<tr>' +
        '<td><code>' + esc(e.id) + '@r' + esc(e.revision) + '</code></td>' +
        '<td><div style="font-weight:600;">' + esc(e.title) + '</div><div style="margin-top:4px;">' + aliases + '</div></td>' +
        '<td><span class="chip chip-blue">' + esc(e.type) + '</span><span class="chip">' + esc(e.priority) + '</span></td>' +
        '<td>' + statusBadges(e) + '</td>' +
        '<td>' + probBtns + '<button class="btn" data-detail="' + esc(e.id) + '" style="height:26px;padding:0 10px;">详情 / 编辑</button></td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }

  async function openDetailDrawer(id) {
    const detail = await callRpc('accremind.kb.get', { id: id });
    if (!detail.found) { showToast('未找到该条目'); return; }
    const e = detail.entry;
    document.getElementById('drawer-title').textContent = e.id + ' · 条目详情与同名同序修订';
    const body = document.getElementById('drawer-body');
    const foot = document.getElementById('drawer-foot');

    // L1: Commands inside claim / verification / evidence are strictly rendered via esc() plain text!
    body.innerHTML =
      '<div style="margin-bottom:14px;">' + statusBadges(e) + '</div>' +
      '<div id="s03-box"></div>' +
      '<div class="field"><label>标题 *</label><div class="fh">一句话说明什么条件下需要注意什么</div><input id="ed-title" value="' + esc(e.title) + '" /></div>' +
      '<div class="field"><label>双语检索别名 (逗号分隔)</label><div class="fh">补充口语词与代码标识符以提升召回</div><input id="ed-aliases" value="' + esc((e.search_aliases || []).join(', ')) + '" /></div>' +
      '<div class="field"><label>核心结论 (Claim) *</label><div class="fh">可直接指导编码的确定性结论（L1 纯文本渲染）</div><textarea id="ed-claim" rows="3">' + esc(e.claim) + '</textarea></div>' +
      '<div class="field"><label>相较现有代码新增的上下文 (Knowledge Delta) *</label><div class="fh">仅看源码无法直接得知的背景或隐性约束</div><textarea id="ed-delta" rows="3">' + esc(e.knowledge_delta) + '</textarea></div>' +
      '<div class="field"><label>原因与证据依据 (Rationale) *</label><textarea id="ed-rationale" rows="2">' + esc(e.rationale) + '</textarea></div>' +
      '<div class="field"><label>适用前置条件 (每行一条) *</label><textarea id="ed-pre" rows="2">' + esc((e.preconditions || []).join('\\n')) + '</textarea></div>' +
      '<div class="field"><label>失效触发条件 (每行一条) *</label><textarea id="ed-inv" rows="2">' + esc((e.invalidation_triggers || []).join('\\n')) + '</textarea></div>' +
      '<div class="field"><label>验证方法 *</label><div class="code-plain">' + esc(e.verification_method) + '</div></div>' +
      '<div class="field"><label>证据定位 (相对路径)</label><div class="code-plain">' + esc((e.evidence || []).map(function(ev){ return ev.id + ' [' + ev.locator + ']: ' + ev.summary; }).join('\\n')) + '</div></div>' +
      '<div class="field"><label>本次修订影响 *</label>' +
      '<select id="ed-impact"><option value="substantive">实质结论/条件变更（成熟度将重算为 draft）</option><option value="editorial">仅文字排版勘误（保留原成熟度）</option></select></div>';

    const canSkill = e.maturity === 'verified' || e.maturity === 'proven';
    foot.innerHTML =
      '<div style="display:flex;gap:8px;">' +
      '<button class="btn" id="btn-val-ok">✓ 记录独立验证有效</button>' +
      '<button class="btn btn-danger" id="btn-val-err">⚠ 疑似错误熔断</button>' +
      (canSkill ? '<button class="btn" id="btn-exp-skill">导出 SKILL.md</button>' : '') +
      '</div>' +
      '<button class="btn btn-primary" id="btn-save-rev">保存新版本</button>';

    document.getElementById('drawer-mask').classList.add('open');

    document.getElementById('btn-save-rev').onclick = async function() {
      const res = await callRpc('accremind.kb.saveRevision', {
        id: e.id,
        revisionImpact: document.getElementById('ed-impact').value,
        patch: {
          title: document.getElementById('ed-title').value,
          search_aliases: document.getElementById('ed-aliases').value.split(',').map(function(s){return s.trim();}).filter(Boolean),
          claim: document.getElementById('ed-claim').value,
          knowledge_delta: document.getElementById('ed-delta').value,
          rationale: document.getElementById('ed-rationale').value,
          preconditions: document.getElementById('ed-pre').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
          invalidation_triggers: document.getElementById('ed-inv').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean)
        }
      });
      if (!res.ok) {
        document.getElementById('s03-box').innerHTML =
          '<div class="banner-err"><strong>S03 门禁阻断（请补齐以下必填项）</strong>：<br/>' +
          res.missingFields.map(esc).join('<br/>') + '</div>';
        return;
      }
      showToast('已保存版本 r' + res.entry.revision);
      closeDrawer();
      await refreshAll();
    };

    document.getElementById('btn-val-ok').onclick = async function() {
      const note = prompt('请输入本次在独立任务中验证有效的说明（如通过的测试名）：', '回归测试验证通过');
      if (!note) return;
      await callRpc('accremind.feedback.submit', { id: e.id, kind: 'verified_effective', detail: note });
      showToast('独立验证已记录，成熟度/状态已更新');
      closeDrawer();
      await refreshAll();
    };

    document.getElementById('btn-val-err').onclick = async function() {
      const note = prompt('S01 反证确认：请填写该结论错误的依据（提交后将立即暂停该条检索注入）：');
      if (!note) return;
      await callRpc('accremind.feedback.submit', { id: e.id, kind: 'suspected_error', detail: note });
      showToast('已熔断暂停该条目 (serving=suspended)');
      closeDrawer();
      await refreshAll();
    };

    if (canSkill) {
      document.getElementById('btn-exp-skill').onclick = async function() {
        const slug = prompt('输入导出技能目录名 (.dsh/skills/<slug>/SKILL.md)：', e.id.toLowerCase());
        if (!slug) return;
        const out = await callRpc('accremind.gov.exportSkill', { id: e.id, skillSlug: slug });
        showToast('已导出至 ' + out.skillRelPath);
        await refreshAll();
      };
    }
  }

  function closeDrawer() {
    document.getElementById('drawer-mask').classList.remove('open');
  }

  async function loadReviewQueue() {
    const data = await callRpc('accremind.review.listQueue', { reviewState: 'all' });
    const wrap = document.getElementById('review-list-wrap');
    if (!data.items || data.items.length === 0) {
      wrap.innerHTML = '<div style="color:var(--text-muted);">当前暂无采集评估记录。</div>';
    } else {
      wrap.innerHTML = data.items.map(function(item) {
        const a = item.assessment;
        const isPending = item.reviewState === 'pending';
        const actions = isPending
          ? '<div style="margin-top:10px;display:flex;gap:8px;">' +
            '<button class="btn btn-primary" data-rev-act="approve_active" data-ca="' + esc(a.id) + '">批准入项目正式库</button>' +
            '<button class="btn" data-rev-act="approve_probation" data-ca="' + esc(a.id) + '">放入影子试用池</button>' +
            '<button class="btn" data-rev-act="index_only" data-ca="' + esc(a.id) + '">转为代码导航</button>' +
            '<button class="btn" data-rev-act="discard" data-ca="' + esc(a.id) + '">丢弃</button>' +
            '</div>'
          : '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">已分流处置: ' + esc(a.disposition) + '</div>';

        return '<div style="border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:12px;">' +
          '<div><strong>' + esc(a.id) + '</strong> · <span class="chip chip-blue">' + esc(a.priority) + '</span>' +
          '<span class="chip">' + esc(a.discoverability) + ' → ' + esc(a.disposition) + '</span>' +
          '<span style="margin-left:6px;font-weight:600;">场景问题：' + esc(a.question) + '</span></div>' +
          '<div class="split-compare">' +
          '<div class="cmp-box"><div style="font-weight:600;margin-bottom:6px;">左栏：仅看现有代码/文档得出的基线 (Baseline)</div><div>' + esc(a.baseline_answer || '（无）') + '</div></div>' +
          '<div class="cmp-box cmp-delta"><div style="font-weight:600;margin-bottom:6px;color:var(--primary);">右栏：本次新增不可恢复上下文 (Knowledge Delta)</div><div>' + esc(a.knowledge_delta || '（无新增代码外增量）') + '</div></div>' +
          '</div>' + actions + '</div>';
      }).join('');
    }

    const navWrap = document.getElementById('nav-items-wrap');
    if (!data.navigationItems || data.navigationItems.length === 0) {
      navWrap.innerHTML = '<div style="color:var(--text-muted);">暂无代码导航或文档链接项。</div>';
    } else {
      navWrap.innerHTML = data.navigationItems.map(function(n) {
        return '<div style="padding:6px 0;border-bottom:1px solid var(--border);"><span class="chip">' + esc(n.kind) + '</span> <strong>' + esc(n.title) + '</strong> → <code>' + esc(n.locator) + '</code></div>';
      }).join('');
    }
  }

  async function loadGovStale() {
    const res = await callRpc('accremind.gov.scanStaleness', {});
    const wrap = document.getElementById('gov-stale-wrap');
    let html = '';
    if (res.corruptedFiles && res.corruptedFiles.length > 0) {
      html += '<div class="banner-err"><strong>检测到隔离异常/Git冲突文件 (' + res.corruptedFiles.length + ')</strong>：<br/>' +
        res.corruptedFiles.map(function(c){ return esc(c.file_path + ' — ' + c.reason); }).join('<br/>') + '</div>';
    }
    if (!res.staleEntries || res.staleEntries.length === 0) {
      html += '<div style="color:var(--text-muted);">所有生效经验与当前本地 Git HEAD 及依赖版本保持一致，无待复核项。</div>';
    } else {
      html += res.staleEntries.map(function(e) {
        return '<div class="turn-bar" style="margin-bottom:8px;">' +
          '<div><code>' + esc(e.id) + '</code> <strong>' + esc(e.title) + '</strong> <span class="chip chip-orange">' + esc(e.freshness) + '</span></div>' +
          '<div style="display:flex;gap:8px;">' +
          '<button class="btn btn-primary" data-fresh-ok="' + esc(e.id) + '">✓ 核对新代码后确认仍有效</button>' +
          '<button class="btn" data-detail="' + esc(e.id) + '">修订内容</button>' +
          '</div></div>';
      }).join('');
    }
    wrap.innerHTML = html;
  }

  async function refreshAll() {
    await refreshOverview();
    await loadKbList();
    await loadReviewQueue();
    await loadGovStale();
  }

  // Event Delegation
  document.addEventListener('click', async function(ev) {
    const tabEl = ev.target.closest('[data-tab]');
    if (tabEl) {
      const tab = tabEl.getAttribute('data-tab');
      document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.toggle('active', n === tabEl); });
      ['kb', 'review', 'turn', 'gov'].forEach(function(t) {
        document.getElementById('tab-' + t).style.display = t === tab ? 'block' : 'none';
      });
      return;
    }

    const detailBtn = ev.target.closest('[data-detail]');
    if (detailBtn) {
      await openDetailDrawer(detailBtn.getAttribute('data-detail'));
      return;
    }

    const promoteBtn = ev.target.closest('[data-promote]');
    if (promoteBtn) {
      const id = promoteBtn.getAttribute('data-promote');
      await callRpc('accremind.probation.decide', { id: id, action: 'promote' });
      showToast('已将 ' + id + ' 转正迁入项目 .accremind/entries/');
      await refreshAll();
      return;
    }

    const revActBtn = ev.target.closest('[data-rev-act]');
    if (revActBtn) {
      const caId = revActBtn.getAttribute('data-ca');
      const act = revActBtn.getAttribute('data-rev-act');
      const res = await callRpc('accremind.review.decide', { assessmentId: caId, decision: act });
      if (!res.ok) {
        alert('S03 门禁阻断：\\n' + (res.missingFields || []).join('\\n'));
        return;
      }
      showToast('已完成分流裁决: ' + act);
      await refreshAll();
      return;
    }

    const freshBtn = ev.target.closest('[data-fresh-ok]');
    if (freshBtn) {
      await callRpc('accremind.gov.confirmFresh', { id: freshBtn.getAttribute('data-fresh-ok') });
      showToast('已刷新检查点并恢复 current 状态');
      await refreshAll();
      return;
    }
  });

  document.getElementById('btn-drawer-close').onclick = closeDrawer;
  document.getElementById('drawer-mask').onclick = function(e) { if (e.target.id === 'drawer-mask') closeDrawer(); };
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      document.getElementById('f-query').focus();
    }
  });

  document.getElementById('btn-kb-search').onclick = loadKbList;
  document.getElementById('btn-kb-reset').onclick = function() {
    document.getElementById('f-query').value = '';
    document.getElementById('f-status').value = '';
    document.getElementById('f-type').value = '';
    loadKbList();
  };
  document.getElementById('btn-top-scan').onclick = async function() {
    await loadGovStale();
    await refreshOverview();
    showToast('本地 Git 与依赖时效巡检完成');
  };
  document.getElementById('btn-gov-rescan').onclick = loadGovStale;
  document.getElementById('btn-gov-rebuild').onclick = async function() {
    const out = await callRpc('accremind.gov.rebuildIndex', {});
    document.getElementById('gov-rebuild-msg').textContent =
      '全量索引重建成功：同步 ' + out.syncedCount + ' 条经验卡片，隔离冲突文件 ' + out.corruptedCount + ' 个。';
    showToast('SQLite FTS5 索引重建完成');
    await refreshAll();
  };

  document.getElementById('btn-gov-bootstrap').onclick = async function() {
    const out = await callRpc('accremind.gov.bootstrapHistory', { topK: 10 });
    const wrap = document.getElementById('gov-arch-wrap');
    if (!out.minedCommits || out.minedCommits.length === 0) {
      wrap.innerHTML = '<div style="color:var(--text-muted);">当前仓库未发现得分 ≥ 3 的高信号历史排障/回滚提交。</div>';
      return;
    }
    wrap.innerHTML = out.minedCommits.map(function(c) {
      return '<div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px;">' +
        '<div><code>' + esc(c.commitSha.slice(0, 8)) + '</code> <span class="chip chip-blue">信号分 ' + esc(c.signalScore) + '</span> <strong>' + esc(c.subject) + '</strong></div>' +
        '<div style="font-size:12px;color:var(--text-sec);margin:4px 0;">命中信号：' + esc(c.signalReasons.join('；')) + '</div>' +
        '<div class="code-plain" style="max-height:140px;overflow:auto;">' + esc(c.diffPreview.slice(0, 800)) + '</div></div>';
    }).join('');
  };

  document.getElementById('btn-sim-run').onclick = async function() {
    const q = document.getElementById('sim-query').value.trim();
    const res = await callRpc('accremind.kb.list', { query: q, includeProbation: true, limit: 5 });
    const wrap = document.getElementById('sim-result-wrap');
    if (!res.items || res.items.length === 0) {
      wrap.innerHTML = '<div class="turn-bar"><span>本轮 Turn 回执：未命中相关经验 (' + esc(res.zeroReason) + ')</span></div>';
      return;
    }
    wrap.innerHTML = res.items.map(function(h) {
      const e = h.entry;
      return '<div class="turn-bar" style="margin-bottom:10px;">' +
        '<div><span class="chip chip-blue">雷达命中 ' + esc(e.id) + '@r' + esc(e.revision) + '</span> ' +
        '<strong>' + esc(e.title) + '</strong> ' + statusBadges(e) + '</div>' +
        '<div style="display:flex;gap:8px;">' +
        (e.status === 'probation'
          ? '<button class="btn btn-primary" data-promote="' + esc(e.id) + '">✓ 有效转正</button>'
          : '<button class="btn" data-detail="' + esc(e.id) + '">查看详情与反馈</button>') +
        '</div></div>';
    }).join('');
  };

  document.getElementById('btn-open-create').onclick = function() {
    document.getElementById('drawer-title').textContent = '手动录入代码外研发经验';
    document.getElementById('drawer-body').innerHTML =
      '<div id="create-err"></div>' +
      '<div class="field"><label>中立场景问题 (Question) *</label><input id="cr-q" placeholder="如：订单支付回调并发到达时如何防重？" /></div>' +
      '<div class="field"><label>现有代码基线答案 (Baseline) *</label><input id="cr-base" placeholder="仅看当前源码能得出的信息" /></div>' +
      '<div class="field"><label>代码外新增上下文 (Knowledge Delta) *</label><textarea id="cr-delta" rows="2" placeholder="源码未表达的隐性约束、否决原因或压测复现背景"></textarea></div>' +
      '<div class="field"><label>条目标题 *</label><input id="cr-title" placeholder="什么条件下需要注意什么" /></div>' +
      '<div class="field"><label>主类型 *</label><select id="cr-type"><option value="pitfall">pitfall</option><option value="decision">decision</option><option value="guideline">guideline</option><option value="model">model</option><option value="process">process</option></select></div>' +
      '<div class="field"><label>双语检索别名 (逗号分隔)</label><input id="cr-aliases" placeholder="重复扣款, 防重, idempotency" /></div>' +
      '<div class="field"><label>核心结论 (Claim) *</label><textarea id="cr-claim" rows="2"></textarea></div>' +
      '<div class="field"><label>适用前置条件 (每行一条) *</label><textarea id="cr-pre" rows="2"></textarea></div>' +
      '<div class="field"><label>失效触发条件 (每行一条) *</label><textarea id="cr-inv" rows="2"></textarea></div>' +
      '<div class="field"><label>证据相对路径定位 *</label><input id="cr-loc" placeholder="src/modules/order/service.ts#L10-L30" /></div>';

    document.getElementById('drawer-foot').innerHTML =
      '<span style="font-size:12px;color:var(--text-muted);">保存时强制执行 S03 增量与相对路径门禁校验</span>' +
      '<button class="btn btn-primary" id="btn-do-create">提交入库</button>';

    document.getElementById('drawer-mask').classList.add('open');

    document.getElementById('btn-do-create').onclick = async function() {
      try {
        const resp = await fetch('/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            method: '__tool.accremind_capture',
            params: {
              question: document.getElementById('cr-q').value,
              discoverability: 'missing_context',
              disposition: 'knowledge_candidate',
              baseline_answer: document.getElementById('cr-base').value,
              knowledge_delta: document.getElementById('cr-delta').value,
              title: document.getElementById('cr-title').value,
              type: document.getElementById('cr-type').value,
              polarity: 'avoid',
              search_aliases: document.getElementById('cr-aliases').value.split(',').map(function(s){return s.trim();}).filter(Boolean),
              claim: document.getElementById('cr-claim').value,
              rationale: document.getElementById('cr-delta').value,
              preconditions: document.getElementById('cr-pre').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              invalidation_triggers: document.getElementById('cr-inv').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              file_locator: document.getElementById('cr-loc').value
            }
          })
        });
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        const out = json.result;
        if (out.downgradedReason) {
          document.getElementById('create-err').innerHTML =
            '<div class="banner-err">门禁降级为 ' + esc(out.finalDisposition) + '：' + esc(out.downgradedReason) + '</div>';
          await refreshAll();
          return;
        }
        showToast('已入库 (' + out.finalDisposition + ')');
        closeDrawer();
        await refreshAll();
      } catch (err) {
        document.getElementById('create-err').innerHTML = '<div class="banner-err">' + esc(err.message) + '</div>';
      }
    };
  };

  refreshAll().catch(function(err) { showToast(err.message); });
})();
</script>
</body>
</html>`;
}
