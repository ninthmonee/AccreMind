import { CircleAlert, FileCheck2, FolderGit2, Gauge, Quote, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip, Ring, StatCard } from '@/components/display';
import { PriorityBadge, TypeChip } from '@/components/entry-badges';
import { toneBg } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { FRESHNESS, MATURITY, STATUS, TYPES } from '@/lib/labels';
import type { EntryStatus, Freshness, ListItem, Maturity } from '@/lib/types';
import { cn, percent } from '@/lib/utils';
import { SERIES } from './charts';

const STATUS_ORDER: EntryStatus[] = ['active', 'probation', 'candidate', 'archived', 'withdrawn'];

/** 总结视图：把当前筛选范围内的经验汇总为数据卡片、图表与关键结论。 */
export function EntrySummary({ items, onOpen, scopeLabel }: { items: ListItem[]; onOpen: (id: string) => void; scopeLabel: string }) {
  const s = useMemo(() => {
    const entries = items.map((i) => i.entry);
    const total = entries.length;
    const p0 = entries.filter((e) => e.priority === 'P0');
    const verified = entries.filter((e) => e.maturity !== 'draft').length;
    const due = entries.filter((e) => e.freshness !== 'current').length;
    const evidence = entries.reduce((n, e) => n + e.evidence.length, 0);

    const byType = TYPES.map((t) => {
      const row: Record<string, number | string> = { type: t.label };
      for (const st of STATUS_ORDER) row[st] = entries.filter((e) => e.type === t.value && e.status === st).length;
      return row;
    }).filter((r) => STATUS_ORDER.some((st) => (r[st] as number) > 0));
    const usedStatus = STATUS_ORDER.filter((st) => entries.some((e) => e.status === st));

    const maturity = (Object.keys(MATURITY) as Maturity[]).map((m) => ({ key: m, ...MATURITY[m], value: entries.filter((e) => e.maturity === m).length }));
    const freshness = (Object.keys(FRESHNESS) as Freshness[]).map((f) => ({ key: f, ...FRESHNESS[f], value: entries.filter((e) => e.freshness === f).length }));

    const paths = new Map<string, number>();
    for (const e of entries) for (const p of e.watch_paths) paths.set(p, (paths.get(p) ?? 0) + 1);
    const hotPaths = [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    return { entries, total, p0, verified, due, evidence, byType, usedStatus, maturity, freshness, hotPaths };
  }, [items]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Gauge} label={`${scopeLabel} · 经验数`} value={s.total} caption={`累计证据 ${s.evidence} 份`} />
        <StatCard icon={ShieldAlert} tone="danger" label="P0 严重事故级" value={s.p0.length} caption={`占比 ${percent(s.p0.length, s.total)}%`} visual={<Ring value={percent(s.p0.length, s.total)} tone="danger" size={56} label="P0 占比" />} />
        <StatCard icon={FileCheck2} tone="success" label="已验证" value={s.verified} caption="已验证或多次验证" visual={<Ring value={percent(s.verified, s.total)} tone="success" size={56} label="验证率" />} />
        <StatCard icon={CircleAlert} tone="warning" label="需复核" value={s.due} caption="待复核或已失效" visual={<Ring value={percent(s.due, s.total)} tone="warning" size={56} label="需复核占比" />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>类型 × 入库状态</CardTitle>
              <CardDescription>每类经验所处的生命周期阶段</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={s.byType} layout="vertical" margin={{ left: 8, right: 28, top: 4, bottom: 4 }} barCategoryGap={10}>
                  <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                  <YAxis type="category" dataKey="type" width={72} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 13 }} />
                  <Tooltip cursor={{ fill: 'var(--accent)', opacity: 0.5 }} content={<ChartTooltip />} />
                  {s.usedStatus.map((st, i) => (
                    <Bar
                      key={st}
                      dataKey={st}
                      name={STATUS[st].label}
                      stackId="s"
                      fill={SERIES[i % SERIES.length]}
                      stroke="var(--card)"
                      strokeWidth={2}
                      radius={i === s.usedStatus.length - 1 ? [0, 4, 4, 0] : 0}
                      maxBarSize={22}
                    >
                      {i === s.usedStatus.length - 1 && (
                        <LabelList
                          position="right"
                          className="fill-muted-foreground text-xs"
                          valueAccessor={(entry: { payload: Record<string, number> }) => s.usedStatus.reduce((n, k) => n + (entry.payload[k] ?? 0), 0)}
                        />
                      )}
                    </Bar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {s.usedStatus.map((st, i) => (
                <span key={st} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
                  {STATUS[st].label}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>成熟度与时效</CardTitle>
              <CardDescription>可信程度与是否仍然适用</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-6">
            {[{ title: '成熟度', rows: s.maturity }, { title: '时效', rows: s.freshness }].map((g) => (
              <div key={g.title}>
                <p className="mb-2.5 text-xs font-medium text-muted-foreground">{g.title}</p>
                <div className="grid gap-2.5">
                  {g.rows.map((r) => (
                    <div key={r.key} className="grid grid-cols-[72px_1fr_32px] items-center gap-3 text-[13px]">
                      <span>{r.label}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-muted">
                        <span className={cn('block h-full rounded-full transition-[width] duration-700', toneBg[r.tone])} style={{ width: `${percent(r.value, s.total)}%` }} />
                      </span>
                      <span className="num text-right font-medium">{r.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <div>
              <CardTitle>关键结论</CardTitle>
              <CardDescription>按优先级排列，忽略它们的代价最高</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2">
            {[...s.entries]
              .sort((a, b) => a.priority.localeCompare(b.priority))
              .slice(0, 6)
              .map((e) => (
                <button key={e.id} type="button" onClick={() => onOpen(e.id)} className="group flex gap-3 rounded-lg border bg-background/40 p-3 text-left transition hover:border-primary/40 hover:bg-accent/50">
                  <Quote className="mt-0.5 size-4 shrink-0 text-primary/70" />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13px] leading-relaxed">{e.claim}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <PriorityBadge priority={e.priority} />
                      <TypeChip type={e.type} />
                      <span className="font-mono text-[11px] text-muted-foreground group-hover:text-primary">{e.id}@r{e.revision}</span>
                    </div>
                  </div>
                </button>
              ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>高频关注路径</CardTitle>
              <CardDescription>改动这些路径时，AI 会收到经验提醒</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {s.hotPaths.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前范围内的经验尚未登记关注路径。</p>
            ) : (
              <ul className="grid gap-2">
                {s.hotPaths.map(([p, n]) => (
                  <li key={p} className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                    <code className="min-w-0 flex-1 truncate text-[12px]">{p}</code>
                    <span className="num text-xs text-muted-foreground">{n} 条</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
