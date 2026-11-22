import { useEffect, useRef } from 'react';
import { Toaster } from 'sonner';
import { AppProvider, useApp } from './app/app-context';
import { CaptureDialog } from './app/capture-dialog';
import { CommandPalette } from './app/command-palette';
import { Header } from './app/header';
import { TooltipProvider } from './components/ui/overlays';
import { EntrySheet } from './features/entry/entry-sheet';
import { DocsPage } from './features/docs/docs-page';
import { GovernancePage } from './features/governance/governance-page';
import { HomePage } from './features/home/home-page';
import { LibraryPage } from './features/library/library-page';
import { RadarPage } from './features/radar/radar-page';
import { ReceiptsPage } from './features/receipts/receipts-page';
import { ReviewPage } from './features/review/review-page';
import { isDemo, isRpcBusy } from './lib/rpc';

function Shell() {
  const { view, themePref, switchDemo, overview } = useApp();
  const headerWrap = useRef<HTMLDivElement>(null);

  // 粘性工具栏需要知道顶栏实际高度（移动端多一行菜单、演示空间多一条提示）。
  useEffect(() => {
    const el = headerWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 独立预览可用 ?demo=1 直接进入演示空间。须等首屏读取结束，否则会被“请等待当前操作完成”拦下。
  const autoDemo = useRef(window === window.top && new URLSearchParams(location.search).get('demo') === '1');
  useEffect(() => {
    if (!autoDemo.current || overview.loading || isRpcBusy() || isDemo()) return;
    autoDemo.current = false;
    void switchDemo();
  }, [overview.loading, switchDemo]);

  return (
    <>
      <div ref={headerWrap} className="sticky top-0 z-40">
        <Header />
      </div>
      <main className="mx-auto w-full max-w-[1440px] px-4 md:px-8">
        <div key={view} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
          {view === 'home' && <HomePage />}
          {view === 'library' && <LibraryPage />}
          {view === 'review' && <ReviewPage />}
          {view === 'governance' && <GovernancePage />}
          {view === 'receipts' && <ReceiptsPage />}
          {view === 'radar' && <RadarPage />}
          {view === 'docs' && <DocsPage />}
        </div>
      </main>
      <footer className="mx-auto flex max-w-[1440px] flex-wrap justify-between gap-2 border-t px-4 py-6 text-xs text-muted-foreground md:px-8">
        <span>AccreMind · 本地优先的研发经验增量引擎</span>
        <span>数据只保存在本机与当前仓库</span>
      </footer>
      <EntrySheet />
      <CaptureDialog />
      <CommandPalette />
      <Toaster position="bottom-right" theme={themePref === 'light' ? 'light' : themePref === 'system' ? 'system' : 'dark'} richColors closeButton />
    </>
  );
}

export function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <AppProvider>
        <Shell />
      </AppProvider>
    </TooltipProvider>
  );
}
