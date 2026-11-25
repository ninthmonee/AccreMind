import { ChevronDown, FlaskConical, GitCommitHorizontal, Radar, ScanSearch, ShieldOff, Sparkles, TestTube, Wand2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { toast } from 'sonner';
import { useApp } from '@/app/app-context';
import { EmptyState, PageHeader, StatCard, stagger } from '@/components/display';
import { DiffView } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Segmented } from '@/components/ui/overlays';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Switch } from '@/components/ui/primitives';
import { rpc } from '@/lib/rpc';
import type { MinedCommit, RadarResult, RepoProfile } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { cn, formatDate } from '@/lib/utils';

const DISPOSITION: Record<string, string> = {
  knowledge_candidate: '成为候选',
  needs_confirmation: '待补证据',
  index_only: '仅建索引',
  link_existing: '关联已有',
  discard: '丢弃',
};

/** Git 雷达：零 Token 扫描提交历史，按信号强度排序；勾选后交给模型提炼为候选。 */
export function RadarPage() {
  const { refresh, setView, demo, switchDemo, revision } = useApp();
  const [depth, setDepth] = useState('150');
  const [result, setResult] = useState<RadarResult | null>(null);
  const [busy, setBusy] = useState<'scan' | 'extract' | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingFlag, setSavingFlag] = useState<'capture' | 'share' | null>(null);
  const settings = useAsync(() => rpc<RepoProfile>('accremind.repo.profile'), [revision]);
  const captureOn = settings.data?.capture !== false;
  const shareOn = settings.data?.share !== false;

  const setFlag = async (key: 'capture' | 'share', value: boolean) => {
    setSavingFlag(key);
    try {
      await rpc('accremind.repo.setSettings', { [key]: value });
      toast.success(value ? '已恢复' : '已排除', { description: '写入 .accremind/repo.json，提交后对整个仓库生效' });
      settings.reload();
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingFlag(null);
    }
  };

  const scan = async () => {
    setBusy('scan');
    try {
      const out = await rpc<RadarResult>('accremind.gov.bootstrapHistory', { maxCommits: Number(depth), topK: 20, extractWithLlm: false });
      setResult(out);
      setPicked(new Set(out.minedCommits.slice(0, 3).map((c) => c.commitSha)));
      if (!out.minedCommits.length) toast.info('没有发现高信号提交');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const extract = async () => {
    setBusy('extract');
    try {
      const out = await rpc<RadarResult>('accremind.gov.bootstrapHistory', { maxCommits: Number(depth), topK: picked.size, extractWithLlm: true, commitShas: [...picked] });
      if (out.message) toast.info(out.message);
      else {
        const counts = out.triageReport?.dispositionCounts ?? {};
        toast.success('提炼完成', { description: Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${DISPOSITION[k] ?? k} ${n}`).join(' · ') || '没有生成候选' });
        refresh();
      }
      setResult((r) => (r ? { ...r, triageReport: out.triageReport, modelAvailable: out.modelAvailable } : out));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const commits = result?.minedCommits ?? [];
  const points = useMemo(() => commits.map((c) => ({ x: new Date(c.committedAtIso).getTime(), y: c.signalScore, z: c.touchedFiles.length, sha: c.commitSha, subject: c.subject })), [commits]);
  const strong = commits.filter((c) => c.signalScore >= 5).length;
  const withTest = commits.filter((c) => c.hasCoModifiedTest).length;
  const maxScore = Math.max(1, ...commits.map((c) => c.signalScore));
  const toggle = (sha: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(sha)) n.delete(sha);
      else n.add(sha);
      return n;
    });

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={<><Radar className="size-4" /><span>冷启动：从历史里找经验</span></>}
        title="Git 雷达"
        description="回滚、竞态修复、短时间内反复改同一文件的提交，往往藏着代码里看不出来的教训。扫描不消耗 Token。"
        actions={
          <>
            <Segmented<string>
              ariaLabel="扫描深度"
              value={depth}
              onValueChange={setDepth}
              items={[
                { value: '50', label: '近 50' },
                { value: '150', label: '近 150' },
                { value: '400', label: '近 400' },
              ]}
            />
            <Button variant="outline" onClick={() => setSettingsOpen(true)}>
              <ShieldOff className={cn(!captureOn && 'text-warning')} />
              项目排除
            </Button>
            <Button onClick={() => void scan()} disabled={!!busy || !captureOn}>
              <ScanSearch className={cn(busy === 'scan' && 'animate-pulse')} />
              {result ? '重新扫描' : '开始扫描'}
            </Button>
          </>
        }
      />

      {!captureOn ? (
        <Card className="relative overflow-hidden p-10">
          <div className="relative flex flex-col items-center gap-4 text-center">
            <span className="inline-flex size-16 items-center justify-center rounded-2xl bg-warning/12 text-warning ring-1 ring-inset ring-warning/25"><ShieldOff className="size-7" /></span>
            <div>
              <p className="text-lg font-semibold">本项目已排除沉淀</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground"><code>.accremind/repo.json</code> 里写着 <code>capture: false</code>：雷达不扫描，手工与自动捕获也不写入；库里已有的经验照常服务。恢复后要重新扫描一次，才会看到新候选。</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" disabled={savingFlag !== null} onClick={() => void setFlag('capture', true)}><ShieldOff />恢复沉淀</Button>
              <Button size="lg" variant="outline" onClick={() => setSettingsOpen(true)}>查看排除设置</Button>
            </div>
          </div>
        </Card>
      ) : !result ? (
        <Card className="relative overflow-hidden p-10">
          <div className="pointer-events-none absolute inset-x-0 top-[72px] flex justify-center">
            {[0, 1, 2].map((i) => (
              <span key={i} className="absolute -top-12 size-24 animate-ping rounded-full border border-primary/30 [animation-duration:3s]" style={{ animationDelay: `${i}s` }} />
            ))}
          </div>
          <div className="relative flex flex-col items-center gap-4 text-center">
            <span className="inline-flex size-16 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-1 ring-inset ring-primary/25"><Radar className="size-7" /></span>
            <div>
              <p className="text-lg font-semibold">扫描最近的提交</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">只读取本地 Git 记录，不会上传任何代码。结果按信号强度排序，你可以挑选值得提炼的提交。</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" onClick={() => void scan()} disabled={!!busy}><ScanSearch />开始扫描</Button>
              {!demo && <Button size="lg" variant="outline" onClick={() => void switchDemo()}><FlaskConical />在示例项目里试试</Button>}
            </div>
          </div>
        </Card>
      ) : !commits.length ? (
        <EmptyState icon={ScanSearch} title="没有发现高信号提交" description="试试扩大扫描深度。提交信息越具体（写清修了什么、为什么），雷达越容易识别。" />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <div className="rise"><StatCard icon={GitCommitHorizontal} tone="primary" label="高信号提交" value={commits.length} caption={`在最近 ${depth} 个提交中`} /></div>
            <div className="rise" style={stagger(1)}><StatCard icon={Zap} tone="warning" label="强信号" value={strong} caption="信号分 ≥ 5，优先查看" /></div>
            <div className="rise" style={stagger(2)}><StatCard icon={TestTube} tone="success" label="同时改了测试" value={withTest} caption="有测试佐证，更容易补证据" /></div>
          </section>

          <Card className="rise mt-4">
            <CardHeader>
              <div>
                <CardTitle>提交时间线与信号强度</CardTitle>
                <CardDescription>越靠上信号越强，点越大改动的文件越多。点击圆点勾选。</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" />
                    <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => formatDate(new Date(v).toISOString()).slice(5)} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickLine={false} axisLine={false} name="时间" />
                    <YAxis type="number" dataKey="y" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} tickLine={false} axisLine={false} name="信号分" allowDecimals={false} />
                    <ZAxis type="number" dataKey="z" range={[50, 360]} />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3' }}
                      content={({ payload }) => {
                        const p = payload?.[0]?.payload as (typeof points)[number] | undefined;
                        if (!p) return null;
                        return (
                          <div className="max-w-xs rounded-lg border bg-popover px-3 py-2 text-xs shadow-xl">
                            <p className="font-mono text-muted-foreground">{p.sha.slice(0, 7)} · 信号 {p.y}</p>
                            <p className="mt-1 font-medium">{p.subject}</p>
                          </div>
                        );
                      }}
                    />
                    <Scatter
                      data={points}
                      fill="var(--chart-1)"
                      fillOpacity={0.75}
                      stroke="var(--card)"
                      strokeWidth={2}
                      className="cursor-pointer"
                      onClick={(d: { payload?: { sha?: string } }) => d.payload?.sha && toggle(d.payload.sha)}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="sticky top-[calc(var(--header-h,64px)+12px)] z-20 mt-6 surface flex flex-wrap items-center gap-3 p-3">
            <span className="text-sm">已选 <b className="num">{picked.size}</b> 个提交</span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(commits.map((c) => c.commitSha)))}>全选</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>清空</Button>
            <span className="ml-auto text-xs text-muted-foreground">{result.modelAvailable ? '提炼会把所选提交的说明与差异发送给已配置的模型' : '未配置提炼模型，暂时只能扫描'}</span>
            <Button disabled={!picked.size || !result.modelAvailable || !!busy} onClick={() => void extract()}>
              <Wand2 className={cn(busy === 'extract' && 'animate-spin')} />提炼为候选
            </Button>
          </div>

          {result.triageReport && (
            <div className="rise mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-success/30 bg-success/8 px-4 py-3 text-sm">
              <Sparkles className="size-4 text-success" />
              <span>上次提炼：</span>
              {Object.entries(result.triageReport.dispositionCounts).filter(([, n]) => n).map(([k, n]) => <Badge key={k} tone="success">{DISPOSITION[k] ?? k} {n}</Badge>)}
              <Button variant="link" size="sm" className="ml-auto h-auto p-0" onClick={() => setView('review')}>去审核候选</Button>
            </div>
          )}

          <ul className="mt-4 grid gap-3">
            {commits.map((c, i) => (
              <CommitRow key={c.commitSha} commit={c} index={i} maxScore={maxScore} picked={picked.has(c.commitSha)} onToggle={() => toggle(c.commitSha)} open={open === c.commitSha} onOpen={() => setOpen(open === c.commitSha ? null : c.commitSha)} />
            ))}
          </ul>
        </>
      )}

      <ExclusionDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        captureOn={captureOn}
        shareOn={shareOn}
        saving={savingFlag}
        onToggle={(key, value) => void setFlag(key, value)}
        profileFile={settings.data?.profileFile}
      />
    </div>
  );
}

/**
 * 项目级排除：有的仓库（临时脚本、带客户数据的项目）既不需要沉淀经验，也不该和别的仓库共享。
 * 两个开关都写进 .accremind/repo.json，随仓库提交，所有克隆一致。
 */
function ExclusionDialog({ open, onOpenChange, captureOn, shareOn, saving, onToggle, profileFile }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  captureOn: boolean;
  shareOn: boolean;
  saving: 'capture' | 'share' | null;
  onToggle: (key: 'capture' | 'share', value: boolean) => void;
  profileFile?: string;
}) {
  const rows: { key: 'capture' | 'share'; on: boolean; title: string; hint: string }[] = [
    { key: 'capture', on: captureOn, title: '本项目沉淀经验', hint: '关掉后 Git 雷达不扫描，手工录入与自动捕获都不写入；已经在库里的经验照常提醒。' },
    { key: 'share', on: shareOn, title: '与其它仓库共享经验', hint: '关掉后双向隔离：这里的领域知识与通用经验不提醒到别的仓库，也不读取别处的经验。' },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>项目排除</DialogTitle>
        <DialogDescription>
          有些项目不需要沉淀经验，也不该共享经验。开关写进 {profileFile ? <code className="break-all">{profileFile}</code> : '.accremind/repo.json'}，提交后整个仓库一致。
        </DialogDescription>
        <div className="mt-4 grid gap-4">
          {rows.map((row) => (
            <div key={row.key} className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{row.title}</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">{row.hint}</p>
              </div>
              <Switch
                checked={row.on}
                disabled={saving !== null}
                onCheckedChange={(v: boolean) => onToggle(row.key, v)}
                aria-label={row.title}
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CommitRow({ commit: c, index, maxScore, picked, onToggle, open, onOpen }: { commit: MinedCommit; index: number; maxScore: number; picked: boolean; onToggle: () => void; open: boolean; onOpen: () => void }) {
  return (
    <li className="rise min-w-0" style={stagger(index)}>
      <Card className={cn('min-w-0 overflow-hidden transition', picked && 'border-primary/50 ring-1 ring-primary/30')}>
        <div className="flex items-start gap-4 p-4">
          <button
            type="button"
            role="checkbox"
            aria-checked={picked}
            aria-label="选择该提交"
            onClick={onToggle}
            className={cn('mt-1 inline-flex size-5 shrink-0 items-center justify-center rounded-md border transition', picked ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:border-primary/60')}
          >
            {picked && <svg viewBox="0 0 16 16" className="size-3.5"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{c.commitSha.slice(0, 7)}</span>
              <span>{formatDate(c.committedAtIso)}</span>
              <span>· {c.touchedFiles.length} 个文件</span>
              {c.hasCoModifiedTest && <Badge tone="success"><TestTube />含测试</Badge>}
              {c.rapidFixClusterFiles.length > 0 && <Badge tone="warning">短期内反复修改</Badge>}
            </div>
            <p className="mt-1 break-words font-medium leading-snug [overflow-wrap:anywhere]">{c.subject}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.signalReasons.map((r) => <Badge key={r} tone="info">{r}</Badge>)}
            </div>
          </div>
          <div className="w-28 shrink-0 text-right">
            <p className="num font-display text-2xl font-semibold leading-none">{c.signalScore}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">信号分</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="grow-x h-full rounded-full bg-chart-1" style={{ width: `${(c.signalScore / maxScore) * 100}%` }} />
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label={open ? '收起' : '查看改动'} onClick={onOpen}>
            <ChevronDown className={cn('transition', open && 'rotate-180')} />
          </Button>
        </div>
        {open && (
          <div className="grid min-w-0 gap-3 border-t bg-muted/20 p-4 animate-in fade-in-0">
            {c.body && (
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{c.body}</p>
            )}
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {c.touchedFiles.slice(0, 12).map((f) => <code key={f} className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{f}</code>)}
            </div>
            <DiffView diff={c.diffPreview} className="min-w-0 max-w-full" wrap />
          </div>
        )}
      </Card>
    </li>
  );
}

