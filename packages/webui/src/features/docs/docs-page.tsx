import { BookMarked, Check, GitCommitHorizontal, Inbox, Plus, Tag, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, PageHeader } from '@/components/display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, SimpleSelect, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Skeleton, Textarea } from '@/components/ui/primitives';
import { rpc } from '@/lib/rpc';
import type { DocCategory, DocChange, DocDetail, DocListItem, DocProposal, TagProposal } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { formatDate } from '@/lib/utils';

const CATEGORY: Record<DocCategory, { label: string; hint: string }> = {
  domain: { label: '业务领域', hint: '业务概念、实体与流程；同业务领域的仓库共享' },
  business_rules: { label: '业务规则', hint: '必须遵守的业务约束；同业务领域的仓库共享' },
  project_norms: { label: '项目规范', hint: '本仓库的开发与协作规范' },
  project_profile: { label: '项目基本业务属性', hint: '项目定位、用户、核心指标；每轮常驻提示' },
};
const CATEGORIES = Object.keys(CATEGORY) as DocCategory[];

const OP: Record<string, string> = {
  create_doc: '新建文档', add_section: '新增章节', update_section: '修改章节', delete_section: '删除章节',
  import: '导入', manual_edit: '直接编辑', delete_doc: '删除文档',
};

/** 规则文档集：业务领域、业务规则、项目规范、项目基本业务属性。AI 只能提议修改，确认后才写入并记录变更明细。 */
export function DocsPage() {
  const { revision, refresh } = useApp();
  const docs = useAsync(() => rpc<{ docs: DocListItem[]; docsDir: string }>('accremind.docs.list'), [revision]);
  const proposals = useAsync(() => rpc<{ proposals: DocProposal[]; tagProposals: TagProposal[] }>('accremind.docs.proposals', { status: 'pending' }), [revision]);
  const changes = useAsync(() => rpc<{ changes: DocChange[] }>('accremind.docs.changes', { limit: 100 }), [revision]);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
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
      <Tabs defaultValue="docs">
        <TabsList>
          <TabsTrigger value="docs">文档</TabsTrigger>
          <TabsTrigger value="proposals">待确认修改{pendingCount > 0 && <Badge tone="warning" className="ml-1.5">{pendingCount}</Badge>}</TabsTrigger>
          <TabsTrigger value="changes">变更明细</TabsTrigger>
        </TabsList>

        <TabsContent value="docs" className="mt-4 grid gap-4 lg:grid-cols-2">
          {docs.loading && !docs.data ? (
            <Skeleton className="h-48 rounded-xl lg:col-span-2" />
          ) : !docs.data?.docs.length ? (
            <EmptyState className="lg:col-span-2" icon={BookMarked} title="还没有规则文档"
              description="导入已有的业务说明、规则或规范（Markdown），按“## 章节”切分建立索引；之后与问题相关的章节会自动提醒给 AI。" />
          ) : (
            CATEGORIES.map((c) => {
              const list = docs.data!.docs.filter((d) => d.category === c);
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
                        {d.domains.map((dom) => <Badge key={dom} tone="primary">{dom}</Badge>)}
                        {d.originRepo && <Badge tone="warning">来自 {d.originRepo}</Badge>}
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
      </Tabs>

      <DocDialog docId={openDoc} onClose={() => setOpenDoc(null)} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onDone={refresh} />
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
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogTitle>{d?.meta.title ?? '文档'}</DialogTitle>
        <DialogDescription>{d ? `${CATEGORY[d.meta.category]?.label ?? d.meta.category} · v${d.meta.version} · ${d.file}` : '加载中…'}</DialogDescription>
        {d && (
          <div className="grid gap-4 text-sm">
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

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [category, setCategory] = useState<DocCategory | ''>('business_rules');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!category || !content.trim()) {
      toast.error('请选择类别并粘贴文档内容');
      return;
    }
    setBusy(true);
    try {
      const out = await rpc<{ file: string; sections: number }>('accremind.docs.import', {
        category, content, fileName: fileName.trim() || 'doc.md',
        domains: domains.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
      });
      toast.success(`已导入 ${out.file}（${out.sections} 个章节），请提交到仓库`);
      setContent('');
      setFileName('');
      onOpenChange(false);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>导入规则文档</DialogTitle>
        <DialogDescription>粘贴 Markdown，按“## 章节”切分。文档保存在 .accremind/docs/ 下，随仓库评审与共享。</DialogDescription>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>类别</Label>
              <SimpleSelect<DocCategory> ariaLabel="文档类别" value={category} onValueChange={setCategory} placeholder="选择类别"
                options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY[c].label, hint: CATEGORY[c].hint }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-file">文件名</Label>
              <Input id="doc-file" value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="refund-rules.md" />
            </div>
          </div>
          {(category === 'domain' || category === 'business_rules') && (
            <div className="grid gap-1.5">
              <Label htmlFor="doc-domains">业务领域（留空则用本仓库的领域）</Label>
              <Input id="doc-domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="payment, settlement" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="doc-content">内容</Label>
            <Textarea id="doc-content" rows={12} value={content} onChange={(e) => setContent(e.target.value)} placeholder={'# 退款规则\n\n## 部分退款\n\n…'} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button disabled={busy} onClick={() => void submit()}>导入</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
