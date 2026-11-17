export const ACCREMIND_OBSERVATORY_CLIENT_SCRIPT = `
(function() {
  var STATE = {
    tab: 'kb',
    viewMode: 'cards',
    theme: localStorage.getItem('accremind_theme') || 'dark',
    overview: null,
    kbItems: [],
    zeroReason: 'none',
    reviewItems: [],
    navItems: [],
    staleData: null,
    archCommits: []
  };

  document.documentElement.setAttribute('data-theme', STATE.theme);

  async function rpc(method, params) {
    if (window.__DSH_ACCREMIND_RPC__) {
      return window.__DSH_ACCREMIND_RPC__(method, params || {});
    }
    var resp = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: method, params: params || {} })
    });
    var json = await resp.json();
    if (!resp.ok || json.error) {
      throw new Error(json.error || ('RPC HTTP ' + resp.status));
    }
    return json.result;
  }

  function esc(val) {
    return String(val == null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg) {
    var el = document.getElementById('toast-pill');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(window.__accreToastTimer);
    window.__accreToastTimer = setTimeout(function() {
      el.style.display = 'none';
    }, 3000);
  }

  // Custom Modal Engine (Replaces ugly browser prompt/alert!)
  function openDialog(opts) {
    var mask = document.getElementById('dialog-mask');
    var box = document.getElementById('dialog-box');
    var levelBanner = '';
    if (opts.level === 'S01') {
      levelBanner = '<div class="alert-box alert-s01"><strong>S01 高危熔断操作</strong> · 必须填写可追溯依据，操作立即变更检索状态</div>';
    } else if (opts.level === 'L6') {
      levelBanner = '<div class="alert-box alert-s03"><strong>L6 四维正交铁律</strong> · 四个状态维度彼此正交并存，全站严禁使用“85% 可信度”等伪概率百分比</div>';
    }

    box.innerHTML =
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">' +
        '<strong style="font-size:15px;">' + esc(opts.title) + '</strong>' +
        '<button class="btn btn-sm" id="dlg-x">✕</button>' +
      '</div>' +
      '<div style="padding:18px 20px;">' +
        levelBanner +
        (opts.bodyHtml || '') +
        (opts.inputLabel
          ? '<div class="form-row" style="margin-top:10px;"><label>' + esc(opts.inputLabel) + '</label>' +
            '<textarea id="dlg-input" rows="3" placeholder="' + esc(opts.placeholder || '') + '">' + esc(opts.defaultValue || '') + '</textarea></div>'
          : '') +
        '<div id="dlg-err"></div>' +
      '</div>' +
      '<div style="padding:12px 20px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;gap:8px;background:var(--bg-elev-1);">' +
        '<button class="btn" id="dlg-cancel">取消</button>' +
        (opts.confirmText
          ? '<button class="btn ' + (opts.danger ? 'btn-crimson' : 'btn-primary') + '" id="dlg-ok">' + esc(opts.confirmText) + '</button>'
          : '') +
      '</div>';

    mask.classList.add('open');
    var close = function() { mask.classList.remove('open'); };
    document.getElementById('dlg-x').onclick = close;
    document.getElementById('dlg-cancel').onclick = close;

    var okBtn = document.getElementById('dlg-ok');
    if (okBtn && opts.onConfirm) {
      okBtn.onclick = async function() {
        var val = opts.inputLabel ? document.getElementById('dlg-input').value.trim() : '';
        if (opts.requireInput && !val) {
          document.getElementById('dlg-err').innerHTML = '<div class="alert-box alert-s01">请填写必填说明后再继续</div>';
          return;
        }
        try {
          await opts.onConfirm(val);
          close();
        } catch (err) {
          document.getElementById('dlg-err').innerHTML = '<div class="alert-box alert-s01">' + esc(err.message) + '</div>';
        }
      };
    }
  }

  function show4dLegendModal() {
    openDialog({
      title: '四维正交状态矩阵释义 (PRD §5.1 & L6)',
      level: 'L6',
      bodyHtml:
        '<div style="font-size:12.5px;color:var(--text-2);display:grid;gap:8px;">' +
        '<div><strong>1. 确认态 (Status)</strong>：<code>probation</code>(影子孵化，仅本机试用) · <code>active</code>(已落盘项目库) · <code>withdrawn</code>(错误撤回)</div>' +
        '<div><strong>2. 成熟度 (Maturity)</strong>：<code>draft</code>(单次捕获待复验) · <code>verified</code>(≥1次跨任务独立验证) · <code>proven</code>(≥2次独立验证)。<em>注意：检索或引用次数绝不自动提升成熟度！</em></div>' +
        '<div><strong>3. 时效性 (Freshness)</strong>：<code>current</code>(与当前符号哈希一致) · <code>review_due</code>(目标函数逻辑或依赖版本已变动)</div>' +
        '<div><strong>4. 检索开关 (Serving)</strong>：<code>enabled</code>(正常唤醒) · <code>suspended</code>(收到反证立即熔断停止注入)</div>' +
        '</div>'
    });
  }

  function render4dMatrix(e) {
    var stCls = e.status === 'active' ? 'm4-ok' : e.status === 'probation' ? 'm4-prob' : 'm4-err';
    var matCls = e.maturity === 'proven' || e.maturity === 'verified' ? 'm4-ok' : '';
    var frCls = e.freshness === 'current' ? '' : 'm4-warn';
    var svCls = e.serving === 'suspended' ? 'm4-err' : 'm4-ok';
    return '<div class="matrix-4d" data-open-legend="1" title="点击查看四维正交状态矩阵释义">' +
      '<span class="m4-cell ' + stCls + '">' + esc(e.status.toUpperCase()) + '</span>' +
      '<span class="m4-cell ' + matCls + '">' + esc(e.maturity.toUpperCase()) + '</span>' +
      '<span class="m4-cell ' + frCls + '">' + esc(e.freshness === 'review_due' ? 'REV_DUE' : e.freshness.toUpperCase()) + '</span>' +
      '<span class="m4-cell ' + svCls + '">' + esc(e.serving === 'enabled' ? 'ON' : 'OFF') + '</span>' +
      '</div>';
  }

  function renderProbationPips(exposures, maxExp) {
    var max = maxExp || 3;
    var pips = '';
    for (var i = 0; i < max; i++) {
      pips += '<span class="pip ' + (i < exposures ? 'used' : '') + '"></span>';
    }
    return '<span class="pip-meter" title="影子孵化剩余曝光寿命 (' + exposures + '/' + max + ' 次无反馈自动归档)">' + pips + ' 孵化 ' + exposures + '/' + max + '</span>';
  }

  function renderConstellationSvg(items, navCount) {
    var cx = 110, cy = 88;
    var rings = [26, 52, 76];
    var svg = '<svg class="constellation-svg" viewBox="0 0 220 176">' +
      '<defs>' +
        '<radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>' +
          '<stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="34" fill="url(#coreGlow)" />' +
      rings.map(function(r) { return '<circle class="orbit-ring" cx="' + cx + '" cy="' + cy + '" r="' + r + '" />'; }).join('') +
      '<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="var(--accent)" />';

    var nodes = (items || []).slice(0, 14);
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i].entry;
      var radius = e.layer === 'team_rule' ? 26 : e.status === 'probation' ? 76 : 52;
      var angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 3;
      var nx = (cx + Math.cos(angle) * radius).toFixed(1);
      var ny = (cy + Math.sin(angle) * radius).toFixed(1);
      var color = e.layer === 'team_rule' ? 'var(--emerald)' : e.status === 'probation' ? 'var(--violet)' : e.freshness !== 'current' ? 'var(--amber)' : 'var(--accent)';
      svg += '<g class="orbit-node" data-detail="' + esc(e.id) + '">' +
        '<title>' + esc(e.id + ' · ' + e.title) + '</title>' +
        '<circle cx="' + nx + '" cy="' + ny + '" r="5.5" fill="' + color + '" stroke="var(--bg-canvas)" stroke-width="1.5" />' +
        '</g>';
    }
    svg += '</svg>';
    return svg;
  }

  async function refreshDashboard() {
    var ov = await rpc('accremind.dashboard.overview', {});
    STATE.overview = ov;

    document.getElementById('hud-ws').textContent = ov.workspaceId;
    document.getElementById('rail-dir').textContent = ov.projectDir;

    document.getElementById('cnt-kb').textContent = ov.counts.totalEntries;
    document.getElementById('cnt-rev').textContent = ov.counts.pendingReviewCount;
    document.getElementById('cnt-gov').textContent = ov.counts.reviewDueCount + ov.counts.corruptedCount;

    document.getElementById('m-active').textContent = ov.counts.activeCount;
    document.getElementById('m-prob').textContent = ov.counts.probationCount;
    document.getElementById('m-ver').textContent = ov.counts.verifiedOrProvenCount;
    document.getElementById('m-stale').textContent = ov.counts.reviewDueCount;

    document.getElementById('lt-rules').textContent = ov.counts.rulesCount;
    document.getElementById('lt-proj').textContent = Math.max(0, ov.counts.activeCount - ov.counts.rulesCount);
    document.getElementById('lt-prob').textContent = ov.counts.probationCount;
    document.getElementById('lt-nav').textContent = ov.counts.navigationItemsCount;

    var demoBtn = document.getElementById('btn-demo-toggle');
    if (ov.hasDemoSeeded) {
      demoBtn.textContent = '✕ 清除演示样本';
      demoBtn.setAttribute('data-seeded', '1');
    } else {
      demoBtn.textContent = '✦ 载入工程暗物质样本';
      demoBtn.setAttribute('data-seeded', '0');
    }
  }

  async function loadVault() {
    var q = document.getElementById('flt-q').value.trim();
    var st = document.getElementById('flt-status').value;
    var tp = document.getElementById('flt-type').value;

    var res = await rpc('accremind.kb.list', {
      adminView: !q,
      query: q || undefined,
      status: st || undefined,
      type: tp || undefined,
      includeProbation: true,
      limit: 30
    });

    STATE.kbItems = res.items || [];
    STATE.zeroReason = res.zeroReason;

    document.getElementById('constellation-svg-slot').innerHTML =
      renderConstellationSvg(STATE.kbItems, STATE.overview ? STATE.overview.counts.navigationItemsCount : 0);

    renderVaultItems();
  }

  function renderVaultItems() {
    var host = document.getElementById('vault-host');
    var items = STATE.kbItems;

    if (!items || items.length === 0) {
      var zeroExplain = {
        no_applicable_entry: '当前筛选或检索词无匹配经验（L3 诚实空结果：系统绝不填充无关凑数条目）',
        version_excluded: '存在相关历史经验，但当前仓库 package.json 依赖版本不满足前置约束，已自动排除',
        suspended_conflict: '匹配条目因收到反证反馈当前处于熔断暂停 (suspended) 状态'
      };
      host.innerHTML =
        '<div class="empty-observatory">' +
          '<div style="font-size:28px;margin-bottom:8px;">🔭</div>' +
          '<div style="font-size:15px;font-weight:650;margin-bottom:6px;">暗物质观测站当前无匹配条目</div>' +
          '<div style="color:var(--text-2);max-width:520px;margin:0 auto 16px;">' + esc(zeroExplain[STATE.zeroReason] || '仅沉淀代码与现有文档无法直接恢复的工程增量。') + '</div>' +
          '<div style="display:flex;justify-content:center;gap:10px;">' +
            '<button class="btn btn-primary" data-seed-now="1">✦ 一键注入 4 条高仿真工程暗物质样本</button>' +
            '<button class="btn" data-open-create="1">＋ 手动录入第一条经验</button>' +
          '</div>' +
        '</div>';
      return;
    }

    if (STATE.viewMode === 'table') {
      var rows = items.map(function(hit) {
        var e = hit.entry;
        var pCls = e.priority === 'P0' ? 'tag-p0' : e.priority === 'P1' ? 'tag-p1' : '';
        return '<tr>' +
          '<td class="mono" style="font-size:12px;">' + esc(e.id) + '@r' + esc(e.revision) + '</td>' +
          '<td><div class="vc-title" data-detail="' + esc(e.id) + '">' + esc(e.title) + '</div></td>' +
          '<td><span class="tag tag-type">' + esc(e.type) + '</span> <span class="tag ' + pCls + '">' + esc(e.priority) + '</span></td>' +
          '<td>' + render4dMatrix(e) + '</td>' +
          '<td style="text-align:right;">' +
            (e.status === 'probation' ? '<button class="btn btn-sm btn-emerald" data-promote="' + esc(e.id) + '">⚡ 淬炼转正</button> ' : '') +
            '<button class="btn btn-sm" data-detail="' + esc(e.id) + '">检视棱镜</button>' +
          '</td></tr>';
      }).join('');
      host.innerHTML = '<div class="glass-panel"><table class="data-tbl"><thead><tr><th>ID</th><th>经验断言标题</th><th>分类 / 代价</th><th>四维正交遥测</th><th style="text-align:right;">操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      return;
    }

    host.innerHTML = '<div class="vault-grid">' + items.map(function(hit) {
      var e = hit.entry;
      var pCls = e.priority === 'P0' ? 'tag-p0' : e.priority === 'P1' ? 'tag-p1' : '';
      var aliases = (e.search_aliases || []).slice(0, 5).map(function(a) {
        return '<span class="tag">' + esc(a) + '</span>';
      }).join('');
      var maxExp = STATE.overview ? STATE.overview.maxProbationExposures : 3;
      return '<article class="vault-card">' +
        '<div class="vc-top">' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<code style="font-size:12px;color:var(--accent);font-weight:700;">' + esc(e.id) + '@r' + esc(e.revision) + '</code>' +
            '<span class="tag tag-type">' + esc(e.type) + '</span>' +
            '<span class="tag ' + pCls + '">' + esc(e.priority) + '</span>' +
            (e.layer === 'team_rule' ? '<span class="l1-lock-pill">KV-PINNED</span>' : '') +
          '</div>' +
          (e.status === 'probation' ? renderProbationPips(hit.probationExposures || 0, maxExp) : '') +
        '</div>' +
        '<div class="vc-title" data-detail="' + esc(e.id) + '">' + esc(e.title) + '</div>' +
        '<div class="vc-delta">' + esc((e.knowledge_delta || e.claim).slice(0, 135)) + '</div>' +
        (aliases ? '<div class="vc-aliases">' + aliases + '</div>' : '') +
        '<div class="vc-foot">' +
          render4dMatrix(e) +
          '<div style="display:flex;gap:6px;">' +
            (e.status === 'probation' ? '<button class="btn btn-sm btn-emerald" data-promote="' + esc(e.id) + '">⚡ 转正</button>' : '') +
            '<button class="btn btn-sm" data-detail="' + esc(e.id) + '">检视 / 修订</button>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('') + '</div>';
  }

  async function loadPrismReview() {
    var data = await rpc('accremind.review.listQueue', { reviewState: 'all' });
    STATE.reviewItems = data.items || [];
    STATE.navItems = data.navigationItems || [];

    var host = document.getElementById('prism-queue-host');
    if (STATE.reviewItems.length === 0) {
      host.innerHTML = '<div class="empty-observatory">暂无捕获评估记录。可点击右上角「✦ 载入工程暗物质样本」体验双栏分光镜对照审核。</div>';
    } else {
      host.innerHTML = STATE.reviewItems.map(function(item) {
        var a = item.assessment;
        var pending = item.reviewState === 'pending';
        var methodBadge = a.checked_context && a.checked_context.method === 'isolated_check'
          ? '<span class="l1-lock-pill">ISOLATED BLIND CHECK · ' + esc(a.checked_context.token_used) + ' tok</span>'
          : '<span class="tag">' + esc(a.checked_context ? a.checked_context.method : 'check') + '</span>';

        var dock = pending
          ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-subtle);">' +
              '<button class="btn btn-sm btn-primary" data-rev-decide="approve_active" data-ca="' + esc(a.id) + '">✓ 批准入项目正式库 (.accremind/entries)</button>' +
              '<button class="btn btn-sm btn-emerald" data-rev-decide="approve_probation" data-ca="' + esc(a.id) + '">🧪 放入影子孵化舱 (probation)</button>' +
              '<button class="btn btn-sm" data-rev-decide="index_only" data-ca="' + esc(a.id) + '">↳ 仅转代码导航 (index_only)</button>' +
              '<button class="btn btn-sm" data-rev-decide="link_existing" data-ca="' + esc(a.id) + '">🔗 链接权威文档 (link_existing)</button>' +
              '<button class="btn btn-sm btn-crimson" data-rev-decide="discard" data-ca="' + esc(a.id) + '">✕ 丢弃无增量噪声</button>' +
            '</div>'
          : '<div style="font-size:12px;color:var(--text-3);margin-top:8px;">已归档分流结论：<code>' + esc(a.disposition) + '</code></div>';

        return '<div class="prism-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
            '<div><code style="color:var(--accent);font-weight:700;">' + esc(a.id) + '</code> ' +
            '<span class="tag ' + (a.priority === 'P0' ? 'tag-p0' : 'tag-p1') + '">' + esc(a.priority) + '</span> ' +
            '<strong style="margin-left:6px;">中立盲测问题：' + esc(a.question) + '</strong></div>' +
            methodBadge +
          '</div>' +
          '<div class="prism-grid">' +
            '<div class="prism-pane">' +
              '<div class="prism-label">Visible Matter · 仅看当前源码与文档得出的基线</div>' +
              '<div style="color:var(--text-2);">' + esc(a.baseline_answer || '（现有代码无相关上下文表达）') + '</div>' +
            '</div>' +
            '<div class="prism-divider">Δ</div>' +
            '<div class="prism-pane delta">' +
              '<div class="prism-label">Dark-Matter Delta · 剥离复述后真正新增的隐性约束</div>' +
              '<div style="color:var(--text-1);font-weight:500;">' + esc(a.knowledge_delta || '（零增量）') + '</div>' +
              '<div style="margin-top:8px;font-size:11.5px;color:var(--text-2);">缺失代价：' + esc(a.omission_consequence) + '</div>' +
            '</div>' +
          '</div>' +
          dock +
        '</div>';
      }).join('');
    }

    var navHost = document.getElementById('nav-index-host');
    if (STATE.navItems.length === 0) {
      navHost.innerHTML = '<div style="color:var(--text-3);font-size:12.5px;">暂无分流至此的代码导航或文档链接。</div>';
    } else {
      navHost.innerHTML = STATE.navItems.map(function(n) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border-subtle);">' +
          '<div><span class="tag tag-type">' + esc(n.kind) + '</span> <strong style="margin-left:6px;">' + esc(n.title) + '</strong></div>' +
          '<code style="font-size:12px;color:var(--accent);">' + esc(n.locator) + '</code>' +
        '</div>';
      }).join('');
    }
  }

  async function runCompilerReactor() {
    var promptVal = document.getElementById('sim-prompt').value;
    var activeFileVal = document.getElementById('sim-active-file').value;
    var jitFileVal = document.getElementById('sim-jit-file').value;

    var out = await rpc('accremind.sim.compile', {
      userPrompt: promptVal,
      activeFile: activeFileVal,
      midTurnToolFile: jitFileVal
    });

    var bRes = out.budgets.residentRulesTokens || 500;
    var bRad = out.budgets.turnRadarTokens || 300;
    var bJit = out.budgets.toolGuardTokens || 240;

    var pctRes = Math.min(100, Math.round((out.residentTokens / bRes) * 100));
    var pctRad = Math.min(100, Math.round((out.radarTokens / bRad) * 100));
    var pctJit = Math.min(100, Math.round((out.guardTokens / bJit) * 100));

    document.getElementById('reactor-lanes').innerHTML =
      '<div class="lane-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<strong>Tier 1 · 常驻系统红线</strong>' +
          '<span class="l1-lock-pill">🔒 KV-CACHE SHA:' + esc(out.residentSha256.slice(0, 8)) + '</span>' +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--text-2);display:flex;justify-content:space-between;">' +
          '<span>ctx.systemPrompt.section</span><span class="mono">' + out.residentTokens + ' / ' + bRes + ' tok</span>' +
        '</div>' +
        '<div class="budget-bar"><div class="budget-fill" style="width:' + pctRes + '%;"></div></div>' +
        '<pre class="code-vault">' + esc(out.residentPrefix || '（当前无 rules/ 常驻红线）') + '</pre>' +
      '</div>' +

      '<div class="lane-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<strong>Tier 2 · 回合前瞬态雷达</strong>' +
          '<span class="tag tag-type">命中 ' + out.radarSurfacedIds.length + ' 条</span>' +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--text-2);display:flex;justify-content:space-between;">' +
          '<span>registerMessageProjection</span><span class="mono">' + out.radarTokens + ' / ' + bRad + ' tok</span>' +
        '</div>' +
        '<div class="budget-bar"><div class="budget-fill" style="width:' + pctRad + '%;"></div></div>' +
        '<pre class="code-vault">' + esc(out.radarBlock || '（回合前未命中相关关键词或路径）') + '</pre>' +
      '</div>' +

      '<div class="lane-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<strong>Tier 2.5 · 回合中 JIT 工具护栏</strong>' +
          '<span class="tag ' + (out.guardSurfacedIds.length > 0 ? 'tag-p0' : '') + '">拦截追加 ' + out.guardSurfacedIds.length + ' 条</span>' +
        '</div>' +
        '<div style="font-size:11.5px;color:var(--text-2);display:flex;justify-content:space-between;">' +
          '<span>tools/post-execute (会话去重)</span><span class="mono">' + out.guardTokens + ' / ' + bJit + ' tok</span>' +
        '</div>' +
        '<div class="budget-bar"><div class="budget-fill" style="width:' + pctJit + '%;"></div></div>' +
        '<pre class="code-vault">' + esc(out.guardBlock || '（该文件无未曝光的高优陷阱，或已在左栏雷达曝光去重）') + '</pre>' +
      '</div>';
  }

  async function loadGovernance() {
    var res = await rpc('accremind.gov.scanStaleness', {});
    STATE.staleData = res;
    var host = document.getElementById('gov-stale-host');
    var html = '';

    if (res.corruptedFiles && res.corruptedFiles.length > 0) {
      html += '<div class="alert-box alert-s01"><strong>隔离区告警：检测到 ' + res.corruptedFiles.length + ' 个未解决 Git 冲突或损坏文件（不影响其余条目正常运行）</strong><br/>' +
        res.corruptedFiles.map(function(c) { return '<code>' + esc(c.file_path) + '</code> — ' + esc(c.reason); }).join('<br/>') + '</div>';
    }

    if (!res.staleEntries || res.staleEntries.length === 0) {
      html += '<div style="padding:16px;color:var(--text-2);background:var(--bg-elev-2);border-radius:10px;border:1px solid var(--border-subtle);">' +
        '✓ 所有生效条目的函数符号去空白哈希 (<code>symbol_anchors</code>) 与当前 Git HEAD 完全对齐，零待复核积压。</div>';
    } else {
      html += res.staleEntries.map(function(e) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:var(--bg-elev-2);border:1px solid var(--amber);border-radius:10px;margin-bottom:10px;gap:12px;">' +
          '<div><code style="color:var(--amber);font-weight:700;">' + esc(e.id) + '@r' + esc(e.revision) + '</code> ' +
          '<strong style="margin-left:6px;">' + esc(e.title) + '</strong> ' +
          '<div style="font-size:12px;color:var(--text-2);margin-top:3px;">触发依据：' + esc((e.invalidation_triggers || []).join('；')) + '</div></div>' +
          '<div style="display:flex;gap:8px;flex-shrink:0;">' +
            '<button class="btn btn-sm btn-emerald" data-fresh-confirm="' + esc(e.id) + '">✓ 核对新代码后确认仍有效</button>' +
            '<button class="btn btn-sm" data-detail="' + esc(e.id) + '">修订版本</button>' +
          '</div></div>';
      }).join('');
    }
    host.innerHTML = html;
  }

  async function openEntryDrawer(id) {
    var data = await rpc('accremind.kb.get', { id: id });
    if (!data.found) { toast('未找到条目 ' + id); return; }
    var e = data.entry;

    document.getElementById('drw-title').innerHTML =
      '<code style="color:var(--accent);">' + esc(e.id) + '@r' + esc(e.revision) + '</code> · ' + esc(e.title);

    var drawerTabs = document.getElementById('drw-tabs');
    drawerTabs.style.display = 'flex';

    function renderTabEdit() {
      document.getElementById('drw-scroll').innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">' +
          render4dMatrix(e) +
          '<span class="l1-lock-pill">L1 REFERENCE ONLY · NON-EXECUTABLE</span>' +
        '</div>' +
        '<div id="drw-s03-banner"></div>' +
        '<div id="drw-s02-banner" class="alert-box alert-s02"><strong>S02 就地变更影响预览</strong>：当前选择「实质结论/条件变更」，保存后版本号升至 <code>r' + (e.revision + 1) + '</code>，成熟度将按 PRD §5.3 重置为 <code>draft</code> 待重新独立验证。</div>' +
        '<div class="form-row"><label>标题 (Title) *</label><div class="form-hint">一句话写清：什么条件下，需要注意什么</div><input id="f-ed-title" value="' + esc(e.title) + '" /></div>' +
        '<div class="form-row"><label>双语与口语检索别名 (search_aliases)</label><div class="form-hint">逗号分隔，弥合口语提问（如“重复扣款”）与底层标识符（如 idempotency_key）断层</div><input id="f-ed-aliases" value="' + esc((e.search_aliases || []).join(', ')) + '" /></div>' +
        '<div class="form-row"><label>核心结论 (Claim) *</label><textarea id="f-ed-claim" rows="3">' + esc(e.claim) + '</textarea></div>' +
        '<div class="form-row"><label>相较现有代码新增的不可恢复上下文 (Knowledge Delta) *</label><textarea id="f-ed-delta" rows="3">' + esc(e.knowledge_delta) + '</textarea></div>' +
        '<div class="form-row"><label>原因依据 (Rationale) *</label><textarea id="f-ed-rationale" rows="2">' + esc(e.rationale) + '</textarea></div>' +
        '<div class="form-row"><label>适用前置条件 (Preconditions · 每行一条) *</label><textarea id="f-ed-pre" rows="2">' + esc((e.preconditions || []).join('\\n')) + '</textarea></div>' +
        '<div class="form-row"><label>失效触发条件 (Invalidation Triggers · 每行一条) *</label><textarea id="f-ed-inv" rows="2">' + esc((e.invalidation_triggers || []).join('\\n')) + '</textarea></div>' +
        '<div class="form-row"><label>验证命令与方法（L1 纯文本锁定展示）</label><pre class="code-vault">' + esc(e.verification_method) + '</pre></div>' +
        '<div class="form-row"><label>本次修订性质 *</label>' +
          '<select id="f-ed-impact"><option value="substantive">实质结论或前置条件变更（重置成熟度为 draft）</option><option value="editorial">仅排版或错别字润色（保留当前成熟度）</option></select>' +
        '</div>';

      var impactSel = document.getElementById('f-ed-impact');
      impactSel.onchange = function() {
        document.getElementById('drw-s02-banner').style.display = impactSel.value === 'substantive' ? 'block' : 'none';
      };
    }

    function renderTabRawMd() {
      document.getElementById('drw-scroll').innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<span style="font-size:12px;color:var(--text-2);">本地磁盘权威真源格式（可直接纳入项目 Git PR 评审）</span>' +
          '<button class="btn btn-sm" id="btn-copy-md">复制 Markdown</button>' +
        '</div>' +
        '<pre class="code-vault" style="max-height:calc(100vh - 230px);">' + esc(data.rawMarkdown || '') + '</pre>';
      document.getElementById('btn-copy-md').onclick = function() {
        if (navigator.clipboard) navigator.clipboard.writeText(data.rawMarkdown || '');
        toast('已复制 Markdown 真源内容到剪贴板');
      };
    }

    function renderTabGeneAndVal() {
      var anchors = e.symbol_anchors || [];
      var vals = data.validations || [];
      document.getElementById('drw-scroll').innerHTML =
        '<div style="font-weight:650;margin-bottom:8px;">函数/类符号去空白逻辑指纹锚点 (symbol_anchors)</div>' +
        (anchors.length === 0
          ? '<div style="color:var(--text-3);margin-bottom:18px;font-size:12.5px;">当前条目使用路径 Glob 监听 (' + esc((e.watch_paths || []).join(', ') || '无') + ')。</div>'
          : anchors.map(function(a) {
              return '<div style="padding:10px 12px;background:var(--bg-elev-1);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:10px;">' +
                '<div><strong>' + esc(a.symbol_name) + '</strong> · <code>' + esc(a.file_path + '#L' + a.start_line + '-L' + a.end_line) + '</code></div>' +
                '<div class="mono" style="font-size:11px;color:var(--text-3);margin-top:4px;">SHA256: ' + esc(a.normalized_sha256) + '</div></div>';
            }).join('')) +
        '<div style="font-weight:650;margin:18px 0 8px;">跨任务独立验证账本 (引用次数不计入此表)</div>' +
        (vals.length === 0
          ? '<div style="color:var(--text-3);font-size:12.5px;">尚无跨会话独立验证记录。</div>'
          : vals.map(function(v) {
              var cls = v.outcome === 'success' ? 'm4-ok' : 'm4-err';
              return '<div style="padding:10px 12px;background:var(--bg-elev-1);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:8px;">' +
                '<span class="m4-cell ' + cls + '" style="border-radius:4px;">' + esc(v.outcome.toUpperCase()) + '</span> ' +
                '<code style="font-size:11.5px;margin-left:6px;">task:' + esc(v.task_fingerprint) + '</code>' +
                '<div style="margin-top:5px;color:var(--text-2);font-size:12.5px;">' + esc(v.evidence_note) + '</div></div>';
            }).join(''));
    }

    document.querySelectorAll('.d-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-dtab') === 'edit');
      btn.onclick = function() {
        document.querySelectorAll('.d-tab').forEach(function(b) { b.classList.toggle('active', b === btn); });
        var mode = btn.getAttribute('data-dtab');
        if (mode === 'edit') renderTabEdit();
        else if (mode === 'raw') renderTabRawMd();
        else renderTabGeneAndVal();
      };
    });

    renderTabEdit();

    var canExportSkill = e.maturity === 'verified' || e.maturity === 'proven';
    document.getElementById('drw-foot').innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
        '<button class="btn btn-sm btn-emerald" id="drw-btn-val">✓ 登记独立验证</button>' +
        '<button class="btn btn-sm btn-crimson" id="drw-btn-s01">⚠ S01 反证熔断/撤回</button>' +
        (canExportSkill ? '<button class="btn btn-sm" id="drw-btn-skill">✦ 固化为 SKILL.md</button>' : '') +
      '</div>' +
      '<button class="btn btn-primary" id="drw-btn-save">保存新版本</button>';

    document.getElementById('drawer-backdrop').classList.add('open');

    document.getElementById('drw-btn-save').onclick = async function() {
      if (!document.getElementById('f-ed-title')) {
        document.querySelector('[data-dtab="edit"]').click();
      }
      var res = await rpc('accremind.kb.saveRevision', {
        id: e.id,
        revisionImpact: document.getElementById('f-ed-impact').value,
        patch: {
          title: document.getElementById('f-ed-title').value,
          search_aliases: document.getElementById('f-ed-aliases').value.split(',').map(function(s){return s.trim();}).filter(Boolean),
          claim: document.getElementById('f-ed-claim').value,
          knowledge_delta: document.getElementById('f-ed-delta').value,
          rationale: document.getElementById('f-ed-rationale').value,
          preconditions: document.getElementById('f-ed-pre').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
          invalidation_triggers: document.getElementById('f-ed-inv').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean)
        }
      });

      if (!res.ok) {
        var fieldMap = {
          title: 'f-ed-title',
          claim: 'f-ed-claim',
          knowledge_delta: 'f-ed-delta',
          rationale: 'f-ed-rationale',
          preconditions: 'f-ed-pre',
          invalidation_triggers: 'f-ed-inv'
        };
        document.getElementById('drw-s03-banner').innerHTML =
          '<div class="alert-box alert-s03"><strong>S03 门禁阻断 · 点击缺失项直接定位输入</strong>：<div style="margin-top:6px;display:grid;gap:4px;">' +
          res.missingFields.map(function(msg) {
            var key = msg.split(':')[0].trim();
            var targetInput = fieldMap[key] || 'f-ed-title';
            return '<div style="cursor:pointer;color:var(--accent);font-weight:600;" data-focus-id="' + targetInput + '">↳ ' + esc(msg) + ' [定位 ›]</div>';
          }).join('') + '</div></div>';
        return;
      }

      toast('已原子写入 Markdown 真源并升级至 r' + res.entry.revision);
      closeDrawer();
      await syncAll();
    };

    document.getElementById('drw-btn-val').onclick = function() {
      openDialog({
        title: '登记跨任务独立验证证据 (' + e.id + ')',
        inputLabel: '本次在哪个独立需求/测试中验证了该经验有效？ *',
        placeholder: '例如：在结算重构任务中运行 webhook-concurrency.spec.ts 验证并发无双入账',
        defaultValue: '在独立开发任务中复用该约束并通过回归测试验证',
        requireInput: true,
        confirmText: '提交正向验证',
        onConfirm: async function(note) {
          await rpc('accremind.feedback.submit', { id: e.id, kind: 'verified_effective', detail: note });
          toast('独立验证已入账，成熟度已重算');
          closeDrawer();
          await syncAll();
        }
      });
    };

    document.getElementById('drw-btn-s01').onclick = function() {
      openDialog({
        title: 'S01 反证熔断或撤回条目 (' + e.id + ')',
        level: 'S01',
        danger: true,
        inputLabel: '请填写该经验已失效或结论错误的证据依据 *',
        placeholder: '例如：升级 v3 SDK 后底层已内置自动字节序保护，原结论不再成立',
        requireInput: true,
        confirmText: '立即熔断暂停检索',
        onConfirm: async function(reason) {
          await rpc('accremind.feedback.submit', { id: e.id, kind: 'suspected_error', detail: reason });
          toast('已触发 S01 熔断，该条目 serving 已置为 suspended');
          closeDrawer();
          await syncAll();
        }
      });
    };

    if (canExportSkill) {
      document.getElementById('drw-btn-skill').onclick = function() {
        openDialog({
          title: '固化导出为 DSH 原生技能 (.dsh/skills/<slug>/SKILL.md)',
          inputLabel: '技能目录标识 (仅小写字母/数字/连字符) *',
          defaultValue: e.id.toLowerCase() + '-guard',
          requireInput: true,
          confirmText: '生成 SKILL.md',
          onConfirm: async function(slug) {
            var out = await rpc('accremind.gov.exportSkill', { id: e.id, skillSlug: slug });
            toast('已生成技能文件: ' + out.skillRelPath);
            closeDrawer();
            await syncAll();
          }
        });
      };
    }
  }

  function openCreateDrawer() {
    document.getElementById('drw-title').textContent = '捕获新工程暗物质经验 (强制 S03 增量门禁)';
    document.getElementById('drw-tabs').style.display = 'none';
    document.getElementById('drw-scroll').innerHTML =
      '<div id="cr-feedback"></div>' +
      '<div class="form-row"><label>中立场景问题 (Question · 不含答案暗示) *</label><input id="cr-q" placeholder="例如：分布式定时任务跨实例调度时如何避免重复对账？" /></div>' +
      '<div class="form-row"><label>仅看现有代码的基线答案 (Visible Baseline) *</label><input id="cr-base" placeholder="例如：代码仅展示了 @Cron 注解触发 reconcile()" /></div>' +
      '<div class="form-row"><label>代码外新增不可恢复上下文 (Dark-Matter Delta) *</label><textarea id="cr-delta" rows="2" placeholder="例如：K8s 滚动发布期间新旧 Pod 重叠存活 30s，无数据库租约锁曾导致双发对账单"></textarea></div>' +
      '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;">' +
        '<div class="form-row"><label>经验标题 *</label><input id="cr-title" placeholder="什么条件下需要注意什么" /></div>' +
        '<div class="form-row"><label>知识类型 *</label><select id="cr-type"><option value="pitfall">pitfall</option><option value="decision">decision</option><option value="guideline">guideline</option><option value="model">model</option><option value="process">process</option></select></div>' +
        '<div class="form-row"><label>缺失代价优先级 *</label><select id="cr-prio"><option value="P0">P0 严重事故</option><option value="P1" selected>P1 重复排障</option><option value="P2">P2 辅助理解</option></select></div>' +
      '</div>' +
      '<div class="form-row"><label>双语检索别名 (逗号分隔)</label><input id="cr-alias" placeholder="滚动发布双发, 定时任务防重, cron lease lock" /></div>' +
      '<div class="form-row"><label>可执行结论 (Claim) *</label><textarea id="cr-claim" rows="2"></textarea></div>' +
      '<div class="form-row"><label>适用前置条件 (每行一条) *</label><textarea id="cr-pre" rows="2"></textarea></div>' +
      '<div class="form-row"><label>失效触发条件 (每行一条) *</label><textarea id="cr-inv" rows="2"></textarea></div>' +
      '<div class="form-row"><label>证据仓库相对路径定位 (严禁 /Users/... 本机绝对路径) *</label><input id="cr-loc" placeholder="src/jobs/reconcile.job.ts#L15-L42" /></div>';

    document.getElementById('drw-foot').innerHTML =
      '<span style="font-size:12px;color:var(--text-3);">通过门禁后默认进入本机影子孵化舱，验证后迁入项目库</span>' +
      '<button class="btn btn-primary" id="btn-submit-capture">执行五路分流与入库</button>';

    document.getElementById('drawer-backdrop').classList.add('open');

    document.getElementById('btn-submit-capture').onclick = async function() {
      try {
        var resp = await fetch('/rpc', {
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
              priority: document.getElementById('cr-prio').value,
              polarity: 'avoid',
              search_aliases: document.getElementById('cr-alias').value.split(',').map(function(s){return s.trim();}).filter(Boolean),
              claim: document.getElementById('cr-claim').value,
              rationale: document.getElementById('cr-delta').value,
              preconditions: document.getElementById('cr-pre').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              invalidation_triggers: document.getElementById('cr-inv').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              file_locator: document.getElementById('cr-loc').value
            }
          })
        });
        var json = await resp.json();
        if (json.error) throw new Error(json.error);
        var out = json.result;
        if (out.downgradedReason) {
          document.getElementById('cr-feedback').innerHTML =
            '<div class="alert-box alert-s01"><strong>S03 门禁自动降级拦截 (' + esc(out.finalDisposition) + ')</strong>：<br/>' + esc(out.downgradedReason) + '</div>';
          await syncAll();
          return;
        }
        toast('捕获成功 → 已进入 ' + (out.persistedZone || out.finalDisposition));
        closeDrawer();
        await syncAll();
      } catch (err) {
        document.getElementById('cr-feedback').innerHTML = '<div class="alert-box alert-s01">' + esc(err.message) + '</div>';
      }
    };
  }

  function closeDrawer() {
    document.getElementById('drawer-backdrop').classList.remove('open');
  }

  function switchTab(tab) {
    STATE.tab = tab;
    document.querySelectorAll('.nav-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === tab);
    });
    ['kb', 'review', 'reactor', 'gov'].forEach(function(id) {
      document.getElementById('view-' + id).style.display = id === tab ? 'block' : 'none';
    });
    if (tab === 'reactor') runCompilerReactor();
  }

  // Command Palette (Cmd+K / Ctrl+K)
  function openCommandPalette() {
    var mask = document.getElementById('cmdk-mask');
    var input = document.getElementById('cmdk-input');
    mask.classList.add('open');
    input.value = '';
    renderCmdkResults('');
    setTimeout(function() { input.focus(); }, 20);
  }

  function renderCmdkResults(q) {
    var lower = q.trim().toLowerCase();
    var cmds = [
      { label: '切换到：暗物质知识星图库', hint: 'Tab 1', run: function() { switchTab('kb'); } },
      { label: '切换到：增量分光镜审核台 (Delta Prism)', hint: 'Tab 2', run: function() { switchTab('review'); } },
      { label: '切换到：三层上下文编译反应堆 & JIT 护栏沙盒', hint: 'Tab 3', run: function() { switchTab('reactor'); } },
      { label: '切换到：符号基因时效巡检 & Git 考古时光机', hint: 'Tab 4', run: function() { switchTab('gov'); } },
      { label: '动作：＋ 捕获新工程暗物质经验', hint: 'Drawer', run: function() { openCreateDrawer(); } },
      { label: '动作：切换暗色黑曜石 / 亮色瑞士蓝图主题', hint: 'Theme', run: function() { toggleTheme(); } },
      { label: '动作：从双层 Markdown 真源全量无损重建 SQLite 索引', hint: 'Rebuild', run: async function() { await rpc('accremind.gov.rebuildIndex', {}); toast('SQLite 索引重建完成'); await syncAll(); } },
      { label: '图例：查看四维正交状态矩阵规范 (L6 禁百分比)', hint: 'Legend', run: function() { show4dLegendModal(); } }
    ];

    (STATE.kbItems || []).forEach(function(hit) {
      var e = hit.entry;
      cmds.push({
        label: '经验 ' + e.id + ' · ' + e.title,
        hint: (e.search_aliases || []).slice(0, 2).join(', ') || e.type,
        run: function() { openEntryDrawer(e.id); }
      });
    });

    var filtered = cmds.filter(function(c) {
      if (!lower) return true;
      return c.label.toLowerCase().indexOf(lower) !== -1 || (c.hint && c.hint.toLowerCase().indexOf(lower) !== -1);
    });

    var listEl = document.getElementById('cmdk-list');
    listEl.innerHTML = filtered.slice(0, 12).map(function(c, idx) {
      return '<div class="cmdk-item" data-cmdk-idx="' + idx + '">' +
        '<span>' + esc(c.label) + '</span><span class="kbd">' + esc(c.hint) + '</span></div>';
    }).join('');

    listEl.querySelectorAll('[data-cmdk-idx]').forEach(function(el) {
      el.onclick = function() {
        var item = filtered[Number(el.getAttribute('data-cmdk-idx'))];
        document.getElementById('cmdk-mask').classList.remove('open');
        if (item) item.run();
      };
    });
  }

  function toggleTheme() {
    STATE.theme = STATE.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', STATE.theme);
    localStorage.setItem('accremind_theme', STATE.theme);
    document.getElementById('btn-theme').textContent = STATE.theme === 'dark' ? '☀ 亮色蓝图' : '☾ 暗色观测';
  }

  async function syncAll() {
    await refreshDashboard();
    await loadVault();
    await loadPrismReview();
    await loadGovernance();
  }

  // Global Event Delegation
  document.addEventListener('click', async function(ev) {
    var navBtn = ev.target.closest('[data-nav]');
    if (navBtn) { switchTab(navBtn.getAttribute('data-nav')); return; }

    var detailTrigger = ev.target.closest('[data-detail]');
    if (detailTrigger) { await openEntryDrawer(detailTrigger.getAttribute('data-detail')); return; }

    var legendTrigger = ev.target.closest('[data-open-legend]');
    if (legendTrigger) { show4dLegendModal(); return; }

    var promoteBtn = ev.target.closest('[data-promote]');
    if (promoteBtn) {
      var pid = promoteBtn.getAttribute('data-promote');
      await rpc('accremind.probation.decide', { id: pid, action: 'promote' });
      toast('⚡ 已将 ' + pid + ' 淬炼转正并原子迁入项目 .accremind/entries/');
      await syncAll();
      return;
    }

    var seedNow = ev.target.closest('[data-seed-now]');
    if (seedNow) {
      await rpc('accremind.demo.seed', {});
      toast('✦ 已注入 4 条工程暗物质样本与 1 条待审分光镜候选');
      await syncAll();
      return;
    }

    var openCreate = ev.target.closest('[data-open-create]');
    if (openCreate) { openCreateDrawer(); return; }

    var revBtn = ev.target.closest('[data-rev-decide]');
    if (revBtn) {
      var caId = revBtn.getAttribute('data-ca');
      var dec = revBtn.getAttribute('data-rev-decide');
      var res = await rpc('accremind.review.decide', { assessmentId: caId, decision: dec });
      if (!res.ok) {
        openDialog({
          title: 'S03 门禁阻断',
          bodyHtml: '<div class="alert-box alert-s01">' + (res.missingFields || []).map(esc).join('<br/>') + '</div>'
        });
        return;
      }
      toast('分光镜裁决已完成：' + dec);
      await syncAll();
      return;
    }

    var freshBtn = ev.target.closest('[data-fresh-confirm]');
    if (freshBtn) {
      await rpc('accremind.gov.confirmFresh', { id: freshBtn.getAttribute('data-fresh-confirm') });
      toast('✓ 已刷新复核检查点，恢复为 current 状态');
      await syncAll();
      return;
    }

    var focusJump = ev.target.closest('[data-focus-id]');
    if (focusJump) {
      var targetEl = document.getElementById(focusJump.getAttribute('data-focus-id'));
      if (targetEl) { targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); targetEl.focus(); }
      return;
    }

    var presetBtn = ev.target.closest('[data-sim-preset]');
    if (presetBtn) {
      var p = presetBtn.getAttribute('data-sim-preset');
      if (p === '1') {
        document.getElementById('sim-prompt').value = '怎么防止支付回调并发造成重复扣款？';
        document.getElementById('sim-active-file').value = '';
        document.getElementById('sim-jit-file').value = 'src/payment/webhook.ts';
      } else if (p === '2') {
        document.getElementById('sim-prompt').value = '帮我重构一下账务结算模块代码结构';
        document.getElementById('sim-active-file').value = '';
        document.getElementById('sim-jit-file').value = 'src/payment/webhook.ts';
      } else {
        document.getElementById('sim-prompt').value = '为什么预发环境用户退出登录会报 CROSSSLOT？';
        document.getElementById('sim-active-file').value = 'src/auth/session-cache.ts';
        document.getElementById('sim-jit-file').value = '';
      }
      await runCompilerReactor();
      return;
    }

    var layerTile = ev.target.closest('[data-filter-shortcut]');
    if (layerTile) {
      var kind = layerTile.getAttribute('data-filter-shortcut');
      switchTab(kind === 'nav' ? 'review' : 'kb');
      if (kind === 'probation') {
        document.getElementById('flt-status').value = 'probation';
        await loadVault();
      } else if (kind === 'active') {
        document.getElementById('flt-status').value = 'active';
        await loadVault();
      }
      return;
    }
  });

  // Top & Filter Bindings
  document.getElementById('btn-theme').textContent = STATE.theme === 'dark' ? '☀ 亮色蓝图' : '☾ 暗色观测';
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-cmdk').onclick = openCommandPalette;
  document.getElementById('btn-new-entry').onclick = openCreateDrawer;
  document.getElementById('drw-close').onclick = closeDrawer;
  document.getElementById('drawer-backdrop').onclick = function(e) { if (e.target.id === 'drawer-backdrop') closeDrawer(); };
  document.getElementById('cmdk-mask').onclick = function(e) { if (e.target.id === 'cmdk-mask') e.target.classList.remove('open'); };
  document.getElementById('dialog-mask').onclick = function(e) { if (e.target.id === 'dialog-mask') e.target.classList.remove('open'); };
  document.getElementById('cmdk-input').oninput = function(e) { renderCmdkResults(e.target.value); };

  document.getElementById('btn-demo-toggle').onclick = async function() {
    var seeded = document.getElementById('btn-demo-toggle').getAttribute('data-seeded') === '1';
    if (seeded) {
      await rpc('accremind.demo.clear', {});
      toast('已清理全部演示样本，恢复空白工作区');
    } else {
      await rpc('accremind.demo.seed', {});
      toast('✦ 已注入 4 条演示样本与分光镜待审队列');
    }
    await syncAll();
  };

  document.getElementById('flt-q').oninput = function() { loadVault(); };
  document.getElementById('flt-status').onchange = function() { loadVault(); };
  document.getElementById('flt-type').onchange = function() { loadVault(); };

  document.querySelectorAll('[data-view-mode]').forEach(function(btn) {
    btn.onclick = function() {
      STATE.viewMode = btn.getAttribute('data-view-mode');
      document.querySelectorAll('[data-view-mode]').forEach(function(b) { b.classList.toggle('active', b === btn); });
      renderVaultItems();
    };
  });

  document.getElementById('btn-run-reactor').onclick = runCompilerReactor;
  document.getElementById('btn-gov-scan').onclick = async function() {
    await loadGovernance();
    await refreshDashboard();
    toast('符号级 Git 时效巡检已完成');
  };
  document.getElementById('btn-gov-rebuild').onclick = async function() {
    var out = await rpc('accremind.gov.rebuildIndex', {});
    document.getElementById('rebuild-status').textContent =
      '✓ 重建成功：从双层 Markdown 真源无损同步 ' + out.syncedCount + ' 张卡片（隔离冲突 ' + out.corruptedCount + ' 个）。';
    toast('SQLite FTS5 派生索引已重建');
    await syncAll();
  };
  document.getElementById('btn-gov-arch').onclick = async function() {
    var out = await rpc('accremind.gov.bootstrapHistory', { topK: 10 });
    var wrap = document.getElementById('arch-timeline-host');
    if (!out.minedCommits || out.minedCommits.length === 0) {
      wrap.innerHTML = '<div style="color:var(--text-3);padding:10px 0;">当前 Git 仓库最近历史未检出得分 ≥ 3 的 revert / hotfix / race 返工簇提交。</div>';
      return;
    }
    wrap.innerHTML = out.minedCommits.map(function(c) {
      return '<div style="padding:14px 16px;background:var(--bg-elev-2);border:1px solid var(--border-subtle);border-radius:10px;margin-bottom:10px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
          '<div><code style="color:var(--accent);font-weight:700;">' + esc(c.commitSha.slice(0, 8)) + '</code> <strong style="margin-left:8px;">' + esc(c.subject) + '</strong></div>' +
          '<span class="tag tag-p0">信号强度 ' + esc(c.signalScore) + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">触发依据：' + esc(c.signalReasons.join(' · ')) + '</div>' +
        '<pre class="code-vault" style="max-height:140px;">' + esc(c.diffPreview.slice(0, 900)) + '</pre>' +
      '</div>';
    }).join('');
  };

  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.key === 'Escape') {
      closeDrawer();
      document.getElementById('cmdk-mask').classList.remove('open');
      document.getElementById('dialog-mask').classList.remove('open');
      return;
    }
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
      e.preventDefault();
      switchTab('kb');
      document.getElementById('flt-q').focus();
    }
  });

  syncAll().catch(function(err) { toast(err.message); });
})();
`;
