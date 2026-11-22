/** Dialog / Sheet / Tooltip / DropdownMenu / Select / Tabs / ToggleGroup —— 基于 Radix 的 shadcn/ui 风格封装。 */
import { Check, ChevronDown, X } from 'lucide-react';
import {
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  Select as SelectPrimitive,
  Tabs as TabsPrimitive,
  ToggleGroup as TogglePrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* ---------------- Dialog & Sheet ---------------- */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

function Overlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  overlayClassName,
  hideClose = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string; hideClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <Overlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid max-h-[min(88dvh,860px)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]',
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Sheet = DialogPrimitive.Root;
export function SheetContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l bg-popover text-popover-foreground shadow-2xl outline-none sm:w-[min(760px,92vw)] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-200',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground">
          <X className="size-4" />
          <span className="sr-only">关闭详情</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/* ---------------- Tooltip ---------------- */
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ---------------- DropdownMenu ---------------- */
export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export function DropdownMenuContent({ className, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={6}
        className={cn(
          'z-50 min-w-44 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}
export function DropdownMenuItem({ className, tone, ...props }: ComponentProps<typeof MenuPrimitive.Item> & { tone?: 'danger' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground',
        tone === 'danger' && 'text-danger [&_svg]:!text-danger',
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-lg py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="!text-primary" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}
export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-3 py-1.5 text-xs text-muted-foreground', className)} {...props} />;
}

/* ---------------- Select ---------------- */
export function SimpleSelect<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  ariaLabel,
  icon,
}: {
  value: T | '';
  onValueChange: (v: T | '') => void;
  options: { value: T; label: string; hint?: string }[];
  placeholder: string;
  className?: string;
  ariaLabel: string;
  icon?: ReactNode;
}) {
  const ALL = '__all__';
  return (
    <SelectPrimitive.Root value={value || ALL} onValueChange={(v) => onValueChange(v === ALL ? '' : (v as T))}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex h-9 min-w-0 items-center gap-2 rounded-lg border border-input bg-card/60 px-3 text-sm shadow-xs outline-none transition hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/20 data-[placeholder]:text-muted-foreground [&>span]:truncate',
          value && 'border-primary/40 text-foreground',
          className,
        )}
      >
        {icon}
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="ml-auto">
          <ChevronDown className="size-4 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <SelectPrimitive.Viewport>
            {[{ value: ALL, label: placeholder, hint: undefined as string | undefined }, ...options].map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none items-center gap-2 rounded-lg py-2 pl-8 pr-3 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <span className="absolute left-2.5 flex size-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-4 text-primary" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && <span className="ml-auto pl-4 text-xs text-muted-foreground">{o.hint}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* ---------------- Tabs ---------------- */
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('scrollbar-none flex items-center gap-1 overflow-x-auto border-b', className)}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-sm font-medium text-muted-foreground outline-none transition hover:text-foreground data-[state=active]:text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition data-[state=active]:after:opacity-100 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

/* ---------------- ToggleGroup（分段控件） ---------------- */
export function Segmented<T extends string>({
  value,
  onValueChange,
  items,
  ariaLabel,
  className,
}: {
  value: T;
  onValueChange: (v: T) => void;
  items: { value: T; label: ReactNode; icon?: ReactNode; count?: number }[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <TogglePrimitive.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={ariaLabel}
      className={cn('inline-flex h-9 items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5', className)}
    >
      {items.map((item) => (
        <TogglePrimitive.Item
          key={item.value}
          value={item.value}
          className="inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:size-4"
        >
          {item.icon}
          {item.label}
          {item.count !== undefined && <span className="num text-xs text-muted-foreground">{item.count}</span>}
        </TogglePrimitive.Item>
      ))}
    </TogglePrimitive.Root>
  );
}
