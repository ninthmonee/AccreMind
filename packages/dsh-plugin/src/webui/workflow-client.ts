// Embedded in the same controller as the host RPC bridge and the entry drawer.
export const WORKFLOW_CLIENT = String.raw`
  var reviewState = 'pending';
  var reviewOffset = 0;
  var reviewPageSize = 50;
  var reviewRequest = 0;
  var reviewBusy = false;
  var entryDrafts = new Map();
  var pendingReviewEdits = new Map();
  var reviewWorkspace = '';
  var routingLabels = {
    approve_active: '批准为正式经验', approve_probation: '进入本机试用',
    knowledge_candidate: '经验候选', needs_confirmation: '待补证',
    index_only: '代码导航', link_existing: '权威文档', discard: '丢弃', supplement: '保存补证'
  };

  function reviewFields(item) {
    var entry = item.candidateDraft || {}, a = item.assessment;
    var fields = [
      ['title', '经验标题', entry.title],
      ['claim', '核心结论', entry.claim],
      ['knowledge_delta', '已核实的知识增量', entry.knowledge_delta || a.knowledge_delta],
      ['rationale', '依据', entry.rationale],
      ['preconditions', '前置条件，每行一项', (entry.preconditions || []).join('\n')],
      ['invalidation_triggers', '失效条件，每行一项', (entry.invalidation_triggers || []).join('\n')],
      ['verification_method', '可复核的验证方法', entry.verification_method],
      ['evidenceLocator', '新证据定位，如提交 SHA、文件与行号', ''],
      ['evidenceNote', '这份证据实测或记录了什么', ''],
      ['navigationLocator', '保存代码导航或文档链接时使用的目标位置', '']
    ];
    var layer = entry.layer || 'project';
    var scopeField = '<div class="form-row"><label>知识范围';
    if (layer === 'domain' || layer === 'project') {
      scopeField += '<select data-review-field="layer" data-initial-layer="' + layer + '">' +
        ['project','domain'].map(function(value) {
          return '<option value="' + value + '"' + (layer === value ? ' selected' : '') + '>' +
            esc(knowledgeScopeLabel(null, value)) + '</option>';
        }).join('') + '</select>';
    } else {
      scopeField += ' · ' + esc(knowledgeScopeLabel(null, layer));
    }
    scopeField += '</label></div>';
    return scopeField + fields.map(function(f) {
      return '<div class="form-row"><label>' + esc(f[1]) + '<textarea rows="2" data-review-field="' +
        f[0] + '">' + esc(f[2] || '') + '</textarea></label></div>';
    }).join('');
  }

  function reviewCard(item) {
    var a = item.assessment, draft = item.candidateDraft || {}, ctx = a.checked_context || {};
    var pending = item.reviewState === 'pending';
    var evidence = (a.claim_evidence_map || []).map(function(m) {
      return '<li>' + esc(m.assertion) + ' · <code>' + esc(m.evidence_locator || '待补定位') +
        '</code> · ' + (m.verified_fact ? '已核实' : '待核实') + '</li>';
    }).join('');
    var sources = (draft.evidence || []).map(function(e) {
      return '<li><code>' + esc(e.locator) + '</code> ' + esc(e.summary) + '</li>';
    }).join('');
    var anchors = (draft.symbol_anchors || []).map(function(s) {
      return '<li><code>' + esc(s.file_path + '#L' + s.start_line + '-L' + s.end_line) + '</code> ' + esc(s.symbol_name) + '</li>';
    }).join('');
    var mapped = (a.claim_evidence_map || []).find(function(m){return m.verified_fact && m.evidence_locator;});
    var sourcesList = draft.evidence || [];
    var first = (mapped && sourcesList.find(function(e){return e.locator === mapped.evidence_locator;})) || sourcesList[0];
    var locator = (mapped && mapped.evidence_locator) || (first && first.locator);
    var summary = (first && first.locator === locator && first.summary) || (mapped && mapped.assertion) || '';
    var preview = locator ? '<p class="form-hint"><strong>核查证据</strong> · <code title="' + esc(locator) + '">' +
      esc(locator.replace(/\b[\da-f]{40}\b/gi,function(sha){return sha.slice(0,8);})) + '</code> ' +
      esc(summary.length > 110 ? summary.slice(0,110) + '…' : summary) + '</p>' :
      '<p><strong>缺少证据</strong>' + (pending ? ' <button class="btn btn-sm" data-issue="evidenceLocator">补充定位与依据</button>' : '') + '</p>';
    var omissions = item.missingFields || [];
    return '<article class="prism-card" data-assessment="' + esc(a.id) + '">' +
      '<div>' + (pending ? '<label><input type="checkbox" data-review-select aria-label="选择 ' + esc(a.id) + '" /> </label>' : '') +
      '<strong>' + esc(a.question) + '</strong> <span class="tag">' + esc(a.priority) + '</span></div>' +
      '<p class="form-hint"><code>' + esc(a.id) + '</code> · ' + esc(routingLabels[a.disposition] || a.disposition) + ' · ' +
      (draft.layer ? esc(knowledgeScopeLabel(null,draft.layer)) + ' · ' : '') + esc(ctx.method || '') + (ctx.head_commit ? ' · <code title="' + esc(ctx.head_commit) + '">' + esc(ctx.head_commit.slice(0,8)) + '</code>' : '') + '</p>' +
      '<div class="prism-grid"><div class="prism-pane"><div class="prism-label">当前代码与文档能回答什么</div>' +
      esc(a.baseline_answer || '尚无基线') + '</div><div class="prism-divider">Δ</div><div class="prism-pane delta">' +
      '<div class="prism-label">还需保留的经验</div>' + esc(a.knowledge_delta || '待补知识增量') +
      '<p class="form-hint">' + esc(a.omission_consequence || '') + '</p></div></div>' +
      preview + '<details><summary>查看全部断言与证据</summary>' +
      (evidence + sources + anchors ? '<ul>' + evidence + sources + anchors + '</ul>' : '<p>尚无已绑定证据</p>') +
      '<p class="form-hint">已查阅 ' + esc([].concat(ctx.checked_files || [], ctx.checked_docs || []).join('、') || '无文件记录') + '</p></details>' +
      (pending ? '<div data-issues role="status">' + issueList(omissions) + '</div>' +
        '<details data-review-editor><summary>编辑候选或补充证据</summary>' + reviewFields(item) +
        '<button class="btn" data-decision="supplement">保存补证，留在待审</button></details>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' +
        ['approve_probation', 'approve_active', 'needs_confirmation', 'index_only', 'link_existing', 'discard'].map(function(key) {
          return '<button class="btn btn-sm' + (key === 'approve_probation' ? ' btn-primary' : '') + '" data-decision="' + key + '">' + routingLabels[key] + '</button>';
        }).join('') + '</div>' : '') + '</article>';
  }

  function issueList(issues) {
    return issues.length ? '<strong>待补项目</strong><ul>' + issues.map(function(msg) {
      var key = msg.split(':')[0];
      if (/^(claim_evidence_map|evidence)/.test(key)) key = 'evidenceLocator';
      return '<li><button class="btn btn-sm" data-issue="' + esc(key) + '">' + esc(msg) + '</button></li>';
    }).join('') + '</ul>' : '';
  }

  function reviewParams(card, decision) {
    var id = card.getAttribute('data-assessment');
    var item = STATE.reviewItems.find(function(i) { return i.assessment.id === id; });
    var params = {assessmentId: id, decision: decision};
    // Route-only decisions do not submit an unpublished card as an approved draft.
    if (decision === 'index_only' || decision === 'link_existing') {
      params.navigationLocator = card.querySelector('[data-review-field="navigationLocator"]').value.trim();
      return params;
    }
    if (['approve_probation', 'approve_active', 'supplement'].indexOf(decision) < 0) return params;
    var patch = {};
    card.querySelectorAll('[data-review-field]').forEach(function(el) {
      var key = el.getAttribute('data-review-field'), value = el.value.trim();
      if (key === 'navigationLocator') return;
      if (key === 'evidenceLocator' || key === 'evidenceNote') {
        if (value) params[key] = value;
      } else {
        var initialValue = key === 'layer' ? el.getAttribute('data-initial-layer') : el.defaultValue.trim();
        if (value === initialValue && item.candidateDraft) return;
        patch[key] = key === 'preconditions' || key === 'invalidation_triggers' ?
          value.split('\n').map(function(s){return s.trim();}).filter(Boolean) : value;
      }
    });
    if (Object.keys(patch).length) params.editedEntry = patch;
    if (patch.knowledge_delta || params.evidenceLocator || params.evidenceNote) {
      params.knowledgeDelta = card.querySelector('[data-review-field="knowledge_delta"]').value.trim();
    }
    return params;
  }

  async function applyReview(host, cards, decision) {
    if (reviewBusy || !cards.length) return;
    reviewBusy = true;
    var results = [], successes = 0;
    host.querySelectorAll('button,select').forEach(function(b) { b.disabled = true; });
    try {
      for (var card of cards) {
        var id = card.getAttribute('data-assessment');
        try {
          var out = await rpc('accremind.review.decide', reviewParams(card, decision));
          if (!out.ok) {
            var missing = out.missingFields || ['请检查候选资料'];
            card.querySelector('[data-issues]').innerHTML = issueList(missing);
            card.querySelector('[data-review-editor]').open = true;
            results.push(id + ' · 待补 ' + missing.join('、'));
          } else {
            successes++;
            results.push(id + ' · ' + routingLabels[decision]);
            pendingReviewEdits.delete(id);
            if (decision !== 'supplement' && decision !== 'needs_confirmation') card.remove();
            else if (decision === 'supplement') {
              card.querySelector('[data-issues]').innerHTML = issueList(out.missingFields || []);
              card.querySelectorAll('[data-review-field]').forEach(function(el) {
                if (el.hasAttribute('data-initial-layer')) el.setAttribute('data-initial-layer', el.value);
                else el.defaultValue = el.value;
              });
              ['evidenceLocator','evidenceNote'].forEach(function(k){
                var el = card.querySelector('[data-review-field="' + k + '"]');
                el.defaultValue = el.value = '';
              });
            }
          }
        } catch (err) { results.push(id + ' · ' + err.message); }
      }
      // Preserve edits on all remaining cards when any decision failed.
      if (successes) {
        await refreshDashboard();
        await loadVault();
        await loadPrismReview();
      }
      var feedback = document.getElementById('review-feedback');
      if (feedback) feedback.textContent = results.join('\n');
    } finally {
      reviewBusy = false;
      host.querySelectorAll('button,select').forEach(function(b) { b.disabled = false; });
    }
  }

  async function loadPrismReview() {
    var req = ++reviewRequest;
    var data = await rpc('accremind.review.listQueue', { reviewState: reviewState, offset: reviewOffset, limit: reviewPageSize });
    if (req !== reviewRequest) return;
    STATE.reviewItems = data.items || [];
    if (!STATE.reviewItems.length && reviewOffset) {
      reviewOffset = Math.max(0, reviewOffset - reviewPageSize);
      return loadPrismReview();
    }
    STATE.navItems = data.navigationItems || [];
    var host = document.getElementById('prism-queue-host');
    var savedRows = new Map();
    var workspace = STATE.overview ? STATE.overview.projectDir : '';
    if (workspace !== reviewWorkspace) pendingReviewEdits.clear();
    var previousCards = workspace === reviewWorkspace ? host.querySelectorAll('[data-assessment]') : [];
    reviewWorkspace = workspace;
    previousCards.forEach(function(card){
      var issues = card.querySelector('[data-issues]');
      var opened = card.querySelector('[data-review-editor]');
      var checked = card.querySelector('[data-review-select]');
      if (opened) savedRows.set(card.getAttribute('data-assessment'), {
        issues:issues.innerHTML, opened:opened.open, checked:checked.checked
      });
    });
    host.innerHTML = '<div class="toolbar"><label>审核记录 <select id="review-filter"><option value="pending">待审核</option>' +
      '<option value="decided">已处理</option></select></label>' + (reviewState === 'pending' && STATE.reviewItems.length ?
        '<div><label><input type="checkbox" id="review-all" /> 选择本页</label> <select id="review-bulk-choice">' +
        ['approve_probation','approve_active','discard'].map(function(k) { return '<option value="' + k + '">' + routingLabels[k] + '</option>'; }).join('') +
        '</select> <button class="btn" data-review-bulk>处理选中项</button></div>' : '') +
      '</div><div id="review-feedback" role="status" style="white-space:pre-line"></div>' +
      (STATE.reviewItems.length ? STATE.reviewItems.map(reviewCard).join('') :
        '<div class="empty-observatory">' + (reviewState === 'pending' ? '目前没有待审候选。 <button class="btn" data-work-action="discover">扫描仓库历史</button>' : '暂无已处理的记录。') + '</div>') +
      (data.hasMore || reviewOffset ? '<div class="toolbar"><span>第 ' + (1 + reviewOffset / reviewPageSize) + ' 页 · 本页 ' + STATE.reviewItems.length + ' 条</span><div>' +
        (reviewOffset ? '<button class="btn" data-review-page="prev">上一页</button> ' : '') +
        (data.hasMore ? '<button class="btn" data-review-page="next">下一页</button>' : '') + '</div></div>' : '');
    document.getElementById('review-filter').value = reviewState;
    host.querySelectorAll('[data-review-editor]').forEach(function(editor){
      var card = editor.closest('[data-assessment]'), id = card.getAttribute('data-assessment');
      var local = pendingReviewEdits.get(id), saved = savedRows.get(id);
      if (local) card.querySelectorAll('[data-review-field]').forEach(function(el){
        if (el.getAttribute('data-review-field') in local) el.value = local[el.getAttribute('data-review-field')];
      });
      if (saved) {
        editor.open = saved.opened;
        card.querySelector('[data-review-select]').checked = saved.checked;
        if (saved.issues) card.querySelector('[data-issues]').innerHTML = saved.issues;
      }
    });
    host.oninput = function(ev) {
      if (!ev.target.hasAttribute('data-review-field')) return;
      var card = ev.target.closest('[data-assessment]'), id = card.getAttribute('data-assessment');
      var local = pendingReviewEdits.get(id) || {};
      local[ev.target.getAttribute('data-review-field')] = ev.target.value;
      pendingReviewEdits.set(id, local);
    };
    host.onchange = async function(ev) {
      if (ev.target.id === 'review-filter') { reviewState = ev.target.value; reviewOffset = 0; await loadPrismReview(); }
      if (ev.target.id === 'review-all') host.querySelectorAll('[data-review-select]').forEach(function(c) { c.checked = ev.target.checked; });
    };
    host.onclick = async function(ev) {
      var page = ev.target.closest('[data-review-page]');
      if (page) {
        reviewOffset = Math.max(0, reviewOffset + (page.getAttribute('data-review-page') === 'next' ? reviewPageSize : -reviewPageSize));
        await loadPrismReview();
        host.scrollIntoView({block:'start'});
        return;
      }
      var card = ev.target.closest('[data-assessment]');
      var issue = ev.target.closest('[data-issue]');
      if (issue && card) {
        card.querySelector('[data-review-editor]').open = true;
        var field = Array.from(card.querySelectorAll('[data-review-field]')).find(function(el) {
          return el.getAttribute('data-review-field') === issue.getAttribute('data-issue');
        });
        (field || card.querySelector('[data-review-field]')).focus();
      }
      var btn = ev.target.closest('[data-decision]');
      if (btn && card) {
        var route = btn.getAttribute('data-decision');
        if (route === 'index_only' || route === 'link_existing') {
          var a = STATE.reviewItems.find(function(i){return i.assessment.id === card.getAttribute('data-assessment');}).assessment;
          var ctx = a.checked_context || {};
          var input = card.querySelector('[data-review-field="navigationLocator"]');
          var choices = route === 'index_only' ? ctx.checked_files : ctx.checked_docs;
          openDialog({title:routingLabels[route],inputLabel:route === 'index_only' ? '目标代码路径或符号' : '权威文档位置',
            defaultValue:input.value || (choices || [])[0] || '',requireInput:true,confirmText:'保存到索引',
            onConfirm:function(locator){ input.value = locator; return applyReview(host,[card],route); }});
          return;
        }
        await applyReview(host, [card], route);
      }
      if (ev.target.closest('[data-review-bulk]')) {
        var selected = Array.from(host.querySelectorAll('[data-review-select]:checked')).map(function(el) { return el.closest('[data-assessment]'); });
        if (!selected.length) { document.getElementById('review-feedback').textContent = '请先选择要处理的候选。'; return; }
        var decision = document.getElementById('review-bulk-choice').value;
        openDialog({title:'确认批量处理',bodyHtml:'将对 ' + selected.length + ' 条候选执行「' + esc(routingLabels[decision]) + '」。每条均独立校验。',confirmText:'确认处理',onConfirm:function(){return applyReview(host, selected, decision);}});
      }
    };
    document.getElementById('nav-index-host').innerHTML = STATE.navItems.length ? STATE.navItems.map(function(n) {
      return '<p><strong>' + esc(n.title) + '</strong> · <code>' + esc(n.locator) + '</code></p>';
    }).join('') : '<p>暂无代码导航或文档链接。</p>';
  }

  async function loadArchaeology() {
    var scan = document.getElementById('btn-gov-arch'), host = document.getElementById('arch-timeline-host');
    scan.disabled = true;
    host.textContent = '正在读取仓库提交记录…';
    try {
      var out = await rpc('accremind.gov.bootstrapHistory', {topK:20});
      var commits = out.minedCommits || [];
      STATE.archCommits = commits;
      if (!commits.length) { host.textContent = out.message || '扫描已完成，当前范围内没有找到高信号提交。'; return; }
      host.innerHTML = '<p>找到 ' + commits.length + ' 个高信号提交。选择包含可复用经验的提交进行提炼。</p>' +
        (out.modelAvailable ? '' : '<p role="status">扫描已完成。配置提炼模型后可从选中提交生成候选。</p>') +
        '<label><input type="checkbox" id="arch-all" /> 选择全部提交</label>' +
        commits.map(function(c) {
          return '<article class="prism-card"><label><input type="checkbox" data-arch-sha="' + esc(c.commitSha) + '" /> ' +
            '<code>' + esc(c.commitSha.slice(0,8)) + '</code> ' + esc(c.subject) + '</label>' +
            '<p class="form-hint">' + esc(c.signalReasons.join(' · ')) + '</p><details><summary>查看提交差异</summary>' +
            '<pre class="code-vault">' + esc(c.diffPreview || '无可预览差异') + '</pre></details></article>';
        }).join('') + '<button class="btn btn-primary" id="arch-extract" disabled>提炼选中提交</button><div id="arch-report" aria-live="polite"></div>';
      var extract = document.getElementById('arch-extract'), selectAll = document.getElementById('arch-all');
      host.onchange = function(ev) {
        if (ev.target === selectAll) host.querySelectorAll('[data-arch-sha]').forEach(function(el){ el.checked = selectAll.checked; });
        var count = host.querySelectorAll('[data-arch-sha]:checked').length;
        selectAll.checked = count === commits.length;
        selectAll.indeterminate = count > 0 && count < commits.length;
        extract.disabled = !out.modelAvailable || count === 0;
        extract.textContent = '提炼选中提交' + (count ? '（' + count + '）' : '');
      };
      extract.onclick = async function() {
        var chosen = Array.from(host.querySelectorAll('[data-arch-sha]:checked')).map(function(el){ return el.getAttribute('data-arch-sha'); });
        if (!chosen.length) return;
        var reportHost = document.getElementById('arch-report');
        reportHost.textContent = '正在提炼 ' + chosen.length + ' 个提交…';
        scan.disabled = true;
        host.querySelectorAll('input,button').forEach(function(el){ el.disabled = true; });
        try {
          var result = await rpc('accremind.gov.bootstrapHistory', {topK:20, extractWithLlm:true, commitShas:chosen});
          var report = result.triageReport;
          if (!report) { reportHost.textContent = result.message || '未完成提炼。请检查模型配置后重试。'; return; }
          var outcomes = report.outcomes || [];
          var counts = Object.entries(report.dispositionCounts).map(function(pair){return (routingLabels[pair[0]] || pair[0]) + ' ' + pair[1];});
          reportHost.innerHTML = '<p><strong>提炼结果</strong> · ' + esc(counts.join('，')) + '</p>' +
            outcomes.map(function(o) {
              return '<div><code>' + esc(o.assessmentId) + '</code> · ' + esc(routingLabels[o.finalDisposition] || o.finalDisposition) +
                (o.duplicate ? ' · 已处理过' : '') + (o.downgradedReason ? ' · ' + esc(o.downgradedReason) : '') +
                (o.persistedEntry ? ' <button class="btn btn-sm" data-detail="' + esc(o.persistedEntry.id) + '">打开' +
                  (o.persistedEntry.status === 'probation' ? '试用草稿' : '经验') + '</button>' : '') + '</div>';
            }).join('') + '<button class="btn" id="arch-open-review">打开审核队列</button>';
          await syncAll();
          document.getElementById('arch-open-review').onclick = async function(){ reviewState = 'pending'; reviewOffset = 0; await loadPrismReview(); switchTab('review'); };
        } catch(err) { reportHost.textContent = '提炼未完成 · ' + err.message; }
        finally {
          scan.disabled = false;
          host.querySelectorAll('input').forEach(function(el){ el.disabled = false; });
          extract.disabled = !out.modelAvailable;
        }
      };
    } catch(err) { host.textContent = '无法扫描当前仓库 · ' + err.message; }
    finally { scan.disabled = false; }
  }

  async function loadGovernance() {
    var res = await rpc('accremind.gov.scanStaleness', {});
    STATE.staleData = res;
    var host = document.getElementById('gov-stale-host');
    var details = res.reviewDetails || {};
    var rows = new Map();
    (res.staleEntries || []).concat(res.suspendedEntries || []).forEach(function(e) { rows.set(e.id, e); });
    var corrupt = res.corruptedFiles || [];
    var warning = corrupt.length ? '<div class="alert-box alert-s01"><strong>有 ' + corrupt.length + ' 个文件待处理</strong>' +
      corrupt.map(function(c){ return '<p><code>' + esc(c.file_path) + '</code> · ' + esc(c.reason) + '</p>'; }).join('') + '</div>' : '';
    host.innerHTML = warning + (rows.size ? Array.from(rows.values()).map(function(e) {
      var detail = details[e.id] || {}, pending = e.freshness !== 'current', suspended = e.serving === 'suspended';
      var actionable = e.status === 'active' || e.status === 'probation';
      return '<article class="prism-card" data-govern-id="' + esc(e.id) + '"><strong>' + esc(e.title) + '</strong> ' +
        '<code>' + esc(e.id + '@r' + e.revision) + '</code>' +
        '<p>时效 ' + esc(e.freshness) + ' · 检索 ' + esc(e.serving) + '</p>' +
        (pending ? '<p>复核原因 · ' + esc(detail.reason || '缺少历史扫描原因，请核对锚点和代码版本。') + '</p>' : '') +
        (detail.anchorIssues || []).map(function(i) {return '<p>' + esc(i) + '</p>';}).join('') +
        ((detail.anchorIssues || []).length ? '<button class="btn btn-sm" data-govern-anchors>检查并重新绑定锚点</button>' : '') +
        (detail.diff ? '<details><summary>查看关联代码变更 ' + esc((detail.previousHead || detail.baselineCommit || '').slice(0,8)) + ' → ' +
          esc((detail.currentHead || '').slice(0,8)) + '</summary><pre class="code-vault">' + esc(detail.diff) + '</pre></details>' :
          pending ? '<p class="form-hint">无可显示的 Git 差异。可查看条目的证据与验证记录。</p>' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
        (e.freshness === 'stale' && actionable ? '<button class="btn" data-govern-act="requestReview">重新评估已过期经验</button> ' : '') +
        (e.freshness === 'review_due' && actionable ? '<button class="btn" data-govern-act="confirmFresh">确认当前版本仍适用</button> ' : '') +
        '<button class="btn" data-detail="' + esc(e.id) + '">查看证据与修订</button> ' +
        (actionable && e.freshness !== 'stale' ? '<button class="btn" data-govern-act="markStale">标记已过期</button> ' : '') +
        (suspended && actionable && e.freshness === 'current' ? '<button class="btn" data-govern-act="resolveConflict">复核暂停原因并恢复检索</button>' : '') + '</div></article>';
    }).join('') : '<p>当前没有需要复核或处理暂停原因的经验。</p>');
    host.onclick = async function(ev) {
      var anchors = ev.target.closest('[data-govern-anchors]');
      if (anchors) { await openEntryDrawer(anchors.closest('[data-govern-id]').getAttribute('data-govern-id'), 'gene'); return; }
      var btn = ev.target.closest('[data-govern-act]');
      if (!btn) return;
      var e = rows.get(btn.closest('[data-govern-id]').getAttribute('data-govern-id')), action = btn.getAttribute('data-govern-act');
      var confirm = action === 'confirmFresh', resolve = action === 'resolveConflict', request = action === 'requestReview';
      var conflicts = '';
      if (resolve) {
        try {
          var entry = await rpc('accremind.kb.get', {id:e.id});
          var failures = (entry.validations || []).filter(function(v){return v.outcome === 'failure';});
          conflicts = '<p><strong>已登记的反证</strong></p>' + (failures.length ? failures.map(function(v) {
            return '<div><code>r' + esc(v.revision) + '</code> · ' + esc(v.evidence_note) + '</div>';
          }).join('') : '<p>当前没有登记反证。请核对时效复核记录和恢复依据。</p>');
        } catch(err) { toast('无法读取反证记录 · ' + err.message); return; }
      }
      openDialog({
        title: btn.textContent + ' · ' + e.id + '@r' + e.revision,
        bodyHtml: confirm ? '仅更新时效与复核日期。检索状态为 <code>' + esc(e.serving) + '</code>。' :
          resolve ? conflicts + '<p>请说明此前暂停的原因如何解决。恢复后此经验可再次用于后续对话。</p>' :
          request ? '提交后进入待复核队列，继续暂停检索。' : '此经验将退出自动检索。',
        inputLabel: confirm ? undefined : (resolve ? '解决暂停原因的复核依据 *' : request ? '重新评估的依据 *' : '过期原因 *'),
        requireInput: !confirm, confirmText: btn.textContent,
        onConfirm: async function(reason) {
          await rpc('accremind.gov.' + action, {id:e.id, revision:e.revision, reason:reason,
            reviewToken:confirm && details[e.id] ? details[e.id].reviewToken : undefined});
          await syncAll();
          toast('已更新 ' + e.id);
        }
      });
    };
  }
`;
