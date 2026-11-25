import { Contrast, FlaskConical, LogOut, Monitor, Moon, Plus, Search, Sun } from 'lucide-react';
import brandIcon from '../../../dsh-plugin/icon.svg?inline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tip,
} from '@/components/ui/overlays';
import { Kbd } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { useApp, type View } from './app-context';
import { NAV } from './nav';
import type { ThemePref } from './theme';

function BrandMark() {
  return (
    <img src={brandIcon} width={32} height={32} className="size-8 shrink-0" alt="" aria-hidden="true" />
  );
}

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'dark', label: '石墨（深色）', icon: Moon },
  { value: 'light', label: '纸白（浅色）', icon: Sun },
  { value: 'contrast', label: '高对比', icon: Contrast },
];

export function Header() {
  const { view, setView, overview, demo, switchDemo, setCaptureOpen, setPaletteOpen, themePref: pref, setThemePref: setPref } = useApp();
  const counts = overview.data?.counts;
  const badge: Partial<Record<View, number>> = {
    library: counts?.totalEntries,
    review: counts?.pendingReviewCount,
    governance: counts?.governanceQueueCount,
  };
  const ThemeIcon = THEMES.find((t) => t.value === pref)?.icon ?? Monitor;
  const workspace = demo ? '演示工作区' : overview.data?.projectName || overview.data?.workspaceId || '正在加载…';

  const navButton = (item: (typeof NAV)[number], compact = false) => {
    const active = view === item.id;
    const count = badge[item.id];
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        title={item.label}
        onClick={() => setView(item.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative inline-flex shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50',
          compact ? 'h-9' : 'h-16',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon className={cn('size-4 transition', active ? 'text-primary' : 'opacity-70 group-hover:opacity-100')} />
        <span className={cn(!compact && !active && 'sr-only xl:not-sr-only')}>{item.label}</span>
        {!!count && (
          <span
            className={cn(
              'num inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
              item.id === 'library' ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
            )}
          >
            {count}
          </span>
        )}
        <span
          className={cn(
            'absolute inset-x-3 rounded-full bg-primary transition-opacity',
            compact ? '-bottom-[5px] h-0.5' : 'bottom-0 h-0.5',
            active ? 'opacity-100 shadow-[0_0_12px_var(--primary)]' : 'opacity-0',
          )}
        />
      </button>
    );
  };

  return (
    <header className="border-b bg-background/75 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 md:px-8">
        <button type="button" onClick={() => setView('home')} className="flex shrink-0 items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <BrandMark />
          <span className="font-display text-[17px] font-bold tracking-tight">AccreMind</span>
        </button>
        <Tip content={demo ? '当前在临时演示空间' : '当前项目'}>
          <span className="hidden h-7 max-w-[160px] items-center gap-1.5 rounded-full border bg-card/60 px-2.5 text-xs text-muted-foreground 2xl:inline-flex">
            <span className={cn('size-1.5 shrink-0 rounded-full', demo ? 'bg-warning' : 'bg-success shadow-[0_0_8px_var(--success)]')} />
            <span className="truncate">{workspace}</span>
          </span>
        </Tip>

        <nav aria-label="工作台菜单" className="ml-2 hidden items-center gap-0.5 md:flex">
          {NAV.map((item) => navButton(item))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-9 w-56 items-center gap-2 rounded-lg border bg-card/60 px-3 text-sm text-muted-foreground shadow-xs transition hover:bg-accent hover:text-foreground 2xl:flex"
          >
            <Search className="size-4" />
            <span>搜索经验或操作</span>
            <span className="ml-auto flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
          <Tip content="搜索（⌘K）">
            <Button variant="outline" size="icon" className="2xl:hidden" onClick={() => setPaletteOpen(true)} aria-label="搜索经验或操作">
              <Search />
            </Button>
          </Tip>
          <DropdownMenu>
            <Tip content="界面主题">
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="界面主题">
                  <ThemeIcon />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>界面主题</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
                {THEMES.map((t) => (
                  <DropdownMenuRadioItem key={t.value} value={t.value}>
                    <t.icon />
                    {t.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tip content={demo ? '返回我的工作区' : '在临时项目中体验完整流程'}>
            <Button variant="outline" size="icon" className="xl:w-auto xl:px-3" onClick={switchDemo} aria-label={demo ? '返回我的工作区' : '体验示例'}>
              {demo ? <LogOut /> : <FlaskConical />}
              <span className="hidden xl:inline">{demo ? '返回工作区' : '体验示例'}</span>
            </Button>
          </Tip>
          <Button onClick={() => setCaptureOpen(true)} aria-label="录入经验">
            <Plus />
            <span className="hidden sm:inline">录入经验</span>
          </Button>
        </div>
      </div>

      <nav aria-label="工作台菜单（紧凑）" className="scrollbar-none -mt-1 flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {NAV.map((item) => navButton(item, true))}
      </nav>

      {demo && (
        <div className="border-t border-warning/20 bg-warning/8">
          <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-2 text-[13px] md:px-8">
            <Badge tone="warning" dot>演示空间</Badge>
            <span className="text-muted-foreground">所有操作只作用于临时示例项目，30 分钟无操作自动清理。</span>
            <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={switchDemo}>返回我的工作区</Button>
          </div>
        </div>
      )}
    </header>
  );
}
