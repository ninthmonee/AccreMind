import { ArrowRight, BellOff, CircleCheckBig, ClipboardCheck, FlaskConical, GitCompareArrows, type LucideIcon, Stamp, Trash2, TrendingDown, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { IconTile, stagger } from '@/components/display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/primitives';
import { ATTENTION, type Tone } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { AttentionItem, ReviewItem } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Row {
  key: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  hint: string;
  tag: string;
  actions: ReactNode;
  /** Owners named in repo.json or the domain catalog; empty = nobody in particular. */
  owners?: string[];
  mine?: boolean;
}

/**
 * 待办收件箱：候选审核、试用期满无反馈、多次不适用、代码变更待复核，按紧急度排在一起。
 * 试用期满的经验可以直接转正或淘汰，处理后行项滑出。
 */
export function InboxCard({
  pending,
  attention,
  reviewDue,
  loading,
  className,
}: {
  pending: ReviewItem[];
  attention: AttentionItem[];
  reviewDue: number;
  loading: boolean;
  className?: string;
}) {
  const { setView, openEntry, refresh } = useApp();
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const hasOwners = attention.some((a) => (a.owners?.length ?? 0) > 0);

  const decide = async (item: AttentionItem, action: 'promote' | 'dismiss') => {
    setBusy(item.entry_id);
    try {
      await rpc('accremind.probation.decide', { id: item.entry_id, revision: item.revision, action });
      setLeaving((s) => new Set(s).add(`att-${item.entry_id}`));
      toast.success(action === 'promote' ? '已转为正式经验' : '已淘汰这条试用经验');
      setTimeout(refresh, 320);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (item: AttentionItem) => {
    setBusy(item.entry_id);
    try {
      await rpc('accremind.gov.restoreAutoDemotion', { entryId: item.entry_id });
      setLeaving((s) => new Set(s).add(`att-${item.entry_id}-${item.kind}`));
      toast.success('已撤销自动降级，恢复为原来的状态');
      setTimeout(refresh, 320);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const rows: Row[] = [
    ...pending.map<Row>((p) => ({
      key: `rev-${p.assessment.id}`,
      icon: ClipboardCheck,
      tone: 'info',
      title: p.candidateDraft?.title || p.assessment.question || '新的候选经验',
      hint: p.missingFields.length ? `还缺 ${p.missingFields.length} 项信息才能批准` : 'AI 总结完毕，核对增量与证据后入库',
      tag: '候选',
      actions: (
        <Button size="sm" variant="outline" onClick={() => setView('review')}>
          去审核<ArrowRight />
        </Button>
      ),
    })),
    ...attention.map<Row>((a) => ({
      key: `att-${a.entry_id}-${a.kind}`,
      icon: a.kind === 'probation_silent' ? FlaskConical : a.kind === 'auto_demoted' ? TrendingDown : BellOff,
      tone: 'warning',
      title: a.title,
      hint: (a.kind === 'auto_demoted' ? a.reason : ATTENTION[a.kind]?.hint ?? a.reason)
        + (a.owners?.length ? ` · 负责人：${a.assignedToMe ? '你' : a.owners.join('、')}` : ''),
      tag: ATTENTION[a.kind]?.label ?? a.kind,
      owners: a.owners ?? [],
      mine: a.assignedToMe === true,
      actions:
        a.kind === 'probation_silent' ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy === a.entry_id} onClick={() => void decide(a, 'promote')}>
              <Stamp />转正
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="淘汰" title="淘汰" disabled={busy === a.entry_id} onClick={() => void decide(a, 'dismiss')}>
              <Trash2 />
            </Button>
          </div>
        ) : a.kind === 'auto_demoted' ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy === a.entry_id} onClick={() => void restore(a)}>
              <Undo2 />撤销
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="查看" title="查看" onClick={() => openEntry(a.entry_id)}>
              <ArrowRight />
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => openEntry(a.entry_id)}>
            查看<ArrowRight />
          </Button>
        ),
    })),
    ...(reviewDue > 0
      ? [
          {
            key: 'due',
            icon: GitCompareArrows,
            tone: 'danger' as Tone,
            title: `${reviewDue} 条经验关联的代码有变化`,
            hint: '对照代码差异，确认仍然成立或标记失效',
            tag: '待复核',
            actions: (
              <Button size="sm" variant="outline" onClick={() => setView('governance')}>
                去复核<ArrowRight />
              </Button>
            ),
          },
        ]
      : []),
  ];
  const visible = onlyMine ? rows.filter((r) => r.mine) : rows;
  const count = visible.filter((r) => !leaving.has(r.key)).length;

  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>需要你处理</CardTitle>
          <CardDescription>处理完就是空的。AI 总结出新经验或代码变化时会出现在这里。</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {hasOwners && (
            <Button size="sm" variant={onlyMine ? 'default' : 'outline'} aria-pressed={onlyMine} onClick={() => setOnlyMine((v) => !v)}>只看我的</Button>
          )}
          <Badge tone={count ? 'primary' : 'success'} className="num">{count ? `${count} 项` : '已清空'}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !rows.length ? (
          <div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        ) : count === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="inline-flex size-12 animate-[rise_0.5s_ease-out_both] items-center justify-center rounded-full bg-success/12 text-success ring-1 ring-inset ring-success/25">
              <CircleCheckBig className="size-6" />
            </span>
            <p className="font-medium">{onlyMine ? '没有由你负责的事项' : '都处理完了'}</p>
            <p className="max-w-xs text-sm text-muted-foreground">新的候选或需要复核的经验会自动出现在这里。</p>
          </div>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {visible.slice(0, 7).map((r, i) => (
              <li
                key={r.key}
                style={stagger(i)}
                className={cn(
                  'rise group flex min-w-0 items-center gap-3 rounded-xl border bg-background/40 px-3.5 py-3 transition-all duration-300 hover:border-primary/30 hover:bg-accent/40',
                  leaving.has(r.key) && 'pointer-events-none -translate-x-4 opacity-0',
                )}
              >
                <IconTile icon={r.icon} tone={r.tone} className="size-9" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{r.title}</p>
                    <Badge tone={r.tone} className="hidden shrink-0 sm:inline-flex">{r.tag}</Badge>
                    {r.mine && <Badge tone="primary" className="shrink-0">我负责</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.hint}</p>
                </div>
                <div className="shrink-0">{r.actions}</div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
