(() => {
  'use strict';
  const examples = window.ACCREMIND_EXAMPLES;
  const projects = [{id:'accremind',name:'AccreMind',commits:window.ACCREMIND_GIT || []},...examples.projects];
  const allCommits = projects.flatMap(project => project.commits);
  const commitBySha = sha => allCommits.find(commit => commit.sha === sha);
  const screen = document.getElementById('screen');
  const drawer = document.getElementById('drawer');
  const drawerBody = document.getElementById('drawer-body');
  const theme = document.getElementById('theme');
  const toast = document.getElementById('toast');
  const storeKey = 'accremind-v32-prototype';
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storeKey)); } catch { saved = null; }
  const entries = saved?.entries || examples.entries;
  const revisions = saved?.revisions || examples.revisions;
  for (const item of [...entries,...revisions]) if (item.scope === '个人知识') item.scope = '个人技术';
  const decisions = saved?.decisions || [{id:'K-1042',rev:1,date:'2026-10-28',title:'确认 SSR 验证范围',note:'已记录真实 SSR 与 mock API 的边界。',by:'陈晓'}];
  const blankFilters = () => ({query:'',scope:'',type:'',topic:'',tag:'',status:'',eligible:false});
  const state = {
    view:'library', library:'entries', review:'queue', governance:'open', history:'all',
    filters:{entries:blankFilters(), history:blankFilters(), sources:blankFilters()},
    project:projects[0].id, pinned:projects[0].commits[0]?.sha, signal:false, mode:'map', still:false, scanned:false, receipt:false
  };
  const labels = {
    status:{candidate:'待审核',probation:'试用中',active:'已入库',archived:'已归档',withdrawn:'已撤回'},
    maturity:{draft:'草稿',verified:'已验证',proven:'多次验证'},
    freshness:{current:'当前适用',review_due:'待复核',stale:'已失效'},
    serving:{enabled:'检索启用',suspended:'检索暂停'}
  };
  const scopes = ['领域知识','项目知识','通用技术','团队规范','个人技术'];
  const types = ['排障陷阱','架构决策','规范','领域模型','操作流程'];
  const typeFields = {
    '排障陷阱':['故障现象','根因','验证范围'],
    '架构决策':['约束','备选方案','取舍'],
    '规范':['判定规则','正例与反例','例外'],
    '领域模型':['核心实体','不变量','边界场景'],
    '操作流程':['触发条件','操作顺序','失败恢复']
  };
  const stages = ['收纳','增量评估','审核／试用','正式入库'];
  const iconPaths = {
    search:'<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>',
    radar:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 19 5m-7 7h.01"/>',
    arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
    table:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-12 0v9"/>',
    scan:'<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M4 12h16"/>',
    route:'<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v7a3 3 0 0 0 3 3h7M18 16V9a3 3 0 0 0-3-3h-3"/>'
  };
  const glyph = name => `<svg class="od-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const chip = (label, tone = '') => `<span class="chip ${tone ? `tone-${tone}` : ''}">${escape(label)}</span>`;
  const statusChip = item => chip(labels.status[item.status], ({active:'cyan',probation:'blue',candidate:'warn'})[item.status]);
  const eligible = item => ['active','probation'].includes(item.status) && item.serving === 'enabled' && item.freshness === 'current';
  const present = () => entries.filter(item => ['active','probation'].includes(item.status));
  const older = () => entries.filter(item => ['archived','withdrawn'].includes(item.status));
  const current = id => entries.find(item => item.id === id);
  const getEntry = (id, revision) => {
    const item = current(id);
    return !revision || item?.rev === Number(revision) ? item : revisions.find(row => row.id === id && row.rev === Number(revision));
  };
  const dateOf = value => String(value || '').slice(0,10);
  const today = () => dateOf(new Date().toISOString());
  const project = () => projects.find(item => item.id === state.project);
  const currentCommits = () => project().commits;
  const high = () => currentCommits().filter(commit => commit.score >= 3);
  const note = message => {
    clearTimeout(note.timer);
    toast.textContent = message;
    toast.hidden = false;
    note.timer = setTimeout(() => { toast.hidden = true; }, 3600);
  };
  const save = () => {
    try { localStorage.setItem(storeKey, JSON.stringify({entries,revisions,decisions,theme:theme.value})); } catch { /* memory remains usable */ }
  };
  if (['graphite','paper','contrast'].includes(saved?.theme)) theme.value = saved.theme;
  document.documentElement.dataset.theme = theme.value;
  theme.addEventListener('change', () => { document.documentElement.dataset.theme = theme.value; save(); });
  document.querySelector('[data-act="search"]').innerHTML = glyph('search');

  const button = (label, action, attrs = '', style = '') => `<button type="button" class="${style}" data-act="${action}" ${attrs}>${label}</button>`;
  const entryButton = (item, label, style = 'row-action') => button(label,'entry',`data-id="${escape(item.id)}" data-rev="${item.rev}"`,style);
  const commitButton = (commit, label, style = '') => button(label,'commit',`data-sha="${escape(commit.sha)}"`,style);
  const tabs = (items, active, action) => `<div class="tabs" aria-label="内容视图">${items.map(([key,label,count]) => button(`${label}${count === undefined ? '' : ` <small>${count}</small>`}`, action, `data-value="${key}" aria-pressed="${key === active}"`)).join('')}</div>`;
  const table = (columns, rows, empty = '当前条件下没有记录。', footer = '') => rows.length ? `<div class="table-wrap"><table><thead><tr>${columns.map(([label,width,cls]) => `<th scope="col" style="width:${width}%" class="${cls || ''}">${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>${footer ? `<div class="table-tail">${footer}</div>` : ''}` : `<div class="empty">${empty}</div>`;
  const cell = (content, label = '', cls = '') => `<td class="${cls}"${label ? ` data-label="${label}"` : ''}>${content}</td>`;
  const info = (item, summary = true) => `<div class="od-field"><span class="entry-id">${escape(item.id)} · r${item.rev}</span>${entryButton(item,escape(item.title),'link entry-title')}${summary ? `<small>${escape(item.claim)}</small>` : ''}</div>`;
  const stageOf = item => item.stage ?? (item.status === 'candidate' ? 0 : item.status === 'probation' ? 2 : 3);
  function steps(item) {
    const currentStep = stageOf(item);
    return `<ol class="steps" aria-label="治理阶段">${stages.map((label,index) => `<li class="${index < currentStep || (index === 3 && item.status === 'active') ? 'done' : index === currentStep ? 'current' : ''}"${index === currentStep ? ' aria-current="step"' : ''}>${index + 1}. ${label}</li>`).join('')}</ol>`;
  }

  // Plot geometry and ambient texture are drawn as data graphics. Each focusable point is one commit.
  const positions = [[467,86],[389,155],[293,101],[558,146],[436,193],[314,184],[196,143],[524,63],[366,60],[629,101],[245,212],[598,198],[190,79]];
  function plotted(list) {
    const coords = list.map(commit => {
      const index = currentCommits().indexOf(commit);
      const angle = index * 2.39996;
      return {commit, index, pos:positions[index] || [380 + Math.cos(angle)*(180 + index%80),135 + Math.sin(angle)*(60 + index%48)]};
    });
    const dust = Array.from({length:157}, (_,i) => {
      const x = (i * 137.39 + 12) % 752;
      const y = (i * 53.879 + 16) % 261;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i%13 === 0 ? 1.25 : .62}" opacity="${(.12 + (i%6)*.075).toFixed(2)}"/>`;
    }).join('');
    const selected = coords.find(point => point.commit.sha === state.pinned);
    const lines = [[12,2,8,0,7,9,3,11],[6,2,1,4,11],[6,5,10],[5,1,0]];
    return `<svg viewBox="0 0 760 270" aria-label="Git 提交星图，可用 Tab 选择提交" role="group">
      <defs><radialGradient id="cloud"><stop stop-color="#4386a4" stop-opacity=".31"/><stop offset="1" stop-color="#3c76a3" stop-opacity="0"/></radialGradient><linearGradient id="ray" x2="0" y2="1"><stop stop-color="#6fedec" stop-opacity=".33"/><stop offset="1" stop-color="#6fedec" stop-opacity="0"/></linearGradient></defs>
      <g class="sky-dust">${dust}</g>
      <ellipse cx="392" cy="137" rx="258" ry="67" transform="rotate(-16 392 137)" fill="url(#cloud)"/>
      <g class="sky-grid"><ellipse cx="380" cy="135" rx="276" ry="108"/><ellipse cx="380" cy="135" rx="207" ry="80"/><ellipse cx="380" cy="135" rx="138" ry="53"/><ellipse cx="380" cy="135" rx="69" ry="26"/><path d="M78 135h604M380 17v236m-210-205 420 174m0-174L170 222" stroke-dasharray="3 5"/><path d="M365 135h30m-15-15v30"/></g>
      <g class="sweep"><path d="M380 135 552 101Q557 124 551 154Z" fill="url(#ray)"/><path d="M380 135 552 101" stroke="#6fedec" stroke-opacity=".38"/></g>
      <g class="axis-text"><text x="73" y="45">历史提交</text><text x="624" y="232">HEAD</text><text x="74" y="239">时间分布</text></g>
      <g class="connection">${lines.map(line => `<polyline points="${line.map(index => coords.find(point => point.index === index)?.pos.join(',')).filter(Boolean).join(' ')}"/>`).join('')}${selected ? `<path d="M380 135 ${selected.pos.join(' ')}"/>` : ''}</g>
      ${coords.map(({commit,index,pos:[x,y]}) => `<g class="star ${commit.score >= 3 ? 'signal' : ''} ${index === 0 ? 'newest' : ''} ${state.pinned === commit.sha ? 'selected' : ''}" tabindex="0" role="button" aria-pressed="${state.pinned === commit.sha}" aria-label="${escape(commit.sha.slice(0,8) + ' ' + commit.subject)}" data-star="${escape(commit.sha)}" style="--delay:-${(index*.43).toFixed(2)}s"><circle class="hit" cx="${x}" cy="${y}" r="16"/><circle class="halo" cx="${x}" cy="${y}" r="${index === 0 || commit.score >= 3 ? 9 : 6}"/><circle class="pick" cx="${x}" cy="${y}" r="12"/><circle class="core" cx="${x}" cy="${y}" r="${index === 0 ? 4.2 : commit.score >= 3 ? 3.7 : 2.7}"/></g>`).join('')}
    </svg>`;
  }
  function commitSummary(commit, hover = false) {
    if (!commit) return '<p class="muted">当前范围没有匹配的提交。</p>';
    return `<div class="caption">${hover ? '提交预览' : '当前选中'}</div><div class="od-cluster radar-meta"><span class="mono">${escape(commit.sha.slice(0,8))}</span><time datetime="${escape(commit.date)}">${dateOf(commit.date)}</time>${chip(commit.score >= 3 ? '高信号' : '普通提交',commit.score >= 3 ? 'cyan' : '')}</div><h3 class="commit-title od-clamp-2">${escape(commit.subject)}</h3><p class="mini-name">${commit.reasons.length ? escape(commit.reasons.join(' · ')) : `${commit.fileCount} 个变更文件 · 点击查看来源`}</p>`;
  }
  const visibleCommits = () => state.signal ? high() : currentCommits();
  const pinnedCommit = () => visibleCommits().find(commit => commit.sha === state.pinned) || visibleCommits()[0];
  function radar() {
    const selected = pinnedCommit();
    if (selected) state.pinned = selected.sha;
    const listMode = state.mode === 'list';
    return `<section class="radar full-radar ${listMode ? 'list-only' : ''}" data-still="${state.still}" aria-label="Git 历史雷达">
      <div class="radar-main"><div class="radar-title"><div class="od-row">${glyph('radar')}<small>${escape(project().name)} / HEAD</small></div><small>${listMode ? '提交列表' : '提交星图'}</small></div>
      ${listMode ? '' : `<div class="radar-map">${visibleCommits().length ? plotted(visibleCommits()) : '<p class="radar-empty">没有高信号提交，可查看全部提交。</p>'}</div>`}
      <div class="map-foot"><div class="od-cluster"><i class="dot"></i><span>普通提交</span><i class="dot signal-dot"></i><span>高信号</span><i class="dot pinned-dot"></i><span>最新提交</span></div><span>${listMode ? '列表模式' : '悬浮预览 · 点击固定'}</span></div></div>
      <aside class="radar-side"><div id="radar-summary" class="od-stack">${commitSummary(selected)}</div>
        <div class="stats" aria-label="雷达筛选"><button data-act="radar-filter" data-value="all" aria-pressed="${!state.signal}"><b>${String(currentCommits().length).padStart(2,'0')}</b><small>全部提交</small></button><button data-act="radar-filter" data-value="signals" aria-pressed="${state.signal}"><b>${String(high().length).padStart(2,'0')}</b><small>高信号</small></button></div>
        <div class="side-buttons od-cluster">${selected ? commitButton(selected,'查看文件与变更','primary') : ''}${!listMode ? button(state.still ? '开启动效' : '减少动效','still',`aria-pressed="${state.still}"`,'quiet') : ''}</div>
      </aside></section>`;
  }
  function radarPage() {
    const list = visibleCommits();
    return `<div class="view-toolbar"><div class="od-cluster"><label class="project-control">项目 <select id="radar-project">${projects.map(item => `<option value="${item.id}" ${item.id === state.project ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></label>${chip(state.project === 'demo' ? '示例历史' : '本地提交快照')}</div><div class="od-cluster">${button(`${glyph('radar')} 星图`,'radar-mode',`data-value="map" aria-pressed="${state.mode === 'map'}"`)}${button(`${glyph('table')} 列表`,'radar-mode',`data-value="list" aria-pressed="${state.mode === 'list'}"`)}${button(`${glyph('scan')} 扫描快照`,'scan')}</div></div>` + radar() +
      `<section class="content-card" aria-label="提交记录">${table([['提交',45],['日期',16],['变更文件',14],['信号',12],['操作',13]],list.map(commit => `<tr>${cell(`<div class="od-field"><span class="mono muted">${escape(commit.sha.slice(0,8))}</span>${commitButton(commit,escape(commit.subject),'link entry-title')}</div>`)}${cell(dateOf(commit.date),'日期')}${cell(`${commit.fileCount} 个`,'变更文件')}${cell(chip(commit.score >= 3 ? '高信号' : '普通',commit.score >= 3 ? 'cyan' : ''),'信号')}${cell(commitButton(commit,'查看变更','row-action'))}</tr>`),'没有高信号提交，可切回全部提交。',`${state.scanned ? '筛选完成 · ' : ''}当前显示 ${list.length} 条提交`)}</section>`;
  }

  const select = (name, label, all, values, value) => `<label>${label}<select data-filter="${name}"><option value="">${all}</option>${values.map(([key,text]) => `<option value="${escape(key)}" ${value === key ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`;
  const pairs = values => values.map(value => [value,value]);
  const unique = values => [...new Set(values.filter(Boolean))];
  const recordFor = item => ({...examples.records[item.id],...examples.records[`${item.id}@${item.rev}`],...item.content});
  const sourceFor = item => item.source || recordFor(item).source || (item.commit ? {kind:'git',sha:item.commit} : {kind:'manual'});
  const sourceLabels = {git:'Git 提交',dialog:'对话回合',doc:'文档',manual:'人工录入'};
  function sourceLocator(source) {
    if (source.kind === 'git') return source.sha?.slice(0,8) || '待定位';
    if (source.kind === 'dialog') return source.id;
    return source.path || '';
  }
  function libraryTabs() {
    return tabs([['entries','经验条目',present().length],['sources','来源导航',examples.sources.length],['history','历史记录',older().length+revisions.length]],state.library,'library-tab');
  }
  function filterBar() {
    const filter = state.filters[state.library];
    const isEntries = state.library === 'entries';
    const options = [...present(),...older(),...revisions];
    return `<div class="filters"><label class="query">关键词<span class="search-field">${glyph('search')}<input id="library-query" data-filter="query" placeholder="名称 / 标签 / 来源编号" value="${escape(filter.query)}"></span></label>
      ${state.library === 'sources' ? '' : `${isEntries ? '' : select('scope','归属','全部归属',pairs(scopes),filter.scope)}${select('type','分类','全部分类',pairs(types),filter.type)}${select('topic','主题','全部主题',pairs(unique(options.map(item => item.topic))),filter.topic)}${select('tag','标签','全部标签',pairs(unique(options.flatMap(item => item.tags))),filter.tag)}`}
      ${isEntries ? `${select('status','状态','全部状态',[['active','已入库'],['probation','试用中'],['review_due','待复核'],['suspended','检索暂停']],filter.status)}<label class="checklabel"><input type="checkbox" data-filter="eligible" ${filter.eligible ? 'checked' : ''}>可自动检索</label>` : ''}${button('清空','clear','','quiet')}</div>`;
  }
  const textMatch = (query, values) => query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => values.join(' ').toLowerCase().includes(word));
  const entryMatch = (item, filter) => textMatch(filter.query,[item.id,`${item.id}@r${item.rev}`,item.title,item.claim,item.topic,item.scope,item.type,sourceLocator(sourceFor(item)),sourceLabels[sourceFor(item).kind],...item.tags,...(item.aliases || [])]) &&
    (!filter.scope || item.scope === filter.scope) && (!filter.type || item.type === filter.type) && (!filter.topic || item.topic === filter.topic) &&
    (!filter.tag || item.tags.includes(filter.tag)) && (!filter.status || [item.status,item.serving,item.freshness].includes(filter.status)) && (!filter.eligible || eligible(item));
  function libraryResults() {
    const filter = state.filters[state.library];
    const noResults = `没有匹配项。${button('清空筛选','clear','','quiet')}`;
    if (state.library === 'sources') {
      const sources = examples.sources.filter(source => textMatch(filter.query,[source.title,source.path,source.id,source.kind]));
      return table([['名称',36],['来源位置',38],['来源类型',14],['关联经验',12]],sources.map(source => `<tr>${cell(escape(source.title))}${cell(`<code>${escape(source.path)}</code>`,'位置')}${cell(chip(source.kind),'类型')}${cell(entryButton(current(source.id),'打开'))}</tr>`), noResults,`共 ${sources.length} 条 · 示例来源`);
    }
    if (state.library === 'history') {
      const historyRows = [...(state.history !== 'revisions' ? older() : []),...(state.history !== 'archived' ? revisions : [])].filter(item => entryMatch(item,filter)).sort((a,b) => b.date.localeCompare(a.date));
      return table([['知识条目',42],['历史类型',14],['原因',25],['日期',12],['操作',7]],historyRows.map(item => `<tr>${cell(info(item,false))}${cell(chip(older().includes(item) ? labels.status[item.status] : '旧修订'),'历史类型')}${cell(escape(item.reason || '保留前一版结论与证据。'),'原因')}${cell(`<time>${dateOf(item.date)}</time>`,'日期')}${cell(entryButton(item,'查看'))}</tr>`),noResults,`共 ${historyRows.length} 条历史记录`);
    }
    const rows = present().filter(item => entryMatch(item,filter));
    return table([['名称与结论',30],['归属 / 分类',14],['主题与标签',17],['来源',15],['治理状态',16],['轨迹',8]], rows.map(item => {
      const source = sourceFor(item);
      return `<tr>${cell(info(item))}${cell(`<div class="od-field"><span>${escape(item.scope)}</span><small>${escape(item.type)}</small></div>`,'归属 / 分类')}${cell(`<div class="od-field"><span>${escape(item.topic || '未归类')}</span><div class="od-cluster cluster-tight">${item.tags.map(tag => `<span class="chip tag">${escape(tag)}</span>`).join('')}</div></div>`,'主题与标签')}${cell(`<div class="od-field"><span>${sourceLabels[source.kind]}</span><small class="od-clamp-2">${escape(sourceLocator(source))}</small></div>`,'来源')}${cell(`<div class="od-cluster cluster-tight">${statusChip(item)}${item.freshness === 'review_due' ? chip('待复核','warn') : ''}${item.serving === 'suspended' ? chip('检索暂停','danger') : ''}</div>`,'治理状态')}${cell(button(glyph('route'),'trajectory',`data-id="${escape(item.id)}" data-rev="${item.rev}" aria-label="查看治理轨迹" title="查看治理轨迹"`,'square trajectory'))}</tr>`;
    }),noResults,`共 ${rows.length} 条经验 · ${rows.filter(eligible).length} 条可自动检索`);
  }
  function libraryPage() {
    const scope = state.filters.entries.scope;
    const scopeButtons = state.library === 'entries' ? `<div class="scope-strip od-cluster" aria-label="知识归属">${[['','全部归属'],...pairs(scopes)].map(([value,label]) => button(label,'scope',`data-value="${escape(value)}" aria-pressed="${scope === value}"`)).join('')}</div>` : '';
    return `<section class="content-card library-card" id="knowledge-table" aria-label="知识库">${libraryTabs()}${scopeButtons}${filterBar()}${state.library === 'history' ? tabs([['all','全部历史'],['archived','归档与撤回'],['revisions','旧修订']],state.history,'history-tab') : ''}<div id="library-results">${libraryResults()}</div></section>`;
  }

  function reviewPage() {
    const draft = entries.filter(item => ['candidate','probation'].includes(item.status));
    const processed = entries.filter(item => decisions.some(event => event.id === item.id && ['正式入库','归档候选'].includes(event.title)));
    const list = state.review === 'queue' ? draft : processed;
    return `<section class="content-card" aria-label="候选审核">${tabs([['queue','待处理',draft.length],['processed','已处理',processed.length]],state.review,'review-tab')}${table([['候选知识',31],['分类与来源',21],['流转阶段',31],['下一步',17]],list.map(item => `<tr>${cell(info(item))}${cell(`<div class="od-field"><span>${escape(item.scope)} · ${escape(item.type)}</span><small>${sourceLabels[sourceFor(item).kind]} · ${escape(item.tags.join('、') || '无标签')}</small></div>`,'分类与来源')}${cell(steps(item),'流转阶段')}${cell(entryButton(item,item.status === 'probation' ? '查看试用' : '查看审核','row-action'))}</tr>`),'暂无候选。可从 Git 提交或回合记录提取候选。')}</section>`;
  }
  function governancePage() {
    const todo = present().filter(item => item.reasons?.length || item.serving === 'suspended');
    let contents;
    if (state.governance === 'settings') {
      contents = `<div class="section-head"><div><h3>仓库历史</h3><p>打开雷达，从本地快照检查历史提交。</p></div>${button('打开 Git 雷达','radar-open','','primary')}</div><div class="section-head"><div><h3>历史经验</h3><p>查阅旧修订及归档、撤回记录。</p></div>${button('查看历史','jump-history')}</div>`;
    } else if (state.governance === 'done') {
      contents = table([['知识与修订',35],['处理结果',22],['依据',28],['时间',15]], [...decisions].reverse().map(event => {
        const item = getEntry(event.id,event.rev) || current(event.id);
        return `<tr>${cell(item ? info(item,false) : escape(event.id))}${cell(escape(event.title),'处理结果')}${cell(`${escape(event.note)}<small>${escape(event.by)}</small>`,'依据')}${cell(dateOf(event.date),'时间')}</tr>`;
      }), '暂无已处理记录。');
    } else {
      contents = table([['知识与修订',34],['待办原因',26],['影响',22],['最近证据',10],['操作',8]], todo.map(item => `<tr>${cell(info(item,false))}${cell(`<div class="od-cluster cluster-tight">${(item.reasons || []).map(reason => chip(reason,'warn')).join('') || chip('可恢复检索','cyan')}</div>`,'待办原因')}${cell(labels.serving[item.serving],'影响')}${cell(dateOf(item.date),'最近证据')}${cell(entryButton(item,'处理'))}</tr>`),'暂无治理待办。');
    }
    return `<section class="content-card" aria-label="知识治理">${tabs([['open','治理待办',todo.length],['done','已处理',decisions.length],['settings','设置']],state.governance,'governance-tab')}${contents}</section>`;
  }
  function receiptsPage() {
    const rows = examples.receipts.map(receipt => `<tr>${cell(`<div class="od-field"><span class="entry-id">${receipt.id}</span>${button(escape(receipt.title),'receipt',`data-id="${receipt.id}"`,'link entry-title')}</div>`)}${cell(chip(receipt.trigger,'blue'),'触发')}${cell(escape(receipt.summary),'摘要')}${cell(button('查看回合','receipt',`data-id="${receipt.id}"`,'row-action'))}</tr>`);
    return `<section class="content-card" aria-label="回合记录">${table([['对话任务',24],['触发',16],['记录摘要',46],['操作',14]],rows,'暂无回合记录。','示例对话 · 可从回合中提取候选')}</section>`;
  }

  function attachRadar() {
    const summary = document.getElementById('radar-summary');
    if (!summary) return;
    for (const point of screen.querySelectorAll('[data-star]')) {
      const commit = commitBySha(point.dataset.star);
      const show = () => { summary.innerHTML = commitSummary(commit,commit.sha !== state.pinned); };
      const reset = () => { summary.innerHTML = commitSummary(pinnedCommit()); };
      const pin = () => {
        state.pinned = commit.sha;
        for (const star of screen.querySelectorAll('[data-star]')) {
          const selected = star === point;
          star.classList.toggle('selected',selected);
          star.setAttribute('aria-pressed',String(selected));
        }
        const detailTrigger = screen.querySelector('.radar-side [data-act="commit"]');
        if (detailTrigger) detailTrigger.dataset.sha = commit.sha;
        reset();
      };
      point.addEventListener('pointerenter',show);
      point.addEventListener('pointerleave',() => { if (document.activeElement !== point) reset(); });
      point.addEventListener('focus',show);
      point.addEventListener('blur',reset);
      point.addEventListener('click',pin);
      point.addEventListener('keydown',event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); pin(); } });
    }
  }
  function render(keepControl) {
    const pages = {library:libraryPage, radar:radarPage, review:reviewPage, governance:governancePage, receipts:receiptsPage};
    const active = state.view;
    for (const item of document.querySelectorAll('.main-nav [data-nav]')) {
      if (item.dataset.nav === active) item.setAttribute('aria-current','page');
      else item.removeAttribute('aria-current');
    }
    screen.innerHTML = pages[state.view]();
    attachRadar();
    if (keepControl?.act && !drawer.open) {
      [...screen.querySelectorAll('[data-act]')].find(control => control.dataset.act === keepControl.act && control.dataset.value === keepControl.value)?.focus({preventScroll:true});
    }
  }
  function navigate(view) {
    state.view = view;
    if (drawer.open) { returnControl = null; drawer.close(); }
    render();
    window.scrollTo(0,0);
    screen.focus({preventScroll:true});
  }

  let returnControl;
  function openDrawer(title, content) {
    if (!drawer.open) returnControl = document.activeElement;
    document.getElementById('drawer-title').textContent = title;
    drawerBody.innerHTML = content;
    if (!drawer.open) drawer.showModal();
    drawer.scrollTop = 0;
    (drawerBody.querySelector('[data-autofocus]') || drawer.querySelector('[data-act="close"]')).focus();
  }
  drawer.addEventListener('close', () => {
    if (returnControl?.isConnected) returnControl.focus({preventScroll:true});
    else screen.focus({preventScroll:true});
    returnControl = null;
  });
  const section = (title, content) => `<section class="detail-section"><h3>${title}</h3>${content}</section>`;
  const stateLine = item => `<div class="od-cluster">${statusChip(item)}${chip(labels.maturity[item.maturity],'blue')}${chip(labels.freshness[item.freshness],item.freshness === 'current' ? 'cyan' : 'warn')}${chip(labels.serving[item.serving],item.serving === 'suspended' ? 'danger' : '')}</div>`;
  function showEntry(item, focusTrajectory = false) {
    if (!item) return;
    const live = current(item.id) === item;
    const isCandidate = live && ['candidate','probation'].includes(item.status);
    const source = sourceFor(item);
    const record = recordFor(item);
    const commit = commitBySha(source.sha);
    const trajectory = [...item.trail].reverse();
    const previous = revisions.filter(row => row.id === item.id && row.rev !== item.rev);
    const reasonButtons = (item.reasons || []).map(reason => button(escape(`处理${reason}`),'decision',`data-id="${escape(item.id)}" data-value="${escape(reason)}"`));
    if (live && item.status === 'active' && item.serving === 'suspended' && !item.reasons?.length && item.freshness === 'current') reasonButtons.push(button('恢复检索','decision',`data-id="${escape(item.id)}" data-value="恢复检索"`,'primary'));
    const next = item.status === 'probation' || item.stage === 2 ? '正式入库' : item.stage === 1 ? '送审核／试用' : '完成增量评估';
    const cta = isCandidate ? `<div class="od-cluster">${button(next,'decision',`data-id="${escape(item.id)}" data-value="${next}"`,'primary')}${button('登记待补证','decision',`data-id="${escape(item.id)}" data-value="登记待补证"`)}${button('归档候选','decision',`data-id="${escape(item.id)}" data-value="归档候选"`,'quiet')}</div>` : '';
    const related = (record.relations || []).map(([relation,id,context]) => {
      const target = current(id);
      return target ? `<div class="relation-row od-field"><div class="od-cluster">${chip(relation,'blue')}${entryButton(target,escape(target.title),'link')}</div><small>${escape(context)}</small></div>` : '';
    }).join('');
    const sourceLink = commit ? commitButton(commit,`查看 Git 提交 ${escape(sourceLocator(source))}`,'quiet') : source.kind === 'dialog' ? button(`查看对话 ${escape(source.id)}`,'receipt',`data-id="${escape(source.id)}"`,'quiet') : source.path ? `<p><code>${escape(source.path)}</code></p>` : '';
    openDrawer(item.title, `<div class="od-cluster"><span class="mono muted">${escape(item.id)}@r${item.rev}</span><time class="muted">${dateOf(item.date)}</time>${!live ? chip('历史修订','warn') : ''}</div>${stateLine(item)}
      ${section('结论与适用条件',`<p>${escape(item.claim)}</p><p>${escape(item.condition)}</p>${item.baseline ? `<p>代码基线 · ${escape(item.baseline)}</p>` : ''}`)}
      ${section('归属、分类与标签',`<div class="od-cluster">${chip(item.scope)}${chip(item.type)}${chip(item.topic || '未归类')}${item.tags.map(tag => chip(tag,'blue')).join('')}</div>${live && !['archived','withdrawn'].includes(item.status) ? button('整理分类与标签','classify',`data-id="${escape(item.id)}"`,'quiet') : ''}`)}
      ${(record.details || []).map(([title,text]) => section(escape(title),`<p>${escape(text)}</p>`)).join('')}
      ${record.code ? section('示例代码',`<pre class="code-block"><code>${escape(record.code)}</code></pre>`) : ''}
      ${section('来源与证据',`<div class="od-cluster">${chip(sourceLabels[source.kind],'blue')}${sourceLink}</div><p>${escape(item.evidence || '暂无证据。')}</p>`)}
      ${section('关联知识',related || '<p>暂无已登记的知识关系。</p>')}
      ${section('治理轨迹',`<div id="entry-trajectory" tabindex="-1">${steps(item)}</div><ol class="timeline">${trajectory.map(event => `<li class="event"><strong>${escape(event.title)}</strong><small>${dateOf(event.date)} · ${escape(event.by)}</small><p>${escape(event.note)}</p></li>`).join('')}</ol>${cta}${live && item.status === 'active' && reasonButtons.length ? `<div class="od-cluster">${reasonButtons.join('')}</div>` : ''}`)}
      ${section('历史修订',`${item.reason ? `<p>${escape(item.reason)}</p>` : ''}<div class="od-cluster">${!live ? entryButton(current(item.id),'打开现行修订') : ''}${item.replacement && current(item.replacement) ? entryButton(current(item.replacement),'打开替代经验') : ''}${previous.map(row => entryButton(row,`${escape(row.id)}@r${row.rev}`)).join('') || (live && !item.replacement ? '<span class="muted">暂无其他修订</span>' : '')}</div>`)}`);
    if (focusTrajectory) drawerBody.querySelector('#entry-trajectory').focus();
  }
  const changeLabels = {A:'新增',M:'修改',D:'删除',T:'类型变更'};
  function fileChanges(commit) {
    const files = commit.changes || window.ACCREMIND_DIFFS?.[commit.sha] || [];
    return files.length ? `<p>共 ${files.length} 个文件。展开文件可查看差异。</p><div class="file-changes">${files.map(file => `<details><summary><span class="chip ${file.status === 'A' ? 'tone-cyan' : file.status === 'D' ? 'tone-danger' : ''}">${changeLabels[file.status] || '变更'}</span><code>${escape(file.path)}</code></summary>${file.patch ? `<pre class="code-block diff"><code>${file.patch.split('\n').map(line => `<span class="${line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : ''}">${escape(line)}</span>`).join('\n')}</code></pre>` : '<p>没有可预览的文本差异。</p>'}${file.limited ? '<p class="muted">预览已截断，可在本地仓库查看完整差异。</p>' : ''}</details>`).join('')}</div>` : '<p>快照中没有文件差异。</p>';
  }
  function showCommit(commit) {
    if (!commit) return;
    const linked = entries.filter(item => sourceFor(item).sha === commit.sha);
    const repository = projects.find(item => item.commits.includes(commit));
    openDrawer('Git 提交详情', `<div class="od-cluster">${chip(commit.score >= 3 ? '高信号' : '普通提交',commit.score >= 3 ? 'cyan' : '')}<time datetime="${escape(commit.date)}">${dateOf(commit.date)}</time></div><h3>${escape(commit.subject)}</h3><code class="muted">${escape(commit.sha)}</code>${commit.body ? `<p>${escape(commit.body)}</p>` : ''}
      ${section('信号依据',`<p>${escape(commit.reasons.join(' · ') || (commit.eligible ? '没有命中高信号规则。' : '这条提交超出当前高信号筛选口径。'))}</p>`)}
      ${section('变更文件与差异',`<p class="muted">${escape(repository.name)}</p>${fileChanges(commit)}`)}
      ${section('从提交沉淀的知识',`${linked.length ? `<div class="od-stack">${linked.map(item => `<div class="od-cluster">${statusChip(item)}${entryButton(item,escape(item.title),'link')}</div>`).join('')}</div>` : '<p>暂无关联知识。</p>'}${button('提取候选知识','intake',`data-sha="${escape(commit.sha)}"`,'primary')}`)}`);
  }
  function showReceipt(receipt) {
    if (!receipt) return;
    const historic = getEntry(receipt.knowledge,receipt.rev);
    const linked = entries.filter(item => sourceFor(item).id === receipt.id);
    openDrawer(receipt.title,`<div class="od-cluster">${chip(receipt.id)}${chip(receipt.trigger,'blue')}${chip('示例对话')}</div>
      ${section('回合记录',`<p>${escape(receipt.summary)}</p>`)}
      ${historic ? section('当时引用的修订',entryButton(historic,`${historic.id}@r${historic.rev} · ${escape(historic.title)}`,'link')) : ''}
      ${section('从对话沉淀的知识',`${linked.length ? `<div class="od-stack">${linked.map(item => `<div class="od-cluster">${statusChip(item)}${entryButton(item,escape(item.title),'link')}</div>`).join('')}</div>` : '<p>暂无关联知识。</p>'}${button('提取候选知识','intake-dialog',`data-id="${receipt.id}"`,'primary')}`)}`);
  }

  function addEvent(item, title, basis) {
    const event = {date:today(),title,by:'当前操作者',note:basis};
    item.trail.push(event);
    decisions.push({...event,id:item.id,rev:item.rev});
    item.date = event.date;
  }
  function afterMutation(item, message) {
    save();
    render();
    if (!returnControl?.isConnected) {
      returnControl = [...screen.querySelectorAll('[data-act="entry"]')].find(control => control.dataset.id === item.id) || screen;
    }
    showEntry(item);
    note(message);
  }
  function showDecision(item, action) {
    if (!item) return;
    const descriptions = {
      '完成增量评估':'对照现有代码和文档，记录本次候选提供的额外信息。',
      '送审核／试用':'审核通过后进入本机试用，仍可补证或归档。',
      '正式入库':'批准当前条目进入正式知识库，保留判定依据。',
      '登记待补证':'保留当前阶段，注明缺少的证据。',
      '归档候选':'从待处理队列移出，可在知识库历史记录回查。',
      '时效待复核':'确认当前版本仍适用，只结清时效待办。',
      '反证与冲突':'写明如何核对反证。若检索已暂停，仍需单独恢复。',
      '来源与文件异常':'记录新的来源定位或复核结果。',
      '恢复检索':'核对反证和时效后，登记恢复依据。'
    };
    openDrawer(action, `<p class="notice">${escape(descriptions[action] || '记录本次处理的证据和结果。')}</p><div class="form" data-form="decision" data-id="${escape(item.id)}" data-value="${escape(action)}"><label>处理依据（必填）<textarea name="basis" data-autofocus required></textarea></label><div class="od-cluster">${button('确认提交','submit','','primary')}${entryButton(item,'返回条目','quiet')}</div><p class="muted" data-form-error hidden></p></div>`);
  }
  function applyDecision(item, action, basis) {
    let result = action;
    if (action === '完成增量评估') item.stage = 1;
    else if (action === '送审核／试用') { item.stage = 2; item.status = 'probation'; item.serving = 'enabled'; }
    else if (action === '正式入库') { item.stage = 3; item.status = 'active'; item.serving = 'enabled'; }
    else if (action === '归档候选') { item.stage = stageOf(item); item.status = 'archived'; item.reason = basis; item.serving = 'suspended'; }
    else if (action === '恢复检索') item.serving = 'enabled';
    else if (item.reasons?.includes(action)) {
      item.reasons = item.reasons.filter(reason => reason !== action);
      if (action === '时效待复核') item.freshness = 'current';
      result = `已处理 · ${action}`;
    }
    addEvent(item,result,basis);
    afterMutation(item,'处理结果已写入示例轨迹');
  }
  const fieldSelect = (name,label,options,active) => `<label>${label}<select name="${name}">${options.map(option => `<option ${option === active ? 'selected' : ''}>${escape(option)}</option>`).join('')}</select></label>`;
  const typedFields = (type, previous = []) => typeFields[type].map((label,index) => `<label>${label}<textarea name="detail-${index}">${escape(previous[index])}</textarea></label>`).join('');
  function entryForm(item, commit, receipt) {
    const edit = Boolean(item);
    const title = edit ? '整理分类与标签' : commit ? '从 Git 提取候选' : receipt ? '从对话提取候选' : '录入经验';
    openDrawer(title, `<div class="form" data-form="entry" data-id="${escape(item?.id)}" data-sha="${escape(commit?.sha)}" data-receipt="${escape(receipt?.id)}">
      ${commit ? `<p class="notice">关联提交 ${escape(commit.sha.slice(0,8))} · ${escape(commit.subject)}</p>` : ''}
      ${receipt ? `<p class="notice">对话 ${escape(receipt.id)} · ${escape(receipt.title)}\n${escape(receipt.summary)}</p>` : ''}
      ${commit || receipt ? '<p class="muted">从上方材料整理可复用的结论，再提交审核。</p>' : ''}
      ${edit ? '' : `<label>标题（必填）<input name="title" data-autofocus maxlength="100" required></label><label>可复用结论（必填）<textarea name="claim" required></textarea></label><label>适用条件<input name="condition" maxlength="240"></label><label>检验依据或来源<textarea name="evidence"></textarea></label>`}
      <div class="od-grid">${fieldSelect('scope','归属',scopes,item?.scope)}${fieldSelect('type','类型',types,item?.type)}</div>
      <div class="od-grid"><label>主题<input name="topic" value="${escape(item?.topic)}" maxlength="24" ${edit ? 'data-autofocus' : ''}></label><label>标签（逗号分隔）<input name="tags" maxlength="80" value="${escape(item?.tags.join('，'))}"></label></div>
      ${edit ? '' : `<details class="form-extra"><summary>补充分类详情和代码片段</summary><div class="form" data-type-fields>${typedFields(types[0])}</div><label>代码片段<textarea name="snippet" spellcheck="false"></textarea></label></details>`}
      <div class="od-cluster">${button(edit ? '保存分类' : '收纳到候选审核','submit','','primary')}${edit ? entryButton(item,'返回条目','quiet') : button('取消','close','','quiet')}</div><p class="muted" data-form-error hidden></p></div>`);
  }
  function submit(form) {
    if (!form) return;
    const value = name => form.querySelector(`[name="${name}"]`)?.value.trim() || '';
    const invalid = (field,message) => {
      const error = form.querySelector('[data-form-error]');
      error.textContent = message;
      error.hidden = false;
      form.querySelector(`[name="${field}"]`)?.focus();
    };
    if (form.dataset.form === 'decision') {
      const item = current(form.dataset.id);
      if (item && value('basis')) applyDecision(item,form.dataset.value,value('basis'));
      else invalid('basis','请填写处理依据。');
      return;
    }
    const taxonomy = {scope:value('scope'),type:value('type'),topic:value('topic'),tags:unique(value('tags').split(/[,，、]/).map(tag => tag.trim())).slice(0,8)};
    const item = current(form.dataset.id);
    if (item) {
      const old = `${item.scope}／${item.type}／${item.topic || '未归类'}／${item.tags.join('、') || '无标签'}`;
      const next = `${taxonomy.scope}／${taxonomy.type}／${taxonomy.topic || '未归类'}／${taxonomy.tags.join('、') || '无标签'}`;
      if (old === next) { showEntry(item); return; }
      revisions.push({...item, tags:[...item.tags], trail:[...item.trail], reason:'分类与标签已更新，旧修订留档。'});
      Object.assign(item,taxonomy,{rev:item.rev+1});
      addEvent(item,'整理分类与标签',`${old} → ${next}`);
      afterMutation(item,'分类已更新，旧修订可从历史查看');
      return;
    }
    if (!value('title')) { invalid('title','请填写知识标题。'); return; }
    if (!value('claim')) { invalid('claim','请填写可复用的知识结论。'); return; }
    const newId = `K-${Math.max(1052,...entries.map(row => Number(row.id.split('-')[1]) || 0))+1}`;
    const sha = form.dataset.sha;
    const receipt = form.dataset.receipt;
    const source = sha ? {kind:'git',sha} : receipt ? {kind:'dialog',id:receipt} : {kind:'manual'};
    const details = typeFields[taxonomy.type].map((label,index) => [label,value(`detail-${index}`)]).filter(([,text]) => text);
    const content = {details,code:value('snippet')};
    const candidate = {id:newId,rev:1,title:value('title'),claim:value('claim'),condition:value('condition') || '待核对适用条件。',evidence:value('evidence'),...taxonomy,status:'candidate',maturity:'draft',freshness:'current',serving:'suspended',stage:0,source,content,date:today(),trail:[]};
    entries.unshift(candidate);
    addEvent(candidate,'收纳材料',sha ? `已登记 Git 证据 ${sha.slice(0,8)}。` : receipt ? `已登记对话回合 ${receipt}。` : '人工录入，等待增量评估。');
    state.view = 'review';
    state.review = 'queue';
    window.scrollTo(0,0);
    afterMutation(candidate,'候选已收纳，可继续评估');
  }

  function globalResults(query) {
    const matches = item => entryMatch(item,{...blankFilters(),query});
    const group = (title,list) => section(title,list.length ? `<div class="od-stack">${list.map(item => entryButton(item,`${escape(item.id)}@r${item.rev} · ${escape(item.title)}`,'link')).join('')}</div>` : '<p>没有匹配项</p>');
    const sources = unique(examples.sources.filter(source => textMatch(query,[source.title,source.path,source.id])).map(source => source.id)).map(current).filter(Boolean);
    return group('经验条目',present().filter(matches)) + group('来源导航',sources) + group('历史记录',[...older(),...revisions].filter(matches));
  }
  function showSearch() {
    openDrawer('搜索知识',`<div class="form"><label>关键词<input id="global-query" data-autofocus placeholder="标题 / ID@修订 / 代码术语"></label></div><div id="global-results">${globalResults('')}</div>`);
  }

  function updateResults() {
    const results = document.getElementById('library-results');
    if (results) results.innerHTML = libraryResults();
  }
  document.addEventListener('input',event => {
    const input = event.target;
    if (input.id === 'global-query') document.getElementById('global-results').innerHTML = globalResults(input.value);
    if (input.dataset.filter === 'query') { state.filters[state.library].query = input.value; updateResults(); }
  });
  document.addEventListener('change',event => {
    const input = event.target;
    if (input.name === 'type') {
      const detailFields = input.closest('[data-form]')?.querySelector('[data-type-fields]');
      if (detailFields) {
        const previous = [...detailFields.querySelectorAll('textarea')].map(field => field.value);
        detailFields.innerHTML = typedFields(input.value,previous);
      }
    }
    if (input.id === 'radar-project') {
      state.project = input.value;
      state.pinned = currentCommits()[0]?.sha;
      state.signal = false;
      state.scanned = false;
      render();
      document.getElementById('radar-project')?.focus();
      return;
    }
    const field = input.dataset.filter;
    if (!field || field === 'query') return;
    state.filters[state.library][field] = input.type === 'checkbox' ? input.checked : input.value;
    updateResults();
  });
  document.addEventListener('keydown',event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showSearch(); }
    if (event.key === 'Enter' && !event.isComposing && event.target.matches('input:not([type=checkbox])')) {
      const form = event.target.closest('[data-form]');
      if (form) { event.preventDefault(); submit(form); }
    }
  });
  document.addEventListener('click',event => {
    const control = event.target.closest('button[data-nav],button[data-act]');
    if (!control || control.disabled) return;
    const {nav,act,value,id,rev,sha} = control.dataset;
    if (nav) { navigate(nav); return; }
    switch (act) {
      case 'search': showSearch(); break;
      case 'new': entryForm(); break;
      case 'close': drawer.close(); break;
      case 'entry': showEntry(getEntry(id,rev)); break;
      case 'trajectory': showEntry(getEntry(id,rev),true); break;
      case 'commit': showCommit(commitBySha(sha)); break;
      case 'intake': entryForm(null,commitBySha(sha)); break;
      case 'receipt': showReceipt(examples.receipts.find(row => row.id === id)); break;
      case 'intake-dialog': entryForm(null,null,examples.receipts.find(row => row.id === id)); break;
      case 'classify': entryForm(current(id)); break;
      case 'decision': showDecision(current(id),value); break;
      case 'submit': submit(control.closest('[data-form]')); break;
      case 'radar-open': navigate('radar'); break;
      case 'library-back': navigate('library'); break;
      case 'jump-history': state.library = 'history'; navigate('library'); document.getElementById('knowledge-table')?.scrollIntoView(); break;
      case 'radar-filter': state.signal = value === 'signals'; render(control.dataset); break;
      case 'radar-mode': state.mode = value; render(control.dataset); break;
      case 'still': state.still = !state.still; render(control.dataset); break;
      case 'scan': state.scanned = true; render(control.dataset); note(`已检查 ${currentCommits().length} 条快照提交，命中 ${high().length} 条高信号。`); break;
      case 'scope': state.filters.entries.scope = value; render(control.dataset); break;
      case 'library-tab': state.library = value; render(control.dataset); break;
      case 'history-tab': state.history = value; render(control.dataset); break;
      case 'review-tab': state.review = value; render(control.dataset); break;
      case 'governance-tab': state.governance = value; render(control.dataset); break;
      case 'simulate': state.receipt = true; render(control.dataset); note('已显示两条命中示例'); break;
      case 'clear': state.filters[state.library] = blankFilters(); render(control.dataset); document.getElementById('library-query')?.focus(); break;
      default: break;
    }
  });
  render();
})();
