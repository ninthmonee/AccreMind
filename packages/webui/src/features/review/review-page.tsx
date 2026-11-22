import {
  ArrowRight,
  BookMarked,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ClipboardCheck,
  Clock,
  FileSearch,
  FlaskConical,
  Link2,
  Scale,
  Stamp,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, IconTile, PageHeader, stagger } from '@/components/display';
import { PriorityBadge, TypeChip } from '@/components/entry-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Segmented } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Textarea } from '@/components/ui/primitives';
import { CHECK_METHOD, DISCOVERABILITY, layerLabel } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { KbListResult, ListItem, ReviewDecision, ReviewItem, ReviewQueue } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { cn, formatDate, relativeDays } from '@/lib/utils';

type Tab = 'pending' | 'probation' | 'decided';

const DISPOSITION_LABEL: Record<string, string> = {
  index_only: '仅建索引',
  link_existing: '关联已有经验',
  knowledge_candidate: '候选经验',
  needs_confirmation: '待补证据',
  discard: '已驳回',
};

/** 候选审核：左侧队列，右侧对照“只看代码能得出什么”与“这条经验多说了什么”，底部决策条。 */
export function ReviewPage() {
  const { revision, overview } = useApp();
  const [tab, setTab] = useState<Tab>('pending');
  const [selected, setSelected] = useState<string | null>(null);
  const queue = useAsync(
    () => (tab === 'probation' ? Promise.resolve(undefined) : rpc<ReviewQueue>('accremind.review.listQueue', { reviewState: tab, limit: 100 })),
    [tab, revision],
  );
  const probation = useAsync(() => rpc<KbListResult>('accremind.kb.list', { adminView: true, status: 'probation' }), [revision]);
  const items = useMemo(() => queue.data?.items ?? [], [queue.data]);
  const current = items.find((i) => i.assessment.id === selected) ?? items[0];

  useEffect(() => {
    if (tab !== 'probation' && items.length && !items.some((i) => i.assessment.id === selected)) setSelected(items[0]!.assessment.id);
  }, [items, selected, tab]);

  const c = overview.data?.counts;
  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={<><ClipboardCheck className="size-4" /><span>经验入库前的最后一道关</span></>}
        title="候选审核"
        description="AI 只能看到代码。批准前确认：这条经验说了代码里看不出来的东西，并且每个结论都有证据。"
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented<Tab>
          ariaLabel="审核队列"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'pending', label: '待审核', icon: <ClipboardCheck />, count: c?.pendingReviewCount },
            { value: 'probation', label: '试用中', icon: <FlaskConical />, count: c?.probationCount },
            { value: 'decided', label: '已处理', icon: <Check /> },
          ]}
        />
        <ReviewSteps />
      </div>

      {tab === 'probation' ? (
        <ProbationBoard items={probation.data?.items ?? []} loading={probation.loading} maxExposures={overview.data?.maxProbationExposures ?? 3} />
      ) : queue.loading && !queue.data ? (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : !items.length ? (
        <EmptyState
          icon={tab === 'pending' ? CircleCheck : Clock}
          title={tab === 'pending' ? '没有待审核的候选' : '还没有处理过的候选'}
          description={tab === 'pending' ? 'AI 在任务结束时识别到值得沉淀的经验，或你在 Git 雷达里提炼提交后，候选会出现在这里。' : '批准、送入试用或驳回的候选会归档到这里。'}
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <Card className="overflow-hidden lg:sticky lg:top-[calc(var(--header-h,64px)+16px)]">
            <div className="flex items-center justify-between border-b px-4 py-3 text-xs text-muted-foreground">
              <span>共 <b className="num text-foreground">{queue.data?.total ?? items.length}</b> 条</span>
              <span>按时间倒序</span>
            </div>
            <ul className="max-h-[calc(100dvh-var(--header-h,64px)-200px)] min-h-40 overflow-y-auto p-2">
              {items.map((it, i) => (
                <QueueRow key={it.assessment.id} item={it} active={current?.assessment.id === it.assessment.id} onClick={() => setSelected(it.assessment.id)} index={i} />
              ))}
            </ul>
          </Card>
          {current && <ReviewDetail key={current.assessment.id + revision} item={current} readOnly={tab === 'decided'} />}
        </div>
      )}
    </div>
  );
}

function ReviewSteps() {
  const steps = ['读增量', '对证据', '做决定'];
  return (
    <ol className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span className="num inline-flex size-5 items-center justify-center rounded-full bg-primary/12 text-[11px] font-semibold text-primary">{i + 1}</span>
          {s}
          {i < steps.length - 1 && <ArrowRight className="size-3.5 opacity-50" />}
        </li>
      ))}
    </ol>
  );
}

function QueueRow({ item, active, onClick, index }: { item: ReviewItem; active: boolean; onClick: () => void; index: number }) {
  const a = item.assessment;
  const ready = item.reviewState === 'pending' && !item.missingFields.length;
  return (
    <li className="rise" style={stagger(index)}>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'relative w-full rounded-lg px-3 py-2.5 text-left transition',
          active ? 'bg-primary/10 ring-1 ring-inset ring-primary/30' : 'hover:bg-accent',
        )}
      >
        {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />}
        <div className="flex items-center gap-2">
          <PriorityBadge priority={a.priority} />
          {item.reviewState === 'pending' ? (
            ready ? <Badge tone="success" dot>可批准</Badge> : <Badge tone="warning" dot>缺 {item.missingFields.length} 项</Badge>
          ) : (
            <Badge tone="neutral">{DISPOSITION_LABEL[a.disposition] ?? a.disposition}</Badge>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">{relativeDays(a.created_at)}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug">{item.candidateDraft?.title || a.question}</p>
        {item.candidateDraft && <TypeChip type={item.candidateDraft.type} className="mt-1.5" />}
      </button>
    </li>
  );
}

function ReviewDetail({ item, readOnly }: { item: ReviewItem; readOnly: boolean }) {
  const { refresh } = useApp();
  const a = item.assessment;
  const d = item.candidateDraft;
  const [busy, setBusy] = useState<ReviewDecision | null>(null);
  const [showSupplement, setShowSupplement] = useState(item.missingFields.length > 0 && !readOnly);
  const [locator, setLocator] = useState('');
  const [note, setNote] = useState('');
  const [delta, setDelta] = useState(a.knowledge_delta);
  const disc = DISCOVERABILITY[a.discoverability];
  const verified = a.claim_evidence_map.filter((m) => m.verified_fact).length;

  const decide = async (decision: ReviewDecision, extra: Record<string, unknown> = {}) => {
    setBusy(decision);
    try {
      const out = await rpc<{ ok?: boolean; missingFields?: string[] }>('accremind.review.decide', { assessmentId: a.id, decision, ...extra });
      if (out && out.ok === false) {
        toast.warning('还不能批准', { description: (out.missingFields ?? []).join('；') });
        setShowSupplement(true);
        return;
      }
      const msg: Record<ReviewDecision, string> = {
        approve_active: '已批准入库，会随仓库共享',
        approve_probation: '已送入本机试用',
        supplement: '证据已补充',
        needs_confirmation: '已标记为待确认',
        index_only: '已作为索引保留',
        link_existing: '已关联到现有经验',
        discard: '已驳回',
      };
      toast.success(msg[decision], decision === 'supplement' && out?.missingFields?.length ? { description: `还缺：${out.missingFields.join('；')}` } : undefined);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4">
      <Card className="rise overflow-hidden">
        <div className="relative border-b px-6 py-5">
          <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-primary/10 blur-3xl" />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{a.id}</span>
            <PriorityBadge priority={a.priority} />
            {d && <TypeChip type={d.type} />}
            {d && <span>· {layerLabel(d.layer)}</span>}
            <span>· {CHECK_METHOD[a.checked_context.method] ?? a.checked_context.method}</span>
            <span>· {formatDate(a.created_at)}</span>
          </div>
          <h2 className="mt-2 font-display text-xl font-semibold leading-snug tracking-tight">{d?.title || a.question}</h2>
          {d?.title && <p className="mt-1 text-sm text-muted-foreground">问题：{a.question}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone={disc?.tone ?? 'neutral'}>{disc?.label ?? a.discoverability}</Badge>
            <Badge tone={verified === a.claim_evidence_map.length && verified > 0 ? 'success' : 'warning'}>
              证据 {verified}/{a.claim_evidence_map.length}
            </Badge>
            {a.checked_context.head_commit && <Badge tone="neutral" className="font-mono">@{a.checked_context.head_commit.slice(0, 7)}</Badge>}
          </div>
        </div>

        {/* 基线 vs 增量 */}
        <div className="grid gap-0 md:grid-cols-2">
          <div className="border-b p-6 md:border-b-0 md:border-r">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <FileSearch className="size-3.5" />只看代码能得出
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">{a.baseline_answer || '—'}</p>
            <p className="mt-3 text-xs text-muted-foreground">核对了 {a.checked_context.checked_files.length} 个文件、{a.checked_context.checked_docs.length} 篇文档</p>
          </div>
          <div className="relative bg-primary/[0.04] p-6">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <Scale className="size-3.5" />这条经验多说了
            </p>
            <p className="text-[15px] font-medium leading-relaxed">{a.knowledge_delta || '—'}</p>
            {a.omission_consequence && (
              <p className="mt-3 flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning ring-1 ring-inset ring-warning/20">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span><b>不知道会怎样：</b>{a.omission_consequence}</span>
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* 断言与证据 */}
      <Card className="rise" style={stagger(1)}>
        <CardHeader>
          <div>
            <CardTitle>结论与证据</CardTitle>
            <CardDescription>每一条结论都应能在仓库里找到出处。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {a.claim_evidence_map.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">还没有逐条对应的证据。</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-14 whitespace-nowrap px-3 py-2 text-left font-medium">核实</th>
                    <th className="px-3 py-2 text-left font-medium">结论</th>
                    <th className="px-3 py-2 text-left font-medium">证据位置</th>
                  </tr>
                </thead>
                <tbody>
                  {a.claim_evidence_map.map((m, i) => (
                    <tr key={i} className="border-t align-top">
                      <td className="px-3 py-2.5">
                        {m.verified_fact ? (
                          <span className="inline-flex size-5 items-center justify-center rounded-full bg-success/15 text-success" title="已核实"><Check className="size-3.5" /></span>
                        ) : (
                          <span className="inline-flex size-5 items-center justify-center rounded-full bg-warning/15 text-warning" title="未核实"><CircleHelp className="size-3.5" /></span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 leading-relaxed">{m.assertion}</td>
                      <td className="px-3 py-2.5">{m.evidence_locator ? <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{m.evidence_locator}</code> : <span className="text-muted-foreground">缺失</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d && (
            <div className="mt-4 grid gap-3 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">核心结论</p>
                <p className="mt-1 leading-relaxed">{d.claim || '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">适用条件</p>
                <p className="mt-1 leading-relaxed">{d.preconditions.join('；') || '—'}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {!readOnly && item.missingFields.length > 0 && (
        <div role="alert" className="rise flex gap-3 rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">批准前还缺这些信息</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              {item.missingFields.map((f) => <li key={f}>{f.replace(/^[a-zA-Z_.]+:\s*/, '')}</li>)}
            </ul>
          </div>
        </div>
      )}

      {!readOnly && (
        <Card className="rise overflow-hidden" style={stagger(2)}>
          <button type="button" onClick={() => setShowSupplement((v) => !v)} className="flex w-full items-center gap-3 px-5 py-4 text-left">
            <IconTile icon={BookMarked} tone="info" className="size-8 [&_svg]:size-4" />
            <span className="flex-1">
              <span className="block text-sm font-medium">补充证据</span>
              <span className="block text-xs text-muted-foreground">填写仓库相对路径、提交或文档引用，并说明你核实了什么</span>
            </span>
            <ChevronDown className={cn('size-4 text-muted-foreground transition', showSupplement && 'rotate-180')} />
          </button>
          {showSupplement && (
            <div className="grid gap-3 border-t px-5 py-4 animate-in fade-in-0 slide-in-from-top-1">
              <div className="grid gap-1.5">
                <Label htmlFor="sup-delta">对应的增量</Label>
                <Textarea id="sup-delta" value={delta} onChange={(e) => setDelta(e.target.value)} rows={2} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="sup-loc">证据位置</Label>
                  <Input id="sup-loc" value={locator} onChange={(e) => setLocator(e.target.value)} placeholder="src/order/service.ts#L40-L58" className="font-mono text-[13px]" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sup-note">核实说明</Label>
                  <Input id="sup-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="复现了 30ms 延迟下的竞态" />
                </div>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" disabled={!locator || !note || !!busy} onClick={() => void decide('supplement', { evidenceLocator: locator, evidenceNote: note, knowledgeDelta: delta })}>
                  <Link2 />保存证据
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {!readOnly && (
        <div className="sticky bottom-4 z-10">
          <div className="surface flex flex-wrap items-center gap-2 p-3 shadow-2xl backdrop-blur">
            <p className="mr-auto hidden text-xs text-muted-foreground sm:block">
              {item.missingFields.length ? '补全信息后才能批准；也可以先送入本机试用。' : '证据齐全，可以批准。'}
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" disabled={!!busy}>其他处理<ChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void decide('index_only')}><FileSearch />只建索引（不提醒 AI）</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void decide('needs_confirmation')}><CircleHelp />标记为待确认</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => void decide('discard')}><Trash2 />驳回</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" disabled={!!busy || !d} onClick={() => void decide('approve_probation')}>
              <FlaskConical />送入试用
            </Button>
            <Button disabled={!!busy || item.missingFields.length > 0} onClick={() => void decide('approve_active')}>
              <Stamp />批准入库
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 试用看板：每条试用经验的曝光进度（达到上限仍无反馈会进入待办），可直接转正或淘汰。 */
function ProbationBoard({ items, loading, maxExposures }: { items: ListItem[]; loading: boolean; maxExposures: number }) {
  const { refresh, openEntry } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (it: ListItem, action: 'promote' | 'dismiss') => {
    setBusy(it.entry.id);
    try {
      await rpc('accremind.probation.decide', { id: it.entry.id, revision: it.entry.revision, action });
      toast.success(action === 'promote' ? '已转为正式经验' : '已淘汰');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  if (loading && !items.length) return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}</div>;
  if (!items.length)
    return <EmptyState icon={FlaskConical} title="没有试用中的经验" description="送入试用的候选只在本机提醒 AI，不写入仓库。攒够反馈后再决定转正。" />;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {items.map((it, i) => {
        const n = it.probationExposures ?? 0;
        const pct = Math.min(100, (n / Math.max(1, maxExposures)) * 100);
        return (
          <Card key={it.entry.id} className="rise flex flex-col p-5" style={stagger(i)}>
            <div className="flex items-center gap-2">
              <PriorityBadge priority={it.entry.priority} />
              <TypeChip type={it.entry.type} />
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{it.entry.id}</span>
            </div>
            <button type="button" onClick={() => openEntry(it.entry.id)} className="mt-2 text-left font-medium leading-snug hover:text-primary">{it.entry.title}</button>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{it.entry.claim}</p>
            <div className="mt-auto pt-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>已提醒 AI</span>
                <span className="num font-medium text-foreground">{n} / {maxExposures} 次</span>
              </div>
              <div className="mt-1.5 flex gap-1">
                {Array.from({ length: maxExposures }, (_, k) => (
                  <span key={k} className={cn('h-1.5 flex-1 rounded-full transition-colors', k < n ? (pct >= 100 ? 'bg-warning' : 'bg-primary') : 'bg-muted')} />
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <Button size="sm" className="flex-1" disabled={busy === it.entry.id || it.entry.serving !== 'enabled'} onClick={() => void decide(it, 'promote')}><Stamp />转正</Button>
                <Button size="sm" variant="outline" disabled={busy === it.entry.id} onClick={() => void decide(it, 'dismiss')}><X />淘汰</Button>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
