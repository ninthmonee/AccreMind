import { ArrowRight, ClipboardCheck, FlaskConical, Inbox, type LucideIcon, ShieldCheck, Stamp } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import type { Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';

export interface FlowStage {
  key: string;
  label: string;
  hint: string;
  count: number;
  icon: LucideIcon;
  tone: Tone;
  onClick?: () => void;
}

const ring: Record<Tone, string> = {
  primary: 'text-primary bg-primary/10 ring-primary/30',
  success: 'text-success bg-success/10 ring-success/30',
  warning: 'text-warning bg-warning/10 ring-warning/30',
  danger: 'text-danger bg-danger/10 ring-danger/30',
  info: 'text-info bg-info/10 ring-info/30',
  neutral: 'text-muted-foreground bg-muted ring-border',
};

/** 经验生命周期流程：捕获 → 审核 → 试用 → 入库 → 治理。有待处理数量的阶段连线会流动。 */
export function LifecycleFlow({ stages, className }: { stages: FlowStage[]; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>经验流水线</CardTitle>
          <CardDescription>每条经验从对话或提交历史中被捕获，经审核与本机试用后正式入库，并持续接受时效治理。</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pt-6">
        <ol className="grid gap-3 sm:grid-cols-5 sm:gap-0">
          {stages.map((s, i) => {
            const next = stages[i + 1];
            const moving = s.count > 0 && !!next;
            return (
              <li key={s.key} className="relative flex items-center gap-3 sm:flex-col sm:items-center sm:gap-0 sm:text-center">
                {next && (
                  <div aria-hidden className="absolute left-[calc(50%+30px)] right-[calc(-50%+30px)] top-[26px] hidden h-0.5 sm:block">
                    <div className="absolute inset-0 rounded-full bg-border" />
                    {moving && <div className="flow-line absolute inset-0 animate-flow rounded-full opacity-70" />}
                    <ArrowRight className="absolute -right-1.5 -top-[7px] size-4 text-muted-foreground/60" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={s.onClick}
                  disabled={!s.onClick}
                  className={cn(
                    'group relative z-10 flex size-[52px] shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset outline-none transition',
                    ring[s.tone],
                    s.onClick && 'hover:scale-105 focus-visible:ring-2',
                    s.count > 0 && 'shadow-[0_0_24px_-6px_currentColor]',
                  )}
                  aria-label={`${s.label} ${s.count}`}
                >
                  <s.icon className="size-5" />
                  {s.count > 0 && (
                    <span className="num absolute -right-2 -top-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[11px] font-semibold text-background">
                      {s.count}
                    </span>
                  )}
                </button>
                <div className="min-w-0 sm:mt-3 sm:px-2">
                  <p className="text-sm font-medium">{s.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{s.hint}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

export const FLOW_ICONS = { Inbox, ClipboardCheck, FlaskConical, Stamp, ShieldCheck };
