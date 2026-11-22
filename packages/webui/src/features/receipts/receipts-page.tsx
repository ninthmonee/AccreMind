import {
  BellRing,
  Bug,
  CircleSlash,
  FileCode2,
  History,
  MessageSquareText,
  Play,
  Radar,
  ScrollText,
  Sparkles,
  ThumbsUp,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, IconTile, PageHeader, SegmentBar, StatCard, stagger } from '@/components/display';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Textarea } from '@/components/ui/primitives';
import type { Tone } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { ReceiptHit, SimResult, TurnReceipt } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';

const SOURCE: Record<ReceiptHit['source'], { label: string; hint: string; icon: typeof Radar; tone: Tone }> = {
  rule: { label: '常驻规范', hint: '每轮都带上的团队规范', icon: ScrollText, tone: 'primary' },
  radar: { label: '提问雷达', hint: '根据提问与报错召回', icon: Radar, tone: 'info' },
  jit: { label: '文件护栏', hint: 'AI 打开文件时即时提醒', icon: FileCode2, tone: 'warning' },
};

const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** 回合记录：每轮对话 AI 收到了哪些经验、来自哪个通道，并就地反馈；以及命中模拟。 */
export function ReceiptsPage() {
  const { revision } = useApp();
  const turns = useAsync(() => rpc<{ receipts: TurnReceipt[] }>('accremind.turn.list', { limit: 40 }), [revision]);
  const receipts = useMemo(() => (turns.data?.receipts ?? []).filter((r) => r.hits.length > 0), [turns.data]);
  const hits = receipts.flatMap((r) => r.hits);
  const bySource = (k: ReceiptHit['source']) => hits.filter((h) => h.source === k).length;
  const withFeedback = hits.filter((h) => h.feedback).length;

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={<><History className="size-4" /><span>AI 每一轮看到了什么</span></>}
        title="回合记录"
        description="每轮对话里，经验通过三个通道提醒 AI。在这里确认它们是否有帮助，反馈会直接影响经验的去留。"
      />
      <Tabs defaultValue="turns">
        <TabsList>
          <TabsTrigger value="turns"><MessageSquareText />最近回合</TabsTrigger>
          <TabsTrigger value="sim"><Play />命中模拟</TabsTrigger>
        </TabsList>

        <TabsContent value="turns" className="mt-5">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rise"><StatCard icon={MessageSquareText} tone="primary" label="有提醒的回合" value={receipts.length} loading={turns.loading && !turns.data} caption="最近 40 轮内" /></div>
            <div className="rise" style={stagger(1)}>
              <StatCard
                icon={BellRing}
                tone="info"
                label="提醒次数"
                value={hits.length}
                loading={turns.loading && !turns.data}
                caption={
                  <div className="grid gap-1.5">
                    <span>规范 {bySource('rule')} · 雷达 {bySource('radar')} · 护栏 {bySource('jit')}</span>
                    <SegmentBar parts={(['rule', 'radar', 'jit'] as const).map((k) => ({ key: k, value: bySource(k), tone: SOURCE[k].tone, label: SOURCE[k].label }))} />
                  </div>
                }
              />
            </div>
            <div className="rise" style={stagger(2)}><StatCard icon={ThumbsUp} tone="success" label="已反馈" value={withFeedback} suffix={`/ ${hits.length}`} loading={turns.loading && !turns.data} caption="反馈越多，经验越可靠" /></div>
            <div className="rise" style={stagger(3)}><StatCard icon={Sparkles} tone="warning" label="待反馈" value={hits.length - withFeedback} loading={turns.loading && !turns.data} caption="点每条右侧的按钮即可" /></div>
          </section>

          <div className="mt-6">
            {turns.loading && !turns.data ? (
              <div className="grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
            ) : !receipts.length ? (
              <EmptyState icon={History} title="还没有回合记录" description="在 DSH 里正常对话，AI 每轮收到的经验提醒都会记录在这里。也可以先在“命中模拟”里试一试。" />
            ) : (
              <ol className="relative grid gap-4 before:absolute before:bottom-2 before:left-[19px] before:top-2 before:w-px before:bg-border">
                {receipts.map((r, i) => <TurnCard key={r.sessionId + r.turnId} receipt={r} index={i} />)}
              </ol>
            )}
          </div>
        </TabsContent>

        <TabsContent value="sim" className="mt-5">
          <Simulator />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TurnCard({ receipt: r, index }: { receipt: TurnReceipt; index: number }) {
  const { openEntry, refresh } = useApp();
  const [wrong, setWrong] = useState<ReceiptHit | null>(null);
  const send = async (h: ReceiptHit, kind: 'verified_effective' | 'inapplicable' | 'suspected_error', detail = '') => {
    try {
      await rpc('accremind.feedback.submit', { id: h.id, revision: h.revision, kind, detail, sessionId: r.sessionId, turnId: r.turnId });
      toast.success(kind === 'verified_effective' ? '感谢反馈：有帮助' : kind === 'inapplicable' ? '已记录：这里不适用' : '已记录疑似错误，经验已暂停提醒');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  return (
    <li className="rise relative pl-12" style={stagger(index)}>
      <span className="absolute left-2 top-4 inline-flex size-[22px] items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_20%,transparent)]">
        <MessageSquareText className="size-3" />
      </span>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="num font-medium text-foreground">{timeFmt.format(new Date(r.createdAt))}</span>
          <span>·</span>
          <span className="font-mono">{r.sessionId.slice(0, 8)}</span>
          <span className="ml-auto">{r.hits.length} 条经验</span>
        </div>
        <ul className="mt-3 grid gap-2">
          {r.hits.map((h) => {
            const src = SOURCE[h.source];
            const changed = h.currentRevision !== null && h.currentRevision !== h.revision;
            return (
              <li key={h.id + h.source} className="flex flex-wrap items-center gap-3 rounded-lg border bg-background/40 px-3 py-2">
                <IconTile icon={src.icon} tone={src.tone} className="size-7 [&_svg]:size-3.5" />
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => openEntry(h.id)} className="block max-w-full truncate text-left text-sm font-medium hover:text-primary">{h.title}</button>
                  <p className="text-xs text-muted-foreground">
                    {src.label}
                    {h.filePath && <> · <span className="font-mono">{h.filePath}</span></>}
                    {changed && <> · 之后已更新到 r{h.currentRevision}</>}
                  </p>
                </div>
                {h.feedback ? (
                  <Badge tone={h.feedback === 'success' ? 'success' : h.feedback === 'failure' ? 'danger' : 'neutral'} dot>
                    {h.feedback === 'success' ? '有帮助' : h.feedback === 'failure' ? '有错误' : '不适用'}
                  </Badge>
                ) : changed ? (
                  <span className="text-xs text-muted-foreground">版本已变，无法反馈</span>
                ) : (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => void send(h, 'verified_effective').catch(() => undefined)}><ThumbsUp />有帮助</Button>
                    <Button size="icon-sm" variant="ghost" title="这里不适用" aria-label="这里不适用" onClick={() => void send(h, 'inapplicable').catch(() => undefined)}><CircleSlash /></Button>
                    <Button size="icon-sm" variant="ghost" title="内容有误" aria-label="内容有误" onClick={() => setWrong(h)}><Bug /></Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <ReasonDialog
        open={!!wrong}
        onOpenChange={(o) => !o && setWrong(null)}
        title="这条经验哪里不对？"
        description={wrong?.title}
        label="哪里不对，你是怎么发现的"
        confirmLabel="提交并暂停提醒"
        danger
        onConfirm={(detail) => send(wrong!, 'suspected_error', detail)}
      />
    </li>
  );
}

function Lane({ icon, title, hint, tokens, budget, ids, block, tone, dropped = [] }: { icon: typeof Radar; title: string; hint: string; tokens: number; budget: number; ids: string[]; block: string; tone: Tone; dropped?: string[] }) {
  const pct = budget ? Math.min(100, (tokens / budget) * 100) : 0;
  const over = tokens > budget;
  return (
    <Card className="rise flex flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <IconTile icon={icon} tone={tone} />
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{hint}</CardDescription>
          </div>
        </div>
        <Badge tone={ids.length ? tone : 'neutral'} className="num">{ids.length} 条</Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>占用</span>
            <span className={cn('num', over && 'font-semibold text-danger')}>{tokens} / {budget} tokens</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn('grow-x h-full rounded-full', over ? 'bg-danger' : 'bg-primary')} style={{ width: `${pct}%` }} />
          </div>
        </div>
        {dropped.length > 0 && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning ring-1 ring-inset ring-warning/20">
            另有 {dropped.length} 条规范放不下，只告诉 AI 编号：{dropped.join('、')}
          </p>
        )}
        {block ? (
          <pre className="max-h-56 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-3 font-mono text-[12px] leading-relaxed text-foreground/85">{block}</pre>
        ) : (
          <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">这一通道没有召回经验</p>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Simulator() {
  const [prompt, setPrompt] = useState('帮我改一下支付回调的验签逻辑');
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [tool, setTool] = useState('src/payment/webhook.ts');
  const [out, setOut] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setOut(await rpc<SimResult>('accremind.sim.compile', { userPrompt: prompt, errorOutput: error, activeFile: active, midTurnToolFile: tool }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4">
      <Card className="p-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <Field id="sim-prompt" label="假设用户这样提问"><Textarea id="sim-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
          <Field id="sim-error" label="附带的报错（可选）"><Textarea id="sim-error" rows={3} value={error} onChange={(e) => setError(e.target.value)} placeholder="CROSSSLOT Keys in request don't hash to the same slot" className="font-mono text-[13px]" /></Field>
          <Field id="sim-active" label="编辑器里打开的文件（可选）"><Input id="sim-active" value={active} onChange={(e) => setActive(e.target.value)} placeholder="src/order/order.service.ts" className="font-mono text-[13px]" /></Field>
          <Field id="sim-tool" label="AI 中途要修改的文件（可选）"><Input id="sim-tool" value={tool} onChange={(e) => setTool(e.target.value)} className="font-mono text-[13px]" /></Field>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">只做预览，不会记录回合，也不会计入试用次数。</p>
          <Button onClick={() => void run()} disabled={busy}><Play />模拟这一轮</Button>
        </div>
      </Card>
      {out && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Lane icon={ScrollText} tone="primary" title="常驻规范" hint="每轮固定带上，可被缓存" tokens={out.residentTokens} budget={out.budgets.residentRulesTokens ?? 0} ids={out.residentRuleIds} block={out.residentPrefix} dropped={out.residentDroppedIds ?? []} />
          <Lane icon={Radar} tone="info" title="提问雷达" hint="按提问、报错与打开的文件召回" tokens={out.radarTokens} budget={out.budgets.turnRadarTokens ?? 0} ids={out.radarSurfacedIds} block={out.radarBlock} />
          <Lane icon={FileCode2} tone="warning" title="文件护栏" hint="AI 动这个文件前即时提醒" tokens={out.guardTokens} budget={out.budgets.toolGuardTokens ?? 0} ids={out.guardSurfacedIds} block={out.guardBlock} />
        </div>
      )}
    </div>
  );
}
