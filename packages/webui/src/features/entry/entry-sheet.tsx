import {
  Anchor,
  Ban,
  BookOpen,
  Check,
  CircleCheck,
  CircleDashed,
  Clock,
  Copy,
  FileCode2,
  FileText,
  GitCommitHorizontal,
  type LucideIcon,
  MessageSquare,
  Scale,
  Sparkles,
  TestTube,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useApp } from '@/app/app-context';
import { EmptyState } from '@/components/display';
import { Excerpt, LedgerPanel, SnapshotMeta } from '@/components/evidence-ledger';
import { EntryActions, EntryStepper } from './entry-actions';
import { GovernanceBadges, PriorityBadge, TypeChip } from '@/components/entry-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogTitle, Sheet, SheetContent, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Skeleton } from '@/components/ui/primitives';
import { CHECK_METHOD, DISCOVERABILITY, EVIDENCE_SOURCE, layerLabel, ZONE } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { KbGetResult, KnowledgeEntry } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { cn, formatDate, relativeDays, shortSha } from '@/lib/utils';

const EVIDENCE_ICON: Record<string, LucideIcon> = {
  git_commit: GitCommitHorizontal,
  file_lines: FileCode2,
  test_run: TestTube,
  doc_ref: BookOpen,
  session_turn: MessageSquare,
};

function Block({ title, icon: Icon, children, className }: { title: string; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {title}
      </h4>
      {children}
    </section>
  );
}

function BulletList({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="grid gap-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 text-sm leading-relaxed">
          <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
          {t}
        </li>
      ))}
    </ul>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* sandbox 可能禁止剪贴板 */
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {done ? '已复制' : '复制原文'}
    </Button>
  );
}

/** 时效时间线：创建 → 最近验证 → 下次复核，进度条显示距复核的消耗。 */
function FreshnessTimeline({ entry }: { entry: KnowledgeEntry }) {
  const start = new Date(entry.last_validated_at ?? entry.created_at).getTime();
  const end = new Date(entry.review_due_at).getTime();
  const progress = end > start ? Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100)) : 100;
  const steps = [
    { label: '创建', date: entry.created_at, done: true },
    { label: '最近验证', date: entry.last_validated_at, done: !!entry.last_validated_at },
    { label: '下次复核', date: entry.review_due_at, done: false },
  ];
  return (
    <div className="rounded-xl border bg-background/40 p-4">
      <div className="grid grid-cols-3 gap-2">
        {steps.map((s) => (
          <div key={s.label} className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {s.done ? <CircleCheck className="size-3.5 text-success" /> : <CircleDashed className="size-3.5" />}
              {s.label}
            </p>
            <p className="num mt-1 text-sm font-medium">{formatDate(s.date)}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', progress > 85 ? 'bg-warning' : 'bg-primary')} style={{ width: `${progress}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">距下次复核 {relativeDays(entry.review_due_at)}</p>
    </div>
  );
}

function EntryBody({ data }: { data: Extract<KbGetResult, { servable: true }> }) {
  const { entry: e, assessment: a, validations, rawMarkdown, storageZone, snapshots = [], ledger } = data;
  const latestSnap = new Map<string, (typeof snapshots)[number]>();
  for (const sn of snapshots) if (!latestSnap.has(sn.evidenceId)) latestSnap.set(sn.evidenceId, sn);
  return (
    <>
      <div className="border-b px-6 pb-5 pt-6">
        <div className="flex flex-wrap items-center gap-2 pr-10">
          <span className="font-mono text-xs text-muted-foreground">{e.id}@r{e.revision}</span>
          <PriorityBadge priority={e.priority} />
          <TypeChip type={e.type} />
          <span className="text-xs text-muted-foreground">· {layerLabel(e.layer)} · {ZONE[storageZone]}</span>
        </div>
        <DialogTitle className="mt-3 font-display text-xl font-semibold leading-snug tracking-tight">{e.title}</DialogTitle>
        <DialogDescription className="sr-only">经验详情</DialogDescription>
        <div className="mt-3">
          <GovernanceBadges entry={e} full />
        </div>
        <EntryStepper entry={e} />
      </div>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="px-4">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="evidence">证据 <span className="num text-xs text-muted-foreground">{e.evidence.length}</span></TabsTrigger>
          <TabsTrigger value="anchors">锚点与时效</TabsTrigger>
          <TabsTrigger value="assessment">增量评估</TabsTrigger>
          <TabsTrigger value="ledger">验证记录 <span className="num text-xs text-muted-foreground">{ledger?.records.length ?? 0}</span></TabsTrigger>
          <TabsTrigger value="raw">原文</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="overview" className="grid gap-6 p-6">
            <Block title="结论">
              <p className="text-[15px] leading-relaxed">{e.claim}</p>
            </Block>
            {e.knowledge_delta && (
              <div className="relative overflow-hidden rounded-xl border border-primary/25 bg-primary/[0.07] p-4">
                <Sparkles className="absolute -right-2 -top-2 size-16 text-primary/10" />
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary"><Sparkles className="size-3.5" />代码外增量</p>
                <p className="text-sm leading-relaxed">{e.knowledge_delta}</p>
              </div>
            )}
            {e.rationale && (
              <Block title="依据">
                <p className="text-sm leading-relaxed text-muted-foreground">{e.rationale}</p>
              </Block>
            )}
            <div className="grid gap-6 sm:grid-cols-2">
              <Block title="适用条件" icon={Check}><BulletList items={e.preconditions} /></Block>
              <Block title="排除条件" icon={Ban}><BulletList items={e.exclusions} empty="未登记排除条件" /></Block>
            </div>
            {e.alternatives.length > 0 && (
              <Block title="被否决的方案" icon={Scale}>
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr><th className="px-3 py-2 font-medium">方案</th><th className="px-3 py-2 font-medium">否决原因</th><th className="px-3 py-2 font-medium">证据</th></tr>
                    </thead>
                    <tbody>
                      {e.alternatives.map((alt) => (
                        <tr key={alt.option} className="border-t">
                          <td className="px-3 py-2.5 font-medium">{alt.option}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{alt.rejected_because}</td>
                          <td className="px-3 py-2.5 font-mono text-xs">{alt.evidence_id}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Block>
            )}
            <div className="grid gap-6 sm:grid-cols-2">
              <Block title="搜索别名">
                <div className="flex flex-wrap gap-1.5">
                  {e.search_aliases.length ? e.search_aliases.map((x) => <Badge key={x}>{x}</Badge>) : <span className="text-sm text-muted-foreground">—</span>}
                </div>
              </Block>
              <Block title="验证方式">
                <code className="block rounded-lg bg-muted px-3 py-2 text-[12px] leading-relaxed">{e.verification_method || '—'}</code>
                <p className="mt-2 text-xs text-muted-foreground">
                  落地约束：{e.enforcement.kind} · {e.enforcement.status === 'verified' ? '已验证' : e.enforcement.status === 'implemented' ? '已实现' : '建议'}
                  {e.enforcement.ref && <> · <code>{e.enforcement.ref}</code></>}
                </p>
              </Block>
            </div>
            {validations.length > 0 && (
              <Block title="使用验证">
                <ul className="grid gap-2">
                  {validations.map((v) => (
                    <li key={v.id} className="flex items-start gap-2 text-sm">
                      <Badge tone={v.outcome === 'success' ? 'success' : v.outcome === 'failure' ? 'danger' : 'neutral'}>
                        {v.outcome === 'success' ? '有效' : v.outcome === 'failure' ? '失败' : '不确定'}
                      </Badge>
                      <span className="flex-1 text-muted-foreground">{v.evidence_note || '—'}</span>
                      <span className="num text-xs text-muted-foreground">{formatDate(v.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}
          </TabsContent>

          <TabsContent value="evidence" className="p-6">
            {e.evidence.length === 0 ? (
              <EmptyState icon={FileText} title="暂无证据" />
            ) : (
              <ol className="relative grid gap-5 border-l pl-6">
                {e.evidence.map((ev) => {
                  const Icon = EVIDENCE_ICON[ev.source_type] ?? FileText;
                  return (
                    <li key={ev.id} className="relative">
                      <span className="absolute -left-[37px] top-0 flex size-[26px] items-center justify-center rounded-full border bg-popover text-primary">
                        <Icon className="size-3.5" />
                      </span>
                      <div className="rounded-xl border bg-background/40 p-4">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <Badge tone="info">{EVIDENCE_SOURCE[ev.source_type] ?? ev.source_type}</Badge>
                          <span className="font-mono text-muted-foreground">{ev.id}</span>
                          <span className="ml-auto font-mono text-muted-foreground" title={ev.source_ref}>{shortSha(ev.source_ref)}</span>
                        </div>
                        <p className="mt-2.5 text-sm leading-relaxed">{ev.summary}</p>
                        <code className="mt-2 block truncate text-[12px] text-muted-foreground">{ev.locator}</code>
                        {latestSnap.get(ev.id) ? (
                          <div className="mt-3 grid gap-1.5">
                            <p className="text-xs font-medium text-muted-foreground">快照：批准或上次确认时的原文</p>
                            <Excerpt text={latestSnap.get(ev.id)!.excerpt} start={latestSnap.get(ev.id)!.startLine} />
                            <SnapshotMeta s={latestSnap.get(ev.id)!} />
                          </div>
                        ) : (
                          <p className="mt-3 text-xs text-muted-foreground">还没有快照：下次复核确认时会自动保存。</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="anchors" className="grid gap-6 p-6">
            <Block title="时效" icon={Clock}><FreshnessTimeline entry={e} /></Block>
            <Block title="函数符号锚点" icon={Anchor}>
              {e.symbol_anchors.length === 0 ? (
                <p className="text-sm text-muted-foreground">未锚定到具体函数，仅按关注路径匹配。</p>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 text-xs text-muted-foreground">
                      <tr><th className="px-3 py-2 font-medium">符号</th><th className="px-3 py-2 font-medium">文件</th><th className="px-3 py-2 font-medium">行</th><th className="px-3 py-2 font-medium">指纹</th></tr>
                    </thead>
                    <tbody>
                      {e.symbol_anchors.map((s) => (
                        <tr key={s.file_path + s.symbol_name} className="border-t">
                          <td className="px-3 py-2.5 font-mono text-[12px] font-medium">{s.symbol_name}</td>
                          <td className="px-3 py-2.5 font-mono text-[12px] text-muted-foreground">{s.file_path}</td>
                          <td className="num px-3 py-2.5 text-[12px]">{s.start_line}–{s.end_line}</td>
                          <td className="px-3 py-2.5 font-mono text-[11px] text-muted-foreground">{s.normalized_sha256.slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Block>
            <div className="grid gap-6 sm:grid-cols-2">
              <Block title="关注路径">
                <div className="flex flex-wrap gap-1.5">
                  {e.watch_paths.length ? e.watch_paths.map((p) => <code key={p} className="rounded-md bg-muted px-2 py-1 text-[12px]">{p}</code>) : <span className="text-sm text-muted-foreground">—</span>}
                </div>
              </Block>
              <Block title="失效条件" icon={TriangleAlert}><BulletList items={e.invalidation_triggers} /></Block>
            </div>
            {e.dependency_constraints.length > 0 && (
              <Block title="依赖版本约束">
                <div className="flex flex-wrap gap-1.5">
                  {e.dependency_constraints.map((d) => <Badge key={d.name} tone="info" className="font-mono">{d.name} {d.range}</Badge>)}
                </div>
              </Block>
            )}
          </TabsContent>

          <TabsContent value="assessment" className="grid gap-6 p-6">
            {!a ? (
              <EmptyState icon={Scale} title="没有关联的增量评估" description="手工迁入或团队规范镜像通常没有评估记录。" />
            ) : (
              <>
                <Block title="评估问题"><p className="text-[15px] leading-relaxed">{a.question}</p></Block>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border bg-muted/30 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">仅凭代码与文档（基线）</p>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{a.baseline_answer}</p>
                  </div>
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.07] p-4">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary"><Sparkles className="size-3.5" />代码外增量</p>
                    <p className="mt-2 text-sm leading-relaxed">{a.knowledge_delta}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ['可发现性', <Badge key="d" tone={DISCOVERABILITY[a.discoverability]?.tone}>{DISCOVERABILITY[a.discoverability]?.label}</Badge>],
                    ['评估方式', CHECK_METHOD[a.checked_context.method] ?? a.checked_context.method],
                    ['Token', a.checked_context.token_used.toLocaleString()],
                    ['耗时', `${a.checked_context.duration_ms} ms`],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="rounded-lg border bg-background/40 px-3 py-2.5">
                      <p className="text-[11px] text-muted-foreground">{k}</p>
                      <div className="num mt-1 text-sm font-medium">{v}</div>
                    </div>
                  ))}
                </div>
                <Block title="断言与证据">
                  <ul className="grid gap-2">
                    {a.claim_evidence_map.map((m, i) => (
                      <li key={i} className="flex gap-3 rounded-lg border p-3 text-sm">
                        {m.verified_fact ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-warning" />}
                        <div className="min-w-0">
                          <p className="leading-relaxed">{m.assertion}</p>
                          {m.evidence_locator && <code className="mt-1 block truncate text-[12px] text-muted-foreground">{m.evidence_locator}</code>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Block>
                {a.omission_consequence && (
                  <div className="flex gap-3 rounded-xl border border-danger/25 bg-danger/[0.07] p-4 text-sm">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                    <div><p className="font-medium text-danger">忽略的后果</p><p className="mt-1 text-muted-foreground">{a.omission_consequence}</p></div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  核对文件 {a.checked_context.checked_files.length} 个 · 文档 {a.checked_context.checked_docs.length} 份 · HEAD <code>{shortSha(a.checked_context.head_commit)}</code>
                </p>
              </>
            )}
          </TabsContent>

          <TabsContent value="ledger" className="p-6">
            {ledger ? <LedgerPanel shared={ledger.shared} standing={ledger.standing} records={ledger.records} revision={e.revision} /> : null}
          </TabsContent>

          <TabsContent value="raw" className="p-6">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Markdown 真源，索引可随时据此重建</p>
              <CopyButton text={rawMarkdown} />
            </div>
            <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-4 font-mono text-[12px] leading-relaxed">{rawMarkdown}</pre>
          </TabsContent>
        </div>
      </Tabs>
      <EntryActions entry={e} />
    </>
  );
}

const REASON: Record<string, string> = { withdrawn: '这条经验已撤回', archived: '这条经验已归档', suspended: '这条经验已暂停推荐，等待复核' };

/** 经验详情抽屉：读取 accremind.kb.get（不计入使用统计）。 */
export function EntrySheet() {
  const { entryId, openEntry, revision } = useApp();
  const res = useAsync(() => (entryId ? rpc<KbGetResult>('accremind.kb.get', { id: entryId }) : Promise.resolve(undefined)), [entryId, revision]);
  const data = res.data;
  return (
    <Sheet open={!!entryId} onOpenChange={(o) => !o && openEntry(null)}>
      <SheetContent aria-describedby={undefined}>
        {res.loading && !data ? (
          <div className="grid gap-4 p-6">
            <DialogTitle className="sr-only">正在加载</DialogTitle>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-4/5" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : res.error ? (
          <div className="p-6"><DialogTitle className="sr-only">加载失败</DialogTitle><EmptyState icon={TriangleAlert} title="读取失败" description={res.error.message} /></div>
        ) : !data || !data.found ? (
          <div className="p-6"><DialogTitle className="sr-only">未找到</DialogTitle><EmptyState icon={FileText} title={`没有找到 ${entryId ?? ''}`} description="它可能已被删除或迁移。" /></div>
        ) : !data.servable ? (
          <div className="p-6">
            <DialogTitle className="sr-only">{REASON[data.reason]}</DialogTitle>
            <EmptyState icon={Ban} title={REASON[data.reason] ?? '暂不可查看'} description={data.supersedes ? `已由 ${data.supersedes} 取代` : '可在「治理」中查看处理记录。'} />
          </div>
        ) : (
          <EntryBody data={data} />
        )}
      </SheetContent>
    </Sheet>
  );
}
