import {
  ChartPie,
  FlaskConical,
  LayoutGrid,
  LibraryBig,
  Radar,
  RotateCcw,
  Search,
  Table2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/app-context';
import { EmptyState, PageHeader } from '@/components/display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Segmented, SimpleSelect } from '@/components/ui/overlays';
import { Input, Skeleton } from '@/components/ui/primitives';
import { FRESHNESS, LAYERS, STATUS, TYPES } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { DomainsOverview, EntryStatus, Freshness, KbListResult, KnowledgeLayer, KnowledgeType, SubprojectDef } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { EntryGrid } from './entry-grid';
import { EntrySummary } from './entry-summary';
import { EntryTable } from './entry-table';

type ViewMode = 'cards' | 'table' | 'summary';
interface Filters {
  layer: KnowledgeLayer | '';
  query: string;
  type: KnowledgeType | '';
  status: EntryStatus | '';
  freshness: Freshness | '';
  /** Catalog domain ID; also matches its other spellings and sub-domains. */
  domain: string;
  subproject: string;
}
const blank: Filters = { layer: '', query: '', type: '', status: '', freshness: '', domain: '', subproject: '' };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LibraryPage() {
  const { overview, revision, openEntry, setView, demo, switchDemo, libraryPreset, consumeLibraryPreset } = useApp();
  const [filters, setFilters] = useState<Filters>(() => ({ ...blank, ...(libraryPreset ?? {}) }));

  // 从总览等页面带过来的筛选：每次跳转都应用一次，然后清空。
  useEffect(() => {
    if (!libraryPreset) return;
    setFilters({ ...blank, ...libraryPreset });
    consumeLibraryPreset();
  }, [libraryPreset, consumeLibraryPreset]);
  const [mode, setMode] = useState<ViewMode>('cards');
  const libraryRef = useRef<HTMLElement>(null);
  const query = useDebounced(filters.query, 250);
  const catalog = useAsync(() => rpc<DomainsOverview>('accremind.domains.list'), [revision]);
  const profile = useAsync(() => rpc<{ subprojects: SubprojectDef[] }>('accremind.repo.profile'), [revision]);
  const domainOptions = (catalog.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name, hint: d.myRole ? '本仓库' : undefined }));
  const subprojectOptions = (profile.data?.subprojects ?? []).map((sp) => ({ value: sp.id, label: sp.name ?? sp.id }));

  const list = useAsync(
    () =>
      rpc<KbListResult>('accremind.kb.list', {
        adminView: true,
        layer: filters.layer || undefined,
        type: filters.type || undefined,
        status: filters.status || undefined,
        freshness: filters.freshness || undefined,
        domain: filters.domain || undefined,
        subproject: filters.subproject || undefined,
        query: query.trim() || undefined,
      }),
    [filters.layer, filters.type, filters.status, filters.freshness, filters.domain, filters.subproject, query, revision],
  );

  const c = overview.data?.counts;
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const active = Object.entries(filters).filter(([k, v]) => k !== 'layer' && v).length;
  const patch = (p: Partial<Filters>, scroll = false) => {
    setFilters((f) => ({ ...f, ...p }));
    if (scroll) requestAnimationFrame(() => libraryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const empty = !overview.loading && c?.totalEntries === 0;

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={
          <>
            <span>{demo ? '演示工作区' : overview.data?.projectName ?? '工作区'}</span>
            <span className="text-border">/</span>
            <span className="text-foreground">知识库</span>
          </>
        }
        title="团队研发经验知识库"
        description={<>共 <b className="num text-foreground">{c?.totalEntries ?? 0}</b> 条经验，其中 <b className="num text-foreground">{c?.activeCount ?? 0}</b> 条正式入库、<b className="num text-foreground">{c?.probationCount ?? 0}</b> 条试用中。只沉淀代码与文档难以恢复的隐性约束、架构取舍与排障结论。</>}
        actions={
          <>
            <Button variant="outline" onClick={() => setView('radar')}>
              <Radar />扫描仓库历史
            </Button>
            {!demo && (
              <Button variant="outline" onClick={() => void switchDemo()}>
                <FlaskConical />体验示例
              </Button>
            )}
          </>
        }
      />

      {overview.error && (
        <div role="alert" className="mb-6 flex items-center gap-3 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
          <TriangleAlert className="size-4 text-danger" />
          <span className="flex-1">{overview.error.message}</span>
          <Button size="sm" variant="outline" onClick={overview.reload}>重试</Button>
        </div>
      )}

      {/* ---------- 经验列表 ---------- */}
      <section ref={libraryRef} aria-label="经验条目" className="scroll-mt-24">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">经验条目</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                卡片用于阅读单条经验，表格用于比较结论与条件，总结按当前筛选范围汇总。
              </p>
            </div>
            <Segmented<ViewMode>
              ariaLabel="展示方式"
              value={mode}
              onValueChange={setMode}
              items={[
                { value: 'cards', label: '卡片', icon: <LayoutGrid /> },
                { value: 'table', label: '表格', icon: <Table2 /> },
                { value: 'summary', label: '总结', icon: <ChartPie /> },
              ]}
            />
          </div>

          <div className="surface sticky top-[calc(var(--header-h,64px)+12px)] z-20 flex flex-col gap-3 p-3">
            <div className="scrollbar-none -mx-1 overflow-x-auto px-1">
              <Segmented<KnowledgeLayer | 'all'>
                ariaLabel="按知识范围浏览"
                value={filters.layer || 'all'}
                onValueChange={(v) => patch({ layer: v === 'all' ? '' : v })}
                items={[
                  { value: 'all', label: '全部', count: list.data ? Object.values(list.data.scopeCounts).reduce((a, b) => a + b, 0) : undefined },
                  ...LAYERS.map((l) => ({ value: l.value, label: l.label, count: list.data?.scopeCounts[l.value] })),
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filters.query}
                  onChange={(e) => patch({ query: e.target.value })}
                  placeholder="搜标题、结论或口语别名，如“重复扣款”“被踢下线”"
                  className="pl-9"
                  aria-label="搜索经验"
                />
              </div>
              <SimpleSelect ariaLabel="知识类型" placeholder="全部类型" value={filters.type} onValueChange={(v) => patch({ type: v })} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} className="w-[132px]" />
              <SimpleSelect ariaLabel="入库状态" placeholder="全部状态" value={filters.status} onValueChange={(v) => patch({ status: v })} options={(Object.keys(STATUS) as EntryStatus[]).map((k) => ({ value: k, label: STATUS[k].label }))} className="w-[120px]" />
              <SimpleSelect ariaLabel="时效" placeholder="全部时效" value={filters.freshness} onValueChange={(v) => patch({ freshness: v })} options={(Object.keys(FRESHNESS) as Freshness[]).map((k) => ({ value: k, label: FRESHNESS[k].label }))} className="w-[120px]" />
              {domainOptions.length > 0 && (
                <SimpleSelect ariaLabel="业务领域" placeholder="全部领域" value={filters.domain} onValueChange={(v) => patch({ domain: v })} options={domainOptions} className="w-[132px]" />
              )}
              {subprojectOptions.length > 0 && (
                <SimpleSelect ariaLabel="子项目" placeholder="全部子项目" value={filters.subproject} onValueChange={(v) => patch({ subproject: v })}
                  options={[{ value: '__none__', label: '整个仓库（不限子项目）' }, ...subprojectOptions]} className="w-[140px]" />
              )}
              {active > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setFilters((f) => ({ ...blank, layer: f.layer }))}>
                  <RotateCcw />清除 {active} 项
                </Button>
              )}
              <span className="ml-auto hidden text-[13px] text-muted-foreground sm:inline">
                {list.loading ? '检索中…' : <>共 <b className="num text-foreground">{items.length}</b> 条</>}
              </span>
            </div>
          </div>

          {list.error ? (
            <EmptyState icon={TriangleAlert} title="读取经验失败" description={list.error.message} action={<Button variant="outline" onClick={list.reload}>重试</Button>} />
          ) : list.loading && !list.data ? (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-60 rounded-xl" />)}
            </div>
          ) : items.length === 0 ? (
            empty ? (
              <EmptyState
                icon={LibraryBig}
                title="知识库还是空的"
                description="从 Git 历史中扫描高信号提交来冷启动，或者先进入演示空间体验完整流程。"
                action={
                  <div className="flex gap-2">
                    <Button onClick={() => setView('radar')}><Radar />扫描仓库历史</Button>
                    <Button variant="outline" onClick={() => void switchDemo()}><FlaskConical />体验示例</Button>
                  </div>
                }
              />
            ) : (
              <EmptyState
                icon={Search}
                title="没有符合条件的经验"
                description="换个说法试试，搜索支持中文口语与代码术语双语别名。"
                action={<Button variant="outline" onClick={() => setFilters(blank)}><RotateCcw />清除全部筛选</Button>}
              />
            )
          ) : (
            <div className={list.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
              {mode === 'cards' && <EntryGrid items={items} onOpen={openEntry} />}
              {mode === 'table' && <EntryTable items={items} onOpen={openEntry} />}
              {mode === 'summary' && <EntrySummary items={items} onOpen={openEntry} scopeLabel={filters.layer ? LAYERS.find((l) => l.value === filters.layer)?.label ?? '' : '全部范围'} />}
            </div>
          )}
          {active > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
              当前筛选：
              {filters.type && <Badge>{TYPES.find((t) => t.value === filters.type)?.label}</Badge>}
              {filters.status && <Badge>{STATUS[filters.status].label}</Badge>}
              {filters.freshness && <Badge>{FRESHNESS[filters.freshness].label}</Badge>}
              {filters.query && <Badge>“{filters.query}”</Badge>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
