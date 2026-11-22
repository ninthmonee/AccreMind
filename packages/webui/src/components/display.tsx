/** 业务无关的展示件：页头、数据卡片、环形进度、空状态、图表提示框。 */
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { type Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { toneBg, toneText } from './ui/badge';

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 pb-6 pt-8 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">{eyebrow}</div>}
        <h1 className="font-display text-[28px] font-bold leading-tight tracking-[-0.03em] md:text-[34px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const iconTile: Record<Tone, string> = {
  primary: 'bg-primary/12 text-primary ring-primary/20',
  success: 'bg-success/12 text-success ring-success/20',
  warning: 'bg-warning/12 text-warning ring-warning/20',
  danger: 'bg-danger/12 text-danger ring-danger/20',
  info: 'bg-info/12 text-info ring-info/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

export function IconTile({ icon: Icon, tone = 'primary', className }: { icon: LucideIcon; tone?: Tone; className?: string }) {
  return (
    <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', iconTile[tone], className)}>
      <Icon className="size-[18px]" />
    </span>
  );
}

/** 数据卡片：大号数字 + 说明 + 可选右侧可视化（环/迷你条），整卡可点击跳转。 */
export function StatCard({
  icon,
  tone = 'primary',
  label,
  value,
  suffix,
  caption,
  visual,
  onClick,
  loading,
}: {
  icon: LucideIcon;
  tone?: Tone;
  label: string;
  value: number | string;
  suffix?: string;
  caption?: ReactNode;
  visual?: ReactNode;
  onClick?: () => void;
  loading?: boolean;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'surface group relative flex h-full w-full min-w-0 items-start gap-4 overflow-hidden p-5 text-left outline-none transition',
        onClick && 'cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      <span className={cn('pointer-events-none absolute -right-10 -top-10 size-28 rounded-full opacity-[0.08] blur-2xl', toneBg[tone])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <IconTile icon={icon} tone={tone} className="size-8 [&_svg]:size-4" />
          <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        </div>
        <div className="mt-4 flex items-baseline gap-1.5">
          {loading ? (
            <span className="h-9 w-16 animate-pulse rounded-md bg-muted" />
          ) : (
            <span className="num font-display text-[34px] font-semibold leading-none tracking-tight">{value}</span>
          )}
          {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
        </div>
        {caption && <div className="mt-2 text-xs text-muted-foreground">{caption}</div>}
      </div>
      {visual && <div className="shrink-0 self-center">{visual}</div>}
    </Comp>
  );
}

/** SVG 环形进度，中心显示百分比。 */
export function Ring({ value, size = 64, stroke = 6, tone = 'primary', label }: { value: number; size?: number; stroke?: number; tone?: Tone; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative" style={{ width: size, height: size }} role="img" aria-label={`${label ?? ''} ${v}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-700', toneText[tone])}
          stroke="currentColor"
        />
      </svg>
      <span className="num absolute inset-0 flex items-center justify-center text-[13px] font-semibold">{v}%</span>
    </div>
  );
}

/** 分段比例条：多个状态在一条上的占比，配合图例使用。 */
export function SegmentBar({ parts, className }: { parts: { key: string; value: number; tone: Tone; label: string }[]; className?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className={cn('flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-muted', className)} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join('，')}>
      {total > 0 &&
        parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.key} className={cn('h-full first:rounded-l-full last:rounded-r-full', toneBg[p.tone])} style={{ width: `${(p.value / total) * 100}%` }} />
        ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center', className)}>
      <span className="relative inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
        <Icon className="size-5" />
      </span>
      <div>
        <p className="font-medium">{title}</p>
        {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Recharts 自定义提示框，统一样式。 */
export function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: number; color?: string; payload?: { fill?: string } }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-xl">
      {label && <p className="mb-1.5 font-medium text-foreground">{label}</p>}
      <div className="grid gap-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="size-2 rounded-[3px]" style={{ background: p.color ?? p.payload?.fill }} />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="num ml-auto pl-3 font-semibold text-foreground">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SectionTitle({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** 迷你走势图：单一序列，无坐标轴，末点标记。颜色用图表变量（身份色），不用状态色。 */
export function Sparkline({ values, color = 'var(--chart-1)', width = 112, height = 40, className }: { values: number[]; color?: string; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const id = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('overflow-visible', className)} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.28} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="animate-[draw_1s_ease-out_both]" pathLength={1} strokeDasharray={1} />
      <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="var(--card)" strokeWidth={2} />
    </svg>
  );
}

/** 环比变化：上升 / 下降 / 持平，带箭头与文字，不只靠颜色。 */
export function Delta({ value, suffix = '' }: { value: number; suffix?: string }) {
  const tone = value > 0 ? 'bg-success/12 text-success' : value < 0 ? 'bg-danger/12 text-danger' : 'bg-muted text-muted-foreground';
  return (
    <span className={cn('num inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-semibold', tone)}>
      {value > 0 ? '↑' : value < 0 ? '↓' : '→'}
      {value === 0 ? '持平' : `${value > 0 ? '+' : ''}${value}${suffix}`}
    </span>
  );
}

/** 自上而下渐入：列表与卡片进场时错开 40ms。 */
export function stagger(i: number): CSSProperties {
  return { animationDelay: `${Math.min(i, 12) * 40}ms` };
}
