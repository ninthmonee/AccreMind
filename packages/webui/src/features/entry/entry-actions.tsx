import { BadgeCheck, Bug, Check, FlaskConical, Sparkles, Stamp, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { ReasonDialog } from '@/components/reason-dialog';
import { Button } from '@/components/ui/button';
import { rpc } from '@/lib/rpc';
import type { KnowledgeEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 经验所处阶段：AI 总结 → 试用 → 正式 → 已验证。当前阶段带呼吸光圈，停用时显示原因。 */
export function EntryStepper({ entry: e }: { entry: KnowledgeEntry }) {
  const steps = [
    { label: 'AI 总结', icon: Sparkles },
    { label: '本机试用', icon: FlaskConical },
    { label: '正式入库', icon: Stamp },
    { label: '已验证', icon: BadgeCheck },
  ];
  const at = e.status === 'candidate' ? 0 : e.status === 'probation' ? 1 : e.status === 'active' ? (e.maturity === 'draft' ? 2 : 3) : 2;
  const stopped = e.status === 'withdrawn' || e.status === 'archived' || e.serving === 'suspended';
  return (
    <ol className="mt-5 grid grid-cols-4" aria-label="经验所处阶段">
      {steps.map((s, i) => {
        const done = i < at || (i === at && i === 3);
        const current = i === at && !done;
        return (
          <li key={s.label} className="relative flex flex-col items-center gap-1.5 text-center">
            {i > 0 && <span className={cn('absolute left-[calc(-50%+18px)] right-[calc(50%+18px)] top-[13px] h-0.5 rounded-full', i <= at ? 'bg-primary' : 'bg-border')} />}
            <span
              className={cn(
                'relative z-10 inline-flex size-7 items-center justify-center rounded-full border-2 transition',
                done && 'border-primary bg-primary text-primary-foreground',
                current && !stopped && 'animate-pulse-ring border-primary bg-card text-primary',
                current && stopped && 'border-muted-foreground/40 bg-muted text-muted-foreground',
                !done && !current && 'border-border bg-card text-muted-foreground',
              )}
            >
              {done ? <Check className="size-3.5" /> : <s.icon className="size-3.5" />}
            </span>
            <span className={cn('text-[11px]', done || current ? 'font-medium text-foreground' : 'text-muted-foreground')}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 详情底部操作：试用转正 / 淘汰；正式经验登记“在任务里有效”或“内容有误”。 */
export function EntryActions({ entry: e }: { entry: KnowledgeEntry }) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const call = async (method: string, params: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await rpc(method, { id: e.id, revision: e.revision, ...params });
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };
  const live = e.status === 'active' || e.status === 'probation';
  if (!live) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-card/80 px-6 py-3 backdrop-blur">
      <span className="mr-auto text-xs text-muted-foreground">{e.status === 'probation' ? '试用中：只提醒、不强制。' : '在任务里用过？告诉我们效果。'}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setWrong(true)}><Bug />内容有误</Button>
      {e.status === 'probation' ? (
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void call('accremind.probation.decide', { action: 'dismiss' }, '已淘汰').catch(() => undefined)}><X />淘汰</Button>
          <Button size="sm" disabled={busy || e.serving !== 'enabled'} onClick={() => void call('accremind.probation.decide', { action: 'promote' }, '已转为正式经验').catch(() => undefined)}><Stamp />转正</Button>
        </>
      ) : (
        <Button size="sm" disabled={busy} onClick={() => void call('accremind.feedback.submit', { kind: 'verified_effective' }, '已登记为在任务中有效').catch(() => undefined)}><BadgeCheck />在任务里有效</Button>
      )}
      <ReasonDialog
        open={wrong}
        onOpenChange={setWrong}
        title="这条经验哪里不对？"
        description={e.title}
        label="哪里不对，你是怎么发现的"
        confirmLabel="提交并暂停提醒"
        danger
        onConfirm={(detail) => call('accremind.feedback.submit', { kind: 'suspected_error', detail }, '已记录，经验暂停提醒等待复核')}
      />
    </div>
  );
}
