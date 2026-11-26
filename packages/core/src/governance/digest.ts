import * as path from 'node:path';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { readTuningHistory } from '../retrieval/auto-tuning.ts';
import { LlmUsageMeter } from '../observability/llm-usage.ts';

/**
 * A periodic summary of what needs people and what changed by itself: pending decisions (the reader's own first),
 * automatic steps, document changes, tuning changes, and whether reminders were useful. It is the "weekly report"
 * of a repository; hosts show it in the workbench, the CLI prints it, and a scheduled job can send it.
 */
export interface Digest {
  repo: string;
  since: string;
  until: string;
  user: string;
  pending: {
    candidates: number;
    attention: number;
    attentionMine: number;
    docProposals: number;
    docProposalsMine: number;
    reviewDue: number;
  };
  happened: {
    autoDemotions: Array<{ entryId: string; title: string | null; step: string; reason: string; at: string }>;
    docChanges: Array<{ doc: string; section: string | null; op: string; actor: string; at: string; home?: string }>;
    tuning: Array<{ action: string; reason: string; at: string }>;
  };
  usage: { reminders: number; helpful: number; inapplicable: number; wrong: number; helpfulRate: number | null; inapplicableRate: number | null };
  /** What the automatic work cost: model calls and tokens spent on tagging and extraction in the window. */
  models: { calls: number; tokens: number; byKind: Record<string, { calls: number; tokens: number }> };
  markdown: string;
}

export function buildDigest(store: LocalMarkdownSqliteStore, options: { days?: number; now?: Date } = {}): Digest {
  const days = Math.max(1, Math.min(90, options.days ?? 7));
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const attention = store.listAttentionItems();
  const proposals = store.docs.listProposals('pending');
  const reviewDue = store.listEntriesForAdmin().filter(({ entry }) => entry.freshness === 'review_due'
    && (entry.status === 'active' || entry.status === 'probation')).length;
  const autoDemotions = store.listAutoDemotions({ includeReverted: false }).filter((d) => d.created_at >= since)
    .map((d) => ({ entryId: d.entry_id, title: d.title, step: d.step, reason: d.reason, at: d.created_at }));
  const docChanges = store.docs.listChanges({ limit: 500 }).filter((c) => c.at >= since)
    .map((c) => ({ doc: c.docTitle, section: c.section, op: c.op, actor: c.actor, at: c.at, ...(c.home ? { home: c.home } : {}) }));
  const tuning = readTuningHistory(store, 100).filter((r) => r.at >= since).map((r) => ({ action: r.action, reason: r.reason, at: r.at }));
  const insights = store.insights(Math.max(7, days), now);
  const recent = insights.daily.filter((d) => d.date >= since.slice(0, 10));
  const sum = (k: 'reminders' | 'helpful' | 'inapplicable' | 'wrong') => recent.reduce((n, d) => n + d[k], 0);
  const reminders = sum('reminders');
  const helpful = sum('helpful');
  const inapplicable = sum('inapplicable');
  const wrong = sum('wrong');
  const rated = helpful + inapplicable + wrong;
  const usage = {
    reminders, helpful, inapplicable, wrong,
    helpfulRate: rated ? helpful / rated : null,
    inapplicableRate: reminders ? inapplicable / reminders : null,
  };
  const llm = new LlmUsageMeter(path.join(store.paths.globalRoot, 'usage', 'llm-usage.jsonl')).read(days, now);
  const models = { calls: llm.calls, tokens: llm.tokens, byKind: llm.byKind };
  const pending = {
    candidates: store.countAssessments('pending'),
    attention: attention.length,
    attentionMine: attention.filter((a) => a.assignedToMe).length,
    docProposals: proposals.length,
    docProposalsMine: proposals.filter((p) => p.assignedToMe).length,
    reviewDue,
  };
  const user = store.displayName;

  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const lines = [
    `# AccreMind ${days === 7 ? '周报' : `近 ${days} 天摘要`} · ${store.identity.name}`,
    '',
    `${since.slice(0, 10)} 至 ${now.toISOString().slice(0, 10)} · 读者：${user}`,
    '',
    '## 需要处理',
    '',
    `- 待审核的候选经验：${pending.candidates}`,
    `- 待决定的经验：${pending.attention}（其中由你负责 ${pending.attentionMine}）`,
    `- 规则文档的修改提议：${pending.docProposals}（其中由你负责 ${pending.docProposalsMine}）`,
    `- 关联代码有变化、待复核：${pending.reviewDue}`,
    '',
    '## 提醒效果',
    '',
    `- 提醒 ${reminders} 次；有用 ${helpful}、不适用 ${inapplicable}、有错 ${wrong}`,
    `- 有帮助率 ${pct(usage.helpfulRate)}（在有反馈的提醒中）；不适用率 ${pct(usage.inapplicableRate)}`,
    '',
    '## 模型用量',
    '',
    `- 自动提炼与主题标注共 ${models.calls} 次调用、约 ${models.tokens} tokens` +
      (Object.keys(models.byKind).length
        ? `（${Object.entries(models.byKind).map(([kind, v]) => `${kind === 'capture' ? '提炼' : kind === 'tag' ? '标注' : kind} ${v.calls} 次 / ${v.tokens} tokens`).join('；')}）`
        : ''),
    '',
  ];
  if (autoDemotions.length) {
    lines.push('## 自动降级 / 归档', '');
    for (const d of autoDemotions.slice(0, 20)) lines.push(`- ${d.title ?? d.entryId}（${d.step === 'demote' ? '降为试用' : '归档'}）：${d.reason}`);
    lines.push('');
  }
  if (docChanges.length) {
    lines.push('## 规则文档变更', '');
    for (const c of docChanges.slice(0, 20)) lines.push(`- ${c.at.slice(0, 10)} ${c.doc}${c.section ? ` › ${c.section}` : ''}（${c.op}，${c.actor}）`);
    lines.push('');
  }
  if (tuning.length) {
    lines.push('## 检索参数调整', '');
    for (const t of tuning) lines.push(`- ${t.at.slice(0, 10)} ${t.action}：${t.reason}`);
    lines.push('');
  }
  if (!autoDemotions.length && !docChanges.length && !tuning.length) lines.push('这段时间没有自动调整或文档变更。', '');
  return { repo: store.workspaceId, since, until: now.toISOString(), user, pending, happened: { autoDemotions, docChanges, tuning }, usage, models,
    markdown: lines.join('\n') };
}

/** The short line a host may show (not to the model) when the current user has decisions waiting. */
export function pendingNotice(store: LocalMarkdownSqliteStore): { count: number; text: string } {
  const attention = store.listAttentionItems();
  const mine = attention.filter((a) => a.assignedToMe).length + store.docs.listProposals('pending').filter((p) => p.assignedToMe).length;
  const unowned = attention.filter((a) => !a.owners.length).length;
  const candidates = store.countAssessments('pending');
  const count = mine + unowned + candidates;
  if (!count) return { count: 0, text: '' };
  const parts = [mine ? `${mine} 项由你负责` : '', unowned ? `${unowned} 项未指定负责人` : '', candidates ? `${candidates} 条候选待审核` : ''].filter(Boolean);
  return { count, text: `AccreMind 有待处理事项：${parts.join('，')}。打开经验工作台处理。` };
}
