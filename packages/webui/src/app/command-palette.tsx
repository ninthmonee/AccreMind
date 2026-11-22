import { Command } from 'cmdk';
import { Contrast, CornerDownLeft, FlaskConical, Moon, Plus, Search, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/primitives';
import { STATUS, typeMeta } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { KbListResult } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { useApp } from './app-context';
import { NAV } from './nav';

const itemClass =
  'flex cursor-default select-none items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const groupClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/** ⌘K 命令面板：跳转菜单、按标题/编号/别名找经验、执行常用操作。 */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setView, openEntry, setCaptureOpen, switchDemo, demo, revision, setThemePref } = useApp();
  const entries = useAsync(
    () => (paletteOpen ? rpc<KbListResult>('accremind.kb.list', { adminView: true }) : Promise.resolve(undefined)),
    [paletteOpen, revision],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, setPaletteOpen]);

  const run = (fn: () => void) => {
    setPaletteOpen(false);
    fn();
  };

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      label="搜索经验或操作"
      overlayClassName="cmdk-mask fixed inset-0 z-50 bg-black/45 backdrop-blur-[3px]"
      contentClassName="fixed left-1/2 top-[14vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center gap-3 border-b px-4">
        <Search className="size-4 text-muted-foreground" />
        <Command.Input
          placeholder="搜索经验标题、编号、别名，或输入操作…"
          className="h-13 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground/70"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
        <Command.Empty className="py-10 text-center text-sm text-muted-foreground">没有找到匹配的经验或操作</Command.Empty>
        <Command.Group heading="前往" className={groupClass}>
          {NAV.map((n) => (
            <Command.Item key={n.id} value={`前往 ${n.label} ${n.desc}`} onSelect={() => run(() => setView(n.id))} className={itemClass}>
              <n.icon />
              <span>{n.label}</span>
              <span className="ml-auto text-xs text-muted-foreground">{n.desc}</span>
            </Command.Item>
          ))}
        </Command.Group>
        {!!entries.data?.items.length && (
          <Command.Group heading="经验" className={groupClass}>
            {entries.data.items.map(({ entry }) => {
              const Icon = typeMeta(entry.type).icon;
              return (
                <Command.Item
                  key={entry.id}
                  value={`${entry.id} ${entry.title} ${entry.search_aliases.join(' ')}`}
                  onSelect={() => run(() => openEntry(entry.id))}
                  className={itemClass}
                >
                  <Icon />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  <Badge tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{entry.id}</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}
        <Command.Group heading="操作" className={groupClass}>
          <Command.Item value="录入经验 新建" onSelect={() => run(() => setCaptureOpen(true))} className={itemClass}>
            <Plus />录入一条经验
          </Command.Item>
          <Command.Item value="演示 体验示例 返回工作区" onSelect={() => run(() => void switchDemo())} className={itemClass}>
            <FlaskConical />{demo ? '返回我的工作区' : '进入演示空间'}
          </Command.Item>
          <Command.Item value="主题 深色 石墨" onSelect={() => run(() => setThemePref('dark'))} className={itemClass}><Moon />切换到石墨（深色）</Command.Item>
          <Command.Item value="主题 浅色 纸白" onSelect={() => run(() => setThemePref('light'))} className={itemClass}><Sun />切换到纸白（浅色）</Command.Item>
          <Command.Item value="主题 高对比" onSelect={() => run(() => setThemePref('contrast'))} className={itemClass}><Contrast />切换到高对比</Command.Item>
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-4 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
        <span className="flex items-center gap-1.5"><Kbd><CornerDownLeft className="size-3" /></Kbd>打开</span>
      </div>
    </Command.Dialog>
  );
}
