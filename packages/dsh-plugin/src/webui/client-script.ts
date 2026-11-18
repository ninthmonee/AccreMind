import { WORKSPACE_CLIENT } from './workspace-client.ts';
import { WORKFLOW_CLIENT } from './workflow-client.ts';

export const ACCREMIND_OBSERVATORY_CLIENT_SCRIPT = `
(function() {
  var STATE = {
    tab: 'kb',
    demoToken: null,
    viewMode: 'cards',
    theme: 'dark',
    overview: null,
    kbItems: [],
    zeroReason: 'none',
    reviewItems: [],
    navItems: [],
    staleData: null,
    archCommits: []
  };

  try { STATE.theme = localStorage.getItem('accremind_theme') || 'dark'; } catch { /* isolated host frame */ }
  try {
    var savedMode = localStorage.getItem('accremind_library_view');
    if (['cards','table','summary'].includes(savedMode)) STATE.viewMode = savedMode;
  } catch { /* embedded host without persistent preferences */ }
  document.documentElement.setAttribute('data-theme', STATE.theme);

  async function rpc(method, params) {
    activeCalls++;
    try {
      if (STATE.demoToken) return await hostRpc('accremind.demo.call', {token:STATE.demoToken,method:method,params:params || {}});
      return await hostRpc(method, params);
    } finally { activeCalls--; }
  }

  async function hostRpc(method, params) {
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
      levelBanner = '<div class="alert-box alert-s01">提交后会立即暂停该经验的自动检索。</div>';
    }

    box.innerHTML =
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">' +
        '<strong id="dialog-title" style="font-size:15px;">' + esc(opts.title) + '</strong>' +
        '<button class="btn btn-sm" id="dlg-x">✕</button>' +
      '</div>' +
      '<div style="padding:18px 20px;">' +
        levelBanner +
        (opts.bodyHtml || '') +
        (opts.inputLabel
          ? '<div class="form-row" style="margin-top:10px;"><label for="dlg-input">' + esc(opts.inputLabel) + '</label>' +
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

    var opener = document.activeElement;
    mask.classList.add('open');
    var close = function() { mask.classList.remove('open'); if (opener && opener.isConnected) opener.focus(); };
    (box.querySelector('input,textarea') || document.getElementById('dlg-cancel')).focus();
    document.getElementById('dlg-x').onclick = close;
    document.getElementById('dlg-cancel').onclick = close;

    var okBtn = document.getElementById('dlg-ok');
    if (okBtn && opts.onConfirm) {
      okBtn.onclick = async function() {
        if (okBtn.disabled) return;
        var val = opts.inputLabel ? document.getElementById('dlg-input').value.trim() : '';
        if (opts.requireInput && !val) {
          document.getElementById('dlg-err').innerHTML = '<div class="alert-box alert-s01">请填写必填说明后再继续</div>';
          return;
        }
        try {
          okBtn.disabled = true;
          await opts.onConfirm(val);
          close();
        } catch (err) {
          document.getElementById('dlg-err').innerHTML = '<div class="alert-box alert-s01">' + esc(err.message) + '</div>';
        } finally { okBtn.disabled = false; }
      };
    }
  }

  ${WORKSPACE_CLIENT}

  function show4dLegendModal() {
    openDialog({
      title: '如何阅读经验状态',
      bodyHtml: '<div class="state-guide"><p><strong>确认状态</strong>表示经验处于候选、本机试用、正式、撤回或归档阶段。</p>' +
        '<p><strong>成熟度</strong>记录独立任务的验证结果。一次有效为“已验证”，两次及以上有效且无反证为“多任务证实”。</p>' +
        '<p><strong>时效</strong>表示经验是否适用于当前代码与依赖。遇到变更时，进入治理页核对差异。</p>' +
        '<p><strong>检索开关</strong>决定是否向开发任务推荐该经验。收到反证后暂停，经处理后可恢复。</p></div>'
    });
  }

  function render4dMatrix(e) {
    var stCls = e.status === 'active' ? 'm4-ok' : e.status === 'probation' ? 'm4-prob' : 'm4-err';
    var matCls = e.maturity === 'proven' || e.maturity === 'verified' ? 'm4-ok' : '';
    var frCls = e.freshness === 'current' ? '' : 'm4-warn';
    var svCls = e.serving === 'suspended' ? 'm4-err' : 'm4-ok';
    var names = {candidate:'候选',active:'已确认',probation:'试用中',withdrawn:'已撤回',archived:'已归档',draft:'待验证',verified:'已验证',proven:'多任务证实',current:'当前适用',review_due:'待复核',stale:'已失效',enabled:'检索开',suspended:'检索暂停'};
    var chips = [[e.status,stCls,'确认'],[e.maturity,matCls,'成熟度'],[e.freshness,frCls,'时效'],[e.serving,svCls,'检索']];
    return '<button class="matrix-4d" data-open-legend="1" aria-label="查看状态说明">' + chips.map(function(c) {
      return '<span class="m4-cell ' + c[1] + '" title="' + esc(c[2] + ' · ' + c[0]) + '">' + esc(names[c[0]] || c[0]) + '</span>';
    }).join('') + '</button>';
  }

  function renderProbationPips(exposures, maxExp) {
    var max = maxExp || 3;
    var pips = '';
    for (var i = 0; i < max; i++) {
      pips += '<span class="pip ' + (i < exposures ? 'used' : '') + '"></span>';
    }
    return '<span class="pip-meter" title="影子孵化剩余曝光寿命 (' + exposures + '/' + max + ' 次无反馈自动归档)">' + pips + ' 曝光 ' + exposures + '/' + max + '</span>';
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

    var workspaceLabel = document.getElementById('hud-ws');
    workspaceLabel.textContent = STATE.demoToken ? '演示工作区' : (ov.projectName || ov.workspaceId);
    workspaceLabel.title = ov.projectDir;


    document.getElementById('cnt-kb').textContent = ov.counts.totalEntries;
    document.getElementById('cnt-rev').textContent = ov.counts.pendingReviewCount;
    document.getElementById('cnt-gov').title = '需核对的经验和异常文件';
    document.getElementById('cnt-gov').textContent = ov.counts.governanceQueueCount;

    document.getElementById('m-active').textContent = ov.counts.activeCount;
    document.getElementById('m-suspended').textContent = ov.counts.suspendedCount;
    document.getElementById('m-ver').textContent = ov.counts.verifiedOrProvenCount;
    document.getElementById('m-stale').textContent = ov.counts.reviewDueCount;

    document.getElementById('lt-rules').textContent = ov.counts.rulesCount;
    document.getElementById('lt-proj').textContent = ov.counts.projectActiveCount;
    document.getElementById('lt-prob').textContent = ov.counts.probationCount;
    document.getElementById('lt-nav').textContent = ov.counts.navigationItemsCount;

    document.getElementById('overview-total').textContent = ov.counts.totalEntries + ' 条经验';
    document.getElementById('demo-label').textContent = STATE.demoToken ? '返回我的工作区' : '体验示例';
    document.getElementById('demo-banner').hidden = !STATE.demoToken;
    showNextTask(ov.counts);
  }

  async function loadVault() {
    var request = ++vaultRequest;
    var params = {adminView:true};
    var query = document.getElementById('flt-q').value.trim();
    if (query) params.query = query;
    Object.entries(filterFields).forEach(function(pair) {
      var value = document.getElementById('flt-' + pair[0]).value;
      if (value) params[pair[1]] = value;
    });
    var res = await rpc('accremind.kb.list', params);
    if (request !== vaultRequest) return;
    STATE.kbItems = res.items;
    STATE.zeroReason = res.zeroReason;
    renderScopes(res.scopeCounts || {}, params.layer || '');
    document.getElementById('vault-count').textContent = res.items.length + ' 条';
    var filtered = Object.keys(params).length > 1;
    document.getElementById('clear-filters').hidden = !filtered;
    if (!filtered) {
      STATE.allItems = res.items;
      document.getElementById('constellation-svg-slot').innerHTML = renderConstellationSvg(STATE.allItems);
    }
    renderVaultItems();
  }

  function renderVaultItems() {
    var host = document.getElementById('vault-host');
    var items = STATE.kbItems;
    if (items.length && STATE.viewMode === 'summary') { renderKnowledgeSummary(host, items); return; }

    if (!items || items.length === 0) {
      var empty = !STATE.overview || !STATE.overview.counts.totalEntries;
      host.innerHTML = '<div class="empty-observatory"><h3>' + (empty ? '这里将显示已录入的经验' : '没有符合当前条件的经验') + '</h3><p>' +
        (empty ? '扫描仓库历史，或直接记录一条有证据的项目约束。' : '可清除筛选，或改用条目编号、其他别名重新搜索。') +
        '</p><div class="action-row">' + (empty ? '<button class="btn" data-open-create>手动录入经验</button>' :
        button('reset','清除全部筛选',false)) + '</div></div>';
      return;
    }

    function titleButton(e) {
      return '<button type="button" class="vc-title knowledge-title" data-detail="' + esc(e.id) + '">' + esc(e.title) + '</button>';
    }
    function promoteButton(e) {
      return e.status === 'probation' ? '<button class="btn btn-sm btn-emerald" data-promote="' + esc(e.id) + '">转为正式</button>' : '';
    }
    function reference(e) {
      var first = (e.evidence || []).find(function(item) { return item.locator || item.source_ref; });
      if (!first) return '';
      var locator = first.locator || first.source_ref;
      return '<code class="knowledge-evidence" title="' + esc(locator + (first.summary ? ' · ' + first.summary : '')) + '">' +
        esc(locator.replace(/\\b[0-9a-f]{40}\\b/gi, function(sha) { return sha.slice(0,8); })) + '</code>';
    }

    var presentations = items.map(function(hit) {
      var e = hit.entry;
      var summary = knowledgeSummary(e);
      return {entry:e, type:knowledgeTypeLabel(e.type), scope:knowledgeScopeLabel(hit.storageZone, e.layer),
        claim:e.claim || '', conditions:(e.preconditions || []).filter(Boolean).join('；'),
        summary:summary && summary !== e.claim && summary !== e.title ? summary : '',
        contextLabel:e.knowledge_delta ? '知识增量' : '依据', reference:reference(e), exposures:hit.probationExposures || 0};
    });

    if (STATE.viewMode === 'table') {
      var rows = presentations.map(function(v) {
        var e = v.entry;
        return '<tr data-entry-id="' + esc(e.id) + '">' +
          '<th scope="row">' + titleButton(e) + '<small class="knowledge-meta">' + esc(e.id + '@r' + e.revision + ' · ' + e.priority) + '</small></th>' +
          '<td>' + esc(v.type) + '</td><td>' + esc(v.scope) + '</td>' +
          '<td class="knowledge-cell-claim">' + esc(v.claim || '待补充') + '</td>' +
          '<td>' + esc(v.conditions || '未记录') + '</td>' +
          '<td>' + (v.summary ? esc(v.summary) : v.reference || '—') + '</td>' +
          '<td>' + render4dMatrix(e) + (e.status === 'probation' ? '<div>' + promoteButton(e) + '</div>' : '') + '</td></tr>';
      }).join('');
      host.innerHTML = '<div class="glass-panel table-scroll" role="region" tabindex="0" aria-label="知识条目表，可横向滚动">' +
        '<table class="data-tbl knowledge-table"><thead><tr>' +
        ['知识条目','知识类型','知识归属','核心结论','适用条件','增量或依据','状态'].map(function(label) {
          return '<th scope="col">' + label + '</th>';
        }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      return;
    }

    var maxExp = STATE.overview ? STATE.overview.maxProbationExposures : 3;
    host.innerHTML = '<div class="vault-grid">' + presentations.map(function(v) {
      var e = v.entry;
      return '<article class="vault-card knowledge-card" data-entry-id="' + esc(e.id) + '">' +
        '<div class="vc-top knowledge-meta"><span class="tag tag-type">' + esc(v.type) + '</span><span>' + esc(v.scope) + '</span>' +
        '<code>' + esc(e.id + '@r' + e.revision) + '</code><small title="遗漏代价优先级">' + esc(e.priority) + '</small></div>' +
        '<h3>' + titleButton(e) + '</h3><p class="knowledge-claim">' + esc(v.claim || '待补充核心结论') + '</p>' +
        '<dl class="knowledge-facts"><div class="knowledge-fact"><dt>适用条件</dt><dd>' + esc(v.conditions || '未记录') + '</dd></div>' +
        (v.summary ? '<div class="knowledge-fact"><dt>' + v.contextLabel + '</dt><dd>' + esc(v.summary) + '</dd></div>' : '') +
        (v.reference ? '<div class="knowledge-fact"><dt>证据</dt><dd>' + v.reference + '</dd></div>' : '') + '</dl>' +
        '<div class="vc-foot">' + render4dMatrix(e) +
        (e.status === 'probation' ? renderProbationPips(v.exposures, maxExp) + promoteButton(e) : '') +
        '</div></article>';
    }).join('') + '</div>';
  }

  ${WORKFLOW_CLIENT}

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

  async function openEntryDrawer(id, initialTab) {
    var data = await rpc('accremind.kb.get', { id: id });
    if (!data.found) { toast('未找到条目 ' + id); return; }
    var e = data.entry;

    document.getElementById('drw-title').innerHTML =
      '<code style="color:var(--accent);">' + esc(e.id) + '@r' + esc(e.revision) + '</code> · ' + esc(e.title);

    var drawerTabs = document.getElementById('drw-tabs');
    drawerTabs.style.display = 'flex';

    var fields = {
      title: ['f-ed-title', '标题'], search_aliases: ['f-ed-aliases', '检索别名', ','],
      claim: ['f-ed-claim', '核心结论'], knowledge_delta: ['f-ed-delta', '知识增量'],
      rationale: ['f-ed-rationale', '原因依据'], preconditions: ['f-ed-pre', '前置条件', '\\n'],
      invalidation_triggers: ['f-ed-inv', '失效条件', '\\n']
    };
    var editableScope = e.layer === 'domain' || e.layer === 'project';
    if (editableScope) fields.layer = ['f-ed-layer', '知识归属'];
    var draftKey = (STATE.overview ? STATE.overview.projectDir : '') + '/' + e.id + '@r' + e.revision;
    var prior = entryDrafts.get(draftKey);
    var draft = Object.assign({}, e, prior ? prior.draft : {});
    var impact = prior ? prior.impact : 'substantive';

    function changedKeys() {
      return Object.keys(fields).filter(function(k) { return JSON.stringify(e[k]) !== JSON.stringify(draft[k]); });
    }
    function scopeLabel(layer) { return knowledgeScopeLabel(data.storageZone, layer); }
    function changeValue(key, value) {
      if (key === 'layer') return scopeLabel(value);
      return Array.isArray(value) ? value.join('；') : String(value);
    }
    function renderChanges() {
      var keys = changedKeys();
      var save = document.getElementById('drw-btn-save');
      if (save) save.disabled = keys.length === 0;
      var discard = document.getElementById('drw-btn-discard');
      if (discard) discard.hidden = keys.length === 0;
      if (keys.length) entryDrafts.set(draftKey, {draft:draft, impact:impact});
      else entryDrafts.delete(draftKey);
      var preview = document.getElementById('drw-change-preview');
      if (preview) preview.innerHTML = keys.length ? '<strong>待保存的修改</strong>' + keys.map(function(k) {
        return '<div>' + esc(fields[k][1]) + ' · <del>' + esc(changeValue(k,e[k])) + '</del> → <ins>' + esc(changeValue(k,draft[k])) + '</ins></div>';
      }).join('') : '';
      var scopeChanged = keys.includes('layer');
      var impactSelector = document.getElementById('f-ed-impact');
      if (impactSelector) {
        impactSelector.disabled = scopeChanged;
        impactSelector.value = scopeChanged ? 'substantive' : impact;
      }
      var warning = document.getElementById('drw-s02-banner');
      if (warning) warning.style.display = keys.length && (scopeChanged || impact === 'substantive') ? 'block' : 'none';
    }
    function renderTabEdit() {
      var summary = knowledgeSummary(e);
      var conditions = (e.preconditions || []).join('；');
      var sources = (e.evidence || []).filter(function(source) { return source.locator || source.source_ref; });
      document.getElementById('drw-scroll').innerHTML =
        '<section class="knowledge-detail-summary" aria-label="已保存的知识内容"><div class="knowledge-meta">' +
          '<span class="tag tag-type">' + esc(knowledgeTypeLabel(e.type)) + '</span> ' + esc(scopeLabel(e.layer)) + '</div>' +
          '<p class="knowledge-claim">' + esc(e.claim || '待补充核心结论') + '</p>' +
          '<dl class="knowledge-facts"><div class="knowledge-fact"><dt>适用条件</dt><dd>' + esc(conditions || '未记录') + '</dd></div>' +
          (summary && summary !== e.claim && summary !== e.title ? '<div class="knowledge-fact"><dt>' +
            (e.knowledge_delta ? '知识增量' : '依据') + '</dt><dd>' + esc(summary) + '</dd></div>' : '') +
          (sources.length ? '<div class="knowledge-fact"><dt>证据</dt><dd>' + sources.map(function(source) {
            return '<div><code class="knowledge-evidence">' + esc(source.locator || source.source_ref) + '</code>' +
              (source.summary ? ' · ' + esc(source.summary) : '') + '</div>';
          }).join('') + '</dd></div>' : '') +
          '</dl>' + render4dMatrix(e) + '</section>' +
        '<h3>修订内容</h3>' +
        '<div id="drw-s03-banner"></div><div id="drw-change-preview" aria-live="polite"></div>' +
        '<div id="drw-s02-banner" class="alert-box alert-s02">此次为实质修订。保存后生成 <code>r' + (e.revision + 1) + '</code>，成熟度回到待验证。</div>' +
        '<div class="form-row"><label for="f-ed-title">标题 *</label><div class="form-hint">一句话写清适用条件和要点。</div><input id="f-ed-title" value="' + esc(e.title) + '" /></div>' +
        (editableScope ? '<div class="form-row"><label for="f-ed-layer">知识归属</label><select id="f-ed-layer">' +
          '<option value="domain">' + esc(scopeLabel('domain')) + '</option><option value="project">' + esc(scopeLabel('project')) +
          '</option></select><div class="form-hint">更改归属按实质修订保存。</div></div>' : '') +
        '<div class="form-row"><label for="f-ed-aliases">搜索别名</label><div class="form-hint">可填写业务叫法和代码标识，用逗号分隔。</div><input id="f-ed-aliases" value="' + esc((e.search_aliases || []).join(', ')) + '" /></div>' +
        '<div class="form-row"><label for="f-ed-claim">核心结论 *</label><textarea id="f-ed-claim" rows="3">' + esc(e.claim) + '</textarea></div>' +
        '<div class="form-row"><label for="f-ed-delta">代码或文档之外的知识增量 *</label><textarea id="f-ed-delta" rows="3">' + esc(e.knowledge_delta) + '</textarea></div>' +
        '<div class="form-row"><label for="f-ed-rationale">结论依据 *</label><textarea id="f-ed-rationale" rows="2">' + esc(e.rationale) + '</textarea></div>' +
        '<div class="form-row"><label for="f-ed-pre">适用条件（每行一条）*</label><textarea id="f-ed-pre" rows="2">' + esc((e.preconditions || []).join('\\n')) + '</textarea></div>' +
        '<div class="form-row"><label for="f-ed-inv">哪些变化会使结论失效（每行一条）*</label><textarea id="f-ed-inv" rows="2">' + esc((e.invalidation_triggers || []).join('\\n')) + '</textarea></div>' +
        '<div class="form-row"><label>验证方法</label><pre class="code-vault">' + esc(e.verification_method) + '</pre></div>' +
        '<div class="form-row"><label for="f-ed-impact">本次修订性质 *</label>' +
          '<select id="f-ed-impact"><option value="substantive">结论或适用条件有变（回到待验证）</option><option value="editorial">仅排版或错别字润色（保留当前成熟度）</option></select>' +
        '</div>';

      Object.keys(fields).forEach(function(k) {
        var spec = fields[k], input = document.getElementById(spec[0]);
        input.value = spec[2] ? draft[k].join(spec[2] === ',' ? ', ' : spec[2]) : draft[k];
        input.oninput = function() {
          draft[k] = spec[2] ? input.value.split(spec[2]).map(function(v) { return v.trim(); }).filter(Boolean) : input.value;
          renderChanges();
        };
      });
      var impactSel = document.getElementById('f-ed-impact');
      impactSel.value = impact;
      impactSel.onchange = function() { impact = impactSel.value; renderChanges(); };
      renderChanges();
    }

    function renderTabRawMd() {
      document.getElementById('drw-scroll').innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<span style="font-size:12px;color:var(--text-2);">此修订保存的 Markdown 内容</span>' +
          '<button class="btn btn-sm" id="btn-copy-md">复制 Markdown</button>' +
        '</div>' +
        '<pre id="entry-markdown" tabindex="0" class="code-vault" style="max-height:calc(100vh - 230px);">' + esc(data.rawMarkdown || '') + '</pre>';
      document.getElementById('btn-copy-md').onclick = async function() {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(data.rawMarkdown || '');
            toast('已复制 Markdown');
            return;
          }
        } catch { /* Embedded pages may not have clipboard permission. */ }
        var pre = document.getElementById('entry-markdown');
        var selection = window.getSelection();
        if (pre && selection) {
          pre.focus();
          var range = document.createRange();
          range.selectNodeContents(pre);
          selection.removeAllRanges();
          selection.addRange(range);
          toast('已选中 Markdown，请按系统复制快捷键');
        } else {
          toast('当前窗口无法访问剪贴板，请手动选中原文复制');
        }
      };
    }

    function renderTabGeneAndVal() {
      var anchors = e.symbol_anchors || [];
      var vals = data.validations || [];
      document.getElementById('drw-scroll').innerHTML =
        '<div style="font-weight:650;margin-bottom:8px;">关联的函数与类</div>' +
        (anchors.length === 0
          ? '<div style="color:var(--text-3);margin-bottom:18px;font-size:12.5px;">当前条目使用路径 Glob 监听 (' + esc((e.watch_paths || []).join(', ') || '无') + ')。</div>'
          : anchors.map(function(a, index) {
              return '<div style="padding:10px 12px;background:var(--bg-elev-1);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:10px;">' +
                '<div><strong>' + esc(a.symbol_name) + '</strong> · <code>' + esc(a.file_path + '#L' + a.start_line + '-L' + a.end_line) + '</code></div>' +
                '<div class="mono" style="font-size:11px;color:var(--text-3);margin-top:4px;">SHA256: ' + esc(a.normalized_sha256) + '</div>' +
                '<button class="btn btn-sm" data-read-anchor="' + index + '">查看源码</button> ' +
                '<button class="btn btn-sm" data-rebind="' + index + '">重新绑定代码锚点</button></div>';
            }).join('')) +
        '<div style="font-weight:650;margin:18px 0 8px;">独立任务的验证记录</div>' +
        (vals.length === 0
          ? '<div style="color:var(--text-3);font-size:12.5px;">尚无跨会话独立验证记录。</div>'
          : vals.map(function(v) {
              var cls = v.outcome === 'success' ? 'm4-ok' : 'm4-err';
              return '<div style="padding:10px 12px;background:var(--bg-elev-1);border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:8px;">' +
                '<span class="m4-cell ' + cls + '" style="border-radius:4px;">' + esc(v.outcome.toUpperCase()) + '</span> ' +
                '<code style="font-size:11.5px;margin-left:6px;">r' + esc(v.revision) + ' · ' + esc(v.task_fingerprint) + '</code>' +
                '<div style="margin-top:5px;color:var(--text-2);font-size:12.5px;">' + esc(v.evidence_note) + '</div></div>';
            }).join(''));
      document.querySelectorAll('[data-read-anchor]').forEach(function(btn) {
        btn.onclick = async function() {
          var anchor = anchors[Number(btn.getAttribute('data-read-anchor'))];
          try {
            var source = await rpc('accremind.gov.readAnchor', {id:e.id, revision:e.revision, filePath:anchor.file_path, symbolName:anchor.symbol_name});
            openDialog({title:anchor.symbol_name, bodyHtml:'<p><code>' + esc(anchor.file_path) + '#L' + esc(source.startLine) +
              '-L' + esc(source.endLine) + '</code></p><pre class="code-vault">' + esc(source.code) + '</pre>' +
              (source.truncated ? '<p>当前仅展示源码片段。</p>' : '')});
          } catch(err) { toast(err.message); }
        };
      });
      document.querySelectorAll('[data-rebind]').forEach(function(btn) {
        btn.onclick = function() {
          if (changedKeys().length) { toast('请先保存或丢弃本次修订，再变更锚点。'); return; }
          var anchor = anchors[Number(btn.getAttribute('data-rebind'))];
          openDialog({title:'重新绑定代码锚点', bodyHtml:'<p>保存后创建新修订，回到草稿并进入时效复核。检索状态保持为 ' + esc(e.serving) +
              '。</p><div class="form-row"><label for="rebind-file">仓库内相对路径</label><input id="rebind-file" value="' +
              esc(anchor.file_path) + '" /></div>',
            inputLabel:'目标函数或类的符号名', defaultValue:anchor.symbol_name, requireInput:true, confirmText:'核对代码并重新绑定',
            onConfirm:async function(symbol) {
              var path = document.getElementById('rebind-file').value.trim();
              if (!path) throw new Error('请填写仓库内的文件路径');
              await rpc('accremind.gov.rebindAnchor', {id:e.id, revision:e.revision, oldFilePath:anchor.file_path,
                oldSymbolName:anchor.symbol_name, filePath:path, symbolName:symbol});
              await syncAll();
              await openEntryDrawer(e.id, 'gene');
            }
          });
        };
      });
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

    var canExportSkill = e.status === 'active' && e.freshness === 'current' && e.serving === 'enabled' &&
      (e.maturity === 'verified' || e.maturity === 'proven');
    document.getElementById('drw-foot').innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
        '<button class="btn btn-sm btn-emerald" id="drw-btn-val">✓ 登记独立验证</button>' +
        '<button class="btn btn-sm btn-crimson" id="drw-btn-s01">登记反证并暂停检索</button>' +
        (canExportSkill ? '<button class="btn btn-sm" id="drw-btn-skill">✦ 固化为 SKILL.md</button>' : '') +
      '</div>' +
      '<button class="btn" id="drw-btn-discard" hidden>丢弃未保存修改</button><button class="btn btn-primary" id="drw-btn-save" disabled>保存新版本</button>';
    document.getElementById('drw-btn-discard').onclick = function() {
      draft = Object.assign({}, e);
      impact = 'substantive';
      document.querySelector('[data-dtab="edit"]').click();
    };
    renderChanges();
    if (initialTab === 'gene') document.querySelector('[data-dtab="gene"]').click();

    document.getElementById('drawer-backdrop').classList.add('open');

    document.getElementById('drw-btn-save').onclick = async function() {
      var keys = changedKeys();
      if (!keys.length) return;
      var patch = {};
      keys.forEach(function(k) { patch[k] = draft[k]; });
      var save = document.getElementById('drw-btn-save');
      save.disabled = true;
      var res;
      try {
        res = await rpc('accremind.kb.saveRevision', { id: e.id, expectedRevision: e.revision,
          revisionImpact: keys.includes('layer') ? 'substantive' : impact, patch: patch });
      } catch (err) {
        toast(err.message);
        renderChanges();
        return;
      }
      if (!res.ok) {
        document.querySelector('[data-dtab="edit"]').click();
        var fieldMap = {
          title: 'f-ed-title',
          claim: 'f-ed-claim',
          knowledge_delta: 'f-ed-delta',
          rationale: 'f-ed-rationale', layer: 'f-ed-layer',
          preconditions: 'f-ed-pre',
          invalidation_triggers: 'f-ed-inv'
        };
        document.getElementById('drw-s03-banner').innerHTML =
          '<div class="alert-box alert-s03"><strong>保存前请补齐以下内容</strong><div style="margin-top:6px;display:grid;gap:4px;">' +
          res.missingFields.map(function(msg) {
            var key = msg.split(':')[0].trim();
            var targetInput = fieldMap[key] || 'f-ed-title';
            return '<div style="cursor:pointer;color:var(--accent);font-weight:600;" data-focus-id="' + targetInput + '">↳ ' + esc(msg) + ' [定位 ›]</div>';
          }).join('') + '</div></div>';
        return;
      }

      entryDrafts.delete(draftKey);
      toast('已保存 r' + res.entry.revision);
      closeDrawer();
      await syncAll();
    };

    document.getElementById('drw-btn-val').onclick = function() {
      openDialog({
        title: '登记跨任务独立验证证据 (' + e.id + ')',
        inputLabel: '本次在哪个独立需求/测试中验证了该经验有效？ *',
        placeholder: '例如：在结算重构任务中运行 webhook-concurrency.spec.ts 验证并发无双入账',
        bodyHtml: '<div class="form-row"><label for="validation-task">独立任务或工单 ID *</label><input id="validation-task" placeholder="例如 BILL-238" /></div>',
        requireInput: true,
        confirmText: '提交正向验证',
        onConfirm: async function(note) {
          var task = document.getElementById('validation-task').value.trim();
          if (!task) throw new Error('请填写可追溯的任务或工单 ID');
          await rpc('accremind.feedback.submit', { id: e.id, revision: e.revision, taskFingerprint: task, kind: 'verified_effective', detail: note });
          toast('独立验证已入账，成熟度已重算');
          closeDrawer();
          await syncAll();
        }
      });
    };

    document.getElementById('drw-btn-s01').onclick = function() {
      openDialog({
        title: '登记反证并暂停检索 (' + e.id + ')',
        level: 'S01',
        danger: true,
        inputLabel: '请填写该经验已失效或结论错误的证据依据 *',
        placeholder: '例如：升级 v3 SDK 后底层已内置自动字节序保护，原结论不再成立',
        requireInput: true,
        confirmText: '暂停检索',
        onConfirm: async function(reason) {
          await rpc('accremind.feedback.submit', { id: e.id, revision: e.revision, kind: 'suspected_error', detail: reason });
          toast('已登记反证并暂停这条经验的检索');
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
    document.getElementById('drw-title').textContent = '记录研发经验';
    document.getElementById('drw-tabs').style.display = 'none';
    document.getElementById('drw-scroll').innerHTML =
      '<div id="cr-feedback" role="status"></div>' +
      '<div class="form-row"><label for="cr-layer">知识范围</label><select id="cr-layer"><option value="project">项目知识 · 本项目的实现与约束</option><option value="domain">领域知识 · 业务概念、规则与流程</option></select></div>' +
      '<div class="form-row"><label for="cr-route">代码与文档对这个问题的覆盖程度</label><select id="cr-route">' +
        '<option value="knowledge_candidate">有代码外新增经验</option><option value="index_only">代码已能回答，保存导航</option>' +
        '<option value="link_existing">已有权威文档，保存链接</option><option value="needs_confirmation">证据不足，提交待补</option>' +
        '<option value="discard">没有复用价值，记录丢弃原因</option></select></div>' +
      '<div class="form-row"><label for="cr-q">遇到了什么问题？ *</label><input id="cr-q" placeholder="例如：分布式定时任务跨实例调度时如何避免重复对账？" /></div>' +
      '<div class="form-row"><label for="cr-base">从当前代码或文档能知道什么？ *</label><input id="cr-base" placeholder="例如：代码仅展示了 @Cron 注解触发 reconcile()" /></div>' +
      '<div class="form-row"><label for="cr-delta">还有哪些经验无法从代码得知？ *</label><textarea id="cr-delta" rows="2" placeholder="例如：K8s 滚动发布期间新旧 Pod 重叠存活 30s，无数据库租约锁曾导致双发对账单"></textarea></div>' +
      '<div class="capture-fields">' +
        '<div class="form-row"><label for="cr-title">经验标题 *</label><input id="cr-title" placeholder="什么条件下需要注意什么" /></div>' +
        '<div class="form-row"><label for="cr-type">知识类型 *</label><select id="cr-type"><option value="pitfall">排障陷阱</option><option value="decision">架构决策</option><option value="guideline">规范</option><option value="model">领域模型</option><option value="process">操作流程</option></select></div>' +
        '<div class="form-row"><label for="cr-prio">忽略这条经验的代价 *</label><select id="cr-prio"><option value="P0">P0 严重事故</option><option value="P1" selected>P1 重复排障</option><option value="P2">P2 辅助理解</option></select></div>' +
      '</div>' +
      '<div class="form-row" hidden><label for="cr-polarity">规范方向</label><select id="cr-polarity"><option value="recommend">建议这样做</option><option value="avoid">禁止这样做</option></select></div>' +
      '<div class="form-row"><label for="cr-alias">搜索别名（中英文均可，逗号分隔）</label><input id="cr-alias" placeholder="滚动发布双发, 定时任务防重, cron lease lock" /></div>' +
      '<div class="form-row"><label for="cr-claim">遇到同样情况应该怎样做？ *</label><textarea id="cr-claim" rows="2"></textarea></div>' +
      '<div class="form-row"><label for="cr-pre">适用条件（每行一条）*</label><textarea id="cr-pre" rows="2"></textarea></div>' +
      '<div class="form-row"><label for="cr-inv">失效条件（每行一条）*</label><textarea id="cr-inv" rows="2"></textarea></div>' +
      '<div class="form-row"><label for="cr-method">如何验证这条结论 *</label><textarea id="cr-method" rows="2" placeholder="回归用例或可重复的检查方法"></textarea></div>' +
      '<div class="form-row"><label for="cr-note">证据内容 *</label><textarea id="cr-note" rows="2" placeholder="记录的现象、测试结果或文档结论"></textarea></div>' +
      '<div class="form-row"><label for="cr-loc">证据位置（仓库相对路径）*</label><input id="cr-loc" placeholder="src/jobs/reconcile.job.ts#L15-L42" /></div>';

    document.getElementById('drw-foot').innerHTML =
      '<span class="form-hint">项目写入策略决定新经验进入试用池或待审队列。</span>' +
      '<button class="btn btn-primary" id="btn-submit-capture">提交经验</button>';

    document.getElementById('drawer-backdrop').classList.add('open');

    var route = document.getElementById('cr-route');
    function updateCaptureForm() {
      var candidate = route.value === 'knowledge_candidate';
      ['cr-layer','cr-title','cr-type','cr-prio','cr-alias','cr-claim','cr-pre','cr-inv','cr-method','cr-delta'].forEach(function(id){
        document.getElementById(id).closest('.form-row').hidden = !candidate;
      });
      var discarded = route.value === 'discard';
      document.getElementById('cr-note').closest('.form-row').hidden = !candidate && !discarded;
      document.querySelector('label[for="cr-note"]').textContent = discarded ? '丢弃原因 *' : '证据内容 *';
      document.getElementById('cr-note').placeholder = discarded ? '为什么这条信息无需沉淀为经验？' : '记录的现象、测试结果或文档结论';
      document.getElementById('cr-loc').closest('.form-row').hidden = discarded;
      document.querySelector('label[for="cr-loc"]').textContent = route.value === 'needs_confirmation' ? '已有线索的位置（可选）' : '证据位置（仓库相对路径）*';
      document.getElementById('cr-polarity').closest('.form-row').hidden = !candidate || document.getElementById('cr-type').value !== 'guideline';
      document.getElementById('btn-submit-capture').textContent = {knowledge_candidate:'提交经验',index_only:'保存代码导航',link_existing:'保存文档链接',needs_confirmation:'提交待补证',discard:'记录丢弃原因'}[route.value];
    }
    document.getElementById('cr-layer').value = document.getElementById('flt-layer').value === 'domain' ? 'domain' : 'project';
    route.onchange = updateCaptureForm;
    document.getElementById('cr-type').onchange = updateCaptureForm;
    updateCaptureForm();
    document.getElementById('btn-submit-capture').onclick = async function(ev) {
      var button = ev.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        var disposition = route.value;
        var discovery = {knowledge_candidate:'missing_context', index_only:'code_recoverable', link_existing:'authoritative_source',
          needs_confirmation:'inconclusive', discard:'inconclusive'};
        var candidate = disposition === 'knowledge_candidate';
        var required = ['cr-q','cr-base'];
        if (candidate) required.push('cr-delta','cr-title','cr-claim','cr-pre','cr-inv','cr-method','cr-note','cr-loc');
        if (disposition === 'discard') required.push('cr-note');
        if (disposition === 'index_only' || disposition === 'link_existing') required.push('cr-loc');
        var missing = required.find(function(id){ return !document.getElementById(id).value.trim(); });
        if (missing) {
          var field = document.getElementById(missing);
          field.focus();
          throw new Error('请填写' + field.closest('.form-row').querySelector('label').textContent);
        }
        var out = await rpc('accremind.capture.manual', {
              question: document.getElementById('cr-q').value,
              discoverability: discovery[disposition],
              layer: document.getElementById('cr-layer').value,
              disposition: disposition,
              baseline_answer: document.getElementById('cr-base').value,
              knowledge_delta: candidate ? document.getElementById('cr-delta').value : '',
              title: document.getElementById('cr-title').value,
              type: document.getElementById('cr-type').value,
              priority: document.getElementById('cr-prio').value,
              polarity: document.getElementById('cr-type').value === 'guideline' ? document.getElementById('cr-polarity').value : undefined,
              search_aliases: document.getElementById('cr-alias').value.split(/[,，]/).map(function(s){return s.trim();}).filter(Boolean),
              claim: document.getElementById('cr-claim').value,
              rationale: candidate || disposition === 'discard' ? document.getElementById('cr-note').value : document.getElementById('cr-base').value,
              preconditions: document.getElementById('cr-pre').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              invalidation_triggers: document.getElementById('cr-inv').value.split('\\n').map(function(s){return s.trim();}).filter(Boolean),
              verification_method: document.getElementById('cr-method').value,
              evidence_summary: candidate ? document.getElementById('cr-note').value : '',
              file_locator: disposition === 'discard' ? '' : document.getElementById('cr-loc').value
        });
        var destination = {probation:'本机试用池', project:'项目经验库', knowledge_candidate:'待审核队列',index_only:'代码导航',link_existing:'文档索引',needs_confirmation:'待补证队列',discard:'审核历史'};
        if (out.downgradedReason) {
          var pending = out.finalDisposition === 'needs_confirmation';
          document.getElementById('cr-feedback').innerHTML =
            '<div class="alert-box alert-s01"><strong>已保存到' + esc(destination[out.finalDisposition] || '候选审核') + '</strong><p>' +
            esc(out.downgradedReason) + '</p><button class="btn btn-sm" id="cr-check-result">' + (pending ? '去候选审核补证' : '查看代码与文档索引') + '</button></div>';
          document.getElementById('cr-check-result').onclick = async function() {
            closeDrawer();
            reviewState = 'pending'; reviewOffset = 0;
            await switchTab('review');
            var target = pending ? Array.from(document.querySelectorAll('[data-assessment]')).find(function(row) { return row.dataset.assessment === out.assessmentId; }) : document.getElementById('nav-index-host');
            if (target) target.scrollIntoView({block:'center'});
          };
          await syncAll();
          return;
        }
        toast(out.duplicate ? '此记录已存在 · ' + out.assessmentId : '已保存到' + (destination[out.persistedZone || out.finalDisposition] || '经验库'));
        closeDrawer();
        await syncAll();
      } catch (err) {
        document.getElementById('cr-feedback').innerHTML = '<div class="alert-box alert-s01">' + esc(err.message) + '</div>';
      } finally { button.disabled = false; }
    };
  }

  function closeDrawer() {
    document.getElementById('drawer-backdrop').classList.remove('open');
  }

  async function switchTab(tab) {
    STATE.tab = tab;
    document.querySelectorAll('.nav-btn').forEach(function(b) {
      var selected = b.getAttribute('data-nav') === tab;
      b.classList.toggle('active', selected);
      if (selected) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
    });
    ['kb', 'review', 'reactor', 'gov'].forEach(function(id) {
      document.getElementById('view-' + id).style.display = id === tab ? 'block' : 'none';
    });
    document.getElementById('app-error').hidden = true;
    window.scrollTo(0,0);
    if (tab === 'review') await loadPrismReview();
    if (tab === 'reactor') await loadReceipts();
    if (tab === 'gov') { await loadGovernance(); await loadSettings(); await refreshDashboard(); }
    if (tab === 'kb') await loadVault();
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
      { label: '打开知识库', hint: 'Tab 1', run: function() { switchTab('kb'); } },
      { label: '审核候选经验', hint: 'Tab 2', run: function() { switchTab('review'); } },
      { label: '查看回合回执与命中模拟', hint: 'Tab 3', run: function() { switchTab('reactor'); } },
      { label: '治理与设置', hint: 'Tab 4', run: function() { switchTab('gov'); } },
      { label: '录入经验', hint: 'Drawer', run: function() { openCreateDrawer(); } },
      { label: '动作：切换暗色黑曜石 / 亮色瑞士蓝图主题', hint: 'Theme', run: function() { toggleTheme(); } },
      { label: '动作：从双层 Markdown 真源全量无损重建 SQLite 索引', hint: 'Rebuild', run: async function() { await rpc('accremind.gov.rebuildIndex', {}); toast('SQLite 索引重建完成'); await syncAll(); } },
      { label: STATE.demoToken ? '返回我的工作区' : '体验演示空间', hint: '工作区', run: switchDemo },
      { label: '查看经验状态说明', hint: '帮助', run: function() { show4dLegendModal(); } }
    ];

    (STATE.allItems || STATE.kbItems || []).forEach(function(hit) {
      var e = hit.entry;
      cmds.push({
        label: '经验 ' + e.id + ' · ' + e.title,
        hint: (e.search_aliases || []).join(', ') || e.type,
        run: function() { openEntryDrawer(e.id); }
      });
    });

    var filtered = cmds.filter(function(c) {
      if (!lower) return true;
      return c.label.toLowerCase().indexOf(lower) !== -1 || (c.hint && c.hint.toLowerCase().indexOf(lower) !== -1);
    });

    var listEl = document.getElementById('cmdk-list');
    listEl.innerHTML = filtered.slice(0, 12).map(function(c, idx) {
      return '<button class="cmdk-item" data-cmdk-idx="' + idx + '">' +
        '<span>' + esc(c.label) + '</span><span class="kbd">' + esc(c.hint) + '</span></button>';
    }).join('');

    if (!filtered.length) listEl.textContent = '没有匹配的经验或操作';
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
    try { localStorage.setItem('accremind_theme', STATE.theme); } catch { /* isolated host frame */ }
    document.getElementById('btn-theme').textContent = STATE.theme === 'dark' ? '☀ 亮色蓝图' : '☾ 暗色观测';
  }

  async function syncAll() {
    await refreshDashboard();
    await loadVault();
    if (STATE.tab === 'review') await loadPrismReview();
    if (STATE.tab === 'reactor') await loadReceipts();
    if (STATE.tab === 'gov') { await loadGovernance(); await loadSettings(); }
  }

  // Global Event Delegation
  document.addEventListener('click', async function(ev) {
    var navBtn = ev.target.closest('[data-nav]');
    if (navBtn) { await switchTab(navBtn.getAttribute('data-nav')); return; }

    var detailTrigger = ev.target.closest('[data-detail]');
    if (detailTrigger) { await openEntryDrawer(detailTrigger.getAttribute('data-detail')); return; }

    var legendTrigger = ev.target.closest('[data-open-legend]');
    if (legendTrigger) { show4dLegendModal(); return; }

    var promoteBtn = ev.target.closest('[data-promote]');
    if (promoteBtn) {
      var pid = promoteBtn.getAttribute('data-promote');
      var hit = STATE.kbItems.find(function(item) { return item.entry.id === pid; });
      if (!hit) return;
      openDialog({title:'将试用草稿转为正式经验',bodyHtml:'<p>' + esc(hit.entry.title) + '</p><p>保存到项目经验库，可随 Git 共享。成熟度维持原值。</p>',confirmText:'转为正式',
        onConfirm:async function() { await rpc('accremind.probation.decide',{id:pid,revision:hit.entry.revision,action:'promote'}); toast('已转为正式经验'); await syncAll(); }});

      return;
    }

    var demo = ev.target.closest('[data-demo-switch]');
    if (demo) { await switchDemo(); return; }
    var actionBtn = ev.target.closest('[data-work-action]');
    if (actionBtn) {
      var action = actionBtn.dataset.workAction;
      if (action === 'review') { reviewState = 'pending'; reviewOffset = 0; await switchTab('review'); }
      else if (action === 'demo') await switchDemo();
      else if (action === 'reset') { clearFilters(); await loadVault(); }
      else if (action === 'discover') {
        await switchTab('gov');
        document.getElementById('btn-gov-arch').scrollIntoView({block:'center'});
        await loadArchaeology();
      } else await switchTab(action);
      return;
    }

    var openCreate = ev.target.closest('[data-open-create]');
    if (openCreate) { openCreateDrawer(); return; }

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
    if (layerTile) await libraryShortcut(layerTile.dataset.filterShortcut);
  });

  // Top & Filter Bindings
  document.getElementById('btn-theme').textContent = STATE.theme === 'dark' ? '☀ 亮色蓝图' : '☾ 暗色观测';
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-cmdk').onclick = openCommandPalette;
  document.getElementById('btn-mobile-actions').onclick = openCommandPalette;
  document.getElementById('btn-new-entry').onclick = openCreateDrawer;
  document.getElementById('drw-close').onclick = closeDrawer;
  document.getElementById('drawer-backdrop').onclick = function(e) { if (e.target.id === 'drawer-backdrop') closeDrawer(); };
  document.getElementById('cmdk-mask').onclick = function(e) { if (e.target.id === 'cmdk-mask') e.target.classList.remove('open'); };
  document.getElementById('dialog-mask').onclick = function(e) { if (e.target.id === 'dialog-mask') e.target.classList.remove('open'); };
  document.getElementById('cmdk-input').oninput = function(e) { renderCmdkResults(e.target.value); };

  document.getElementById('refresh-receipts').onclick = loadReceipts;
  document.getElementById('toggle-filters').onclick = function() { moreFilters(document.getElementById('more-filters').hidden); };
  document.getElementById('clear-filters').onclick = function() { clearFilters(); loadVault().catch(reportError); };
  document.getElementById('flt-q').oninput = function() { loadVault().catch(reportError); };
  Object.keys(filterFields).forEach(function(key) { document.getElementById('flt-' + key).onchange = loadVault; });
  document.getElementById('cmdk-input').onkeydown = function(event) {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      var first = document.querySelector('#cmdk-list button');
      if (first) { event.preventDefault(); if (event.key === 'Enter') first.click(); else first.focus(); }
    }
  };

  document.querySelectorAll('[data-view-mode]').forEach(function(btn) {
    var selected = btn.getAttribute('data-view-mode') === STATE.viewMode;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-pressed', String(selected));
    btn.onclick = function() {
      STATE.viewMode = btn.getAttribute('data-view-mode');
      try { localStorage.setItem('accremind_library_view', STATE.viewMode); } catch { /* use current session */ }
      document.querySelectorAll('[data-view-mode]').forEach(function(b) { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
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
  document.getElementById('btn-gov-arch').onclick = loadArchaeology;

  document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    var dialog = document.getElementById('dialog-mask'), palette = document.getElementById('cmdk-mask');
    var overlay = dialog.classList.contains('open') ? dialog : palette.classList.contains('open') ? palette :
      (document.getElementById('drawer-backdrop').classList.contains('open') ? document.getElementById('drawer-backdrop') : null);
    if (overlay) {
      if (e.key === 'Escape') {
        if (overlay === dialog) document.getElementById('dlg-cancel').click();
        else if (overlay === palette) {
          palette.classList.remove('open');
          var searchButton = document.getElementById('btn-cmdk');
          (searchButton.getClientRects().length ? searchButton : document.getElementById('btn-mobile-actions')).focus();
        }
        else closeDrawer();
      }
      if (e.key === 'Tab') {
        var targets = Array.from(overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,select,summary')).filter(function(el) { return el.getClientRects().length; });
        var index = targets.indexOf(document.activeElement);
        if (targets.length && (index === -1 || (e.shiftKey ? index === 0 : index === targets.length - 1))) {
          e.preventDefault(); targets[e.shiftKey ? targets.length - 1 : 0].focus();
        }
      }
      return;
    }
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
      e.preventDefault();
      switchTab('kb');
      document.getElementById('flt-q').focus();
    }
  });

  window.addEventListener('unhandledrejection', function(event) { reportError(event.reason); });
  document.getElementById('demo-banner').hidden = !STATE.demoToken;
  if (window === window.top && new URLSearchParams(location.search).get('demo') === '1') switchDemo().catch(reportError);
  else syncAll().catch(reportError);
})();
`;
