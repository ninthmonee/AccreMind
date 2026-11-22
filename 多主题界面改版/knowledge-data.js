// Demonstration knowledge records based on the V3.2 product examples.
(() => {
  const [webui, capture, storage] = window.ACCREMIND_GIT || [];
  const entry = (id, title, claim, type, scope, topic, tags, status, maturity, freshness, serving, commit, extra = {}) => ({
    id, rev: 1, title, claim, type, scope, topic, tags, status, maturity, freshness, serving,
    commit: commit?.sha, date: '2026-11-17', condition: '仅适用于下述示例工作区和已验证范围。',
    evidence: 'V3.2 产品设计示例。关联 Git 提交用于演示定位和回跳。',
    trail: [{date:'2026-11-12', title:'收纳材料', by:'示例工作区', note:'已登记来源和适用范围。'}, {date:'2026-11-13', title:'完成增量评估', by:'林岚', note:'对照代码基线，记录额外约束和证据。'}], ...extra
  });
  const active = [
    entry('K-1042','表格列偏好的合并边界','云端只覆盖显隐、冻结、顺序和列宽。新列沿用本地默认定义。','架构决策','项目知识','表格',['列偏好','状态合并'],'active','verified','review_due','suspended',webui,{rev:2,condition:'适用于共享表格 Hook 和服务端渲染页面。真实后端持久化待验证。',evidence:'来源 references/experiences/table.md。SSR 场景已验证列宽，保存接口使用 mock。',reasons:['时效待复核','反证与冲突']}),
    entry('K-1038','支付回调的幂等边界','只有本地事务提交成功后才能返回 ACK。幂等键应覆盖商户和事件。','排障陷阱','领域知识','支付回调',['幂等','事务'],'active','proven','current','enabled',capture,{rev:3,condition:'适用于支付提供方可能重放同一回调的接入。',evidence:'示例证据覆盖重复投递和事务回滚两种路径。',aliases:['idempotency_key','重复扣款','callback']}),
    entry('K-1034','弹窗内下拉层的裁剪规避','将下拉层挂到 body，并在滚动时重新定位。','排障陷阱','通用技术','表单',['浮层','Safari'],'probation','draft','current','enabled',webui,{condition:'适用于带独立滚动容器的 Modal。触摸事件失效需作为独立场景复测。',evidence:'来源 references/experiences/form.md › Modal 滚动容器裁剪。',aliases:['点击无反应','弹窗选项被截断']}),
    entry('K-1027','检索索引可从 Markdown 真源重建','索引可以重建，回执及验证记录仍需要持久化副本。','操作流程','项目知识','本地存储',['索引','SQLite'],'active','verified','current','enabled',storage),
    entry('K-1023','账务金额使用最小货币单位','结算字段按最小货币单位计算，并在接口边界明确币种。','规范','团队规范','支付回调',['金额','契约'],'active','verified','current','enabled',null),
    entry('K-1018','结算事件与订单状态保持独立','支付成功与订单完成是独立事件，由履约状态决定是否进入完成态。','领域模型','领域知识','支付回调',['状态机'],'active','draft','current','enabled',null),
    entry('K-1011','复盘保留未覆盖的验证范围','将未覆盖项和已通过的回归结果并列记录，后续可以按范围补证。','操作流程','个人知识','验证',['复盘'],'active','draft','current','enabled',capture,{reasons:['来源与文件异常']})
  ];
  const candidates = [
    entry('K-1051','重试队列的失效边界','重试窗口结束后保留失败原因，重复执行前校验任务标识。','操作流程','项目知识','自动采集',['重试','队列'],'candidate','draft','current','suspended',capture,{stage:2,baseline:'已有退避重试和过期清理。',evidence:'需要补充跨会话重试的可复核记录。'}),
    entry('K-1052','保留表单浮层的独立验证场景','触摸失效和弹窗裁剪分别登记测试环境与结论。','排障陷阱','通用技术','表单',['浮层','复测'],'candidate','draft','current','suspended',webui,{stage:1,baseline:'当前实现共用浮层挂载策略。',evidence:'示例来源 references/experiences/form.md 两个独立小节。'})
  ];
  const archived = [entry('K-1006','轮询方式同步表格列偏好','按固定间隔拉取列偏好。','架构决策','项目知识','表格',['列偏好'],'archived','verified','stale','suspended',null,{date:'2026-10-22',reason:'被按需同步方案替代。',replacement:'K-1042'}), entry('K-1002','付款失败后立即释放订单锁','检测到超时后立即释放订单锁。','排障陷阱','领域知识','支付回调',['事务'],'withdrawn','draft','stale','suspended',null,{date:'2026-10-15',reason:'迟到回调使该建议失效。',replacement:'K-1038'})];
  const revisions = [
    {...active[0], rev:1, date:'2026-10-28', claim:'云端列偏好覆盖顺序、显隐和列宽。', reason:'r2 补充冻结列与 SSR 验证范围。'},
    {...active[1], rev:2, date:'2026-10-19', claim:'按事件维度去重，再处理到账。', reason:'r3 补充多商户隔离和事务提交顺序。'}
  ];
  for (const item of [...active, ...archived, ...revisions]) {
    const approvedAt = item.date < '2026-11-16' ? item.date : '2026-11-16';
    item.trail = item.date < '2026-11-12' ? [] : [...item.trail];
    item.trail.push({date:approvedAt,title:'审核通过，进入本机试用',by:'林岚',note:`${item.scope} / ${item.type} / ${item.tags.join('、')}`});
    if (item.status !== 'probation') item.trail.push({date:approvedAt,title:'正式入库',by:'陈晓',note:`保留 ${item.id}@r${item.rev} 与来源引用。`});
    if (item.reason) item.trail.push({date:item.date,title:'记录修订去向',by:'陈晓',note:item.reason});
  }
  const receipts = [
    {id:'T-018',title:'表格列偏好调整',trigger:'回合前检索',summary:'开发者说明了后端可覆盖的四类偏好，以及新增列需要保留本地默认值的原因。',knowledge:'K-1042',rev:1},
    {id:'T-021',title:'支付回调重试',trigger:'编辑护栏',summary:'复盘记录了事务已失败但上游因提前收到 ACK 而停止重试的路径。',knowledge:'K-1038',rev:3},
    {id:'T-026',title:'回归报告覆盖范围复盘',trigger:'对话提取',summary:'复盘确认 mock 保存请求只能验证请求形状，真实后端持久化需要独立验证。',knowledge:'K-1011',rev:1}
  ];
  const records = {
    'K-1042': {source:{kind:'dialog',id:'T-018'}, details:[['约束','后端只托管已有列的可编辑偏好。默认定义必须覆盖新加的列。'],['备选方案','全量覆盖会丢失新列定义。纯本地配置会丢失跨设备偏好。'],['取舍','按列合并白名单字段，适用范围变化时重新验证。']],code:'const { visible, frozen, order, width } = remotePreference;\nreturn { ...localColumn, visible, frozen, order, width };',relations:[['补充','K-1011','用回归范围解释 SSR 和真实保存的验证差异。'],['替代','K-1006','当前使用按需同步，已归档轮询方案。']]},
    'K-1038': {source:{kind:'dialog',id:'T-021'},details:[['故障现象','回调重放时可能产生重复记账，或上游停止重试后漏记一笔。'],['根因','提前返回 ACK 会使上游停止重试。并发时单独查询是否已处理存在竞态。'],['验证范围','覆盖重复投递和事务回滚。跨区域并发需要另行验证。']],code:'await db.transaction(async tx => {\n  const inserted = await tx.reserveEvent({ merchantId, eventId });\n  if (inserted) await tx.recordPayment(event);\n});\nreturn ack();',relations:[['依赖','K-1018','结算事件与履约状态独立推进。'],['补充','K-1023','入账金额遵循账务字段规范。']]},
    'K-1034': {source:{kind:'doc',path:'references/experiences/form.md › Modal 裁剪'},details:[['故障现象','弹窗滚动到边缘时，下拉菜单被容器截断。'],['根因','弹层位于带 overflow 的滚动容器内部。'],['修复与复测','Portal 挂到 body，滚动时重新锚定。Safari 触摸问题需独立复测。']],code:'return createPortal(<Options anchor={anchorRect} />, document.body);',relations:[['补充','K-1052','候选补足两个场景各自的复测条件。']]},
    'K-1027': {source:{kind:'git',sha:storage?.sha},details:[['触发条件','索引损坏或需要重新同步本地 Markdown。'],['操作顺序','备份持久化记录，重建检索索引，再核对异常与冲突。'],['失败恢复','保留原 Markdown 与 SQLite 副本，逐条处理解析异常。']],relations:[['相关','K-1051','索引与采集队列各自保留持久化记录。']]},
    'K-1023': {source:{kind:'doc',path:'示例 › 账务接口契约'},details:[['判定规则','结算字段必须采用对应币种的最小货币单位，并显式携带币种。'],['正例与反例','1001 分用整数 1001 表示。浮点数 10.01 不进入账务事实表。'],['例外','展示层可做格式化。汇率换算按业务规则独立取整。']],code:'type SettlementAmount = { amountMinor: bigint; currency: string };',relations:[['补充','K-1038','可与支付回调的事务边界一起查阅。']]},
    'K-1018': {source:{kind:'doc',path:'示例 › 订单与结算事件约定'},details:[['核心实体','结算事件、订单和履约记录。'],['不变量','支付成功只推进结算状态，履约结果决定订单完成。'],['边界场景','退款与补偿各自产生事件，保留原事件引用。']]},
    'K-1011': {source:{kind:'dialog',id:'T-026'},details:[['复盘步骤','列出验证的主张、环境和证据位置，再单列未覆盖项。'],['验收边界','mock 保存不能证明真实后端已经持久化。']],relations:[['补充','K-1042','列偏好条目展示了如何标记真实保存待验证。']]},
    'K-1042@1': {details:[['当时的约束','只登记顺序、显隐和列宽。'],['后续修订','r2 补充冻结列及验证范围。']],code:''},
    'K-1038@2': {details:[['当时的做法','在回调入口按事件维度去重。'],['后续修订','r3 补充商户隔离及事务提交顺序。']],code:''}
  };
  const demoCommit = {sha:'demo1e4f',date:'2026-11-16T10:00:00+08:00',subject:'fix: 保留异步同步失败后的重试入口',body:'示例提交用于演示项目切换。',score:3,reasons:['命中重试与故障恢复线索'],fileCount:1,changes:[{path:'src/sync.ts',status:'M',patch:'@@ -4,1 +4,2 @@\n-  clearPending();\n+  if (result.ok) clearPending();\n+  else markRetryable();'}]};
  window.ACCREMIND_EXAMPLES = {entries:[...active,...candidates,...archived],revisions,records,receipts,projects:[{id:'demo',name:'同步服务（示例）',commits:[demoCommit]}],sources:[
    {title:'表格列偏好 · 原文章节',path:'references/experiences/table.md › 列偏好',kind:'文档链接',id:'K-1042'},
    {title:'弹窗滚动容器 · 原文章节',path:'references/experiences/form.md › Modal 裁剪',kind:'文档链接',id:'K-1034'},
    {title:'历史挖掘与候选审批 · 工作台实现',path:'packages/dsh-plugin/src/webui/workflow-client.ts',kind:'代码定位',id:'K-1051'}
  ]};
})();
