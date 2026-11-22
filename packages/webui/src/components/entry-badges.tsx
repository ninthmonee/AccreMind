import { FRESHNESS, MATURITY, PRIORITY, SERVING, STATUS, typeMeta } from '@/lib/labels';
import type { KnowledgeEntry, Priority } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const tone = PRIORITY[priority].tone;
  return (
    <Badge tone={tone} className={cn('num font-semibold', className)} title={PRIORITY[priority].label}>
      {priority}
    </Badge>
  );
}

export function TypeChip({ type, className }: { type: KnowledgeEntry['type']; className?: string }) {
  const meta = typeMeta(type);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground', className)}>
      <meta.icon className="size-3.5 text-primary" />
      {meta.label}
    </span>
  );
}

/** 治理四维：入库状态 / 成熟度 / 时效 / 检索。只显示需要注意的维度，保持卡片干净。 */
export function GovernanceBadges({ entry, full = false }: { entry: KnowledgeEntry; full?: boolean }) {
  const s = STATUS[entry.status];
  const m = MATURITY[entry.maturity];
  const f = FRESHNESS[entry.freshness];
  const v = SERVING[entry.serving];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={s.tone} dot>{s.label}</Badge>
      <Badge tone={m.tone}>{m.label}</Badge>
      {(full || entry.freshness !== 'current') && <Badge tone={f.tone}>{f.label}</Badge>}
      {(full || entry.serving !== 'enabled') && <Badge tone={v.tone}>{v.label}</Badge>}
    </div>
  );
}
