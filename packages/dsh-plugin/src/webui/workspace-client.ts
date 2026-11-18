// Runs inside the workbench closure with the shared, host-aware RPC transport.
export const WORKSPACE_CLIENT = `
  var filterFields = { layer: 'layer', zone: 'storageZone', status: 'status', type: 'type', maturity: 'maturity', freshness: 'freshness', serving: 'serving' };
  var vaultRequest = 0;
  var demoChanging = false;
  var activeCalls = 0;

  var scopeNames = {domain:'领域知识', project:'项目知识', shared_tech:'通用技术', team_rule:'团队规范', personal:'个人知识'};
  var typeNames = {model:'领域模型', decision:'架构决策', guideline:'规范', pitfall:'排障陷阱', process:'操作流程'};

  function knowledgeTypeLabel(type) { return typeNames[type] || type || '未标注类型'; }
  function knowledgeScopeLabel(storageZone, layer) {
    return scopeNames[layer] || ({rules:'团队规范',personal:'个人知识',shared_tech:'通用技术'}[storageZone]) || '未标注范围';
  }
  function knowledgeSummary(entry) { return String(entry.knowledge_delta || entry.rationale || entry.claim || '').trim(); }

  function renderScopes(counts, selected) {
    var total = Object.values(counts).reduce(function(sum, count) { return sum + count; }, 0);
    document.querySelectorAll('[data-scope]').forEach(function(chip) {
      var scope = chip.dataset.scope;
      chip.setAttribute('aria-pressed', String(scope === selected));
      chip.querySelector('span').textContent = scope ? (counts[scope] || 0) : total;
    });
    document.getElementById('scope-caption').textContent = scopeNames[selected] || '全部知识';
  }

  function renderKnowledgeSummary(host, items) {
    var groups = new Map();
    var reviewed = 0, due = 0;
    items.forEach(function(hit) {
      var entry = hit.entry;
      var scope = knowledgeScopeLabel(hit.storageZone, entry.layer);
      if (!groups.has(scope)) groups.set(scope, []);
      groups.get(scope).push(entry);
      if (entry.maturity === 'verified' || entry.maturity === 'proven') reviewed++;
      if (entry.freshness === 'review_due') due++;
    });
    var body = Array.from(groups.entries()).map(function(group) {
      var name = group[0], entries = group[1];
      var types = {};
      entries.forEach(function(e) { var type = knowledgeTypeLabel(e.type); types[type] = (types[type] || 0) + 1; });
      var distribution = Object.entries(types).map(function(pair) { return esc(pair[0]) + ' ' + pair[1] + ' 条'; }).join(' · ');
      function conclusion(entry) {
        var text = entry.claim || knowledgeSummary(entry);
        return '<li><button class="summary-ref" data-detail="' + esc(entry.id) + '">' + esc(entry.title) +
          ' <code>' + esc(entry.id + '@r' + entry.revision) + '</code></button>' +
          (text && text !== entry.title ? '<p>' + esc(text) + '</p>' : '') + '</li>';
      }
      var remainder = entries.length > 3 ? '<details><summary>其余 ' + (entries.length - 3) + ' 条结论</summary><ul>' +
        entries.slice(3).map(conclusion).join('') + '</ul></details>' : '';
      return '<section class="glass-panel knowledge-digest"><div class="digest-head"><strong>' + esc(name) +
        '</strong><span>' + distribution + '</span></div><ul>' + entries.slice(0,3).map(conclusion).join('') + '</ul>' + remainder + '</section>';
    }).join('');
    host.innerHTML = '<p class="digest-totals">当前结果覆盖 ' + groups.size + ' 个知识范围，' + reviewed +
      ' 条已独立验证，' + due + ' 条待复核。</p>' + body;
  }

  document.getElementById('scope-choices').onclick = function(event) {
    var chip = event.target.closest('[data-scope]');
    if (!chip) return;
    document.getElementById('flt-layer').value = chip.dataset.scope;
    loadVault().catch(reportError);
  };

  function reportError(error) {
    var el = document.getElementById('app-error');
    el.hidden = false;
    el.textContent = error.message || String(error);
  }

  function moreFilters(open) {
    document.getElementById('more-filters').hidden = !open;
    document.getElementById('toggle-filters').setAttribute('aria-expanded', String(open));
  }

  function clearFilters() {
    document.getElementById('flt-q').value = '';
    Object.keys(filterFields).forEach(function(key) { document.getElementById('flt-' + key).value = ''; });
  }

  function button(action, label, primary) {
    return '<button class="btn ' + (primary ? 'btn-primary' : '') + '" data-work-action="' + action + '">' + label + '</button>';
  }

  function showNextTask(counts) {
    var title, detail, actions;
    if (counts.pendingReviewCount) {
      title = counts.pendingReviewCount + ' 条候选经验等待审核';
      detail = '先看代码能够解释什么，再核对新增经验的证据。';
      actions = button('review', '审核候选', true) + (counts.governanceQueueCount ? button('gov', '治理队列 · ' + counts.governanceQueueCount, false) : '');
    } else if (counts.governanceQueueCount) {
      title = '治理队列中有 ' + counts.governanceQueueCount + ' 项';
      detail = '查看待复核、暂停检索或已失效的经验，以及存在冲突的文件。';
      actions = button('gov', '查看治理队列', true);
    } else if (!counts.totalEntries) {
      title = '从仓库历史发现第一条经验';
      detail = '扫描修复与回滚记录，选出值得下次开发时提醒的经验。';
      actions = button('discover', '扫描仓库历史', true) + button('demo', '体验示例', false);
    } else {
      title = counts.probationCount ? counts.probationCount + ' 条经验正在试用' : '项目经验已就绪';
      detail = '在真实开发任务中核对命中结果，记录哪些经验确实有效。';
      actions = button('reactor', '查看回合回执', true) + button('discover', '从历史发现经验', false);
    }
    document.getElementById('next-title').textContent = title;
    document.getElementById('next-title').title = detail;
    document.getElementById('next-actions').innerHTML = actions;
  }

  async function switchDemo() {
    if (demoChanging) return;
    if (activeCalls) { toast('请等待当前操作完成后切换空间'); return; }
    demoChanging = true;
    try {
      if (STATE.demoToken) {
        await hostRpc('accremind.demo.close', { token: STATE.demoToken });
        STATE.demoToken = null;
        if (window === window.top && new URLSearchParams(location.search).has('demo')) {
          var address = new URL(location.href);
          address.searchParams.delete('demo');
          history.replaceState(null, '', address);
        }
      } else {
        var session = await hostRpc('accremind.demo.open', {});
        STATE.demoToken = session.token;
      }
      clearFilters();
      moreFilters(false);
      reviewState = 'pending'; reviewOffset = 0;
      STATE.allItems = []; STATE.archCommits = []; STATE.kbItems = [];
      document.getElementById('arch-timeline-host').textContent = '扫描本工作区的 Git 提交记录。';
      document.getElementById('reactor-lanes').replaceChildren();
      document.getElementById('rebuild-status').textContent = '从本工作区保存的经验卡片重建检索索引。';
      document.getElementById('overview-panel').open = false;
      document.getElementById('demo-banner').hidden = !STATE.demoToken;
      await refreshDashboard();
      await switchTab('kb');
    } catch (error) { reportError(error); } finally { demoChanging = false; }
  }

  async function libraryShortcut(kind) {
    if (kind === 'nav') {
      await switchTab('review');
      document.getElementById('nav-index-host').scrollIntoView({ block:'center' });
      return;
    }
    var mappings = { rules:{ zone:'rules' }, project:{ zone:'project', status:'active' },
      probation:{status:'probation'}, active:{status:'active'}, verified:{maturity:'verified_or_proven'},
      due:{freshness:'review_due'}, suspended:{serving:'suspended'} };
    clearFilters();
    Object.entries(mappings[kind] || {}).forEach(function(pair) { document.getElementById('flt-' + pair[0]).value = pair[1]; });
    moreFilters(['verified','due','suspended'].includes(kind));
    if (STATE.tab !== 'kb') await switchTab('kb'); else await loadVault();
    document.getElementById('library').scrollIntoView({block:'start'});
  }

  async function loadReceipts() {
    var response = await rpc('accremind.turn.list', {limit:30});
    var receipts = response.receipts;
    var host = document.getElementById('receipt-host');
    if (!receipts.length) {
      host.innerHTML = '<div class="receipt-meta">暂无真实回合。在已启用 AccreMind 的 DSH 项目中发起一次任务后，这里会显示命中记录。下方可先预览匹配效果。</div>';
      return;
    }
    host.innerHTML = receipts.map(function(receipt, ri) {
      var hits = receipt.hits.map(function(hit, hi) {
        var origin = {rule:'项目常驻规范', radar:'回合前匹配', jit:'读写文件时提示'}[hit.source];
        var state = '';
        if (!hit.currentStatus) state = '条目已移除';
        else if (hit.currentRevision !== hit.revision) state = '已有更新版本';
        else if (hit.currentStatus === 'archived' || hit.currentStatus === 'withdrawn') state = '已归档或撤回';
        else if (hit.currentServing === 'suspended') state = '已暂停检索';
        else if (hit.status === 'probation' && hit.currentStatus === 'active') state = '已转为正式经验';
        else if (hit.feedback === 'success') state = '本任务已验证';
        var actions = state ? [] : hit.status === 'probation' ? [['promote','有效，转为正式'],['dismiss','淘汰草稿']] :
          [['verified_effective','验证有效'],['suspected_error','疑似错误']];
        if (hit.feedback === 'success' && hit.currentServing === 'enabled' && hit.currentRevision === hit.revision) actions = [['suspected_error','补充反证']];
        return '<div class="receipt-hit"><div><strong>' + esc(hit.title) + '</strong><div class="receipt-meta">' +
          esc(hit.id + '@r' + hit.revision) + ' · ' + esc(origin) + (hit.filePath ? ' · ' + esc(hit.filePath) : '') +
          '</div></div><div class="action-row">' + (state ? '<span class="receipt-meta">' + esc(state) + '</span>' : '') + actions.map(function(pair) {
            return '<button class="btn btn-sm" data-receipt="' + ri + '" data-hit="' + hi + '" data-result="' + pair[0] + '">' + pair[1] + '</button>';
          }).join('') + (hit.currentStatus ? '<button class="btn btn-sm" data-detail="' + esc(hit.id) + '">查看当前条目</button>' : '') + '</div></div>';
      }).join('');
      return '<details' + (ri === 0 ? ' open' : '') + '><summary>' + esc(new Date(receipt.createdAt).toLocaleString()) +
        ' · 命中 ' + receipt.hits.length + ' 条 <span class="receipt-meta">会话 ' + esc(receipt.sessionId) + '</span></summary>' +
        (hits || '<div class="receipt-hit">本回合未命中经验。</div>') + '</details>';
    }).join('');
    host.onclick = function(event) {
      var btn = event.target.closest('[data-receipt]');
      if (!btn) return;
      var receipt = receipts[Number(btn.dataset.receipt)];
      var hit = receipt.hits[Number(btn.dataset.hit)];
      var result = btn.dataset.result;
      var positive = result === 'verified_effective' || result === 'promote';
      var payload = {id:hit.id, revision:hit.revision, sessionId:receipt.sessionId, turnId:receipt.turnId};
      openDialog({
        title: btn.textContent + ' · ' + hit.id + '@r' + hit.revision,
        bodyHtml: '<p>' + esc(hit.title) + '</p>',
        inputLabel: result === 'dismiss' ? null : (positive ? '本任务的验证依据' : '发现的反证'),
        placeholder: positive ? '记录执行的测试、提交或实际观察到的结果' : '描述出错条件和观察到的结果',
        requireInput: result !== 'dismiss', confirmText:btn.textContent,
        onConfirm: async function(note) {
          if (result === 'dismiss') {
            await rpc('accremind.probation.decide', Object.assign(payload,{action:'dismiss'}));
          } else {
            await rpc('accremind.feedback.submit', Object.assign(payload,{kind:positive ? 'verified_effective' : result,detail:note}));
          }
          toast('已记录此回合的处理结果');
          await syncAll();
        }
      });
    };
  }

  async function loadSettings() {
    var settings = await rpc('accremind.settings.get', {});
    var gate = settings.writeGate;
    var host = document.getElementById('settings-host');
    host.innerHTML = '<div class="settings-line"><div><strong>新经验的处理方式</strong>' +
      '<p>作用于当前工作区后续捕获的经验。</p></div><div class="action-row"><select id="settings-gate" aria-label="新经验的处理方式">' +
      (gate === 'off' ? '<option value="off">直接入库（宿主配置）</option>' : '') +
      '<option value="probation">先在本机试用</option><option value="review">先人工审核</option></select>' +
      '<button class="btn btn-sm" id="save-settings" disabled>保存策略</button></div></div>' +
      '<div class="settings-line"><div><strong>模型推理</strong><p>Git 扫描在本机执行。提炼会将经过脱敏的上下文提交给配置的模型。</p></div><code>' +
      esc(settings.modelEndpoint) + '</code></div>';
    var select = document.getElementById('settings-gate');
    var save = document.getElementById('save-settings');
    select.value = gate;
    select.onchange = function() { save.disabled = select.value === gate; };
    save.onclick = async function() {
      save.disabled = true;
      try {
        await rpc('accremind.settings.setGate', {writeGate:select.value});
        toast('已保存当前工作区的写入策略');
        await loadSettings();
      } catch (err) { save.disabled = false; reportError(err); }
    };
  }
`;
