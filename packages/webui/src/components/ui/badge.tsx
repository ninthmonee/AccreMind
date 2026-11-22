import type { ComponentProps } from 'react';
import type { Tone } from '@/lib/labels';
import { cn } from '@/lib/utils';

const toneClass: Record<Tone, string> = {
  primary: 'bg-primary/12 text-primary ring-primary/25',
  success: 'bg-success/12 text-success ring-success/25',
  warning: 'bg-warning/12 text-warning ring-warning/25',
  danger: 'bg-danger/12 text-danger ring-danger/25',
  info: 'bg-info/12 text-info ring-info/25',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

const dotClass: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted-foreground/60',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  className,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: Tone; dot?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium ring-1 ring-inset [&_svg]:size-3.5',
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className={cn('size-1.5 rounded-full', dotClass[tone])} />}
      {children}
    </span>
  );
}

export const toneText: Record<Tone, string> = {
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-muted-foreground',
};
export const toneBg = dotClass;
