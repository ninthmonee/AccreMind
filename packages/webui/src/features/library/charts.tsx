import type { ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartTooltip } from '@/components/display';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** 环形占比图 + 右侧图例（带数量与百分比，身份不只靠颜色）。颜色按类别固定顺序分配。 */
export function DonutCard({
  title,
  description,
  data,
  centerLabel,
  centerValue,
  onSelect,
  className,
}: {
  title: string;
  description?: string;
  data: { key: string; label: string; value: number; fill?: string; icon?: ReactNode }[];
  centerLabel: string;
  /** 中心显示的数字，默认是合计。 */
  centerValue?: string | number;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const colored = data.map((d, i) => ({ ...d, fill: d.fill ?? SERIES[i % SERIES.length]! }));
  const shown = colored.filter((d) => d.value > 0);
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col xl:flex-row">
        <div className="relative size-[148px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={shown.length ? shown : [{ key: 'none', label: '暂无', value: 1, fill: 'var(--border)' }]}
                dataKey="value"
                nameKey="label"
                innerRadius={52}
                outerRadius={72}
                paddingAngle={shown.length > 1 ? 3 : 0}
                cornerRadius={4}
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive
              >
                {(shown.length ? shown : [{ key: 'none', fill: 'var(--border)' }]).map((d) => (
                  <Cell key={d.key} fill={d.fill} className={cn(onSelect && 'cursor-pointer outline-none')} onClick={() => d.key !== 'none' && onSelect?.(d.key)} />
                ))}
              </Pie>
              {shown.length > 0 && <Tooltip content={<ChartTooltip />} />}
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="num font-display text-2xl font-semibold leading-none">{centerValue ?? total}</span>
            <span className="mt-1 text-[11px] text-muted-foreground">{centerLabel}</span>
          </div>
        </div>
        <ul className="grid w-full min-w-0 gap-1">
          {colored.map((d) => (
            <li key={d.key}>
              <button
                type="button"
                disabled={!onSelect}
                onClick={() => onSelect?.(d.key)}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition enabled:hover:bg-accent"
              >
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: d.fill }} />
                {d.icon && <span className="text-muted-foreground [&_svg]:size-3.5">{d.icon}</span>}
                <span className={cn('min-w-0 flex-1 truncate', d.value === 0 && 'text-muted-foreground')}>{d.label}</span>
                <span className="num font-medium">{d.value}</span>
                <span className="num w-9 text-right text-xs text-muted-foreground">{total ? Math.round((d.value / total) * 100) : 0}%</span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
