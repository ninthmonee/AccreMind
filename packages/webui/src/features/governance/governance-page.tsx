import {
  BellOff,
  Bot,
  ChevronDown,
  CircleCheck,
  Cpu,
  DatabaseZap,
  FileWarning,
  GitCompareArrows,
  Hourglass,
  PauseCircle,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  Unplug,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, IconTile, PageHeader, StatCard, stagger } from '@/components/display';
import { GovernanceBadges, PriorityBadge, TypeChip } from '@/components/entry-badges';
import { DiffView, ReasonDialog } from '@/components/reason-dialog';
import { EvidenceCompareView } from '@/components/evidence-ledger';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, Switch } from '@/components/ui/primitives';
import { rpc } from '@/lib/rpc';
import type { GovernanceQueue, KnowledgeEntry, LedgerStatus, ReviewDetails, Settings, SimResult, StalenessScan } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { cn, formatDate, shortSha } from '@/lib/utils';

type Pending = { kind: 'stale' | 'conflict' | 'reassess'; entry: KnowledgeEntry } | null;

/** 治理：代码变化触发的复核、被暂停的经验、文件问题与工作区设置。 */
export function GovernancePage() {
  const { revision, refresh } = useApp();
  // 读队列很便宜，每次操作后刷新；检查代码变更会跑 git，只在进入页面和点按钮时执行。
  const scan = useAsync(() => rpc<GovernanceQueue>('accremind.gov.reviewQueue'), [revision]);
  const [lastScan, setLastScan] = useState<StalenessScan['scan'] | null>(null);
  const [scanning, setScanning] = useState(false);
  const runScan = async () => {
    setScanning(true);
    try {
      const out = await rpc<StalenessScan>('accremind.gov.scanStaleness');
      setLastScan(out.scan);
      if (out.scan.markedReviewDue.length) toast.info(`发现 ${out.scan.markedReviewDue.length} 条经验关联的代码有变化`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };
  const scannedOnce = useRef(false);
  useEffect(() => {
    if (scannedOnce.current) return;
    scannedOnce.current = true;
    void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const settings = useAsync(() => rpc<Settings>('accremind.settings.get'), [revision]);
  const [pending, setPending] = useState<Pending>(null);
  const [tab, setTab] = useState('review');
  const s = scan.data;
  const due = s?.staleEntries.filter((e) => e.freshness === 'review_due') ?? [];
  const stale = s?.staleEntries.filter((e) => e.freshness === 'stale') ?? [];
  const suspended = s?.suspendedEntries ?? [];
  const corrupted = s?.corruptedFiles ?? [];

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={<><ShieldCheck className="size-4" /><span>让经验跟着代码一起保持正确</span></>}
        title="治理"
        description="代码改了，经验可能就不对了。这里集中处理需要复核、被暂停和文件异常的经验。"
        actions={
          <Button variant="outline" onClick={() => void runScan()} disabled={scanning}>
            <RefreshCw className={cn(scanning && 'animate-spin')} />{scanning ? '正在检查…' : '重新检查代码变更'}
          </Button>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: GitCompareArrows, tone: 'warning' as const, label: '待复核', value: due.length, caption: '关联代码有变化', tab: 'review' },
          { icon: ShieldOff, tone: 'danger' as const, label: '已失效', value: stale.length, caption: '确认不再成立，等待重写或撤回', tab: 'review' },
          { icon: PauseCircle, tone: 'neutral' as const, label: '暂停提醒', value: suspended.length, caption: '被反馈有误或多次不适用', tab: 'suspended' },
          { icon: FileWarning, tone: corrupted.length ? ('danger' as const) : ('success' as const), label: '文件问题', value: corrupted.length, caption: corrupted.length ? '有经验文件无法读取' : '所有经验文件完好', tab: 'files' },
        ].map((k, i) => (
          <div key={k.label} className="rise" style={stagger(i)}>
            <StatCard icon={k.icon} tone={k.tone} label={k.label} value={k.value} caption={k.caption} loading={scan.loading && !s} onClick={() => setTab(k.tab)} />
          </div>
        ))}
      </section>

      {lastScan && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Hourglass className="size-3.5" />
          {lastScan.skippedUnchanged ? '自上次检查以来代码没有变化' : `已检查到 ${shortSha(lastScan.currentHead ?? '—')}`}
          {lastScan.markedReviewDue.length > 0 && <Badge tone="warning">本次新增 {lastScan.markedReviewDue.length} 条待复核</Badge>}
          {lastScan.relocatedEntries.length > 0 && <Badge tone="info">自动跟随了 {lastScan.relocatedEntries.length} 处代码移动</Badge>}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="review"><GitCompareArrows />复核队列<span className="num text-xs text-muted-foreground">{due.length + stale.length}</span></TabsTrigger>
          <TabsTrigger value="suspended"><BellOff />暂停与反证<span className="num text-xs text-muted-foreground">{suspended.length}</span></TabsTrigger>
          <TabsTrigger value="files"><FileWarning />文件与索引</TabsTrigger>
          <TabsTrigger value="settings"><Settings2 />工作区设置</TabsTrigger>
        </TabsList>

        <TabsContent value="review" className="mt-4 grid gap-4">
          {scan.loading && !s ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : due.length + stale.length === 0 ? (
            <EmptyState icon={CircleCheck} title="没有需要复核的经验" description="每次检查会对比经验锚定的代码。代码变化时，相关经验会自动进入这里。" />
          ) : (
            [...due, ...stale].map((e, i) => (
              <ReviewCard
                key={e.id}
                entry={e}
                index={i}
                onConfirm={(token) => act(() => rpc('accremind.gov.confirmFresh', { id: e.id, revision: e.revision, reviewToken: token }), '已确认仍然成立')}
                onStale={() => setPending({ kind: 'stale', entry: e })}
                onReassess={() => setPending({ kind: 'reassess', entry: e })}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="suspended" className="mt-4 grid gap-3">
          {suspended.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="没有被暂停的经验" description="当经验被反馈有误、或多次被标记为不适用时，会暂停提醒 AI 并出现在这里。" />
          ) : (
            suspended.map((e, i) => <SuspendedRow key={e.id} entry={e} index={i} onResolve={() => setPending({ kind: 'conflict', entry: e })} />)
          )}
          {s && s.attentionItems.length > 0 && (
            <Card className="p-5">
              <CardTitle>需要关注</CardTitle>
              <ul className="mt-3 grid gap-2">
                {s.attentionItems.map((a) => (
                  <li key={a.entry_id + a.kind} className="flex items-center gap-3 text-sm">
                    <Badge tone="warning">{a.kind === 'probation_silent' ? '试用期满' : '不适用'}</Badge>
                    <span className="min-w-0 flex-1 truncate">{a.entry?.title ?? a.entry_id}</span>
                    <span className="text-xs text-muted-foreground">{a.reason}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="files" className="mt-4 grid gap-4 lg:grid-cols-2">
          <FilesCard corrupted={corrupted} onDone={refresh} />
          <QueueCard />
          <RuleBudgetCard />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <SettingsCard settings={settings.data} loading={settings.loading} onChanged={settings.reload} />
        </TabsContent>
      </Tabs>

      <ReasonDialog
        open={pending?.kind === 'stale'}
        onOpenChange={(o) => !o && setPending(null)}
        title="标记为失效"
        description={pending?.entry.title}
        label="为什么不再成立"
        placeholder="例如：订单服务已改为事务消息，这条约束不再适用"
        confirmLabel="标记失效"
        danger
        onConfirm={(reason) => act(() => rpc('accremind.gov.markStale', { id: pending!.entry.id, revision: pending!.entry.revision, reason }), '已标记为失效')}
      />
      <ReasonDialog
        open={pending?.kind === 'reassess'}
        onOpenChange={(o) => !o && setPending(null)}
        title="重新评估"
        description="经验会暂停提醒并回到待复核，核对后可以恢复。"
        label="重新评估的依据"
        onConfirm={(reason) => act(() => rpc('accremind.gov.requestReview', { id: pending!.entry.id, revision: pending!.entry.revision, reason }), '已送回复核')}
      />
      <ReasonDialog
        open={pending?.kind === 'conflict'}
        onOpenChange={(o) => !o && setPending(null)}
        title="解除暂停，恢复提醒"
        description={pending?.entry.title}
        label="你核实了什么"
        placeholder="例如：反馈来自旧分支，主干代码中这条经验仍然成立"
        confirmLabel="恢复提醒"
        onConfirm={(reason) => act(() => rpc('accremind.gov.resolveConflict', { id: pending!.entry.id, revision: pending!.entry.revision, reason }), '已恢复提醒')}
      />
    </div>
  );
}

function ReviewCard({
  entry: e,
  index,
  onConfirm,
  onStale,
  onReassess,
}: {
  entry: KnowledgeEntry;
  index: number;
  onConfirm: (reviewToken: string | undefined) => Promise<void>;
  onStale: () => void;
  onReassess: () => void;
}) {
  const { openEntry } = useApp();
  const [open, setOpen] = useState(index === 0);
  // 差异按需读取：只有展开的卡片才去跑 git diff；“仍然成立”需要核对过的差异令牌，未展开时先读一次。
  const [details, setDetails] = useState<ReviewDetails | null>(null);
  const loadDetails = async (): Promise<ReviewDetails | null> => {
    if (details) return details;
    try {
      const d = await rpc<ReviewDetails>('accremind.gov.reviewDetails', { id: e.id, revision: e.revision });
      setDetails(d);
      return d;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  useEffect(() => {
    if (open && !details) void loadDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const [view, setView] = useState<'evidence' | 'diff' | 'claim'>('evidence');
  const stale = e.freshness === 'stale';
  return (
    <Card className="rise overflow-hidden" style={stagger(index)}>
      <div className="flex flex-wrap items-start gap-4 p-5">
        <IconTile icon={stale ? ShieldOff : GitCompareArrows} tone={stale ? 'danger' : 'warning'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{e.id}@r{e.revision}</span>
            <PriorityBadge priority={e.priority} />
            <TypeChip type={e.type} />
          </div>
          <button type="button" onClick={() => openEntry(e.id)} className="mt-1 text-left font-medium leading-snug hover:text-primary">{e.title}</button>
          <p className="mt-1 text-sm text-muted-foreground">{details?.reason ?? '关联代码有变化'}</p>
          {details && (
            <p className="mt-2 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              {shortSha(details.previousHead ?? '—')} <span className="text-border">→</span> {shortSha(details.currentHead ?? '—')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {stale ? (
            <Button variant="outline" size="sm" onClick={onReassess}><RotateCcw />重新评估</Button>
          ) : (
            <>
              <Button variant="destructive" size="sm" onClick={onStale}><ShieldOff />已失效</Button>
              <Button size="sm" onClick={async () => { const d = await loadDetails(); if (d) await onConfirm(d.reviewToken).catch(() => undefined); }}><CircleCheck />仍然成立</Button>
            </>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={open ? '收起差异' : '展开差异'} onClick={() => setOpen((v) => !v)}>
            <ChevronDown className={cn('transition', open && 'rotate-180')} />
          </Button>
        </div>
      </div>
      {open && !details && <div className="border-t px-5 py-4"><Skeleton className="h-24 w-full rounded-lg" /></div>}
      {open && details && (
        <div className="border-t bg-muted/20 px-5 py-4 animate-in fade-in-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented<'evidence' | 'diff' | 'claim'>
              ariaLabel="对照内容"
              value={view}
              onValueChange={setView}
              items={[
                { value: 'evidence', label: '证据对照', count: details.evidence?.filter((x) => x.changed).length || undefined },
                { value: 'diff', label: '代码差异' },
                { value: 'claim', label: '经验原文' },
              ]}
            />
            {details.anchorIssues.length > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-warning"><TriangleAlert className="size-3.5" />{details.anchorIssues.join('；')}</span>
            )}
          </div>
          {view === 'evidence' ? (
            <EvidenceCompareView items={details.evidence ?? []} />
          ) : view === 'diff' ? (
            <DiffView diff={details.diff} truncated={details.truncated} />
          ) : (
            <div className="grid gap-2 rounded-lg border bg-background/60 p-4 text-sm">
              <p className="font-medium">{e.claim}</p>
              {e.preconditions.length > 0 && <p className="text-muted-foreground">适用：{e.preconditions.join('；')}</p>}
              {e.symbol_anchors.length > 0 && (
                <p className="font-mono text-xs text-muted-foreground">{e.symbol_anchors.map((a) => `${a.file_path}#${a.symbol_name}`).join('  ·  ')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SuspendedRow({ entry: e, index, onResolve }: { entry: KnowledgeEntry; index: number; onResolve: () => void }) {
  const { openEntry } = useApp();
  return (
    <Card className="rise flex flex-wrap items-center gap-4 p-4" style={stagger(index)}>
      <IconTile icon={PauseCircle} tone="neutral" />
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => openEntry(e.id)} className="text-left font-medium hover:text-primary">{e.title}</button>
        <div className="mt-1.5"><GovernanceBadges entry={e} /></div>
      </div>
      <Button variant="outline" size="sm" disabled={e.freshness !== 'current'} title={e.freshness !== 'current' ? '请先在复核队列确认时效' : undefined} onClick={onResolve}>
        <Unplug />恢复提醒
      </Button>
    </Card>
  );
}

function FilesCard({ corrupted, onDone }: { corrupted: StalenessScan['corruptedFiles']; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const rebuild = async () => {
    setBusy(true);
    try {
      const out = await rpc<{ syncedCount: number; corruptedCount: number }>('accremind.gov.rebuildIndex');
      toast.success(`搜索索引已重建，读入 ${out.syncedCount} 条经验`, out.corruptedCount ? { description: `${out.corruptedCount} 个文件需要处理` } : undefined);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>经验文件与搜索索引</CardTitle>
          <CardDescription>经验以 Markdown 保存在仓库的 .accremind/ 中，搜索索引可随时从文件重建。</CardDescription>
        </div>
        <IconTile icon={DatabaseZap} tone="info" />
      </CardHeader>
      <CardContent className="grid gap-4">
        {corrupted.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2.5 text-sm text-success"><CircleCheck className="size-4" />所有经验文件都能正常读取</p>
        ) : (
          <ul className="grid gap-2">
            {corrupted.map((f) => (
              <li key={f.file_path} className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm">
                <p className="font-mono text-xs">{f.file_path}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{f.reason} · {formatDate(f.detected_at)}</p>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" onClick={() => void rebuild()} disabled={busy} className="justify-self-start">
          <RefreshCw className={cn(busy && 'animate-spin')} />从文件重建搜索索引
        </Button>
      </CardContent>
    </Card>
  );
}

function QueueCard() {
  const { revision, refresh } = useApp();
  const jobs = useAsync(() => rpc<{ jobs: { jobId?: string; id?: string; createdAt?: string; sessionId?: string }[] }>('accremind.queue.list'), [revision]);
  const [busy, setBusy] = useState(false);
  const n = jobs.data?.jobs.length ?? 0;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>自动捕获队列</CardTitle>
          <CardDescription>任务结束时识别到的经验信号，等模型提炼成候选。</CardDescription>
        </div>
        <IconTile icon={Bot} tone="primary" />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-baseline gap-2">
          <span className="num font-display text-3xl font-semibold">{n}</span>
          <span className="text-sm text-muted-foreground">项等待处理</span>
        </div>
        <Button
          variant="outline"
          className="justify-self-start"
          disabled={!n || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const out = await rpc<{ processed: number }>('accremind.queue.drain');
              toast.success(`已处理 ${out.processed} 项`);
              refresh();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Cpu />立即提炼
        </Button>
      </CardContent>
    </Card>
  );
}

/** 常驻规范每轮都会带给 AI，篇幅有上限；放不下的规范按优先级排在后面，这里列出来便于精简或合并。 */
function RuleBudgetCard() {
  const { revision, openEntry } = useApp();
  const sim = useAsync(() => rpc<SimResult>('accremind.sim.compile', { userPrompt: '' }), [revision]);
  const d = sim.data;
  const budget = d?.budgets.residentRulesTokens ?? 0;
  const used = d?.residentTokens ?? 0;
  const pct = budget ? Math.min(100, (used / budget) * 100) : 0;
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>常驻规范篇幅</CardTitle>
          <CardDescription>团队规范每轮都会带给 AI。超出上限的按优先级（P0 → P2）排后，只告诉 AI 编号。</CardDescription>
        </div>
        <IconTile icon={ShieldCheck} tone={d?.residentDroppedIds.length ? 'warning' : 'success'} />
      </CardHeader>
      <CardContent className="grid gap-3">
        {sim.loading && !d ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span><b className="num text-lg">{d?.residentRuleIds.length ?? 0}</b> 条完整带上{d?.residentDroppedIds.length ? <>，<b className="num text-warning">{d.residentDroppedIds.length}</b> 条只带编号</> : null}</span>
              <span className={cn('num text-xs', used > budget ? 'text-danger' : 'text-muted-foreground')}>{used} / {budget} tokens</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn('grow-x h-full rounded-full', pct > 90 ? 'bg-warning' : 'bg-primary')} style={{ width: `${pct}%` }} />
            </div>
            {!!d?.residentDroppedIds.length && (
              <div className="flex flex-wrap gap-1.5">
                {d.residentDroppedIds.map((id) => (
                  <button key={id} type="button" onClick={() => openEntry(id)} className="rounded-md bg-warning/10 px-2 py-0.5 font-mono text-xs text-warning ring-1 ring-inset ring-warning/25 hover:bg-warning/20">{id}</button>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 开启共享前先预览会写进仓库的内容：只有结论、哈希后的任务号和脱敏说明。 */
function ShareLedgerControl({ on, onChanged }: { on: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LedgerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    if (!next) {
      await rpc('accremind.settings.setShareLedger', { shareLedger: false });
      toast.success('已停止共享，新的记录只保存在本机');
      onChanged();
      return;
    }
    setStatus(await rpc<LedgerStatus>('accremind.ledger.status'));
    setOpen(true);
  };
  return (
    <>
      <Switch checked={on} onCheckedChange={(v) => void toggle(v).catch((err) => toast.error(err instanceof Error ? err.message : String(err)))} aria-label="共享验证记录" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl p-6">
          <DialogTitle className="text-lg font-semibold">开启验证记录共享</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            本机有 {status?.pendingCount ?? 0} 条记录会移入仓库的 .accremind/ledger，并写入 {status?.sharedFile?.split('/').slice(-2).join('/')}。提交后团队成员都会看到。
          </DialogDescription>
          <div className="mt-4 max-h-72 overflow-auto rounded-lg border">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr className="border-b"><th className="px-3 py-2 text-left font-medium">经验</th><th className="px-3 py-2 text-left font-medium">记录</th><th className="px-3 py-2 text-left font-medium">记录人</th><th className="px-3 py-2 text-left font-medium">说明（已脱敏）</th></tr>
              </thead>
              <tbody>
                {(status?.preview ?? []).map((r) => (
                  <tr key={r.id} className="border-b last:border-0 align-top">
                    <td className="px-3 py-1.5 font-mono">{r.entryId}</td>
                    <td className="px-3 py-1.5">{({ validated: '确认有效', counterexample: '反证', inapplicable: '不适用' } as Record<string, string>)[r.kind] ?? ({ publish: '发布', promote: '转正', dismiss: '淘汰', stale: '失效', request_review: '送回复核', resume: '解除反证', withdraw: '撤回', confirm_fresh: '确认仍成立' } as Record<string, string>)[r.action ?? ''] ?? r.kind}</td>
                    <td className="px-3 py-1.5">{r.actor}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.note || '—'}</td>
                  </tr>
                ))}
                {!status?.preview.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">没有需要移动的记录</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">不会共享：对话内容、提问原文、会话标识、每次提醒的明细。试用中和个人经验的记录仍只留在本机。</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const out = await rpc<{ moved: number }>('accremind.settings.setShareLedger', { shareLedger: true });
                  toast.success('已开启共享', { description: `移入仓库 ${out.moved} 条记录，记得提交 .accremind/` });
                  setOpen(false);
                  onChanged();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              开启并移入仓库
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SettingsCard({ settings, loading, onChanged }: { settings: Settings | undefined; loading: boolean; onChanged: () => void }) {
  const save = async (method: string, params: Record<string, unknown>, ok: string) => {
    try {
      await rpc(method, params);
      toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  if (loading && !settings) return <Skeleton className="h-64 rounded-xl" />;
  if (!settings) return null;
  const rows = [
    {
      icon: ShieldCheck,
      title: 'AI 新总结的经验怎么处理',
      desc: '先试用：直接在本机提醒 AI，攒够反馈再转正。先审核：必须人工批准后才会提醒。',
      control: (
        <Segmented<string>
          ariaLabel="写入策略"
          value={settings.writeGate}
          onValueChange={(v) => void save('accremind.settings.setGate', { writeGate: v }, '写入策略已更新')}
          items={[
            { value: 'probation', label: '先试用' },
            { value: 'review', label: '先审核' },
          ]}
        />
      ),
    },
    {
      icon: Bot,
      title: '允许把对话片段发送给提炼模型',
      desc: settings.modelAvailable ? `当前模型：${settings.modelEndpoint}。发送前会自动去除密钥、手机号等敏感信息。` : '尚未配置提炼模型，开启后也不会发送任何内容。',
      control: (
        <Switch
          checked={settings.modelUpload}
          onCheckedChange={(v) => void save('accremind.settings.setModelUpload', { modelUpload: v }, v ? '已允许发送对话片段' : '已关闭发送')}
          aria-label="允许发送对话片段"
        />
      ),
    },
    {
      icon: Users,
      title: '把验证记录共享到仓库',
      desc: settings.shareLedger
        ? '已开启：确认、反证和治理决定写入 .accremind/ledger 随仓库共享；团队里需要作者以外的人确认才算“多次验证”。'
        : '关闭时只保存在本机。开启后写入仓库的 .accremind/team.json，提交后团队成员都会共享。',
      control: <ShareLedgerControl on={settings.shareLedger} onChanged={onChanged} />,
    },
    {
      icon: Cpu,
      title: '任务结束时自动捕获',
      desc: '由插件配置决定，在 DSH 的插件设置中修改。',
      control: <Badge tone={settings.autoCapture ? 'success' : 'neutral'} dot>{settings.autoCapture ? '已开启' : '已关闭'}</Badge>,
    },
  ];
  return (
    <Card className="divide-y">
      {rows.map((r) => (
        <div key={r.title} className="flex flex-wrap items-center gap-4 p-5">
          <IconTile icon={r.icon} tone="primary" />
          <div className="min-w-[240px] flex-1">
            <p className="font-medium">{r.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{r.desc}</p>
          </div>
          <div className="shrink-0">{r.control}</div>
        </div>
      ))}
    </Card>
  );
}
