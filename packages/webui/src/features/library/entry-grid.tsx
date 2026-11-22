import { Anchor, ArrowUpRight, FileCheck2, Sparkles, Tag } from 'lucide-react';
import { GovernanceBadges, PriorityBadge, TypeChip } from '@/components/entry-badges';
import { layerLabel, ZONE } from '@/lib/labels';
import type { ListItem } from '@/lib/types';
import { cn, relativeDays } from '@/lib/utils';

/** 卡片视图：适合逐条阅读。突出“代码外增量”，并把治理状态收在底部。 */
export function EntryGrid({ items, onOpen }: { items: ListItem[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
      {items.map(({ entry, storageZone, probationExposures }) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onOpen(entry.id)}
          className={cn(
            'surface group relative flex flex-col gap-3.5 overflow-hidden p-5 text-left outline-none transition duration-200',
            'hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-[0_18px_40px_-20px_color-mix(in_srgb,var(--primary)_45%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-0 left-0 w-[3px]',
              entry.priority === 'P0' ? 'bg-danger' : entry.priority === 'P1' ? 'bg-warning' : 'bg-border',
            )}
          />
          <div className="flex items-center gap-2">
            <TypeChip type={entry.type} />
            <span className="text-border">·</span>
            <span className="text-xs text-muted-foreground">{layerLabel(entry.layer)}</span>
            <span className="ml-auto flex items-center gap-2">
              <PriorityBadge priority={entry.priority} />
              <span className="font-mono text-[11px] text-muted-foreground">{entry.id}@r{entry.revision}</span>
            </span>
          </div>

          <div>
            <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight group-hover:text-primary">{entry.title}</h3>
            <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{entry.claim}</p>
          </div>

          {entry.knowledge_delta && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2.5">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                <Sparkles className="size-3" />代码外增量
              </p>
              <p className="line-clamp-2 text-[13px] leading-relaxed text-foreground/90">{entry.knowledge_delta}</p>
            </div>
          )}

          {entry.search_aliases.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="size-3.5 text-muted-foreground" />
              {entry.search_aliases.slice(0, 4).map((a) => (
                <span key={a} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{a}</span>
              ))}
              {entry.search_aliases.length > 4 && <span className="text-[11px] text-muted-foreground">+{entry.search_aliases.length - 4}</span>}
            </div>
          )}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3.5">
            <GovernanceBadges entry={entry} />
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1" title="证据"><FileCheck2 className="size-3.5" />{entry.evidence.length}</span>
              <span className="flex items-center gap-1" title="符号锚点"><Anchor className="size-3.5" />{entry.symbol_anchors.length}</span>
              <ArrowUpRight className="size-4 opacity-0 transition group-hover:opacity-100" />
            </div>
          </div>
          <p className="-mt-1.5 text-[11px] text-muted-foreground">
            {ZONE[storageZone]}
            {entry.status === 'probation' && probationExposures !== undefined && ` · 已曝光 ${probationExposures} 次`}
            {' · '}复核 {relativeDays(entry.review_due_at)}
          </p>
        </button>
      ))}
    </div>
  );
}
