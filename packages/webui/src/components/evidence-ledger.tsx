import {
  BadgeCheck,
  Ban,
  CircleSlash,
  Clock,
  FileWarning,
  Gavel,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Stamp,
  ThumbsUp,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { MATURITY, type Tone } from '@/lib/labels';
import type { EvidenceCompare, EvidenceSnapshot, LedgerRecord, LedgerStanding, SnapshotVerification } from '@/lib/types';
import { cn, formatDate, shortSha } from '@/lib/utils';

const dateTime = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => (Number.isNaN(new Date(iso).getTime()) ? iso : dateTime.format(new Date(iso)));

/** 证据摘录：等宽、带行号起点，长摘录可滚动。 */
export function Excerpt({ text, start, tone = 'neutral', className }: { text: string; start?: number | null; tone?: 'neutral' | 'then' | 'now'; className?: string }) {
  const lines = text.split('\n');
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded-lg border py-2 font-mono text-[12px] leading-[1.65]',
        tone === 'then' ? 'border-info/30 bg-info/5' : tone === 'now' ? 'border-warning/30 bg-warning/5' : 'bg-background/60',
        className,
      )}
    >
      {lines.map((l, i) => (
        <div key={i} className="flex">
          {start ? <span className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground/60">{start + i}</span> : <span className="w-3 shrink-0" />}
          <span className="whitespace-pre-wrap break-all pr-3">{l || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

const VERIFY: Record<SnapshotVerification['status'], { label: string; tone: Tone; icon: LucideIcon }> = {
  verified: { label: '与 Git 一致', tone: 'success', icon: ShieldCheck },
  mismatch: { label: '与 Git 不一致', tone: 'danger', icon: ShieldAlert },
  unavailable: { label: '无法校验', tone: 'neutral', icon: ShieldQuestion },
};

export function VerifyBadge({ v }: { v: SnapshotVerification }) {
  const m = VERIFY[v.status];
  return (
    <Badge tone={m.tone} title={v.detail}>
      <m.icon />
      {m.label}
    </Badge>
  );
}

/** 快照元信息：哪个提交、哪几行、谁在什么时候拍的、是否脱敏。 */
export function SnapshotMeta({ s }: { s: EvidenceSnapshot }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1"><Clock className="size-3" />{when(s.capturedAt)} · {s.capturedBy}</span>
      <span>版本 r{s.revision}</span>
      {s.commit && <span className="font-mono">@{shortSha(s.commit)}</span>}
      {s.filePath && s.startLine && <span className="font-mono">{s.filePath}#L{s.startLine}-L{s.endLine}</span>}
      {s.redacted > 0 && <Badge tone="warning">已脱敏 {s.redacted} 处</Badge>}
      {s.truncated && <span>仅保留前 20 行</span>}
    </div>
  );
}

/** 复核用：当时的证据 ↔ 现在的内容，并给出是否变化与 Git 校验结果。 */
export function EvidenceCompareView({ items }: { items: EvidenceCompare[] }) {
  if (!items.length) return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">这条经验没有登记证据</p>;
  return (
    <div className="grid gap-4">
      {items.map((it) => (
        <div key={it.evidenceId} className="rounded-xl border bg-background/40 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground">{it.evidenceId}</span>
            <code className="truncate text-muted-foreground">{it.locator}</code>
            <span className="ml-auto flex gap-1.5">
              {it.changed === null ? <Badge tone="neutral">没有快照</Badge> : it.changed ? <Badge tone="warning" dot>内容已变化</Badge> : <Badge tone="success" dot>内容未变</Badge>}
              {it.verification && <VerifyBadge v={it.verification} />}
            </span>
          </div>
          {it.then ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-semibold text-info">当时（批准或上次确认）</p>
                <Excerpt text={it.then.excerpt} start={it.then.startLine} tone="then" />
                <div className="mt-1.5"><SnapshotMeta s={it.then} /></div>
              </div>
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-semibold text-warning">现在</p>
                <Excerpt text={it.now.excerpt} start={it.then.startLine} tone={it.changed ? 'now' : 'neutral'} />
                {it.now.commit && <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">@{shortSha(it.now.commit)}{it.now.truncated ? ' · 仅显示前 20 行' : ''}</p>}
              </div>
            </div>
          ) : (
            <>
              <p className="mb-1.5 text-xs text-muted-foreground">这条证据还没有快照（早于快照功能入库）。现在的内容：</p>
              <Excerpt text={it.now.excerpt} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const KIND: Record<string, { label: string; tone: Tone; icon: LucideIcon }> = {
  validated: { label: '确认有效', tone: 'success', icon: ThumbsUp },
  counterexample: { label: '提出反证', tone: 'danger', icon: Ban },
  inapplicable: { label: '这里不适用', tone: 'neutral', icon: CircleSlash },
};
const ACTION: Record<string, string> = {
  publish: '发布', promote: '转正', dismiss: '淘汰', stale: '标记失效', request_review: '送回复核',
  resume: '解除反证', withdraw: '撤回', confirm_fresh: '复核后确认仍然成立',
};

/** 验证账本：推算出的成熟度 + 每条记录的时间线。 */
export function LedgerPanel({ shared, standing, records, revision }: { shared: boolean; standing: LedgerStanding; records: LedgerRecord[]; revision: number }) {
  const m = MATURITY[standing.maturity];
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border bg-background/40 p-4">
          <p className="text-xs text-muted-foreground">按账本推算</p>
          <div className="mt-2 flex items-center gap-2">
            <Badge tone={m.tone}>{m.label}</Badge>
            {standing.unresolvedCounterexample && <Badge tone="danger" dot>有未解决的反证</Badge>}
          </div>
        </div>
        <div className="rounded-xl border bg-background/40 p-4">
          <p className="text-xs text-muted-foreground">独立任务确认</p>
          <p className="num mt-1 font-display text-2xl font-semibold">{standing.successTasks}</p>
        </div>
        <div className="rounded-xl border bg-background/40 p-4">
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><Users className="size-3.5" />确认人</p>
          <p className="mt-1.5 truncate text-sm">{standing.confirmers.length ? standing.confirmers.join('、') : '—'}</p>
          {standing.author && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">作者 {standing.author}</p>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {shared ? '验证记录随仓库共享：团队里需要作者以外的人确认，才能算“多次验证”。' : '验证记录只保存在本机。开启共享后会写入仓库的 .accremind/ledger。'}
        只有针对当前版本（r{revision}）原文的记录才计数；改了正文，之前的确认就不再算。
      </p>
      {records.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">还没有验证或治理记录</p>
      ) : (
        <ol className="relative grid gap-3 border-l pl-6">
          {records.map((r) => {
            const k = r.kind === 'decision' ? { label: ACTION[r.action ?? ''] ?? r.action ?? '决定', tone: 'info' as Tone, icon: r.action === 'publish' ? Stamp : Gavel } : KIND[r.kind] ?? { label: r.kind, tone: 'neutral' as Tone, icon: FileWarning };
            const stale = r.revision !== revision;
            return (
              <li key={r.id} className={cn('relative', stale && 'opacity-60')}>
                <span className="absolute -left-[33px] top-0.5 flex size-[18px] items-center justify-center rounded-full border bg-popover">
                  <k.icon className="size-3 text-muted-foreground" />
                </span>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={k.tone}>{k.label}</Badge>
                  <span className="text-muted-foreground">{r.actor}</span>
                  <span className="text-muted-foreground">{formatDate(r.at)}</span>
                  {stale ? <span className="text-muted-foreground">旧版本 r{r.revision}，不再计数</span> : <span className="inline-flex items-center gap-0.5 text-muted-foreground"><BadgeCheck className="size-3" />r{r.revision}</span>}
                </div>
                {r.note && <p className="mt-1 text-sm leading-relaxed">{r.note}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
