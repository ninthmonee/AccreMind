import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  ClipboardCheck,
  FlaskConical,
  Inbox,
  LibraryBig,
  type LucideIcon,
  PauseCircle,
  Radar,
  ShieldCheck,
  Sparkles,
  Stamp,
  ThumbsUp,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApp } from '@/app/app-context';
import { ChartTooltip, Delta, PageHeader, Ring, SegmentBar, Sparkline, StatCard, stagger } from '@/components/display';
import { TypeChip } from '@/components/entry-badges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@/components/ui/primitives';
import { TYPES } from '@/lib/labels';
import { rpc } from '@/lib/rpc';
import type { AttentionItem, Digest, Insights, KnowledgeType, ReviewQueue } from '@/lib/types';
import { useAsync } from '@/lib/use-async';
import { percent } from '@/lib/utils';
import { DonutCard } from '../library/charts';
import { LifecycleFlow } from '../library/lifecycle-flow';
import { InboxCard } from './inbox-card';
import { TrendCard } from './trend-card';

interface NextStep {
  icon: LucideIcon;
  title: string;
  detail: string;
  cta?: { label: string; run: () => void };
}

/** 总览：先告诉你下一步做什么，再用数据卡片、趋势、健康度与流程呈现全局。 */
export function HomePage() {
  const { overview, revision, setView, openLibrary, openEntry, demo, switchDemo } = useApp();
  const [days, setDays] = useState(28);
  const insights = useAsync(() => rpc<Insights>('accremind.insights.overview', { days, tzOffsetMinutes: -new Date().getTimezoneOffset() }), [days, revision]);
  const queue = useAsync(() => rpc<ReviewQueue>('accremind.review.listQueue', { reviewState: 'pending', limit: 5 }), [revision]);
  const attention = useAsync(() => rpc<{ items: AttentionItem[] }>('accremind.attention.list'), [revision]);
  const digest = useAsync(() => rpc<Digest>('accremind.digest', { days: 7 }), [revision]);

  const c = overview.data?.counts;
  const ins = insights.data;
  const t = ins?.totals;
  const loadingCounts = overview.loading && !c;
  const inboxTotal = (c?.pendingReviewCount ?? 0) + (ins?.attention ?? 0) + (c?.reviewDueCount ?? 0);

  const next: NextStep = !c
    ? { icon: Sparkles, title: '正在读取工作区…', detail: '' }
    : c.totalEntries === 0 && c.pendingReviewCount === 0
      ? {
          icon: Radar,
          title: '从仓库历史开始沉淀第一条经验',
          detail: 'Git 雷达会找出回滚、竞态修复、反复排障这类高信号提交，帮你冷启动经验库。',
          cta: { label: '扫描仓库历史', run: () => setView('radar') },
        }
      : c.pendingReviewCount > 0
        ? {
            icon: ClipboardCheck,
            title: `${c.pendingReviewCount} 条新经验等你确认`,
            detail: 'AI 在最近的任务里总结了这些经验。看一眼它比代码多说了什么，再决定是否保留。',
            cta: { label: '去审核', run: () => setView('review') },
          }
        : c.governanceQueueCount > 0
          ? {
              icon: ShieldCheck,
              title: `${c.governanceQueueCount} 条经验需要复核`,
              detail: '关联的代码有变化或被反馈有误，核对后继续使用或标记失效。',
              cta: { label: '去治理', run: () => setView('governance') },
            }
          : {
              icon: CircleCheck,
              title: '一切正常，经验在持续帮 AI 干活',
              detail: `近 7 天 AI 被提醒了 ${t?.remindersLast7 ?? 0} 次。继续在 DSH 里工作，新经验会自动出现在待办里。`,
              cta: { label: '浏览知识库', run: () => setView('library') },
            };

  const health = ins?.byHealth;
  const healthTotal = health ? Object.values(health).reduce((a, b) => a + b, 0) : 0;
  const typeData = TYPES.map((ty, i) => ({ key: ty.value, label: ty.label, value: ins?.byType[ty.value] ?? 0, fill: `var(--chart-${i + 1})` })).filter((d) => d.value > 0);
  const topMax = Math.max(1, ...(ins?.topEntries ?? []).map((e) => e.reminders));

  return (
    <div className="pb-16">
      <PageHeader
        eyebrow={
          <>
            <span>{demo ? '演示工作区' : overview.data?.projectName ?? '工作区'}</span>
            <span className="text-border">/</span>
            <span className="text-foreground">总览</span>
          </>
        }
        title={next.title}
        description={next.detail}
        actions={
          <>
            {next.cta && (
              <Button size="lg" onClick={next.cta.run}>
                <next.icon />
                {next.cta.label}
                <ArrowRight />
              </Button>
            )}
            {!demo && c?.totalEntries === 0 && (
              <Button size="lg" variant="outline" onClick={() => void switchDemo()}>
                <FlaskConical />体验示例
              </Button>
            )}
          </>
        }
      />

      {/* ---------- 数据卡片 ---------- */}
      <section aria-label="关键指标" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
        <div className="rise" style={stagger(0)}>
          <StatCard
            icon={LibraryBig}
            tone="success"
            label="已入库经验"
            value={c?.activeCount ?? 0}
            suffix={`/ ${c?.totalEntries ?? 0}`}
            loading={loadingCounts}
            caption={<>团队规范 <b className="num text-foreground">{c?.rulesCount ?? 0}</b> · 试用 <b className="num text-foreground">{c?.probationCount ?? 0}</b></>}
            visual={<Ring value={percent(c?.verifiedOrProvenCount ?? 0, c?.totalEntries ?? 0)} tone="success" label="已验证占比" />}
            onClick={() => openLibrary({ status: 'active' })}
          />
        </div>
        <div className="rise" style={stagger(1)}>
          <StatCard
            icon={Zap}
            tone="info"
            label="近 7 天按需提醒"
            value={t?.remindersLast7 ?? 0}
            suffix="次"
            loading={insights.loading && !t}
            caption={<span className="flex items-center gap-1.5"><Delta value={(t?.remindersLast7 ?? 0) - (t?.remindersPrev7 ?? 0)} />比前 7 天</span>}
            visual={<Sparkline values={(ins?.daily ?? []).slice(-14).map((d) => d.reminders)} color="var(--chart-1)" width={96} />}
            onClick={() => setView('receipts')}
          />
        </div>
        <div className="rise" style={stagger(2)}>
          <StatCard
            icon={ThumbsUp}
            tone="primary"
            label="有帮助的反馈"
            value={t?.helpful ?? 0}
            loading={insights.loading && !t}
            caption={t?.reminders ? <>占提醒的 <b className="num text-foreground">{percent(t.helpful, t.reminders)}%</b> · 近 {days} 天</> : `近 ${days} 天`}
            visual={<Sparkline values={(ins?.daily ?? []).slice(-14).map((d) => d.helpful)} color="var(--chart-3)" width={96} />}
          />
        </div>
        <div className="rise" style={stagger(3)}>
          <StatCard
            icon={Inbox}
            tone={inboxTotal ? 'warning' : 'success'}
            label="需要你处理"
            value={inboxTotal}
            suffix="项"
            loading={loadingCounts}
            caption={
              <div className="grid gap-1.5">
                <span>审核 {c?.pendingReviewCount ?? 0} · 关注 {ins?.attention ?? 0} · 复核 {c?.reviewDueCount ?? 0}</span>
                <SegmentBar
                  parts={[
                    { key: 'rev', value: c?.pendingReviewCount ?? 0, tone: 'info', label: '候选审核' },
                    { key: 'att', value: ins?.attention ?? 0, tone: 'warning', label: '需要关注' },
                    { key: 'due', value: c?.reviewDueCount ?? 0, tone: 'danger', label: '待复核' },
                  ]}
                />
              </div>
            }
            onClick={inboxTotal ? () => document.getElementById('home-inbox')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) : undefined}
          />
        </div>
      </section>

      {/* ---------- 趋势 + 健康度 ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <TrendCard className="rise lg:col-span-2" daily={ins?.daily} days={days} onDaysChange={setDays} loading={insights.loading} />
        <DonutCard
          className="rise"
          title="经验健康度"
          description="现在能不能放心交给 AI 用"
          centerLabel="可放心用"
          centerValue={`${percent((health?.verified ?? 0) + (health?.usable ?? 0), healthTotal)}%`}
          data={[
            { key: 'verified', label: '已验证', value: health?.verified ?? 0, fill: 'var(--success)', icon: <BadgeCheck /> },
            { key: 'usable', label: '可用（待验证）', value: health?.usable ?? 0, fill: 'var(--chart-1)', icon: <CircleCheck /> },
            { key: 'trial', label: '试用中', value: health?.trial ?? 0, fill: 'var(--chart-4)', icon: <FlaskConical /> },
            { key: 'attention', label: '需复核', value: health?.attention ?? 0, fill: 'var(--danger)', icon: <TriangleAlert /> },
            { key: 'stopped', label: '已停用', value: health?.stopped ?? 0, fill: 'var(--muted-foreground)', icon: <PauseCircle /> },
          ]}
          onSelect={(key) =>
            key === 'trial' ? openLibrary({ status: 'probation' }) : key === 'attention' ? openLibrary({ freshness: 'review_due' }) : openLibrary({ status: 'active' })
          }
        />
      </section>

      {/* ---------- 流程 ---------- */}
      <LifecycleFlow
        className="rise mt-4"
        stages={[
          { key: 'queue', label: '捕获', hint: '对话结束或提交历史中识别信号', count: c?.queuedCaptureJobs ?? 0, icon: Inbox, tone: 'neutral', onClick: () => setView('radar') },
          { key: 'review', label: '候选审核', hint: '核对基线、增量与证据', count: c?.pendingReviewCount ?? 0, icon: ClipboardCheck, tone: 'info', onClick: () => setView('review') },
          { key: 'probation', label: '本机试用', hint: '只提醒、不强制，攒够反馈再转正', count: c?.probationCount ?? 0, icon: FlaskConical, tone: 'warning', onClick: () => openLibrary({ status: 'probation' }) },
          { key: 'active', label: '正式入库', hint: '随仓库共享，改前自动提醒', count: c?.activeCount ?? 0, icon: Stamp, tone: 'success', onClick: () => openLibrary({ status: 'active' }) },
          { key: 'gov', label: '时效治理', hint: '代码变更触发复核与反证处理', count: c?.governanceQueueCount ?? 0, icon: ShieldCheck, tone: 'danger', onClick: () => setView('governance') },
        ]}
      />

      {/* ---------- 待办 + 常用经验 ---------- */}
      <section className="mt-4 grid gap-4 lg:grid-cols-5 [&>*]:min-w-0">
        <div id="home-inbox" className="lg:col-span-3">
          <InboxCard
            className="h-full"
            pending={queue.data?.items ?? []}
            attention={attention.data?.items ?? []}
            reviewDue={c?.reviewDueCount ?? 0}
            loading={queue.loading || attention.loading}
          />
        </div>
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>最常用的经验</CardTitle>
              <CardDescription>近 {days} 天提醒 AI 次数最多</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {insights.loading && !ins ? (
              <div className="grid gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
            ) : !ins?.topEntries.length ? (
              <p className="py-10 text-center text-sm text-muted-foreground">AI 还没有被提醒过。开始在 DSH 里干活后，这里会显示最常用的经验。</p>
            ) : (
              <ol className="grid gap-1">
                {ins.topEntries.map((e, i) => (
                  <li key={e.id} className="rise" style={stagger(i)}>
                    <button type="button" onClick={() => openEntry(e.id)} className="group grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-accent">
                      <span className={`num inline-flex size-6 items-center justify-center rounded-md text-xs font-semibold ${i === 0 ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium group-hover:text-primary">{e.title}</span>
                        <span className="mt-1 flex items-center gap-2">
                          <TypeChip type={e.type} />
                          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                            <span className="grow-x block h-full rounded-full bg-chart-1" style={{ width: `${(e.reminders / topMax) * 100}%` }} />
                          </span>
                        </span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-sm font-semibold">{e.reminders}</span>
                        <span className="num inline-flex items-center gap-1 text-[11px] text-muted-foreground"><ThumbsUp className="size-3" />{e.helpful}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------- 类型分布 ---------- */}
      <Card className="rise mt-4">
        <CardHeader>
          <div>
            <CardTitle>按类型分布</CardTitle>
            <CardDescription>正在使用的经验里，每类各有多少条。点击柱子在知识库中查看。</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {!typeData.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有正在使用的经验。</p>
          ) : (
            <div style={{ height: typeData.length * 44 + 8 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={typeData} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={10}>
                  <XAxis type="number" hide allowDecimals={false} />
                  <YAxis type="category" dataKey="label" width={84} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 13 }} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--accent)', opacity: 0.6 }} />
                  <Bar dataKey="value" name="条数" radius={[0, 4, 4, 0]} maxBarSize={22} className="cursor-pointer" onClick={(d: { payload?: { key?: string } }) => d.payload?.key && openLibrary({ type: d.payload.key as KnowledgeType })} animationDuration={800}>
                    {typeData.map((d) => <Cell key={d.key} fill={d.fill} />)}
                    <LabelList dataKey="value" position="right" fill="var(--foreground)" fontSize={12} fontWeight={600} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- 本周摘要 ---------- */}
      <DigestCard digest={digest.data} loading={digest.loading && !digest.data} />
    </div>
  );
}

const DIGEST_OP: Record<string, string> = {
  create_doc: '新建文档', add_section: '新增章节', update_section: '修改章节', delete_section: '删除章节', import: '导入', manual_edit: '直接编辑', delete_doc: '删除文档',
};

/** 近 7 天：哪些事等你决定、系统自己做了什么（自动降级、文档变更、调参）、提醒效果如何。命令行同样可用：accremind digest。 */
function DigestCard({ digest: d, loading }: { digest: Digest | undefined; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  if (loading) return <Skeleton className="mt-4 h-40 rounded-xl" />;
  if (!d) return null;
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const events = [
    ...d.happened.autoDemotions.map((a) => ({ at: a.at, text: `${a.title ?? a.entryId} 被自动${a.step === 'demote' ? '降为试用' : '归档'}：${a.reason}` })),
    ...d.happened.docChanges.map((c) => ({ at: c.at, text: `${c.doc}${c.section ? ` › ${c.section}` : ''}：${DIGEST_OP[c.op] ?? c.op}（${c.actor}）` })),
    ...d.happened.tuning.map((t) => ({ at: t.at, text: `检索参数${t.action}：${t.reason}` })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <Card className="rise mt-4">
      <CardHeader>
        <div>
          <CardTitle>本周摘要</CardTitle>
          <CardDescription>{d.since.slice(0, 10)} 至 {d.until.slice(0, 10)}。可以复制成 Markdown 发到团队群。</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => void copy()}>{copied ? '已复制' : '复制 Markdown'}</Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5 text-sm">
          <p>待审核候选 <span className="num font-semibold">{d.pending.candidates}</span></p>
          <p>待决定的经验 <span className="num font-semibold">{d.pending.attention}</span>（由你负责 {d.pending.attentionMine}）</p>
          <p>文档修改提议 <span className="num font-semibold">{d.pending.docProposals}</span>（由你负责 {d.pending.docProposalsMine}）</p>
          <p>关联代码有变化 <span className="num font-semibold">{d.pending.reviewDue}</span></p>
          <p className="text-muted-foreground">提醒 {d.usage.reminders} 次 · 有帮助率 {pct(d.usage.helpfulRate)} · 不适用率 {pct(d.usage.inapplicableRate)}</p>
        </div>
        <ul className="grid content-start gap-1.5 text-xs">
          {events.length ? events.map((e, i) => (
            <li key={i} className="flex gap-2"><span className="num shrink-0 text-muted-foreground">{e.at.slice(5, 10)}</span><span className="min-w-0">{e.text}</span></li>
          )) : <li className="text-muted-foreground">这段时间没有自动调整或文档变更。</li>}
        </ul>
      </CardContent>
    </Card>
  );
}
