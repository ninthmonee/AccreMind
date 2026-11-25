import { ArrowUp, BookMarked, Check, FileUp, Folder, FolderGit2, FolderOpen, GitCommitHorizontal, Inbox, LibraryBig, Network, Plus, RotateCcw, Search, Tag, Trash2, UserRound, X } from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, PageHeader } from '@/components/display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Segmented, SimpleSelect, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Textarea } from '@/components/ui/primitives';
import { rpc } from '@/lib/rpc';
import type { DocCategory, DocChange, DocDetail, DocListItem, DocProposal, DocScope, DomainsOverview, SubprojectDef, TagProposal } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useAsync } from '@/lib/use-async';
import { formatDate } from '@/lib/utils';

const CATEGORY: Record<DocCategory, { label: string; hint: string }> = {
  domain: { label: '业务领域', hint: '业务概念、实体与流程；同业务领域的仓库共享' },
  business_rules: { label: '业务规则', hint: '必须遵守的业务约束；同业务领域的仓库共享' },
  project_norms: { label: '项目规范', hint: '本仓库的开发与协作规范' },
  project_profile: { label: '项目基本业务属性', hint: '项目定位、用户、核心指标；每轮常驻提示' },
  personal_preferences: { label: '个人偏好', hint: '只对你自己生效，不进仓库；与团队规范冲突时以团队为准' },
};

const SCOPE: Record<DocScope, { label: string; hint: string }> = {
  project: { label: '本项目', hint: '只对当前仓库（或其中一个子项目）生效，保存在 .accremind/docs/' },
  domain: { label: '领域', hint: '对所选领域的所有项目生效；挂载了团队知识库时保存在知识库里' },
  personal: { label: '个人', hint: '只对你自己生效，保存在本机，不进仓库' },
};
const SCOPES_FOR: Record<DocCategory, DocScope[]> = {
  domain: ['domain'], business_rules: ['domain', 'project'], project_norms: ['project'], project_profile: ['project'],
  personal_preferences: ['personal'],
};
const HOME: Record<string, string> = { kb: '团队知识库', personal: '个人' };

function splitList(v: string): string[] {
  return v.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}
const CATEGORIES = Object.keys(CATEGORY) as DocCategory[];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface DocHit { ref: string; docId: string; sectionId: string; docTitle: string; heading: string; snippet: string; scope: DocScope }
type SourceFilter = '' | 'repo' | 'kb' | 'personal' | 'other';
const SOURCE_LABEL: Record<Exclude<SourceFilter, ''>, string> = { repo: '本仓库', kb: '团队知识库', personal: '个人', other: '其他仓库' };

function sourceOf(d: DocListItem): Exclude<SourceFilter, ''> {
  const h = d.home ?? (d.originRepo ? 'other' : 'repo');
  return h === 'repo' || h === 'kb' || h === 'personal' ? h : 'other';
}

const OP: Record<string, string> = {
  create_doc: '新建文档', add_section: '新增章节', update_section: '修改章节', delete_section: '删除章节',
  import: '导入', manual_edit: '直接编辑', delete_doc: '删除文档',
};

/** 规则文档集：业务领域、业务规则、项目规范、项目基本业务属性。AI 只能提议修改，确认后才写入并记录变更明细。 */
export function DocsPage() {
  const { revision, refresh } = useApp();
  const docs = useAsync(() => rpc<{ docs: DocListItem[]; docsDir: string; duplicates?: Array<{ docId: string; files: string[] }> }>('accremind.docs.list'), [revision]);
  const proposals = useAsync(() => rpc<{ proposals: DocProposal[]; tagProposals: TagProposal[] }>('accremind.docs.proposals', { status: 'pending' }), [revision]);
  const changes = useAsync(() => rpc<{ changes: DocChange[] }>('accremind.docs.changes', { limit: 100 }), [revision]);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const catalog = useAsync(() => rpc<DomainsOverview>('accremind.domains.list'), [revision]);
  const share = useAsync(() => rpc<ShareStatus>('accremind.share.status'), [revision]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<DocScope | 'all'>('all');
  const [domain, setDomain] = useState('');
  const [source, setSource] = useState<SourceFilter>('');
  const q = useDebounced(query.trim(), 250);
  // Section text is searched on the server (same index the AI is served from); titles, tags and domains here.
  const sectionHits = useAsync(() => (q ? rpc<{ hits: DocHit[] }>('accremind.docs.search', { query: q, limit: 8 }) : Promise.resolve({ hits: [] })), [q, revision]);
  const domainKeys = useMemo(() => {
    if (!domain) return null;
    const list = catalog.data?.domains ?? [];
    const byId = new Map(list.map((d) => [d.id, d]));
    const within = (id: string): boolean => {
      for (let cur = byId.get(id), n = 0; cur && n < 20; cur = cur.parent ? byId.get(cur.parent) : undefined, n++) if (cur.id === domain) return true;
      return false;
    };
    const keys = new Set<string>([domain.toLowerCase()]);
    for (const d of list) if (within(d.id)) for (const k of [d.id, d.name, ...d.aliases]) keys.add(k.toLowerCase());
    return keys;
  }, [domain, catalog.data]);
  const allDocs = docs.data?.docs ?? [];
  const filtered = allDocs.filter((d) => (scope === 'all' || (d.scope ?? 'project') === scope)
    && (!domainKeys || d.domains.some((x) => domainKeys.has(x.toLowerCase())))
    && (!source || sourceOf(d) === source)
    && (!q || [d.title, d.docId, ...d.domains, ...d.tags].some((t) => t.toLowerCase().includes(q.toLowerCase()))
      || (sectionHits.data?.hits ?? []).some((h) => h.docId === d.docId)));
  const activeFilters = [query, scope !== 'all' ? scope : '', domain, source].filter(Boolean).length;
  const scopeCount = (x: DocScope | 'all') => allDocs.filter((d) => x === 'all' || (d.scope ?? 'project') === x).length;
  const pendingCount = (proposals.data?.proposals.length ?? 0) + (proposals.data?.tagProposals.length ?? 0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={<><BookMarked className="size-4" /><span>手动导入、开发中逐步完善</span></>}
        title="规则文档"
        description="业务领域、业务规则、项目规范和项目基本业务属性。AI 发现缺漏或过时只会提议修改，确认后才写入文档，每次改动都有明细。"
        actions={<Button onClick={() => setImportOpen(true)}><Plus />导入文档</Button>}
      />
      <ShareBanner status={share.data} />
      <Tabs defaultValue="docs">
        <TabsList>
          <TabsTrigger value="docs">文档</TabsTrigger>
          <TabsTrigger value="proposals">待确认修改{pendingCount > 0 && <Badge tone="warning" className="ml-1.5">{pendingCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="changes">变更明细</TabsTrigger>
          <TabsTrigger value="domains">领域</TabsTrigger>
        </TabsList>

        <TabsContent value="docs" className="mt-4 grid gap-4 lg:grid-cols-2">
          {(docs.data?.duplicates?.length ?? 0) > 0 && (
            <div role="alert" className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm lg:col-span-2">
              <p className="font-medium text-warning">有文档编号重复，引用和修改提议可能指向错误的文档</p>
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                {docs.data!.duplicates!.map((d) => <li key={d.docId}><code>{d.docId}</code>：{d.files.join('、')}</li>)}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">在其中一份文件的头部把 <code>id:</code> 改成不同的值即可。</p>
            </div>
          )}
          {allDocs.length > 0 && (
            <div className="surface flex flex-col gap-3 p-3 lg:col-span-2">
              <div className="scrollbar-none -mx-1 overflow-x-auto px-1">
                <Segmented<DocScope | 'all'> ariaLabel="按挂载范围筛选" value={scope} onValueChange={setScope}
                  items={(['all', 'project', 'domain', 'personal'] as const).map((x) => ({
                    value: x, label: x === 'all' ? '全部' : SCOPE[x].label, count: scopeCount(x),
                  }))} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜标题、标签、领域，或章节里的内容" className="pl-9" aria-label="搜索规则文档" />
                </div>
                {(catalog.data?.domains.length ?? 0) > 0 && (
                  <SimpleSelect ariaLabel="业务领域" placeholder="全部领域" value={domain} onValueChange={setDomain} className="w-[132px]"
                    options={catalog.data!.domains.map((d) => ({ value: d.id, label: d.name, hint: d.myRole ? '本仓库' : undefined }))} />
                )}
                <SimpleSelect<Exclude<SourceFilter, ''>> ariaLabel="存放位置" placeholder="全部来源" value={source} onValueChange={setSource} className="w-[132px]"
                  options={(Object.keys(SOURCE_LABEL) as Array<Exclude<SourceFilter, ''>>).map((k) => ({ value: k, label: SOURCE_LABEL[k] }))} />
                {activeFilters > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => { setQuery(''); setScope('all'); setDomain(''); setSource(''); }}>
                    <RotateCcw />清除 {activeFilters} 项
                  </Button>
                )}
                <span className="ml-auto hidden text-[13px] text-muted-foreground sm:inline">共 <b className="num text-foreground">{filtered.length}</b> 份</span>
              </div>
              {q && (sectionHits.data?.hits.length ?? 0) > 0 && (
                <div className="grid gap-1.5 border-t pt-3">
                  <p className="text-xs text-muted-foreground">匹配的章节（AI 检索时也会看到这些）</p>
                  {sectionHits.data!.hits.map((h) => (
                    <button key={h.ref} type="button" onClick={() => setOpenDoc(h.docId)}
                      className="grid gap-0.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition hover:bg-accent">
                      <span className="truncate"><span className="font-medium">{h.docTitle}</span><span className="text-muted-foreground"> › {h.heading}</span></span>
                      {h.snippet && <span className="line-clamp-1 text-xs text-muted-foreground">{h.snippet}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {docs.loading && !docs.data ? (
            <Skeleton className="h-48 rounded-xl lg:col-span-2" />
          ) : !allDocs.length ? (
            <EmptyState className="lg:col-span-2" icon={BookMarked} title="还没有规则文档"
              description="导入已有的业务说明、规则或规范（Markdown），按“## 章节”切分建立索引；之后与问题相关的章节会自动提醒给 AI。" />
          ) : !filtered.length ? (
            <EmptyState className="lg:col-span-2" icon={Search} title="没有符合条件的文档" description="换个关键词，或清除筛选条件。" />
          ) : (
            CATEGORIES.map((c) => {
              const list = filtered.filter((d) => d.category === c);
              if (!list.length) return null;
              return (
                <Card key={c}>
                  <CardHeader>
                    <div>
                      <CardTitle>{CATEGORY[c].label}</CardTitle>
                      <CardDescription>{CATEGORY[c].hint}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    {list.map((d) => (
                      <button key={d.docId} type="button" onClick={() => setOpenDoc(d.docId)}
                        className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition hover:bg-accent">
                        <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                        <span className="text-xs text-muted-foreground">{d.sections} 节 · v{d.version}</span>
                        {d.scope && <Badge tone={d.scope === 'personal' ? 'info' : 'neutral'}>{SCOPE[d.scope].label}</Badge>}
                        {d.domains.map((dom) => <Badge key={dom} tone="primary">{dom}</Badge>)}
                        {d.subproject && <Badge tone="neutral">子项目 {d.subproject}</Badge>}
                        {d.audience === 'core' && <Badge tone="warning">仅核心项目</Badge>}
                        {d.home && d.home !== 'repo' ? <Badge tone="info">{HOME[d.home] ?? `来自 ${d.home}`}</Badge>
                          : d.originRepo && <Badge tone="warning">来自 {d.originRepo}</Badge>}
                      </button>
                    ))}
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        <TabsContent value="proposals" className="mt-4 grid gap-4">
          {!pendingCount ? (
            <EmptyState icon={Inbox} title="没有待确认的修改" description="AI 在开发中发现文档缺少、过时或与代码不符时，会在这里提交修改提议。" />
          ) : (
            <>
              {proposals.data?.proposals.map((p) => (
                <Card key={p.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone="info">{OP[p.op] ?? p.op}</Badge>
                    <span className="font-medium">{p.docTitle ?? '新文档'}</span>
                    <span className="text-muted-foreground">› {p.sectionHeading}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{p.source === 'ai' ? 'AI 提议' : '手动提议'} · {formatDate(p.createdAt)}</span>
                  </div>
                  {(p.owners?.length ?? 0) > 0 && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <UserRound className="size-3.5" />负责人：{p.owners!.join('、')}{p.assignedToMe && <Badge tone="warning">由你确认</Badge>}
                    </p>
                  )}
                  <p className="mt-2 text-sm">理由：{p.rationale}</p>
                  {p.evidence && <p className="mt-1 text-xs text-muted-foreground">证据：{p.evidence}</p>}
                  {p.op !== 'delete_section' && (
                    <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border bg-background/60 p-3 text-[13px]">{p.content}</pre>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => void act(() => rpc('accremind.docs.decide', { id: p.id, decision: 'accept' }), '已写入文档并记录变更')}><Check />确认写入</Button>
                    <Button size="sm" variant="outline" onClick={() => void act(() => rpc('accremind.docs.decide', { id: p.id, decision: 'reject' }), '已拒绝')}><X />拒绝</Button>
                  </div>
                </Card>
              ))}
              {(proposals.data?.tagProposals.length ?? 0) > 0 && (
                <Card className="p-5">
                  <CardTitle className="flex items-center gap-2"><Tag className="size-4" />词表新词提议</CardTitle>
                  <CardDescription>检索打标签时发现词表缺少的主题词。确认后写入 .accremind/vocabulary.json。</CardDescription>
                  <ul className="mt-3 grid gap-2">
                    {proposals.data!.tagProposals.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="font-medium">{t.label}</span>
                        <span className="text-xs text-muted-foreground">出现 {t.count} 次{t.example ? ` · 例：${t.example}` : ''}</span>
                        <span className="ml-auto flex gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => void act(() => rpc('accremind.vocab.decide', { id: t.id, decision: 'accept' }), '已加入词表')}>加入词表</Button>
                          <Button size="sm" variant="ghost" onClick={() => void act(() => rpc('accremind.vocab.decide', { id: t.id, decision: 'reject' }), '已忽略')}>忽略</Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="changes" className="mt-4">
          <ChangeList changes={changes.data?.changes ?? []} loading={changes.loading && !changes.data} />
        </TabsContent>

        <TabsContent value="domains" className="mt-4">
          <DomainsPanel act={act} />
        </TabsContent>
      </Tabs>

      <DocDialog docId={openDoc} onClose={() => setOpenDoc(null)} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={refresh} />
    </div>
  );
}

interface GitShare { root: string; isGit: boolean; uncommitted: number; ahead: number; behind: number; hasUpstream: boolean }
interface ShareStatus { project: GitShare; knowledgeBase: GitShare | null }

/** AccreMind 只写文件、从不提交或推送：这里提醒哪些知识还只在本机，队友还看不到。 */
function ShareBanner({ status }: { status: ShareStatus | undefined }) {
  if (!status) return null;
  const parts: string[] = [];
  const p = status.project;
  if (p.isGit && p.uncommitted) parts.push(`本仓库的 .accremind/ 有 ${p.uncommitted} 个改动未提交`);
  if (p.isGit && p.ahead) parts.push(`本仓库有 ${p.ahead} 个提交未推送`);
  const kb = status.knowledgeBase;
  if (kb?.isGit && kb.uncommitted) parts.push(`团队知识库有 ${kb.uncommitted} 个改动未提交`);
  if (kb?.isGit && kb.ahead) parts.push(`团队知识库有 ${kb.ahead} 个提交未推送`);
  if (kb?.isGit && kb.behind) parts.push(`团队知识库落后远端 ${kb.behind} 个提交（拉取后才能看到队友的更新）`);
  if (kb && !kb.isGit) parts.push('团队知识库不是 Git 仓库，改动不会同步给队友');
  if (!parts.length) return null;
  return (
    <div role="status" className="mb-4 rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-sm">
      <p className="font-medium">还有知识只在本机，队友看不到</p>
      <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">{parts.map((t) => <li key={t}>· {t}</li>)}</ul>
      {kb?.isGit && (kb.uncommitted > 0 || kb.ahead > 0 || kb.behind > 0) && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">cd {kb.root} && git pull && git add -A && git commit -m "更新知识库" && git push</p>
      )}
    </div>
  );
}

function ChangeList({ changes, loading }: { changes: DocChange[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-48 rounded-xl" />;
  if (!changes.length) return <EmptyState icon={GitCommitHorizontal} title="还没有变更" description="导入、确认的修改提议和直接编辑文档文件，都会记录在这里（同时写入 .accremind/docs/CHANGELOG.md）。" />;
  return (
    <Card className="divide-y">
      {changes.map((c) => (
        <div key={c.id} className="grid gap-1.5 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={c.op === 'manual_edit' ? 'warning' : 'info'}>{OP[c.op] ?? c.op}</Badge>
            <span className="font-medium">{c.docTitle}</span>
            {c.section && <span className="text-muted-foreground">› {c.section}</span>}
            <span className="text-xs text-muted-foreground">v{c.version}</span>
            {c.home && c.home !== 'repo' && <Badge tone="neutral">{HOME[c.home] ?? c.home}</Badge>}
            <span className="ml-auto text-xs text-muted-foreground">{c.actor} · {formatDate(c.at)}</span>
          </div>
          <p className="text-xs text-muted-foreground">理由：{c.rationale}{c.proposalId ? `（提议 ${c.proposalId}）` : ''}</p>
          {(c.before || c.after) && (
            <div className="grid gap-2 sm:grid-cols-2">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-destructive/5 p-2 text-[12px]">{c.before ?? '（无）'}</pre>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-primary/5 p-2 text-[12px]">{c.after ?? '（已删除）'}</pre>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function DocDialog({ docId, onClose }: { docId: string | null; onClose: () => void }) {
  const doc = useAsync(() => (docId ? rpc<DocDetail>('accremind.docs.get', { id: docId }) : Promise.resolve(undefined)), [docId]);
  const d = doc.data;
  return (
    <Dialog open={docId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl grid-rows-[auto_minmax(0,1fr)]">
        <div className="border-b px-6 pb-4 pr-12 pt-5">
          <DialogTitle className="font-display text-lg font-semibold tracking-tight">{d?.meta.title ?? '文档'}</DialogTitle>
          <DialogDescription className="mt-1 break-all text-[13px] text-muted-foreground">
            {d ? `${CATEGORY[d.meta.category]?.label ?? d.meta.category} · v${d.meta.version} · ${d.file}` : '加载中…'}
          </DialogDescription>
        </div>
        {d && (
          <div className="grid min-h-0 content-start gap-4 overflow-y-auto px-6 py-5 text-sm">
            {d.intro && <p className="whitespace-pre-wrap text-muted-foreground">{d.intro}</p>}
            {d.sections.map((s) => (
              <section key={s.id}>
                <h4 className="font-medium">{s.heading}</h4>
                <p className="mt-1 whitespace-pre-wrap">{s.body}</p>
              </section>
            ))}
            {d.changes.length > 0 && (
              <div>
                <h4 className="mb-2 font-medium">本文档的变更</h4>
                <ChangeList changes={d.changes} loading={false} />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 领域目录：有哪些领域、谁负责、哪些项目属于它（核心或使用方）；本仓库可以加入或退出。 */
function DomainsPanel({ act }: { act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { revision, openLibrary } = useApp();
  const data = useAsync(() => rpc<DomainsOverview>('accremind.domains.list'), [revision]);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [aliases, setAliases] = useState('');
  const [owners, setOwners] = useState('');
  if (data.loading && !data.data) return <Skeleton className="h-48 rounded-xl" />;
  const d = data.data;
  if (!d) return null;
  return (
    <div className="grid gap-4">
      <Card className="p-5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Network className="size-4" />
          <span className="font-medium">{d.knowledgeBase.kind === 'team' ? '团队知识库' : '本机知识库'}</span>
          <code className="truncate text-xs text-muted-foreground">{d.knowledgeBase.root}</code>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {d.knowledgeBase.kind === 'team'
            ? '领域目录和领域文档保存在这个仓库里，改动请像代码一样评审后提交。'
            : '还没有挂载团队知识库，领域目录只在本机生效。团队共享请运行 accremind team set <团队知识库仓库目录>。'}
        </p>
        {d.unknown.length > 0 && <p className="mt-2 text-xs text-warning">repo.json 里有目录中不存在的领域：{d.unknown.join('、')}</p>}
      </Card>
      {!d.domains.length ? (
        <EmptyState icon={Network} title="还没有领域" description="先登记领域（如 支付、退款），再让项目加入；领域文档与领域经验只会提醒给属于该领域的项目。" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {d.domains.map((dom) => (
            <Card key={dom.id} className="p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{dom.name}</span>
                <code className="text-xs text-muted-foreground">{dom.id}</code>
                {dom.parent && <Badge tone="neutral">上级 {d.domains.find((x) => x.id === dom.parent)?.name ?? dom.parent}</Badge>}
                {dom.myRole && <Badge tone="primary">本仓库：{dom.myRole === 'core' ? '核心' : '使用方'}</Badge>}
              </div>
              {dom.aliases.length > 0 && <p className="mt-1 text-xs text-muted-foreground">别名：{dom.aliases.join('、')}</p>}
              {dom.owners.length > 0 && <p className="mt-1 text-xs text-muted-foreground">负责人：{dom.owners.join('、')}</p>}
              <ul className="mt-2 grid gap-1 text-xs">
                {dom.members.map((m) => (
                  <li key={`${m.repo}|${m.subproject ?? ''}`} className="flex gap-2">
                    <span className={m.isThisRepo ? 'font-medium' : ''}>{m.name}{m.subproject ? ` / ${m.subproject}` : ''}</span>
                    <span className="text-muted-foreground">{m.role === 'core' ? '核心' : '使用方'}</span>
                  </li>
                ))}
                {!dom.members.length && <li className="text-muted-foreground">还没有项目加入</li>}
              </ul>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {dom.myRole !== 'core' && <Button size="sm" variant="outline" onClick={() => void act(() => rpc('accremind.domains.join', { domain: dom.id, role: 'core' }), `本仓库已作为核心项目加入「${dom.name}」`)}>作为核心加入</Button>}
                {dom.myRole !== 'consumer' && <Button size="sm" variant="outline" onClick={() => void act(() => rpc('accremind.domains.join', { domain: dom.id, role: 'consumer' }), `本仓库已作为使用方加入「${dom.name}」`)}>作为使用方加入</Button>}
                {dom.myRole && <Button size="sm" variant="ghost" onClick={() => void act(() => rpc('accremind.domains.leave', { domain: dom.id }), `本仓库已退出「${dom.name}」`)}>退出</Button>}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openLibrary({ domain: dom.id })}><LibraryBig />查看经验</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Card className="grid gap-3 p-5">
        <CardTitle>登记领域</CardTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="dom-name">名称</Label><Input id="dom-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="退款" /></div>
          <div className="grid gap-1.5"><Label htmlFor="dom-parent">上级领域（可选）</Label><Input id="dom-parent" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="支付" /></div>
          <div className="grid gap-1.5"><Label htmlFor="dom-aliases">别名（可选）</Label><Input id="dom-aliases" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="refund, 退款域" /></div>
          <div className="grid gap-1.5"><Label htmlFor="dom-owners">负责人（可选）</Label><Input id="dom-owners" value={owners} onChange={(e) => setOwners(e.target.value)} placeholder="lead@example.com" /></div>
        </div>
        <div className="flex justify-end">
          <Button disabled={!name.trim()} onClick={() => void act(async () => {
            await rpc('accremind.domains.upsert', { name: name.trim(), parent: parent.trim() || undefined, aliases: splitList(aliases), owners: splitList(owners) });
            setName(''); setParent(''); setAliases(''); setOwners('');
          }, '已登记领域')}><Plus />登记</Button>
        </div>
      </Card>
    </div>
  );
}

interface PickedFile { name: string; content: string; title: string; sections: number }

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function describeMarkdown(name: string, content: string): PickedFile {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || name.replace(/\.(md|markdown|txt)$/i, '');
  return { name, content, title, sections: (body.match(/^##\s+/gm) ?? []).length };
}

async function readFiles(list: FileList | File[]): Promise<{ files: PickedFile[]; skipped: string[] }> {
  const files: PickedFile[] = [];
  const skipped: string[] = [];
  for (const f of Array.from(list)) {
    if (!/\.(md|markdown|txt)$/i.test(f.name)) {
      skipped.push(`${f.name}（不是 Markdown）`);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      skipped.push(`${f.name}（超过 2 MB）`);
      continue;
    }
    files.push(describeMarkdown(f.name, await f.text()));
  }
  return { files, skipped };
}

interface NewDomain { name: string; parent: string }

interface ProjectOption { root: string; name: string; repoId?: string | null }
interface ProjectsList { current: ProjectOption & { isGit: boolean }; others: ProjectOption[] }
interface BrowseResult {
  path: string; parent: string | null;
  current: { root: string; name: string; exists: boolean; isGit: boolean; hasAccremind: boolean };
  dirs: Array<{ name: string; path: string; isGit: boolean; hasAccremind: boolean }>;
  truncated: boolean;
}

/** 选择其他项目的文件夹：只列出文件夹名，Git 仓库和已使用 AccreMind 的项目排在前面。 */
function FolderBrowser({ open, onOpenChange, start, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; start: string; onPick: (root: string, name: string) => void }) {
  const [at, setAt] = useState(start);
  const [typed, setTyped] = useState(start);
  useEffect(() => {
    if (open) { setAt(start); setTyped(start); }
  }, [open, start]);
  const list = useAsync(() => (open && at ? rpc<BrowseResult>('accremind.fs.browse', { path: at }) : Promise.resolve(undefined)), [open, at]);
  const go = (p: string) => { setAt(p); setTyped(p); };
  const cur = list.data?.current;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <div className="grid gap-3 border-b px-6 pb-4 pr-12 pt-5">
          <div>
            <DialogTitle className="font-display text-lg font-semibold tracking-tight">选择项目文件夹</DialogTitle>
            <DialogDescription className="mt-1 text-[13px] text-muted-foreground">文档会写入该项目的 .accremind/docs/，随那个项目的仓库评审与共享。</DialogDescription>
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setAt(typed.trim()); }}>
            <Button type="button" size="icon-sm" variant="outline" aria-label="上一级" disabled={!list.data?.parent} onClick={() => list.data?.parent && go(list.data.parent)}><ArrowUp /></Button>
            <Input aria-label="文件夹路径" className="h-8 flex-1 font-mono text-xs" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <Button type="submit" size="sm" variant="outline">前往</Button>
          </form>
        </div>
        <div className="min-h-0 overflow-y-auto px-3 py-2">
          {list.error ? (
            <p className="px-3 py-6 text-center text-sm text-danger">{list.error instanceof Error ? list.error.message : String(list.error)}</p>
          ) : list.loading && !list.data ? (
            <div className="grid gap-1.5 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : !list.data?.dirs.length ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">这里没有子文件夹</p>
          ) : (
            <ul className="grid">
              {list.data.dirs.map((d) => (
                <li key={d.path}>
                  <button type="button" onClick={() => go(d.path)} onDoubleClick={() => onPick(d.path, d.name)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm transition hover:bg-accent">
                    {d.isGit ? <FolderGit2 className="size-4 text-primary" /> : <Folder className="size-4 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {d.hasAccremind && <Badge tone="primary">AccreMind</Badge>}
                    {d.isGit && !d.hasAccremind && <Badge tone="neutral">Git</Badge>}
                  </button>
                </li>
              ))}
              {list.data.truncated && <li className="px-3 py-1.5 text-xs text-muted-foreground">文件夹太多，只显示了一部分，可以在上方直接输入路径</li>}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-2 border-t bg-muted/30 px-6 py-3">
          <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
            {cur ? (cur.isGit ? `${cur.name} 是一个 Git 仓库` : `${cur.name} 不是 Git 仓库，文档不会随版本库共享`) : ''}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!cur?.exists} onClick={() => cur && onPick(cur.root, cur.name)}><FolderOpen />选择这个文件夹</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [category, setCategory] = useState<DocCategory | ''>('business_rules');
  const [scope, setScope] = useState<DocScope>('domain');
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [newDomains, setNewDomains] = useState<NewDomain[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftParent, setDraftParent] = useState('');
  const [join, setJoin] = useState(true);
  const [audience, setAudience] = useState<'all' | 'core'>('all');
  const [subproject, setSubproject] = useState('');
  const [projectRoot, setProjectRoot] = useState('');
  const [picked, setPicked] = useState<ProjectOption[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const catalog = useAsync(() => (open ? rpc<DomainsOverview>('accremind.domains.list') : Promise.resolve(undefined)), [open]);
  const projects = useAsync(() => (open ? rpc<ProjectsList>('accremind.projects.list') : Promise.resolve(undefined)), [open]);
  // Sub-projects are those of the project the document goes to.
  const profile = useAsync(() => (!open ? Promise.resolve(undefined) : projectRoot
    ? rpc<{ subprojects: SubprojectDef[] }>('accremind.projects.inspect', { root: projectRoot })
    : rpc<{ subprojects: SubprojectDef[] }>('accremind.repo.profile')), [open, projectRoot]);
  const projectOptions = [...(projects.data?.others ?? []), ...picked.filter((p) => !(projects.data?.others ?? []).some((o) => o.root === p.root))];
  const targetName = projectRoot ? projectOptions.find((p) => p.root === projectRoot)?.name ?? projectRoot : projects.data?.current.name ?? '当前项目';
  const scopes = category ? SCOPES_FOR[category] : [];
  const effectiveScope: DocScope = scopes.includes(scope) ? scope : (scopes[0] ?? 'project');
  const subprojects = profile.data?.subprojects ?? [];
  const known = catalog.data?.domains ?? [];
  const mineIds = (catalog.data?.mine ?? []).filter((m) => m.known).map((m) => m.id);

  // Start from the domains this repository belongs to; a fresh dialog forgets the last import.
  useEffect(() => {
    if (open && catalog.data) setDomains((cur) => (cur.length ? cur : mineIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog.data]);
  useEffect(() => {
    if (open) return;
    setFiles([]); setFileName(''); setContent(''); setDomains([]); setNewDomains([]); setDraftName(''); setDraftParent('');
    setFailures({}); setAudience('all'); setSubproject(''); setJoin(true); setProjectRoot(''); setBrowsing(false);
  }, [open]);

  const toggleDomain = (id: string) => setDomains((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const notJoined = [...domains.filter((id) => !mineIds.includes(id)), ...newDomains.map((d) => d.name)];
  const addNewDomain = () => {
    const name = draftName.trim();
    if (!name) return;
    const existing = known.find((d) => [d.id, d.name, ...d.aliases].some((k) => k.toLowerCase() === name.toLowerCase()));
    if (existing) {
      if (!domains.includes(existing.id)) setDomains((cur) => [...cur, existing.id]);
      toast.info(`「${existing.name}」已在领域目录里，已为你选中`);
    } else if (!newDomains.some((d) => d.name === name)) {
      setNewDomains((cur) => [...cur, { name, parent: draftParent }]);
    }
    setDraftName('');
  };

  const pick = async (list: FileList | File[] | null) => {
    if (!list?.length) return;
    const { files: picked, skipped } = await readFiles(list);
    if (skipped.length) toast.error(`已跳过：${skipped.join('、')}`);
    if (!picked.length) return;
    setFiles((cur) => [...cur.filter((f) => !picked.some((p) => p.name === f.name)), ...picked]);
    setFailures({});
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void pick(e.dataTransfer.files);
  };

  const items = files.length ? files : content.trim() ? [describeMarkdown(fileName.trim() || 'doc.md', content)] : [];
  const needsDomain = effectiveScope === 'domain' && !domains.length && !newDomains.length;
  const submit = async () => {
    if (!category || !items.length) {
      toast.error('请选择类别，并上传文件或粘贴内容');
      return;
    }
    if (needsDomain) {
      toast.error('请选择或新建至少一个领域');
      return;
    }
    setBusy(true);
    try {
      let ids = [...domains];
      if (effectiveScope === 'domain') {
        for (const d of newDomains) {
          const def = await rpc<{ id: string }>('accremind.domains.upsert', { name: d.name, parent: d.parent || undefined });
          ids.push(def.id);
        }
        ids = [...new Set(ids)];
        setDomains(ids);
        setNewDomains([]);
        if (join) for (const id of ids.filter((x) => !mineIds.includes(x))) await rpc('accremind.domains.join', { domain: id, role: 'core' });
      }
      const ok: string[] = [];
      const failed: Record<string, string> = {};
      for (const f of items) {
        try {
          await rpc('accremind.docs.import', {
            category, content: f.content, fileName: f.name, scope: effectiveScope,
            domains: effectiveScope === 'domain' ? ids : [],
            ...(effectiveScope === 'domain' && audience === 'core' ? { audience: 'core' } : {}),
            ...(effectiveScope === 'project' && subproject ? { subproject } : {}),
            ...(effectiveScope === 'project' && projectRoot ? { projectRoot } : {}),
          });
          ok.push(f.name);
        } catch (err) {
          failed[f.name] = err instanceof Error ? err.message : String(err);
        }
      }
      if (ok.length) {
        const where = effectiveScope === 'personal' ? '只对你生效，不进仓库' : effectiveScope === 'project' ? `已写入「${targetName}」，记得提交到那个仓库` : effectiveScope === 'domain' && catalog.data?.knowledgeBase.kind === 'team' ? '已写入团队知识库，记得提交' : '记得提交到仓库';
        toast.success(`已导入 ${ok.length} 份文档（${where}）`);
        onDone();
      }
      setFailures(failed);
      if (!Object.keys(failed).length) onOpenChange(false);
      else setFiles((cur) => cur.filter((f) => failed[f.name]));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <div className="border-b px-6 pb-4 pr-12 pt-5">
          <DialogTitle className="font-display text-lg font-semibold tracking-tight">导入规则文档</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-muted-foreground">
            上传 Markdown 文件或直接粘贴，按“## 章节”切分。先选类别，再选它挂在哪里：本项目、领域或你个人。
          </DialogDescription>
        </div>
        <div className="grid min-h-0 content-start gap-4 overflow-y-auto px-6 py-5">
          <div className="grid gap-1.5">
            <Label>类别</Label>
            <SimpleSelect<DocCategory> ariaLabel="文档类别" value={category} onValueChange={(v) => v && setCategory(v)} placeholder="选择类别"
              options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY[c].label }))} />
            {category && <p className="text-xs text-muted-foreground">{CATEGORY[category].hint}</p>}
          </div>
          {category && (
            <div className="grid gap-1.5">
              <Label>挂载到</Label>
              {scopes.length > 1 ? (
                <Segmented<DocScope> ariaLabel="挂载范围" className="w-fit" value={effectiveScope} onValueChange={setScope}
                  items={scopes.map((x) => ({ value: x, label: SCOPE[x].label }))} />
              ) : (
                <div><Badge tone="neutral">{SCOPE[effectiveScope].label}</Badge></div>
              )}
              <p className="text-xs text-muted-foreground">{SCOPE[effectiveScope].hint}</p>
            </div>
          )}
          {effectiveScope === 'domain' && (
            <div className="grid gap-2.5 rounded-xl border bg-muted/30 p-4">
              <Label>领域</Label>
              {known.length > 0 || newDomains.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {known.map((d) => (
                    <Button key={d.id} size="sm" type="button" variant={domains.includes(d.id) ? 'default' : 'outline'}
                      aria-pressed={domains.includes(d.id)} onClick={() => toggleDomain(d.id)}>
                      {domains.includes(d.id) && <Check />}{d.name}{d.myRole && <span className="text-xs opacity-70">本仓库</span>}
                    </Button>
                  ))}
                  {newDomains.map((d) => (
                    <span key={d.name} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 pl-3 pr-1 text-sm">
                      {d.name}
                      <Badge tone="primary">新建{d.parent ? ` · 上级 ${known.find((k) => k.id === d.parent)?.name ?? d.parent}` : ''}</Badge>
                      <button type="button" aria-label={`不新建 ${d.name}`} className="rounded p-1 text-muted-foreground hover:bg-accent"
                        onClick={() => setNewDomains((cur) => cur.filter((x) => x.name !== d.name))}><X className="size-3.5" /></button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">领域目录还是空的。在下面新建第一个领域，导入时会一并登记。</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label="新领域名称" className="min-w-[160px] flex-1" value={draftName} onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNewDomain(); } }} placeholder="新建领域，如“退款”" />
                {known.length > 0 && (
                  <SimpleSelect<string> ariaLabel="上级领域" placeholder="无上级" value={draftParent} onValueChange={setDraftParent} className="w-[132px]"
                    options={known.map((d) => ({ value: d.id, label: d.name }))} />
                )}
                <Button type="button" size="sm" variant="outline" disabled={!draftName.trim()} onClick={addNewDomain}><Plus />新建</Button>
              </div>
              {notJoined.length > 0 && (
                <label className="flex items-start gap-2 text-xs leading-5">
                  <input type="checkbox" className="mt-1 size-3.5 shrink-0 accent-[var(--primary)]" checked={join} onChange={(e) => setJoin(e.target.checked)} />
                  <span>本仓库作为核心项目加入：{notJoined.map((id) => known.find((k) => k.id === id)?.name ?? id).join('、')}
                    <span className="text-muted-foreground">（不加入的话，本仓库看不到这份文档）</span></span>
                </label>
              )}
              <label className="flex items-start gap-2 text-xs leading-5">
                <input type="checkbox" className="mt-1 size-3.5 shrink-0 accent-[var(--primary)]" checked={audience === 'core'}
                  onChange={(e) => setAudience(e.target.checked ? 'core' : 'all')} />
                <span>只提醒给领域的核心项目（使用方项目看不到，适合内部实现细节）</span>
              </label>
            </div>
          )}
          {effectiveScope === 'project' && (
            <div className="grid gap-1.5">
              <Label>挂载到哪个项目</Label>
              <div className="flex flex-wrap items-center gap-2">
                <SimpleSelect<string> ariaLabel="目标项目" className="min-w-[200px] flex-1" value={projectRoot}
                  onValueChange={(v) => { setProjectRoot(v); setSubproject(''); }}
                  placeholder={`${projects.data?.current.name ?? '当前项目'}（当前打开）`}
                  options={projectOptions.map((p) => ({ value: p.root, label: p.name, hint: p.root }))} />
                <Button type="button" size="sm" variant="outline" onClick={() => setBrowsing(true)}><FolderOpen />浏览其他文件夹…</Button>
              </div>
              <p className="truncate text-xs text-muted-foreground">{projectRoot || projects.data?.current.root}</p>
            </div>
          )}
          {effectiveScope === 'project' && subprojects.length > 0 && (
            <div className="grid gap-1.5">
              <Label>子项目 <span className="font-normal text-muted-foreground">（可选）</span></Label>
              <SimpleSelect<string> ariaLabel="子项目" value={subproject} onValueChange={setSubproject} placeholder="整个仓库"
                options={subprojects.map((sp) => ({ value: sp.id, label: sp.name ?? sp.id, hint: sp.paths.join(', ') }))} />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>文档</Label>
            <div
              role="button" tabIndex={0} aria-label="选择或拖入 Markdown 文件"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn('flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center text-sm transition hover:bg-accent/50',
                dragging && 'border-primary bg-primary/5')}
            >
              <FileUp className="size-5 text-muted-foreground" />
              <span className="font-medium">选择或拖入 Markdown 文件</span>
              <span className="text-xs text-muted-foreground">.md / .markdown / .txt，可多选，单个不超过 2 MB</span>
              <input ref={inputRef} type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain" className="hidden"
                onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
            </div>
          </div>
          {files.length > 0 ? (
            <ul className="grid gap-1.5">
              {files.map((f) => (
                <li key={f.name} className={cn('flex items-start gap-3 rounded-lg border px-3 py-2 text-sm', failures[f.name] && 'border-danger/40 bg-danger/5')}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{f.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{f.name} · {f.sections} 个章节</p>
                    {failures[f.name] && <p className="mt-1 text-xs text-danger">{failures[f.name]}</p>}
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label={`移除 ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.name !== f.name))}><Trash2 /></Button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />或直接粘贴<span className="h-px flex-1 bg-border" /></div>
              <div className="grid gap-1.5">
                <Label htmlFor="doc-file">文件名</Label>
                <Input id="doc-file" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="refund-rules.md" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="doc-content">内容</Label>
                <Textarea id="doc-content" rows={8} className="min-h-32 font-mono text-[13px]" value={content} onChange={(e) => setContent(e.target.value)}
                  placeholder={'# 退款规则\n\n## 部分退款\n\n…'} />
                {failures[items[0]?.name ?? ''] && <p className="text-xs text-danger">{failures[items[0]!.name]}</p>}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          {items.length > 1 && <span className="mr-auto text-xs text-muted-foreground">将导入 {items.length} 份文档</span>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={busy || !category || !items.length || needsDomain} onClick={() => void submit()}>
            {busy ? '导入中…' : items.length > 1 ? `导入 ${items.length} 份` : '导入'}
          </Button>
        </div>
      </DialogContent>
      <FolderBrowser open={browsing} onOpenChange={setBrowsing}
        start={projectRoot ? projectRoot.replace(/[\\/][^\\/]+$/, '') : (projects.data?.current.root ?? '').replace(/[\\/][^\\/]+$/, '')}
        onPick={(root, name) => {
          if (root === projects.data?.current.root) setProjectRoot('');
          else {
            setPicked((cur) => (cur.some((p) => p.root === root) ? cur : [...cur, { root, name }]));
            setProjectRoot(root);
          }
          setSubproject('');
          setBrowsing(false);
        }} />
    </Dialog>
  );
}
