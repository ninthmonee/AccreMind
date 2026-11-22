import { ChartSpline, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltip } from '@/components/display';
import { Segmented } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/primitives';
import type { InsightsDay } from '@/lib/types';

const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
};

/**
 * 提醒与反馈趋势：同一纵轴的两条序列（提醒 AI 用面积，有帮助用线），十字线提示框，
 * 可切换为表格查看每日明细；时间范围 7 / 28 / 90 天。
 */
export function TrendCard({
  daily,
  days,
  onDaysChange,
  loading,
  className,
}: {
  daily: InsightsDay[] | undefined;
  days: number;
  onDaysChange: (d: number) => void;
  loading: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const data = (daily ?? []).map((d) => ({ ...d, label: shortDate(d.date) }));
  return (
    <Card className={className}>
      <CardHeader className="flex-wrap">
        <div>
          <CardTitle>AI 被提醒与反馈趋势</CardTitle>
          <CardDescription>每天按需提醒 AI 的次数（提问雷达 + 文件护栏，不含每轮都带的常驻规范），以及“有帮助”反馈。</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<string>
            ariaLabel="时间范围"
            value={String(days)}
            onValueChange={(v) => onDaysChange(Number(v))}
            items={[
              { value: '7', label: '7 天' },
              { value: '28', label: '28 天' },
              { value: '90', label: '90 天' },
            ]}
          />
          <Segmented<'chart' | 'table'>
            ariaLabel="展示方式"
            value={mode}
            onValueChange={setMode}
            items={[
              { value: 'chart', label: <span className="sr-only">图表</span>, icon: <ChartSpline /> },
              { value: 'table', label: <span className="sr-only">表格</span>, icon: <Table2 /> },
            ]}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-chart-1" />按需提醒</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded-full bg-chart-3" />有帮助</span>
        </div>
        {loading && !daily ? (
          <Skeleton className="h-[240px] w-full rounded-lg" />
        ) : mode === 'chart' ? (
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3', strokeOpacity: 0.5 }} />
                <Area type="monotone" dataKey="reminders" name="按需提醒" stroke="var(--chart-1)" strokeWidth={2} fill="url(#trend-fill)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} animationDuration={900} />
                <Line type="monotone" dataKey="helpful" name="有帮助" stroke="var(--chart-3)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} animationDuration={900} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="max-h-[240px] overflow-auto rounded-lg border">
            <table className="num w-full text-[13px]">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">日期</th>
                  <th className="px-3 py-2 text-right font-medium">按需提醒</th>
                  <th className="px-3 py-2 text-right font-medium">常驻规范回合</th>
                  <th className="px-3 py-2 text-right font-medium">有帮助</th>
                  <th className="px-3 py-2 text-right font-medium">不适用</th>
                  <th className="px-3 py-2 text-right font-medium">疑似错误</th>
                </tr>
              </thead>
              <tbody>
                {[...data].reverse().map((d) => (
                  <tr key={d.date} className="border-b last:border-0 hover:bg-accent/50">
                    <td className="px-3 py-1.5">{d.date}</td>
                    <td className="px-3 py-1.5 text-right">{d.reminders}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{d.ruleTurns}</td>
                    <td className="px-3 py-1.5 text-right">{d.helpful}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{d.inapplicable}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{d.wrong}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
