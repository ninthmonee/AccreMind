import { BookMarked, Compass, FileQuestion, Lightbulb, Loader2, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, SimpleSelect } from '@/components/ui/overlays';
import { Input, Label, Textarea } from '@/components/ui/primitives';
import { LAYERS, PRIORITY, TYPES } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { CaptureResult, Disposition, KnowledgeType, Priority } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useApp } from './app-context';

const ROUTES: { value: Disposition; label: string; hint: string; icon: typeof Lightbulb; submit: string; discoverability: string }[] = [
  { value: 'knowledge_candidate', label: '有代码外新增经验', hint: '沉淀为经验条目', icon: Lightbulb, submit: '提交经验', discoverability: 'missing_context' },
  { value: 'index_only', label: '代码已能回答', hint: '只保存代码导航', icon: Compass, submit: '保存代码导航', discoverability: 'code_recoverable' },
  { value: 'link_existing', label: '已有权威文档', hint: '保存文档链接', icon: BookMarked, submit: '保存文档链接', discoverability: 'authoritative_source' },
  { value: 'needs_confirmation', label: '证据不足', hint: '提交待补证', icon: FileQuestion, submit: '提交待补证', discoverability: 'inconclusive' },
  { value: 'discard', label: '没有复用价值', hint: '记录丢弃原因', icon: Trash2, submit: '记录丢弃原因', discoverability: 'inconclusive' },
];

const DESTINATION: Record<string, string> = {
  probation: '本机试用池', project: '项目经验库', knowledge_candidate: '待审核队列', index_only: '代码导航',
  link_existing: '文档索引', needs_confirmation: '待补证队列', discard: '审核历史',
};

const empty = {
  layer: 'project' as 'project' | 'domain', question: '', baseline: '', delta: '', title: '', type: 'pitfall' as KnowledgeType,
  priority: 'P1' as Priority, polarity: 'recommend' as 'recommend' | 'avoid', aliases: '', claim: '', pre: '', inv: '',
  method: '', note: '', loc: '',
};

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** 录入经验：按“代码与文档的覆盖程度”分五路，与 accremind_capture 工具的分流语义一致。 */
export function CaptureDialog() {
  const { captureOpen, setCaptureOpen, refresh, setView } = useApp();
  const [route, setRoute] = useState<Disposition>('knowledge_candidate');
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    if (captureOpen) {
      setF(empty);
      setNotice(null);
      setRoute('knowledge_candidate');
    }
  }, [captureOpen]);

  const set = <K extends keyof typeof empty>(k: K, v: (typeof empty)[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const candidate = route === 'knowledge_candidate';
  const discarded = route === 'discard';
  const meta = ROUTES.find((r) => r.value === route)!;
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const required: [keyof typeof empty, string][] = [['question', '遇到的问题'], ['baseline', '代码或文档能知道什么']];
    if (candidate) required.push(['delta', '代码外经验'], ['title', '经验标题'], ['claim', '应对做法'], ['pre', '适用条件'], ['inv', '失效条件'], ['method', '验证方法'], ['note', '证据内容'], ['loc', '证据位置']);
    if (discarded) required.push(['note', '丢弃原因']);
    if (route === 'index_only' || route === 'link_existing') required.push(['loc', '位置']);
    const missing = required.find(([k]) => !String(f[k]).trim());
    if (missing) {
      toast.error(`请填写「${missing[1]}」`);
      document.getElementById(`cap-${missing[0]}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const out = await rpc<CaptureResult>('accremind.capture.manual', {
        question: f.question,
        discoverability: meta.discoverability,
        layer: f.layer,
        disposition: route,
        baseline_answer: f.baseline,
        knowledge_delta: candidate ? f.delta : '',
        title: f.title,
        type: f.type,
        priority: f.priority,
        polarity: f.type === 'guideline' ? f.polarity : undefined,
        search_aliases: f.aliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        claim: f.claim,
        rationale: candidate || discarded ? f.note : f.baseline,
        preconditions: lines(f.pre),
        invalidation_triggers: lines(f.inv),
        verification_method: f.method,
        evidence_summary: candidate ? f.note : '',
        file_locator: discarded ? '' : f.loc,
      });
      refresh();
      if (out.downgradedReason) {
        setNotice({ title: `已保存到${DESTINATION[out.finalDisposition] ?? '候选审核'}`, body: out.downgradedReason });
        return;
      }
      toast.success(out.duplicate ? `此记录已存在 · ${out.assessmentId}` : `已保存到${DESTINATION[out.persistedZone ?? out.finalDisposition] ?? '经验库'}`);
      setCaptureOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
      <DialogContent className="max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <div className="border-b px-6 pb-4 pt-5">
          <DialogTitle className="font-display text-lg font-semibold tracking-tight">录入研发经验</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-muted-foreground">
            只沉淀“仅凭当前代码与文档难以恢复”的信息。项目写入策略决定新经验进入试用池还是待审队列。
          </DialogDescription>
        </div>
        <form id="capture-form" onSubmit={submit} className="grid min-h-0 gap-5 overflow-y-auto px-6 py-5">
          {notice && (
            <div role="status" className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
              <p className="font-medium text-warning">{notice.title}</p>
              <p className="mt-1 text-muted-foreground">{notice.body}</p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => { setCaptureOpen(false); setView('review'); }}>
                前往候选审核
              </Button>
            </div>
          )}

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-[13px] font-medium">代码与文档对这个问题的覆盖程度</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {ROUTES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={route === r.value}
                  onClick={() => setRoute(r.value)}
                  className={cn(
                    'flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition hover:bg-accent',
                    route === r.value && 'border-primary/60 bg-primary/8 ring-1 ring-primary/30',
                  )}
                >
                  <r.icon className={cn('size-4', route === r.value ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="text-[13px] font-medium leading-tight">{r.label}</span>
                  <span className="text-xs text-muted-foreground">{r.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="知识范围">
              <SimpleSelect
                ariaLabel="知识范围"
                value={f.layer}
                onValueChange={(v) => set('layer', (v || 'project') as 'project' | 'domain')}
                placeholder="项目知识"
                options={LAYERS.filter((l) => l.value === 'project' || l.value === 'domain').map((l) => ({ value: l.value as 'project' | 'domain', label: l.label, hint: l.hint }))}
              />
            </Field>
            <Field label="遇到了什么问题？" required>
              <Input id="cap-question" value={f.question} onChange={(e) => set('question', e.target.value)} placeholder="例如：分布式定时任务跨实例调度时如何避免重复对账？" />
            </Field>
          </div>
          <Field label="从当前代码或文档能知道什么？" required>
            <Input id="cap-baseline" value={f.baseline} onChange={(e) => set('baseline', e.target.value)} placeholder="例如：代码仅展示了 @Cron 注解触发 reconcile()" />
          </Field>

          {candidate && (
            <>
              <Field label="还有哪些经验无法从代码得知？" required hint="这就是这条经验的核心价值——代码外增量。">
                <Textarea id="cap-delta" rows={2} value={f.delta} onChange={(e) => set('delta', e.target.value)} placeholder="例如：K8s 滚动发布期间新旧 Pod 重叠存活 30s，无数据库租约锁曾导致双发对账单" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
                <Field label="经验标题" required>
                  <Input id="cap-title" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="什么条件下需要注意什么" />
                </Field>
                <Field label="知识类型" required>
                  <SimpleSelect ariaLabel="知识类型" value={f.type} onValueChange={(v) => set('type', (v || 'pitfall') as KnowledgeType)} placeholder="排障陷阱" options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
                </Field>
                <Field label="忽略的代价" required>
                  <SimpleSelect ariaLabel="忽略这条经验的代价" value={f.priority} onValueChange={(v) => set('priority', (v || 'P1') as Priority)} placeholder="P1" options={(['P0', 'P1', 'P2'] as const).map((p) => ({ value: p, label: `${p} ${PRIORITY[p].label}` }))} />
                </Field>
              </div>
              {f.type === 'guideline' && (
                <Field label="规范方向">
                  <SimpleSelect ariaLabel="规范方向" value={f.polarity} onValueChange={(v) => set('polarity', (v || 'recommend') as 'recommend' | 'avoid')} placeholder="建议这样做" options={[{ value: 'recommend', label: '建议这样做' }, { value: 'avoid', label: '禁止这样做' }]} />
                </Field>
              )}
              <Field label="搜索别名" hint="中英文均可，逗号分隔，用于口语提问召回。">
                <Input value={f.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="滚动发布双发, 定时任务防重, cron lease lock" />
              </Field>
              <Field label="遇到同样情况应该怎样做？" required>
                <Textarea id="cap-claim" rows={2} value={f.claim} onChange={(e) => set('claim', e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="适用条件（每行一条）" required>
                  <Textarea id="cap-pre" rows={3} value={f.pre} onChange={(e) => set('pre', e.target.value)} />
                </Field>
                <Field label="失效条件（每行一条）" required>
                  <Textarea id="cap-inv" rows={3} value={f.inv} onChange={(e) => set('inv', e.target.value)} />
                </Field>
              </div>
              <Field label="如何验证这条结论" required>
                <Textarea id="cap-method" rows={2} value={f.method} onChange={(e) => set('method', e.target.value)} placeholder="回归用例或可重复的检查方法" />
              </Field>
            </>
          )}

          {(candidate || discarded) && (
            <Field label={discarded ? '丢弃原因' : '证据内容'} required>
              <Textarea id="cap-note" rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={discarded ? '为什么这条信息无需沉淀为经验？' : '记录的现象、测试结果或文档结论'} />
            </Field>
          )}
          {!discarded && (
            <Field label={route === 'needs_confirmation' ? '已有线索的位置（可选）' : '证据位置（仓库相对路径）'} required={route !== 'needs_confirmation'}>
              <Input id="cap-loc" className="font-mono text-[13px]" value={f.loc} onChange={(e) => set('loc', e.target.value)} placeholder="src/jobs/reconcile.job.ts#L15-L42" />
            </Field>
          )}
        </form>
        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-3">
          <Button type="button" variant="ghost" onClick={() => setCaptureOpen(false)}>取消</Button>
          <Button type="submit" form="capture-form" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {meta.submit}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
