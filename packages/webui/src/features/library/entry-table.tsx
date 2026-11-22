import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PriorityBadge, TypeChip } from '@/components/entry-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FRESHNESS, layerLabel, MATURITY, STATUS } from '@/lib/labels';
import type { ListItem } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const priorityRank = { P0: 0, P1: 1, P2: 2 } as const;

/** 表格视图：横向比较结论、适用条件与治理状态。支持排序与分页，行点击打开详情。 */
export function EntryTable({ items, onOpen }: { items: ListItem[]; onOpen: (id: string) => void }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'priority', desc: false }]);

  const columns = useMemo<ColumnDef<ListItem>[]>(
    () => [
      {
        id: 'priority',
        header: '优先级',
        accessorFn: (r) => priorityRank[r.entry.priority],
        cell: ({ row }) => <PriorityBadge priority={row.original.entry.priority} />,
        size: 76,
      },
      {
        id: 'title',
        header: '经验与结论',
        accessorFn: (r) => r.entry.title,
        cell: ({ row }) => {
          const e = row.original.entry;
          return (
            <div className="min-w-[280px] max-w-[520px] py-0.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{e.id}</span>
                <TypeChip type={e.type} />
              </div>
              <p className="mt-1 line-clamp-1 font-medium">{e.title}</p>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{e.claim}</p>
            </div>
          );
        },
      },
      {
        id: 'conditions',
        header: '适用条件',
        enableSorting: false,
        cell: ({ row }) => {
          const pre = row.original.entry.preconditions;
          return (
            <div className="max-w-[260px] text-xs text-muted-foreground">
              <p className="line-clamp-2">{pre[0] ?? '—'}</p>
              {pre.length > 1 && <span className="text-[11px]">另 {pre.length - 1} 条</span>}
            </div>
          );
        },
      },
      { id: 'layer', header: '范围', accessorFn: (r) => layerLabel(r.entry.layer), cell: (c) => <span className="whitespace-nowrap text-[13px]">{c.getValue<string>()}</span> },
      {
        id: 'status',
        header: '状态',
        accessorFn: (r) => r.entry.status,
        cell: ({ row }) => {
          const s = STATUS[row.original.entry.status];
          return <Badge tone={s.tone} dot>{s.label}</Badge>;
        },
      },
      {
        id: 'maturity',
        header: '成熟度',
        accessorFn: (r) => MATURITY[r.entry.maturity].rank,
        cell: ({ row }) => {
          const m = MATURITY[row.original.entry.maturity];
          return (
            <span className="flex items-center gap-2 whitespace-nowrap text-[13px]">
              <span className="flex gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span key={i} className={cn('h-3 w-1 rounded-full', i <= m.rank ? 'bg-success' : 'bg-muted')} />
                ))}
              </span>
              {m.label}
            </span>
          );
        },
      },
      {
        id: 'freshness',
        header: '时效',
        accessorFn: (r) => r.entry.freshness,
        cell: ({ row }) => {
          const f = FRESHNESS[row.original.entry.freshness];
          return <Badge tone={f.tone}>{f.label}</Badge>;
        },
      },
      { id: 'evidence', header: '证据', accessorFn: (r) => r.entry.evidence.length, cell: (c) => <span className="num text-[13px]">{c.getValue<number>()}</span> },
      { id: 'updated', header: '更新于', accessorFn: (r) => r.entry.updated_at, cell: (c) => <span className="num whitespace-nowrap text-[13px] text-muted-foreground">{formatDate(c.getValue<string>())}</span> },
    ],
    [],
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 15 } },
  });

  const page = table.getState().pagination;
  return (
    <div className="surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/40">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b">
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th key={h.id} className="h-10 whitespace-nowrap px-4 text-xs font-medium text-muted-foreground">
                      {h.column.getCanSort() ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex items-center gap-1 rounded hover:text-foreground">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === 'asc' ? <ArrowUp className="size-3" /> : sorted === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                tabIndex={0}
                onClick={() => onOpen(row.original.entry.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(row.original.entry.id)}
                className="cursor-pointer border-b outline-none transition last:border-0 hover:bg-accent/60 focus-visible:bg-accent"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-[13px] text-muted-foreground">
          <span className="num">
            第 {page.pageIndex * page.pageSize + 1}–{Math.min((page.pageIndex + 1) * page.pageSize, items.length)} 条，共 {items.length} 条
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="上一页"><ChevronLeft /></Button>
            <span className="num px-2">{page.pageIndex + 1} / {table.getPageCount()}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="下一页"><ChevronRight /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
