import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { closeDemo, isRpcBusy, openDemo, rpc } from '@/lib/rpc';
import type { EntryStatus, Freshness, KnowledgeLayer, KnowledgeType, Overview } from '@/lib/types';
import { type AsyncState, useAsync } from '@/lib/use-async';
import { type ThemePref, useTheme } from './theme';

export type View = 'home' | 'library' | 'radar' | 'review' | 'governance' | 'receipts';

/** 从别的页面跳到知识库时预置的筛选（例如总览里点“试用中”）。 */
export interface LibraryPreset {
  layer?: KnowledgeLayer;
  type?: KnowledgeType;
  status?: EntryStatus;
  freshness?: Freshness;
}

interface AppState {
  view: View;
  setView: (v: View) => void;
  /** 打开知识库并带上筛选；读取后由知识库清空。 */
  openLibrary: (preset?: LibraryPreset) => void;
  libraryPreset: LibraryPreset | null;
  consumeLibraryPreset: () => void;
  /** 写操作或切换空间后递增，所有读取据此刷新。 */
  revision: number;
  refresh: () => void;
  overview: AsyncState<Overview>;
  demo: boolean;
  switchDemo: () => Promise<void>;
  entryId: string | null;
  openEntry: (id: string | null) => void;
  captureOpen: boolean;
  setCaptureOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  themePref: ThemePref;
  setThemePref: (pref: ThemePref) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setViewState] = useState<View>('home');
  const [revision, setRevision] = useState(0);
  const [demo, setDemo] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [libraryPreset, setLibraryPreset] = useState<LibraryPreset | null>(null);
  const { pref: themePref, setPref: setThemePref } = useTheme();

  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  const overview = useAsync(() => rpc<Overview>('accremind.dashboard.overview'), [revision]);

  const setView = useCallback((v: View) => {
    setViewState(v);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const openLibrary = useCallback((preset?: LibraryPreset) => {
    setLibraryPreset(preset ?? {});
    setViewState('library');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const consumeLibraryPreset = useCallback(() => setLibraryPreset(null), []);

  const switchDemo = useCallback(async () => {
    if (switching) return;
    if (isRpcBusy()) {
      toast.info('请等待当前操作完成后再切换空间');
      return;
    }
    setSwitching(true);
    try {
      if (demo) {
        await closeDemo();
        setDemo(false);
        toast.success('已返回你的工作区');
      } else {
        await openDemo();
        setDemo(true);
        toast.success('已进入演示空间', { description: '所有操作只作用于临时示例项目' });
      }
      setEntryId(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  }, [demo, refresh, switching]);

  const value = useMemo<AppState>(
    () => ({
      view, setView, openLibrary, libraryPreset, consumeLibraryPreset, revision, refresh, overview, demo, switchDemo,
      entryId, openEntry: setEntryId, captureOpen, setCaptureOpen, paletteOpen, setPaletteOpen, themePref, setThemePref,
    }),
    [view, setView, openLibrary, libraryPreset, consumeLibraryPreset, revision, refresh, overview, demo, switchDemo, entryId, captureOpen, paletteOpen, themePref, setThemePref],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp 必须在 AppProvider 内使用');
  return ctx;
}
